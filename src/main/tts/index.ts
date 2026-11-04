/**
 * TTS 合成（兜底音源）—— 任意 OpenAI 兼容端点的 /audio/speech。
 *
 * 设计约束：
 * - 配置**唯一真源** = `settings.tts[]` + `activeTtsId`（经 `pipeline/providers.activeProvider('tts')` 取）；
 *   **不再读旧单组字段 `baseURL/apiKey/model/ttsVoice`**（A 收敛，配音与模型接入彻底分开）。
 * - **不默认发起任何网络请求**：仅当用户配置了配音 Base URL / API Key / Model、
 *   且演出策略显式选择 TTS（或手动试听）时才会调用；无配置/未启用/未填完整 → **立即返回可读错误，不发请求**。
 * - 音色优先级：**调用方传入**（`speak(text,{voice})`，演出页在用）**最高** > 配置里的 `voice` > `'alloy'`。
 * - 结果按 sha256(文本+音色+模型) 缓存到 userData/tts/，同一句重复合成直接命中缓存；
 * - 缓存文件通过 cache://tts/<文件名> 常驻访问（见 cache-protocol.ts）。
 */
import { createHash } from 'node:crypto'
import { app } from 'electron'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SpeakResult } from '../../shared/app-types'
import type { TtsProvider } from '../../shared/pipeline-types'
import { validateBaseURL } from '../settings/store'
import { activeProvider } from '../pipeline/providers'

export type { SpeakResult } from '../../shared/app-types'

/** 单次合成上限（超长文本交给上游会不稳定，直接报错让走定时器兜底） */
const MAX_TEXT = 4000
const TIMEOUT_MS = 60_000
/** 缓存查找候选扩展名（与 cache-protocol 的白名单一致） */
const EXTS = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'mp4', 'opus', 'flac', 'aac']

export function ttsCacheDir(): string {
  return join(app.getPath('userData'), 'tts')
}

/** 缓存键：同一段文本 + 同一音色 + 同一模型 → 同一文件 */
export function ttsCacheKey(text: string, voice: string, model: string): string {
  return createHash('sha256').update(JSON.stringify({ v: 1, text, voice, model })).digest('hex')
}

async function findCached(key: string): Promise<{ path: string; size: number } | null> {
  for (const ext of EXTS) {
    const p = join(ttsCacheDir(), `${key}.${ext}`)
    try {
      const s = await stat(p)
      if (s.isFile() && s.size > 0) return { path: p, size: s.size }
    } catch {
      // 不存在即试下一个扩展名
    }
  }
  return null
}

function extFromContentType(ct: string): string {
  const c = ct.toLowerCase()
  if (c.includes('mpeg') || c.includes('mp3')) return 'mp3'
  if (c.includes('wav')) return 'wav'
  if (c.includes('ogg')) return 'ogg'
  if (c.includes('mp4') || c.includes('m4a')) return 'm4a'
  if (c.includes('opus')) return 'opus'
  if (c.includes('flac')) return 'flac'
  if (c.includes('aac')) return 'aac'
  return 'mp3'
}

/**
 * 合成一段文本。
 * 顺序：解析配音配置（未配置/未启用/未填完整 → 立即报错，不发请求）→ 磁盘缓存 → 上游请求 → 写缓存 → 返回 cache:// URL。
 */
export async function speak(text: string, opts?: { voice?: string }): Promise<SpeakResult> {
  const input = (text ?? '').trim()
  if (!input) return { ok: false, error: '文本为空，无法合成' }
  if (input.length > MAX_TEXT) {
    return { ok: false, error: `文本过长（${input.length} > ${MAX_TEXT} 字），请改走定时器节奏` }
  }

  // 配音配置唯一真源 = tts[] + activeTtsId（不再读旧单组字段）
  const provider = (await activeProvider('tts')) as TtsProvider | null
  if (!provider) {
    return { ok: false, error: '尚未配置配音（设置 → 配音接入），TTS 不可用；已回退定时器节奏' }
  }
  if (!provider.enabled) {
    return { ok: false, error: '尚未配置配音（设置 → 配音接入）：当前选中的配音已被禁用，TTS 不可用；已回退定时器节奏' }
  }
  if (!provider.baseURL.trim() || !provider.apiKey.trim() || !provider.model.trim()) {
    return {
      ok: false,
      error: '尚未配置配音（设置 → 配音接入）：当前配音的 Base URL / API Key / Model 未填完整，TTS 不可用；已回退定时器节奏'
    }
  }

  // 音色优先级：调用方传入（演出页/local）最高 > 配置里的 voice > 'alloy'（不得破坏 speak(text,{voice}) 覆盖能力）
  const voice = (opts?.voice ?? '').trim() || (provider.voice ?? '').trim() || 'alloy'
  const key = ttsCacheKey(input, voice, provider.model)

  const hit = await findCached(key)
  if (hit) {
    return {
      ok: true,
      cached: true,
      bytes: hit.size,
      url: `cache://tts/${key}.${hit.path.split('.').pop()}`
    }
  }

  const check = validateBaseURL(provider.baseURL)
  if (!check.ok) return { ok: false, error: `Base URL 不合法：${check.reason}` }

  const endpoint = provider.baseURL.trim().replace(/\/+$/, '') + '/audio/speech'
  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${provider.apiKey.trim()}`
      },
      body: JSON.stringify({
        model: provider.model.trim(),
        input,
        voice,
        response_format: 'mp3'
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (e) {
    return { ok: false, error: `TTS 请求失败：${(e as Error).message}` }
  }
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 300)
    } catch {
      /* 忽略读取失败 */
    }
    return { ok: false, error: `TTS 上游返回 ${res.status}${detail ? `：${detail}` : ''}` }
  }

  const ct = res.headers.get('content-type') ?? ''
  if (!ct.toLowerCase().startsWith('audio/')) {
    return { ok: false, error: `TTS 上游未返回音频二进制（content-type=${ct || '空'}）` }
  }
  const ext = extFromContentType(ct)
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) return { ok: false, error: 'TTS 上游返回了空音频' }

  const dir = ttsCacheDir()
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${key}.${ext}`)
  await writeFile(file, buf)
  // 触摸一下 access，避免某些平台写后立即可读性竞态（不影响正确性）
  await access(file).catch(() => undefined)
  return { ok: true, cached: false, bytes: buf.length, url: `cache://tts/${key}.${ext}` }
}

/**
 * 配音端点探活：真正打一次 `/audio/speech`（**不是** `/chat/completions`）。
 *
 * 【为什么必须单独实现】配音端点支持 `/audio/speech` 不代表支持 `/chat/completions`，
 * 反之亦然。早先配音配置共用 LLM 的探活（`singleChat` → POST /chat/completions），
 * 对一个纯 TTS 端点必然 404 —— 看起来像「配置错了」，其实配置完全正确。
 * 所以配音要用它自己的协议来验。
 *
 * 判定口径：**HTTP 200 且 content-type 是 audio/*** 才算可用；
 * 200 但返回 JSON（常见于「模型名不对」的报错包装）判失败，并把上游原文带回。
 *
 * 与 `speak()` 的差别：探活**不写缓存**（避免一句无意义的探活文本污染缓存目录）。
 */
export async function probeTts(provider: TtsProvider): Promise<{ ok: boolean; httpStatus?: number; ms?: number; error?: string }> {
  const check = validateBaseURL(provider.baseURL)
  if (!check.ok) return { ok: false, error: `探活失败：Base URL 不合法（${check.reason}）` }
  if (!provider.model.trim()) return { ok: false, error: '探活失败：未填写 model' }
  const voice = (provider.voice ?? '').trim() || 'alloy'
  const endpoint = provider.baseURL.trim().replace(/\/+$/, '') + '/audio/speech'
  const started = Date.now()
  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${provider.apiKey.trim()}`
      },
      // 探活文本取最短的「能出声」内容：太短有些端点会拒，太长浪费时间
      body: JSON.stringify({ model: provider.model.trim(), input: '你好', voice, response_format: 'mp3' }),
      signal: AbortSignal.timeout(60_000)
    })
  } catch (e) {
    const err = e as Error
    const timedOut = err.name === 'TimeoutError' || /timeout|abort/i.test(err.message)
    return {
      ok: false,
      ms: Date.now() - started,
      error: `探活失败：${timedOut ? '请求超时（60s）' : err.message}`
    }
  }
  const ms = Date.now() - started
  const ct = (res.headers.get('content-type') ?? '').toLowerCase()
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 300)
    } catch {
      /* 忽略 */
    }
    return {
      ok: false,
      httpStatus: res.status,
      ms,
      error: `探活失败：上游返回 ${res.status}${detail ? `：${detail}` : ''}`
    }
  }
  if (!ct.startsWith('audio/')) {
    // 200 但不是音频：读出正文（多半是「model not found」这类 JSON 报错），原文带回便于定位
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 300)
    } catch {
      /* 忽略 */
    }
    return {
      ok: false,
      httpStatus: res.status,
      ms,
      error: `探活失败：端点返回 ${ct || '未知类型'} 而不是音频${detail ? `，原文：${detail}` : ''}（模型名或音色可能不被支持）`
    }
  }
  return { ok: true, httpStatus: res.status, ms }
}

/**
 * 合成一段文本并**直接返回音频字节**（漫画配音写回用）。
 *
 * 与上方 `speak()` 的差别：`speak()` 是给渲染进程播放用的，只回 `cache://` URL；
 * 而「重新配音」需要拿到字节去写进工作库资产区（内容寻址 `assets/audio/<sha>.mp3`），
 * 所以必须有拿字节的入口。
 *
 * 复用同一条缓存：同一段文本 + 同一音色 + 同一模型 → 同一缓存文件，
 * 命中缓存时直接读盘返回，不会重复请求上游（省钱也省时间）。
 */
export async function ttsSpeakBytes(
  text: string,
  opts?: { voice?: string }
): Promise<{ ok: boolean; bytes?: Buffer; ext?: string; error?: string; cached?: boolean }> {
  const input = (text ?? '').trim()
  if (!input) return { ok: false, error: '文本为空，无法合成' }
  if (input.length > MAX_TEXT) {
    return { ok: false, error: `文本过长（${input.length} > ${MAX_TEXT} 字）` }
  }

  const provider = (await activeProvider('tts')) as TtsProvider | null
  if (!provider) return { ok: false, error: '尚未配置配音（设置 → 配音接入）' }
  if (!provider.enabled) return { ok: false, error: '当前选中的配音配置已被禁用' }

  // 音色优先级与 speak() 一致：调用方传入 > 配置里的 voice > 'alloy'
  const voice = (opts?.voice ?? '').trim() || (provider.voice ?? '').trim() || 'alloy'
  const key = ttsCacheKey(input, voice, provider.model.trim())

  // 缓存命中：直接读盘
  const hit = await findCached(key)
  if (hit) {
    try {
      const bytes = Buffer.from(await readFile(hit.path))
      return { ok: true, bytes, ext: hit.path.split('.').pop() || 'mp3', cached: true }
    } catch {
      // 读失败就当未命中，继续请求上游
    }
  }

  const check = validateBaseURL(provider.baseURL)
  if (!check.ok) return { ok: false, error: `Base URL 不合法：${check.reason}` }

  const endpoint = provider.baseURL.trim().replace(/\/+$/, '') + '/audio/speech'
  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${provider.apiKey.trim()}`
      },
      body: JSON.stringify({
        model: provider.model.trim(),
        input,
        voice,
        response_format: 'mp3'
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (e) {
    return { ok: false, error: `TTS 请求失败：${(e as Error).message}` }
  }
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 300)
    } catch {
      /* 忽略 */
    }
    return { ok: false, error: `TTS 上游返回 ${res.status}${detail ? `：${detail}` : ''}` }
  }

  const ct = res.headers.get('content-type') ?? ''
  if (!ct.toLowerCase().startsWith('audio/')) {
    return { ok: false, error: `TTS 上游未返回音频二进制（content-type=${ct || '空'}）` }
  }
  const ext = extFromContentType(ct)
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) return { ok: false, error: 'TTS 上游返回了空音频' }

  // 写缓存（下次命中）
  try {
    const dir = ttsCacheDir()
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${key}.${ext}`), buf)
  } catch {
    // 缓存写失败不影响返回值本身
  }

  return { ok: true, bytes: buf, ext, cached: false }
}

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
import { access, mkdir, stat, writeFile } from 'node:fs/promises'
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

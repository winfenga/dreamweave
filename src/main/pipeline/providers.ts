/**
 * 多 provider 池（设计 §6.9 · N-4~N-8）。
 *
 * - `listProviders(kind)`：多组配置列表
 * - `activeProvider(kind)`：本题使用的那组
 * - `probeProvider(id)`：探活（`POST /chat/completions`、`max_tokens:16`（用户批准）、
 *   `stream:false`、`response_format:{type:'json_object'}`、**不发 temperature**）
 * - `nextAfter(id)`：fallback 链（空则轮询启用项）中的下一组
 * - `providerChain(startId?)`：完整尝试链（供编排器一键取用）
 *
 * fallback 边界：**同配置退避耗尽 / 不可重试态** 才由调用方走 `nextAfter()` 换配置。
 */
import type {
  LlmProvider,
  ModelListResult,
  ProviderKind,
  ProviderSettings,
  TtsProvider,
  ProbeResult
} from '../../shared/pipeline-types'
import { loadSettings, saveSettings, validateBaseURL } from '../settings/store'
import { singleChat } from './llm-client'
import { probeTts } from '../tts'

/**
 * 探活超时。取 60s：该聚合服务延迟波动大（实测同一模型 1~37s），
 * 30s 会把「可达但慢」误判为超时。**用户确认接受 60s。**
 */
const PROBE_TIMEOUT_MS = 60_000

/** 全部 LLM 配置（含未启用）。 */
export async function listLlmProviders(): Promise<LlmProvider[]> {
  return (await loadSettings()).llm
}

/** 全部 TTS 配置。 */
export async function listTtsProviders(): Promise<TtsProvider[]> {
  return (await loadSettings()).tts
}

export async function listProviders(kind: ProviderKind): Promise<Array<LlmProvider | TtsProvider>> {
  return kind === 'llm' ? listLlmProviders() : listTtsProviders()
}

/** 当前选中的 LLM 配置（activeLlmId 失效时回退第一条启用项）。 */
export async function activeProvider(kind: ProviderKind = 'llm'): Promise<LlmProvider | TtsProvider | null> {
  const s = await loadSettings()
  const list: Array<LlmProvider | TtsProvider> = kind === 'llm' ? s.llm : s.tts
  const activeId = kind === 'llm' ? s.activeLlmId : s.activeTtsId
  return list.find((p) => p.id === activeId) ?? list.find((p) => p.enabled) ?? list[0] ?? null
}

/** 完整尝试链：主配置在前，随后 fallback 链（或轮询启用项）。 */
export async function providerChain(startId?: string): Promise<LlmProvider[]> {
  const s = await loadSettings()
  const enabled = s.llm.filter((p) => p.enabled)
  if (!enabled.length) return []
  const start = startId ?? s.activeLlmId
  const out: LlmProvider[] = []
  const seen = new Set<string>()
  const push = (p: LlmProvider | undefined): void => {
    if (p && !seen.has(p.id)) {
      seen.add(p.id)
      out.push(p)
    }
  }
  push(enabled.find((p) => p.id === start) ?? enabled[0])
  if (s.fallbackChain.length) {
    for (const id of s.fallbackChain) push(enabled.find((p) => p.id === id))
  } else {
    const i0 = enabled.findIndex((p) => p.id === out[0]?.id)
    for (let k = 1; k < enabled.length; k++) push(enabled[(i0 + k) % enabled.length])
  }
  return out
}

/** fallback 链中的下一组（无下一组 → null）。 */
export async function nextAfter(providerId: string): Promise<LlmProvider | null> {
  const chain = await providerChain(providerId)
  return chain.length > 1 ? chain[1] : null
}

/**
 * 探活：把指定配置发一次最小请求（口径：`POST /chat/completions`、Bearer、
 * `stream:false`、`response_format:{type:'json_object'}`、**不含 temperature**）。
 *
 * 语义（设计 §6.9 + QA 复验）：**HTTP 200 且响应体可解析 = 可达（ok:true）**；
 * `finish_reason==='length'`（小预算下属正常）**不得**判失败。
 * 失败文案为**探活专用**，不复用任务级「输出被 token 上限截断」提示。
 *
 * ⚠️ 探活 `max_tokens=16`（**用户批准**，偏离设计 §6.9/§9 字面值 `1`；
 *    该服务 1-token 会 502/超时，16 才稳定 200；探活必须真实可用）。
 * 探活失败**重试 1 次**：可重试类＝网络/超时/5xx/429；不可重试类＝400/401/402/403/404/422。
 */
export async function probeProvider(id: string): Promise<ProbeResult> {
  const s = await loadSettings()
  const p = s.llm.find((x) => x.id === id) ?? s.tts.find((x) => x.id === id)
  if (!p) return { ok: false, error: `探活失败：未找到配置 ${id}` }
  // 配音配置要用**它自己的协议**验（POST /audio/speech），不能拿 LLM 的
  // /chat/completions 去探 —— 纯 TTS 端点那个路径必然 404，会把好配置判成坏的。
  if (s.tts.some((x) => x.id === id)) {
    const r = await probeTts(p as TtsProvider)
    return { ok: r.ok, httpStatus: r.httpStatus, ms: r.ms, error: r.error }
  }
  const check = validateBaseURL(p.baseURL)
  if (!check.ok) return { ok: false, error: `探活失败：Base URL 不合法（${check.reason}）` }
  if (!p.model.trim()) return { ok: false, error: '探活失败：未填写 model' }
  // 探活失败自动重试 1 次（用户口径，总请求 ≤2 次）：
  // **可重试类**＝网络错误 / **超时** / 5xx / 429 → 重试 1 次；
  // **不可重试类**＝400/401/402/403/404/422 → 立即返回、不重试（与设计 §6.5 不可重试口径一致）。
  const nonRetryableStatus = new Set([400, 401, 402, 403, 404, 422])
  let last: Awaited<ReturnType<typeof singleChat>> | null = null
  let retried = false
  for (let attempt = 0; attempt < 2; attempt++) {
    last = await singleChat(p, [{ role: 'user', content: 'ping' }], {
      // 用户批准（方案 B）：探活 max_tokens=16，偏离设计字面值 1
      maxTokens: 16,
      timeoutMs: PROBE_TIMEOUT_MS,
      // 探活专用开关：长度截断/空内容不判失败（HTTP 200 且响应可解析即可达）
      probe: true
    })
    if (last.ok) return { ok: true, httpStatus: last.httpStatus, ms: last.ms }
    const fatalStatus = last.httpStatus !== undefined && nonRetryableStatus.has(last.httpStatus)
    // 不可重试态（4xx）→ 停止；其余（含**超时**）→ 重试 1 次
    if (fatalStatus || (!last.retryable && !last.timedOut)) break
    if (attempt === 0) retried = true
  }
  const raw = last?.error ?? '未知错误'
  const core = raw.startsWith('探活失败') ? raw : `探活失败：${raw}`
  const error = retried ? core.replace(/^探活失败/, '探活失败（已重试 1 次）') : core
  return {
    ok: false,
    httpStatus: last?.httpStatus,
    ms: last?.ms,
    error
  }
}

/**
 * 模型探测：`GET {baseURL}/models`，列出该端点可用模型。
 *
 * **与 `probeProvider` 的区别**（两个都要，不能只留一个）：
 *   - `probeProvider` 需要已经填好 model，发的是对话请求 —— 回答「这组现在能跑吗」；
 *   - `listModels` 不需要 model，只读模型目录 —— 回答「这组有哪些模型可选」。
 * 填模型之前没法探活，但那一刻最需要的恰恰是看到模型名，所以本函数独立存在。
 *
 * 兼容性处理（实测环境里三种端点都存在）：
 *   1. 标准 `{object:'list', data:[{id, owned_by}]}`；
 *   2. 裸数组 `[{id}]`；
 *   3. Ollama 风格 `{models:[{name}]}`（部分本地网关会回这个）。
 *
 * SSE 不需要特判：`/models` 是普通 GET，实测不会被网关改成流式。
 * 超时取 20s —— 模型列表比对话请求轻得多，但要容忍首次 DNS/握手慢。
 */
export async function listModels(providerId: string): Promise<ModelListResult> {
  const s = await loadSettings()
  const p = s.llm.find((x) => x.id === providerId) ?? s.tts.find((x) => x.id === providerId)
  if (!p) return { ok: false, error: `探测失败：未找到配置 ${providerId}` }
  return listModelsOf(p.baseURL, p.apiKey)
}

/** 探测任意 baseURL 的模型列表（不依赖已保存的配置；界面里「未保存也能试」用这个）。 */
export async function listModelsOf(baseURL: string, apiKey: string): Promise<ModelListResult> {
  const check = validateBaseURL(baseURL)
  if (!check.ok) return { ok: false, error: `探测失败：Base URL 不合法（${check.reason}）` }
  const base = baseURL.trim().replace(/\/+$/, '')
  const endpoint = `${base}/models`
  const started = Date.now()
  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'GET',
      headers: apiKey.trim() ? { authorization: `Bearer ${apiKey.trim()}` } : {},
      signal: AbortSignal.timeout(20_000)
    })
  } catch (e) {
    const err = e as Error
    const timedOut = err.name === 'TimeoutError' || /timeout|abort/i.test(err.message)
    return {
      ok: false,
      baseURL: base,
      error: `探测失败：${timedOut ? '请求超时（20s）' : err.message}`
    }
  }
  const ms = Date.now() - started
  let text = ''
  try {
    text = await res.text()
  } catch {
    text = ''
  }
  if (!res.ok) {
    const detail = text.slice(0, 300)
    return {
      ok: false,
      httpStatus: res.status,
      ms,
      baseURL: base,
      error: `探测失败：上游返回 ${res.status}${detail ? `：${detail}` : ''}`
    }
  }
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  if (parsed === null) {
    return {
      ok: false,
      httpStatus: res.status,
      ms,
      baseURL: base,
      error: '探测失败：端点可达但返回的不是 JSON（可能不支持 /models）'
    }
  }

  // 三种形状统一抽成 [{id, owner}]
  const rows: { id: string; owner: string }[] = []
  const pushRow = (id: unknown, owner: unknown): void => {
    const s = typeof id === 'string' ? id.trim() : ''
    if (s) rows.push({ id: s, owner: typeof owner === 'string' ? owner.trim() : '' })
  }
  if (Array.isArray(parsed)) {
    for (const it of parsed) {
      const o = it as Record<string, unknown>
      pushRow(o?.id ?? o?.name ?? o?.model, o?.owned_by ?? o?.owner)
    }
  } else if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>
    if (Array.isArray(o.data)) {
      for (const it of o.data) {
        const e = it as Record<string, unknown>
        pushRow(e?.id ?? e?.name ?? e?.model, e?.owned_by ?? e?.owner)
      }
    } else if (Array.isArray(o.models)) {
      for (const it of o.models) {
        const e = it as Record<string, unknown>
        pushRow(e?.id ?? e?.name ?? e?.model, e?.owned_by ?? e?.owner)
      }
    }
  }

  if (!rows.length) {
    return {
      ok: false,
      httpStatus: res.status,
      ms,
      baseURL: base,
      error: '探测失败：/models 返回了空列表（Key 可能无权读取模型目录，但仍可正常对话）'
    }
  }

  // 去重 + 按 id 排序（端点返回顺序不稳定，排序后便于扫读）
  const seen = new Set<string>()
  const uniq = rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
  uniq.sort((a, b) => a.id.localeCompare(b.id))
  const owners: Record<string, string> = {}
  for (const r of uniq) if (r.owner) owners[r.id] = r.owner

  return {
    ok: true,
    httpStatus: res.status,
    ms,
    baseURL: base,
    models: uniq.map((r) => r.id),
    owners
  }
}

/** 覆盖式保存多配置（增删改 + 选 active + fallback 链）。 */export async function saveProviders(next: Partial<ProviderSettings>): Promise<{ ok: boolean; error?: string }> {
  if (Array.isArray(next.llm)) {
    for (const p of next.llm) {
      if (p.baseURL && !validateBaseURL(p.baseURL).ok) {
        return { ok: false, error: `配置「${p.label || p.id}」的 Base URL 不合法：${validateBaseURL(p.baseURL).reason}` }
      }
    }
  }
  if (Array.isArray(next.tts)) {
    for (const p of next.tts) {
      if (p.baseURL && !validateBaseURL(p.baseURL).ok) {
        return { ok: false, error: `TTS 配置「${p.label || p.id}」的 Base URL 不合法：${validateBaseURL(p.baseURL).reason}` }
      }
    }
  }
  await saveSettings({
    llm: next.llm,
    tts: next.tts,
    activeLlmId: next.activeLlmId,
    activeTtsId: next.activeTtsId,
    fallbackChain: next.fallbackChain
  })
  return { ok: true }
}

/**
 * LLM 客户端（设计 §6.6 · B-P0-2）。
 *
 * 严格形态（抓包口径）：
 *   POST {baseURL 去尾部 /}/chat/completions
 *   Headers: content-type: application/json ; authorization: Bearer <apiKey>
 *   Body: { model, messages, stream:false, response_format:{type:"json_object"} }
 *   —— **绝不发送 temperature**（显式不写入）；`baseURL` 不得含 `/chat/completions`。
 *
 * 输出上限字段按 provider 二选一：minimax/mimo → `max_completion_tokens`；其它（含 custom）→ `max_tokens`。
 * 超时用 `AbortSignal.timeout`。错误分类：400/401/402/403/404/422 及用户 abort → 不可重试；
 * 网络/5xx/限流 → 可重试（退避 [2000,4000,8000]ms；storyScript 最多 2 次、其它最多 3 次）。
 * `finish_reason==="length"` → 抛「输出被 token 上限截断，请调高最大输出 token 后手动重试」。
 *
 * 换配置（fallback）：同配置退避耗尽或遇不可重试态 → 才由 `chatWithFallback` 走 `nextAfter()`。
 */
import type { ChatMessage, TokenUsage, LlmProvider } from '../../shared/pipeline-types'
import { validateBaseURL } from '../settings/store'

/** 不可重试的 HTTP 状态（recon §5）。 */
export const NON_RETRYABLE_STATUS = new Set<number>([400, 401, 402, 403, 404, 422])

/** 退避表（recon `dQ`）。 */
export const BACKOFF_MS = [2000, 4000, 8000] as const

export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

export interface ChatOptions {
  taskId?: string
  maxTokens?: number
  thinking?: 'enabled' | 'disabled'
  effort?: number
  timeoutMs?: number
  /** 覆盖退避策略 */
  retry?: { maxRetries: number; backoffMs: readonly number[] }
  /**
   * **探活模式**：`HTTP 200`（响应可解析）即视为存活 —— 探活预算 `max_tokens=16`
   * （**用户批准的偏离**：设计字面值为 `1`；该服务 1-token 会 502/超时，故探活用 16；
   * 见 `providers.ts`）。推理/正常模型在该预算下 `finish_reason` 常为 `length`、
   * 内容可能为空，这属**正常**，不得复用「任务级截断」语义把可达端点误判为失败。
   */
  probe?: boolean
}

/** 单次请求的原始产物（供落盘审计）。 */
export interface RawExchange {
  request: unknown
  response: unknown
}

export interface SingleAttemptResult {
  ok: boolean
  httpStatus?: number
  retryable: boolean
  /** 是否因**超时**中断（`AbortSignal.timeout`）。探活把超时视为可重试（用户口径）。 */
  timedOut?: boolean
  /**
   * 是否被**内容审查拦截**：上游返回 200 但内容过短（<50 字），
   * 典型是「对不起，我不能生成……」这类拒绝语。
   *
   * 语义上与普通失败不同：重试多少次结果都一样，
   * 调用方应当**立即终止该任务**而不是退避重试或换配置。
   */
  blocked?: boolean
  content?: string
  finishReason?: string | null
  usage?: TokenUsage | null
  ms: number
  error?: string
  exchange?: RawExchange
}

/** 组合 baseURL + /chat/completions（去掉尾部 /）。 */
export function endpointOf(provider: LlmProvider): string {
  return provider.baseURL.trim().replace(/\/+$/, '') + '/chat/completions'
}

/** 按 provider 类型选择输出上限字段。 */
export function usesMaxCompletionTokens(provider: LlmProvider): boolean {
  const k = (provider.providerKind ?? 'custom').toLowerCase()
  return k === 'minimax' || k === 'mimo'
}

/** 构造请求体（**不含 temperature**）。 */
export function buildRequestBody(
  provider: LlmProvider,
  messages: ChatMessage[],
  opts: ChatOptions
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: provider.model,
    messages,
    stream: false,
    response_format: { type: 'json_object' }
  }
  const limit = opts.maxTokens && opts.maxTokens > 0 ? Math.floor(opts.maxTokens) : 0
  if (limit > 0) {
    if (usesMaxCompletionTokens(provider)) body.max_completion_tokens = limit
    else body.max_tokens = limit
  }
  // 显式删除（防御上游/sdk 注入）
  delete body.temperature
  return body
}

/** 解析用量。 */
export function parseUsage(raw: unknown): TokenUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const u = (raw as Record<string, unknown>).usage as Record<string, unknown> | undefined
  if (!u || typeof u !== 'object') return null
  const input = num(u.prompt_tokens)
  const output = num(u.completion_tokens)
  const details = u.prompt_tokens_details as Record<string, unknown> | undefined
  const hit = num(u.prompt_cache_hit_tokens ?? details?.cached_tokens)
  const miss = num(u.prompt_cache_miss_tokens ?? Math.max(0, input - hit))
  return { input, hit, miss, output, raw: u }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** 单次请求（不重试）。 */
export async function singleChat(
  provider: LlmProvider,
  messages: ChatMessage[],
  opts: ChatOptions = {}
): Promise<SingleAttemptResult> {
  const check = validateBaseURL(provider.baseURL)
  if (!check.ok) {
    return { ok: false, retryable: false, ms: 0, error: `Base URL 不合法：${check.reason}` }
  }
  if (!provider.model.trim()) {
    return { ok: false, retryable: false, ms: 0, error: '未配置 model，无法发起请求' }
  }
  const endpoint = endpointOf(provider)
  const body = buildRequestBody(provider, messages, opts)
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS
  const started = Date.now()
  const signal = AbortSignal.timeout(timeoutMs)
  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify(body),
      signal
    })
  } catch (e) {
    const ms = Date.now() - started
    const err = e as { name?: string; message?: string }
    const name = err?.name ?? ''
    const msg = err?.message ?? String(e)
    const reasonName = signal.reason && typeof signal.reason === 'object' ? (signal.reason as { name?: string }).name ?? '' : ''
    const timedOut = name === 'TimeoutError' || reasonName === 'TimeoutError'
    const aborted = timedOut || name === 'AbortError' || /abort/i.test(msg)
    return {
      ok: false,
      // 任务语义（不变）：abort/超时 视为不可重试；探活侧另用 timedOut 归入可重试类。
      retryable: !aborted,
      timedOut,
      ms,
      error: timedOut ? `请求超时（${timeoutMs}ms）：${msg}` : aborted ? `请求被中断：${msg}` : `网络请求失败：${msg}`,
      exchange: { request: body, response: null }
    }
  }

  const ms = Date.now() - started
  let text = ''
  try {
    text = await res.text()
  } catch {
    text = ''
  }
  // ⚠️ 上游可能**无视 `stream:false`** 直接回 SSE。实测本地 workbuddy 网关
  // （buddy:deepseek-v4.1-flash）就是如此：请求体明确 `stream:false`，
  // 响应却是 `Content-Type: text/event-stream` + `data: {...}` 分帧。
  //
  // 若直接 JSON.parse 得到 null，会引发两个**都很致命**的连锁症状：
  //   1) 探活 → 报「端点可达但响应不可解析（非 JSON）」，看起来像配错了；
  //   2) 正式任务 → `getChoices(null)` 返回空数组 → 报「响应缺少 choices[0].message.content」，
  //      整条流水线在这个端点上完全不可用。
  // 端点本身是好的，所以这里先把 SSE 聚合成等价的一次性 completion 再走后续逻辑。
  const sse = parseSseCompletion(text, res.headers.get('content-type'))
  const bodyText = sse ? JSON.stringify(sse) : text
  let parsed: unknown = null
  try {
    parsed = bodyText ? JSON.parse(bodyText) : null
  } catch {
    parsed = null
  }
  const exchange: RawExchange = { request: body, response: parsed ?? text }

  if (!res.ok) {
    const detail = text.slice(0, 300)
    return {
      ok: false,
      httpStatus: res.status,
      retryable: !NON_RETRYABLE_STATUS.has(res.status),
      ms,
      error: `上游返回 ${res.status}${detail ? `：${detail}` : ''}`,
      exchange
    }
  }

  const choices = getChoices(parsed)
  const finishReason = choices.length ? ((choices[0] as Record<string, unknown>).finish_reason as string | null) : null

  // 探活语义：HTTP 200 且**响应体可解析**即视为可达。探活预算 max_tokens=16
  // （用户批准的偏离：设计字面值 1；该服务 1-token 会 502/超时）下 length/空内容均属正常。
  if (opts.probe) {
    if (parsed === null) {
      return {
        ok: false,
        httpStatus: res.status,
        retryable: false,
        ms,
        error: '探活失败：端点可达但响应不可解析（非 JSON）',
        exchange
      }
    }
    return {
      ok: true,
      httpStatus: res.status,
      retryable: false,
      content: extractContent(choices) ?? '',
      finishReason,
      usage: parseUsage(parsed),
      ms,
      exchange
    }
  }

  const content = extractContent(choices)
  if (content === null) {
    return {
      ok: false,
      httpStatus: res.status,
      retryable: false,
      ms,
      error: '响应缺少 choices[0].message.content',
      exchange
    }
  }
  if (finishReason === 'length') {
    return {
      ok: false,
      httpStatus: res.status,
      retryable: false,
      ms,
      error: '输出被 token 上限截断，请调高最大输出 token 后手动重试',
      exchange
    }
  }

  // ---- 审查拦截检测 ----
  // 上游服务商（Qwen / GPT / Claude 等）在内容审查命中时会返回「一段很短的拒绝语」，
  // 形如「对不起，我不能生成……」/「I'm sorry, but I can't help with that.」。
  // 这类响应 HTTP 200、finish_reason 正常，**从协议层看完全成功**，
  // 但内容是废的。若当成功处理，会让整条流水线拿到垃圾数据继续往下跑，
  // 甚至写进产物。所以必须在最底层拦下来。
  //
  // 判定规则（用户指定）：**返回文本不足 50 字**即视为审查拦截。
  //   为什么用长度而不是关键词：拒绝语的措辞千变万化（多语言、多供应商），
  //   关键词穷举不了；而「不足 50 字」对任何一个真实任务输出来说都不可能——
  //   JSON 产物最短也有几十个字段。这条规则简单、无漏判。
  if (isLikelyContentBlocked(content)) {
    return {
      ok: false,
      httpStatus: res.status,
      retryable: false,
      blocked: true,
      ms,
      error: `内容审查拦截：上游返回过短内容（${content.trim().length} 字符），可能是拒绝响应：${content.trim().slice(0, 120)}`,
      exchange
    }
  }

  return { ok: true, httpStatus: res.status, retryable: false, content, finishReason, usage: parseUsage(parsed), ms, exchange }
}

/** 审查拦截的最小文本长度阈值（用户指定：不足 50 字即为拦截） */
export const CONTENT_BLOCKED_MIN_CHARS = 50

/**
 * 判定一段返回内容是否是审查拒绝。
 *
 * 只用长度判定（用户指定策略）：真实任务输出（结构化 JSON）不可能短于 50 字，
 * 而拒绝语通常只有一两句。这样既不依赖多语言关键词表，也不会误伤正常短输出。
 *
 * 注意：纯空白也算拦截（长度按 trim 后计算）。
 */
export function isLikelyContentBlocked(content: string): boolean {
  return content.trim().length < CONTENT_BLOCKED_MIN_CHARS
}

/**
 * 把 SSE（`text/event-stream`）响应聚合成**与非流式等价的一次性 completion**。
 *
 * 为什么需要它：`stream:false` 并不是所有网关都遵守。不认这个字段的上游会直接回
 * `data: {chunk}\n\n…data: [DONE]`，此时 `JSON.parse` 整体必然失败。
 * 我们不做真流式消费（任务都是「拿完整结果再解析 JSON」），所以这里只把分片里的
 * `delta.content` 按顺序拼起来，再套回标准 `choices[0].message.content` 结构，
 * 让调用方对 SSE / 非 SSE 完全无感。
 *
 * 判定条件是**内容形状**而不是只看 Content-Type：有的网关 Content-Type 写着
 * `application/json` 却回 SSE 帧，也有的反过来。两者任一命中即按 SSE 处理。
 *
 * 返回 `null` 表示「这段文本不是 SSE」，调用方照常按普通 JSON 解析。
 */
export function parseSseCompletion(raw: string, contentType?: string | null): unknown | null {
  if (!raw) return null
  const head = raw.slice(0, 200)
  const looksSse = /^data:\s/m.test(head) || (contentType ?? '').toLowerCase().includes('text/event-stream')
  if (!looksSse) return null

  let content = ''
  let id = ''
  let model = ''
  let finishReason: string | null = null
  let usage: unknown = null
  let sawChunk = false

  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    const payload = t.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    let chunk: unknown
    try {
      chunk = JSON.parse(payload)
    } catch {
      // 单帧坏掉不该让整段作废，跳过即可
      continue
    }
    if (!chunk || typeof chunk !== 'object') continue
    sawChunk = true
    const c = chunk as Record<string, unknown>
    if (typeof c.id === 'string') id = c.id
    if (typeof c.model === 'string') model = c.model
    if (c.usage && typeof c.usage === 'object') usage = c.usage
    const choices = Array.isArray(c.choices) ? c.choices : []
    const first = choices[0] as Record<string, unknown> | undefined
    if (!first) continue
    const delta = first.delta as Record<string, unknown> | undefined
    const piece = delta?.content
    if (typeof piece === 'string') content += piece
    const fr = first.finish_reason
    if (typeof fr === 'string' && fr) finishReason = fr
  }

  // 一帧都没解析出来 → 不是我们认识的 SSE，交回普通路径，由它产出原始错误
  if (!sawChunk) return null

  return {
    id,
    model,
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: finishReason
      }
    ],
    usage
  }
}

function getChoices(parsed: unknown): unknown[] {
  if (!parsed || typeof parsed !== 'object') return []
  const c = (parsed as Record<string, unknown>).choices
  return Array.isArray(c) ? c : []
}

function extractContent(choices: unknown[]): string | null {
  if (!choices.length) return null
  const msg = (choices[0] as Record<string, unknown>).message as Record<string, unknown> | undefined
  const c = msg?.content
  return typeof c === 'string' ? c : null
}

/**
 * 读取一次 chat/completions 响应并取出正文 —— **所有非流式调用方的唯一入口**。
 *
 * 存在理由：本仓有 4 个功能各自直接 `fetch` chat/completions
 * （`pipeline/llm-client`、`effects-suggest`、`imagegen/prompt-rewrite`、
 * `workspace/chapter-recognition-llm`）。它们都要面对同一个现实：
 * 上游可能无视 `stream:false` 回 SSE（本地 workbuddy 网关实测如此）。
 *
 * 之前每处都写 `await res.json()`，于是**四处一起坏**：JSON 解析直接抛
 * 「响应非 JSON：Unexpected token 'd', "data: {"id"…」。
 * 把它收敛到这里，是为了让「认不认 SSE」只由一处决定，新调用方也不会再各自踩坑。
 *
 * @returns `ok:false` 时 `error` 已是可读中文（含上游状态码 / 截断正文）。
 */
export async function readChatCompletion(
  res: Response
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 300)
    } catch {
      // 读取失败不影响错误信息本身
    }
    return { ok: false, error: `上游返回 ${res.status}${detail ? `：${detail}` : ''}` }
  }

  let text = ''
  try {
    text = await res.text()
  } catch {
    text = ''
  }

  // 先按 SSE 尝试聚合；不是 SSE 则原样 JSON 解析
  const sse = parseSseCompletion(text, res.headers.get('content-type'))
  let parsed: unknown = sse
  if (sse === null) {
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = null
    }
  }
  if (parsed === null) {
    return { ok: false, error: `响应不可解析（非 JSON，也非 SSE）：${text.slice(0, 200)}` }
  }

  const content = extractContent(getChoices(parsed))
  if (content === null) return { ok: false, error: '响应缺少 choices[0].message.content' }
  if (!content.trim()) return { ok: false, error: '响应内容为空' }
  return { ok: true, content }
}


/** 默认重试策略：storyScript 最多 2 次、其它最多 3 次。 */
export function defaultRetry(taskId?: string): { maxRetries: number; backoffMs: readonly number[] } {
  const max = taskId === 'storyScript' ? 2 : 3
  return { maxRetries: max, backoffMs: BACKOFF_MS }
}

export interface ChatAttemptLog {
  providerId: string
  model: string
  ok: boolean
  httpStatus?: number
  error?: string
  ms: number
  communicationMs: number
  usage: TokenUsage | null
}

export interface ChatWithFallbackResult {
  ok: boolean
  content?: string
  providerId?: string
  model?: string
  usage?: TokenUsage | null
  error?: string
  httpStatus?: number
  /**
   * 是否因**内容审查拦截**而终止。
   * true 时上层应把任务标为 blocked（而不是普通失败），且**不要自动重试**——
   * 用户可能需要换模型/改写提示词/人工介入。
   */
  blocked?: boolean
  attempts: ChatAttemptLog[]
}

/** 可重试退避等待。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 多 provider 执行：**同配置先按退避重试**，**退避耗尽 / 不可重试态** 才换下一配置。
 *
 * @param providers 按序尝试的配置链（首个 = 主配置）
 * @param onAttempt 每次「换配置后」的回调（用于落 attempts.providerId）
 */
export async function chatWithFallback(
  messages: ChatMessage[],
  opts: ChatOptions,
  providers: LlmProvider[],
  onAttempt?: (log: ChatAttemptLog) => void | Promise<void>
): Promise<ChatWithFallbackResult> {
  const attempts: ChatAttemptLog[] = []
  if (!providers.length) {
    return { ok: false, error: '没有可用的模型配置（请在设置中新增并选中一条）', attempts }
  }
  const policy = opts.retry ?? defaultRetry(opts.taskId)
  const errors: string[] = []

  for (const provider of providers) {
    let last: SingleAttemptResult | null = null
    for (let i = 0; i <= policy.maxRetries; i++) {
      if (i > 0) await sleep(policy.backoffMs[i - 1] ?? policy.backoffMs[policy.backoffMs.length - 1] ?? 8000)
      const r = await singleChat(provider, messages, opts)
      last = r
      if (r.ok) {
        const log: ChatAttemptLog = {
          providerId: provider.id,
          model: provider.model,
          ok: true,
          httpStatus: r.httpStatus,
          ms: r.ms,
          communicationMs: r.ms,
          usage: r.usage ?? null
        }
        attempts.push(log)
        await onAttempt?.(log)
        return {
          ok: true,
          content: r.content ?? '',
          providerId: provider.id,
          model: provider.model,
          usage: r.usage ?? null,
          attempts
        }
      }
      // 审查拦截：重试多少次都是同一段拒绝语，换配置也一样（内容敏感度只增不减）
      // → **立即终止整条链**，不走退避、不换配置，把 blocked 传给上层以便标记任务状态。
      if (r.blocked) {
        const blockedLog: ChatAttemptLog = {
          providerId: provider.id,
          model: provider.model,
          ok: false,
          httpStatus: r.httpStatus,
          error: r.error ?? '内容审查拦截',
          ms: r.ms,
          communicationMs: r.ms,
          usage: r.usage ?? null
        }
        attempts.push(blockedLog)
        await onAttempt?.(blockedLog)
        return {
          ok: false,
          blocked: true,
          error: r.error ?? '内容审查拦截：上游返回过短内容',
          attempts
        }
      }
      // 不可重试 → 立即跳出（换配置）
      if (!r.retryable) break
    }
    const failLog: ChatAttemptLog = {
      providerId: provider.id,
      model: provider.model,
      ok: false,
      httpStatus: last?.httpStatus,
      error: last?.error ?? '未知错误',
      ms: last?.ms ?? 0,
      communicationMs: last?.ms ?? 0,
      usage: last?.usage ?? null
    }
    attempts.push(failLog)
    await onAttempt?.(failLog)
    errors.push(`[${provider.label || provider.id}/${provider.model}] ${last?.error ?? '未知错误'}`)
  }

  return {
    ok: false,
    error: `全部模型配置均失败：\n${errors.join('\n')}`,
    attempts
  }
}

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
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
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

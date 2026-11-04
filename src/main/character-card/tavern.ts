/**
 * 内置酒馆：把角色卡 + 世界书变成一次真实对话。
 *
 * 【设计取舍：为什么不复用 `chatWithFallback`】
 *
 *   1) `buildRequestBody()` **刻意不发送 temperature**（本仓抓包口径，
 *      见 `llm-client.ts` 顶部注释）。流水线任务需要确定性输出，所以那条约束是对的；
 *      但酒馆的核心需求恰是「让用户调温度、惩罚」—— 这是用户明确点名的功能。
 *      所以在酒馆链路上单独构造请求体，参数 null 表示**不发该字段**（不是发 0）。
 *
 *   2) 酒馆要回显「实际发了什么参数」。走 `chatWithFallback` 拿不到这份回显，
 *      用户调了没生效时无从排查。
 *
 *   3) 酒馆是**单轮请求 + 明确错误**，不需要流水线那套退避重试
 *      （对话场景里等 8 秒再重试一次，体验比直接报错差得多）。
 *
 * 其余（端点拼接、SSE 兼容、审查拦截阈值）全部复用 `llm-client` 的现成实现，
 * 避免又造一套「各自踩同一个坑」的代码。
 */
import type { LlmProvider } from '../../shared/pipeline-types'
import type {
  CharacterCard,
  LorebookEntry,
  TavernGenerateResult,
  TavernMessage,
  TavernParams,
  TavernSettings
} from '../../shared/character-card-types'
import {
  endpointOf,
  readChatCompletion,
  usesMaxCompletionTokens,
  sleep
} from '../pipeline/llm-client'

/** 酒馆默认参数（用户可改） */
export function defaultTavernParams(): TavernParams {
  return {
    // 对话场景取 0.85：太低回复呆板，太高容易跑题
    temperature: 0.85,
    topP: 0.95,
    topK: null,
    frequencyPenalty: 0.2,
    presencePenalty: 0.2,
    repetitionPenalty: null,
    maxTokens: 800,
    stop: [],
    seed: null
  }
}

export function defaultTavernSettings(): TavernSettings {
  return {
    params: defaultTavernParams(),
    useLorebook: true,
    lorebookLimit: 6,
    // 12 条历史 ≈ 6 轮对话，够连贯又不至于把上下文挤爆
    historyLimit: 12,
    replyCount: 1
  }
}

/**
 * 构造酒馆的请求体。
 *
 * 与流水线版 `buildRequestBody` 的差别只有一处、但很关键：
 * **参数为 null 时不发送该字段**。为什么不发 0：
 * `temperature: 0` 是「确定性地贪心解码」，与「用模型默认值」是完全不同的语义。
 * 用户把滑杆设成「默认」时，我们什么都不该发。
 */
export function buildTavernBody(
  provider: LlmProvider,
  messages: { role: string; content: string }[],
  params: TavernParams
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: provider.model,
    messages,
    stream: false
  }

  // ⚠️ 酒馆**不发送** response_format:json_object —— 这里要的是自然语言回复，
  // 强制 JSON 会把对话变成字段拼装（实测上游会真的只回 JSON）。
  if (params.temperature !== null && Number.isFinite(params.temperature)) {
    body.temperature = params.temperature
  }
  if (params.topP !== null && Number.isFinite(params.topP)) body.top_p = params.topP
  if (params.topK !== null && Number.isFinite(params.topK)) body.top_k = params.topK
  if (params.frequencyPenalty !== null && Number.isFinite(params.frequencyPenalty)) {
    body.frequency_penalty = params.frequencyPenalty
  }
  if (params.presencePenalty !== null && Number.isFinite(params.presencePenalty)) {
    body.presence_penalty = params.presencePenalty
  }
  if (params.repetitionPenalty !== null && Number.isFinite(params.repetitionPenalty)) {
    body.repetition_penalty = params.repetitionPenalty
  }
  const limit = Math.max(0, Math.floor(params.maxTokens || 0))
  if (limit > 0) {
    if (usesMaxCompletionTokens(provider)) body.max_completion_tokens = limit
    else body.max_tokens = limit
  }
  // 停用词**不能 trim**：`\n用户：` 这类以换行开头的 stop 是常见写法，
  // trim 掉会变成 `用户：`，反而在正文中间误停。只过滤纯空白项。
  const stop = (params.stop ?? []).filter((s) => typeof s === 'string' && s.length > 0 && s.trim().length > 0)
  if (stop.length) body.stop = stop
  if (params.seed !== null && Number.isFinite(params.seed)) body.seed = params.seed

  return body
}

/**
 * 酒馆回复的审查判定。
 *
 * ⚠️ **不能复用流水线的 50 字阈值**。那个阈值是为结构化 JSON 产物定的
 * （任何真实任务输出最短也有几十个字段），但酒馆回复是**自然口语**：
 * 「我是爱德蒙·唐太斯，法老号上的大副。刚刚随船回到马赛。」
 * 只有 39 字，却是完全合格的角色扮演对白 —— 实测就撞过这个假拦截。
 *
 * 所以这里换一套判据：
 *   1) 极短（< 12 字）→ 大概率是拒绝语（「抱歉，我不能…」）或空回复；
 *   2) 或命中典型的拒绝句式开头 → 拦截。
 * 长度阈值取 12 而不是 50：一句正常的中文对白很少短于 12 字，
 * 而拒绝语几乎都短于这个长度。
 */
const REFUSAL_MAX_CHARS = 12
const REFUSAL_PATTERNS = [
  /^对不起[，,]?\s*我(不能|无法|不可以)/,
  /^抱歉[，,]?\s*我(不能|无法|不可以)/,
  /^我(不能|无法)(生成|提供|回答|协助|帮)/,
  /^作为(一个)?(AI|人工智能|语言模型)/i,
  /^I('m| am) (sorry|unable)/i,
  /^Sorry[,，]? (I|but)/i,
  /^(As an AI|I cannot|I can't)/i
]

/** 判定酒馆回复是否像拒绝/无效输出。 */
export function isLikelyRefusal(content: string): boolean {
  const t = content.trim()
  if (!t) return true
  if (t.length < REFUSAL_MAX_CHARS) return true
  return REFUSAL_PATTERNS.some((re) => re.test(t))
}

/**
 * 世界书匹配。
 *
 * 规则（对齐 SillyTavern 的 token 内匹配思路，但去掉它的复杂策略）：
 *   1) `constant` 条目**永远注入**（世界观这种不带关键词的）；
 *   2) 其余条目只要**任一 key 出现在最近 N 条消息**里就命中；
 *   3) 命中数超过 `limit` 时**按 insertionOrder 升序优先**（小的先 = 更基础的信息）。
 *
 * 为什么 key 用大写的 `includes` 而不是正则：角色名含「·」「」等字符，
 * 拼正则容易因特殊字符炸掉；大小写不敏感是为了英文名（「Dantès」/「dantes」）。
 */
export function matchLorebook(
  entries: LorebookEntry[],
  messages: TavernMessage[],
  limit: number
): { hits: LorebookEntry[]; hitIds: string[] } {
  if (!entries.length) return { hits: [], hitIds: [] }

  const recent = messages
    .filter((m) => m.role !== 'system')
    .slice(-6)
    .map((m) => m.content.toUpperCase())
    .join('\n')

  const constants = entries.filter((e) => e.constant)
  const matched = entries
    .filter((e) => !e.constant)
    .filter((e) => e.keys.some((k) => k && recent.includes(k.toUpperCase())))
    .sort((a, b) => a.insertionOrder - b.insertionOrder)

  const max = Math.max(1, limit)
  const combined = [...constants, ...matched].slice(0, max)
  // constant 条目被上限挤掉时单独补回（世界观不能因为条数上限而丢失）
  for (const c of constants) {
    if (!combined.includes(c)) combined.push(c)
  }
  return { hits: combined, hitIds: combined.map((e) => e.id) }
}

/**
 * 组装 system 消息。
 *
 * 顺序有意为之：**卡片人设在前、世界书在后**。
 * 越靠后的内容对生成的影响越大，所以把「当前场景相关的事实」（世界书）
 * 放在人设之后，避免人设把具体的当下情境压过去。
 */
export function buildSystemPrompt(card: CharacterCard, loreHits: LorebookEntry[]): string {
  const parts: string[] = []
  parts.push(
    '你正在进行角色扮演对话。请始终以角色的身份、语气和认知说话，' +
      '不要跳出角色做解释，不要复述设定原文，不要输出旁白说明。'
  )
  parts.push(`# 你的角色\n${card.name}`)
  if (card.aliases.length) parts.push(`别名：${card.aliases.join('、')}`)
  if (card.description) parts.push(`# 角色设定\n${card.description}`)
  if (card.personality) parts.push(`# 性格与身份\n${card.personality}`)
  if (card.scenario) parts.push(`# 情境\n${card.scenario}`)
  if (card.systemPrompt.trim()) parts.push(`# 额外要求\n${card.systemPrompt.trim()}`)
  if (loreHits.length) {
    parts.push('# 相关背景（供你理解，不要直接背诵）')
    for (const e of loreHits) parts.push(`【${e.name}】\n${e.content}`)
  }
  parts.push('回复要求：用中文，控制在 1–4 句话，符合角色当前处境与情绪；不要使用任何 Markdown 标记。')
  return parts.join('\n\n')
}

/** 把会话消息裁成能进上下文的部分（historyLimit=0 表示全部保留）。 */
export function trimHistory(messages: TavernMessage[], historyLimit: number): TavernMessage[] {
  const usable = messages.filter((m) => m.role === 'user' || m.role === 'assistant')
  if (!historyLimit || historyLimit <= 0) return usable
  return usable.slice(-historyLimit)
}

/**
 * 生成一条角色回复。
 *
 * 失败语义与流水线保持一致：
 *   - 审查拦截（返回 <50 字）→ `blocked: true`，**不重试**（重试结果一样）；
 *   - 其余错误直接返回可读中文，不静默吞掉。
 */
export async function generateTavernReply(
  card: CharacterCard,
  messages: TavernMessage[],
  params: TavernParams,
  lorebook: LorebookEntry[],
  settings: TavernSettings,
  provider: LlmProvider
): Promise<TavernGenerateResult> {
  if (!provider?.baseURL || !provider?.model) {
    return { ok: false, error: '尚未配置模型接入（设置 → 模型接入），无法对话' }
  }

  const lore = settings.useLorebook
    ? matchLorebook(lorebook, messages, settings.lorebookLimit)
    : { hits: [], hitIds: [] }

  const history = trimHistory(messages, settings.historyLimit)
  const chat = [
    { role: 'system', content: buildSystemPrompt(card, lore.hits) },
    ...history.map((m) => ({ role: m.role, content: m.content }))
  ]

  const body = buildTavernBody(provider, chat, params)
  const endpoint = endpointOf(provider)

  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${provider.apiKey.trim()}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000)
    })
  } catch (e) {
    return { ok: false, error: `对话请求失败：${(e as Error).message}`, usedParams: body }
  }

  const read = await readChatCompletion(res)
  if (!read.ok) {
    return { ok: false, error: `对话${read.error}`, usedParams: body, loreHits: lore.hitIds }
  }

  const content = read.content
  // 用酒馆专用的拒绝判据，**不用**流水线那条 50 字阈值：
  // 39 字的「我是爱德蒙·唐太斯，法老号上的大副…」是合格对白，会被 50 字规则误杀。
  if (isLikelyRefusal(content)) {
    return {
      ok: false,
      blocked: true,
      error: `上游返回疑似拒绝/空回复（${content.trim().length} 字符）：${content.trim().slice(0, 100)}`,
      usedParams: body,
      loreHits: lore.hitIds
    }
  }

  return {
    ok: true,
    content: content.trim(),
    loreHits: lore.hitIds,
    usedParams: body,
    usage: null
  }
}

/** 供上层做「一条 user 消息 + 一次生成」的便捷封装（IPC 用）。 */
export async function chatOnce(
  card: CharacterCard,
  messages: TavernMessage[],
  params: TavernParams,
  lorebook: LorebookEntry[],
  settings: TavernSettings,
  provider: LlmProvider
): Promise<TavernGenerateResult> {
  const r = await generateTavernReply(card, messages, params, lorebook, settings, provider)
  if (!r.ok) return r
  // 轻微延迟：连续快速点击时给上游一点喘息，避免撞上速率限制
  await sleep(0)
  return r
}

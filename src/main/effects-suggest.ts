/**
 * P4 特效 LLM 推荐（主进程）。
 *
 * 约束：
 * - 任意 OpenAI 兼容 `/chat/completions`（不绑定供应商）；用 Node 18+ 全局 fetch + AbortSignal.timeout。
 * - 配置**唯一真源** = `settings.llm[]` + `activeLlmId`（经 `pipeline/providers.activeProvider('llm')` 取）；
 *   **不再读旧单组字段 `baseURL/apiKey/model`**（Step1 收敛，消除"改了两套配置之一却不生效"）。
 * - 请求体由 `pipeline/llm-client.buildRequestBody` 统一构造（抓包口径不破）：
 *   **不含 temperature**、`stream:false`、`response_format:{type:'json_object'}`；
 *   输出上限字段按 providerKind 二选一（minimax/mimo → `max_completion_tokens`；其它含 custom → `max_tokens`）。
 * - 未配置 / 该组被禁用 / 未填完整 → **立即返回可读中文错误，不发起任何网络请求**。
 * - 模型返回的 effectId 走**目录白名单**过滤：未知 id 丢弃并计入 `dropped`，绝不写回臆造特效。
 */
import { loadCatalog } from './effects/catalog'
import { validateBaseURL } from './settings/store'
import { activeProvider } from './pipeline/providers'
import { buildRequestBody, endpointOf } from './pipeline/llm-client'
import type { ChatMessage, LlmProvider } from '../shared/pipeline-types'
import type {
  EffectCatalogEntry,
  EffectSuggestInput,
  EffectSuggestItem,
  EffectSuggestResult
} from '../shared/effects-types'

const TIMEOUT_MS = 60_000
/**
 * 特效推荐输出上限（供 `buildRequestBody` 按 providerKind 落到 `max_tokens` / `max_completion_tokens`）。
 * 结果至多 3 条特效的 JSON，2k token 足够，同时兜住模型跑飞。
 */
const EFFECT_SUGGEST_MAX_TOKENS = 2048

interface RawSuggestion {
  id?: unknown
  effectId?: unknown
  reason?: unknown
  confidence?: unknown
  cId?: unknown
  characterId?: unknown
}

/**
 * 目录 → 提示表（A4：摘要改用 `guide`，不再截断 description）。
 *
 * 为什么改：`description` 说的是「这个特效怎么工作」，不是「什么时候该用它」。
 * 实测 `portrait-cutin` 的 description 是「自动检测当前立绘的不透明顶部与底部…」，
 * 还被 `slice(0, 40)` 截掉大半 —— 模型看到这行不可能知道「普通说话别用这个」。
 * `guide` 才是新版给模型的判断依据，且本身平均只有 30 字左右，不需要截断。
 *
 * 兜底：46 条没有 guide（FB 里没有对应，环境类与基础演出），回落 description 前 40 字。
 */
function catalogDigest(entries: EffectCatalogEntry[]): string {
  return entries
    .map((e) => {
      const guide = (e.guide ?? '').trim()
      const fallback = (e.description ?? '').replace(/\s+/g, ' ').slice(0, 40)
      const basis = guide || fallback
      // target 特效在清单里显式标注，让模型知道这条必须给出人物
      const needChar = e.target ? ' | 需指定人物' : ''
      return `- ${e.id} | ${e.name} | ${e.category}${basis ? ` | ${basis}` : ''}${needChar}`
    })
    .join('\n')
}

/**
 * system 提示词（A4：五段结构化，照新版 `manga_effects_system_prompt` 的写法）。
 *
 * 原实现只有一句话，只说了「要什么」，没说「什么时候不该要」——
 * 这是漏挂与乱挂的直接原因。五段分别回答：
 *   【角色】你是什么 · 【输入结构】给你什么 · 【特效清单】可选项与判断依据
 *   【选择原则】什么时候选/不选 · 【输出约束】格式与硬规则
 */
function buildSystemPrompt(hasTargetEffect: boolean): string {
  const targetRule = hasTargetEffect
    ? '\n- 清单中标注「需指定人物」的特效，必须在结果里给出 cId（画面中的人物 id）。' +
      '\n- 若无法确定该特效作用于哪个人物，**不要推荐这个特效**，宁可返回空数组也不要硬猜。' +
      '\n- cId 只能填「本句人物」里出现过的 id，不得编造。'
    : ''
  return (
    '【角色】\n' +
    '你是互动视觉小说的演出特效导演，负责为单句剧本挑选最契合的画面特效。\n' +
    '你只做选择，不发明特效：可选范围严格限定在下方【特效清单】内。\n' +
    '\n【输入结构】\n' +
    '你会收到一句剧本正文，以及它的说话人、场景、类型（叙述/对白/心声等）。\n' +
    '\n【特效清单】\n' +
    '每行格式：`id | 名称 | 类别 | 判断依据`。判断依据写明了「是什么、什么时候用、什么时候不用」，' +
    '请以它为准，不要只看名称去联想。\n' +
    '\n【选择原则】\n' +
    '- 只在该句的**画面语义**确实需要时才选；宁可少选，不要为了热闹硬加。\n' +
    '- 每句 0~3 个。超过 3 个会让画面互相干扰。\n' +
    '- 判断依据里写了「不用于…」的场合，就**不要**选。\n' +
    '- 同一句内避免选择互斥特效（例如同时「变亮」与「变暗」、同时多种调色滤镜）。\n' +
    '- 纯信息性叙述、日常对话、无画面变化的句子，通常应该返回空数组。' +
    targetRule +
    '\n\n【输出约束】\n' +
    '只输出一个 JSON 对象，不要任何解释文字、不要 Markdown 代码块。格式：\n' +
    '{"effects":[{"id":"<清单中的 id>","reason":"<简短理由>","confidence":0.0}]}\n' +
    '需要人物时增加 "cId":"<人物 id>"。若该句不宜加特效，返回 {"effects":[]}。'
  )
}

function buildMessages(input: EffectSuggestInput, entries: EffectCatalogEntry[]): ChatMessage[] {
  const hasTarget = entries.some((e) => e.target === true)
  const system = buildSystemPrompt(hasTarget)
  const user =
    `【特效清单】（格式：id | 名称 | 类别 | 判断依据）\n${catalogDigest(entries)}\n\n` +
    `【本句】\n${input.text ?? ''}\n` +
    `说话人：${input.speaker ?? '（未知/旁白）'}\n` +
    `人物：${input.characterIds?.length ? input.characterIds.join('、') : '（未知）'}\n` +
    `场景：${input.scene ?? '（未知）'}\n` +
    `类型：${input.type ?? '（未知）'}`
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]
}

/**
 * 白名单过滤：known 保序保留，unknown 原样丢进 dropped。
 *
 * A3 增加 cId 处理：
 *   - 只对目录里 `target: true` 的特效保留 cId（其它特效的 cId 无意义，丢掉更干净）；
 *   - cId 必须出现在 `input.characterIds` 里（有给清单时），否则丢弃该 cId
 *     —— 保留特效本身，只是回落「当前句说话人」，这是更稳妥的降级；
 *   - `target: true` 但模型没给 cId：**仍然保留**该特效（渲染层会回落当前说话人立绘），
 *     因为对 `portrait-cutin` 这类，切「当前说话人」通常就是对的。
 */
function whitelist(
  raw: RawSuggestion[],
  entries: EffectCatalogEntry[],
  knownCharacterIds?: string[]
): {
  kept: EffectSuggestItem[]
  dropped: string[]
} {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const charSet = knownCharacterIds?.length ? new Set(knownCharacterIds) : null
  const kept: EffectSuggestItem[] = []
  const dropped: string[] = []
  const seen = new Set<string>()
  for (const r of raw ?? []) {
    const idRaw = r?.id ?? r?.effectId
    const id = typeof idRaw === 'string' ? idRaw.trim() : ''
    if (!id) continue
    if (!byId.has(id)) {
      if (!dropped.includes(id)) dropped.push(id)
      continue
    }
    if (seen.has(id)) continue
    seen.add(id)
    const entry = byId.get(id)
    const reason = typeof r.reason === 'string' ? r.reason : undefined
    const conf = typeof r.confidence === 'number' && Number.isFinite(r.confidence) ? r.confidence : undefined

    // ---- cId ----
    let cId: string | undefined
    const rawCid = r.cId ?? r.characterId
    if (entry?.target === true && typeof rawCid === 'string') {
      const c = rawCid.trim()
      // 有清单时只接受清单内的 id；没给清单（老调用方）则原样接受
      if (c && (!charSet || charSet.has(c))) cId = c
    }

    kept.push({ effectId: id, name: entry?.name, reason, confidence: conf, ...(cId ? { cId } : {}) })
  }
  return { kept, dropped }
}

/** 从模型返回内容中抽出 { effects: [...] }（容忍 ```json 包裹） */
function parseSuggestions(content: string): RawSuggestion[] {
  let text = (content ?? '').trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fence) text = fence[1].trim()
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch {
    // 兜底：截取第一个 { 到最后一个 } 再解析
    const s = text.indexOf('{')
    const e = text.lastIndexOf('}')
    if (s >= 0 && e > s) {
      try {
        obj = JSON.parse(text.slice(s, e + 1))
      } catch {
        return []
      }
    } else {
      return []
    }
  }
  if (obj && typeof obj === 'object') {
    const list = (obj as Record<string, unknown>).effects
    if (Array.isArray(list)) return list as RawSuggestion[]
  }
  return []
}

/**
 * 解析当前应使用的 LLM 配置（唯一真源：`llm[]` + `activeLlmId`）。
 * 不可用（无配置 / 被禁用 / 未填完整）时给出可读中文原因，调用方据此立即返回、**不发请求**。
 */
async function resolveActiveLlm(): Promise<{ ok: true; provider: LlmProvider } | { ok: false; error: string }> {
  const resolved = (await activeProvider('llm')) as LlmProvider | null
  if (!resolved) {
    return { ok: false, error: '尚未配置模型接入（设置 → 模型接入），无法进行 AI 推荐' }
  }
  if (!resolved.enabled) {
    return { ok: false, error: '尚未配置模型接入（设置 → 模型接入）：当前选中的配置已被禁用，无法进行 AI 推荐' }
  }
  if (!resolved.baseURL.trim() || !resolved.apiKey.trim() || !resolved.model.trim()) {
    return {
      ok: false,
      error: '尚未配置模型接入（设置 → 模型接入）：当前配置的 Base URL / API Key / Model 未填完整，无法进行 AI 推荐'
    }
  }
  return { ok: true, provider: resolved }
}

/**
 * 推荐特效。未配置模型接入时立即返回可读错误（不发请求）。
 */
export async function suggestEffects(input: EffectSuggestInput): Promise<EffectSuggestResult> {
  const text = (input.text ?? '').trim()
  if (!text) return { ok: false, error: '该句文本为空，无法推荐特效' }

  const picked = await resolveActiveLlm()
  if (!picked.ok) return { ok: false, error: picked.error }
  const provider = picked.provider

  const check = validateBaseURL(provider.baseURL)
  if (!check.ok) return { ok: false, error: `Base URL 不合法：${check.reason}` }

  const cat = await loadCatalog()
  if (!cat.ok || !cat.entries) return { ok: false, error: cat.error ?? '特效目录不可用' }
  const entries = cat.entries

  // 请求体统一由 llm-client 构造：不含 temperature / stream:false / response_format:json_object，
  // 输出上限字段按 providerKind 二选一。
  const endpoint = endpointOf(provider)
  const reqBody = buildRequestBody(provider, buildMessages(input, entries), {
    maxTokens: EFFECT_SUGGEST_MAX_TOKENS
  })

  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${provider.apiKey.trim()}`
      },
      body: JSON.stringify(reqBody),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (e) {
    return { ok: false, error: `特效推荐请求失败：${(e as Error).message}` }
  }

  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 300)
    } catch {
      // 忽略读取失败
    }
    return { ok: false, error: `特效推荐上游返回 ${res.status}${detail ? `：${detail}` : ''}` }
  }

  let parsed: unknown
  try {
    parsed = await res.json()
  } catch (e) {
    return { ok: false, error: `特效推荐响应非 JSON：${(e as Error).message}` }
  }

  const content = (() => {
    if (!parsed || typeof parsed !== 'object') return ''
    const choices = (parsed as Record<string, unknown>).choices
    if (!Array.isArray(choices) || !choices.length) return ''
    const msg = (choices[0] as Record<string, unknown>)?.message as Record<string, unknown> | undefined
    const c = msg?.content
    return typeof c === 'string' ? c : ''
  })()
  if (!content) return { ok: false, error: '特效推荐响应缺少 choices[0].message.content' }

  const raw = parseSuggestions(content)
  const { kept, dropped } = whitelist(raw, entries, input.characterIds)
  return { ok: true, items: kept, dropped }
}

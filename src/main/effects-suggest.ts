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
}

/** 目录 → 精简提示表（id/名称/类别/简述），控制 token 体量 */
function catalogDigest(entries: EffectCatalogEntry[]): string {
  return entries
    .map((e) => {
      const desc = (e.description ?? '').replace(/\s+/g, ' ').slice(0, 40)
      return `- ${e.id} | ${e.name} | ${e.category}${desc ? ` | ${desc}` : ''}`
    })
    .join('\n')
}

function buildMessages(input: EffectSuggestInput, entries: EffectCatalogEntry[]): ChatMessage[] {
  const system =
    '你是演出特效导演。请为给定的一句剧本，从下方【特效清单】中挑选 0~3 个最契合的特效（可多选）。' +
    '严格只使用清单中出现的 id，不得编造。只输出 JSON 对象，形如 ' +
    '{"effects":[{"id":"<清单中的id>","reason":"<简短理由>","confidence":0.0}]}。' +
    '若该句不宜加特效，返回 {"effects":[]}。'
  const user =
    `【特效清单】（格式：id | 名称 | 类别 | 简述）\n${catalogDigest(entries)}\n\n` +
    `【本句】\n${input.text ?? ''}\n` +
    `说话人：${input.speaker ?? '（未知/旁白）'}\n` +
    `场景：${input.scene ?? '（未知）'}\n` +
    `类型：${input.type ?? '（未知）'}`
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]
}

/** 白名单过滤：known 保序保留，unknown 原样丢进 dropped */
function whitelist(raw: RawSuggestion[], entries: EffectCatalogEntry[]): {
  kept: EffectSuggestItem[]
  dropped: string[]
} {
  const byId = new Map(entries.map((e) => [e.id, e]))
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
    const reason = typeof r.reason === 'string' ? r.reason : undefined
    const conf = typeof r.confidence === 'number' && Number.isFinite(r.confidence) ? r.confidence : undefined
    kept.push({ effectId: id, name: byId.get(id)?.name, reason, confidence: conf })
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
  const { kept, dropped } = whitelist(raw, entries)
  return { ok: true, items: kept, dropped }
}

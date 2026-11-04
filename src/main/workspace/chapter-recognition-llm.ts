/**
 * 章节识别 LLM 兜底的**执行层**（把 `chapter-recognition.ts` 的纯逻辑接到 LLM 上）。
 *
 * 链路：
 *   全文 → buildStructureReport() 产出结构报告 →
 *   渲染 `chapter_recognition_system_prompt` → 调 LLM →
 *   parseRecognitionJson() 校验 → 把选中的组还原成字符偏移
 *
 * 设计要点：
 * - **只发结构报告，不发全文**。一本 30 万字的小说塞不进上下文，
 *   而判断「哪个组是章节」只需要统计特征 + 少量样例。
 * - 模型只回答「哪个 groupId 当章节」，**由程序把组还原成行/偏移**——
 *   让 LLM 直接输出切分位置会丢字、会幻觉行号。
 * - 任何失败返回 null，调用方继续用正则结果。
 */
import { activeProvider } from '../pipeline/providers'
import { buildRequestBody, endpointOf } from '../pipeline/llm-client'
import type { LlmProvider } from '../../shared/pipeline-types'
import { renderPrompt } from '../pipeline/prompt-loader'
import { validateBaseURL } from '../settings/store'
import {
  buildStructureReport,
  parseRecognitionJson,
  type ChapterRecognitionResult
} from './chapter-recognition'

const TIMEOUT_MS = 60_000

/**
 * 用 LLM 判断章节结构，返回**章节标题行的字符偏移**。
 *
 * @returns null = 放弃兜底（正则结果照用）
 */
export async function recognizeChaptersByLlm(
  text: string
): Promise<{ charStarts: number[]; titles: string[]; result: ChapterRecognitionResult } | null> {
  // ---- 1. LLM 配置 ----
  const provider = (await activeProvider('llm')) as LlmProvider | null
  if (!provider || !provider.enabled) return null
  if (!provider.baseURL.trim() || !provider.apiKey.trim() || !provider.model.trim()) return null
  const check = validateBaseURL(provider.baseURL)
  if (!check.ok) return null

  // ---- 2. 结构报告 ----
  const report = buildStructureReport(text)
  // 候选组太少说明这文本本身就没有章节结构，不必问模型
  if (report.groups.length < 2) return null

  // ---- 3. 渲染提示词 ----
  let system: string
  try {
    system = await renderPrompt('chapter_recognition_system_prompt', {})
  } catch {
    return null
  }
  if (!system.trim()) return null

  // ---- 4. 调用 ----
  const messages = [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: JSON.stringify(report, null, 1) }
  ]
  const reqBody = buildRequestBody(provider, messages, { maxTokens: 4096 })
  let res: Response
  try {
    res = await fetch(endpointOf(provider), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey.trim()}` },
      body: JSON.stringify(reqBody),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch {
    return null
  }
  if (!res.ok) return null
  let parsed: unknown
  try {
    parsed = await res.json()
  } catch {
    return null
  }
  const content = (() => {
    if (!parsed || typeof parsed !== 'object') return ''
    const choices = (parsed as Record<string, unknown>).choices
    if (!Array.isArray(choices) || !choices.length) return ''
    const msg = (choices[0] as Record<string, unknown>)?.message as Record<string, unknown> | undefined
    const c = msg?.content
    return typeof c === 'string' ? c : ''
  })()
  if (!content) return null

  // ---- 5. 校验 ----
  const result = parseRecognitionJson(content)
  if (!result) return null
  // 模型自己说不确定 → 尊重它，不硬套
  if (result.status === 'uncertain') return null

  // ---- 6. 把选中的组长还原成字符偏移 ----
  // 需要重新扫一遍正文拿到「该组每个标题行的 charStart」。
  // 这里按 groupId 顺序重新分组，与 buildStructureReport 的分组逻辑保持一致。
  const chosen = new Set(result.groups.filter((g) => g.role === 'chapter' || g.role === 'volume').map((g) => g.groupId))
  if (!chosen.size) return null
  const picked = pickGroupLines(text, chosen)
  if (picked.length < 2) return null
  // 按出现顺序排序（模板要求「章卷按原文出现顺序排列」）
  picked.sort((a, b) => a.charStart - b.charStart)
  return {
    charStarts: picked.map((p) => p.charStart),
    titles: picked.map((p) => p.title),
    result
  }
}

/**
 * 按 groupId 取出对应组的全部候选行（重新扫描一遍正文）。
 *
 * 为什么不复用 `buildStructureReport` 的中间结果：那个函数只返回统计摘要，
 * 不含每行的 charStart（模型不需要，也不需要发）。所以这里按**同一套
 * 分组规则**重扫一次，保证 groupId 对应关系一致。
 *
 * ⚠️ 分组规则必须与 `buildStructureReport` 严格一致（同样的排序 + 同样的
 * `g{n}` 编号）。若两处漂移，会出现「模型选了 g2 但还原成别的组」的静默错误。
 * 为此把「按 count 降序取前 N 个家族」的确定性逻辑抽在这里单点维护。
 */
function pickGroupLines(
  text: string,
  chosen: Set<string>
): { title: string; charStart: number }[] {
  // 用 report 的 group 顺序反推：group i 的 family 必须与重扫结果一致。
  // 为稳妥，这里**只按 groupId 序号取家族**，不依赖 family 字符串匹配。
  const lines = text.split('\n')
  const all: { title: string; charStart: number; familyKey: string }[] = []
  let pos = 0
  let seq = 0
  for (const raw of lines) {
    const lineStart = pos
    pos += raw.length + 1
    const trimmed = raw.trimStart()
    if (!trimmed) continue
    const body = trimmed.trimEnd()
    const t = body.trim()
    if (!t || t.length > 60) continue
    const cls = classifyForGrouping(t)
    if (!cls) continue
    seq++
    all.push({ title: t, charStart: lineStart + (raw.length - trimmed.length), familyKey: cls })
  }
  const byFamily = new Map<string, { title: string; charStart: number; familyKey: string }[]>()
  for (const c of all) {
    const arr = byFamily.get(c.familyKey) ?? []
    arr.push(c)
    byFamily.set(c.familyKey, arr)
  }
  const sorted = [...byFamily.entries()].sort((a, b) => b[1].length - a[1].length)
  const out: { title: string; charStart: number }[] = []
  for (let gi = 0; gi < sorted.length; gi++) {
    const gid = `g${gi + 1}`
    if (!chosen.has(gid)) continue
    for (const c of sorted[gi][1]) out.push({ title: c.title, charStart: c.charStart })
  }
  return out
}

/** 与 `chapter-recognition.ts` 的 `classifyLine` 同口径的家族键（只返回 familyKey）。 */
function classifyForGrouping(t: string): string | null {
  let m = /^第\s*([0-9０-９一二三四五六七八九十百千零〇两]+)\s*([章回节篇部卷集话話])/.exec(t)
  if (m) return `di-${m[2]}`
  m = /^(?:chapter|chap\.?)\s*([0-9]+)\b/i.exec(t)
  if (m) return 'chapter-en'
  m = /^([0-9０-９一二三四五六七八九十百千零〇两]+)\s*[、.．]\s*\S/.exec(t)
  if (m) return 'cn-num-dun'
  m = /^卷\s*([0-9０-９一二三四五六七八九十百千零〇两]+)/.exec(t)
  if (m) return 'juan-lead'
  if (/^(序章|序言|序曲|楔子|前言|引子|尾声|终章|后记|跋|番外)/.test(t)) return 'special'
  m = /^(#{1,6})\s+\S/.exec(t)
  if (m) return `md-${m[1].length}`
  return null
}

/** 兜底是否可用（供 UI 提示用；不实际发请求） */
export async function chapterFallbackAvailable(): Promise<boolean> {
  const provider = (await activeProvider('llm')) as LlmProvider | null
  return !!provider && provider.enabled && !!provider.baseURL.trim() && !!provider.apiKey.trim() && !!provider.model.trim()
}

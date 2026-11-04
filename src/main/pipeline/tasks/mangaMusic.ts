/**
 * `mangaMusic` 任务适配器（C 线；模板 `manga_music_system_prompt` + `manga_music_merge_system_prompt`）。
 *
 * 两阶段（模板就是两份，对应真包里的两组任务）：
 *   1. **规划**（`mangaMusic:music:<ch>:…:brief`）：读漫画脚本 → 产出 `musicGroups`
 *      （每个 group = 一份 musicBrief + 覆盖的章节/页范围）
 *   2. **合并**（`mangaMusic:chapter:<ch>:…`）：把相邻、情绪相近的 groups 合并
 *      （实测真包的章级 `groups[].plan.musicBrief` 就是合并结果）
 *
 * 本适配器只做**阶段 1（规划）**：阶段 2 需要跨 chunk 聚合全部 groups，
 * 属于 global 任务，由 `mangaMusicMerge` 适配器处理（见同目录）。
 *
 * 产物：`records/results/mangaMusic:music:<chunk>:…:brief.json`
 * 输出契约（模板原文，与 gmzz-10 的 `:brief` 条目逐字一致）：
 * ```jsonc
 * { "musicGroups": [
 *     { "musicBrief": {
 *         "purpose": "叙事用途", "mood": ["情绪"], "style": ["风格"],
 *         "energy": 2, "pace": "慢", "avoid": ["人声"] },
 *       "chapters": [{ "chapterSeq": 1, "ranges": [{ "fromPage": 1, "toPage": 2 }] }] }
 *   ] }
 * ```
 *
 * 【注意 musicGroups vs groups】真包里两种键名并存：
 *   - `:brief` 条目的值叫 **`musicGroups`**
 *   - 章级 `:chapter:` 条目的值叫 **`groups`**（内含 plan+selection）
 * 本适配器产出 `musicGroups`（阶段 1 的形状），合并阶段产出 `groups`。
 */
import type { ChatMessage, LlmTaskAdapter, TaskRuntime } from '../../../shared/pipeline-types'
import { parseJsonLoose } from './cacheWarming'

const PACES = new Set(['慢', '中', '快', '自由'])

/** 从上游条目取 mangaScript 的 chapters */
function pickChapters(value: unknown): Record<string, unknown>[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const o = value as Record<string, unknown>
  const d = o.data && typeof o.data === 'object' && !Array.isArray(o.data) ? (o.data as Record<string, unknown>) : o
  const chapters = d.chapters
  if (!Array.isArray(chapters)) return null
  return chapters.filter(
    (c): c is Record<string, unknown> => !!c && typeof c === 'object' && !Array.isArray(c)
  )
}

/**
 * 可引用的章/页范围（模板 `pageRanges` 变量）。
 *
 * 实测真包第 8 章有 2 页，其余 1 页 —— 模板特别强调
 * 「一章若仅有1页，无论包含多少分镜，该章的范围只能是 fromPage=1、toPage=1」，
 * 所以这里如实按每章实际页数给出范围，不臆造。
 */
function buildPageRanges(chapters: Record<string, unknown>[]): string {
  const lines: string[] = []
  for (const c of chapters) {
    const seq = Number(c.chapterSeq ?? 0)
    if (!seq) continue
    const pages = Array.isArray(c.pages) ? c.pages.length : 0
    const from = 1
    const to = Math.max(1, pages)
    lines.push(`第 ${seq} 章：fromPage=${from}, toPage=${to}（共 ${to} 页）`)
  }
  return lines.join('\n')
}

export const mangaMusicAdapter: LlmTaskAdapter = {
  id: 'mangaMusic',
  mergeStrategy: 'concat-dedup-order',
  // 整份脚本 + 范围表一次给模型
  batching: { inputBudgetTokens: 100000 },

  /** 稳定键：同章同范围只保留一份需求（合并阶段才做去重整合） */
  keyOf(part: unknown): string {
    if (typeof part === 'string') return `warn:${part}`
    if (part && typeof part === 'object' && !Array.isArray(part)) {
      const o = part as Record<string, unknown>
      const brief = o.musicBrief as Record<string, unknown> | undefined
      if (brief && typeof brief === 'object') {
        // 用 purpose + mood 组合作为「同类需求」的指纹
        const purpose = typeof brief.purpose === 'string' ? brief.purpose : ''
        const mood = Array.isArray(brief.mood) ? brief.mood.join(',') : ''
        if (purpose) return `brief:${purpose}|${mood}`
      }
    }
    try {
      return JSON.stringify(part)
    } catch {
      return String(part)
    }
  },

  /** 输入 = 漫画脚本（与 mangaEffects 同源，模板同样要求 JSON） */
  async inputText(rt: TaskRuntime): Promise<string> {
    if (typeof rt.readUpstream !== 'function') {
      throw new Error('mangaMusic 需要 mangaScript 产物：运行期未提供 readUpstream')
    }
    const entries = await rt.readUpstream('mangaScript')
    if (!entries.length) {
      throw new Error('mangaMusic 需要 mangaScript 产物：请先运行漫画脚本任务')
    }
    const all: Record<string, unknown>[] = []
    const seen = new Set<number>()
    for (const e of entries) {
      const chapters = pickChapters(e.value)
      if (!chapters) continue
      for (const c of chapters) {
        const seq = Number(c.chapterSeq ?? 0)
        if (!seq || seen.has(seq)) continue
        seen.add(seq)
        all.push(c)
      }
    }
    if (!all.length) throw new Error('mangaScript 产物里没有任何 chapters，无法规划配乐')
    all.sort((a, b) => Number(a.chapterSeq ?? 0) - Number(b.chapterSeq ?? 0))
    // 配乐规划只需要「每页有哪些台词」判断情绪，不需要 lines/scene 细节
    const slim = all.map((c) => ({
      chapterSeq: c.chapterSeq,
      pages: (Array.isArray(c.pages) ? c.pages : []).map((p) => {
        const pg = p as Record<string, unknown>
        return {
          context: pg.context ?? '',
          panels: (Array.isArray(pg.panels) ? pg.panels : []).map((pn) => {
            const x = pn as Record<string, unknown>
            return { no: x.no, speech: x.speech ?? [] }
          })
        }
      })
    }))
    return JSON.stringify({ chapters: slim }, null, 1)
  },

  async buildMessages(batchText: string, rt: TaskRuntime): Promise<ChatMessage[]> {
    // 模板是 system 型且自带 {{pageRanges}} 占位符
    const chapters = await (async () => {
      try {
        const entries = await rt.readUpstream?.('mangaScript') ?? []
        for (const e of entries) {
          const cs = pickChapters(e.value)
          if (cs?.length) return cs
        }
      } catch {
        // 忽略
      }
      return [] as Record<string, unknown>[]
    })()
    const pageRanges = buildPageRanges(chapters)
    const system = await rt.render('manga_music_system_prompt', { pageRanges })
    if (!system.trim()) rt.warnings.push('mangaMusic：manga_music_system_prompt 模板为空')
    return [
      { role: 'system', content: system },
      { role: 'user', content: batchText }
    ]
  },

  parse(content: string): unknown {
    const obj = parseJsonLoose(content)
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const o = obj as Record<string, unknown>
      const groups = o.musicGroups
      if (!Array.isArray(groups)) {
        return { musicGroups: [], raw: (content ?? '').slice(0, 500) }
      }
      const out: Record<string, unknown>[] = []
      for (const g of groups) {
        if (!g || typeof g !== 'object' || Array.isArray(g)) continue
        const gr = g as Record<string, unknown>
        const brief = gr.musicBrief
        if (!brief || typeof brief !== 'object' || Array.isArray(brief)) continue
        const b = brief as Record<string, unknown>
        // 字段级校验（模板硬约束）：mood/style 非空字符串数组、energy 1~5、pace 四选一
        const mood = Array.isArray(b.mood)
          ? b.mood.filter((x): x is string => typeof x === 'string' && !!x.trim())
          : []
        const style = Array.isArray(b.style)
          ? b.style.filter((x): x is string => typeof x === 'string' && !!x.trim())
          : []
        if (!mood.length || !style.length) continue
        const energyRaw = Number(b.energy)
        if (!Number.isFinite(energyRaw) || energyRaw < 1 || energyRaw > 5) continue
        const pace = typeof b.pace === 'string' && PACES.has(b.pace) ? b.pace : '中'
        const avoid = Array.isArray(b.avoid)
          ? b.avoid.filter((x): x is string => typeof x === 'string' && !!x.trim())
          : []
        const purpose = typeof b.purpose === 'string' ? b.purpose.trim() : ''

        // chapters：每章 ranges 为页码闭区间，fromPage <= toPage
        const chsRaw = gr.chapters
        if (!Array.isArray(chsRaw)) continue
        const chapters: Record<string, unknown>[] = []
        for (const c of chsRaw) {
          if (!c || typeof c !== 'object' || Array.isArray(c)) continue
          const cr = c as Record<string, unknown>
          const seq = Number(cr.chapterSeq ?? 0)
          if (!seq) continue
          const rangesRaw = cr.ranges
          if (!Array.isArray(rangesRaw)) continue
          const ranges: { fromPage: number; toPage: number }[] = []
          for (const r of rangesRaw) {
            if (!r || typeof r !== 'object' || Array.isArray(r)) continue
            const rr = r as Record<string, unknown>
            const from = Number(rr.fromPage ?? 0)
            const to = Number(rr.toPage ?? 0)
            if (!Number.isFinite(from) || !Number.isFinite(to)) continue
            if (from < 1 || to < from) continue
            ranges.push({ fromPage: Math.round(from), toPage: Math.round(to) })
          }
          if (ranges.length) chapters.push({ chapterSeq: seq, ranges })
        }
        if (!chapters.length) continue

        out.push({
          musicBrief: { purpose, mood, style, energy: Math.round(energyRaw), pace, avoid },
          chapters
        })
      }
      return { musicGroups: out }
    }
    return { musicGroups: [], raw: (content ?? '').slice(0, 500) }
  }
}

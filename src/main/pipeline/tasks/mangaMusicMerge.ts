/**
 * `mangaMusicMerge` 任务适配器（C 线；模板 `manga_music_merge_system_prompt`）。
 *
 * 这是 `mangaMusic` 的**阶段 2**：把阶段 1 产出的多组 `musicGroups` 合并成
 * 情绪/强度/节奏相近、可以共用同一首曲子的若干组。
 *
 * 产物：`records/results/mangaMusic:chapter:<ch>:…json`（章级 `groups` 形态）
 *
 * 模板约束（parse 侧落实为校验）：
 *   - 每个原有覆盖页**必须仍被覆盖一次**，不能新增/删除/重复/移动页范围
 *   - 不能把中间原本留白的页填满
 *   - 同组同章相邻区间可以合并
 *   - 不编造曲名或曲库 ID（本适配器不产出曲目，只产出需求）
 *
 * 为什么单开一个适配器而不是复用 mangaMusic：
 *   输入完全不同——阶段 1 吃 mangaScript（整份脚本），阶段 2 吃阶段 1 的 musicGroups
 *   （已结构化，不含脚本文本）。塞进一个适配器会让 `inputText` 变成 if 分支，
 *   且 mergeStrategy/keyOf 也各不相同。
 */
import type { ChatMessage, LlmTaskAdapter, TaskRuntime } from '../../../shared/pipeline-types'
import { parseJsonLoose } from './cacheWarming'

const PACES = new Set(['慢', '中', '快', '自由'])

/** 从上游条目取 musicGroups（阶段 1 产物；键名是 musicGroups 不是 groups） */
function pickMusicGroups(value: unknown): Record<string, unknown>[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const o = value as Record<string, unknown>
  const d = o.data && typeof o.data === 'object' && !Array.isArray(o.data) ? (o.data as Record<string, unknown>) : o
  const groups = d.musicGroups
  if (!Array.isArray(groups)) return null
  return groups.filter(
    (g): g is Record<string, unknown> => !!g && typeof g === 'object' && !Array.isArray(g)
  )
}

export const mangaMusicMergeAdapter: LlmTaskAdapter = {
  id: 'mangaMusicMerge',
  mergeStrategy: 'concat-dedup-order',
  batching: { inputBudgetTokens: 100000 },

  /**
   * 稳定键：按 musicBrief 的内容指纹。
   *
   * 合并阶段的产物本身就是「已合并」结果，同一 brief 不该出现两次。
   * 这里用 purpose+mood 做指纹（与 mangaMusic 的 keyOf 同一套规则，
   * 保证两个阶段对「同类需求」的判定一致）。
   */
  keyOf(part: unknown): string {
    if (typeof part === 'string') return `warn:${part}`
    if (part && typeof part === 'object' && !Array.isArray(part)) {
      const o = part as Record<string, unknown>
      const brief = o.musicBrief as Record<string, unknown> | undefined
      if (brief && typeof brief === 'object') {
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

  /** 输入 = 阶段 1 全部 musicGroups 汇成一份（合并需要看到全部才能判断相近性） */
  async inputText(rt: TaskRuntime): Promise<string> {
    if (typeof rt.readUpstream !== 'function') {
      throw new Error('mangaMusicMerge 需要 mangaMusic 产物：运行期未提供 readUpstream')
    }
    const entries = await rt.readUpstream('mangaMusic')
    if (!entries.length) {
      throw new Error('mangaMusicMerge 需要 mangaMusic 产物：请先运行漫画配乐需求任务')
    }
    const groups: Record<string, unknown>[] = []
    for (const e of entries) {
      const gs = pickMusicGroups(e.value)
      if (gs) groups.push(...gs)
    }
    if (!groups.length) {
      throw new Error('mangaMusic 产物里没有任何 musicGroups，无法合并')
    }
    return JSON.stringify({ musicGroups: groups }, null, 1)
  },

  async buildMessages(batchText: string, rt: TaskRuntime): Promise<ChatMessage[]> {
    const system = await rt.render('manga_music_merge_system_prompt', {})
    if (!system.trim()) rt.warnings.push('mangaMusicMerge：manga_music_merge_system_prompt 模板为空')
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
        return { groups: [], musicGroups: [], raw: (content ?? '').slice(0, 500) }
      }
      const out: Record<string, unknown>[] = []
      for (const g of groups) {
        if (!g || typeof g !== 'object' || Array.isArray(g)) continue
        const gr = g as Record<string, unknown>
        const brief = gr.musicBrief
        if (!brief || typeof brief !== 'object' || Array.isArray(brief)) continue
        const b = brief as Record<string, unknown>
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

        const chsRaw = gr.chapters
        if (!Array.isArray(chsRaw)) continue
        const chapters: Record<string, unknown>[] = []
        for (const c of chsRaw) {
          if (!c || typeof c !== 'object' || Array.isArray(c)) continue
          const cr = c as Record<string, unknown>
          const seq = Number(cr.chapterSeq ?? 0)
          if (!seq) continue
          if (!Array.isArray(cr.ranges)) continue
          const ranges: { fromPage: number; toPage: number }[] = []
          for (const r of cr.ranges as unknown[]) {
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

        const briefOut = { purpose, mood, style, energy: Math.round(energyRaw), pace, avoid }
        // 同时给两种键名：`groups`（真包章级形态）/ `musicGroups`（模板输出契约）。
        // 两个都写是有意的——`collectMusic()` 读 groups，而模板契约写 musicGroups，
        // 并存不冲突且省去下游判断。
        out.push({ musicBrief: briefOut, chapters, plan: { musicBrief: briefOut, chapters } })
      }
      return { groups: out, musicGroups: out }
    }
    return { groups: [], musicGroups: [], raw: (content ?? '').slice(0, 500) }
  }
}

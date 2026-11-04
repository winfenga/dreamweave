/**
 * `plot` 任务适配器（T6-A 第一批；模板 `chunk_plot_reader_user_prompt`）。
 *
 * 产物：`records/results/plot.json`（条目 key = 实例键）。
 * 输入：**带行号原文**（与 cacheWarming 逐字同构：各章从 1 重新编号、每章外包 `【原文行：1-N】`）。
 *
 * 输出（与真实工作库 `5662f1d3` 的 results 分片实摘同构）：
 * ```jsonc
 * { "chunkSummary": "……（≤2000 字符）",
 *   "chapters": [ { "chapterSeq": 1, "chapterSummary": "……" }, { "chapterSeq": 2, "chapterSummary": "……" } ] }
 * ```
 *
 * 合并策略：`concat-dedup-order` + 显式 `keyOf`（理由见 `plotKeyOf` 处注释）。
 * parse 必填键（顶层）：`chunkSummary`（字符串）+ `chapters`（数组），二者缺一即走兜底。
 * 模型级契约（不逐层校验）：`chapters: [{ chapterSeq, chapterSummary }]`，每章恰好一条。
 */
import type { ChatMessage, LlmTaskAdapter, TaskRuntime } from '../../../shared/pipeline-types'
import { numberLines } from '../chunk-source'
import { parseJsonLoose } from './cacheWarming'

/**
 * 章条目的稳定键（供 `concat-dedup-order` 的 dedupeDeep 用）。
 *
 * 为什么必须显式提供（读 `../merge` 后的结论）：与 `seg` 同因——L2 切批不尊重章边界，
 * 同一章可能被多个批次各自产出；`mergeOutputs` 先字段级 `combineFirst`（`chapters` 数组拼接、
 * `chunkSummary` 标量取首个非空），再 `dedupeDeep` 去重。章条目天然稳定键 = `chapterSeq`
 * （模板契约：每章恰好一条 chapterSummary）；缺省 `defaultKeyOf` 对章对象会退化成整对象
 * JSON 串，同章不同片段双双保留、下游看到重复 chapterSeq。
 *
 * 另注（单标量字段的跨批语义，读代码如实汇报）：`chunkSummary` 是单字符串，
 * `combineFirst` 对标量的语义是「取首个非空」——若本任务被 L2 切成多批，只有**第一批**的
 * chunkSummary 会存活，后续批次的摘要不会拼接（引擎无「长文本跨批拼接」能力）。
 * 实践中 chunk 原文通常在单批预算内收敛（depth=0）；此不变量由引擎语义决定，适配器不绕过。
 */
export function plotKeyOf(part: unknown): string {
  if (typeof part === 'string') return `warn:${part}`
  if (part && typeof part === 'object' && !Array.isArray(part)) {
    const o = part as Record<string, unknown>
    if (typeof o.chapterSeq === 'number') return `chapter:${o.chapterSeq}`
  }
  try {
    return JSON.stringify(part)
  } catch {
    return String(part)
  }
}

/**
 * 从 rt 推导模板变量（`chunk_plot_reader_user_prompt` 的 `{{{var}}}` 占位符）。
 * 缺 chunkChapters 时视作单章（seq=1）并给合理回退，绝不传 undefined。
 */
function plotTemplateVars(rt: TaskRuntime): Record<string, unknown> {
  const chapters = rt.chunkChapters ?? [{ seq: 1, title: '（单章原文）', text: rt.chunkText }]
  const seqs = chapters.map((c) => c.seq).filter((n) => Number.isFinite(n))
  const first = seqs.length ? seqs[0] : 1
  const last = seqs.length ? seqs[seqs.length - 1] : 1
  return {
    chunkIndex: rt.chunkIndex ?? 0,
    // 章节范围：`首章seq-末章seq`（如 `1-4`）；单章时就是该数字
    chapterRange: first === last ? String(first) : `${first}-${last}`
  }
}

export const plotAdapter: LlmTaskAdapter = {
  id: 'plot',
  mergeStrategy: 'concat-dedup-order',
  keyOf: plotKeyOf,

  async inputText(rt: TaskRuntime): Promise<string> {
    // 与 cacheWarming 逐字同构
    const chapters = rt.chunkChapters ?? [{ seq: 1, title: '（单章原文）', text: rt.chunkText }]
    return numberLines(chapters)
  },

  async buildMessages(batchText: string, rt: TaskRuntime): Promise<ChatMessage[]> {
    const system = await rt.render('common_system_prompt', {})
    const instruction = await rt.render('chunk_plot_reader_user_prompt', plotTemplateVars(rt))
    // 任务指令放最后（与 cacheWarming 一致）
    return [
      { role: 'system', content: system },
      { role: 'user', content: batchText },
      { role: 'user', content: instruction }
    ]
  },

  parse(content: string): unknown {
    const obj = parseJsonLoose(content)
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const o = obj as Record<string, unknown>
      // 必填键：chunkSummary（字符串）+ chapters（数组），缺一即兜底
      if (typeof o.chunkSummary === 'string' && Array.isArray(o.chapters)) {
        return { chunkSummary: o.chunkSummary, chapters: o.chapters }
      }
    }
    // 兜底（与 cacheWarming 的 raw 兜底同风格）：不抛崩，保留原文截断供排查
    return { chunkSummary: null, chapters: [], raw: (content ?? '').slice(0, 500) }
  }
}

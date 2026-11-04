/**
 * `chunkLocationSummary` 任务适配器（T6-A 第一批；模板 `chunk_location_summary_user_prompt`）。
 *
 * 产物：`records/results/chunkLocationSummary.json`（条目 key = 实例键）。
 * 输入：**带行号原文**（与 cacheWarming 逐字同构：各章从 1 重新编号、每章外包 `【原文行：1-N】`）。
 *
 * 输出（与真实工作库 `5662f1d3` 的 results 分片实摘同构）：
 * ```jsonc
 * { "chunkLocationSummary": "艾尔希雅王城及其周边：……" }
 * ```
 *
 * 合并策略：`concat-dedup-order`，**不提供 keyOf**（读 `../merge` 后的结论）：
 * 输出顶层是单个字符串字段 `chunkLocationSummary`，没有任何数组需要稳定键；
 * `mergeOutputs` 对对象走字段级 `combineFirst`，标量语义 = 「取首个非空」。
 *
 * 单字符串型任务被 L2 切成多批时的合并语义（读代码如实汇报，不猜）：
 * `combineFirst(a, b)` 对两个非空字符串返回 **a**（首个非空）——即只有第一批的
 * chunkLocationSummary 会存活，后续批次的摘要不会拼接（引擎无长文本跨批拼接能力）。
 * 实践中 chunk 原文通常在单批预算内收敛（depth=0、calls=1）；此不变量由引擎
 * 语义决定，适配器不绕过、不改引擎。
 *
 * parse 必填键（顶层）：`chunkLocationSummary`（**非空**字符串——模板明确「不返回空字符串」，
 * 空串按缺键走兜底）。
 *
 * 模板 vars 实际用法（读模板正文得出结论）：`{{{chunkIndex}}}` 与 `{{{chapterSeqs}}}` 均为
 * **直接插值**（非 `{{#chapterSeqs}}` 区段用法），故 `chapterSeqs` 传 **join 后的字符串**
 * （`"1,2,3"`）；若传数组，`stringifyVar` 会按行连接成 `"1\n2\n3"`，与模板行文格式不符。
 */
import type { ChatMessage, LlmTaskAdapter, TaskRuntime } from '../../../shared/pipeline-types'
import { numberLines } from '../chunk-source'
import { parseJsonLoose } from './cacheWarming'

/**
 * 从 rt 推导模板变量（`chunk_location_summary_user_prompt` 的 `{{{var}}}` 占位符）。
 * 缺 chunkChapters 时视作单章（seq=1）并给合理回退，绝不传 undefined。
 */
function chunkLocationSummaryTemplateVars(rt: TaskRuntime): Record<string, unknown> {
  const chapters = rt.chunkChapters ?? [{ seq: 1, title: '（单章原文）', text: rt.chunkText }]
  const seqs = chapters.map((c) => c.seq).filter((n) => Number.isFinite(n))
  return {
    chunkIndex: rt.chunkIndex ?? 0,
    // 模板为直接插值用法 → 传 join 后的字符串；无章节信息时回退 '1'
    chapterSeqs: seqs.length ? seqs.join(',') : '1'
  }
}

export const chunkLocationSummaryAdapter: LlmTaskAdapter = {
  id: 'chunkLocationSummary',
  mergeStrategy: 'concat-dedup-order',

  async inputText(rt: TaskRuntime): Promise<string> {
    // 与 cacheWarming 逐字同构
    const chapters = rt.chunkChapters ?? [{ seq: 1, title: '（单章原文）', text: rt.chunkText }]
    return numberLines(chapters)
  },

  async buildMessages(batchText: string, rt: TaskRuntime): Promise<ChatMessage[]> {
    const system = await rt.render('common_system_prompt', {})
    const instruction = await rt.render('chunk_location_summary_user_prompt', chunkLocationSummaryTemplateVars(rt))
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
      // 必填键：chunkLocationSummary（非空字符串）
      if (typeof o.chunkLocationSummary === 'string' && o.chunkLocationSummary) {
        return { chunkLocationSummary: o.chunkLocationSummary }
      }
    }
    // 兜底（与 cacheWarming 的 raw 兜底同风格）：不抛崩，保留原文截断供排查
    return { chunkLocationSummary: null, raw: (content ?? '').slice(0, 500) }
  }
}

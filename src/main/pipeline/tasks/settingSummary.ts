/**
 * `settingSummary` 任务适配器（T6-A 第一批；模板 `chunk_setting_summary_user_prompt`）。
 *
 * 产物：`records/results/settingSummary.json`（条目 key = 实例键）。
 * 输入：**带行号原文**（与 cacheWarming 逐字同构：各章从 1 重新编号、每章外包 `【原文行：1-N】`）。
 *
 * 输出（与真实工作库 `5662f1d3` 的 results 分片实摘同构）：
 * ```jsonc
 * { "settingSummary": "【世界运行规则】1. ……" }
 * ```
 *
 * 合并策略：`concat-dedup-order`，**不提供 keyOf**（读 `../merge` 后的结论）：
 * 输出顶层是单个字符串字段 `settingSummary`，没有任何数组需要稳定键；
 * `mergeOutputs` 对对象走字段级 `combineFirst`，标量语义 = 「取首个非空」。
 *
 * 单字符串型任务被 L2 切成多批时的合并语义（读代码如实汇报，不猜）：
 * `combineFirst(a, b)` 对两个非空字符串返回 **a**（首个非空）——即只有第一批的
 * settingSummary 会存活，后续批次的摘要不会拼接（引擎无长文本跨批拼接能力）。
 * 实践中 chunk 原文通常在单批预算内收敛（depth=0、calls=1）；此不变量由引擎
 * 语义决定，适配器不绕过、不改引擎。
 *
 * parse 必填键（顶层）：`settingSummary`（**非空**字符串——模板明确要求非空正文，
 * 空串按缺键走兜底）。
 */
import type { ChatMessage, LlmTaskAdapter, TaskRuntime } from '../../../shared/pipeline-types'
import { numberLines } from '../chunk-source'
import { parseJsonLoose } from './cacheWarming'

/**
 * 从 rt 推导模板变量（`chunk_setting_summary_user_prompt` 的 `{{var}}` 占位符）。
 * 缺 chunkChapters 时视作单章（seq=1）并给合理回退，绝不传 undefined。
 */
function settingSummaryTemplateVars(rt: TaskRuntime): Record<string, unknown> {
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

export const settingSummaryAdapter: LlmTaskAdapter = {
  id: 'settingSummary',
  mergeStrategy: 'concat-dedup-order',

  async inputText(rt: TaskRuntime): Promise<string> {
    // 与 cacheWarming 逐字同构
    const chapters = rt.chunkChapters ?? [{ seq: 1, title: '（单章原文）', text: rt.chunkText }]
    return numberLines(chapters)
  },

  async buildMessages(batchText: string, rt: TaskRuntime): Promise<ChatMessage[]> {
    const system = await rt.render('common_system_prompt', {})
    const instruction = await rt.render('chunk_setting_summary_user_prompt', settingSummaryTemplateVars(rt))
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
      // 必填键：settingSummary（非空字符串）
      if (typeof o.settingSummary === 'string' && o.settingSummary) {
        return { settingSummary: o.settingSummary }
      }
    }
    // 兜底（与 cacheWarming 的 raw 兜底同风格）：不抛崩，保留原文截断供排查
    return { settingSummary: null, raw: (content ?? '').slice(0, 500) }
  }
}

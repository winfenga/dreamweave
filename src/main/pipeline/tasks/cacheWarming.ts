/**
 * `cacheWarming` 任务适配器（M2-T2；设计 §7 M2 / recon 配方_流水线 §2）。
 *
 * 产物：`records/results/cacheWarming.json`（条目 key = 实例键）。
 * 输入：**带行号原文**（每行首「行号 + 一个空格」，**各章从 1 重新编号**，每章外包 `【原文行：1-N】`）。
 * 输出期望 `{"answer":"ok"}`。走 L2 分批引擎（通常单批）；合并策略 = `concat-dedup-order`。
 */
import type { ChatMessage, LlmCallResult, LlmTaskAdapter, TaskRuntime } from '../../../shared/pipeline-types'
import { numberLines } from '../chunk-source'

/** 供其它模块沿用的「带行号原文」实现（各章从 1 重新编号；见 `../chunk-source`）。 */
export { numberLines } from '../chunk-source'

/** 宽松 JSON 解析（容忍 ```json 包裹与前后缀）。 */
export function parseJsonLoose(content: string): unknown {
  const text = (content ?? '').trim()
  if (!text) return null
  let t = text
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fence) t = fence[1].trim()
  try {
    return JSON.parse(t)
  } catch {
    const a = t.indexOf('{')
    const b = t.lastIndexOf('}')
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

export const cacheWarmingAdapter: LlmTaskAdapter = {
  id: 'cacheWarming',
  mergeStrategy: 'concat-dedup-order',
  /**
   * **本任务的输出契约就是 `{"answer":"ok"}`（15 字符）**。
   *
   * 历史上曾必须显式声明它才能通过「不足 50 字 = 审查拦截」的判定；
   * 现在 `isLikelyContentBlocked` 已升级为「短文本里合法 JSON 放行」，
   * 所以本项**不再是必要条件**（`{"answer":"ok"}` 本身就会被放行）。
   *
   * 仍保留声明，原因是它表达了真实意图（本任务确实只回极短内容），
   * 且若将来判定规则再收紧，这一行能让本任务继续豁免，不必再次排查。
   */
  allowShortOutput: true,

  async inputText(rt: TaskRuntime): Promise<string> {
    // 有章节切片时按「各章从 1 重新编号」组装；否则（调用方直接注入 chunkText）视作单章原文。
    const chapters = rt.chunkChapters ?? [{ seq: 1, title: '（单章原文）', text: rt.chunkText }]
    return numberLines(chapters)
  },

  async buildMessages(batchText: string, rt: TaskRuntime): Promise<ChatMessage[]> {
    const system = await rt.render('common_system_prompt', {})
    const instruction = await rt.render('cache_warming_user_prompt', {
      chunkIndex: rt.chunkIndex ?? 0
    })
    return [
      { role: 'system', content: system },
      { role: 'user', content: batchText },
      { role: 'user', content: instruction }
    ]
  },

  parse(content: string): unknown {
    const obj = parseJsonLoose(content)
    if (obj && typeof obj === 'object' && 'answer' in (obj as Record<string, unknown>)) return obj
    return { answer: null, raw: (content ?? '').slice(0, 500) }
  }
}

/** 供运行期复用的默认调用选项。 */
export function cacheWarmingCallOptions(rt: TaskRuntime): { maxTokens: number; thinking: 'enabled' | 'disabled'; effort: number } {
  return { maxTokens: rt.task.maxTokens, thinking: rt.task.thinking, effort: rt.task.effort }
}

export type { LlmCallResult }

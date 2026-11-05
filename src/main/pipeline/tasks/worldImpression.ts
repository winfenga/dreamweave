/**
 * `worldImpression` 任务适配器（T6-B；模板 `world_impression_user_prompt`）。
 *
 * 产物：`records/results/worldImpression.json`（条目 key = 实例键；global 任务每书一次）。
 * 输入：**全部 chunk 的 plot 摘要**——经 `rt.readUpstream('plot')`（上游产物读取的唯一入口，
 * 见 `../upstream.ts`）取本工作库全部 plot 产物条目，逐条取 `value.chunkSummary`，
 * 按插入序（即 chunk 序）组装为 `【Chunk {i} · 摘要】\n{summary}` 拼接。
 *
 * 输出（与真实工作库 `5662f1d3` 的 results 分片实摘同构）：
 * ```jsonc
 * { "worldImpression": "……（400—1000 字美术背景文字）",
 *   "novelGenre": "一句短语概括小说类型",
 *   "locationIconArtStyle": "地图地点图标统一美术风格" }
 * ```
 * 当前无 view 消费者（`t2w/view.ts` 的 artStyles 来自 reader 条目，不读本产物）；
 * 形状对齐真实库是为 reproject / 将来消费，不自行扩展下游。
 *
 * 【为什么 buildMessages 只发 2 条消息（与 cacheWarming/seg 等的 3 条不同）】
 * `world_impression_user_prompt` 的【本次输入】区把输入**嵌在指令里**
 * （`小说：{{title}}` + `全书摘要：{{chunkSummaries}}` 均在该模板内），因此批文本直接
 * 经 `{{chunkSummaries}}` 渲染进 user 指令即可；若再补一条 user 原文消息，同一批输入
 * 会出现两次。故：system（common_system_prompt）+ user（渲染后的任务指令）= 2 条。
 *
 * 【合并语义如实记录】`concat-dedup-order` 且**不提供 keyOf**（顶层单对象无数组，
 * 无稳定键可去重）：L2 若切多批，`combineFirst` 对单对象只保**第一批**——超大书
 * （摘要合计 >8000 tokens）会分批退化，首现获胜、后续批次摘要被丢弃；当前书量级
 * 单批收敛（depth=0）。此不变量由引擎语义决定，适配器不绕过。
 *
 * parse 必填键（顶层，均**非空字符串**，模板输出契约明确要求非空正文）：
 * `worldImpression` / `novelGenre` / `locationIconArtStyle`，缺任一即走 raw 截断兜底
 * （与 cacheWarming 同风格，不抛崩）。
 */
import type { ChatMessage, LlmTaskAdapter, TaskRuntime, UpstreamEntry } from '../../../shared/pipeline-types'
import { unwrapData } from '../upstream'
import { parseJsonLoose } from './cacheWarming'

/** plot 产物条目 → chunkIndex（key 形如 `<pkgId>:<revisionId>:plot:0`，末段为 chunk 序号）。 */
function chunkIndexOfKey(key: string): number | null {
  const segs = key.split(':')
  const last = segs[segs.length - 1] ?? ''
  return /^\d+$/.test(last) ? Number(last) : null
}

/** 非空字符串判定（模板契约：三个字段都必须有非空正文）。 */
function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

export const worldImpressionAdapter: LlmTaskAdapter = {
  id: 'worldImpression',
  mergeStrategy: 'concat-dedup-order',

  async inputText(rt: TaskRuntime): Promise<string> {
    if (typeof rt.readUpstream !== 'function') {
      throw new Error('worldImpression 需要 plot 产物：运行期未提供 readUpstream（rt 须由编排器 makeRuntime 构造）')
    }
    const entries: UpstreamEntry[] = await rt.readUpstream('plot')
    if (!entries.length) {
      throw new Error('worldImpression 需要 plot 产物：工作库中没有任何 plot 结果，请先运行 plot 任务')
    }
    const blocks: string[] = []
    let occurrence = 0
    for (const e of entries) {
      // 🔴 必须先 unwrapData：本机产物的 value 是 `{data:{chunkSummary}, …}` 信封，
      // 来源包老产物可能是裸 `{chunkSummary}`。直接读 e.value.chunkSummary 会全部落空
      // （历史 bug：报「全部 plot 条目均无 chunkSummary」，而磁盘上摘要明明有内容）。
      const data = unwrapData(e.value)
      const summary = data && typeof data === 'object' ? (data as Record<string, unknown>).chunkSummary : undefined
      if (!nonEmptyString(summary)) {
        // 缺 chunkSummary 的条目跳过并留痕（如 raw 兜底产物），不阻断全书聚合
        rt.warnings.push(`worldImpression：跳过无 chunkSummary 的 plot 产物条目（key=${e.key}）`)
        continue
      }
      // key 末段数字为 chunkIndex（形如 `…:plot:0`）；解析不到 → 按出现序编号
      const idx = chunkIndexOfKey(e.key) ?? occurrence
      blocks.push(`【Chunk ${idx} · 摘要】\n${summary}`)
      occurrence++
    }
    if (!blocks.length) {
      throw new Error('worldImpression 需要 plot 产物：全部 plot 条目均无 chunkSummary，请先运行 plot 任务')
    }
    return blocks.join('\n')
  },

  async buildMessages(batchText: string, rt: TaskRuntime): Promise<ChatMessage[]> {
    const system = await rt.render('common_system_prompt', {})
    // 输入嵌在模板【本次输入】区（{{title}}/{{chunkSummaries}}），故只 2 条消息（理由见文件头）
    const instruction = await rt.render('world_impression_user_prompt', {
      title: rt.title ?? '',
      chunkSummaries: batchText
    })
    return [
      { role: 'system', content: system },
      { role: 'user', content: instruction }
    ]
  },

  parse(content: string): unknown {
    const obj = parseJsonLoose(content)
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const o = obj as Record<string, unknown>
      // 必填键：三个非空字符串（模板输出契约），缺一即兜底
      if (nonEmptyString(o.worldImpression) && nonEmptyString(o.novelGenre) && nonEmptyString(o.locationIconArtStyle)) {
        // C1：`visualImpression` 是新增的**可选**字段（给绘图模型看的纯视觉基调）。
        // 旧包/旧模型不会产出它 → 缺省时留空串，下游回落到 worldImpression。
        // 不做「缺了就走 raw 兜底」——那会把已有的三个有效字段一起丢掉。
        const visual = nonEmptyString(o.visualImpression) ? o.visualImpression.trim() : ''
        return {
          worldImpression: o.worldImpression,
          ...(visual ? { visualImpression: visual } : {}),
          novelGenre: o.novelGenre,
          locationIconArtStyle: o.locationIconArtStyle
        }
      }
    }
    // 兜底（与 cacheWarming 的 raw 兜底同风格）：不抛崩，保留原文截断供排查
    return {
      worldImpression: null,
      visualImpression: null,
      novelGenre: null,
      locationIconArtStyle: null,
      raw: (content ?? '').slice(0, 500)
    }
  }
}

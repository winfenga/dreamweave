/**
 * `batchLocationSummary` 任务适配器（T6-F 第六批；模板 `batch_location_summary_user_prompt`）。
 *
 * 产物：`records/results/batchLocationSummary.json`（条目 key = 实例键；global 任务每书一次）。
 *
 * 输入（模板三变量，逐字读过模板全文）：
 *  - `batchIndex`：恒 `0`（单轮全文模式 = 单批，见下「与真实库的有意差异」）；
 *  - `mapLocations`：locationTree 产物经 `showableMapLocations`（`../location-inputs`）得的
 *    **可展示地点平铺列表**，**预序列化为 JSON 字符串**再传模板——prompt-loader 的
 *    `stringifyVar` 对 JS 数组会**换行拼接**而非 JSON 序列化，传数组会破坏 `id`/`parentId`
 *    结构（模板要求「包含固定 ID、别名及有效展示父级」的结构化索引）；
 *  - `chunkLocationSummaries`：`rt.readUpstream('chunkLocationSummary')` 取全部摘要，按
 *    chunkIndex 编号拼接为 `【Chunk {i} · 空间摘要】\n{text}`（与 locationTree 的 inputText
 *    同口径；解析不到 chunkIndex 的条目按出现序编号）。
 * 无 locationTree 产物 → 抛可读错误；无 chunkLocationSummary 产物 → 抛可读错误。
 *
 * 输出（模板【输出】契约）：`{"batchLocationSummary":"非空字符串"}`。parse 必填
 * `batchLocationSummary` 非空字符串；缺 → raw 兜底（与 worldImpression 同风格，不抛崩）。
 *
 * 【为什么 buildMessages 只发 2 条消息（与 cacheWarming/seg 等的 3 条不同）】
 * 模板【输入与边界】区把两个输入**嵌在指令里**（`mapLocations：{{{mapLocations}}}` 与
 * `chunkLocationSummaries：{{{chunkLocationSummaries}}}` 均在模板内），故批文本经变量
 * 渲染进 user 指令即可；若再补一条 user 原文消息，同一批输入会出现两次。故：
 * system（common_system_prompt）+ user（渲染后的任务指令）= 2 条（与 locationTree 同构）。
 *
 * 【inputText 返回什么 / batchText 为什么不拆用（重要，读引擎后结论）】
 * `inputText` 返回「mapLocations JSON（单行）+ '\n' + 摘要拼接」的**合稿**：既供编排器
 * 做指纹与 L2 预算估算（覆盖两份输入的量），也固定「喂给模型的全量输入」形态。
 * `buildMessages` **不从 batchText 拆回**两个变量——模板语义要求一次看到全量输入
 * （真实生态里「批次范围已经由地点树任务确定」，本引擎单实例单轮即一批），故两个变量
 * 都从 rt 现算重渲染。多批时各批指令相同、结果靠机械合并收敛（concat-dedup-order 对
 * 单字符串对象走 `combineFirst`，首现获胜）；当前书量级单批收敛（depth=0、calls=1），
 * 此退化由引擎语义决定，适配器不绕过、不改引擎。
 *
 * 合并策略：`concat-dedup-order`，**不提供 keyOf**（顶层单对象无数组，无稳定键可去重）。
 * 跨批退化如文件头所述：`combineFirst` 只保首批的非空字符串。
 *
 * 【与真实库 `5662f1d3` 的有意差异（醒目）】
 *  - 真实库主条目（key `…:batchLocationSummary`）的 value 是**数组**
 *    `[{batchIndex:0,chunks:[0,1,2],summary:"…"}]`，另有 `:batch:0` 增量条目
 *    （`{data:{batchLocationSummary:"…"}, responsePath, cacheReadyAt}`）；
 *  - 本适配器按**模板输出契约**产单字符串 `{batchLocationSummary}` 放主条目——模板
 *    【输出】明言「只返回 JSON：{"batchLocationSummary":…}，不返回额外字段」，适配器
 *    只对模板契约负责；真实库的批量数组形态是其按批编排的产物，本引擎 global 单实例
 *    单轮全文模式用不到（batchIndex 恒 0 即此意）。
 */
import type { ChatMessage, LlmTaskAdapter, TaskRuntime, UpstreamEntry } from '../../../shared/pipeline-types'
import { showableMapLocations, summariesFromEntries } from '../location-inputs'
import { parseJsonLoose } from './cacheWarming'

/** 取 readUpstream（未挂 → 可读错误；rt 须由编排器 makeRuntime 构造）。 */
function readUpstreamOf(rt: TaskRuntime): (taskId: string) => Promise<UpstreamEntry[]> {
  if (typeof rt.readUpstream !== 'function') {
    throw new Error('batchLocationSummary 需要 locationTree 与 chunkLocationSummary 产物：运行期未提供 readUpstream（rt 须由编排器 makeRuntime 构造）')
  }
  return rt.readUpstream
}

/**
 * 取 locationTree 产物数据（双形态 `value?.data ?? value`，取首条可用对象）。
 * 无产物 → 抛可读错误（global 任务每书一次，正常恰一条）。
 */
async function readLocationTreeData(rt: TaskRuntime): Promise<Record<string, unknown>> {
  const entries = await readUpstreamOf(rt)('locationTree')
  for (const e of entries) {
    const v = e.value as { data?: unknown } | null
    const data = v && typeof v === 'object' && v.data && typeof v.data === 'object' ? v.data : v
    if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>
  }
  throw new Error('batchLocationSummary 需要 locationTree 产物：工作库中没有任何 locationTree 结果，请先运行 locationTree 任务')
}

/** `mapLocations` 变量：可展示地点平铺列表的**预序列化 JSON 字符串**（理由见文件头）。 */
function mapLocationsVar(locationTreeData: Record<string, unknown>): string {
  return JSON.stringify(showableMapLocations(locationTreeData))
}

/** `chunkLocationSummaries` 变量：全部 chunkLocationSummary 按 chunkIndex 编号拼接（与 locationTree 同口径）。 */
function chunkLocationSummariesVar(entries: UpstreamEntry[]): string {
  const picked = summariesFromEntries(entries, 'chunkLocationSummary')
  if (!picked.length) {
    throw new Error('batchLocationSummary 需要 chunkLocationSummary 产物：全部 chunkLocationSummary 条目均无摘要正文，请先运行 chunkLocationSummary 任务')
  }
  return picked.map((p) => `【Chunk ${p.index} · 空间摘要】\n${p.text}`).join('\n')
}

export const batchLocationSummaryAdapter: LlmTaskAdapter = {
  id: 'batchLocationSummary',
  mergeStrategy: 'concat-dedup-order',

  async inputText(rt: TaskRuntime): Promise<string> {
    const readUpstream = readUpstreamOf(rt)
    const lt = await readLocationTreeData(rt) // 无 locationTree 产物 → 可读错误
    const blocks = chunkLocationSummariesVar(await readUpstream('chunkLocationSummary')) // 无摘要 → 可读错误
    // 合稿：mapLocations JSON（单行）在前、摘要拼接在后（形态说明见文件头）
    return `${mapLocationsVar(lt)}\n${blocks}`
  },

  async buildMessages(_batchText: string, rt: TaskRuntime): Promise<ChatMessage[]> {
    const readUpstream = readUpstreamOf(rt)
    const system = await rt.render('common_system_prompt', {})
    // 两个输入变量都从 rt 现算重渲染（不从 batchText 拆回，理由见文件头）
    const lt = await readLocationTreeData(rt)
    const instruction = await rt.render('batch_location_summary_user_prompt', {
      // 单轮全文模式 = 单批：batchIndex 恒 0（真实库按批跑，见文件头有意差异）
      batchIndex: 0,
      mapLocations: mapLocationsVar(lt),
      chunkLocationSummaries: chunkLocationSummariesVar(await readUpstream('chunkLocationSummary'))
    })
    // 输入嵌在模板内（两个 {{{}}} 占位符），故只 2 条消息（理由见文件头）
    return [
      { role: 'system', content: system },
      { role: 'user', content: instruction }
    ]
  },

  parse(content: string): unknown {
    const obj = parseJsonLoose(content)
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const o = obj as Record<string, unknown>
      // 必填键：batchLocationSummary（模板「不得为空」→ 非空字符串）
      if (typeof o.batchLocationSummary === 'string' && o.batchLocationSummary.trim().length > 0) {
        return { batchLocationSummary: o.batchLocationSummary }
      }
    }
    // 兜底（与 worldImpression 同风格）：不抛崩，保留原文截断供排查
    return { batchLocationSummary: null, raw: (content ?? '').slice(0, 500) }
  }
}

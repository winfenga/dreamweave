/**
 * `impressionLayout` 任务适配器（T6-F 第六批；模板 `impression_layout_user_prompt`）。
 *
 * 产物：`records/results/impressionLayout.json`（条目 key = 实例键；global 任务每书一次）。
 * 消费端：`t2w/view.ts:590-623` 读 `data.layout.layouts` / `data.layout.gridSize`
 * （impression 图谱：rootParentId 取「作为 parentId 出现但自身从未被摆放」的节点）。
 *
 * 输入（模板两变量，逐字读过模板全文）：
 *  - `mapLocations`：locationTree 产物经 `showableMapLocations`（`../location-inputs`）得的
 *    **可展示地点平铺列表**（含合成根 novel-world，parentId = 有效展示父级；已按模板
 *    【地点范围】排除不适合展示的节点及其整棵子树），**预序列化为 JSON 字符串**再传模板
 *    （prompt-loader 的 `stringifyVar` 对 JS 数组会换行拼接，理由同 batchLocationSummary）；
 *  - `batchLocationSummaries`：`rt.readUpstream('batchLocationSummary')` 取全部产物的
 *    `batchLocationSummary` 文本（经 `summariesFromEntries`；多条按 chunk 序拼接；
 *    无 → 抛可读错误「impressionLayout 需要 batchLocationSummary 产物」）。
 *
 * 输出包装（view.ts:591 读 `data.layout.layouts`/`data.layout.gridSize`，必须这层）：
 * ```jsonc
 * { "layout": { "gridSize": 100,
 *     "layouts": [ { "parentId": "novel-world", "mode": "separated",
 *         "placements": [ { "id": "1", "rect": { "x": 10, "y": 10, "width": 60, "height": 60 } } ] } ] },
 *   "warnings": [] }
 * ```
 *
 * parse 校验规则（模板【布局协议】逐条落地；无效项丢弃 + warning，不抛崩）：
 *  - `gridSize`：有限数字，缺省 `100`（非有限数字 → 按 100 + warning）；
 *  - `layouts`：数组（缺键 → raw 兜底：`{layout:{gridSize,layouts:[]},warnings,raw}`）；
 *  - 逐 layout：`parentId` 非空字符串；`mode` ∈ separated|partition（缺省 separated，
 *    其它值 → 整条丢弃 + warning）；`placements` 数组（非数组 → 整条丢弃 + warning）；
 *  - 逐 placement：`id` 非空字符串；`rect` 四字段（x/y/width/height）均为有限数字且
 *    `width>0`、`height>0`、`x>=0`、`y>=0`、`x+width<=100`、`y+height<=100`
 *    （模板协议：gridSize 固定 100 的局部坐标，左上角原点、右下不越界）——无效
 *    placement 丢弃 + warning，同 layout 其余 placement 保留。
 *
 * 【与真实库 `5662f1d3` 的有意差异（醒目）】
 *  - 真实库 data 是 `{tree, layout}` 双字段（`tree` = 精简地点树，informational）；
 *    本适配器**不生成 `tree`**：view 不消费它（view.ts:590-623 只读 layout），且 parse
 *    是同步函数拿不到 locationTree 产物（读上游一律在 inputText/buildMessages 做，
 *    见 T6-F ① 接口约束）→ 留待需要时加后处理步骤；
 *  - 真实库 layout 元素只有 parentId/mode/placements（本书数据实测无 background/
 *    surface），本适配器同样只产这三字段——模板可选的 `background:"water"` /
 *    `surface:"water"` **不透传**（view 不消费；真实库本书数据亦未出现），留待消费
 *    者出现时补；
 *  - 真实库 id 为 `M-1` 式（旧协议 locationTree id），本引擎 locationTree 按模板
 *    `location-numeric-v1` 契约为纯数字字符串（"1"/"2"）——placement.id 原样透传，
 *    不限定格式（view 消费端只做字符串 key 使用）。
 *
 * 【为什么 buildMessages 只发 2 条消息】模板【任务】区把两个输入**嵌在指令里**
 * （`mapLocations：{{{mapLocations}}}` + `batchLocationSummaries：{{{batchLocationSummaries}}}`
 * 均在模板内），且明言「一次生成完整的世界印象地图布局 JSON……不请求分批」——故：
 * system（common_system_prompt）+ user（渲染后的任务指令）= 2 条（与 locationTree 同构）。
 *
 * 【inputText 返回什么 / batchText 为什么不拆用】同 batchLocationSummary（见其文件头）：
 * inputText 返回「mapLocations JSON（单行）+ '\n' + batchLocationSummary 拼接」合稿
 * （供指纹/预算估算）；buildMessages 两个变量都从 rt 现算重渲染——模板要求一次看到
 * 全量输入，多批时各批指令相同、结果靠机械合并收敛（keyOf 按 parentId，跨批重复父
 * 区域首现获胜）；当前书量级单批收敛（depth=0、calls=1）。
 *
 * 合并策略：`concat-dedup-order` + 显式 `keyOf`（layout 按 `parentId` 稳定键；
 * 理由见 `impressionLayoutKeyOf` 处注释）。
 */
import type { ChatMessage, LlmTaskAdapter, TaskRuntime, UpstreamEntry } from '../../../shared/pipeline-types'
import { showableMapLocations, summariesFromEntries } from '../location-inputs'
import { parseJsonLoose } from './cacheWarming'

/** 布局模式枚举（模板【布局协议】：separated 独立分离 / partition 内部连续分区）。 */
type LayoutMode = 'separated' | 'partition'

/** 一个子区域摆放（协议字段严格集：id + rect 四字段）。 */
interface Placement {
  id: string
  rect: { x: number; y: number; width: number; height: number }
}

/** 一个父区域的布局组（协议字段严格集：parentId + mode + placements）。 */
interface LayoutGroup {
  parentId: string
  mode: LayoutMode
  placements: Placement[]
}

/**
 * layout 条目的稳定键（供 `concat-dedup-order` 的 dedupeDeep 用）。
 *
 * 为什么必须显式提供（读 `../merge` 后的结论）：`mergeOutputs` 先字段级 `combineFirst`
 * （`layout.layouts` 数组直接拼接），再 `dedupeDeep` 按稳定键去重。L2 切批时各批可能
 * 对同一父区域各自产出 layouts 条目——layout 的天然稳定键是 `parentId`（模板协议：
 * 「每个有直接子节点的父区域必须有一个 layouts 条目」，一书内一父恰好一条），跨批重复
 * 父区域首现获胜（与 `combineFirst` 的「a 优先」语义一贯）。缺省 `defaultKeyOf` 对
 * layout 对象会取 `id`/`name`——layout 没有这些字段，会退化成整对象 JSON 串（同父
 * 不同批产物双双保留，view 看到重复 parentId 组）；对字符串元素（warnings 形态）给
 * `warn:` 前缀键避免与 layout 相消。
 */
export function impressionLayoutKeyOf(part: unknown): string {
  if (typeof part === 'string') return `warn:${part}`
  if (part && typeof part === 'object' && !Array.isArray(part)) {
    const o = part as Record<string, unknown>
    if (typeof o.parentId === 'string' && o.parentId) return `layout:${o.parentId}`
  }
  try {
    return JSON.stringify(part)
  } catch {
    return String(part)
  }
}

/** 取 readUpstream（未挂 → 可读错误；rt 须由编排器 makeRuntime 构造）。 */
function readUpstreamOf(rt: TaskRuntime): (taskId: string) => Promise<UpstreamEntry[]> {
  if (typeof rt.readUpstream !== 'function') {
    throw new Error('impressionLayout 需要 locationTree 与 batchLocationSummary 产物：运行期未提供 readUpstream（rt 须由编排器 makeRuntime 构造）')
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
  throw new Error('impressionLayout 需要 locationTree 产物：工作库中没有任何 locationTree 结果，请先运行 locationTree 任务')
}

/** `mapLocations` 变量：可展示地点平铺列表的**预序列化 JSON 字符串**（理由见文件头）。 */
function mapLocationsVar(locationTreeData: Record<string, unknown>): string {
  return JSON.stringify(showableMapLocations(locationTreeData))
}

/** `batchLocationSummaries` 变量：全部 batchLocationSummary 文本按 chunk 序拼接（无 → 可读错误）。 */
function batchLocationSummariesVar(entries: UpstreamEntry[]): string {
  const picked = summariesFromEntries(entries, 'batchLocationSummary')
  if (!picked.length) {
    throw new Error('impressionLayout 需要 batchLocationSummary 产物：工作库中没有任何 batchLocationSummary 结果，请先运行 batchLocationSummary 任务')
  }
  // 多条（异常形态：global 任务正常恰一条）按 chunk 序稳定排序后拼接
  const sorted = picked.map((p, i) => ({ p, i })).sort((a, b) => a.p.index - b.p.index || a.i - b.i)
  return sorted.map((s) => s.p.text).join('\n')
}

/** 有限数字判定。 */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * 校验单个 placement（模板【布局协议】rect 规则逐条落地）。
 * 无效 → null（调用方丢弃 + warning）；有效 → 归一化 `{id, rect:{x,y,width,height}}`。
 */
function validatePlacement(raw: unknown): Placement | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id) return null
  const r = o.rect
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null
  const rc = r as Record<string, unknown>
  const { x, y, width, height } = rc
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) return null
  if (width <= 0 || height <= 0) return null
  if (x < 0 || y < 0) return null
  // 模板协议：gridSize 固定 100，右下角不越界（x+width/y+height 不大于 100）
  if (x + width > 100 || y + height > 100) return null
  return { id: o.id, rect: { x, y, width, height } }
}

export const impressionLayoutAdapter: LlmTaskAdapter = {
  id: 'impressionLayout',
  mergeStrategy: 'concat-dedup-order',
  keyOf: impressionLayoutKeyOf,

  async inputText(rt: TaskRuntime): Promise<string> {
    const readUpstream = readUpstreamOf(rt)
    const lt = await readLocationTreeData(rt) // 无 locationTree 产物 → 可读错误
    const batchText = batchLocationSummariesVar(await readUpstream('batchLocationSummary')) // 无产物 → 可读错误
    // 合稿：mapLocations JSON（单行）在前、batchLocationSummary 拼接在后（形态说明见文件头）
    return `${mapLocationsVar(lt)}\n${batchText}`
  },

  async buildMessages(_batchText: string, rt: TaskRuntime): Promise<ChatMessage[]> {
    const readUpstream = readUpstreamOf(rt)
    const system = await rt.render('common_system_prompt', {})
    // 两个输入变量都从 rt 现算重渲染（不从 batchText 拆回，理由见文件头）
    const lt = await readLocationTreeData(rt)
    const instruction = await rt.render('impression_layout_user_prompt', {
      mapLocations: mapLocationsVar(lt),
      batchLocationSummaries: batchLocationSummariesVar(await readUpstream('batchLocationSummary'))
    })
    // 输入嵌在模板内（两个 {{{}}} 占位符），故只 2 条消息（理由见文件头）
    return [
      { role: 'system', content: system },
      { role: 'user', content: instruction }
    ]
  },

  parse(content: string): unknown {
    const warnings: string[] = []
    const obj = parseJsonLoose(content)
    const o = obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null

    // ---- gridSize：有限数字，缺省 100（非有限 → 100 + warning）----
    let gridSize = 100
    if (o && o.gridSize !== undefined) {
      if (isFiniteNumber(o.gridSize)) gridSize = o.gridSize
      else warnings.push('impressionLayout：gridSize 非有限数字，按缺省 100 处理')
    }

    // ---- layouts 必填数组（缺键 → raw 兜底，不抛崩）----
    if (!o || !Array.isArray(o.layouts)) {
      warnings.push('impressionLayout：模型输出无法解析为印象地图布局协议（缺 layouts 数组），走 raw 兜底')
      return { layout: { gridSize, layouts: [] }, warnings, raw: (content ?? '').slice(0, 500) }
    }
    // 模型 warnings（数组则收，非数组忽略）
    if (Array.isArray(o.warnings)) {
      for (const w of o.warnings) {
        if (typeof w === 'string' && w) warnings.push(w)
      }
    }

    const layouts: LayoutGroup[] = []
    for (const item of o.layouts) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        warnings.push(`impressionLayout：跳过非对象的 layout 条目（${JSON.stringify(item)?.slice(0, 80) ?? 'null'}）`)
        continue
      }
      const g = item as Record<string, unknown>
      // parentId 必填非空字符串（模板：「每个有直接子节点的父区域必须有一个 layouts 条目」）
      if (typeof g.parentId !== 'string' || !g.parentId) {
        warnings.push('impressionLayout：跳过缺 parentId 的 layout 条目')
        continue
      }
      // mode ∈ separated|partition；缺省 separated，其它值 → 整条丢弃
      let mode: LayoutMode
      if (g.mode === undefined) mode = 'separated'
      else if (g.mode === 'separated' || g.mode === 'partition') mode = g.mode
      else {
        warnings.push(`impressionLayout：跳过 mode 非 separated/partition 的 layout（parentId=${g.parentId}）`)
        continue
      }
      if (!Array.isArray(g.placements)) {
        warnings.push(`impressionLayout：跳过缺 placements 数组的 layout（parentId=${g.parentId}）`)
        continue
      }
      const placements: Placement[] = []
      for (const p of g.placements) {
        const v = validatePlacement(p)
        if (!v) {
          warnings.push(`impressionLayout：丢弃无效 placement（parentId=${g.parentId}，${JSON.stringify(p)?.slice(0, 100) ?? 'null'}）`)
          continue
        }
        placements.push(v)
      }
      layouts.push({ parentId: g.parentId, mode, placements })
    }

    return { layout: { gridSize, layouts }, warnings }
  }
}

/**
 * 地图/空间链共享输入构造器（T6-F 第六批；`location-inputs.ts`）。
 *
 * 定位：locationTree 产物（T6-C 形状）→ batchLocationSummary / impressionLayout /
 * plotLocation 三个适配器模板变量的**纯函数构造器**。不依赖 electron、无 IO，可被
 * node 验证脚本直接打包单测。
 *
 * 输入来源与形状（以 T6-C `locationTreeAdapter.parse` 产出与真实工作库 `5662f1d3`
 * 的 `:locationTree` 主条目为准）：
 *  - `locations`：平铺数组，元素 8 字段（id/name/aliases/locationType/identInfos/
 *    showOnImpressionMap/parentLocationId/ancestorLocationId）；
 *  - `tree`：嵌套树，合成根 `novel-world`（小说世界/世界，parentLocationId=null），
 *    子节点递归同构（含 children）；**合成根不在 locations 里**（view.ts:445 注释
 *    「根节点通常不在 locations 里」，故本模块展示列表里合成根由树 Walk 产出）；
 *  - 双形态：`value?.data ?? value`（本流水线 `{data,…}` 信封与真实库老数据均兼容）。
 *
 * 三个导出：
 *  1. `showableMapLocations` —— **可展示地点平铺列表**（impression_layout 模板的
 *     `mapLocations` 变量用）。剪枝规则依据模板【地点范围】原文：「输入已排除不适合
 *     展示的节点及其整棵子树」——只收 `showOnImpressionMap !== false` 的节点，不可
 *     展示节点沿树 Walk 时**整支剪掉**（含其全部子孙，即使子孙显式 true）；合成根
 *     `novel-world` **恒入列**（模板原文「mapLocations 中 novel-world 为根节点」；
 *     locationTree 的合成本就不设该字段，缺省 true）。字段名用 `parentId`（模板措辞
 *     「有效展示父级」；因剪枝按整支剪，入列节点的直接树父必然入列，`parentId` 即
 *     原树父 id——「有效」由剪枝语义保证，无需再向上找可展示祖先）。locations 与
 *     tree 不一致时**以 tree 结构为准、locations 补字段**（tree 缺 name/aliases/
 *     locationType/identInfos/showOnImpressionMap 时用 locations 同 id 条目补）。
 *  2. `mapLocationTreeJson` —— **完整树**嵌套序列化（plot_location 模板的
 *     `mapLocationTree` 变量用）。刻意**不剪枝**：剧情地点常绑定不可展示节点——真实库
 *     `5662f1d3` 的 `L-0-l1 百合酒吧特别定制地下室` 的 `mapLocationId=M-6` 挂在
 *     `M-3 百合酒吧`（showOnImpressionMap=false）下，剪枝会丢掉可绑定目标。
 *  3. `summariesFromEntries` —— 从 readUpstream 条目取某摘要字段的通用小工具
 *     （batchLocationSummary 取 `chunkLocationSummary`、impressionLayout 取
 *     `batchLocationSummary` 共用）。
 */
import type { UpstreamEntry } from '../../shared/pipeline-types'

/** 可展示地点（平铺列表元素；字段名对齐 impression_layout 模板措辞「有效展示父级」→ parentId）。 */
export interface ShowableMapLocation {
  id: string
  name: string
  aliases: string[]
  locationType: string
  identInfos: string[]
  parentId: string | null
}

/** 一条摘要（`index` = chunk 序号；`text` = 摘要正文）。 */
export interface EntrySummary {
  index: number
  text: string
}

/** 合成根 id（对齐真实数据 `novel-world`；view.ts:445 注释「根节点通常不在 locations 里」）。 */
const SYNTHETIC_ROOT_ID = 'novel-world'

/** 双形态解包：`{data:{…}}` 信封 → data；裸值原样（本流水线 LLM/本地产物与真实库老数据均兼容）。 */
function unwrapData(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const d = (value as Record<string, unknown>).data
    if (d !== undefined && d !== null) return d
  }
  return value
}

/** 非空字符串判定（空白串视作空）。 */
function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/** 字符串数组成员过滤（非字符串元素剔除；非数组 → `[]`）。 */
function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** 条目 key 末段数字 → chunkIndex（`<pkgId>:<revisionId>:<taskId>:<n>`；本模块私有副本，同各适配器口径）。 */
function chunkIndexOfKey(key: string): number | null {
  const segs = String(key ?? '').split(':')
  const last = segs[segs.length - 1] ?? ''
  return /^\d+$/.test(last) ? Number(last) : null
}

/** 内部规整节点（树 Walk 中间形；字段集 = 平铺 locations 8 字段 + children）。 */
interface NormNode {
  id: string
  name: string
  aliases: string[]
  locationType: string
  identInfos: string[]
  showOnImpressionMap: boolean
  parentLocationId: string | null
  children: NormNode[]
}

/** 无 children 的规整记录（locations 平铺元素 / 树节点共用）。 */
type NormRec = Omit<NormNode, 'children'>

/**
 * 从任意原始记录读字段（缺字段给缺省；id 非非空字符串 → null）。
 * `showOnImpressionMap` 缺省 `true`：模板/view 只把显式 `false` 判为不可展示
 * （view.ts:326 同口径 `!== false`）。
 */
function readRec(v: unknown): NormRec | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (!nonEmpty(o.id)) return null
  return {
    id: o.id,
    name: typeof o.name === 'string' ? o.name : '',
    aliases: stringArray(o.aliases),
    locationType: typeof o.locationType === 'string' ? o.locationType : '',
    identInfos: stringArray(o.identInfos),
    showOnImpressionMap: o.showOnImpressionMap !== false,
    parentLocationId: nonEmpty(o.parentLocationId) ? o.parentLocationId : null
  }
}

/** 树节点 → NormNode（children 递归；tree 缺的字段用 locations 同 id 条目补——结构以 tree 为准）。 */
function toNode(raw: unknown, byId: Map<string, NormRec>): NormNode | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const r = readRec(o)
  if (!r) return null
  const loc = byId.get(r.id)
  const children: NormNode[] = []
  if (Array.isArray(o.children)) {
    for (const c of o.children) {
      const n = toNode(c, byId)
      if (n) children.push(n)
    }
  }
  return {
    id: r.id,
    // 补字段：tree 空值 → locations 同 id 条目补（空串/空数组视作缺）
    name: r.name || loc?.name || '',
    aliases: r.aliases.length ? r.aliases : (loc?.aliases ?? []),
    locationType: r.locationType || loc?.locationType || '',
    identInfos: r.identInfos.length ? r.identInfos : (loc?.identInfos ?? []),
    // showOnImpressionMap：tree 显式声明（含 false）优先；tree 缺该字段时看 locations，再缺省 true
    showOnImpressionMap: o.showOnImpressionMap !== undefined ? r.showOnImpressionMap : (loc?.showOnImpressionMap ?? true),
    parentLocationId: r.parentLocationId,
    children
  }
}

/**
 * 无 tree 时的兜底：由 locations 平铺推导嵌套树（`parentLocationId` 挂接；悬空父与
 * 环入口按根处理——环检测沿祖先链走、遇环在入口截断，与 locationTree 组树同口径，
 * 保序保终止）。合成根 `novel-world` 恒为根（locations 里的同 id 记录不重复入列）。
 */
function synthFromLocations(byId: Map<string, NormRec>): NormNode {
  const recs = [...byId.values()].filter((r) => r.id !== SYNTHETIC_ROOT_ID)
  const ids = new Set(recs.map((r) => r.id))
  const cycleEntry = new Set<string>()
  for (const r of recs) {
    const seen = new Set<string>()
    let cur: string | null = r.id
    while (cur !== null) {
      if (cycleEntry.has(cur)) break
      if (seen.has(cur)) {
        cycleEntry.add(cur)
        break
      }
      seen.add(cur)
      // 显式标注：避免 cur 的控制流窄化与 p 的推断相互依赖（TS7022）
      const p: string | null = byId.get(cur)?.parentLocationId ?? null
      cur = p !== null && ids.has(p) ? p : null
    }
  }
  const kidsOf = new Map<string, NormRec[]>()
  const roots: NormRec[] = []
  for (const r of recs) {
    const p = r.parentLocationId
    if (p === null || !ids.has(p) || cycleEntry.has(r.id)) roots.push(r)
    else {
      const arr = kidsOf.get(p) ?? []
      arr.push(r)
      kidsOf.set(p, arr)
    }
  }
  const build = (rec: NormRec): NormNode => ({
    ...rec,
    children: (kidsOf.get(rec.id) ?? []).map(build)
  })
  return {
    id: SYNTHETIC_ROOT_ID,
    name: '小说世界',
    aliases: [],
    locationType: '世界',
    identInfos: [],
    showOnImpressionMap: true,
    parentLocationId: null,
    children: roots.map(build)
  }
}

/**
 * 构造完整树（不剪枝）：`tree` 优先；缺失/不可用时由 `locations` 平铺推导。
 * 返回 null = 既无 tree 也无可用 locations（调用方按「无产物」处理）。
 */
function buildFullTree(locationTreeData: unknown): NormNode | null {
  const data = unwrapData(locationTreeData)
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const d = data as Record<string, unknown>
  const byId = new Map<string, NormRec>()
  if (Array.isArray(d.locations)) {
    for (const item of d.locations) {
      const r = readRec(item)
      if (r) byId.set(r.id, r)
    }
  }
  if (d.tree && typeof d.tree === 'object' && !Array.isArray(d.tree)) {
    const root = toNode(d.tree, byId)
    if (root) return root
  }
  if (byId.size) return synthFromLocations(byId)
  return null
}

/**
 * 可展示地点平铺列表（impression_layout 模板 `mapLocations` 变量用）。
 *
 * 剪枝（模板【地点范围】原文「输入已排除不适合展示的节点及其整棵子树」）：沿树 Walk，
 * 只收 `showOnImpressionMap !== false` 的节点——遇不可展示节点**整支剪掉**（含全部
 * 子孙，即使子孙显式 true）；合成根恒入列（模板「mapLocations 中 novel-world 为根
 * 节点」）。输出顺序 = 树先根序（根 → 其子孙 → 下一子树）；无可用产物 → `[]`。
 */
export function showableMapLocations(locationTreeData: unknown): ShowableMapLocation[] {
  const root = buildFullTree(locationTreeData)
  if (!root) return []
  const out: ShowableMapLocation[] = []
  const emit = (node: NormNode, parentId: string | null): void => {
    out.push({
      id: node.id,
      name: node.name,
      aliases: node.aliases,
      locationType: node.locationType,
      identInfos: node.identInfos,
      parentId
    })
    for (const c of node.children) {
      if (c.showOnImpressionMap) emit(c, node.id)
    }
  }
  emit(root, null)
  return out
}

/**
 * 完整地点树嵌套序列化（plot_location 模板 `mapLocationTree` 变量用）。
 *
 * **刻意不剪枝**（与 `showableMapLocations` 的本质区别，理由见文件头）：剧情地点常
 * 绑定不可展示节点。序列化形状 = 树节点字段集（id/name/aliases/locationType/
 * identInfos/showOnImpressionMap/parentLocationId/children），父链信息保留供模型
 * 判断空间包含关系。无可用产物 → `'null'`（调用方应在此之前校验产物存在并抛可读
 * 错误，正常链路不会拿到 `'null'`）。
 */
export function mapLocationTreeJson(locationTreeData: unknown): string {
  const root = buildFullTree(locationTreeData)
  if (!root) return 'null'
  const toJson = (node: NormNode): unknown => ({
    id: node.id,
    name: node.name,
    aliases: node.aliases,
    locationType: node.locationType,
    identInfos: node.identInfos,
    showOnImpressionMap: node.showOnImpressionMap,
    parentLocationId: node.parentLocationId,
    children: node.children.map(toJson)
  })
  return JSON.stringify(toJson(root))
}

/**
 * 从 readUpstream 条目取某摘要字段（双形态解包后读 `data[field]`）。
 *
 * 通用小工具（batchLocationSummary 取 `chunkLocationSummary`、impressionLayout 取
 * `batchLocationSummary` 共用）：chunkIndex 从条目 key 末段数字解析（形如
 * `<pkgId>:<revisionId>:<taskId>:<n>`），解析不到 → 按出现序（0 起）；字段非非空
 * 字符串的条目**静默跳过**（不抛——上游可能有 raw 兜底产物；调用方按需记 warning）。
 * 返回按**插入序**（不排序：信封插入序即写入时序，per-chunk 任务同分片内即 chunk 序；
 * 需要严格 chunk 序的调用方自行按 `index` 稳定排序）。
 */
export function summariesFromEntries(entries: UpstreamEntry[], field: string): EntrySummary[] {
  const out: EntrySummary[] = []
  const list = Array.isArray(entries) ? entries : []
  let occurrence = 0
  for (const e of list) {
    if (!e || typeof e !== 'object') continue
    const data = unwrapData(e.value)
    const text =
      data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)[field]
        : undefined
    if (!nonEmpty(text)) continue
    out.push({ index: chunkIndexOfKey(e.key) ?? occurrence, text })
    occurrence++
  }
  return out
}

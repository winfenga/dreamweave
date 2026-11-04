/**
 * 地图页（MapView）的**纯函数**状态判定与换算。
 *
 * 抽出来的理由：MapView 是 .vue（node 直跑测不到 DOM），但这三件事是纯逻辑，
 * 放在这里可以被 `scripts/verify-t7b-map-ui.mjs` 直接断言：
 *  1. `isMapEmpty` —— 空态判据（无 locationTree 产物时不要画树）；
 *  2. `matchMapNodes` —— 搜索匹配；
 *  3. `panToCenter` —— 把节点移到视口中心的平移量换算。
 * 本文件零 DOM、零 Vue 依赖，只做类型引用（import type）。
 */
import type { ViewData } from '../../../shared/app-types'
import type { LaidOutNode } from './mapLayout'

/**
 * 视图是否**没有真实地图数据**。
 *
 * 判据：`mapRoot.id === 'root' && 无子节点`。
 *
 * 为什么不用 `stats.mapNodeCount === 0`：`view.ts` 的 `mapNodeCount` 是 `countTree(mapRoot)`，
 * 计数**含根节点**，兜底根也会被算成 1 —— 该值恒 ≥ 1，永远判不出空态（实测确认，见
 * `scripts/verify-t7b-map-ui.mjs` 的 C 组）。
 *
 * 为什么 `id === 'root'` 是可靠的哨兵：`view.ts` 在无 locationTree 时给出的兜底根就是
 * `{ id:'root', name:'（无地图数据）', children:[] }`（该形状是红线，不能改）；而真实书的树根
 * id 一律是数据里的 id（7 本真实工作库实测全为 `novel-world`，无一本是 `root`）。
 * 再加「无子节点」作第二道闸：真实书即便只有 1 个地点（单节点树），只要 id 不是 `root`
 * 就照常渲染，不会被误判成空态。
 */
export function isMapEmpty(view: ViewData | null | undefined): boolean {
  const root = view?.mapRoot
  if (!root) return true
  if ((root.children?.length ?? 0) > 0) return false
  return root.id === 'root'
}

/**
 * 按名称搜索节点：`name` 包含匹配，大小写不敏感（中文无大小写之分，主要照顾英文地名）。
 * 空查询返回空数组（= 无匹配状态，而不是「全部命中」）。
 * 保持 `layout.nodes` 的原顺序（深度优先、稳定），逐条回车跳转时顺序可预期。
 */
export function matchMapNodes(nodes: readonly LaidOutNode[], query: string): LaidOutNode[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return nodes.filter((n) => (n.node.name ?? '').toLowerCase().includes(q))
}

/** 平移换算的输入（画布坐标 + 当前缩放 + 视口尺寸 + 节点尺寸） */
export interface PanCenterInput {
  /** 节点左上角在画布坐标系里的 x（layout 的 col 换算结果） */
  x: number
  /** 节点左上角在画布坐标系里的 y */
  y: number
  /** 当前缩放 */
  scale: number
  /** 视口宽（canvas clientWidth） */
  viewW: number
  /** 视口高（canvas clientHeight） */
  viewH: number
  nodeW: number
  nodeH: number
}

/**
 * 把节点中心移到视口中心所需的 `tx/ty`（MapView 用 `transform: translate(tx,ty) scale(s)`）。
 *
 * 换算：节点中心画布坐标 `(cx, cy) = (x + nodeW/2, y + nodeH/2)`；
 * 屏幕坐标 = `t + 画布坐标 × scale`（先缩放后平移，与 CSS transform 书写顺序一致）；
 * 令其等于视口中心 → **`tx = viewW/2 − cx × scale`**，**`ty = viewH/2 − cy × scale`**。
 */
export function panToCenter(i: PanCenterInput): { tx: number; ty: number } {
  const cx = i.x + i.nodeW / 2
  const cy = i.y + i.nodeH / 2
  return { tx: i.viewW / 2 - cx * i.scale, ty: i.viewH / 2 - cy * i.scale }
}

/**
 * 印象图谱渲染模型：把 impressionLayout 的「扁平 parentId → placements 列表」
 * 组装成可递归渲染的嵌套树。
 *
 * 数据形状（实测）：
 *   impressionLayout.data = { tree, layout: { gridSize: 100, layouts: [
 *     { parentId: 'novel-world', mode: 'separated', placements: [{ id: 'M-0', rect: {x,y,width,height} }] },
 *     { parentId: 'M-0', ... }, ... ] } }
 * rect 的 x/y/width/height 都是**父容器内的百分比**（gridSize=100）。
 */
import type { ImpressionData, MapLocation, MapTreeNode } from '../../../shared/app-types'

export interface LayoutNode {
  id: string
  name: string
  locationType: string
  identInfos: string[]
  rect: { x: number; y: number; width: number; height: number }
  sceneIds: string[]
  children: LayoutNode[]
}

interface Meta {
  name: string
  locationType: string
  identInfos: string[]
}

export function buildImpressionTree(
  imp: ImpressionData,
  nodes: MapLocation[],
  scenesByNode: Record<string, string[]>,
  mapRoot: MapTreeNode
): LayoutNode | null {
  if (!imp.layouts.length) return null

  // 名称/类型查表：先用地点列表，再用地图树兜底
  // （树根如 `novel-world` 不在 locations[] 里，只有地图树里才有它的名字与类型）
  const meta = new Map<string, Meta>()
  const walkTree = (n: MapTreeNode): void => {
    if (!meta.has(n.id)) meta.set(n.id, { name: n.name, locationType: n.locationType, identInfos: n.identInfos })
    n.children.forEach(walkTree)
  }
  walkTree(mapRoot)
  for (const n of nodes) meta.set(n.id, { name: n.name, locationType: n.locationType, identInfos: n.identInfos })

  const childrenOf = new Map<string, ImpressionData['layouts'][number]['placements']>()
  for (const g of imp.layouts) {
    childrenOf.set(g.parentId, [...(childrenOf.get(g.parentId) ?? []), ...g.placements])
  }

  const build = (id: string, rect: LayoutNode['rect']): LayoutNode => {
    const m = meta.get(id)
    return {
      id,
      name: m?.name ?? id,
      locationType: m?.locationType ?? '未知',
      identInfos: m?.identInfos ?? [],
      rect,
      sceneIds: scenesByNode[id] ?? [],
      children: (childrenOf.get(id) ?? []).map((p) => build(p.id, p.rect))
    }
  }

  // 根节点自身不参与摆放（它代表整块画布），rect 用满 100%
  return build(imp.rootParentId, { x: 0, y: 0, width: 100, height: 100 })
}

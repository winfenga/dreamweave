/**
 * 简易整洁树布局：叶子按顺序占列，父节点取首末子节点列的中点。
 * 22 个节点的规模下足够，且不会重叠。
 */
import type { MapTreeNode } from '../../../shared/app-types'

export interface LaidOutNode {
  node: MapTreeNode
  /** 列（0-based，单位=格） */
  col: number
  /** 层（0-based，根为 0） */
  depth: number
  parentId: string | null
}

export interface MapLayout {
  nodes: LaidOutNode[]
  edges: { from: string; to: string }[]
  cols: number
  depth: number
}

export function layoutTree(root: MapTreeNode): MapLayout {
  const nodes: LaidOutNode[] = []
  const edges: { from: string; to: string }[] = []
  let cursor = 0

  const walk = (n: MapTreeNode, depth: number, parentId: string | null): number => {
    let col: number
    if (!n.children.length) {
      col = cursor++
    } else {
      const childCols: number[] = []
      for (const c of n.children) {
        edges.push({ from: n.id, to: c.id })
        childCols.push(walk(c, depth + 1, n.id))
      }
      col = (childCols[0] + childCols[childCols.length - 1]) / 2
    }
    nodes.push({ node: n, col, depth, parentId })
    return col
  }

  walk(root, 0, null)
  const maxCol = nodes.reduce((m, n) => Math.max(m, n.col), 0)
  const maxDepth = nodes.reduce((m, n) => Math.max(m, n.depth), 0)
  return { nodes, edges, cols: maxCol + 1, depth: maxDepth + 1 }
}

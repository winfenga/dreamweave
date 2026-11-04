/**
 * DAG 拓扑（Kahn）（设计 §6.3）。
 *
 * 节点 = 注册表 task id。边 = `dependsOn` 解析出的「基任务 → 本任务」。
 * 依赖后缀语义（设计 §6.2 / recon §4）在此**只用于解析目标节点集合**：
 *   - `X:i`      → X 在每个 chunk 的实例（拓扑上仍是节点 X）
 *   - `X:*`      → X 的全部实例聚合
 *   - `X:n`      → X 在 chunk n 的实例
 *   - `X:next`   → X 的下一 chunk 实例
 *   - `X:selected` → 复核后被选中的实例（mergeReview→canonical）
 *   - 裸 `X`     → 全局单例
 * 伴随程序步骤（memoryBefore/memoryAfter…）不是节点，其依赖边被忽略（不影响 29 任务拓扑）。
 */
import type { TaskDef } from '../../shared/pipeline-types'
import { VIRTUAL_STEPS, depBase } from './task-registry'

/** 依赖后缀种类（供编排器构造实例依赖）。 */
export type DepSuffix = 'per-chunk' | 'all-instances' | 'chunk-n' | 'next-chunk' | 'selected' | 'global'

/** 解析一条 `dependsOn` 声明的后缀语义。 */
export function parseDepSuffix(dep: string): { base: string; suffix: DepSuffix; chunkIndex?: number } {
  const idx = dep.indexOf(':')
  if (idx < 0) return { base: dep, suffix: 'global' }
  const base = dep.slice(0, idx)
  const rest = dep.slice(idx + 1)
  if (rest === 'i') return { base, suffix: 'per-chunk' }
  if (rest === '*') return { base, suffix: 'all-instances' }
  if (rest === 'next') return { base, suffix: 'next-chunk' }
  if (rest === 'selected') return { base, suffix: 'selected' }
  if (/^\d+$/.test(rest)) return { base, suffix: 'chunk-n', chunkIndex: Number(rest) }
  // 未知后缀（如 mergeReview:characters 这类「本身即 id」）→ 交由 id 精确匹配处理
  return { base: dep, suffix: 'global' }
}

/** 解析一个任务的全部依赖目标节点（去重）。 */
export function resolveDepNodes(task: TaskDef, all: TaskDef[]): string[] {
  const ids = new Set(all.map((t) => t.id))
  const kinds = new Map<string, string[]>()
  for (const t of all) {
    if (!kinds.has(t.kind)) kinds.set(t.kind, [])
    kinds.get(t.kind)!.push(t.id)
  }
  const out = new Set<string>()
  for (const dep of task.dependsOn) {
    if (ids.has(dep)) {
      out.add(dep)
      continue
    }
    const base = depBase(dep)
    if (VIRTUAL_STEPS.includes(base)) continue // 程序步骤：非节点
    if (ids.has(base)) {
      out.add(base)
      continue
    }
    const byKind = kinds.get(base)
    if (byKind) for (const id of byKind) out.add(id)
  }
  return [...out]
}

export interface TopoResult {
  order: string[]
  /** 每个节点的依赖节点（已解析，去掉虚拟步骤） */
  deps: Record<string, string[]>
  warnings: string[]
}

/**
 * Kahn 拓扑排序。存在环 → 抛**可读错误**（列出环上节点，启动前拦截）。
 */
export function topoOrder(tasks: TaskDef[]): TopoResult {
  const ids = tasks.map((t) => t.id)
  const idSet = new Set(ids)
  const deps: Record<string, string[]> = {}
  const warnings: string[] = []
  const indeg = new Map<string, number>()
  const adj = new Map<string, string[]>()

  for (const id of ids) {
    indeg.set(id, 0)
    adj.set(id, [])
  }
  for (const t of tasks) {
    const d = resolveDepNodes(t, tasks).filter((x) => idSet.has(x) && x !== t.id)
    deps[t.id] = d
    indeg.set(t.id, d.length)
    for (const from of d) adj.get(from)!.push(t.id)
  }
  const queue: string[] = ids.filter((id) => (indeg.get(id) ?? 0) === 0)
  const order: string[] = []
  while (queue.length) {
    const id = queue.shift()!
    order.push(id)
    for (const next of adj.get(id) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 0) - 1)
      if ((indeg.get(next) ?? 0) === 0) queue.push(next)
    }
  }

  if (order.length !== ids.length) {
    const remaining = ids.filter((id) => !order.includes(id))
    throw new Error(`任务依赖存在环，无法拓扑排序。涉环节点：${remaining.join(', ')}`)
  }
  return { order, deps, warnings }
}

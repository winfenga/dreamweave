/**
 * 任务面板视图组装（T5）：把「注册表 29 个任务」× 「本机状态表」×「chunks 数」拼成
 * 一份**只读**的面板数据（纯函数式读取，不写任何文件，可 node 直测、不依赖 electron）。
 *
 * 口径（三句说清，实现严格照此）：
 *  1. **一行一个任务**（注册表条目），顺序 = `dag.topoOrder()` 的拓扑序；
 *  2. **实例数**：`expected = global ? 1 : chunksLen`；`actual` = 本机状态里属于该任务的实例数；
 *     `counts` 先按本机实际实例的状态计数，再把**缺额**（`expected - actual`，负差取 0）计入
 *     `pending` —— 于是 `counts` 各状态之和 ≈ `max(expected, actual)`，不会被「还没跑的实例」漏算；
 *  3. **来源包自带历史不计入本机成绩**：本机状态只取 `persistence.loadTaskStates()`（已过滤历史），
 *     历史条数单独用 `loadInheritedTaskStates()` 数出来供面板提示，绝不并入任何任务的 counts。
 *
 * 容错姿势（面板可坏不可崩）：
 *  - 注册表缺失/损坏 → **抛可读错误**（没有注册表就没有「29 个任务」可分组，继续渲染是骗人）；
 *  - 拓扑失败（成环）→ 退回注册表原序，**不抛**（面板只读展示，环由编排器启动时拦截）；
 *  - `records/chunks.json` 缺失/损坏 → chunksLen 视为 1，**不抛**；
 *  - `index.json` 缺失/损坏 → pkgId/title 留空，任务归属退回 `extractTaskId` 兜底，**不抛**。
 */

import { readIndex } from '../workspace/index-store'
import { extractTaskId, readShard } from '../workspace/shards'
import { topoOrder } from './dag'
import { loadInheritedTaskStates, loadTaskStates } from './persistence'
import { loadTaskRegistry } from './task-registry'
import type { TaskCounts, TaskDef, TaskOverviewItem, TasksOverview } from '../../shared/pipeline-types'
import type { TaskState } from '../../shared/workspace-types'

export type { TaskCounts, TaskInstanceState, TaskOverviewItem, TasksOverview } from '../../shared/pipeline-types'

/** chunks 分片（chunk 实例数来源）。 */
const CHUNKS_FILE = 'records/chunks.json'

/** `buildTasksOverview` 的可选入参。 */
export interface BuildOverviewOptions {
  /** 覆盖注册表任务列表（验证脚本 / 单测注入；不传则读 `resources/pipeline/task-registry.json`）。 */
  tasks?: TaskDef[]
  /** 覆盖注册表目录（验证脚本用来验「注册表缺失 → 抛可读错误」）。 */
  registryDir?: string
}

/** 空计数（每次新建，避免共享可变对象）。 */
function emptyCounts(): TaskCounts {
  return { succeeded: 0, failed: 0, skipped: 0, local: 0, running: 0, pending: 0 }
}

/** 把一个状态计入计数（未知/脏状态直接忽略，不虚增）。 */
function bumpCounts(counts: TaskCounts, status: unknown): void {
  if (typeof status !== 'string') return
  switch (status) {
    case 'succeeded':
      counts.succeeded += 1
      break
    case 'failed':
      counts.failed += 1
      break
    case 'skipped':
      counts.skipped += 1
      break
    case 'local':
      counts.local += 1
      break
    case 'running':
      counts.running += 1
      break
    case 'pending':
      counts.pending += 1
      break
    default:
      break
  }
}

/** 加载注册表任务（失败 → 抛可读错误；面板无注册表无法分组）。 */
async function loadTasksForOverview(registryDir?: string): Promise<TaskDef[]> {
  const r = await loadTaskRegistry(registryDir)
  if (!r.ok || !r.tasks || !r.tasks.length) {
    throw new Error(`任务面板无法加载任务注册表：${r.error ?? '注册表为空'}`)
  }
  return r.tasks
}

/**
 * 按拓扑序排列任务（Kahn）。
 * 成环 → 退回注册表原序（面板只读展示，不因环拒绝出图；环由编排器启动时拦截并报错）。
 */
function orderTasks(tasks: TaskDef[]): TaskDef[] {
  const byId = new Map<string, TaskDef>()
  for (const t of tasks) byId.set(t.id, t)
  try {
    const topo = topoOrder(tasks)
    const out: TaskDef[] = []
    for (const id of topo.order) {
      const t = byId.get(id)
      if (t && !out.includes(t)) out.push(t)
    }
    // 拓扑序理论上覆盖全部节点；万一遗漏（注册表里不在图上的条目）按原序补齐，绝不丢行
    for (const t of tasks) if (!out.includes(t)) out.push(t)
    return out
  } catch {
    return [...tasks]
  }
}

/**
 * 构造「实例键 → taskId」判定器。
 *
 * 优先按 `"<pkgId>:<revisionId>:"` 前缀剥掉作用域再匹配（任务 id 自身可能含冒号，如
 * `mergeReview:characters`，故必须用**最长 id 优先 + 边界为冒号或结尾**匹配，
 * 否则 `merge` 会把 `mergeReview:characters` 抢走）。
 * 索引不可读（无作用域前缀）时退回 `extractTaskId()` 的通用推断。
 */
function makeTaskIdMatcher(
  tasks: TaskDef[],
  pkgId: string,
  revisionId: string
): (key: string) => string | null {
  const ids = tasks.map((t) => t.id)
  const idSet = new Set(ids)
  const sorted = [...ids].sort((a, b) => b.length - a.length)
  const prefix = pkgId && revisionId ? `${pkgId}:${revisionId}:` : ''
  return (key: string): string | null => {
    const scope = prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key
    for (const id of sorted) {
      if (scope === id || scope.startsWith(`${id}:`)) return id
    }
    const guess = extractTaskId(key)
    return idSet.has(guess) ? guess : null
  }
}

/** 读 chunk 实例数（分片缺失/损坏 → 1，不抛）。 */
async function readChunksLen(root: string): Promise<number> {
  try {
    const env = await readShard(root, CHUNKS_FILE)
    return env.entries.length
  } catch {
    return 1
  }
}

/** 读索引里的 pkgId/title/revisionId（缺失/损坏 → 空串，不抛）。 */
async function readIdentity(
  root: string
): Promise<{ pkgId: string; title: string; revisionId: string }> {
  try {
    const idx = await readIndex(root)
    return {
      pkgId: typeof idx.pkgId === 'string' ? idx.pkgId : '',
      title: typeof idx.title === 'string' ? idx.title : '',
      revisionId: typeof idx.origin?.revisionId === 'string' ? idx.origin.revisionId : ''
    }
  } catch {
    return { pkgId: '', title: '', revisionId: '' }
  }
}

/**
 * 组装任务面板视图（按注册表拓扑序；缺失的实例按 pending 计入）。
 *
 * 纯读：只 `readShard` / `readIndex`，不产生任何写入（验证脚本会断言 mtime/size 不变）。
 *
 * @param root 工作库根
 * @param opts.tasks 覆盖注册表任务列表（不传则读资源目录里的注册表）
 * @param opts.registryDir 覆盖注册表目录（仅验证用）
 */
export async function buildTasksOverview(
  root: string,
  opts: BuildOverviewOptions = {}
): Promise<TasksOverview> {
  if (typeof root !== 'string' || !root.trim()) {
    throw new Error('任务面板：工作库根为空，无法读取任务状态')
  }

  const registryTasks = opts.tasks ?? (await loadTasksForOverview(opts.registryDir))
  const ordered = orderTasks(registryTasks)

  const identity = await readIdentity(root)
  const chunksLen = await readChunksLen(root)
  const localStates: Record<string, TaskState> = await loadTaskStates(root)
  const inheritedStates = await loadInheritedTaskStates(root)
  const matchTaskId = makeTaskIdMatcher(registryTasks, identity.pkgId, identity.revisionId)

  // 本机状态按 taskId 归桶（一次遍历，避免 29 次扫全表）
  const buckets = new Map<string, { key: string; status: string; error: string | null; elapsedMs?: number }[]>()
  const localCounts = emptyCounts()
  let localTotal = 0
  for (const [key, state] of Object.entries(localStates)) {
    localTotal += 1
    bumpCounts(localCounts, state?.status)
    const taskId = matchTaskId(key)
    if (!taskId) continue // 不属于注册表任何任务（脏键）：只计入 localTotal，不进任何行
    const list = buckets.get(taskId) ?? []
    list.push({
      key,
      status: typeof state?.status === 'string' ? state.status : 'pending',
      error: typeof state?.error === 'string' ? state.error : null,
      elapsedMs: typeof state?.elapsedMs === 'number' && state.elapsedMs > 0 ? state.elapsedMs : undefined
    })
    buckets.set(taskId, list)
  }

  const items: TaskOverviewItem[] = ordered.map((task) => {
    const instances = buckets.get(task.id) ?? []
    const expected = task.global ? 1 : chunksLen
    const actual = instances.length
    const counts = emptyCounts()
    const failures: { key: string; error: string }[] = []
    for (const inst of instances) {
      bumpCounts(counts, inst.status)
      if (inst.status === 'failed') failures.push({ key: inst.key, error: inst.error ?? '' })
    }
    // 缺额按 pending 补（actual > expected 时不出现负数；历史子集导致的超量不抵消已跑计数）
    counts.pending += Math.max(0, expected - actual)

    // G4 平均耗时：有 elapsedMs 的实例取平均；无 → null（面板显示「—」）
    const withElapsed = instances.filter((i) => i.elapsedMs !== undefined)
    const avgElapsedMs =
      withElapsed.length > 0
        ? Math.round(withElapsed.reduce((sum, i) => sum + (i.elapsedMs ?? 0), 0) / withElapsed.length)
        : null

    return {
      id: task.id,
      label: typeof task.label === 'string' && task.label ? task.label : task.id,
      kind: typeof task.kind === 'string' ? task.kind : task.id,
      feature: typeof task.feature === 'string' ? task.feature : '',
      model: task.model === true,
      global: task.global === true,
      execution: typeof task.execution === 'string' ? task.execution : '',
      dependsOn: Array.isArray(task.dependsOn) ? [...task.dependsOn] : [],
      expected,
      actual,
      counts,
      failures,
      avgElapsedMs
    }
  })

  return {
    pkgId: identity.pkgId,
    title: identity.title,
    localTotal,
    localCounts,
    inheritedTotal: Object.keys(inheritedStates).length,
    tasks: items
  }
}

/**
 * 编排器持久化层（设计 §6.4 / §6.10 / §9）。
 *
 * - `records/tasks.json`：任务实例状态源（`index.tasks` 镜像同步）；
 * - `records/attempts/<taskId>.json`：**每 taskId 一份**，内含该 taskId 各次尝试；
 * - `records/results/<taskId>.json`（storyScript/plotLocation 除外）：任务产物。
 *
 * **所有写盘一律经 `workspace/shards.ts` 的 `updateShard` / `writeShard`（唯一入口）**，
 * 由它承担 per-path 串行队列 + `tmp→复检→原子 rename` —— 并发写同一分片不丢更新。
 *
 * **产物也有「本机 / 来源包自带」之分**（T7-A）：`writeResult` 写入的 value 顶层恒带
 * `source: 'runtime'`（`saveTaskState` 同款语义），表示「本机运行写出」；导入 .t2w 解包带来的
 * 来源包历史产物没有该标记。读取侧据此可区分二者（**当前不改变任何选取行为**——`pickMainEntry`
 * 仍一视同仁，只是多了一个可判定的事实；地图页据此显示数据来自本机还是来源包）。
 */
import { readShard, routeResultsKey, shardNameFor, updateShard } from '../workspace/shards'
import { CONTAINER_FILES, attemptsShardFile } from '../workspace/paths'
import { readIndex, writeIndex } from '../workspace/index-store'
import type { ShardEnvelope } from '../workspace/types'
import type { AttemptRecord } from '../../shared/pipeline-types'
import type { TaskState } from '../../shared/workspace-types'

/** tasks.json 分片路径。 */
export const TASKS_FILE = CONTAINER_FILES.tasks // 'records/tasks.json'
const TASKS_SHARD = shardNameFor(TASKS_FILE)

/**
 * 判定某条目值是否为**本机运行状态**（见 `TaskState.source` 注释）。
 *
 * 三条判据（依次）：
 *  1. 显式标记 `source === 'runtime'` → 本机状态（T4 起所有写入都带此标记）；
 *  2. `source` 缺省（T4 之前本机写的历史状态没有标记）→ 靠**字段集**甄别：本机 `TaskState`
 *     只有 4 个字段（status/fingerprint/updatedAt/error），出现包内历史特征键中的任一个
 *     （`key`/`projectId`/`attemptIds`/`revisionId`）即判为**来源包自带历史**；
 *  3. `source` 是其它值（脏数据）→ 一律不认作本机状态（宁可不复用，也不假就绪）。
 *
 * 背景：真实工作库的 `records/tasks.json` 里带着来源包自带的 95 条历史状态（12 字段、
 * 全 `succeeded`，由原项目写出）。若不区分，它们会变成「本机已跑」，造成
 * `orchestrator.depSatisfied()` 上游依赖**假就绪**（下游任务被放行去读别人的旧产物）。
 */
export function isRuntimeState(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (o.source === 'runtime') return true
  // 兼容：T4 之前本机写的状态没有 source 标记，但字段集只有 4 个（无 key/projectId/attemptIds 等包内历史特征）
  if (o.source === undefined) return !('key' in o) && !('projectId' in o) && !('attemptIds' in o) && !('revisionId' in o)
  return false
}

/**
 * 读取**本机**任务状态表（分片缺失/损坏 → 空表）。
 *
 * ⚠️ 只返回本机运行写入的状态（`isRuntimeState`）。来源包自带的历史状态（导入 t2w 时整包
 * 解包带来的 12 字段条目，全 succeeded）**在此被排除**——它们不是本机成绩，排除后：
 *  - `orchestrator.depSatisfied()` 不再被假状态污染（上游依赖不会因包内历史而假就绪）；
 *  - 状态汇总口径（成功数等）只统计本机实际跑过的实例；
 *  - **副作用（期望行为）**：首次运行会真的把任务跑一遍（包内无本机状态 → 无「已成功」可复用）。
 *    幂等判断（`prev.status==='succeeded' && prev.fingerprint===fp`）不受影响：包内历史的
 *    fingerprint 用的是原项目算法，与本引擎的 `fingerprintOf()` 本就不匹配。
 */
export async function loadTaskStates(root: string): Promise<Record<string, TaskState>> {
  try {
    const env = await readShard(root, TASKS_FILE)
    const out: Record<string, TaskState> = {}
    for (const e of env.entries) {
      if (!e.value || typeof e.value !== 'object') continue
      if (!isRuntimeState(e.value)) continue // 包内历史：不是本机成绩，剔除
      out[String(e.key)] = e.value as TaskState
    }
    return out
  } catch {
    return {}
  }
}

/**
 * 读取**非本机**状态条目（= 来源包自带的历史状态；分片缺失/损坏 → 空对象）。
 *
 * 用途：T5 面板展示「来源包自带 N 条历史（不计入本机成绩）」，让用户理解
 * 「为什么本机成功数不是包内那个数」，而不必再去翻 records/tasks.json。
 * 与 `loadTaskStates` 严格互补：两函数的键集不相交、并集 = 分片内全部对象条目。
 * **只读**：绝不改写分片。
 */
export async function loadInheritedTaskStates(root: string): Promise<Record<string, unknown>> {
  try {
    const env = await readShard(root, TASKS_FILE)
    const out: Record<string, unknown> = {}
    for (const e of env.entries) {
      if (!e.value || typeof e.value !== 'object') continue
      if (isRuntimeState(e.value)) continue // 本机状态：不算「来源包历史」
      out[String(e.key)] = e.value
    }
    return out
  } catch {
    return {}
  }
}

/**
 * 写入 / 更新一个任务实例状态（upsert by key）。
 *
 * 写入值恒带 `source: 'runtime'`（本机成绩标记）——读取侧据此把它与来源包自带历史区分开。
 */
export async function saveTaskState(root: string, instanceKey: string, state: TaskState): Promise<void> {
  const value: TaskState = { ...state, source: 'runtime' }
  await updateShard(root, TASKS_FILE, 'tasks', TASKS_SHARD, (env: ShardEnvelope) => {
    const idx = env.entries.findIndex((e) => String(e.key) === instanceKey)
    if (idx >= 0) env.entries[idx] = { ...env.entries[idx], value }
    else env.entries.push({ seq: nextSeq(env), key: instanceKey, value })
    return env
  })
}

/** 追加一次尝试留痕（attempts/<taskId>.json）。 */
export async function appendAttempt(root: string, taskId: string, record: AttemptRecord): Promise<void> {
  const file = attemptsShardFile(taskId)
  await updateShard(root, file, 'attempts', shardNameFor(file), (env: ShardEnvelope) => {
    env.entries.push({ seq: nextSeq(env), key: record.id, value: record })
    return env
  })
}

/**
 * 给产物 value 补**本机运行标记**（`source: 'runtime'`）。
 *
 * 只给**非空对象**补：数组与标量原样返回（往数组上塞 `source` 会破坏 `[...]` 的消费方，
 * 标量也无处可挂）。产物信封 `{data, local?, depth?, calls?, warnings?, at}` 由调用方构造，
 * 标记统一在本函数内补 —— 调用方（orchestrator 的两处 writeResult）不必各自改。
 */
function stampRuntimeSource(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  return { ...(value as Record<string, unknown>), source: 'runtime' }
}

/** 写入任务产物（results/<taskId>.json；storyScript/plotLocation 走各自叶真源路由）。 */
export async function writeResult(root: string, instanceKey: string, value: unknown): Promise<void> {
  const file = routeResultsKey(instanceKey)
  const stamped = stampRuntimeSource(value)
  await updateShard(root, file, 'results', shardNameFor(file), (env: ShardEnvelope) => {
    const idx = env.entries.findIndex((e) => String(e.key) === instanceKey)
    if (idx >= 0) env.entries[idx] = { ...env.entries[idx], value: stamped }
    else env.entries.push({ seq: nextSeq(env), key: instanceKey, value: stamped })
    return env
  })
}

/** 读取某实例的产物（命中 → 值；否则 undefined）。 */
export async function readResult(root: string, instanceKey: string): Promise<unknown | undefined> {
  const file = routeResultsKey(instanceKey)
  try {
    const env = await readShard(root, file)
    const e = env.entries.find((x) => String(x.key) === instanceKey)
    return e?.value
  } catch {
    return undefined
  }
}

/** 分片内下一全局序号（同文件内单调递增）。 */
function nextSeq(env: ShardEnvelope): number {
  let max = -1
  for (const e of env.entries) if (typeof e.seq === 'number' && e.seq > max) max = e.seq
  return max + 1
}

/**
 * 镜像任务状态到 `index.json` 的 `tasks`（records/tasks.json 为权威源）。
 * 进程内串行化，避免编排器内的并发读-改-写丢更新。
 *
 * 契约：调用方**只传本机运行状态**（`loadTaskStates` 的结果 + 本次运行写入），
 * 来源包自带的历史状态不经本函数进索引（否则 `index.tasks` 也会混入非本机成绩）。
 */
let indexQueue: Promise<void> = Promise.resolve()
export function mirrorTasksToIndex(root: string, states: Record<string, TaskState>): Promise<void> {
  indexQueue = indexQueue.then(async () => {
    try {
      const idx = await readIndex(root)
      idx.tasks = { ...idx.tasks, ...states }
      idx.integrity.lastVerifiedAt = new Date().toISOString()
      await writeIndex(root, idx)
    } catch {
      // 索引缺失/损坏时忽略镜像（records/tasks.json 已是权威源）
    }
  })
  return indexQueue
}

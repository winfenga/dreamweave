/**
 * index.json 的原子读写 + 结构校验（设计 §3.1 / §3.3）。
 *
 * - 缺失/损坏给**可读错误**（A-P0-4）；
 * - 写入走 `tmp + rename`（原子替换，进程崩溃不产生半截文件）。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { INDEX_FILE, INDEX_VERSION, WORKSPACE_FORMAT, isAcceptedWorkspaceFormat } from './paths'
import type { WorkspaceIndex } from './types'

/** 结构校验：任意不符即抛可读错误（告警不阻断仅用于资产，不用于 index 骨架）。 */
function validateIndex(raw: unknown, source: string): WorkspaceIndex {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`工作库索引内容不是对象：${source}`)
  }
  const o = raw as Record<string, unknown>
  if (o.indexVersion !== INDEX_VERSION) {
    throw new Error(`工作库索引版本不符（期望 ${INDEX_VERSION}，实际 ${String(o.indexVersion)}）：${source}`)
  }
  // format 双值兼容：新值 + 历史 txt2world-workspace 都放行（见 paths.ts 说明）。
  // 只在**写入**时统一升级成新值，读侧绝不因为一个历史字符串把整本库判死。
  if (!isAcceptedWorkspaceFormat(o.format)) {
    throw new Error(`工作库索引 format 不符（期望 "${WORKSPACE_FORMAT}"，实际 "${String(o.format)}"）：${source}`)
  }
  if (typeof o.pkgId !== 'string' || o.pkgId.length === 0) {
    throw new Error(`工作库索引缺少 pkgId：${source}`)
  }
  if (typeof o.title !== 'string') {
    throw new Error(`工作库索引缺少 title：${source}`)
  }
  if (!o.origin || typeof o.origin !== 'object') {
    throw new Error(`工作库索引缺少 origin 指纹：${source}`)
  }
  if (!o.manifest || typeof o.manifest !== 'object') {
    throw new Error(`工作库索引缺少 manifest 骨架：${source}`)
  }
  if (!Array.isArray(o.shards)) {
    throw new Error(`工作库索引缺少 shards[]：${source}`)
  }
  if (!Array.isArray(o.assets)) {
    throw new Error(`工作库索引缺少 assets[]：${source}`)
  }
  if (!o.tasks || typeof o.tasks !== 'object') {
    throw new Error(`工作库索引缺少 tasks 状态表：${source}`)
  }
  if (!o.integrity || typeof o.integrity !== 'object') {
    throw new Error(`工作库索引缺少 integrity：${source}`)
  }
  return o as unknown as WorkspaceIndex
}

/** 读取并校验 `index.json`；缺失/损坏 → 抛可读错误。 */
export async function readIndex(root: string): Promise<WorkspaceIndex> {
  const abs = join(root, INDEX_FILE)
  let text: string
  try {
    text = await readFile(abs, 'utf8')
  } catch (e) {
    throw new Error(`工作库索引缺失或不可读：${abs}（${(e as Error).message}）`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new Error(`工作库索引 JSON 损坏：${abs}（${(e as Error).message}）`)
  }
  return validateIndex(parsed, abs)
}

/** 原子写入 `index.json`（tmp + rename）。 */
export async function writeIndex(root: string, idx: WorkspaceIndex): Promise<void> {
  await mkdir(root, { recursive: true })
  const abs = join(root, INDEX_FILE)
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  await writeFile(tmp, JSON.stringify(idx, null, 2), 'utf8')
  await rename(tmp, abs)
}

/**
 * **索引读-改-写的唯一安全入口**（进程内全局串行）。
 *
 * 为什么必须有它：`index.json` 是**单一文件**，却有多个并发写者——
 *   - `shards.updateShard` 写产物后要登记 `index.shards[]`（按文件粒度并发）；
 *   - `persistence.mirrorTasksToIndex` 镜像任务状态（每次状态变更）；
 *   - `shard-write.updateShardRow` 更新 sha256/entryCount；
 *   - 用户写回、资产导入等。
 * 各自 `readIndex → 改 → writeIndex` 会**互相覆盖**：A 读到旧值、B 也读到旧值，
 * A 先写、B 后写 → A 的改动静默丢失（典型后果就是分片行丢失 →
 * 聚合型任务报「工作库中没有任何 upstream 结果」）。
 *
 * 因此所有「读-改-写」一律经本函数：整个读-改-写在同一队列内完成，天然互斥。
 * 单纯读取（`readIndex`）不受影响，无需排队。
 *
 * @param root    工作库根
 * @param mutate  收当前索引，**就地修改或返回新对象**；返回 undefined 表示就地改完
 * @returns 修改后的索引（已落盘）
 */
let indexMutex: Promise<unknown> = Promise.resolve()

export async function updateIndex(
  root: string,
  mutate: (idx: WorkspaceIndex) => WorkspaceIndex | void | Promise<WorkspaceIndex | void>
): Promise<WorkspaceIndex> {
  const task = async (): Promise<WorkspaceIndex> => {
    const idx = await readIndex(root)
    const ret = await mutate(idx)
    const next = ret && typeof ret === 'object' ? (ret as WorkspaceIndex) : idx
    await writeIndex(root, next)
    return next
  }
  const next = indexMutex.then(task, task)
  // 队列只关心「串行」，不关心成败；失败不阻断后续排队者
  indexMutex = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

/**
 * 分片路由 + 信封读写 + 容器重建（设计 §3.2 / §5.1 / §5.2 / §9）。
 *
 * 关键不变量：
 *  - 路由**不过滤任何副本**：`storyScript:0` 与其全部 `:batch:` 变体同读同写进同一文件（§5.1）；
 *  - `seq` = 容器内全局序号，重建时按 `seq` 升序即**零重排**还原原顺序（§5.2）；
 *  - `key`/`value` 逐字保留（含 `:batch:`/`:grouped:`/`:plan`/`:repair` 后缀与 `.data` 层）。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sha256Hex } from '../t2w/format'
import {
  CONTAINER_FILES,
  PLOT_LOCATIONS_FILE,
  STORY_SCRIPT_MISC_CHUNK,
  attemptsShardFile,
  resultsShardFile,
  storyScriptShardFile
} from './paths'
import type { KeyedEntry, ShardEnvelope, ShardRoute, WorkspaceIndex } from './types'

/**
 * 已知任务 id（29 任务 + recon 登记的伴随程序步骤 memoryBefore/memoryAfter + 观测到的 templates）。
 * 用于从 key 中稳定定位 taskId（前缀为 <pkgId>:<revisionId>，二者不会等于任务 id）。
 */
export const KNOWN_TASK_IDS: readonly string[] = [
  'cacheWarming',
  'seg',
  'chunkLocationSummary',
  'settingSummary',
  'locationTree',
  'batchLocationSummary',
  'impressionLayout',
  'plot',
  'worldImpression',
  'draft',
  'draftCharacter',
  'draftOther',
  'merge',
  'mergeReview',
  'canonical',
  'characterAppearance',
  'draftAlign',
  'characterRelation',
  'lineAnnotation',
  'plotLocation',
  'storyScript',
  'effectAnnotation',
  'performanceReview',
  'plotLocationMerge',
  'event',
  'compact',
  'memoryBefore',
  'memoryAfter',
  'templates'
]

/**
 * 从结果条目 key 中提取 taskId。
 * 形如 `<pkgId>:<revisionId>:<taskId>[:<chunkIndex>][:batch:<b>]…`。
 */
export function extractTaskId(key: string): string {
  const segments = key.split(':')
  for (const s of segments) {
    if (KNOWN_TASK_IDS.includes(s)) return s
  }
  return segments.length > 2 ? segments[2] : segments[0]
}

const STORY_SCRIPT_RE = /:storyScript(?::(\d+))?/

/** 提取 storyScript 的 chunk 序号；无 → 'misc'。 */
export function storyScriptChunkOf(key: string): number | typeof STORY_SCRIPT_MISC_CHUNK {
  const m = STORY_SCRIPT_RE.exec(key)
  return m && m[1] !== undefined ? Number(m[1]) : STORY_SCRIPT_MISC_CHUNK
}

/**
 * 结果条目 key → 分片文件（设计 §9）。
 * 叶真源 storyScript/plotLocation 落在 script/、world/；其余落 records/results/<taskId>.json。
 */
export function routeResultsKey(key: string): string {
  const taskId = extractTaskId(key)
  if (taskId === 'storyScript') return storyScriptShardFile(storyScriptChunkOf(key))
  if (taskId === 'plotLocation') return PLOT_LOCATIONS_FILE
  return resultsShardFile(taskId)
}

/**
 * 任意容器条目 → 分片文件。
 * - results：按 key 路由；
 * - attempts：按 value.taskId 路由（每 taskId 一份留痕，对齐设计 §9 cacheWarming 行）；
 * - chapters/chunks/tasks/reader：固定文件；
 * - 未知容器：records/<name>.json（透传兜底）。
 */
export function routeContainer(name: string, key: string, value?: unknown): string {
  if (name === 'results') return routeResultsKey(key)
  if (name === 'attempts') {
    const v = value as { taskId?: unknown } | undefined
    const raw = typeof v?.taskId === 'string' ? v.taskId : ''
    const taskId = raw ? raw.split(':')[0] : '_misc'
    return attemptsShardFile(taskId)
  }
  return CONTAINER_FILES[name] ?? `records/${name}.json`
}

/** 分片路由名（= file 去掉 `.json`），供 index.shards[].name 使用。 */
export function shardNameFor(file: string): string {
  return file.replace(/\.json$/, '')
}

export function serializeEnvelope(env: ShardEnvelope): string {
  return JSON.stringify(env)
}

/**
 * per-path 串行写队列（设计 §6.10 · v3.4 唯一瓶颈）。
 *
 * 所有写盘统一经 `writeShard`，同绝对路径的写按提交顺序串行（promise chain），
 * 跨文件互不阻塞（按绝对路径分桶）。所有写者（编排器 M2+ / P3 / P4 / M9 重跑）
 * 共用同一队列 → 同分片「读-改-写」天然互斥，杜绝静默丢更新。
 */
const writeQueues = new Map<string, Promise<unknown>>()

function enqueueWrite<T>(absPath: string, task: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(absPath) ?? Promise.resolve()
  const next = prev.then(task, task)
  writeQueues.set(
    absPath,
    next.catch(() => undefined)
  )
  return next
}

/** 读取分片（损坏即抛可读错误）。 */
export async function readShard(root: string, file: string): Promise<ShardEnvelope> {
  const text = await readFile(join(root, file), 'utf8')
  let env: unknown
  try {
    env = JSON.parse(text)
  } catch (e) {
    throw new Error(`分片 JSON 损坏：${file}（${(e as Error).message}）`)
  }
  const o = env as ShardEnvelope
  if (!o || typeof o !== 'object' || typeof o.shard !== 'string' || !Array.isArray(o.entries)) {
    throw new Error(`分片结构不符：${file}`)
  }
  return o
}

/**
 * 写入分片（**唯一写入口**，设计 §6.10 + M1-T3）。
 *
 * 语义：
 *  1. per-path 串行队列（同文件写互斥，跨文件并行）；
 *  2. 原子写：`<file>.tmp-<pid>-<rand>` → `rename`（失败删 tmp、原文件不变）；
 *  3. 返回文件字节 sha256（供 index.shards[].sha256 记录）。
 *
 * ⚠️ 禁止任何模块绕过本函数直写分片文件（否则用户写回与解析写入无互斥 → 静默丢更新）。
 * 「读-改-写」的读段也应在本队列内完成（见 `withShard`），否则读到的可能是旧值。
 */
export async function writeShard(root: string, file: string, env: ShardEnvelope): Promise<string> {
  const abs = join(root, file)
  return enqueueWrite(abs, async () => {
    await mkdir(dirname(abs), { recursive: true })
    const text = serializeEnvelope(env)
    const tmp = `${abs}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    try {
      await writeFile(tmp, text, 'utf8')
      // 复检：读回字节与待写字节一致才改名（防半截盘/写放大损坏）
      const back = await readFile(tmp, 'utf8')
      if (back !== text) {
        throw new Error(`分片原子写复检失败（tmp 读回不符）：${file}`)
      }
      await rename(tmp, abs)
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => undefined)
      throw e
    }
    return sha256Hex(Buffer.from(text, 'utf8'))
  })
}

/**
 * 分片「读-改-写」复合操作（设计 §6.10：读段也在队列内，读到的一定是最新值）。
 *
 * `mutate` 收到队列内读出的信封，返回写回信封（可原样返回仅改了 entries 的同一对象）。
 * 整个读-改-写在同一路径队列内原子完成，调用方无需再自行加锁。
 */
export async function withShard(
  root: string,
  file: string,
  mutate: (env: ShardEnvelope) => Promise<ShardEnvelope> | ShardEnvelope
): Promise<{ env: ShardEnvelope; sha256: string }> {
  const abs = join(root, file)
  const { sha256, env } = await enqueueWrite(abs, async () => {
    const env = await readShard(root, file)
    const next = await mutate(env)
    // 写段内联 writeShard 的原子写序列（不递归入队——已在同一路径队列内）
    await mkdir(dirname(abs), { recursive: true })
    const text = serializeEnvelope(next)
    const tmp = `${abs}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    try {
      await writeFile(tmp, text, 'utf8')
      const back = await readFile(tmp, 'utf8')
      if (back !== text) {
        throw new Error(`分片原子写复检失败（tmp 读回不符）：${file}`)
      }
      await rename(tmp, abs)
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => undefined)
      throw e
    }
    return { sha256: sha256Hex(Buffer.from(text, 'utf8')), env: next }
  })
  return { env, sha256 }
}

/**
 * 分片 upsert（编排器 M2+ 首选入口，设计 §6.10）。
 *
 * 与 `withShard` 等价，但**容忍文件缺失**：文件不存在时以空信封起手；存在则读出最新值。
 * 「读段」与「写段」在同一路径队列内原子完成 → 并发 upsert 同一分片**不丢更新**。
 * 损坏文件（存在但 JSON 坏）会**抛错**，绝不静默清空重建。
 */
export async function updateShard(
  root: string,
  file: string,
  container: string,
  shardName: string,
  mutate: (env: ShardEnvelope) => ShardEnvelope | void | Promise<ShardEnvelope | void>
): Promise<{ env: ShardEnvelope; sha256: string }> {
  const abs = join(root, file)
  const { sha256, env } = await enqueueWrite(abs, async () => {
    let env: ShardEnvelope
    if (existsSync(abs)) {
      env = await readShard(root, file)
    } else {
      env = { shard: shardName, container, entries: [] }
    }
    const ret = await mutate(env)
    const next = ret && typeof ret === 'object' && Array.isArray((ret as ShardEnvelope).entries) ? (ret as ShardEnvelope) : env
    await mkdir(dirname(abs), { recursive: true })
    const text = serializeEnvelope(next)
    const tmp = `${abs}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    try {
      await writeFile(tmp, text, 'utf8')
      const back = await readFile(tmp, 'utf8')
      if (back !== text) {
        throw new Error(`分片原子写复检失败（tmp 读回不符）：${file}`)
      }
      await rename(tmp, abs)
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => undefined)
      throw e
    }
    return { sha256: sha256Hex(Buffer.from(text, 'utf8')), env: next }
  })
  return { env, sha256 }
}

/**
 * 由索引 + 分片重建某容器（导出 / 装配共用，设计 §5.2）。
 * 收集 `container === name` 的全部分片条目，按 `seq` 升序零重排还原。
 *
 * @param onMissingShard 传入后，读不到的分片**跳过**并回调通知（C2 导出容错；
 *   不传 → 缺失即抛，保持「绝不悄悄少内容」的原行为）。
 */
export async function rebuildContainer(
  root: string,
  idx: WorkspaceIndex,
  name: string,
  onMissingShard?: (file: string, err: Error) => void
): Promise<unknown> {
  const rows = idx.shards.filter((s) => s.container === name)
  const entries: KeyedEntry[] = []
  for (const s of rows) {
    let env: ShardEnvelope
    try {
      env = await readShard(root, s.file)
    } catch (e) {
      if (!onMissingShard) throw e
      onMissingShard(s.file, e as Error)
      continue
    }
    for (const e of env.entries) entries.push(e)
  }
  entries.sort((a, b) => a.seq - b.seq)
  const kind = idx.manifest.containers[name] ?? 'array'
  const keyed = idx.manifest.containerKeyed?.[name] ?? true
  if (kind === 'object') {
    const out: Record<string, unknown> = {}
    for (const e of entries) out[String(e.key)] = e.value
    return out
  }
  return keyed ? entries.map((e) => ({ key: e.key, value: e.value })) : entries.map((e) => e.value)
}

export type { ShardRoute }

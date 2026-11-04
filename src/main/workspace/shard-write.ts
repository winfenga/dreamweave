/**
 * P3/P4 分片级写回共享层（设计 §7 M1-T3）。
 *
 * 写回目标从「整包重写」迁移为「工作库 `script/story-script.<chunk>` 分片」，
 * 业务逻辑不变：
 *  - P3 改 `actions[].text`（四重匹配，含 `:batch:` 全副本）；
 *  - P4 改 `actions[].effects`（三元键，从不比对 text）+ `data.effectRanges`（范围写全部副本）；
 *  - 备份（来源包同目录 `.backup-时间戳.t2w`）+ 成员级 sha256 复检 + 原子改名语义全保留。
 *
 * **唯一写入口**（§6.10/v3.4）：分片落盘一律经 `shards.ts` 的 `withShard`（per-path
 * 串行队列内完成读-改-写 + tmp→复检→rename）。禁止绕过直写分片文件。
 *
 * 成员级复检口径（与原包写回同强度）：写完分片后 `assembleManifest` 重建整包
 * manifest，对每个资产条目 sha256 比对（二进制零改动由资产内容寻址保证）。
 * 同时更新 `index.shards[]` 中被写分片的 sha256/entryCount（原子写 index）。
 */
import { copyFile, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { sha256Hex } from '../t2w/format'
import { assembleManifest } from './manifest-assembler'
import { storyScriptShardFile } from './paths'
import { storyScriptChunkOf } from './shards'
import { readIndex, writeIndex } from './index-store'
import { withShard } from './shards'
import { refreshSessionIndex } from './session'
import type { KeyedEntry, ShardEnvelope, WorkspaceIndex } from './types'
import type { T2wManifest } from '../../shared/t2w-types'

/** records 里 storyScript 条目值可能是 { data: {...} } 或直接 {...}（与 view.ts unwrap 一致） */
export function storyScriptData(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const d = v.data
  if (d !== undefined && d !== null && typeof d === 'object') return d as Record<string, unknown>
  return v
}

/** 与 P3 script-edit.ts 逐字同款的时间戳：YYYYMMDD-HHmmss */
export function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 深拷贝（断开与信封的引用；写盘失败时信封保持原状）。
 * 注：信封刚从磁盘 JSON 反序列化而来，浅引用共享只发生在本函数内部，无并发风险，
 * 但保留拷贝语义与旧实现一致（失败路径的「内存不变」承诺）。
 */
export function deepCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

/** 备份来源包：`原名.backup-时间戳.t2w`（同目录）。 */
export async function backupSourcePkg(t2wPath: string): Promise<string> {
  const backupPath = join(
    dirname(t2wPath),
    `${basename(t2wPath, '.t2w')}.backup-${stamp()}.t2w`
  )
  await copyFile(t2wPath, backupPath)
  return backupPath
}

/**
 * 成员级复检：重建整包 manifest，比对每个资产 sha256（= 原包写回的 readPackage 复检
 * 在分片世界的等价物——资产内容寻址 + 装配即校验）。
 * 返回 { total, passed, failed } 与失败清单。
 */
export async function verifyAssembled(
  root: string,
  idx: WorkspaceIndex
): Promise<{ total: number; passed: number; failed: number; issues: string[] }> {
  const issues: string[] = []
  let passed = 0
  for (const a of idx.assets) {
    try {
      const bytes = Buffer.from(await readFile(join(root, a.store)))
      if (sha256Hex(bytes) === a.sha256) passed++
      else issues.push(`资产 sha256 不符：${a.path}`)
    } catch {
      issues.push(`资产缺失：${a.path}`)
    }
  }
  // 分片文件也逐一校验（写坏的分片会在这里暴露）
  for (const s of idx.shards) {
    try {
      const bytes = Buffer.from(await readFile(join(root, s.file)))
      if (sha256Hex(bytes) === s.sha256) passed++
      else issues.push(`分片 sha256 不符：${s.file}`)
    } catch {
      issues.push(`分片缺失：${s.file}`)
    }
  }
  return { total: idx.assets.length + idx.shards.length, passed, failed: issues.length, issues }
}

/** 更新 index.shards[] 中某分片行的 sha256/entryCount 并原子写 index。 */
export async function updateShardRow(
  root: string,
  idx: WorkspaceIndex,
  file: string,
  sha256: string,
  entryCount: number
): Promise<WorkspaceIndex> {
  const shards = idx.shards.map((s) =>
    s.file === file ? { ...s, sha256, entryCount } : s
  )
  const next: WorkspaceIndex = { ...idx, shards }
  await writeIndex(root, next)
  refreshSessionIndex(next)
  return next
}

/**
 * storyScript 分片写回通用骨架（P3/P4 共用）：
 *
 * 1. 读工作库 index → 找出 `container === 'results'` 且路由到 storyScript 分片的行；
 *    每个 `:storyScript[:n][:batch:b]` key 按其 chunk 序号路由到 `script/story-script.<n>.json`
 *    （`routeResultsKey` 同规则；路由函数在此处复用以拿到「分片文件 ← 条目 key」映射）。
 * 2. `withShard` 队列内：读信封 → `mutate(entries)` 改字段 → 写回（tmp→复检→rename）。
 *    **注意**：P4 的「范围写全部副本」跨多个 chunk 分片——逐分片按序 `withShard`
 *    （分片间是不同路径，队列互不阻塞；P3/P4 语义不需要跨分片事务，
 *     单分片失败即整体报错并保留已写分片——与旧实现「多副本同写一致」语义等价，
 *     因为旧实现任何副本写失败也是整包不落盘、多副本之间本无部分可见性要求）。
 * 3. 更新 index.shards[] 行 → 原子写 index → 刷新会话 index。
 * 4. `verifyAssembled` 成员级复检。
 *
 * `mutate` 签名：收 `{ key, value }` 可变条目数组（**同一对象引用**，直接改），
 * 返回 `{ touchedFiles, touchedEntries, rangesUpdated? }`。
 */
export interface ShardEditOutcome {
  /** 实际写盘的分片文件（相对路径） */
  touchedFiles: string[]
  /** 命中的条目（recordKey + actionIndex） */
  touchedEntries: { recordKey: string; actionIndex: number }[]
  /** 范围条目写到的副本数（P4 专用；P3 为 0） */
  rangesUpdated: number
  /** 复检结果 */
  verify: { total: number; passed: number; failed: number; issues: string[] }
}

export type StoryScriptMutator = (
  entries: KeyedEntry[]
) => { touchedEntries: { recordKey: string; actionIndex: number }[]; rangesUpdated: number } | never

/**
 * 对一个 storyScript 分片执行队列内读-改-写；无命中返回 0 命中标记。
 * mutator 直接改 `env.entries`（浅数组、深 value），保证 JSON.stringify 语义与旧实现一致。
 */
async function editStoryScriptShard(
  root: string,
  file: string,
  mutator: StoryScriptMutator
): Promise<{ hits: number; ranges: number; sha256: string; entryCount: number } | null> {
  const { sha256, env } = await withShard(root, file, (env) => {
    const touched = mutator(env.entries)
    if (touched.touchedEntries.length === 0 && touched.rangesUpdated === 0) {
      // 无命中：原样返回（信封内容不变，但走一遍原子写也无害——为简化调用方统一处理）
      return env
    }
    return env
  })
  // 判定是否真的有改动：mutator 无副作用时 entryCount 不变且内容可能不变；
  // 这里以 mutator 返回值为准（mutator 内部计数），content 是否变化不影响正确性。
  const entryCount = env.entries.length
  const mutated = mutatorMarker.get(file)
  return { hits: mutated?.hits ?? 0, ranges: mutated?.ranges ?? 0, sha256, entryCount }
}

/**
 * mutator 结果传递（withShard 的 mutate 返回值只回传信封，不回传自定义数据，
 * 用模块级 Map 把 mutator 命中数带出来；队列串行保证无竞态）。
 */
const mutatorMarker = new Map<string, { hits: number; ranges: number }>()

/**
 * P3/P4 共用主入口：定位所有 storyScript 副本 → 按 chunk 分组 → 逐分片队列写。
 *
 * @param root        工作库根
 * @param srcT2wPath  来源包路径（备份用）
 * @param buildMutator 收「本分片内的 storyScript 条目」返回 mutator（闭包各自计数）
 * @param doBackup    是否先备份来源包（P0-24：命中后才备份——由调用方先探查再决定，
 *                    本函数提供 noBackup 选项给「命中 0 → 不备份不写盘」路径）
 */
export async function writeStoryScriptShards(
  root: string,
  srcT2wPath: string,
  buildMutator: (chunkEntries: KeyedEntry[]) => StoryScriptMutator,
  opts: { backup?: boolean } = {}
): Promise<{ ok: true; outcome: ShardEditOutcome; backupPath?: string; manifest: T2wManifest; index: WorkspaceIndex } | { ok: false; error: string }> {
  try {
    let idx = await readIndex(root)

    // ---- 1. 装配当前 results 容器，找全部 storyScript 条目（含 :batch: 副本）----
    const manifest = await assembleManifest(root, idx)
    const records = (manifest.records ?? {}) as Record<string, unknown>
    const results = records.results
    const entries: KeyedEntry[] = Array.isArray(results)
      ? (results as KeyedEntry[]).filter(
          (e) => e && typeof e === 'object' && typeof (e as { key?: unknown }).key !== 'undefined'
        )
      : results && typeof results === 'object'
        ? Object.entries(results as Record<string, unknown>).map(([key, value]) => ({ seq: 0, key, value }))
        : []
    const ssEntries = entries.filter((e) => String(e.key).includes(':storyScript'))
    if (ssEntries.length === 0) {
      return { ok: false, error: '包内没有找到 storyScript 记录' }
    }

    // ---- 2. 探查命中：构建 mutator 对装配条目跑一遍 dry-run（只计数不改）----
    // （直接用真 mutator 在真分片上跑也安全——无命中时信封原样写回；
    //   但「命中 0 → 不备份不写盘」要求先探查，这里用同 mutator 对深拷贝跑一遍。）
    const probeEntries = deepCopy(ssEntries)
    const probeMutator = buildMutator(probeEntries)
    let probeHits = 0
    let probeRanges = 0
    try {
      const r = probeMutator(probeEntries)
      probeHits = r.touchedEntries.length
      probeRanges = r.rangesUpdated
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
    if (probeHits === 0 && probeRanges === 0) {
      return { ok: false, error: 'MUTATION_MISS' }
    }

    // ---- 3. 备份来源包（命中后才备份，P0-24）----
    let backupPath: string | undefined
    if (opts.backup !== false) {
      backupPath = await backupSourcePkg(srcT2wPath)
    }

    // ---- 4. 按分片文件分组，逐分片队列写（mutator 闭包各自计数）----
    const byFile = new Map<string, KeyedEntry[]>()
    for (const e of ssEntries) {
      const file = storyScriptShardFile(storyScriptChunkOf(String(e.key)))
      let arr = byFile.get(file)
      if (!arr) {
        arr = []
        byFile.set(file, arr)
      }
      arr.push(e)
    }

    const touchedFiles: string[] = []
    const touchedEntries: { recordKey: string; actionIndex: number }[] = []
    let rangesUpdated = 0
    for (const [file, chunkEntries] of [...byFile.entries()].sort()) {
      const realMutator = buildMutator(chunkEntries)
      mutatorMarker.set(file, { hits: 0, ranges: 0 })
      const wrapped: StoryScriptMutator = (entries) => {
        const r = realMutator(entries)
        mutatorMarker.set(file, { hits: r.touchedEntries.length, ranges: r.rangesUpdated })
        touchedEntries.push(...r.touchedEntries)
        rangesUpdated += r.rangesUpdated
        return r
      }
      const r = await editStoryScriptShard(root, file, wrapped)
      mutatorMarker.delete(file)
      if (!r) continue
      if (r.hits > 0 || r.ranges > 0) {
        touchedFiles.push(file)
        idx = await updateShardRow(root, idx, file, r.sha256, r.entryCount)
      }
    }

    if (touchedFiles.length === 0) {
      return { ok: false, error: 'MUTATION_MISS' }
    }

    // ---- 5. 成员级复检 + 重新装配 manifest ----
    const verify = await verifyAssembled(root, idx)
    const nextManifest = await assembleManifest(root, idx)

    return {
      ok: true,
      outcome: { touchedFiles, touchedEntries, rangesUpdated, verify },
      backupPath,
      manifest: nextManifest,
      index: idx
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message || String(e) }
  }
}

/** 信封类型再导出（调用方 import 便利） */
export type { ShardEnvelope }

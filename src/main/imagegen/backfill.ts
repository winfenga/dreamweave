/**
 * 生成结果落盘 + 回填（人物立绘 / 场景图 / 地点图标三个入口）。
 *
 * 写入规范（与既有产物写入模式逐字对齐）：
 *   - 图片字节落 `assets/image/<sha256>.png`（内容寻址，`writeAsset` 同款去重）；
 *   - index.json 的 `assets[]` 追加一行（格式与真实库实摘一致：
 *     `{path: '<pkgId>/images/<sha>.png', size, sha256, store: 'assets/image/<sha>.png', kind: 'image'}`）；
 *   - reader 分片更新走 `updateShard`（与 persistence.writeResult 同款 upsert 语义，
 *     per-path 串行队列 + tmp→复检→原子 rename）；
 *   - reader 分片更新后**镜像回 index.shards**（entryCount + sha256 + integrity.lastVerifiedAt），
 *     与 mirrorTasksToIndex 的口径一致；
 *   - **旧资产文件永不删除**：force 覆盖只是写新资产 + 条目改指新 entryPath。
 */
import { randomUUID } from 'node:crypto'
import { CONTAINER_FILES } from '../workspace/paths'
import { readIndex, writeIndex } from '../workspace/index-store'
import { shardNameFor, updateShard } from '../workspace/shards'
import { writeAsset, storePathFor } from '../workspace/assets'
import type { AssetRow, ShardEnvelope } from '../workspace/types'
import { sha256Hex } from '../t2w/format'

const READER_FILE = CONTAINER_FILES.reader // 'records/reader.json'
const READER_SHARD = shardNameFor(READER_FILE) // 'records/reader'

/** reader 分片内下一全局序号。 */
function nextSeq(env: ShardEnvelope): number {
  let max = -1
  for (const e of env.entries) if (typeof e.seq === 'number' && e.seq > max) max = e.seq
  return max + 1
}

/** 在 reader 分片里 upsert 一个「key 含 needle」的条目；不存在则以 createKey 新建。 */
async function upsertReaderEntry(
  root: string,
  needle: string,
  createKey: string,
  initialValue: unknown,
  mutate: (value: unknown) => unknown
): Promise<{ entryCount: number; sha256: string }> {
  const { env, sha256 } = await updateShard(root, READER_FILE, 'reader', READER_SHARD, (e) => {
    const idx = e.entries.findIndex((x) => typeof x.key === 'string' && String(x.key).includes(needle))
    if (idx >= 0) {
      const cur = e.entries[idx].value
      e.entries[idx] = { ...e.entries[idx], value: mutate(cur ?? initialValue) }
    } else {
      e.entries.push({ seq: nextSeq(e), key: createKey, value: mutate(initialValue) })
    }
    return e
  })
  return { entryCount: env.entries.length, sha256 }
}

/** 把 reader 分片的新状态镜像回 index.shards（entryCount/sha256）并刷新 integrity。 */
async function mirrorReaderShard(
  root: string,
  entryCount: number,
  sha256: string,
  extraMutate?: (idx: Awaited<ReturnType<typeof readIndex>>) => void
): Promise<void> {
  const idx = await readIndex(root)
  const row = idx.shards.find((s) => s.file === READER_FILE)
  if (row) {
    row.entryCount = entryCount
    row.sha256 = sha256
  }
  idx.integrity.lastVerifiedAt = new Date().toISOString()
  extraMutate?.(idx)
  await writeIndex(root, idx)
}

export interface CommitResult {
  /** 生成的图片 entryPath（`<pkgId>/images/<sha>.png`，即 index.assets[].path） */
  entryPath: string
  assetRow: AssetRow
}

/** 把图片字节写入工作库资产区，返回 entryPath + 资产行（同 sha 已存在则复用，不重复写盘）。 */
async function writeImageAsset(root: string, bytes: Buffer): Promise<{ pkgId: string; entryPath: string; row: AssetRow }> {
  const idx = await readIndex(root)
  const sha = sha256Hex(bytes)
  const pkgId = idx.pkgId
  const entryPath = `${pkgId}/images/${sha}.png`
  const row: AssetRow = {
    path: entryPath,
    size: bytes.length,
    sha256: sha,
    store: storePathFor({ path: entryPath, sha256: sha }),
    kind: 'image'
  }
  await writeAsset(root, row, bytes)
  if (!idx.assets.some((a) => a.sha256 === sha)) idx.assets.push(row)
  // 提前写一次 index：后续 reader 镜像会再写（两次原子写，字段互不重叠）
  await writeIndex(root, idx)
  return { pkgId, entryPath, row }
}

/**
 * 回填人物立绘：`<pkgId>:character-images` 条目里
 * `Record<charId, Array<{id?, appearanceId?, imagePath}>>`（格式与真实库实摘一致）。
 * 同形象已有条目 → 原地改指新 entryPath；没有 → 追加一条（id 取随机 UUID，与真实库同形）。
 */
export async function commitCharImage(
  root: string,
  charId: string,
  appearanceId: string,
  bytes: Buffer
): Promise<CommitResult> {
  const { pkgId, entryPath, row } = await writeImageAsset(root, bytes)
  const { entryCount, sha256 } = await upsertReaderEntry(
    root,
    ':character-images',
    `${pkgId}:character-images`,
    {},
    (value) => {
      const map = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
      const arr = Array.isArray(map[charId]) ? [...(map[charId] as Record<string, unknown>[])] : []
      const hit = arr.findIndex((e) => (e?.appearanceId ?? e?.id ?? '') === appearanceId)
      const entry = { id: randomUUID(), appearanceId, imagePath: entryPath }
      if (hit >= 0) arr[hit] = { ...arr[hit], ...entry }
      else arr.push(entry)
      return { ...map, [charId]: arr }
    }
  )
  await mirrorReaderShard(root, entryCount, sha256)
  return { entryPath, assetRow: row }
}

/**
 * 回填场景图：`<pkgId>:<revisionId>:scene-images` 条目
 * `{shared: {}, individual: Record<场景id, entryPath>}`。**sceneId 必须是合并后 id**
 * （调用方负责经 idMap 换算；无映射的原始 id 直写自身 —— 与 view.ts 的直配优先读取对齐）。
 */
export async function commitSceneImage(root: string, sceneId: string, bytes: Buffer): Promise<CommitResult> {
  const { pkgId, entryPath, row } = await writeImageAsset(root, bytes)
  const idx = await readIndex(root)
  const revisionId = idx.origin.revisionId
  const { entryCount, sha256 } = await upsertReaderEntry(
    root,
    ':scene-images',
    `${pkgId}:${revisionId}:scene-images`,
    { shared: {}, individual: {} },
    (value) => {
      const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
      const individual = (v.individual && typeof v.individual === 'object' ? v.individual : {}) as Record<string, string>
      return { ...v, shared: v.shared ?? {}, individual: { ...individual, [sceneId]: entryPath } }
    }
  )
  await mirrorReaderShard(root, entryCount, sha256)
  return { entryPath, assetRow: row }
}

/** 回填地点图标：`<pkgId>:location-icons` 条目 `Record<locationType, entryPath>`（新通道）。 */
export async function commitLocationIcon(root: string, locationType: string, bytes: Buffer): Promise<CommitResult> {
  const { pkgId, entryPath, row } = await writeImageAsset(root, bytes)
  const { entryCount, sha256 } = await upsertReaderEntry(
    root,
    ':location-icons',
    `${pkgId}:location-icons`,
    {},
    (value) => {
      const map = (value && typeof value === 'object' ? value : {}) as Record<string, string>
      return { ...map, [locationType]: entryPath }
    }
  )
  await mirrorReaderShard(root, entryCount, sha256)
  return { entryPath, assetRow: row }
}

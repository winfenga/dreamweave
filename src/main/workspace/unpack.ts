/**
 * `.t2w` → 工作库（解包器，设计 §4.1 / §5.2）。
 *
 * 步骤：
 *   1. `decodeHeader`（core.mjs）拿原始头部 JSON 字节 + manifest；**先做 blob 长度守卫**；
 *   2. 保存 `meta/origin-header.bin`（前 `12 + jsonLen` 字节，未编辑档 golden G1）；
 *   3. 逐 `files[]`（保序）写内容寻址资产；
 *   4. 逐 records 容器写分片（results 按 key 路由、storyScript 按 chunk 分片、副本全量保留）；
 *   5. 写 `index.json`（骨架 + shards + assets + origin）。
 *
 * **无损**：只要分片未被编辑，导出即与来源包逐字节相等（W1）。
 * 格式算法全部复用 `core.mjs`（禁改红线），本文件零魔改。
 *
 * **M0-T5/A1**：blob 区长度守卫（`Σfiles[].size === blobLen`，无尾随字节），**先于任何写盘**；
 * 且写盘阶段异常时清理，**绝不留下半成品工作库**。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { computeOffsets, decodeHeader, sha256Hex } from '../t2w/format'
import type { T2wManifest } from '../../shared/t2w-types'
import { kindOf, storePathFor, writeAsset } from './assets'
import { writeIndex } from './index-store'
import { INDEX_VERSION, INDEX_FILE, ORIGIN_HEADER_REL, WORKSPACE_FORMAT } from './paths'
import { routeContainer, shardNameFor, writeShard } from './shards'
import type {
  AssetRow,
  ContainerKind,
  KeyedEntry,
  ManifestSkeleton,
  OriginInfo,
  ShardEnvelope,
  ShardRow,
  UnpackResult,
  WorkspaceIndex
} from './types'

/** 保真 key：数字 key 保持数字（不强制转字符串），其余转字符串（M0-T5/A2）。 */
function normalizeKey(raw: unknown): string | number {
  return typeof raw === 'number' ? raw : String(raw)
}

/** 把容器节点展开为 `{seq,key,value}` 序列，并报告条目是否为 `{key,value}` 形态。 */
function toSeqEntries(node: unknown): { entries: KeyedEntry[]; keyed: boolean } {
  if (Array.isArray(node)) {
    const keyed =
      node.length === 0 ||
      node.every(
        (it) => it !== null && typeof it === 'object' && 'key' in (it as object) && 'value' in (it as object)
      )
    if (keyed) {
      return {
        entries: node.map((it, i) => {
          const o = it as { key: unknown; value: unknown }
          return { seq: i, key: normalizeKey(o.key), value: o.value }
        }),
        keyed: true
      }
    }
    return { entries: node.map((it, i) => ({ seq: i, key: String(i), value: it })), keyed: false }
  }
  if (node !== null && typeof node === 'object') {
    return {
      entries: Object.entries(node as Record<string, unknown>).map(([key, value], i) => ({
        seq: i,
        key,
        value
      })),
      keyed: false
    }
  }
  return { entries: [], keyed: false }
}

/** 构建容器级骨架（含必要扩展字段 project / containerKeyed）。 */
function buildSkeleton(
  manifest: T2wManifest,
  recordsKeys: string[],
  containers: Record<string, ContainerKind>,
  containerKeyed: Record<string, boolean>
): ManifestSkeleton {
  const knownTop = new Set(['format', 'includesSource', 'project', 'records', 'files'])
  const extra: Record<string, unknown> = {}
  const manifestAsRecord = manifest as unknown as Record<string, unknown>
  for (const k of Object.keys(manifestAsRecord)) {
    if (!knownTop.has(k)) extra[k] = manifestAsRecord[k]
  }
  return {
    includesSource: !!manifest.includesSource,
    topLevelKeys: Object.keys(manifestAsRecord),
    extra,
    recordsKeys,
    containers,
    containerKeyed,
    project: (manifest.project ?? {}) as unknown as Record<string, unknown>
  }
}

/**
 * 写盘阶段（守卫通过后调用）；异常由 `unpack` 统一清理。
 *
 * **不做整目录 rm**：资产为内容寻址（同 sha 即同内容，`writeAsset` 幂等跳过）、分片按名覆盖、
 * `index.json` 由本函数末尾整体重建 → 上一次解包的残留文件不会被索引引用（孤儿文件无害）。
 * 这样既避免「重新导入即整目录删除」的昂贵/危险操作，也让重复解包幂等。
 */
async function writeWorkspace(
  root: string,
  buf: Buffer,
  blobStart: number,
  manifest: T2wManifest,
  originHeader: Buffer,
  blobs: Buffer[],
  t2wPath: string
): Promise<WorkspaceIndex> {
  await mkdir(root, { recursive: true })

  // 资产（严格 files[] 顺序）
  const assets: AssetRow[] = []
  for (let i = 0; i < manifest.files.length; i++) {
    const f = manifest.files[i]
    const row: AssetRow = {
      path: f.path,
      size: f.size,
      sha256: f.sha256,
      store: storePathFor(f),
      kind: kindOf(f.path)
    }
    await writeAsset(root, row, blobs[i])
    assets.push(row)
  }

  // 容器展开 + 骨架
  const recordsNode = (manifest.records ?? {}) as Record<string, unknown>
  const recordsKeys = Object.keys(recordsNode)
  const containers: Record<string, ContainerKind> = {}
  const containerKeyed: Record<string, boolean> = {}
  const containerEntries: Record<string, KeyedEntry[]> = {}
  for (const name of recordsKeys) {
    const { entries, keyed } = toSeqEntries(recordsNode[name])
    containers[name] = Array.isArray(recordsNode[name]) ? 'array' : 'object'
    containerKeyed[name] = keyed
    containerEntries[name] = entries
  }
  const skeleton = buildSkeleton(manifest, recordsKeys, containers, containerKeyed)

  // 分片（results 按 key 路由；同文件条目按 seq 保序）
  const now = new Date().toISOString()
  const shards: ShardRow[] = []
  for (const name of recordsKeys) {
    const groups = new Map<string, ShardEnvelope>()
    for (const e of containerEntries[name]) {
      // 路由用字符串形式；信封内保留 e.key 原类型（A2）
      const file = routeContainer(name, String(e.key), e.value)
      let env = groups.get(file)
      if (!env) {
        env = { shard: shardNameFor(file), container: name, entries: [] }
        groups.set(file, env)
      }
      env.entries.push(e)
    }
    for (const file of [...groups.keys()].sort()) {
      const env = groups.get(file) as ShardEnvelope
      const sha = await writeShard(root, file, env)
      shards.push({ name: env.shard, file, container: name, entryCount: env.entries.length, sha256: sha })
    }
  }

  // origin-header.bin（未编辑档 golden G1）
  const headerAbs = join(root, ORIGIN_HEADER_REL)
  await mkdir(dirname(headerAbs), { recursive: true })
  await writeFile(headerAbs, originHeader)

  const project = (manifest.project ?? {}) as Record<string, unknown>
  const pkgId = String(project.id ?? project.revisionId ?? 'unknown')
  const origin: OriginInfo = {
    t2wPath,
    t2wSize: buf.length,
    t2wSha256: sha256Hex(buf),
    manifestJsonSha256: sha256Hex(buf.subarray(12, blobStart)),
    hasOriginHeader: true,
    projectId: String(project.id ?? ''),
    revisionId: String(project.revisionId ?? ''),
    createdAt: now
  }

  const index: WorkspaceIndex = {
    indexVersion: INDEX_VERSION,
    format: WORKSPACE_FORMAT,
    pkgId,
    title: String(project.title ?? pkgId),
    origin,
    manifest: skeleton,
    shards,
    assets,
    tasks: {},
    integrity: { createdAt: now, lastVerifiedAt: null }
  }

  await writeIndex(root, index)
  return index
}

/**
 * 解包：`.t2w` 绝对路径 → 工作库根目录。
 * 采用**全量重写**（分片按名覆盖 + 资产内容寻址 + index 整体重建），**不做整目录删除**；
 * 上一次解包的残留文件不被新索引引用（孤儿文件无害）。「复用 / 增量」策略属 M8。
 */
export async function unpack(t2wPath: string, root: string): Promise<UnpackResult> {
  const buf = await readFile(t2wPath)
  const { blobStart, manifest } = decodeHeader(buf)

  // 【M0-T5/A1】blob 区长度守卫：先于任何写盘 → 截断/尾随字节必抛可读错、不落半成品工作库
  const sumSize = manifest.files.reduce((s, f) => s + f.size, 0)
  const blobLen = buf.length - blobStart
  if (sumSize !== blobLen) {
    throw new Error(
      `包 blob 区长度不符（可能被截断或含尾随字节）：Σ(files[].size)=${sumSize}，blobLen=${blobLen}，差 ${blobLen - sumSize}`
    )
  }

  const originHeader = Buffer.from(buf.subarray(0, blobStart))
  const offsets = computeOffsets(manifest.files, blobStart)
  const blobs = manifest.files.map((f, i) => Buffer.from(buf.subarray(offsets[i], offsets[i] + f.size)))

  try {
    const index = await writeWorkspace(root, buf, blobStart, manifest, originHeader, blobs, t2wPath)
    return { index, sourceBytes: buf.length }
  } catch (e) {
    // 失败清理：只删 index.json（单文件删除），使工作库落到「无有效索引」的**可读**状态，
    // 绝不留下一个"看似可用"的半成品工作库（分片/资产残留不会被任何索引引用）。
    await rm(join(root, INDEX_FILE), { force: true }).catch(() => undefined)
    throw e
  }
}

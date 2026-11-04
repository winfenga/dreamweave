/**
 * 工作库 → `.t2w`（打包器，双档导出，设计 §4.2 / §5.2 / D7）。
 *
 * **未编辑判定（修正版，自洽）**：不用「分片 sha256 == index 记录」（写回会更新 index，无法区分），
 * 而是**重建 manifest 后用 `encodePackage` 生成的头部字节与 `meta/origin-header.bin` 逐字节比对**：
 * 相等且全部资产字节 sha256 未变 → 未编辑 → 导出走 `concat(origin-header, blobs)`（G1，逐字节相等）；
 * 否则 → 已编辑 → 导出走 `encodePackage`（G2，成员级 sha256 全等、records 深等）。
 *
 * （M0-T0 实测 8 包 `encodePackage(parse(origJson))` 亦逐字节相等；仍保留 origin-header 作防御纵深。）
 *
 * **C2 一键导出**：本模块新增 `packWorkspace()` —— 面向 IPC 的门面（**不抛裸异常**，
 * 一律返回 `{ok,path,bytes,error}`）。它在 `pack()` 的双档导出之上补三件事：
 *  1. **缺分片容错**：分片文件读不到 → 跳过并记 warning（**绝不静默丢**），导出继续；
 *  2. **blob 字节区间重算**：`byteStart/byteEnd` 一律按**实际写出的字节**重新推算
 *     （= `12 + jsonLen` + Σ 前序 `size`），绝不沿用来源包里的旧偏移，并逐段 sha256 校验；
 *  3. **原子写**：tmp → 读回复检 → rename（失败删 tmp，目标路径不留半截文件）。
 *
 * 与导入侧（`unpack.ts`）严格互逆：导入按 `files[]` 顺序累加 `size` 切 blob，
 * 导出就按同一顺序紧密拼接并回填 `size`/`sha256`（格式算法全部在 `core.mjs`，禁改红线）。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { HEADER_SIZE, computeOffsets, encodePackage, sha256Hex } from '../t2w/format'
import { readIndex } from './index-store'
import { assembleManifest } from './manifest-assembler'
import { ORIGIN_HEADER_REL } from './paths'
import type { PackDetailResult, WorkspaceIndex } from './types'
import type { AssetRow } from '../../shared/workspace-types'
import type { T2wFileEntry, T2wManifest } from '../../shared/t2w-types'

/** 导出侧结果（IPC 门面形状：一律 `ok`，失败给可读 `error`，**不抛**）。 */
export interface PackResult {
  ok: boolean
  /** 成功时的导出绝对路径 */
  path?: string
  /** 导出文件字节数 */
  bytes?: number
  /** 失败原因（可读中文） */
  error?: string
  /** 非致命问题（缺分片 / 缺资产）；**不静默丢** —— 一律登记在此 */
  warnings?: string[]
  /** 导出字节是否与来源包逐字节相等（= sha256 == origin.t2wSha256） */
  byteExact?: boolean
  /** 是否判定为「未编辑」（走了 origin-header 拼接路径） */
  unedited?: boolean
  /** 未编辑档是否走了 origin-header 拼接路径（G1） */
  usedOriginHeader?: boolean
  /** 每个 blob 成员**重算后**的字节区间（导入侧按它切分即可取回原字节） */
  files?: PackFileSpan[]
}

/** 单个 blob 成员在导出包中的字节区间。 */
export interface PackFileSpan {
  /** 包内逻辑路径（files[].path 原样） */
  path: string
  size: number
  sha256: string
  /** 在**导出包**内的起始偏移（= 12 + jsonLen + Σ 前序 size） */
  byteStart: number
  /** 半开区间右端 */
  byteEnd: number
}

/** 重建 manifest 的编码头部是否与来源头部逐字节相等（= 未编辑）。 */
function headerMatchesOrigin(encoded: Buffer, originHeader: Buffer): boolean {
  if (encoded.length < HEADER_SIZE || originHeader.length < HEADER_SIZE) return false
  const reJsonLen = encoded.readUInt32BE(8)
  const reHeader = encoded.subarray(0, HEADER_SIZE + reJsonLen)
  return reHeader.length === originHeader.length && reHeader.equals(originHeader)
}

/**
 * 判定工作库是否「未编辑」：重建头部 == 来源头部 **且** 全部资产字节 sha256 未变。
 * （供 registry/verify 复用；pack 内部已就计算好的 manifest/blobs 复用私有实现。）
 */
export async function isUnedited(root: string, idx: WorkspaceIndex): Promise<boolean> {
  const manifest = await assembleManifest(root, idx)
  const blobs: Buffer[] = []
  for (const a of idx.assets) blobs.push(Buffer.from(await readFile(join(root, a.store))))
  const encoded = encodePackage(manifest, blobs)
  const originHeader = idx.origin.hasOriginHeader ? await readFile(join(root, ORIGIN_HEADER_REL)) : null
  const blobsOk = blobs.every((b, i) => sha256Hex(b) === idx.assets[i].sha256)
  return !!originHeader && blobsOk && headerMatchesOrigin(encoded, originHeader)
}

function decideOutput(
  manifest: T2wManifest,
  blobs: Buffer[],
  originHeader: Buffer | null,
  blobsOk: boolean
): { out: Buffer; usedOriginHeader: boolean } {
  const encoded = encodePackage(manifest, blobs)
  const unedited = !!originHeader && blobsOk && headerMatchesOrigin(encoded, originHeader)
  if (unedited && originHeader) {
    return { out: Buffer.concat([originHeader, ...blobs]), usedOriginHeader: true }
  }
  return { out: encoded, usedOriginHeader: false }
}

/**
 * 按**实际写出的包字节**重算每个成员的 blob 区间。
 *
 * `.t2w` 布局里 `files[]` 不存 offset（导入侧 `core.mjs.computeOffsets` 也是累加推算），
 * 因此偏移完全由 `jsonLen` 与 `size` 前缀和决定 —— 导出必须按本次写出的 jsonLen 重算，
 * **沿用来源包偏移是错的**（一旦 records 被编辑过，jsonLen 就变了）。
 */
function computeSpans(files: T2wFileEntry[], blobStart: number): PackFileSpan[] {
  const offsets = computeOffsets(files, blobStart)
  return files.map((f, i) => ({
    path: f.path,
    size: f.size,
    sha256: f.sha256,
    byteStart: offsets[i],
    byteEnd: offsets[i] + f.size
  }))
}

/**
 * 导出包自校验：与导入侧 `unpack` 的守卫同构（Σsize == blobLen、无尾随字节），
 * 再按重算出的 `byteStart/byteEnd` 逐段切字节验 sha256 —— 偏移写错在这里就会被抓住。
 */
function guardSpans(out: Buffer, spans: PackFileSpan[]): string | null {
  if (spans.length === 0) return null
  const blobStart = spans[0].byteStart
  const blobLen = out.length - blobStart
  if (blobLen < 0) {
    return `导出包自校验失败：blob 起始偏移 ${blobStart} 超出文件长度 ${out.length}`
  }
  const sumSize = spans.reduce((s, x) => s + x.size, 0)
  if (sumSize !== blobLen) {
    return `导出包自校验失败：Σfiles[].size=${sumSize} 与 blob 区长度 ${blobLen} 不符（差 ${blobLen - sumSize}）`
  }
  const last = spans[spans.length - 1]
  if (last.byteEnd !== out.length) {
    return `导出包自校验失败：末成员 byteEnd=${last.byteEnd} 与文件长度 ${out.length} 不符（存在尾随字节）`
  }
  for (const s of spans) {
    if (s.byteStart < blobStart || s.byteEnd > out.length) {
      return `导出包自校验失败：${s.path} 的区间 [${s.byteStart},${s.byteEnd}) 越界`
    }
    const actual = sha256Hex(out.subarray(s.byteStart, s.byteEnd))
    if (actual !== s.sha256) {
      return `导出包自校验失败：${s.path} 按 byteStart/byteEnd 切出的字节 sha256 与清单不符`
    }
  }
  return null
}

/** 原子写：tmp → 读回复检 → rename；任一环节失败删 tmp，目标路径不留半截文件。 */
async function writeAtomic(outPath: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true })
  const tmp = `${outPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  try {
    await writeFile(tmp, bytes)
    const back = await readFile(tmp)
    if (back.length !== bytes.length || !back.equals(bytes)) {
      throw new Error(`导出文件复检失败（tmp 读回不符）：${outPath}`)
    }
    await rename(tmp, outPath)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}

/** 打包：工作库 → `.t2w`；返回 `byteExact` 判定（= 导出 sha256 == 来源包 sha256）。 */
export async function pack(root: string, outPath: string): Promise<PackDetailResult> {
  const idx = await readIndex(root)
  const manifest = await assembleManifest(root, idx)

  const blobs: Buffer[] = []
  for (const a of idx.assets) {
    blobs.push(Buffer.from(await readFile(join(root, a.store))))
  }

  const originHeader = idx.origin.hasOriginHeader ? await readFile(join(root, ORIGIN_HEADER_REL)) : null
  const blobsOk = blobs.every((b, i) => sha256Hex(b) === idx.assets[i].sha256)
  const { out, usedOriginHeader } = decideOutput(manifest, blobs, originHeader, blobsOk)

  await writeAtomic(outPath, out)
  const sha = sha256Hex(out)
  return {
    outPath,
    bytes: out.length,
    sha256: sha,
    byteExact: sha === idx.origin.t2wSha256,
    unedited: usedOriginHeader,
    usedOriginHeader
  }
}

/**
 * **一键导出门面（C2）**：工作库 → `.t2w`，供 IPC 直接调用。
 *
 * 与 `pack()` 的区别（后者是底层实现，仍被 M0 验证脚本使用）：
 *  - **不抛裸异常**：任何失败都收敛成 `{ok:false, error}`，IPC 层无需 try/catch 兜底；
 *  - **缺分片/缺资产容错**：跳过并记 `warnings`（不静默丢）；
 *  - **返回重算后的 blob 区间** `files[]`（`byteStart/byteEnd`，供验证与排查）；
 *  - 走**原子写**（tmp + 复检 + rename），失败不留半截文件。
 *
 * @param root 工作库根目录（含 index.json）
 * @param outPath 导出目标绝对路径
 */
export async function packWorkspace(root: string, outPath: string): Promise<PackResult> {
  const warnings: string[] = []
  try {
    if (typeof root !== 'string' || root.length === 0) {
      return { ok: false, error: '工作库路径为空', warnings }
    }
    if (typeof outPath !== 'string' || outPath.length === 0) {
      return { ok: false, error: '导出路径为空', warnings }
    }

    const idx = await readIndex(root)

    // records：缺分片 → 跳过并登记（导出继续，绝不静默丢）
    const manifest = await assembleManifest(root, idx, {
      onMissingShard: (file) => {
        warnings.push(`分片缺失，导出时已跳过：${file}`)
      }
    })

    // 资产：逐行读字节；读不到 → 跳过并登记。
    // `files[]` 的 size/sha256 一律按**磁盘实际字节**重算，不沿用索引里可能过期的登记值。
    const kept: AssetRow[] = []
    const blobs: Buffer[] = []
    for (const a of idx.assets) {
      try {
        blobs.push(Buffer.from(await readFile(join(root, a.store))))
        kept.push(a)
      } catch {
        warnings.push(`资产缺失，导出时已跳过：${a.path}（${a.store}）`)
      }
    }
    manifest.files = kept.map((a, i) => ({
      path: a.path,
      size: blobs[i].length,
      sha256: sha256Hex(blobs[i])
    }))

    // 未编辑档走 origin-header 拼接（G1，与来源包逐字节相等）；已编辑走 encodePackage（G2）
    const originHeader = idx.origin.hasOriginHeader
      ? await readFile(join(root, ORIGIN_HEADER_REL)).catch(() => null)
      : null
    const blobsOk = blobs.every((b, i) => sha256Hex(b) === kept[i].sha256)
    const { out, usedOriginHeader } = decideOutput(manifest, blobs, originHeader, blobsOk)

    // —— blob 字节区间重算 —— 以实际写出的 jsonLen 为准（core.mjs：偏移 = 12 + jsonLen + Σ前序 size）
    const jsonLen = out.readUInt32BE(8)
    const spans = computeSpans(manifest.files, HEADER_SIZE + jsonLen)
    const guardError = guardSpans(out, spans)
    if (guardError) {
      return { ok: false, error: guardError, warnings }
    }

    await writeAtomic(outPath, out)

    return {
      ok: true,
      path: outPath,
      bytes: out.length,
      warnings,
      byteExact: sha256Hex(out) === idx.origin.t2wSha256,
      unedited: usedOriginHeader,
      usedOriginHeader,
      files: spans
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message, warnings }
  }
}

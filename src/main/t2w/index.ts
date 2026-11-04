import { readFile, stat, writeFile } from 'node:fs/promises'
import type { T2wFileEntry, T2wPackage, T2wVerifiedEntry } from '../../shared/t2w-types'
import { computeOffsets, decodeHeader, encodePackage, sha256Hex } from './format'

/**
 * 读取并校验一个 .t2w 包。
 * - 完整性守卫 #1：Σ files[i].size === 文件总长 - (12 + jsonLen)
 * - 完整性守卫 #2：blobStart + Σ size === 总长（无尾随字节）
 * - 成员级：逐段切片计算 sha256，与 files[i].sha256 比对
 */
/** 单包缓存：避免图片预览时反复读取整包（样本包可达 ~80MB） */
let cache: { path: string; buf: Buffer } | null = null

export async function readPackage(filePath: string): Promise<T2wPackage> {
  const buf = await readFile(filePath)
  cache = { path: filePath, buf }
  const header = decodeHeader(buf)
  const { manifest, blobStart, jsonLen } = header
  const files = manifest.files
  const totalSize = buf.length

  const offsets = computeOffsets(files, blobStart)
  const sumSize = files.reduce((s, f) => s + f.size, 0)

  // 完整性守卫：仅在可选开启时抛错，这里以 verifySummary 记录而非中断读取
  const guardSumOk = sumSize === totalSize - blobStart
  const guardTailOk = blobStart + sumSize === totalSize

  const entries: T2wVerifiedEntry[] = files.map((f: T2wFileEntry, i: number) => {
    const offset = offsets[i]
    const chunk = buf.subarray(offset, offset + f.size)
    const actualSha256 = sha256Hex(chunk)
    return {
      path: f.path,
      size: f.size,
      sha256: f.sha256,
      offset,
      actualSha256,
      ok: actualSha256 === f.sha256
    }
  })

  const passed = entries.filter((e) => e.ok).length
  return {
    filePath,
    totalSize,
    jsonLen,
    blobStart,
    manifest,
    entries,
    verifySummary: {
      total: entries.length,
      passed,
      failed: entries.length - passed
    },
    guards: { sumSizeMatches: guardSumOk, noTrailingBytes: guardTailOk }
  }
}

/** 只读单个成员字节（用于图片预览等） */
export async function readEntry(filePath: string, entryPath: string): Promise<Buffer> {
  const buf = cache && cache.path === filePath ? cache.buf : await readFile(filePath)
  const header = decodeHeader(buf)
  const offsets = computeOffsets(header.manifest.files, header.blobStart)
  const idx = header.manifest.files.findIndex((f) => f.path === entryPath)
  if (idx < 0) throw new Error(`包内不存在成员：${entryPath}`)
  const f = header.manifest.files[idx]
  return buf.subarray(offsets[idx], offsets[idx] + f.size)
}

export interface WritePackageOptions {
  manifest: import('../../shared/t2w-types').T2wManifest
  blobs: Buffer[]
}

/** 写出 .t2w 包（重新计算 sha256 并回填 files[]） */
export async function writePackage(outPath: string, opts: WritePackageOptions): Promise<number> {
  const buf = encodePackage(opts.manifest, opts.blobs)
  await writeFile(outPath, buf)
  return buf.length
}

export async function statSize(filePath: string): Promise<number> {
  const s = await stat(filePath)
  return s.size
}

export { decodeHeader, encodePackage, computeOffsets, sha256Hex }

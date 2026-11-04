/**
 * .t2w 容器格式核心实现（纯 ESM，仅依赖 node 内置模块）
 *
 * 单一事实源：应用主进程（src/main/t2w/format.ts）与验证脚本（scripts/verify-t2w.mjs）
 * 都直接 import 本文件，避免算法在两处各写一份。
 *
 * 字节布局（txt2world-package-v1）：
 *   [ 8B] magic    = ASCII "T2WPKG1\n"
 *   [ 4B] jsonLen  = 大端 uint32，其后 JSON 的 UTF-8 字节长度
 *   [ N B] manifest= UTF-8 JSON
 *   [  M] blob     = 按 files[] 顺序紧密拼接的二进制段（无 offset，按 size 累加推算）
 */
import { createHash } from 'node:crypto'

export const MAGIC_STR = 'T2WPKG1\n'
export const MAGIC_BYTES = [0x54, 0x32, 0x57, 0x50, 0x4b, 0x47, 0x31, 0x0a]
export const FORMAT = 'txt2world-package-v1'
export const HEADER_SIZE = 12

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/** 前 8 字节必须为 "T2WPKG1\n" */
export function checkMagic(buf) {
  if (buf.length < 8) return false
  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (buf[i] !== MAGIC_BYTES[i]) return false
  }
  return true
}

/** 大端 uint32（注意：不是小端） */
export function readUInt32BE(buf, offset) {
  return buf.readUInt32BE(offset)
}

export function writeUInt32BE(value) {
  const b = Buffer.allocUnsafe(4)
  b.writeUInt32BE(value >>> 0, 0)
  return b
}

/** 解析头部与清单（不切分 blob）。任意结构不符即抛错。 */
export function decodeHeader(buf) {
  if (buf.length < HEADER_SIZE) {
    throw new Error(`文件过小：${buf.length} 字节，不足 12 字节头部`)
  }
  if (!checkMagic(buf)) {
    throw new Error('magic 不匹配：期望 "T2WPKG1\\n"')
  }
  const jsonLen = readUInt32BE(buf, 8)
  const blobStart = HEADER_SIZE + jsonLen
  if (blobStart > buf.length) {
    throw new Error(`清单长度越界：jsonLen=${jsonLen}，文件仅 ${buf.length} 字节`)
  }
  const manifestRaw = buf.subarray(HEADER_SIZE, blobStart)
  let manifest
  try {
    manifest = JSON.parse(manifestRaw.toString('utf8'))
  } catch (e) {
    throw new Error(`清单 JSON 解析失败：${e.message}`)
  }
  if (manifest.format !== FORMAT) {
    throw new Error(`format 不符：期望 "${FORMAT}"，实际 "${String(manifest.format)}"`)
  }
  if (!Array.isArray(manifest.files)) {
    throw new Error('清单缺少 files[] 数组')
  }
  return { jsonLen, blobStart, manifestRaw, manifest }
}

/** 按 files[] 顺序累加 size 推算每个成员的 offset */
export function computeOffsets(files, blobStart) {
  const offsets = []
  let off = blobStart
  for (const f of files) {
    offsets.push(off)
    off += f.size
  }
  return offsets
}

/**
 * 组装 .t2w 包字节。会按 blobs 重新计算 sha256 并回写 manifest.files[i].sha256，
 * 保证「写出即自洽」。
 */
export function encodePackage(manifest, blobs) {
  if (manifest.files.length !== blobs.length) {
    throw new Error(`files 数量(${manifest.files.length})与 blobs 数量(${blobs.length})不一致`)
  }
  const files = manifest.files.map((f, i) => ({
    path: f.path,
    size: blobs[i].length,
    sha256: sha256Hex(blobs[i])
  }))
  const jsonRaw = Buffer.from(JSON.stringify({ ...manifest, format: FORMAT, files }), 'utf8')
  const head = Buffer.allocUnsafe(HEADER_SIZE)
  Buffer.from(MAGIC_STR, 'ascii').copy(head, 0)
  head.writeUInt32BE(jsonRaw.length, 8)
  return Buffer.concat([head, jsonRaw, ...blobs])
}

/**
 * 类型化门面：把 core.mjs（格式核心实现）暴露为强类型 API。
 * 算法本体在 core.mjs，主进程与验证脚本共用同一份实现。
 */
import type { T2wFileEntry, T2wManifest } from '../../shared/t2w-types'
import {
  HEADER_SIZE,
  MAGIC_STR,
  checkMagic,
  computeOffsets,
  decodeHeader as coreDecodeHeader,
  encodePackage as coreEncodePackage,
  readUInt32BE,
  sha256Hex,
  writeUInt32BE,
  type DecodedHeader
} from './core.mjs'

export { HEADER_SIZE, MAGIC_STR, checkMagic, computeOffsets, readUInt32BE, sha256Hex, writeUInt32BE }
export type { DecodedHeader }

/** 解析头部与清单（不切分 blob）。 */
export function decodeHeader(buf: Buffer): DecodedHeader {
  return coreDecodeHeader(buf)
}

/** 组装 .t2w 包字节（重算并回填 sha256）。 */
export function encodePackage(manifest: T2wManifest, blobs: Buffer[]): Buffer {
  return coreEncodePackage(manifest, blobs)
}

export type { T2wFileEntry, T2wManifest }

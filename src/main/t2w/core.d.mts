import type { T2wFileEntry, T2wManifest } from '../../shared/t2w-types'

export declare const MAGIC_STR: 'T2WPKG1\n'
export declare const MAGIC_BYTES: readonly number[]
export declare const FORMAT: 'txt2world-package-v1'
export declare const HEADER_SIZE: 12

export declare function sha256Hex(buf: Buffer): string
export declare function checkMagic(buf: Buffer): boolean
export declare function readUInt32BE(buf: Buffer, offset: number): number
export declare function writeUInt32BE(value: number): Buffer

export interface DecodedHeader {
  jsonLen: number
  blobStart: number
  manifestRaw: Buffer
  manifest: T2wManifest
}

export declare function decodeHeader(buf: Buffer): DecodedHeader
export declare function computeOffsets(files: T2wFileEntry[], blobStart: number): number[]
export declare function encodePackage(manifest: T2wManifest, blobs: Buffer[]): Buffer

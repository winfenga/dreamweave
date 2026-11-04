/**
 * .t2w 包容器格式（txt2world-package-v1）—— 共享类型定义
 *
 * 字节布局（见 recon/格式规范_t2w.md）：
 *   [ 8B] magic   = ASCII "T2WPKG1\n"  (54 32 57 50 4b 47 31 0a)
 *   [ 4B] jsonLen = 大端 uint32，其后 JSON 的 UTF-8 字节长度
 *   [ N B] manifest= UTF-8 JSON（format / includesSource / project / records / files）
 *   [  M] blob    = 二进制段，按 files[] 顺序零填充紧密拼接（无 offset，需按 size 累加）
 */

export const T2W_MAGIC = 'T2WPKG1\n'
export const T2W_MAGIC_BYTES = [0x54, 0x32, 0x57, 0x50, 0x4b, 0x47, 0x31, 0x0a] as const
export const T2W_FORMAT = 'txt2world-package-v1'
export const T2W_HEADER_SIZE = 12 // 8 magic + 4 jsonLen

/** files[] 元素：恰好 3 个键，无 offset（偏移由 size 前缀和推算） */
export interface T2wFileEntry {
  path: string
  size: number
  sha256: string
}

export interface T2wProject {
  id: string
  title: string
  revisionId: string
  chapterCount: number
  charCount: number
  encoding?: string
  status?: string
  updatedAt?: string
  createdAt?: string
  [key: string]: unknown
}

export interface T2wManifest {
  format: string
  includesSource: boolean
  project: T2wProject
  records: Record<string, unknown>
  files: T2wFileEntry[]
}

/** 单成员切片 + sha256 校验结果 */
export interface T2wVerifiedEntry extends T2wFileEntry {
  /** 计算出的起始偏移 = 12 + jsonLen + Σ 前序 size */
  offset: number
  /** 实际读出的字节 sha256 */
  actualSha256: string
  ok: boolean
}

export interface T2wPackage {
  filePath: string
  totalSize: number
  jsonLen: number
  blobStart: number
  manifest: T2wManifest
  entries: T2wVerifiedEntry[]
  verifySummary: { total: number; passed: number; failed: number }
  /** 容器级完整性守卫 */
  guards: { sumSizeMatches: boolean; noTrailingBytes: boolean }
}

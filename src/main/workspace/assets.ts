/**
 * 内容寻址资产读写 + `entryPath → store` 映射 + 完整性校验（设计 §3.3 / §5.2 / §9）。
 *
 * - 物理位置：`assets/<kind>/<sha256><ext>`（天然去重 + 完整性强校验，A-P0-3）；
 * - `entryPath`（包内逻辑路径）**原样保留**，映射由索引资产表 `store` 决定；
 * - 一切读取**显式 `Buffer.from()` 拷贝**（`subarray` 是视图，踩过坑）。
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { ASSETS_DIR } from './paths'
import { readIndex } from './index-store'
import type { AssetKind, AssetRow, WorkspaceIndex } from './types'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.svg'])
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.opus', '.mp4'])

/** 由 entryPath 推断资产类别。 */
export function kindOf(entryPath: string): AssetKind {
  const ext = extname(entryPath).toLowerCase()
  if (IMAGE_EXT.has(ext)) return 'image'
  if (AUDIO_EXT.has(ext)) return 'audio'
  if (entryPath.startsWith('source/') || ext === '.bin' || ext === '.txt') return 'source'
  return 'other'
}

/** 内容寻址 store 相对路径。 */
export function storePathFor(entry: { path: string; sha256: string }): string {
  const kind = kindOf(entry.path)
  const ext = extname(entry.path).toLowerCase()
  return `${ASSETS_DIR}/${kind}/${entry.sha256}${ext}`
}

/** 写入单个资产（同 store 已存在即视为已写——内容寻址保证内容相同）。 */
export async function writeAsset(root: string, entry: AssetRow, bytes: Buffer): Promise<void> {
  const abs = join(root, entry.store)
  try {
    await stat(abs)
    return
  } catch {
    /* 不存在 → 写 */
  }
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, bytes)
}

/** 解析 entryPath → 工作库内绝对 store 路径；不存在返回 null。 */
export function resolveStorePath(
  root: string,
  idx: WorkspaceIndex,
  entryPath: string
): string | null {
  const row = idx.assets.find((a) => a.path === entryPath)
  return row ? join(root, row.store) : null
}

/** 按 entryPath 读取资产字节（显式拷贝）。 */
export async function readAsset(root: string, entryPath: string): Promise<Buffer> {
  const idx = await readIndex(root)
  const abs = resolveStorePath(root, idx, entryPath)
  if (!abs) throw new Error(`资产不存在于工作库：${entryPath}`)
  return Buffer.from(await readFile(abs))
}

/** 直接按 store 相对路径读取资产字节（导出打包走这条，保 files[] 顺序）。 */
export async function readAssetBytes(root: string, store: string): Promise<Buffer> {
  return Buffer.from(await readFile(join(root, store)))
}

/**
 * 当前打开的 .t2w 包会话。
 *
 * 只做「记住当前包 + 生成稳定的 assetKey」，不参与格式解析。
 * 图片走自定义协议时需要靠它定位到具体包（见 asset-protocol.ts）。
 */
import { createHash } from 'node:crypto'
import type { T2wPackage } from '../shared/t2w-types'

export interface PackageSession {
  filePath: string
  pkg: T2wPackage
  /** 用于 t2w://<assetKey>/<entryPath> 的稳定短标识 */
  assetKey: string
  /** "t2w://<assetKey>/" */
  assetBase: string
}

let current: PackageSession | null = null

export function setSession(pkg: T2wPackage): PackageSession {
  const assetKey = createHash('sha256').update(pkg.filePath, 'utf8').digest('hex').slice(0, 16)
  current = { filePath: pkg.filePath, pkg, assetKey, assetBase: `t2w://${assetKey}/` }
  return current
}

export function getSession(): PackageSession | null {
  return current
}

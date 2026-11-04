/**
 * 工作库会话（设计 §3.4 / §9；**取代** 旧 `src/main/session.ts`）。
 *
 * 只做「记住当前工作库 + 生成稳定的 assetKey」，不参与格式解析。
 * 图片/音频走 `dwe://<assetKey>/<entryPath>` 时靠它定位到工作库根 + 索引 + 资产表。
 */
import { createHash } from 'node:crypto'
import type { WorkspaceIndex } from './types'

export interface WorkspaceSession {
  pkgId: string
  root: string
  /** `dwe://<assetKey>/` 的短标识 */
  assetKey: string
  /** "dwe://<assetKey>/" */
  assetBase: string
  index: WorkspaceIndex
}

let current: WorkspaceSession | null = null

/** `assetKey = sha256(pkgId + 来源整包 sha256)` 前 16 位（同内容稳定，天然避免串包；§9）。 */
export function assetKeyFor(pkgId: string, t2wSha256: string): string {
  return createHash('sha256').update(`${pkgId}\u0000${t2wSha256}`, 'utf8').digest('hex').slice(0, 16)
}

/** 由工作库根 + 索引构造会话（assetKey/assetBase 派生自 pkgId + 来源指纹）。 */
export function makeSession(root: string, index: WorkspaceIndex): WorkspaceSession {
  const assetKey = assetKeyFor(index.pkgId, index.origin.t2wSha256)
  return { pkgId: index.pkgId, root, assetKey, assetBase: `dwe://${assetKey}/`, index }
}

export function setWorkspaceSession(session: WorkspaceSession): WorkspaceSession {
  current = session
  return current
}

export function getWorkspaceSession(): WorkspaceSession | null {
  return current
}

export function clearWorkspaceSession(): void {
  current = null
}

/** 写回后索引变更（如 shards[].sha256）时刷新会话内的 index 引用。 */
export function refreshSessionIndex(index: WorkspaceIndex): void {
  if (current && current.pkgId === index.pkgId) {
    current = { ...current, index }
  }
}

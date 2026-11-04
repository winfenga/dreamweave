/**
 * 分片 → 内存 `T2wManifest`（供 view/summary/导出共用，设计 §1.2 / §5.2）。
 *
 * 输出与今日**完全同形**的 `records`（只换数据来源，不换解析算法 → A-P0-8 回归面最小）。
 */
import { T2W_FORMAT } from '../../shared/t2w-types'
import type { T2wFileEntry, T2wManifest } from '../../shared/t2w-types'
import { rebuildContainer } from './shards'
import type { WorkspaceIndex } from './types'

/**
 * 装配选项（C2：导出侧需要「缺分片不炸」的容错装配）。
 *
 * 只有导出关心它 —— 导入/视图/摘要一律不传，保持「缺分片即抛」的原行为。
 */
export interface AssembleOptions {
  /**
   * 分片文件读不到（缺失/损坏）时的回调：回调返回后**跳过该分片继续装配**。
   * 不传 → 原样抛错（绝不让上层拿到一个悄悄少了内容的 manifest）。
   */
  onMissingShard?: (file: string, err: Error) => void
}

/**
 * 装配完整 manifest：records 从分片重建，files 从资产表重建（保序），顶层键序还原。
 *
 * @param opts.onMissingShard 传入后，缺失/损坏的分片被跳过并回调通知（导出容错用，C2）。
 */
export async function assembleManifest(
  root: string,
  idx: WorkspaceIndex,
  opts: AssembleOptions = {}
): Promise<T2wManifest> {
  const records: Record<string, unknown> = {}
  for (const name of idx.manifest.recordsKeys) {
    records[name] = await rebuildContainer(root, idx, name, opts.onMissingShard)
  }

  const files: T2wFileEntry[] = idx.assets.map((a) => ({
    path: a.path,
    size: a.size,
    sha256: a.sha256
  }))

  const known: Record<string, unknown> = {
    format: T2W_FORMAT,
    includesSource: idx.manifest.includesSource,
    project: idx.manifest.project,
    records,
    files
  }

  const out: Record<string, unknown> = {}
  for (const key of idx.manifest.topLevelKeys) {
    out[key] = Object.prototype.hasOwnProperty.call(known, key) ? known[key] : idx.manifest.extra[key]
  }
  // 向前兼容：骨架未预期但在 extra 里的顶层键也补回
  for (const [key, value] of Object.entries(idx.manifest.extra)) {
    if (!(key in out)) out[key] = value
  }
  return out as unknown as T2wManifest
}

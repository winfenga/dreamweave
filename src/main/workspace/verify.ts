/**
 * 工作库自检：index ↔ 分片 ↔ 资产 三方一致性（设计 §2.1 / A-P1-3 / W8）。
 *
 * 返回**具体缺失/不符项**列表；空数组表示一致。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sha256Hex } from '../t2w/format'
import type { WorkspaceIndex } from './types'

/** 校验每个分片文件与每个资产文件的存在性与 sha256；返回问题清单。 */
export async function verifyWorkspace(root: string, idx: WorkspaceIndex): Promise<string[]> {
  const issues: string[] = []

  for (const s of idx.shards) {
    try {
      const bytes = await readFile(join(root, s.file))
      if (sha256Hex(bytes) !== s.sha256) {
        issues.push(`分片校验失败（sha256 不符）：${s.file}`)
      }
    } catch {
      issues.push(`分片缺失：${s.file}`)
    }
  }

  for (const a of idx.assets) {
    try {
      const bytes = await readFile(join(root, a.store))
      if (sha256Hex(bytes) !== a.sha256) {
        issues.push(`资产校验失败（sha256 不符）：${a.path}`)
      }
    } catch {
      issues.push(`资产缺失：${a.path}`)
    }
  }

  return issues
}

/**
 * 工作库自检：index ↔ 分片 ↔ 资产 三方一致性（设计 §2.1 / A-P1-3 / W8）。
 *
 * 返回**具体缺失/不符项**列表；空数组表示一致。
 */
import { readFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { sha256Hex } from '../t2w/format'
import { updateIndex } from './index-store'
import { readShard, shardNameFor } from './shards'
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

/** 需要扫描分片的顶层目录（与 `paths.ts` 的分片落点一致）。 */
const SHARD_DIRS = ['records', 'script', 'world'] as const

/**
 * **索引自愈**：把磁盘上存在、但 `index.shards[]` 里没登记的分片补登记进去。
 *
 * 为什么需要：`updateShard` 历史上只写分片文件、不登记索引（已修），
 * 所以**修复前跑过解析的工作库**都是「产物在、索引缺行」的状态。
 * 这类库的症状是：所有聚合型任务（worldImpression / locationTree /
 * characterAppearance …）报「工作库中没有任何 <上游> 结果」，但文件明明在。
 * 本函数让老库自动恢复，不需要用户重新解析一遍（重新解析要烧大量 token）。
 *
 * 实现要点：
 *  - 只**追加**缺失行，绝不删除/改写已登记行（已登记的 sha256/entryCount 可能
 *    被写回链路维护着，覆盖会误伤）；
 *  - 逐文件读信封拿 `container` 与 `entries.length`（真实值，不猜）；
 *  - 损坏分片跳过并记入 `skipped`（不因为一个坏文件让整库自愈失败）；
 *  - 整个读-改-写经 `updateIndex`（全局索引队列），与并发写者互斥。
 *
 * @returns 补充登记的行数（0 = 索引本来就是全的）
 */
export async function repairShardIndex(root: string): Promise<{
  added: number
  skipped: Array<{ file: string; reason: string }>
}> {
  // 先收集磁盘上所有分片文件（相对路径）
  const found: string[] = []
  const walk = (dir: string): void => {
    const abs = join(root, dir)
    if (!existsSync(abs)) return
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      const rel = `${dir}/${ent.name}`
      if (ent.isDirectory()) {
        walk(rel)
        continue
      }
      if (!ent.name.endsWith('.json')) continue
      // tmp 中间文件不属于分片
      if (ent.name.includes('.tmp-')) continue
      found.push(rel)
    }
  }
  for (const d of SHARD_DIRS) walk(d)

  const skipped: Array<{ file: string; reason: string }> = []
  let added = 0

  await updateIndex(root, async (idx) => {
    const known = new Set(idx.shards.map((s) => s.file))
    for (const file of found) {
      if (known.has(file)) continue
      let env
      try {
        env = await readShard(root, file)
      } catch (e) {
        skipped.push({ file, reason: (e as Error).message })
        continue
      }
      let sha256: string
      try {
        sha256 = sha256Hex(Buffer.from(await readFile(join(root, file))))
      } catch (e) {
        skipped.push({ file, reason: (e as Error).message })
        continue
      }
      idx.shards.push({
        name: env.shard || shardNameFor(file),
        file,
        container: env.container,
        entryCount: env.entries.length,
        sha256
      })
      known.add(file)
      added++
    }
  })

  return { added, skipped }
}

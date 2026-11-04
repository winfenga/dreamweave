/**
 * 无损真源 → 可重建投影层（设计 §5.4 / D8 / D14）。
 *
 * 硬约束（W10 / W11）：
 *  1. **输入仅来自 `records/**`**（无损真源），叶真源既不是输入也不是输出；
 *  2. **删除/写入集合始终排除叶真源**：`script/story-script.*.json`、`world/plot-locations.json`；
 *  3. 投影可**删除后确定性重建**：删全部投影 → `reproject` → 与删前逐文件深等（W11）。
 *
 * M0 投影 = 从对应 `records/results/<taskId>.json` 的**主条目**（排除 `:batch:`/`:grouped:`/`:plan`/`:repair`
 * 变体，与 `view.ts pickResult()` 同规则）取 `.data` 层后序列化；完整字段级归一属 M3/M5/M6。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isLeafTruthFile } from './paths'
import { extractTaskId, rebuildContainer } from './shards'
import { isVariant } from './variant'
import type { KeyedEntry, ReprojectResult, WorkspaceIndex } from './types'

interface ProjectionSpec {
  file: string
  taskId: string
}

/** 可重建投影清单（**绝不含叶真源**）。 */
export const PROJECTIONS: readonly ProjectionSpec[] = [
  { file: 'entities/canonical.json', taskId: 'canonical' },
  { file: 'entities/appearances.json', taskId: 'characterAppearance' },
  { file: 'entities/relations.json', taskId: 'characterRelation' },
  { file: 'world/location-tree.json', taskId: 'locationTree' },
  { file: 'world/plot-location-merge.json', taskId: 'plotLocationMerge' },
  { file: 'world/impression-layout.json', taskId: 'impressionLayout' },
  { file: 'script/line-annotation.json', taskId: 'lineAnnotation' },
  { file: 'script/effect-annotation.json', taskId: 'effectAnnotation' },
  { file: 'script/performance-review.json', taskId: 'performanceReview' },
  { file: 'events/event-tree.json', taskId: 'event' }
]

// 编译期自检：投影清单不得包含叶真源（§5.4）。
for (const p of PROJECTIONS) {
  if (isLeafTruthFile(p.file)) {
    throw new Error(`reproject 投影清单非法包含叶真源：${p.file}`)
  }
}

/** 变体判定统一走 `variant.ts`（单一事实源，§9）。 */

/** 值形态下钻（与 view.ts:144-151 的 unwrap 同规则）。 */
function unwrap(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') {
    const data = (value as Record<string, unknown>).data
    if (data !== undefined && data !== null) return data
  }
  return value
}

/** 取某任务的「主记录」值（排除变体；无则退回首个匹配）。 */
function pickMainValue(results: KeyedEntry[], taskId: string): unknown {
  const hit =
    results.find((e) => extractTaskId(String(e.key)) === taskId && !isVariant(String(e.key))) ??
    results.find((e) => extractTaskId(String(e.key)) === taskId)
  return hit ? unwrap(hit.value) : undefined
}

/**
 * 重建投影：先删既有投影（**绝不碰叶真源**），再从 `records/**` 确定性重建。
 */
export async function reproject(root: string, idx: WorkspaceIndex): Promise<ReprojectResult> {
  const removed: string[] = []
  for (const p of PROJECTIONS) {
    if (isLeafTruthFile(p.file)) throw new Error(`拒绝删除叶真源：${p.file}`)
    try {
      await rm(join(root, p.file))
      removed.push(p.file)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
  }

  // 输入仅来自无损真源 records/**（此处为其 results 容器重建）
  const rebuilt = (await rebuildContainer(root, idx, 'results')) as KeyedEntry[]
  const results: KeyedEntry[] = Array.isArray(rebuilt) ? rebuilt : []

  const touched: string[] = []
  for (const p of PROJECTIONS) {
    const value = pickMainValue(results, p.taskId)
    if (value === undefined) continue
    const abs = join(root, p.file)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, JSON.stringify(value, null, 2) + '\n', 'utf8')
    touched.push(p.file)
  }
  return { touched, removed }
}

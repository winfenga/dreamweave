/**
 * 上游产物读取（T6-B；聚合型适配器的基础设施）。
 *
 * 这是**聚合型适配器**（一次调用要消费某任务在本工作库的全部产物，如 worldImpression
 * 读全部 plot chunk 摘要）消费上游产物的**唯一入口**：适配器不自己拼路径、不自己遍历
 * 分片，一律经 `rt.readUpstream(taskId)`（orchestrator.makeRuntime 挂载，内部转本函数）。
 *
 * 路由与 `persistence.writeResult` → `workspace/shards.routeResultsKey` **严格同口径**
 * （保证读写的文件必然一致；两个特殊任务的绕法见 `matchesTaskFile`）：
 *  - `storyScript` → 全部 `script/story-script.*.json`（按 chunk 分文件，用
 *    `STORY_SCRIPT_FILE_PREFIX` 前缀匹配，`STORY_SCRIPT_MISC_CHUNK` 的 misc 文件也覆盖）；
 *  - `plotLocation` → 叶真源单文件 `world/plot-locations.json`（`PLOT_LOCATIONS_FILE`）；
 *  - 其余 → `records/results/<taskId>.json`（`resultsShardFile`，内部过 `sanitizeSegment`，
 *    与写入口径一致）。
 *
 * 遍历顺序 = 「分片在 `index.shards` 中的顺序 → 条目在信封 `entries` 中的顺序」**拼接**，
 * 不排序：信封插入序即写入时序（per-chunk 任务同分片内即 chunk 序，正是阅读序）。
 *
 * 容错边界（调用方契约）：
 *  - 分片在 index 中登记但**文件缺失** → 跳过该分片（不抛；如 range 重跑尚未产出的任务）；
 *  - 分片**损坏**（JSON 坏 / 结构不符）→ 抛可读错误（`readShard` 原文抛出，绝不静默吞掉）；
 *  - `index.json` 本身缺失/损坏 → 抛可读错误（`readIndex` 职责，本模块不兜底）。
 *
 * 返回条目 key 形如 `<pkgId>:<revisionId>:<taskId>[:<chunkIndex>]…`（实例键；
 * 可能带 `:batch:<b>` 等后缀，逐字透传，本模块不解释语义）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readIndex } from '../workspace/index-store'
import { readShard } from '../workspace/shards'
import { PLOT_LOCATIONS_FILE, STORY_SCRIPT_FILE_PREFIX, resultsShardFile } from '../workspace/paths'
import type { UpstreamEntry } from '../../shared/pipeline-types'

export type { UpstreamEntry } from '../../shared/pipeline-types'

/** taskId → 目标分片文件匹配（与 `routeResultsKey` 同口径；storyScript 为前缀多文件）。 */
function matchesTaskFile(file: string, taskId: string): boolean {
  if (taskId === 'storyScript') {
    return file.startsWith(STORY_SCRIPT_FILE_PREFIX) && file.endsWith('.json')
  }
  if (taskId === 'plotLocation') {
    return file === PLOT_LOCATIONS_FILE
  }
  return file === resultsShardFile(taskId)
}

/**
 * 读取某任务在本工作库的**全部产物条目**（按插入序；taskId 不存在 → 空数组）。
 *
 * @param root 工作库根（只读用途，不写任何文件）
 * @param taskId 任务 id（与产物实例键中的 taskId 一致，如 `plot` / `storyScript`）
 */
export async function readUpstreamResults(root: string, taskId: string): Promise<UpstreamEntry[]> {
  const idx = await readIndex(root)
  const out: UpstreamEntry[] = []
  for (const row of idx.shards) {
    if (row.container !== 'results') continue
    if (!matchesTaskFile(row.file, taskId)) continue
    // 登记了但文件缺失 → 跳过（range 重跑 / 尚未产出）；损坏则 readShard 抛可读错误
    if (!existsSync(join(root, row.file))) continue
    const env = await readShard(root, row.file)
    for (const e of env.entries) {
      out.push({ key: String(e.key), value: e.value })
    }
  }
  return out
}

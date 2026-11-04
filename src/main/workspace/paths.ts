/**
 * 工作库布局命名唯一事实源（设计 §9：任何模块不得再写这些字面量）。
 *
 * 目录结构（相对工作库根 <userData>/workspace/<pkgId>/）：
 *   index.json                    索引（原子写）
 *   meta/origin-header.bin        来源包前 12+jsonLen 字节（未编辑档 golden G1）
 *   records/<name>.json           容器分片：chapters/chunks/tasks/reader
 *   records/results/<taskId>.json 无损 results 分片（storyScript/plotLocation 除外）
 *   records/attempts/<taskId>.json 尝试审计分片
 *   script/story-script.<chunk>.json 叶真源（不参与 reproject）
 *   world/plot-locations.json        叶真源（不参与 reproject）
 *   entities/ world/ script/ events/  可重建投影（reproject 生成）
 *   assets/<kind>/<sha256><ext>   内容寻址资产
 */
export const WORKSPACE_DIR_NAME = 'workspace'
export const INDEX_FILE = 'index.json'
export const INDEX_VERSION = 1

/**
 * 工作库索引的 format 串。
 *
 * **双值兼容**（不是过渡期妥协，而是长期约定）：
 *   - 写：一律 `'dreamweave-workspace'`（新值，脱钩 txt2world）；
 *   - 读：新值与历史值 `'txt2world-workspace'` 都认。
 *
 * 为什么读侧必须认旧值：早期导入的工作库（本地实测 63 个）索引里写的就是历史串，
 * 若只认新值，这些书会在`index-store`的校验里**直接抛错、整本打不开**，
 * 而它们的数据本身完全可用 —— 为一个字符串把用户的库锁死是不可接受的。
 *
 * 因此这里不改历史文件、不做批量迁移：**读时兼容，写时升级**。
 * 任何一本库被重新写入（解析/回填/导出）后，format 自然变成新值。
 */
export const WORKSPACE_FORMAT = 'dreamweave-workspace'
/** 历史 format 串（只读兼容，永不再写） */
export const WORKSPACE_FORMAT_LEGACY = 'txt2world-workspace'
/** 读取侧接受的全部 format 值 */
export const WORKSPACE_FORMATS_ACCEPTED: readonly string[] = [WORKSPACE_FORMAT, WORKSPACE_FORMAT_LEGACY]

/** 某个 format 串是否可接受（读侧校验用） */
export function isAcceptedWorkspaceFormat(v: unknown): boolean {
  return typeof v === 'string' && WORKSPACE_FORMATS_ACCEPTED.includes(v)
}

export const META_DIR = 'meta'
export const ORIGIN_HEADER_REL = 'meta/origin-header.bin'

export const RECORDS_DIR = 'records'
export const RESULTS_DIR = 'records/results'
export const ATTEMPTS_DIR = 'records/attempts'
export const ASSETS_DIR = 'assets'

export const SCRIPT_DIR = 'script'
export const WORLD_DIR = 'world'
export const ENTITIES_DIR = 'entities'
export const EVENTS_DIR = 'events'

/** 叶真源文件（reproject 绝不读/写/删，设计 §5.4） */
export const PLOT_LOCATIONS_FILE = 'world/plot-locations.json'
export const STORY_SCRIPT_FILE_PREFIX = 'script/story-script.'
export const STORY_SCRIPT_MISC_CHUNK = 'misc'

/** 容器 → 固定分片文件（设计 §9） */
export const CONTAINER_FILES: Readonly<Record<string, string>> = {
  chapters: 'records/chapters.json',
  chunks: 'records/chunks.json',
  tasks: 'records/tasks.json',
  reader: 'records/reader.json'
}

/** 文件名片段清洗（pkgId/taskId 内的非法字符替换为 _） */
export function sanitizeSegment(segment: string): string {
  return segment.replace(/[\\/:*?"<>|]+/g, '_').replace(/^\.+$/, '_')
}

/** results 分片文件（默认按 taskId） */
export function resultsShardFile(taskId: string): string {
  return `${RESULTS_DIR}/${sanitizeSegment(taskId)}.json`
}

/** storyScript 分片文件（按 chunk；无法解析 chunk 序号 → misc） */
export function storyScriptShardFile(chunk: number | typeof STORY_SCRIPT_MISC_CHUNK): string {
  return `${STORY_SCRIPT_FILE_PREFIX}${chunk}.json`
}

/** attempts 分片文件（按 taskId） */
export function attemptsShardFile(taskId: string): string {
  return `${ATTEMPTS_DIR}/${sanitizeSegment(taskId)}.json`
}

/** 是否叶真源文件（script/story-script.*.json 或 world/plot-locations.json） */
export function isLeafTruthFile(file: string): boolean {
  return (
    file === PLOT_LOCATIONS_FILE ||
    (file.startsWith(STORY_SCRIPT_FILE_PREFIX) && file.endsWith('.json'))
  )
}

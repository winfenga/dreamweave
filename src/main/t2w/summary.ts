import { extname } from 'node:path'
import type { T2wManifest } from '../../shared/t2w-types'
import type { ChapterInfo, EntityCounts, EntityNames, FileInfo, ImportSummary } from '../../shared/app-types'

export type { ChapterInfo, EntityCounts, EntityNames, FileInfo, ImportSummary } from '../../shared/app-types'

/** 摘要所需的容器层信息（调用方从工作库索引 / 来源包提供；设计 §2.2「摘要数据来源切换」）。 */
export interface SummarySource {
  filePath: string
  totalSize: number
  jsonLen: number
  blobStart: number
  verify: { total: number; passed: number; failed: number }
  guards: { sumSizeMatches: boolean; noTrailingBytes: boolean }
  /**
   * 工作库**目录名**（`<userData>/workspace/` 下那一层）。
   *
   * 必填（不是可选）：渲染层所有「按工作库定位」的 IPC 都要它；
   * 漏传会让解析面板/生图面板拼出不存在的路径（历史 bug：
   * 报「工作库索引缺失或不可读：…/<包内ID>/index.json (ENOENT)」+ 任务计数错乱）。
   * 故意设为必填，让编译器逼所有调用点显式提供，而不是默默回落成包内 ID。
   */
  workspaceDir: string
}

function kindOf(path: string): string {
  const ext = extname(path).toLowerCase()
  if (ext === '.png') return 'png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image'
  if (ext === '.json') return 'json'
  if (ext === '.txt') return 'text'
  if (ext === '.bin') return 'bin'
  return ext ? ext.slice(1) : 'unknown'
}

/** records.chapters 既可能是 [{key,value}] 也可能是对象映射，这里统一取出 value 列表 */
function asValueList(node: unknown): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    return node
      .map((it) => (it && typeof it === 'object' && 'value' in (it as object) ? (it as { value: unknown }).value : it))
      .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
  }
  if (node && typeof node === 'object') {
    return Object.values(node as Record<string, unknown>).filter(
      (v): v is Record<string, unknown> => !!v && typeof v === 'object'
    )
  }
  return []
}

/** 在 records.results 中定位 canonical 条目（key 形如 "<pid>:<rev>:canonical"） */
function findCanonical(records: Record<string, unknown>): Record<string, unknown> | null {
  const results = records?.results
  const list: { key?: string; value: unknown }[] = Array.isArray(results)
    ? results.map((it) => {
        const o = it as { key?: string; value: unknown }
        return { key: o?.key, value: o?.value }
      })
    : results && typeof results === 'object'
      ? Object.entries(results as Record<string, unknown>).map(([key, value]) => ({ key, value }))
      : []
  for (const { key, value } of list) {
    if (key && key.endsWith(':canonical')) return (value as Record<string, unknown>) ?? null
  }
  return null
}

/**
 * 从 `records.chapters` 抽取章节列表（按 `seq` 升序）。
 * 供 `buildSummary` 与阅读页共用，保证两处章节口径完全一致。
 */
export function extractChapters(records: Record<string, unknown>): ChapterInfo[] {
  return asValueList(records.chapters)
    .map((c) => ({
      seq: Number(c.seq ?? 0),
      title: String(c.title ?? ''),
      byteStart: Number(c.byteStart ?? 0),
      byteEnd: Number(c.byteEnd ?? 0)
    }))
    .sort((a, b) => a.seq - b.seq)
}

/**
 * 由**注入的 manifest + sourceInfo** 构建导入摘要（数据来源切换为工作库装配结果，设计 §2.2）。
 * 抽取算法与今日**逐字不变**，仅数据来源从「整包 `T2wPackage`」改为「manifest + 容器层信息」。
 */
export function buildSummary(manifest: T2wManifest, source: SummarySource): ImportSummary {
  const p = manifest.project
  const records = (manifest.records ?? {}) as Record<string, unknown>

  const chapters: ChapterInfo[] = extractChapters(records)

  const canonical = findCanonical(records)
  const objects = (canonical?.objects ?? {}) as Record<string, unknown>
  const listOf = (k: string): Record<string, unknown>[] =>
    Array.isArray(objects[k]) ? (objects[k] as Record<string, unknown>[]) : []
  const count = (k: string): number => listOf(k).length
  const namesOf = (k: string): string[] => listOf(k).map((o) => String(o.name ?? o.id ?? ''))

  const entities: EntityCounts = {
    characters: count('characters'),
    factions: count('factions'),
    items: count('items'),
    creatures: count('creatures')
  }

  const entityNames: EntityNames = {
    characters: namesOf('characters'),
    factions: namesOf('factions'),
    items: namesOf('items'),
    creatures: namesOf('creatures')
  }

  const files: FileInfo[] = manifest.files.map((f) => ({ path: f.path, size: f.size, kind: kindOf(f.path) }))

  return {
    filePath: source.filePath,
    totalSize: source.totalSize,
    jsonLen: source.jsonLen,
    blobStart: source.blobStart,
    workspaceDir: source.workspaceDir,
    project: {
      id: String(p.id ?? ''),
      title: String(p.title ?? ''),
      revisionId: String(p.revisionId ?? ''),
      chapterCount: Number(p.chapterCount ?? 0),
      charCount: Number(p.charCount ?? 0),
      status: String(p.status ?? ''),
      encoding: String(p.encoding ?? ''),
      updatedAt: String(p.updatedAt ?? ''),
      parseMode: String(p.parseMode ?? ''),
      storyScriptStyle: String(p.storyScriptStyle ?? '')
    },
    chapters,
    entities,
    entityNames,
    files,
    verify: source.verify,
    guards: source.guards
  }
}

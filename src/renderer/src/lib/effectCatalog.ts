/**
 * 渲染进程侧的特效目录访问层：单例 Promise 缓存 + 若干纯查找辅助。
 * ScriptEditor（选择器）与 StageView（运行时）共用同一份缓存，避免重复 IPC / 重复读盘。
 */
import { EFFECT_CATEGORIES, type EffectCatalogEntry, type EffectCatalogResult } from '../../../shared/effects-types'

let cache: Promise<EffectCatalogResult> | null = null

/** 拉取特效目录（单例缓存；IPC 异常降级为可读错误对象，不抛出） */
export function loadCatalog(): Promise<EffectCatalogResult> {
  if (!cache) {
    cache = window.feather
      .getEffectCatalog()
      .catch((e): EffectCatalogResult => ({ ok: false, error: (e as Error).message }))
  }
  return cache
}

/** 重置缓存（仅测试用） */
export function resetCatalogCache(): void {
  cache = null
}

/** id -> 条目 */
export function catalogById(entries: EffectCatalogEntry[]): Map<string, EffectCatalogEntry> {
  return new Map(entries.map((e) => [e.id, e]))
}

export interface EffectCategoryGroup {
  category: string
  entries: EffectCatalogEntry[]
}

/**
 * 按 7 大类分组（顺序遵循 EFFECT_CATEGORIES），末尾追加目录中出现但不在常量内的类别。
 * 不硬编码任何条目 id。
 */
export function groupByCategory(entries: EffectCatalogEntry[]): EffectCategoryGroup[] {
  const buckets = new Map<string, EffectCatalogEntry[]>()
  const order: string[] = [...EFFECT_CATEGORIES]
  for (const e of entries) {
    const cat = typeof e.category === 'string' && e.category ? e.category : '未分类'
    if (!buckets.has(cat)) {
      buckets.set(cat, [])
      if (!order.includes(cat)) order.push(cat)
    }
    buckets.get(cat)!.push(e)
  }
  return order
    .filter((c) => buckets.has(c))
    .map((category) => ({ category, entries: buckets.get(category)! }))
}

/** 名称 / id / 描述 关键词搜索（大小写不敏感） */
export function searchEntries(entries: EffectCatalogEntry[], query: string): EffectCatalogEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return entries
  return entries.filter(
    (e) =>
      e.id.toLowerCase().includes(q) ||
      (e.name ?? '').toLowerCase().includes(q) ||
      (e.description ?? '').toLowerCase().includes(q)
  )
}

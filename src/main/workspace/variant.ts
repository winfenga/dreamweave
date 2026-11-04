/**
 * 变体检测**单一事实源**（设计 §9 / v3.3）。
 *
 * 收敛 `t2w/view.ts` 原有的**两处分散规则**，供 `view.ts` 与 `workspace/reproject.ts` **同源引用**：
 *   ① `pickResult` / `collectAppearances` 的 **4 后缀**变体判定（`:batch:` / `:grouped:` / `:plan` / `:repair`）；
 *   ② `pickStoryScriptChunks` **单独排除 `:batch:`** 的那条。
 *
 * 语义：**主条目 = 非 4 后缀**；**`storyScript` 再叠加「排除 `:batch:`」**。
 * 禁止在其它文件各写一份。
 */

/** 条目最小形状（key 为字符串）；兼容 view.ts 的 `Keyed<T>` 与 reproject 的 `KeyedEntry`。 */
export interface KeyedLike {
  key: string
  value: unknown
}

/**
 * 4 后缀变体判定（`view.ts:159-166` / `view.ts:202-203` 原 `isVariant` 逐字迁移）。
 * 变体 = 中间产物，取「主条目」时须排除。
 */
export function isVariant(key: string): boolean {
  return (
    key.includes(':batch:') ||
    key.includes(':grouped:') ||
    key.endsWith(':plan') ||
    key.endsWith(':repair')
  )
}

/** 主条目 = 非 4 后缀变体。 */
export function isMainEntry(key: string): boolean {
  return !isVariant(key)
}

/** storyScript 专有的 batch 排除（`view.ts:175` 原规则：`!key.includes(':batch:')`）。 */
export function isStoryScriptBatchCopy(key: string): boolean {
  return key.includes(':batch:')
}

/** storyScript 主条目：含 `:storyScript` 且**非** `:batch:` 副本（`view.ts:174-175`）。 */
export function isStoryScriptMain(key: string): boolean {
  return key.includes(':storyScript') && !isStoryScriptBatchCopy(key)
}

/**
 * 取某 needle 的「主记录」条目（`view.ts:159-166` `pickResult` 原两步规则）：
 *   先取「key 含 needle 且非变体」的第一个；无则取「key 含 needle」的第一个。
 */
export function pickMainEntry<E extends KeyedLike>(entries: E[], needle: string): E | undefined {
  return (
    entries.find((r) => typeof r.key === 'string' && r.key.includes(needle) && isMainEntry(r.key)) ??
    entries.find((r) => typeof r.key === 'string' && r.key.includes(needle))
  )
}

/** storyScript 的 chunk 序号（`/ :storyScript(?::(\d+))?/`），无序号按 0。 */
function chunkRank(key: string): number {
  const m = /:storyScript(?:[:](\d+))?/.exec(key)
  return m && m[1] ? Number(m[1]) : 0
}

/**
 * 全部 **chunk 级** storyScript 条目（排除 `:batch:`），按 chunk 序号升序
 * （`view.ts:169-177` `pickStoryScriptChunks` 的筛选 + 排序段）。
 */
export function selectStoryScriptChunks<E extends KeyedLike>(entries: E[]): E[] {
  return entries.filter((r) => typeof r.key === 'string' && isStoryScriptMain(r.key)).sort((a, b) => chunkRank(a.key) - chunkRank(b.key))
}

/** 全部 storyScript 条目（**含** `:batch:` 副本），供写回定位/兜底使用。 */
export function selectAllStoryScript<E extends KeyedLike>(entries: E[]): E[] {
  return entries.filter((r) => typeof r.key === 'string' && r.key.includes(':storyScript'))
}

/**
 * 阅读记忆（T6-D 重写；recon §4 / 设计 §6.3 的 memoryBefore 语义落地）。
 *
 * 【记忆是什么：plot 产物的纯派生数据（真实库实测结论）】
 * 对真实工作库 `1dc7a26d`（7 本抽样库之一）的 results 分片逐条比对：
 *  - `memoryBefore:i` 的 `recentMemory` ≡ chunks `0..i-1` 的 plot `chunkSummary` 列表：
 *    每条 `text` 与 `plot:{j}.data.chunkSummary` **逐字相等**，`start = end = j`（chunk 序号）；
 *  - `memoryBefore:0` 三层全空（`{recentMemory:[],midMemory:[],longTermMemory:[]}`）；
 *  - `memoryAfter:i` ≡ `memoryBefore:(i+1)`（即读完 chunk i 后把 chunk i 的摘要追加进 recent）；
 *  - `midMemory` / `longTermMemory` 在真实 7 本里**全为空**——从未触发记忆压缩
 *    （单本 recent 合计最大 6385 字，远低于 `DEFAULT_RECENT_LIMIT`）。
 * 因此记忆不需要独立存储：任何 chunk 的「读前记忆」都可以从 plot 产物**现算**。
 *
 * 【模块边界（T6-D 裁定）】
 *  - 本模块是**纯函数**（无 IO、无 electron 依赖），可被 node 验证脚本直接单测；
 *  - **不改 orchestrator 加钩子**：记忆由消费方适配器（draft / draftCharacter / draftOther 的
 *    `buildMessages`）在构造模板变量时经 `buildReadingMemory()` 现时组装；
 *  - `memoryBefore:{i}` / `memoryAfter:{i}` 的**实物落盘留待导出阶段（C2）**，本批不写——
 *    二者同样由本模块纯函数派生（memoryBefore:i = 本函数 selfChunkIndex=i 的结果；
 *    memoryAfter:i = selfChunkIndex=i+1 的结果），落盘只是序列化；
 *  - **compact 暂缓**：真实 7 本书从未触发记忆压缩（见上），本批不实现 compact 适配器与
 *    阈值触发。`DEFAULT_RECENT_LIMIT` 作为 compact 触发阈值常量保留（老 memory.ts 同值，
 *    16000 字符）；阈值是否沿用待定，注释在此备查。
 *
 * 【renderMemory 的渲染契约（模板原文依据）】
 * `chunk_wiki_draft_user_prompt` 的【概念和字段介绍】写明：「chunkReadingMemory 包含
 * longTermMemory、midMemory、recentMemory 三个摘要字符串数组」。故模板变量 `memory`
 * 渲染为三层各「摘要文本数组」的 JSON：
 * `{"recentMemory":["摘要0","摘要1"],"midMemory":[],"longTermMemory":[]}`。
 * 与老项目同构（recon `Ns = e => ({recentMemory: e.recentMemory.map(t=>t.text), …})`，
 * 非字符串模板变量在老渲染器里经 JSON.stringify 落进提示词）。
 */

/** 一条记忆条目（形状对齐真实库 memoryBefore/memoryAfter 分片）。 */
export interface MemoryEntry {
  /** 摘要正文（= 对应 chunk 的 plot chunkSummary，逐字） */
  text: string
  /** 起始 chunk 序号（真实库实测：start = end = chunk 序号） */
  start: number
  /** 结束 chunk 序号 */
  end: number
}

/** 三层阅读记忆（recent 近期 / mid 中期 / longTerm 远期）。 */
export interface ReadingMemory {
  recentMemory: MemoryEntry[]
  midMemory: MemoryEntry[]
  longTermMemory: MemoryEntry[]
}

/**
 * compact 触发阈值（字符）：recent 桶累计字符上限。
 *
 * 保留自老 memory.ts（同值 16000）。**compact 触发阈值待定**——真实 7 本从未触发
 * （单本 recent 合计最大 6385 字）；compact 适配器与阈值触发逻辑暂缓（见文件头）。
 */
export const DEFAULT_RECENT_LIMIT = 16000

/**
 * plot 产物条目 key → chunkIndex（key 形如 `<pkgId>:<revisionId>:plot:0`，末段为 chunk 序号）。
 * 与 `tasks/worldImpression.ts` / `tasks/locationTree.ts` 同口径（各模块私有副本，避免
 * 为一行正则建立跨模块依赖）。
 */
function chunkIndexOfKey(key: string): number | null {
  const segs = String(key ?? '').split(':')
  const last = segs[segs.length - 1] ?? ''
  return /^\d+$/.test(last) ? Number(last) : null
}

/**
 * 取 plot 产物条目的 chunkSummary。**两种 value 形态都兼容**：
 *  - `{data:{chunkSummary, chapters}, …}`（真实库老格式，value 外包一层 data）；
 *  - 裸 `{chunkSummary, chapters}`（本流水线 plot 适配器 parse 的产物形状）。
 * 口径：`value?.data?.chunkSummary ?? value?.chunkSummary`。
 */
function chunkSummaryOf(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined
  const o = value as Record<string, unknown>
  const data = o.data as Record<string, unknown> | null | undefined
  const fromData = data && typeof data === 'object' ? data.chunkSummary : undefined
  return fromData ?? o.chunkSummary
}

/** 非空字符串判定（空白串视作空）。 */
function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/**
 * 从 plot 产物组装某 chunk 的阅读记忆（`memoryBefore:i` 语义：chunks `0..i-1` 的摘要）。
 *
 * 逐条目处理：
 *  - chunkIndex 从 key 末段解析；解析不到 → 按该条目在 `plotEntries` 中的位置（0 起）；
 *  - 只收 `chunkIndex < selfChunkIndex` 且 chunkSummary 为非空字符串的条目
 *    （缺摘要的条目——如 raw 兜底产物——静默跳过：chunk 0 本就空记忆，合法）；
 *  - 每条记忆 `{text: chunkSummary, start: idx, end: idx}`（start/end = chunk 序号，
 *    真实库实测口径）；
 *  - 结果按 chunkIndex 升序（plot 同分片内天然有序，仍防御性排序）。
 *
 * `midMemory` / `longTermMemory` 恒为 `[]`：compact 未实现的诚实表现（真实库从未触发
 * 压缩，见文件头）；待 compact 落地后在此追加。
 *
 * @param plotEntries `rt.readUpstream('plot')` 的返回（`{key, value}[]`，按插入序 = chunk 序）
 * @param selfChunkIndex 当前 chunk 序号（**不含**：记忆只覆盖它之前的 chunk）
 */
export function buildReadingMemory(
  plotEntries: { key: string; value: unknown }[],
  selfChunkIndex: number
): ReadingMemory {
  const picked: { idx: number; text: string }[] = []
  const entries = Array.isArray(plotEntries) ? plotEntries : []
  for (let pos = 0; pos < entries.length; pos++) {
    const e = entries[pos]
    if (!e || typeof e !== 'object') continue
    const summary = chunkSummaryOf(e.value)
    if (!nonEmptyString(summary)) continue
    // key 末段数字为 chunkIndex（形如 `…:plot:0`）；解析不到 → 按出现序（数组位置）编号
    const idx = chunkIndexOfKey(e.key) ?? pos
    if (idx < selfChunkIndex) picked.push({ idx, text: summary })
  }
  // 防御性排序：plot 同分片内天然按 chunk 序，乱序读入时在此归一
  picked.sort((a, b) => a.idx - b.idx)
  return {
    recentMemory: picked.map((p) => ({ text: p.text, start: p.idx, end: p.idx })),
    midMemory: [],
    longTermMemory: []
  }
}

/**
 * 渲染为模板变量用的字符串：三层各为「摘要文本数组」（line_annotation 模板原文：
 * 「chunkReadingMemory 包含 recentMemory、midMemory、longTermMemory 三个摘要字符串数组」）。
 *
 * 输出例：`{"recentMemory":["摘要0","摘要1"],"midMemory":[],"longTermMemory":[]}`
 * （合法 JSON；start/end 序号信息不进模板——模板只要文本数组）。
 */
export function renderMemory(memory: ReadingMemory): string {
  const texts = (list: MemoryEntry[] | undefined): string[] =>
    Array.isArray(list) ? list.map((m) => (m && typeof m.text === 'string' ? m.text : '')) : []
  return JSON.stringify({
    recentMemory: texts(memory?.recentMemory),
    midMemory: texts(memory?.midMemory),
    longTermMemory: texts(memory?.longTermMemory)
  })
}

/**
 * 取**下一个** chunk 的 plot 摘要（`nextChunkSummary` 模板变量用；末 chunk 为 `''`）。
 *
 * 模板契约（draft 三模板通用）：「下一个 chunk 的摘要，最后一个 chunk 为空。仅用于消歧、
 * 判断和深化当前剧情及人物的理解……它绝不是本次事实来源」。故只取 `chunkIndex ===
 * selfChunkIndex + 1` 的条目；没有下一条（末 chunk）或下一条无摘要 → `''`。
 *
 * @param plotEntries 同 `buildReadingMemory`
 * @param selfChunkIndex 当前 chunk 序号
 */
export function nextChunkSummaryOf(
  plotEntries: { key: string; value: unknown }[],
  selfChunkIndex: number
): string {
  const want = selfChunkIndex + 1
  const entries = Array.isArray(plotEntries) ? plotEntries : []
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue
    if (chunkIndexOfKey(e.key) !== want) continue
    const summary = chunkSummaryOf(e.value)
    return nonEmptyString(summary) ? summary : ''
  }
  return ''
}

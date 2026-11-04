/**
 * `draft` 任务适配器（T6-D 第四批；模板 `chunk_wiki_draft_user_prompt`，旧项目单任务模式）。
 *
 * 产物：`records/results/draft.json`（条目 key = 实例键；per-chunk 任务每 chunk 一次）。
 * 输入：**带行号原文**（与 cacheWarming/seg/plot 逐字同构：各章从 1 重新编号、每章外包
 * `【原文行：1-N】`；见 `../chunk-source`）。
 *
 * 【模板变量（以模板实际占位符为准，逐字读过 `chunk_wiki_draft_user_prompt.txt`）】
 * `{{{chunkIndex}}}` / `{{{chapterRange}}}` / `{{{memory}}}` / `{{{nextChunkSummary}}}`
 * / `{{{enabledSections}}}`，共 5 个：
 *  - `chunkIndex` = `rt.chunkIndex ?? 0`；
 *  - `chapterRange` = 首章seq-末章seq（与 seg 逐字同口径：`1-4`，单章时就是该数字；
 *    注：老项目 recon 用全角破折号 `—` 拼接，本流水线统一沿用 seg 的 ASCII `-` 口径）；
 *  - `memory` = `renderMemory(buildReadingMemory(plot 产物, chunkIndex))` 现算
 *    （阅读记忆是 plot 产物的纯派生数据，见 `../memory.ts` 文件头）；
 *  - `nextChunkSummary` = `nextChunkSummaryOf(plot 产物, chunkIndex)`（末 chunk 为 ''）；
 *  - `enabledSections` = `'["characters","factions","items"]'`。
 *
 * 【enabledSections 格式裁定（依据 = 老项目 recon 实证 + 模板契约）】
 * recon `_parser.worker`：`enabledSections: ds(project)`，`ds` 返回 **English section keys
 * 数组**（`ld=["characters","factions","items","creatures"]` 的 feature 过滤子集），且老
 * 渲染器对**非字符串模板变量一律 JSON.stringify**——即真实老书提示词里 enabledSections
 * 形如 `["characters","factions","items"]`。本流水线的 task-registry 只有任务级 feature
 * 门（编排器层），尚无项目级 characters/factions/items/creatures 开关，故取**本任务模板
 * 契约分管的栏目集合**作为启用集：draft 模板【本次目标】写明「只提取人物 characters、
 * 势力 factions、物品 items」，【最后的提醒】3 同——即 `["characters","factions","items"]`。
 * 传 JSON 数组字符串（而非 JS 数组）：本仓 prompt-loader 的 `stringifyVar` 对数组是
 * **换行拼接**而非 JSON 序列化，传字符串才能复刻老项目的落盘渲染结果。
 *
 * 【为什么 buildMessages 发 3 条消息（与 worldImpression/locationTree 的 2 条不同）】
 * 模板【本次输入】区只嵌变量（memory/nextChunkSummary/enabledSections/chunkIndex/
 * chapterRange），原文**不作变量嵌入**——模板原文：「当前 chunk 原文：见前面的 user 消息」。
 * 故原文必须单独作一条 user 消息先行喂入：system（common_system_prompt）+
 * user（带行号原文）+ user（渲染后的任务指令）= 3 条（与 cacheWarming/seg/plot 同构）。
 *
 * 【parse：只产模型数据，不分配 id（T6-D 裁定，与老项目分工）】
 * `parse(content)` 拿不到 rt（没有 chunkIndex），而 id 规则 `D-{chunkIndex}-{cat}-{n}`
 * （recon `py` 实证：cat = characters→`C`，其余为栏目名；同批附 `draftIds` 与
 * `chunkSummaryList`）依赖 chunk 序号 → **id/draftIds/chunkSummaryList 由 T6-E 的 merge
 * 本地步骤统一分配**（与老书方案一致：老项目也是 `program('draft:i')` 落盘前由 `py` 补）。
 * 本批 parse 只产模型数据 + 轻量规范化（见 `normalizeEntity`）。
 *
 * parse 顶层契约（以模板【输出格式】为准）：`{"characters":[],"factions":[],"items":[]}`。
 * 必填键 = `characters` + `factions`（缺任一 → raw 截断兜底，不抛崩）；
 * `items` 与 `identityMatchStopNames` 缺省 `[]`（模型常省略空数组/stopNames）。
 * 注：新模板 draft **不抽 creatures**（creatures 归 draftOther 模板），parse 不产该键；
 * 真实库老 draft 数据里的 `creatures` 是老提示词契约，不由本批产生。
 *
 * 【与真实库 draft 产物的差异（醒目，形状对齐但字段有意不同）】
 *  - 真实库条目带程序字段 `id`/`draftIds`/`chunkSummaryList`（T6-E merge 分配，本批不产）；
 *  - 真实库 `aliases` 是**对象数组** `[{alias,type}]`（老提示词契约）；本批模板是移植版
 *    新版（实测最新书 `15de5d4f` 同代），`aliases` 为**字符串数组**——老书对象数组形状
 *    不由本批产生，下游消费按新模板契约定式；
 *  - 真实库 value 外包 `{data, responsePath, cacheReadyAt}`（persistence 信封，与本适配器
 *    无关——parse 只负责 data 内容）。
 *
 * 合并策略：`concat-dedup-order` + 显式 `keyOf`（draft 实体无 id，name 是唯一稳定标识；
 * 理由见 `draftKeyOf` 处注释）。
 */
import type { ChatMessage, LlmTaskAdapter, TaskRuntime, UpstreamEntry } from '../../../shared/pipeline-types'
import { numberLines } from '../chunk-source'
import { buildReadingMemory, nextChunkSummaryOf, renderMemory } from '../memory'
import { parseJsonLoose } from './cacheWarming'

/**
 * draft 实体的稳定键（供 `concat-dedup-order` 的 dedupeDeep 用）。
 *
 * 为什么必须显式提供（读 `../merge` 后的结论）：L2 切批不尊重实体边界，同一实体可能被
 * 多个批次各自产出；`mergeOutputs` 先字段级 `combineFirst`（`characters`/`factions`/`items`
 * 数组直接拼接），再 `dedupeDeep` 按稳定键去重。draft 实体**无程序 id**（id 由 T6-E
 * merge 分配，见文件头），唯一稳定标识是 `name`（模板契约：「name 取当前原文中最明确、
 * 稳定、适合做 Wiki 页标题的名称」）。chunk 内重名不同实体罕见，按 name 首现获胜。
 * 缺省 `defaultKeyOf` 对实体对象会依次尝试 id/key/name——恰好也落到 name，但显式提供
 * 可锁定语义（不依赖缺省实现的字段顺序），并对字符串元素（ warnings 形态）给出
 * `warn:` 前缀键避免与实体相消。
 */
export function draftKeyOf(part: unknown): string {
  if (typeof part === 'string') return `warn:${part}`
  if (part && typeof part === 'object' && !Array.isArray(part)) {
    const o = part as Record<string, unknown>
    if (typeof o.name === 'string' && o.name.trim().length > 0) return `name:${o.name.trim()}`
  }
  try {
    return JSON.stringify(part)
  } catch {
    return String(part)
  }
}

/** 字符串数组成员过滤（非字符串元素剔除；非数组 → 缺省 `[]`）。 */
function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/**
 * 单个 WorldObj 实体的轻量规范化（模板契约字段；**不逐层深校验**，与既有适配器
 * 「顶层必填键 + 模型级契约」的同风格）：
 *  - `name` 必填非空字符串（trim 后）——缺 → 返回 null（调用方跳过该条）；
 *  - `summary` 缺省 `''`（模板必填，但实体级缺失不应丢整批）；
 *  - `identInfos` / `aliases` 规范为字符串数组（新模板契约：aliases 是字符串数组；
 *    老书对象数组形状不由本批产生，见文件头）；
 *  - 其余字段（wikiSectionType / importanceLevel / lifeStatus / appearanceChapterSeqs /
 *    characterSpriteInfos / vt / vi…）**原样透传**，不发明也不删除；
 *  - **不分配** id/draftIds/chunkSummaryList（T6-E merge 的职责）。
 */
function normalizeEntity(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  if (!name) return null
  return {
    ...o,
    name,
    summary: typeof o.summary === 'string' ? o.summary : '',
    identInfos: stringArray(o.identInfos),
    aliases: stringArray(o.aliases)
  }
}

/** 实体数组规范化（跳过缺 name 的坏条目，不抛崩）。 */
function entityArray(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return []
  const out: Record<string, unknown>[] = []
  for (const item of v) {
    const e = normalizeEntity(item)
    if (e) out.push(e)
  }
  return out
}

/** 非空字符串数组（identityMatchStopNames 用：剔除空白词）。 */
function stopNameArray(v: unknown): string[] {
  return stringArray(v).map((s) => s.trim()).filter((s) => s.length > 0)
}

/** 读 plot 产物（阅读记忆与下一片摘要的唯一来源）；未挂 readUpstream → 可读错误。 */
async function readPlotEntries(rt: TaskRuntime): Promise<UpstreamEntry[]> {
  if (typeof rt.readUpstream !== 'function') {
    throw new Error('draft 需要 plot 产物（阅读记忆与下一片摘要的唯一来源）：运行期未提供 readUpstream（rt 须由编排器 makeRuntime 构造）')
  }
  // plot 产物为空 → 空记忆（chunk 0 本就空，合法），不抛错
  return rt.readUpstream('plot')
}

/**
 * 从 rt 推导模板变量（`chunk_wiki_draft_user_prompt` 的 5 个 `{{{var}}}` 占位符）。
 * 缺 chunkChapters 时视作单章（seq=1）并给合理回退，绝不传 undefined。
 */
async function draftTemplateVars(rt: TaskRuntime): Promise<Record<string, unknown>> {
  const chapters = rt.chunkChapters ?? [{ seq: 1, title: '（单章原文）', text: rt.chunkText }]
  const seqs = chapters.map((c) => c.seq).filter((n) => Number.isFinite(n))
  const first = seqs.length ? seqs[0] : 1
  const last = seqs.length ? seqs[seqs.length - 1] : 1
  const selfChunkIndex = rt.chunkIndex ?? 0
  const entries = await readPlotEntries(rt)
  return {
    chunkIndex: selfChunkIndex,
    // 章节范围：`首章seq-末章seq`（如 `1-4`）；单章时就是该数字
    chapterRange: first === last ? String(first) : `${first}-${last}`,
    // 阅读记忆：chunks 0..i-1 的 plot 摘要，现算（见 ../memory.ts）
    memory: renderMemory(buildReadingMemory(entries, selfChunkIndex)),
    // 下一 chunk 摘要（仅辅助消歧；末 chunk 为 ''）
    nextChunkSummary: nextChunkSummaryOf(entries, selfChunkIndex),
    // 启用栏目：JSON 数组字符串（格式裁定依据见文件头）
    enabledSections: '["characters","factions","items"]'
  }
}

export const draftAdapter: LlmTaskAdapter = {
  id: 'draft',
  mergeStrategy: 'concat-dedup-order',
  keyOf: draftKeyOf,

  async inputText(rt: TaskRuntime): Promise<string> {
    // 与 cacheWarming/seg/plot 逐字同构：有章节切片按「各章从 1 重新编号」组装；
    // 否则（调用方直接注入 chunkText）视作单章原文。
    const chapters = rt.chunkChapters ?? [{ seq: 1, title: '（单章原文）', text: rt.chunkText }]
    return numberLines(chapters)
  },

  async buildMessages(batchText: string, rt: TaskRuntime): Promise<ChatMessage[]> {
    const system = await rt.render('common_system_prompt', {})
    const instruction = await rt.render('chunk_wiki_draft_user_prompt', await draftTemplateVars(rt))
    // 原文单独一条 user 消息在前、任务指令放最后（模板「当前 chunk 原文：见前面的 user 消息」）
    return [
      { role: 'system', content: system },
      { role: 'user', content: batchText },
      { role: 'user', content: instruction }
    ]
  },

  parse(content: string): unknown {
    const obj = parseJsonLoose(content)
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const o = obj as Record<string, unknown>
      // 必填键：characters + factions（模板输出契约三个数组中的两个主干；
      // items 与 identityMatchStopNames 模型常省略 → 缺省 []）
      if (Array.isArray(o.characters) && Array.isArray(o.factions)) {
        return {
          characters: entityArray(o.characters),
          factions: entityArray(o.factions),
          items: entityArray(o.items),
          identityMatchStopNames: stopNameArray(o.identityMatchStopNames)
        }
      }
    }
    // 兜底（与 cacheWarming 的 raw 兜底同风格）：不抛崩，保留原文截断供排查
    return {
      characters: null,
      factions: null,
      items: [],
      identityMatchStopNames: [],
      raw: (content ?? '').slice(0, 500)
    }
  }
}

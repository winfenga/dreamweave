/**
 * `draftCharacter` 任务适配器（T6-D 第四批；模板 `chunk_wiki_draft_character_user_prompt`，
 * 新项目拆分模式·人物子任务）。
 *
 * 产物：`records/results/draftCharacter.json`（条目 key = 实例键；per-chunk 任务每 chunk 一次）。
 * 输入：**带行号原文**（与 cacheWarming/seg/plot/draft 逐字同构；见 `../chunk-source`）。
 *
 * 【与 draft 的分工（老项目 recon 实证）】
 * 老项目 `draft()` 在 parsePlan 含 draftCharacter/draftOther 时走**拆分模式**：两个子任务
 * 收同一组模板变量（`chunkIndex/chapterRange/memory/nextChunkSummary/enabledSections`），
 * 各自 prompt 只产自己的栏目，最后由程序步骤 `draft:{i}` 汇总（characters 取
 * draftCharacter、其余取 draftOther）。本流水线无该程序汇总步骤的接线（T6-E 起才落
 * merge），故本适配器独立产 `records/results/draftCharacter.json`，汇总语义留待 T6-E。
 *
 * 【模板变量（以模板实际占位符为准，逐字读过 `chunk_wiki_draft_character_user_prompt.txt`）】
 * `{{{chunkIndex}}}` / `{{{chapterRange}}}` / `{{{memory}}}` / `{{{nextChunkSummary}}}`，
 * 共 **4 个——本模板没有 enabledSections 占位符**（人物子任务只抽 characters 一个栏目，
 * 无需启用集；与 draft/draftOther 的 5 变量不同）。变量推导与 draft 逐字同构：
 *  - `memory` = `renderMemory(buildReadingMemory(plot 产物, chunkIndex))` 现算
 *    （阅读记忆是 plot 产物的纯派生数据，见 `../memory.ts` 文件头）；
 *  - `nextChunkSummary` = `nextChunkSummaryOf(plot 产物, chunkIndex)`（末 chunk 为 ''）；
 *  - `chapterRange` = 首章seq-末章seq（seg 的 ASCII `-` 口径）。
 *
 * 【为什么 buildMessages 发 3 条消息】
 * 模板【输入与输出】区原文：「当前 chunk 原文见前面的带行号 user 消息；行号不属于正文」——
 * 原文**不作变量嵌入**，须单独一条 user 消息先行喂入：system + user（带行号原文）+
 * user（渲染后的任务指令）= 3 条（与 cacheWarming/seg/plot/draft 同构）。
 *
 * 【parse：只产模型数据，不分配 id（T6-D 裁定）】
 * id 规则 `D-{chunkIndex}-C-{n}`（recon `py` 实证：characters 的 cat 段为 `C`）依赖 chunk
 * 序号，而 `parse(content)` 拿不到 rt → **id/draftIds/chunkSummaryList 由 T6-E 的 merge
 * 本地步骤统一分配**（与老书方案一致）。本批 parse 只产模型数据 + 轻量规范化
 * （与 draft 的 `normalizeEntity` 同规则，见 `./draft.ts`）。
 *
 * parse 顶层契约（以模板【输出结构】为准）：
 * `{"characters":[…],"identityMatchStopNames":[]}`。必填键 = `characters`（缺 → raw 截断
 * 兜底，不抛崩）；`identityMatchStopNames` 缺省 `[]`（模板【身份匹配排除词】一节强调
 * 「必须输出」，但模型对空结果常省略——与 draft 的 stopNames 同 rationale，缺省兜底；
 * 剔除空白词、去重交由 T6-E）。
 *
 * 模型级契约（不逐层深校验，透传）：characters 元素 = WorldObj（name/importanceLevel/
 * summary/identInfos/aliases/lifeStatus/characterSpriteInfos…）；`vt`/`vi` 声音字段
 * **成对出现或同时省略**（模板【人物声音】：本 chunk 有对白且非哑巴时必须同时填写，
 * 没有对白/哑巴时同时省略，不填空串或 null）——配对约束属模型契约，parse 不强制。
 *
 * 【与真实库 draftCharacter 产物的差异（醒目）】
 *  - 真实库条目带程序字段 `id`/`draftIds`/`chunkSummaryList`（T6-E merge 分配，本批不产）；
 *  - 真实库 data 还含 `factions`/`items`/`creatures`（老项目拆分模式由程序补的空数组，
 *    为汇总形状服务）；本适配器按新模板只产 `characters` + `identityMatchStopNames`，
 *    汇总形状留待 T6-E；
 *  - 真实库 `aliases` 是对象数组 `[{alias,type}]`（老契约）；本批模板是移植版新版，
 *    `aliases` 为字符串数组（实测最新书 `15de5d4f` 同代）。
 *
 * 合并策略：`concat-dedup-order` + 显式 `keyOf`（实体无 id，name 是唯一稳定标识；
 * 理由见 `draftKeyOf` 处注释——与 draft 同规则）。
 */
import type { ChatMessage, LlmTaskAdapter, TaskRuntime, UpstreamEntry } from '../../../shared/pipeline-types'
import { numberLines } from '../chunk-source'
import { buildReadingMemory, nextChunkSummaryOf, renderMemory } from '../memory'
import { parseJsonLoose } from './cacheWarming'
import { draftKeyOf } from './draft'

/** 字符串数组成员过滤（非字符串元素剔除；非数组 → 缺省 `[]`）。 */
function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/**
 * 单个人物实体的轻量规范化（与 `./draft.ts` 的 normalizeEntity 同规则，各适配器文件
 * 自持副本——沿用本仓「适配器自包含」的既有风格）：
 *  - `name` 必填非空字符串（trim 后）——缺 → null（调用方跳过该条）；
 *  - `summary` 缺省 `''`；`identInfos` / `aliases` 规范为字符串数组（新模板契约）；
 *  - 其余字段（importanceLevel / lifeStatus / characterSpriteInfos / vt / vi…）原样透传；
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
    throw new Error('draftCharacter 需要 plot 产物（阅读记忆与下一片摘要的唯一来源）：运行期未提供 readUpstream（rt 须由编排器 makeRuntime 构造）')
  }
  // plot 产物为空 → 空记忆（chunk 0 本就空，合法），不抛错
  return rt.readUpstream('plot')
}

/**
 * 从 rt 推导模板变量（`chunk_wiki_draft_character_user_prompt` 的 4 个占位符；
 * **无 enabledSections**——本模板只抽人物，理由见文件头）。
 */
async function draftCharacterTemplateVars(rt: TaskRuntime): Promise<Record<string, unknown>> {
  const chapters = rt.chunkChapters ?? [{ seq: 1, title: '（单章原文）', text: rt.chunkText }]
  const seqs = chapters.map((c) => c.seq).filter((n) => Number.isFinite(n))
  const first = seqs.length ? seqs[0] : 1
  const last = seqs.length ? seqs[seqs.length - 1] : 1
  const selfChunkIndex = rt.chunkIndex ?? 0
  const entries = await readPlotEntries(rt)
  return {
    chunkIndex: selfChunkIndex,
    chapterRange: first === last ? String(first) : `${first}-${last}`,
    memory: renderMemory(buildReadingMemory(entries, selfChunkIndex)),
    nextChunkSummary: nextChunkSummaryOf(entries, selfChunkIndex)
  }
}

export const draftCharacterAdapter: LlmTaskAdapter = {
  id: 'draftCharacter',
  mergeStrategy: 'concat-dedup-order',
  // 实体稳定键与 draft 完全同规则（name 为唯一稳定标识）——直接复用，避免两份实现漂移
  keyOf: draftKeyOf,

  async inputText(rt: TaskRuntime): Promise<string> {
    // 与 cacheWarming/seg/plot/draft 逐字同构
    const chapters = rt.chunkChapters ?? [{ seq: 1, title: '（单章原文）', text: rt.chunkText }]
    return numberLines(chapters)
  },

  async buildMessages(batchText: string, rt: TaskRuntime): Promise<ChatMessage[]> {
    const system = await rt.render('common_system_prompt', {})
    const instruction = await rt.render('chunk_wiki_draft_character_user_prompt', await draftCharacterTemplateVars(rt))
    // 原文单独一条 user 消息在前、任务指令放最后（模板「当前 chunk 原文见前面的带行号 user 消息」）
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
      // 必填键：characters（模板输出结构主干）；
      // identityMatchStopNames 模板强调必须输出但模型常省略 → 缺省 []
      if (Array.isArray(o.characters)) {
        return {
          characters: entityArray(o.characters),
          identityMatchStopNames: stopNameArray(o.identityMatchStopNames)
        }
      }
    }
    // 兜底（与 cacheWarming 的 raw 兜底同风格）：不抛崩，保留原文截断供排查
    return {
      characters: null,
      identityMatchStopNames: [],
      raw: (content ?? '').slice(0, 500)
    }
  }
}

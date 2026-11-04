/**
 * `draftOther` 任务适配器（T6-D 第四批；模板 `chunk_wiki_draft_other_user_prompt`，
 * 新项目拆分模式·非人物子任务）。
 *
 * 产物：`records/results/draftOther.json`（条目 key = 实例键；per-chunk 任务每 chunk 一次）。
 * 输入：**带行号原文**（与 cacheWarming/seg/plot/draft 逐字同构；见 `../chunk-source`）。
 *
 * 【与 draft/draftCharacter 的分工（老项目 recon 实证）】
 * 老项目拆分模式下 draftOther 与 draftCharacter 收同一组模板变量、各自 prompt 只产自己
 * 的栏目（draftOther 产 factions/items/creatures），程序步骤 `draft:{i}` 再汇总。
 * 本流水线该汇总步骤的接线留待 T6-E，故本适配器独立产
 * `records/results/draftOther.json`。
 *
 * 【模板变量（以模板实际占位符为准，逐字读过 `chunk_wiki_draft_other_user_prompt.txt`）】
 * `{{{chunkIndex}}}` / `{{{chapterRange}}}` / `{{{memory}}}` / `{{{nextChunkSummary}}}`
 * / `{{{enabledSections}}}`，共 5 个（与 draft 同构；draftCharacter 只有 4 个）：
 *  - `memory` = `renderMemory(buildReadingMemory(plot 产物, chunkIndex))` 现算
 *    （阅读记忆是 plot 产物的纯派生数据，见 `../memory.ts` 文件头）；
 *  - `nextChunkSummary` = `nextChunkSummaryOf(plot 产物, chunkIndex)`（末 chunk 为 ''）；
 *  - `chapterRange` = 首章seq-末章seq（seg 的 ASCII `-` 口径）；
 *  - `enabledSections` = `'["factions","items","creatures"]'`。
 *
 * 【enabledSections 格式裁定（依据 = 老项目 recon 实证 + 模板契约）】
 * recon `_parser.worker`：`enabledSections: ds(project)` 返回 **English section keys
 * 数组**（`ld=["characters","factions","items","creatures"]` 的 feature 过滤子集），
 * 非字符串模板变量在老渲染器里经 JSON.stringify 落进提示词；且老项目对 draftOther 的
 * 产出还会后置过滤（`ds(project).includes(y) || (_[y]=[])`）。本流水线尚无项目级
 * feature 开关，故取**本任务模板契约分管的栏目集合**：模板【本次目标】写明「只生成
 * 势力 factions、物品 items、生物种类 creatures 草稿」——即 `["factions","items",
 * "creatures"]`，三者全启用，无需后置过滤。传 JSON 数组字符串的理由同 draft（本仓
 * prompt-loader 对 JS 数组是换行拼接，传字符串才复刻老渲染），详见 `./draft.ts` 文件头。
 *
 * 【为什么 buildMessages 发 3 条消息】
 * 模板【输入与输出】区原文：「当前 chunk 原文见前面的带行号 user 消息；行号不属于正文」——
 * 原文不作变量嵌入，须单独一条 user 消息先行喂入：system + user（带行号原文）+
 * user（渲染后的任务指令）= 3 条（与 cacheWarming/seg/plot/draft 同构）。
 *
 * 【parse：只产模型数据，不分配 id（T6-D 裁定）】
 * id 规则 `D-{chunkIndex}-{cat}-{n}`（recon `py` 实证：cat = factions/items/creatures
 * 栏目名）依赖 chunk 序号，而 `parse(content)` 拿不到 rt → **id/draftIds/
 * chunkSummaryList 由 T6-E 的 merge 本地步骤统一分配**（与老书方案一致）。本批 parse
 * 只产模型数据 + 轻量规范化（与 draft 的 `normalizeEntity` 同规则）。
 *
 * parse 顶层契约（以模板【输出格式】为准）：「只输出以下三个数组组成的 JSON 对象」
 * `{"factions":[],"items":[],"creatures":[]}`——三个数组**均为必填**（缺任一 → raw
 * 截断兜底，不抛崩；与老项目 zod `ree` 三层必填同口径）。
 *
 * 模型级契约（不逐层深校验，透传）：三个数组的元素均为
 * `{name, importanceLevel, summary, identInfos, aliases}`；creatures 收录**物种/种类**
 * （非具名个体——模板【对象范围】明示：「小白狼」作为伙伴个体不收录，「银月狼」作为
 * 物种种类可收录），该判别属模型职责，parse 不强制。
 *
 * 【与真实库 draftOther 产物的差异（醒目）】
 *  - 真实库条目带程序字段 `id`/`draftIds`/`chunkSummaryList`（T6-E merge 分配，本批不产）；
 *  - 真实库 data 还含空 `characters` 数组（老项目拆分模式程序补的汇总形状）；本适配器
 *    按新模板只产 `factions`/`items`/`creatures`，汇总形状留待 T6-E；
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
 * 单个实体（factions/items/creatures 通用）的轻量规范化，与 `./draft.ts` 的
 * normalizeEntity 同规则（各适配器文件自持副本——沿用本仓「适配器自包含」的既有风格）：
 *  - `name` 必填非空字符串（trim 后）——缺 → null（调用方跳过该条）；
 *  - `summary` 缺省 `''`；`identInfos` / `aliases` 规范为字符串数组（新模板契约）；
 *  - 其余字段（wikiSectionType / importanceLevel…）原样透传；
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

/** 读 plot 产物（阅读记忆与下一片摘要的唯一来源）；未挂 readUpstream → 可读错误。 */
async function readPlotEntries(rt: TaskRuntime): Promise<UpstreamEntry[]> {
  if (typeof rt.readUpstream !== 'function') {
    throw new Error('draftOther 需要 plot 产物（阅读记忆与下一片摘要的唯一来源）：运行期未提供 readUpstream（rt 须由编排器 makeRuntime 构造）')
  }
  // plot 产物为空 → 空记忆（chunk 0 本就空，合法），不抛错
  return rt.readUpstream('plot')
}

/**
 * 从 rt 推导模板变量（`chunk_wiki_draft_other_user_prompt` 的 5 个占位符）。
 */
async function draftOtherTemplateVars(rt: TaskRuntime): Promise<Record<string, unknown>> {
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
    nextChunkSummary: nextChunkSummaryOf(entries, selfChunkIndex),
    // 启用栏目：JSON 数组字符串（格式裁定依据见文件头）
    enabledSections: '["factions","items","creatures"]'
  }
}

export const draftOtherAdapter: LlmTaskAdapter = {
  id: 'draftOther',
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
    const instruction = await rt.render('chunk_wiki_draft_other_user_prompt', await draftOtherTemplateVars(rt))
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
      // 必填键：factions + items + creatures（模板「只输出以下三个数组组成的 JSON 对象」），
      // 缺任一即走 raw 截断兜底（不抛崩）
      if (Array.isArray(o.factions) && Array.isArray(o.items) && Array.isArray(o.creatures)) {
        return {
          factions: entityArray(o.factions),
          items: entityArray(o.items),
          creatures: entityArray(o.creatures)
        }
      }
    }
    // 兜底（与 cacheWarming 的 raw 兜底同风格）：不抛崩，保留原文截断供排查
    return {
      factions: null,
      items: null,
      creatures: null,
      raw: (content ?? '').slice(0, 500)
    }
  }
}

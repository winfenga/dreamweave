/**
 * `mergeReview` 任务适配器（T6-E 第五批；模板 `wiki_entity_merge_review_user_prompt`）。
 *
 * 注册表是 **4 条独立 TaskDef**（`resources/pipeline/task-registry.json`）：
 * `mergeReview:characters` / `:factions` / `:items` / `:creatures`，均 global、
 * dependsOn [merge]、各带 `feature` 字段（类目名）。本适配器是**同一对象注册 4 个键**
 * （见 `./index.ts` 的 LLM_ADAPTERS），类目从 `rt.task.feature` 取。
 *
 * 产物：`records/results/mergeReview.json`（4 类目同文件——实例键
 * `<pkg>:<rev>:mergeReview:<cat>` 经 `extractTaskId` 命中 KNOWN_TASK_IDS 的
 * `mergeReview` 段路由到同 file，key 后缀区分类目；与真实库实测一致：该类文件同时
 * 含 4 条类目主条目 + `:plan` 变体条目）。
 *
 * ---------------------------------------------------------------------------
 * 【为什么 buildMessages 只发 2 条消息（与 cacheWarming/seg/draft 系的 3 条不同）】
 * 逐字读过模板：【输入】区把三个变量**全部嵌在指令里**——
 * `统一 wikiSectionType：{{{wikiSectionType}}}` / `worldObjs：{{{worldObjs}}}` /
 * `identityMatchStopNames：{{{identityMatchStopNames}}}`，全文**没有**「见前面的
 * user 消息」这类外部素材指引。故消息 = system（common_system_prompt）+
 * user（渲染后的任务指令）= **2 条**；若拆成 3 条（把素材单独喂一条 user）会让
 * 输入出现两次或把指令与素材割裂。
 *
 * 【模板变量（3 个，与模板占位符逐一对应）】
 *  - `wikiSectionType`：**中文栏目名**（characters→人物 / factions→势力 /
 *    items→物品 / creatures→生物）。取值依据：模板措辞「统一 wikiSectionType」是给
 *    模型标注「本批对象同属一个 Wiki 栏目」的展示签；本仓提示词契约家族里该字段
 *    一律取中文栏目名（`chunk_wiki_draft_user_prompt.txt` 明示「wikiSectionType
 *    必须是人物/势力/物品之一」），且真实库 merge 产物实测 characters=人物 /
 *    factions=势力 / items=物品 / creatures=生物。我们的实体不带 wikiSectionType
 *    字段（draft 新模板不产），故由 feature 映射（映射表见 `WIKI_SECTION_TYPES`）。
 *  - `worldObjs`：该类目实体数组，**预序列化为 JSON 字符串**（JSON.stringify 带缩进）。
 *    理由：本仓 prompt-loader 的 `stringifyVar` 对 JS 数组是**换行拼接**而非 JSON
 *    序列化，传字符串才保 JSON 结构（与 draft 系 enabledSections 的裁定同 rationale）。
 *    传全量实体（含 summary/importanceLevel 等）——模板【判断依据】只承诺
 *    id/name/aliases/identInfos 必给，其余字段为模型提供额外上下文。
 *  - `identityMatchStopNames`：merge 产物顶层的停用名词表，同样预序列化为 JSON 字符串。
 *
 * 【inputText 与 L2 分批的关系（醒目）】
 * inputText 返回该类目实体数组的 JSON 文本（L2 据此估预算/切批）。单批（常规路径）
 * 时 worldObjs 是完整合法 JSON；**超大书目被多批切分时，按行切批会把 JSON 数组切成
 * 片段**（各批不再是完整 JSON）——此为模板「素材嵌指令」契约下的已知局限，跨批重复
 * 组由 `concat-dedup-order` + keyOf 去重（首现获胜）兜底。
 *
 * 【parse 契约（与 cacheWarming 同风格：返回值即 data，warnings 并入 data）】
 * 正常：`{mergeGroups:[{ids,reason}…], warnings:[…]}`。校验：`mergeGroups` 必须是
 * 数组；每组 `ids` 须为字符串数组且 **≥2 个**、`reason` 须为非空字符串——不满足的组
 * **跳过并进 warnings**（不抛崩；模板明令「每组至少两个不同对象 ID」）。
 * 兜底（缺 mergeGroups 键 / 非 JSON / 结构不符）：`{mergeGroups:null, warnings:[…],
 * raw: 原文截断}`（与 draft 系 `characters:null + raw` 同风格，保形状稳定）；
 * canonical 侧对 null 按「无合并组」处理。
 *
 * 合并策略：`concat-dedup-order` + 显式 `keyOf`（组按 ids **排序后** join('+')——
 * 组内顺序不影响语义（[A,B]≡[B,A]），排序保证跨批稳定，「重复组首现获胜」）。
 */
import type { ChatMessage, LlmTaskAdapter, TaskRuntime, UpstreamEntry } from '../../../shared/pipeline-types'
import { parseJsonLoose } from './cacheWarming'

/** 四大实体类目（与 task-registry 的 feature 字段一致）。 */
const CATEGORIES = ['characters', 'factions', 'items', 'creatures'] as const
type Category = (typeof CATEGORIES)[number]

/** 类目名集合（feature / id 后缀解析判定用）。 */
const CATEGORY_SET: ReadonlySet<string> = new Set<string>(CATEGORIES)

/**
 * feature → wikiSectionType 中文栏目名（取值依据见文件头：模板措辞 + 本仓提示词
 * 契约家族 + 真实库 merge 产物实测三类证据一致）。
 */
const WIKI_SECTION_TYPES: Readonly<Record<Category, string>> = {
  characters: '人物',
  factions: '势力',
  items: '物品',
  creatures: '生物'
}

/**
 * 确定本次实例的实体类目：优先 `rt.task.feature`（注册表 4 条 TaskDef 均带）；
 * 取不到则从任务 id 的冒号后缀解析（`mergeReview:<cat>`）——正常路径走 feature，
 * 后缀解析只为合成 rt/老数据兜底。
 */
function featureOf(rt: TaskRuntime): Category {
  const feature = rt.task?.feature
  if (typeof feature === 'string' && CATEGORY_SET.has(feature)) return feature as Category
  const m = /:([a-z]+)$/.exec(rt.task?.id ?? '')
  if (m && CATEGORY_SET.has(m[1])) return m[1] as Category
  throw new Error(`mergeReview 无法确定实体类目（task.feature=${String(feature)}，task.id=${String(rt.task?.id)}）——注册表 4 键均带 feature，请检查 rt.task`)
}

/** 读上游产物条目（未挂 readUpstream → 可读错误）。 */
async function readUpstreamEntries(rt: TaskRuntime, taskId: string): Promise<UpstreamEntry[]> {
  if (typeof rt.readUpstream !== 'function') {
    throw new Error(`mergeReview 需要 merge 产物（${taskId}）：运行期未提供 readUpstream（rt 须由编排器 makeRuntime 构造）`)
  }
  return rt.readUpstream(taskId)
}

/** 产物值双形态兼容（本流水线 `{data,…}` 信封 / 真实库老数据裸 data）。 */
function dataObject(value: unknown): Record<string, unknown> | null {
  const d = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).data : undefined
  const body = d !== undefined && d !== null ? d : value
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
}

/** 读 merge 主条目（key 以 `:merge` 结尾；双形态值）。 */
async function readMergeEntry(rt: TaskRuntime): Promise<{ data: Record<string, unknown> } | null> {
  const entries = await readUpstreamEntries(rt, 'merge')
  for (const e of entries) {
    if (!/:merge$/.test(e.key)) continue
    const data = dataObject(e.value)
    if (data) return { data }
  }
  return null
}

export const mergeReviewAdapter: LlmTaskAdapter = {
  id: 'mergeReview',
  mergeStrategy: 'concat-dedup-order',
  keyOf: mergeReviewKeyOf,

  async inputText(rt: TaskRuntime): Promise<string> {
    const cat = featureOf(rt)
    const entry = await readMergeEntry(rt)
    const list = entry && Array.isArray(entry.data[cat]) ? (entry.data[cat] as unknown[]) : null
    if (!list || list.length === 0) {
      throw new Error(`mergeReview:${cat} 需要 merge 产物（records/results/merge.json 中 :merge 主条目的 ${cat} 数组）——当前缺失或为空`)
    }
    // 预序列化为 JSON 字符串（缩进 2，保结构；prompt-loader 对字符串变量原样注入）
    return JSON.stringify(list, null, 2)
  },

  async buildMessages(batchText: string, rt: TaskRuntime): Promise<ChatMessage[]> {
    const cat = featureOf(rt)
    const system = await rt.render('common_system_prompt', {})
    // stopNames 同样预序列化（merge 顶层 identityMatchStopNames；缺失 → 空数组）
    const entry = await readMergeEntry(rt)
    const stopNames = entry && Array.isArray(entry.data.identityMatchStopNames) ? entry.data.identityMatchStopNames : []
    const instruction = await rt.render('wiki_entity_merge_review_user_prompt', {
      wikiSectionType: WIKI_SECTION_TYPES[cat],
      worldObjs: batchText,
      identityMatchStopNames: JSON.stringify(stopNames, null, 2)
    })
    // 模板把三个变量全部嵌在指令里（无外部素材消息）→ system + user(指令) = 2 条
    return [
      { role: 'system', content: system },
      { role: 'user', content: instruction }
    ]
  },

  parse(content: string): unknown {
    const obj = parseJsonLoose(content)
    const warnings: string[] = []
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && Array.isArray((obj as Record<string, unknown>).mergeGroups)) {
      const groups: { ids: string[]; reason: string }[] = []
      for (const g of (obj as Record<string, unknown>).mergeGroups as unknown[]) {
        if (!g || typeof g !== 'object' || Array.isArray(g)) {
          warnings.push('mergeReview：跳过非对象合并组')
          continue
        }
        const go = g as Record<string, unknown>
        const ids = Array.isArray(go.ids) ? go.ids.filter((x): x is string => typeof x === 'string' && x.length > 0) : []
        const reason = typeof go.reason === 'string' ? go.reason.trim() : ''
        if (ids.length < 2) {
          warnings.push(`mergeReview：跳过 ids 不足 2 个的合并组（${JSON.stringify(go.ids ?? null)}）`)
          continue
        }
        if (!reason) {
          warnings.push(`mergeReview：跳过缺 reason 的合并组（ids=${ids.join('+')}）`)
          continue
        }
        groups.push({ ids, reason })
      }
      return { mergeGroups: groups, warnings }
    }
    // 兜底（缺 mergeGroups 键 / 非 JSON / 结构不符）：不抛崩，保留原文截断供排查
    return {
      mergeGroups: null,
      warnings: ['mergeReview：输出缺 mergeGroups 键或非 JSON，走 raw 兜底'],
      raw: (content ?? '').slice(0, 500)
    }
  }
}

/**
 * 合并组的稳定键（供 `concat-dedup-order` 的 dedupeDeep 用）。
 *
 * 组按 `ids` **排序后** join('+')：组内顺序不影响语义（[A,B] 与 [B,A] 是同一组），
 * 排序保证同一组在不同批次/不同模型输出顺序下键一致，「跨批重复组首现获胜」才成立。
 * 字符串元素（warnings 形态）给 `warn:` 前缀避免与组相消。
 */
export function mergeReviewKeyOf(part: unknown): string {
  if (typeof part === 'string') return `warn:${part}`
  if (part && typeof part === 'object' && !Array.isArray(part)) {
    const ids = (part as Record<string, unknown>).ids
    if (Array.isArray(ids)) {
      const stable = ids
        .filter((x): x is string => typeof x === 'string')
        .slice()
        .sort()
        .join('+')
      if (stable) return `group:${stable}`
    }
  }
  try {
    return JSON.stringify(part)
  } catch {
    return String(part)
  }
}

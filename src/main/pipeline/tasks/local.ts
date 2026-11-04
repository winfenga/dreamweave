/**
 * 本地程序步骤（`model:false` · 设计 §6.3）—— T6-E 实体合并链真实语义化。
 *
 * 三条步骤与 LLM 适配器 `./mergeReview.ts` 组成实体合并链：
 * ```
 * draft / draftCharacter / draftOther（per-chunk 草稿，T6-D）
 *   → merge（本文件·global）        机械合并：同名/别名相交 → 组，组内字段归并
 *   → mergeReview:characters|factions|items|creatures（LLM，见 ./mergeReview.ts）
 *   → canonical（本文件·global）    应用复核合并组 → 唯一标准实体 + 全量 ID 映射
 *   → draftAlign（本文件·per-chunk）把本片草稿对齐到 canonical 实体 ID
 * ```
 *
 * **语义：绝不构造请求、绝不调用 fetch**（B-P0-3）。编排器为它们写 `tasks` 状态
 * `status:'local'`，产物信封为 `{data, local:true, warnings, at}`（orchestrator 统一
 * 写）——故本文件各步骤**只返回纯 data**（M2 骨架曾把 local/taskId/kind/instanceKey
 * 塞进 data，本批纠正：真实库 merge/canonical 的 value 就是纯数据，view.ts 的
 * `unwrap()` 也按「data 非空才下钻」消费，见 `src/main/t2w/view.ts:145`）。
 *
 * ---------------------------------------------------------------------------
 * 【draftId 分配规则（merge 分配与 draftAlign 重算共用的确定性规则）】
 * 第 `i` 个 chunk 的第 `n` 个类目实体 → `D-{i}-{cat}-{n}`；人物的 cat 段为单字母
 * `C`，其余用全类目名（对齐真实数据 `D-0-C-0` / `D-1-creatures-2`，实测于真实库
 * `1dc7a26d`）。T6-D 的 draft 适配器 parse **不产 id**（拿不到 chunkIndex），故 id
 * 由 merge 统一分配；draftAlign 输入只有本片草稿（无 id），用**同一规则按位置重算**
 * 才能查 canonical 的 mapping（mapping 以 draftId 为键）。
 * **约束（文件头醒目）：同一 run 内 draft 产物数组顺序必须稳定**——readUpstream 按
 * 信封插入序返回（per-chunk 任务同分片内即 chunk 序），updateShard 按 instanceKey
 * upsert 不重排，故「第 n 个」在 merge 与 draftAlign 两次计算中必然一致。
 *
 * ---------------------------------------------------------------------------
 * 【merge 分组规则（并查集，同类目内；两条实体相连当且仅当）】
 *  ① `name` 相等——**永远算数，即使命中 identityMatchStopNames**；
 *  ② 双方 `aliases` 相交——先从双方 aliases 中剔除 stopNames；
 *  ③ 一方 `name` ∈ 另一方 `aliases`——同样先剔 stopNames。
 * 以上规则经真实库 `1dc7a26d` 全量对拍：**220/220 组逐一复现**（characters 91 /
 * factions 30 / items 76 / creatures 23，分区完全一致）。
 *
 * 【aliases 两代形状（真实库实证）】
 *  - 字符串数组（本仓新模板契约，T6-D 起）；
 *  - 对象数组 `[{alias,type}]`（老数据，如 `[{"alias":"小梦","type":"昵称"}]`）。
 * 相交/包含判断前统一归一为字符串集合（对象取 `alias` 字段）；输出并集**保留原始
 * 元素形状**，去重按 **alias 值**（首现获胜，按 chunk 序）——真实库对拍显示老数据
 * 中同 alias 不同 type 并存时只保留首条（如「莱姆/简称」与「莱姆/别称」只留前者），
 * 故按值去重而非 (alias,type) 二元组（T6-E spec 文本写「二元组」，实测数据为按值，
 * 从实测；二元组口径会在 15 处字段上与真实库不符）。
 *
 * ---------------------------------------------------------------------------
 * 【merge 组内字段规则（真实库 220/220 字段级复现）】
 *  - `id`（keepId）= 组内 `(chunkIndex, 组内序号n)` 最小者；
 *  - `draftIds` = 组内全部 draftId，按 (chunkIndex, n) 升序；
 *  - `chunkSummaryList` = `[{chunkIndex, summaryText: 该 draft 的 summary}]`，按
 *    chunkIndex 升序（同 chunk 多条全留——同 chunk 多实体并入时自然有多条）；
 *  - `identInfos` = 按 chunk 序的并集保序去重（按元素 JSON 值）；
 *  - `aliases` = 并集保序去重（按 alias 值，见上）；
 *  - `summary` = **最新 chunk 那条的 summary**（不拼接；同 chunk 并列时取序号大者
 *    ——真实库对拍口径）；
 *  - `importanceLevel` = 组内最高（rank：CORE>HIGH>MEDIUM>LOW>TEMP；未预见非空值
 *    排在 TEMP 之后、空值之前；全空 → 空串）；
 *  - `lifeStatus` = **最新非空**（样本无法区分「最新 chunk 非空」与「全局最新非空」，
 *    注释标注推断：从最新 chunk 往前取首个非空；组内全空则**不设该键**——保持 keep
 *    实体的原始形状，对齐真实库非人物类目无 lifeStatus 键的实测）；
 *  - `characterSpriteInfos`（仅人物）= 各 draft 的按 chunk 序拼接，**每条打上来源
 *    chunkIndex**（对齐真实库 `{appearanceSummary, visualKeywords, sex, chunkIndex}`）；
 *  - 其余字段（name/wikiSectionType 等）取 keepId 实体的值；
 *  - 顶层 `identityMatchStopNames` = 全部 draft 的并集保序去重（分组即用该集合）。
 *
 * 【canonical 规则（merge + mergeReview → 唯一标准实体）】
 *  - 每类目应用 mergeReview 合并组：每组 `[id1,id2,…]` → keepId = **组内首个 id**；
 *    被合并实体从 objects 移除；keep 实体：`draftIds` **尾部追加**被合并者的
 *    draftIds（不按 chunk 重排，按组内顺序）；`chunkSummaryList` 按 chunkIndex
 *    **合并升序**（稳定排序：同 chunkIndex 时 keep 实体条目在前）；`identInfos` /
 *    `aliases` 并集扩展（保序去重，两代形状兼容）；**`summary` 不重算**（保持 merge
 *    的值）；importanceLevel/lifeStatus 等保持 merge 的值；
 *  - `mapping` = **全部 draftId → 最终实体 id**：先恒等（所有实体自身 id + 其
 *    draftIds 中非自身的也指向自身），再应用合并（被合并者的 draftIds 与自身 id →
 *    keepId）。真实库对拍：357/357 条映射逐一复现；
 *  - 顶层 `identityMatchStopNames` 从 merge 透传。
 *
 * 【draftAlign 规则（per-chunk，rt.chunkIndex = i）】
 *  - 输入：`rt.readUpstream('draft')` 中 key 以 `:draft:${i}` 结尾的条目（**只取本
 *    chunk**）+ `rt.readUpstream('canonical')` 的 `data.mapping` / `data.objects`；
 *  - 对每个实体按位置重算 draftId（与 merge 同一规则）→ 查 mapping：
 *     · 命中（mapping[draftId] ≠ draftId）：`id` 改写为 canonical id；`aliases`
 *       **整体替换为 canonical 实体（objects[cat] 中 id=映射值的那条）的 aliases**；
 *       `draftIds` 收缩为 `[本片 draftId]`；
 *     · 未命中：实体原样，`id` = 自身 draftId；同样补 `draftIds=[自身]`（与命中
 *       分支对称——真实库 draftAlign 实体均带 `draftIds=[本片 id]`）；
 *  - 其余字段一律保留本片值：summary、identInfos、importanceLevel、lifeStatus、
 *    name、wikiSectionType；`characterSpriteInfos` 每条打上本片 chunkIndex；
 *    `chunkSummaryList` **重建为** `[{chunkIndex:i, summaryText: 本片 summary}]`；
 *  - 输出 `{characters, factions, items, creatures}`（**无** identityMatchStopNames
 *    ——对齐真实库 draftAlign 产物形状）。
 *
 * ---------------------------------------------------------------------------
 * 【降级行为清单（均不抛崩， warning 进 rt.warnings → 信封 warnings）】
 *  1. merge：draft 无实体产物 → 回退 draftCharacter（只取 characters）+
 *     draftOther（factions/items/creatures）（新项目拆分模式）；仍无 → 四类空数组 +
 *     identityMatchStopNames:[] + warning；
 *  2. merge：同 chunk 多条 draft 产物 → 取首条 + warning；
 *  3. canonical：merge 产物缺失 → `{objects:{四类空+stopNames:[]}, mapping:{}}` +
 *     warning；
 *  4. canonical：mergeReview 合并组 id 不在 merge 产物中 / 已被合并 → 跳过该 id 或
 *     该组 + warning；`:plan` 等变体条目（key 不以类目结尾）自动过滤；
 *  5. draftAlign：本 chunk 无 draft 产物 → 四类空 + warning；canonical 缺失或
 *     mapping 空 → 全部原样（id 用重算的自身 draftId）+ warning；映射命中但
 *     canonical objects 中无对应实体 → aliases 保留本片值 + warning。
 *
 * 【与 merge.ts 的分界（醒目）】
 * `src/main/pipeline/merge.ts` 是 L2 **分批合并引擎**（mergeOutputs/combineFirst），
 * 与本地步骤「merge」**同名不同物**。本文件的实体合并是专用逻辑：combineFirst 对
 * 标量取首非空（→summary 会错）、数组拼接不去重、importanceLevel 不按 rank——
 * 故禁止复用，全部规则在本文件内实现（已列于上）。
 *
 * ===========================================================================
 * 【event 步骤（D1 方案：纯程序零 LLM）】
 *
 * 真实生态的 `event` 是四阶段状态机（framework → L4 分批 → batch → merge），本引擎装
 * 不下；但真实库 `15de5d4f/records/results/event.json` 的产物**本身就是机械结构**
 * （aggregates 11 = 1 个 L1 + 10 个 L2；atomics 26 = 26 个 L4；memberships 36 = 10 + 26），
 * 故 D1 方案不构造任何请求，全部由 seg / plot 产物机械派生。注册表把 `event` 改为
 * `model:false`（走编排器本地步骤分支）+ `global:true`（全书一张图，对齐真实库只有
 * 一条 `:event:finalize` 产物）。
 *
 * 【四层对应关系（真实库实测 → 本步骤）】
 *  - **L4**（atomics）= seg 的每个叙事段：name/summary 原样搬（seg 模板的中文契约
 *    `{起始行号,结束行号,name,summary}`），`chapterSeq` 取所在章、`chunkIndex` 取来源
 *    chunk、`segmentId` 由程序编（见下）；
 *  - **L2**（aggregates）= 每章一个：name 取 chapters 分片的章标题（读不到回退
 *    `第{seq}章`），summary 取 plot 的 `chapterSummary`（缺失则由该章全部 L4 摘要以
 *    「。」拼接并截断 800 字）；
 *  - **L1**（aggregates）= 全书一个：name 取书名 `rt.title`（缺失回退「全书」），summary
 *    由全部 L4 摘要拼接截断 800 字；
 *  - **L3**：不产出（真实库同样没有 L3 —— 层级是 1/2/4 三档）。
 * 归属（memberships）按章号机械匹配：`E-main → E-ch-{seq}` 每章一条，`E-ch-{seq} →
 * E-beat-{n}` 每条 L4 一条。
 *
 * 【与真实库的对齐点】
 *  - 三层 id 命名同构：`E-main` / `E-ch-{章号}` / `E-beat-{全局序号}`；
 *  - 元素字段集同构（aggregates `{id,level,l1Id,name,summary,chapterSeqs}`、atomics
 *    `{id,level,name,summary,segmentId,chapterSeq,chunkIndex,l1Id}`、memberships
 *    `{parentId,childId}`），输出**只有** `aggregates/atomics/memberships` 三个键
 *    （`warnings` 仅在确有告警时附带）；
 *  - 顺序同构：aggregates 首个即 L1、其后按章号升序；atomics 按 (chunkIndex, 章序,
 *    段序) 升序；memberships 先全部「根→章」再全部「章→段」。
 *
 * 【两处有意差异（务必知情，勿当 bug）】
 *  ① `segmentId` 用 `seg-{chunkIndex}-{段在 chunk 内的序号}`（真实库是全书简写
 *     `seg-1`/`seg-2`）。原因：真实库的简写编号跨 chunk 无法唯一复原来源，本引擎要
 *     让 segmentId 全局唯一且可由 (chunk, 段序) 反查；顺带与 plotLocation 的
 *     `L-{chunk}-l{n}` 编号风格一致。
 *  ② L1 的 `name` 用**书名**（`rt.title`），真实库是模型起的语义名（如「归航与陷阱」）。
 *     原因：零 LLM 无法生成语义名，用书名是唯一不臆造的选择；语义名要等日后接回
 *     LLM 的 event 阶段再谈。
 *
 * 【能力边界（诚实声明）】
 *  放弃**跨章语义聚合**：真实 event 的 L1/L2 摘要是模型对全书的语义归纳，本步骤只能
 *  把 L4 摘要机械拼接（L1 截断 800 字），因此拿不到「主线事件线」「伏笔回收」这类跨章
 *  信息。真实库那本书同样没有建立跨章事件线（10 个 L2 各自独立挂在 E-main 下、L1 仅
 *  一段总述），故此缺口与真实产物差距有限。
 *
 * 【降级行为清单（均不抛崩；warning 同时进 payload.warnings 与 rt.warnings）】
 *  1. `rt.readUpstream` 未挂载（非编排器构造的 rt）→ 抛可读错误（编排器保证挂载，
 *     此处宁可显式失败也不静默输出空树）；
 *  2. seg 无产物 / 产物无 `output.chapters` / 有 chapters 但无任何段 → 三个数组全空 +
 *     warning「event：工作库中没有任何 seg 产物，未生成事件树（请先运行 seg 任务）」；
 *  3. 同 chunkIndex 多条 seg 产物 → 取首条 + warning；
 *  4. 章条目缺有限 `chapterSeq` → 跳过该章 + warning（无法归属就不猜）；
 *  5. `rt.root` 缺失 / `records/chapters.json` 缺失或损坏 → 章标题空 Map，L2 名称
 *     回退 `第{seq}章` + warning，**不抛**；
 *  6. plot 无产物 → 章摘要 Map 为空，L2 摘要回退「该章 L4 摘要拼接」（合法路径，不告警）。
 *
 * 【依赖与幂等】本地步骤分支不检查 dependsOn（编排器只在 LLM 分支查），故本步骤自己
 * 读不到 seg 时降级而不抛；无随机性、无时间戳 —— 同输入必得同输出（可安全重跑）。
 */
import { readIndex } from '../../workspace/index-store'
import { readShard } from '../../workspace/shards'
import { CONTAINER_FILES } from '../../workspace/paths'
import type { LocalTaskStep, TaskRuntime, UpstreamEntry } from '../../../shared/pipeline-types'

// ---------------------------------------------------------------------------
// 常量与类型
// ---------------------------------------------------------------------------

/** 四大实体类目（数组顺序即输出键序）。 */
const CATEGORIES = ['characters', 'factions', 'items', 'creatures'] as const
type Category = (typeof CATEGORIES)[number]

/** 类目名集合（供 key 后缀解析判定）。 */
const CATEGORY_SET: ReadonlySet<string> = new Set<string>(CATEGORIES)

/** 重要性档位排名（真实库实测值域：CORE/HIGH/MEDIUM/LOW/TEMP）。 */
const IMPORTANCE_RANK: Readonly<Record<string, number>> = { CORE: 5, HIGH: 4, MEDIUM: 3, LOW: 2, TEMP: 1 }
/** 未预见非空值：排在 TEMP 之后、空值之前（仍胜过空值——空值不携带任何信息）。 */
const IMPORTANCE_RANK_UNKNOWN = 0
/** 空值：永远不获胜（除非全空 → 空串）。 */
const IMPORTANCE_RANK_EMPTY = -1

/** 一条 draft 产物记录（按 chunk 归集；data 已按类目摘好数组）。 */
interface DraftRecord {
  chunkIndex: number
  data: Record<string, unknown>
}

/** 参与分组的实体（携带位置信息与归一化后的名称）。 */
interface GroupedEntity {
  /** 来源 chunk 序号（id 分配与排序用） */
  chunkIndex: number
  /** 来源 chunk 内该类目的数组位置（id 分配与排序用） */
  n: number
  /** 按位置分配的确定性 draftId */
  draftId: string
  /** trim 后的 name（分组键） */
  name: string
  /** 规范化后的实体数据（name 非空；summary 缺省 ''） */
  raw: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

/** draftId 的类目段：人物用单字母 `C`，其余用全类目名（对齐真实数据 `D-0-C-0` / `D-1-creatures-2`）。 */
function catSegment(cat: Category): string {
  return cat === 'characters' ? 'C' : cat
}

/** 确定性 draftId：第 `chunkIndex` 个 chunk 的第 `n` 个类目实体（merge 分配与 draftAlign 重算共用）。 */
function draftIdOf(chunkIndex: number, cat: Category, n: number): string {
  return `D-${chunkIndex}-${catSegment(cat)}-${n}`
}

/** 读上游产物条目（未挂 readUpstream → 可读错误；rt 须由编排器 makeRuntime 构造）。 */
async function readUpstreamEntries(rt: TaskRuntime, taskId: string): Promise<UpstreamEntry[]> {
  if (typeof rt.readUpstream !== 'function') {
    throw new Error(`${taskId} 产物读取失败：运行期未提供 readUpstream（rt 须由编排器 makeRuntime 构造）`)
  }
  return rt.readUpstream(taskId)
}

/**
 * 产物值双形态兼容（实测）：本流水线 LLM/本地任务写 `{data,…}` 信封；真实库老数据
 * 直接是 data 本体（merge/canonical/draftAlign 均实测无 `.data` 层）。
 */
function unwrapData(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const d = (value as Record<string, unknown>).data
    if (d !== undefined && d !== null) return d
  }
  return value
}

/** 取产物 data 对象（非对象 → null）。 */
function dataObject(value: unknown): Record<string, unknown> | null {
  const d = unwrapData(value)
  return d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : null
}

/** 从 per-chunk 条目 key 解析 chunk 序号（`<pkg>:<rev>:<taskId>:<n>`）；不匹配 → null。 */
function chunkIndexOfKey(key: string, taskId: string): number | null {
  const m = new RegExp(`:${taskId}:(\\d+)$`).exec(key)
  return m ? Number(m[1]) : null
}

/** 字符串数组成员过滤（非字符串元素剔除；非数组 → `[]`）。 */
function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** 数组兜底（非数组 → `[]`）。 */
function arrayOf(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/** 元素稳定键（JSON 值；不可序列化 → String）。 */
function jsonKey(x: unknown): string {
  try {
    return JSON.stringify(x) ?? String(x)
  } catch {
    return String(x)
  }
}

/**
 * aliases 两代形状归一为字符串集合（相交/包含判断用）：
 *  - 字符串数组（新模板）：元素本身；
 *  - 对象数组 `[{alias,type}]`（老数据）：取 `alias` 字段。
 * 空白元素剔除；trim 后比较（老数据空格容忍）。
 */
function aliasStrings(v: unknown): string[] {
  const out: string[] = []
  for (const x of arrayOf(v)) {
    if (typeof x === 'string') {
      const s = x.trim()
      if (s) out.push(s)
      continue
    }
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      const a = (x as Record<string, unknown>).alias
      if (typeof a === 'string') {
        const s = a.trim()
        if (s) out.push(s)
      }
    }
  }
  return out
}

/**
 * aliases 并集去重键：字符串按值；对象按 `alias` 值（**非 (alias,type) 二元组**——
 * 真实库对拍口径：同 alias 不同 type 只留首条，见文件头「两代形状」节）。
 */
function aliasDedupKey(x: unknown): string {
  if (typeof x === 'string') return `s:${x}`
  if (x && typeof x === 'object' && !Array.isArray(x)) {
    const a = (x as Record<string, unknown>).alias
    if (typeof a === 'string') return `a:${a}`
  }
  return jsonKey(x)
}

/** 多列表并集保序去重（按 keyFn；列表顺序即优先序）。 */
function unionDedup(lists: unknown[][], keyFn: (x: unknown) => string): unknown[] {
  const seen = new Set<string>()
  const out: unknown[] = []
  for (const list of lists) {
    for (const x of list) {
      const k = keyFn(x)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(x)
    }
  }
  return out
}

/**
 * draft 实体轻量规范化（与 T6-D 适配器的 normalizeEntity 同规则，本文件自持副本）：
 *  - `name` 必填非空字符串（trim 后）——缺 → null（调用方跳过该条）；
 *  - `summary` 缺省 `''`；
 *  - `identInfos` / `aliases` **原样透传**（两代形状都由下游归一处理）；
 *  - 其余字段（importanceLevel / lifeStatus / characterSpriteInfos / wikiSectionType…）
 *    原样透传；**不分配** id/draftIds/chunkSummaryList（本步骤的职责）。
 */
function normalizeDraftEntity(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  if (!name) return null
  return {
    ...o,
    name,
    summary: typeof o.summary === 'string' ? o.summary : ''
  }
}

// ---------------------------------------------------------------------------
// 并查集（分组）
// ---------------------------------------------------------------------------

/** 路径压缩 + 按大小合并的并查集（分组规模 = 全书实体数，近线性）。 */
class UnionFind {
  private readonly parent: number[]

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i)
  }

  find(x: number): number {
    let root = x
    while (this.parent[root] !== root) root = this.parent[root]
    // 路径压缩
    let cur = x
    while (this.parent[cur] !== root) {
      const next = this.parent[cur]
      this.parent[cur] = root
      cur = next
    }
    return root
  }

  union(a: number, b: number): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent[rb] = ra
  }
}

// ---------------------------------------------------------------------------
// merge：分组 + 组内字段构造
// ---------------------------------------------------------------------------

/**
 * 同类目内分组（三条连线规则见文件头）。
 *
 * 索引化实现（O(N·A)）：name 桶（规则①，不过滤 stopNames）+ alias 桶（规则②/③，
 * 建桶时即剔除 stopNames）+ 每个实体用自身 name 反查 alias 桶（规则③）。
 *
 * @param stopNames 顶层 identityMatchStopNames 集合（分组用）
 * @returns 群组列表；**组内按 (chunkIndex, n) 升序**（首个即 keepId 实体）
 */
function groupEntities(entities: GroupedEntity[], stopNames: ReadonlySet<string>): GroupedEntity[][] {
  const uf = new UnionFind(entities.length)
  const byName = new Map<string, number[]>()
  const byAlias = new Map<string, number[]>()
  entities.forEach((e, i) => {
    const nameBucket = byName.get(e.name)
    if (nameBucket) nameBucket.push(i)
    else byName.set(e.name, [i])
    for (const a of aliasStrings(e.raw.aliases)) {
      // 规则②/③：先从 aliases 中剔除 stopNames（规则①的 name 相等不过滤）
      if (stopNames.has(a)) continue
      const aliasBucket = byAlias.get(a)
      if (aliasBucket) aliasBucket.push(i)
      else byAlias.set(a, [i])
    }
  })
  // ① name 相等永远算数（即使命中 stopNames）
  for (const bucket of byName.values()) {
    for (let k = 1; k < bucket.length; k++) uf.union(bucket[0], bucket[k])
  }
  // ② 双方 aliases 相交（已剔 stopNames）
  for (const bucket of byAlias.values()) {
    for (let k = 1; k < bucket.length; k++) uf.union(bucket[0], bucket[k])
  }
  // ③ 一方 name ∈ 另一方 aliases（已剔 stopNames）
  for (let i = 0; i < entities.length; i++) {
    const bucket = byAlias.get(entities[i].name)
    if (bucket) for (const j of bucket) if (j !== i) uf.union(i, j)
  }
  const clusters = new Map<number, GroupedEntity[]>()
  entities.forEach((e, i) => {
    const root = uf.find(i)
    const c = clusters.get(root)
    if (c) c.push(e)
    else clusters.set(root, [e])
  })
  return [...clusters.values()].map((g) => g.slice().sort((a, b) => a.chunkIndex - b.chunkIndex || a.n - b.n))
}

/** 重要性档位排名（未知非空 → UNKNOWN；空 → EMPTY）。 */
function importanceRank(v: unknown): number {
  const value = typeof v === 'string' ? v.trim() : ''
  if (value === '') return IMPORTANCE_RANK_EMPTY
  return IMPORTANCE_RANK[value] ?? IMPORTANCE_RANK_UNKNOWN
}

/** 组内最高 importanceLevel（rank 最高者获胜，同 rank 取 chunk 序首个；全空 → ''）。 */
function bestImportance(group: GroupedEntity[]): string {
  let bestRank = IMPORTANCE_RANK_EMPTY
  let bestValue = ''
  for (const e of group) {
    const value = typeof e.raw.importanceLevel === 'string' ? (e.raw.importanceLevel as string).trim() : ''
    const rank = importanceRank(e.raw.importanceLevel)
    if (rank > bestRank) {
      bestRank = rank
      bestValue = value
    }
  }
  return bestValue
}

/**
 * 组内最新非空 lifeStatus（从最新 chunk 往前扫；样本无法区分，推断口径见文件头）。
 * 组内全空 → null（调用方不设该键，保持 keep 实体原始形状）。
 */
function latestLifeStatus(group: GroupedEntity[]): string | null {
  for (let k = group.length - 1; k >= 0; k--) {
    const v = group[k].raw.lifeStatus
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return null
}

/** 人物形象按 chunk 序拼接，每条打上来源 chunkIndex（仅人物）。 */
function concatSpriteInfos(group: GroupedEntity[]): unknown[] {
  const out: unknown[] = []
  for (const e of group) {
    for (const s of arrayOf(e.raw.characterSpriteInfos)) {
      out.push(s && typeof s === 'object' && !Array.isArray(s) ? { ...(s as Record<string, unknown>), chunkIndex: e.chunkIndex } : s)
    }
  }
  return out
}

/** 组内字段归并，产出 merge 实体（字段规则见文件头；组内已按 (chunkIndex, n) 升序）。 */
function buildMergedEntity(group: GroupedEntity[], cat: Category): Record<string, unknown> {
  const keep = group[0]
  const latest = group[group.length - 1]
  const out: Record<string, unknown> = {
    ...keep.raw,
    id: keep.draftId,
    draftIds: group.map((e) => e.draftId),
    chunkSummaryList: group.map((e) => ({ chunkIndex: e.chunkIndex, summaryText: e.raw.summary })),
    identInfos: unionDedup(
      group.map((e) => arrayOf(e.raw.identInfos)),
      jsonKey
    ),
    aliases: unionDedup(
      group.map((e) => arrayOf(e.raw.aliases)),
      aliasDedupKey
    ),
    summary: latest.raw.summary,
    importanceLevel: bestImportance(group)
  }
  const lifeStatus = latestLifeStatus(group)
  if (lifeStatus !== null) out.lifeStatus = lifeStatus
  if (cat === 'characters') out.characterSpriteInfos = concatSpriteInfos(group)
  return out
}

// ---------------------------------------------------------------------------
// 上游读取（draft / merge / mergeReview / canonical）
// ---------------------------------------------------------------------------

/**
 * 归集某 per-chunk 任务的产物记录（按 chunk 序号升序；同 chunk 多条 → 取首条 +
 * warning）。只摘 `cats` 指定的类目数组与 identityMatchStopNames。
 */
async function collectRecords(rt: TaskRuntime, taskId: string, cats: readonly Category[]): Promise<DraftRecord[]> {
  const entries = await readUpstreamEntries(rt, taskId)
  const byChunk = new Map<number, Record<string, unknown>>()
  for (const e of entries) {
    const ci = chunkIndexOfKey(e.key, taskId)
    if (ci === null) continue // 非 per-chunk 主条目（如 :batch: 变体）不参与
    if (byChunk.has(ci)) {
      rt.warnings.push(`merge：chunk ${ci} 出现多条 ${taskId} 产物，取首条`)
      continue
    }
    const data = dataObject(e.value)
    if (!data) continue
    const picked: Record<string, unknown> = {}
    for (const c of cats) picked[c] = Array.isArray(data[c]) ? data[c] : []
    if (Array.isArray(data.identityMatchStopNames)) picked.identityMatchStopNames = data.identityMatchStopNames
    byChunk.set(ci, picked)
  }
  return [...byChunk.entries()]
    .map(([chunkIndex, data]) => ({ chunkIndex, data }))
    .sort((a, b) => a.chunkIndex - b.chunkIndex)
}

/**
 * 读全部 draft 产物记录；draft 无实体时回退 draftCharacter（只取 characters）+
 * draftOther（factions/items/creatures）——新项目拆分模式（老项目由程序步骤
 * `draft:{i}` 汇总，本流水线无该接线，T6-E 起由本回退承担）。
 */
async function readDraftRecords(rt: TaskRuntime): Promise<DraftRecord[]> {
  const primary = await collectRecords(rt, 'draft', CATEGORIES)
  const hasEntities = primary.some((r) => CATEGORIES.some((c) => arrayOf(r.data[c]).length > 0))
  if (hasEntities) return primary
  rt.log('merge：draft 无实体产物，回退 draftCharacter + draftOther（拆分模式）')
  const dc = await collectRecords(rt, 'draftCharacter', ['characters'])
  const dOther = await collectRecords(rt, 'draftOther', ['factions', 'items', 'creatures'])
  const byChunk = new Map<number, DraftRecord>()
  for (const rec of dc) {
    byChunk.set(rec.chunkIndex, {
      chunkIndex: rec.chunkIndex,
      data: { characters: rec.data.characters ?? [], identityMatchStopNames: rec.data.identityMatchStopNames ?? [] }
    })
  }
  for (const rec of dOther) {
    const cur = byChunk.get(rec.chunkIndex)
    if (cur) {
      cur.data.factions = rec.data.factions ?? []
      cur.data.items = rec.data.items ?? []
      cur.data.creatures = rec.data.creatures ?? []
    } else {
      byChunk.set(rec.chunkIndex, {
        chunkIndex: rec.chunkIndex,
        data: { factions: rec.data.factions ?? [], items: rec.data.items ?? [], creatures: rec.data.creatures ?? [] }
      })
    }
  }
  return [...byChunk.values()].sort((a, b) => a.chunkIndex - b.chunkIndex)
}

/** 读 merge 主条目（key 以 `:merge` 结尾；双形态值）。缺失 → null。 */
async function readMergeData(rt: TaskRuntime): Promise<Record<string, unknown> | null> {
  const entries = await readUpstreamEntries(rt, 'merge')
  for (const e of entries) {
    if (!/:merge$/.test(e.key)) continue // 只取主条目（global 无 chunk 后缀；:batch: 等变体防御性排除）
    const data = dataObject(e.value)
    if (data) return data
  }
  return null
}

/**
 * 读 mergeReview 各类目合并组（key 形如 `<pkg>:<rev>:mergeReview:<cat>`）。
 * `:plan` 等变体条目 key 不以类目结尾 → 自动过滤（真实库实测 mergeReview:characters:plan
 * 与主条目并存）；每类目多条 → 取首条 + warning。
 */
async function readReviewGroups(rt: TaskRuntime): Promise<Record<Category, string[][]>> {
  const out: Record<Category, string[][]> = { characters: [], factions: [], items: [], creatures: [] }
  const entries = await readUpstreamEntries(rt, 'mergeReview')
  const seen = new Set<Category>()
  for (const e of entries) {
    const m = /:mergeReview:([a-z]+)$/.exec(e.key)
    if (!m) continue // :plan 等变体（key 不以类目结尾）不参与
    const cat = m[1]
    if (!CATEGORY_SET.has(cat)) continue
    const category = cat as Category
    if (seen.has(category)) {
      rt.warnings.push(`canonical：mergeReview:${category} 出现多条产物，取首条`)
      continue
    }
    seen.add(category)
    const data = dataObject(e.value)
    const groups = data && Array.isArray(data.mergeGroups) ? data.mergeGroups : []
    out[category] = groups
      .map((g) => {
        const ids = g && typeof g === 'object' && !Array.isArray(g) ? stringArray((g as Record<string, unknown>).ids) : []
        return ids.filter((x) => x.length > 0)
      })
      .filter((ids) => ids.length >= 2) // 不足 2 个 id 的组是 no-op，直接丢弃
  }
  return out
}

/** 读 canonical 主条目（key 以 `:canonical` 结尾）。缺失 → null。 */
async function readCanonicalData(rt: TaskRuntime): Promise<{ objects: Record<string, unknown>; mapping: Record<string, string> } | null> {
  const entries = await readUpstreamEntries(rt, 'canonical')
  for (const e of entries) {
    if (!/:canonical$/.test(e.key)) continue
    const data = dataObject(e.value)
    if (!data) continue
    const objs = data.objects
    const mp = data.mapping
    return {
      objects: objs && typeof objs === 'object' && !Array.isArray(objs) ? (objs as Record<string, unknown>) : {},
      mapping: mp && typeof mp === 'object' && !Array.isArray(mp) ? (mp as Record<string, string>) : {}
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// canonical：合并组应用
// ---------------------------------------------------------------------------

/** chunkSummaryList 条目的 chunkIndex（缺失 → 0，排序兜底）。 */
function summaryChunkIndex(x: unknown): number {
  if (x && typeof x === 'object' && !Array.isArray(x)) {
    const c = (x as Record<string, unknown>).chunkIndex
    if (typeof c === 'number' && Number.isFinite(c)) return c
  }
  return 0
}

/**
 * chunkSummaryList 按 chunkIndex 合并升序（稳定排序：同 chunkIndex 时 keep 实体条目
 * 在前——keep 的列表整体拼在被合并者之前，Array.prototype.sort 稳定）。
 */
function mergeChunkSummaries(keep: unknown, me: unknown): unknown[] {
  return [...arrayOf(keep), ...arrayOf(me)].sort((a, b) => summaryChunkIndex(a) - summaryChunkIndex(b))
}

/** 在 canonical objects[cat] 中按 id 找实体（防御：非数组/未命中 → null）。 */
function findCanonicalEntity(objects: Record<string, unknown>, cat: Category, id: string): Record<string, unknown> | null {
  for (const e of arrayOf(objects[cat])) {
    if (e && typeof e === 'object' && !Array.isArray(e) && (e as Record<string, unknown>).id === id) {
      return e as Record<string, unknown>
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 三条本地步骤
// ---------------------------------------------------------------------------

export const mergeStep: LocalTaskStep = {
  id: 'merge',
  async run(rt: TaskRuntime): Promise<unknown> {
    rt.log('本地步骤 merge：机械合并实体草稿（不发请求）')
    const records = await readDraftRecords(rt)
    if (records.length === 0) {
      rt.warnings.push('merge：draft 产物为空（回退 draftCharacter/draftOther 后仍无实体）——输出四类空数组')
    }
    // 顶层 identityMatchStopNames = 全部 draft 的并集保序去重（分组即用该集合）
    const stopNames: string[] = []
    const stopSeen = new Set<string>()
    for (const rec of records) {
      for (const s of stringArray(rec.data.identityMatchStopNames)) {
        const t = s.trim()
        if (!t || stopSeen.has(t)) continue
        stopSeen.add(t)
        stopNames.push(t)
      }
    }
    const stopSet = new Set(stopNames)
    const out: Record<string, unknown[]> = {}
    for (const cat of CATEGORIES) {
      const entities: GroupedEntity[] = []
      for (const rec of records) {
        arrayOf(rec.data[cat]).forEach((raw, n) => {
          const e = normalizeDraftEntity(raw)
          if (!e) return
          // normalizeDraftEntity 已保证 name 为非空字符串
          entities.push({ chunkIndex: rec.chunkIndex, n, draftId: draftIdOf(rec.chunkIndex, cat, n), name: e.name as string, raw: e })
        })
      }
      const merged = groupEntities(entities, stopSet).map((g) => ({
        entity: buildMergedEntity(g, cat),
        chunkIndex: g[0].chunkIndex,
        n: g[0].n
      }))
      // 每类按 keepId 的 (chunk, n) 数值升序（注意 D-0-C-10 与 D-0-C-2 要数值比，
      // 不能字符串比——字符串序会把 D-0-C-10 排到 D-0-C-2 前面）
      merged.sort((a, b) => a.chunkIndex - b.chunkIndex || a.n - b.n)
      out[cat] = merged.map((m) => m.entity)
    }
    return { ...out, identityMatchStopNames: stopNames }
  }
}

export const canonicalStep: LocalTaskStep = {
  id: 'canonical',
  async run(rt: TaskRuntime): Promise<unknown> {
    rt.log('本地步骤 canonical：应用 mergeReview 合并组，产出唯一标准实体与 ID 映射（不发请求）')
    const mergeData = await readMergeData(rt)
    if (!mergeData) {
      rt.warnings.push('canonical：merge 产物缺失——输出空 objects 与空 mapping')
      return {
        objects: { characters: [], factions: [], items: [], creatures: [], identityMatchStopNames: [] },
        mapping: {}
      }
    }
    const reviewGroups = await readReviewGroups(rt)
    const objects: Record<string, unknown> = {}
    const mapping: Record<string, string> = {}
    for (const cat of CATEGORIES) {
      // 浅拷贝实体（嵌套数组一律以新数组替换，绝不原地改——避免污染 merge 产物对象）
      const list: Record<string, unknown>[] = []
      for (const e of arrayOf(mergeData[cat])) {
        if (e && typeof e === 'object' && !Array.isArray(e)) list.push({ ...(e as Record<string, unknown>) })
      }
      // mapping 第一步：恒等（所有实体自身 id + 其 draftIds 中非自身的也指向自身）
      for (const o of list) {
        const id = typeof o.id === 'string' ? o.id : ''
        if (!id) continue
        mapping[id] = id
        for (const d of stringArray(o.draftIds)) {
          if (d && d !== id) mapping[d] = id
        }
      }
      const byId = new Map<string, Record<string, unknown>>(list.map((o) => [String(o.id), o]))
      const removed = new Set<string>()
      // mapping 第二步：应用合并（被合并者的 draftIds 与自身 id → keepId）
      for (const group of reviewGroups[cat]) {
        const keepId = group[0]
        const keep = byId.get(keepId)
        if (!keep) {
          rt.warnings.push(`canonical：${cat} 合并组首个 id ${keepId} 不在 merge 产物中，跳过该组`)
          continue
        }
        if (removed.has(keepId)) {
          rt.warnings.push(`canonical：${cat} 合并组首个 id ${keepId} 已被并入其它实体，跳过该组`)
          continue
        }
        for (const mid of group.slice(1)) {
          const me = byId.get(mid)
          if (!me || me === keep) {
            rt.warnings.push(`canonical：${cat} 合并组 id ${mid} 不在 merge 产物中，跳过`)
            continue
          }
          if (removed.has(mid)) {
            rt.warnings.push(`canonical：${cat} 合并组 id ${mid} 已被其它组合并，跳过`)
            continue
          }
          removed.add(mid)
          // draftIds 尾部追加（不按 chunk 重排，按组内顺序）
          keep.draftIds = [...stringArray(keep.draftIds), ...stringArray(me.draftIds)]
          // chunkSummaryList 按 chunkIndex 合并升序（同 chunkIndex keep 条目在前）
          keep.chunkSummaryList = mergeChunkSummaries(keep.chunkSummaryList, me.chunkSummaryList)
          // identInfos / aliases 并集扩展（保序去重，两代形状兼容）
          keep.identInfos = unionDedup([arrayOf(keep.identInfos), arrayOf(me.identInfos)], jsonKey)
          keep.aliases = unionDedup([arrayOf(keep.aliases), arrayOf(me.aliases)], aliasDedupKey)
          // summary / importanceLevel / lifeStatus 等保持 merge 的值（不重算）
          for (const d of stringArray(me.draftIds)) {
            if (d) mapping[d] = keepId
          }
          mapping[mid] = keepId
        }
      }
      objects[cat] = list.filter((o) => !removed.has(String(o.id)))
    }
    objects.identityMatchStopNames = arrayOf(mergeData.identityMatchStopNames)
    return { objects, mapping }
  }
}

export const draftAlignStep: LocalTaskStep = {
  id: 'draftAlign',
  async run(rt: TaskRuntime): Promise<unknown> {
    rt.log('本地步骤 draftAlign：把本片草稿对齐到 canonical 实体 ID（不发请求）')
    const i = rt.chunkIndex
    if (i === null || i === undefined) {
      rt.warnings.push('draftAlign：chunkIndex 缺失（per-chunk 步骤不应出现）——输出四类空')
      return { characters: [], factions: [], items: [], creatures: [] }
    }
    // 本 chunk 的 draft 产物（只取 key 以 `:draft:${i}` 结尾的条目）
    const entries = await readUpstreamEntries(rt, 'draft')
    let data: Record<string, unknown> | null = null
    for (const e of entries) {
      if (!new RegExp(`:draft:${i}$`).test(e.key)) continue
      const d = dataObject(e.value)
      if (d) {
        data = d
        break
      }
    }
    if (!data) {
      rt.warnings.push(`draftAlign：chunk ${i} 无 draft 产物——输出四类空`)
      return { characters: [], factions: [], items: [], creatures: [] }
    }
    const canonical = await readCanonicalData(rt)
    if (!canonical) {
      rt.warnings.push('draftAlign：canonical 产物缺失——本片实体按原样输出（id 用重算的自身 draftId）')
    }
    const mapping = canonical?.mapping ?? {}
    const objects = canonical?.objects ?? {}
    const out: Record<string, unknown[]> = {}
    for (const cat of CATEGORIES) {
      const list: Record<string, unknown>[] = []
      arrayOf(data[cat]).forEach((raw, n) => {
        const e = normalizeDraftEntity(raw)
        if (!e) return
        // 按位置重算 draftId（与 merge 分配同一规则——同 run 内数组顺序稳定，必然一致）
        const selfId = draftIdOf(i, cat, n)
        const mapped = typeof mapping[selfId] === 'string' ? mapping[selfId] : ''
        const hit = mapped !== '' && mapped !== selfId
        const entity: Record<string, unknown> = {
          ...e,
          id: hit ? mapped : selfId,
          draftIds: [selfId]
        }
        // chunkSummaryList 重建为本片
        entity.chunkSummaryList = [{ chunkIndex: i, summaryText: e.summary }]
        // 人物形象每条打上本片 chunkIndex
        if (Array.isArray(e.characterSpriteInfos)) {
          entity.characterSpriteInfos = e.characterSpriteInfos.map((s) =>
            s && typeof s === 'object' && !Array.isArray(s) ? { ...(s as Record<string, unknown>), chunkIndex: i } : s
          )
        }
        if (hit) {
          // 命中：aliases 整体替换为 canonical 实体的 aliases（逐元素浅拷贝，避免共享引用）
          const canon = findCanonicalEntity(objects, cat, mapped)
          if (canon) {
            entity.aliases = arrayOf(canon.aliases).map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? { ...(x as Record<string, unknown>) } : x))
          } else {
            rt.warnings.push(`draftAlign：chunk ${i} ${cat} 实体 ${selfId} 映射到 ${mapped}，但 canonical objects 中无该实体——aliases 保留本片值`)
          }
        }
        list.push(entity)
      })
      out[cat] = list
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// event：纯程序事件树（D1 方案，规则全览见文件头）
// ---------------------------------------------------------------------------

/** 事件树 L1 根节点 id（全书唯一）。 */
const EVENT_ROOT_ID = 'E-main'

/** L1/L2 摘要的拼接截断上限（码点）。 */
const EVENT_SUMMARY_LIMIT = 800

/** event 唯一的降级提示语（无 seg 产物时原样写进 payload.warnings）。 */
const EVENT_NO_SEG_WARNING = 'event：工作库中没有任何 seg 产物，未生成事件树（请先运行 seg 任务）'

/** 一个 seg 叙事段（事件树 L4 的唯一来源）。 */
interface SegBeat {
  /** 来源 chunk 序号（ascending 排序与 segmentId 用） */
  chunkIndex: number
  /** 该段在来源 chunk 内的序号（跨章累计，0 基——segmentId 末段） */
  indexInChunk: number
  /** 所在章的原书章号 */
  chapterSeq: number
  /** seg 原文 name（可能为空串——组装时回退「片段{n}」） */
  name: string
  /** seg 原文 summary（非字符串 → ''） */
  summary: string
}

/** 有限数字（number 或数字字符串）；否则 null。 */
function finiteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** 按码点截断（避免切坏代理对）。 */
function truncateCodePoints(s: string, limit: number): string {
  const chars = Array.from(s)
  return chars.length > limit ? chars.slice(0, limit).join('') : s
}

/**
 * 多条摘要拼接（句间以「。」衔接）+ 按码点截断；空串剔除，全空 → ''。
 *
 * 衔接规则：前一段已以句末标点（`。！？…」』`）结尾时不再补「。」——否则中文摘要自身
 * 带句号会产生「。。」这种明显瑕疵（真实库同样是自然句子衔接）。单段时原样保留。
 */
function joinSummaries(parts: string[], limit: number): string {
  let out = ''
  for (const part of parts) {
    const t = part.trim()
    if (t === '') continue
    if (out === '') {
      out = t
      continue
    }
    out += /[。！？…」』]$/.test(out) ? t : `。${t}`
  }
  return truncateCodePoints(out, limit)
}

/**
 * 归集 seg 产物 → 扁平叙事段列表（按 chunkIndex 升序；chunk 内按章序、章内按段序）。
 *
 * 条目 key 形如 `<pkg>:<rev>:seg:<chunkIndex>`；解析不到 chunkIndex 的条目按**出现序**
 * 兜底编号（防御：老数据/变体条目）。同 chunkIndex 多条 → 取首条 + warning。
 * 产物值双形态：本流水线写 `{data:{output,warnings}}`，真实库老数据直接是
 * `{output,segments,warnings}` —— 统一经 `unwrapData` 解包。
 */
async function readSegBeats(rt: TaskRuntime, warnings: string[]): Promise<SegBeat[]> {
  const entries = await readUpstreamEntries(rt, 'seg')
  const chunks = new Map<number, unknown[]>()
  entries.forEach((e, order) => {
    const ci = chunkIndexOfKey(e.key, 'seg') ?? order
    if (chunks.has(ci)) {
      warnings.push(`event：chunk ${ci} 出现多条 seg 产物，取首条`)
      return
    }
    const data = dataObject(e.value)
    if (!data) return
    // 主路径 output.chapters（seg 适配器契约）；老数据缺 output 时退一层 data.chapters
    const output = data.output
    const chapters =
      output && typeof output === 'object' && !Array.isArray(output)
        ? arrayOf((output as Record<string, unknown>).chapters)
        : arrayOf(data.chapters)
    chunks.set(ci, chapters)
  })

  const beats: SegBeat[] = []
  for (const ci of [...chunks.keys()].sort((a, b) => a - b)) {
    const chapters = chunks.get(ci) ?? []
    // 段序在 chunk 内跨章累计（章与章之间有间隙时仍保持稳定编号）
    let segBase = 0
    for (const ch of chapters) {
      if (!ch || typeof ch !== 'object' || Array.isArray(ch)) continue
      const chapter = ch as Record<string, unknown>
      const segments = arrayOf(chapter.segments)
      const seq = finiteNumber(chapter.chapterSeq)
      if (seq === null) {
        warnings.push(`event：chunk ${ci} 有章条目缺少有效 chapterSeq，跳过该章（${segments.length} 段未纳入）`)
        segBase += segments.length
        continue
      }
      for (let j = 0; j < segments.length; j++) {
        const raw = segments[j]
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
        const o = raw as Record<string, unknown>
        beats.push({
          chunkIndex: ci,
          indexInChunk: segBase + j,
          chapterSeq: seq,
          name: typeof o.name === 'string' ? o.name : '',
          summary: typeof o.summary === 'string' ? o.summary : ''
        })
      }
      segBase += segments.length
    }
  }
  return beats
}

/**
 * 读 plot 产物的章摘要（`chapters[].chapterSummary`）→ `Map<chapterSeq, summary>`。
 * 同一章多条 → 首现获胜（章在全书唯一，仅防变体条目重复）；空摘要不登记（让 L2 走
 * 「L4 摘要拼接」回退）。
 */
async function readPlotChapterSummaries(rt: TaskRuntime): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const entries = await readUpstreamEntries(rt, 'plot')
  for (const e of entries) {
    const data = dataObject(e.value)
    if (!data) continue
    for (const raw of arrayOf(data.chapters)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const o = raw as Record<string, unknown>
      const seq = finiteNumber(o.chapterSeq)
      const summary = typeof o.chapterSummary === 'string' ? o.chapterSummary.trim() : ''
      if (seq === null || summary === '' || out.has(seq)) continue
      out.set(seq, summary)
    }
  }
  return out
}

/**
 * 读章标题（`records/chapters.json` 分片 `entries[].value.title`）→ `Map<chapterSeq, title>`。
 *
 * **全部失败路径都不抛**（L2 名称只是展示文案，缺了就回退 `第{seq}章`）：rt.root 未挂、
 * index.json 缺失/损坏、chapters 分片缺失/损坏 —— 统一 catch 成空 Map + 一条 warning。
 * 走 `readIndex` + `readShard`（而非直接读文件）是为了与工作库约定的读写口径保持一致。
 */
async function readChapterTitles(rt: TaskRuntime, warnings: string[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const root = typeof rt.root === 'string' ? rt.root : ''
  if (root === '') {
    warnings.push('event：运行期未提供 rt.root，L2 名称回退「第{seq}章」')
    return out
  }
  try {
    await readIndex(root) // 结构校验（损坏 → 走下方 catch）
    const env = await readShard(root, CONTAINER_FILES.chapters)
    for (const e of env.entries) {
      const v = e.value
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue
      const o = v as Record<string, unknown>
      const seq = finiteNumber(o.seq)
      const title = typeof o.title === 'string' ? o.title.trim() : ''
      if (seq === null || title === '' || out.has(seq)) continue
      out.set(seq, title)
    }
  } catch (e) {
    warnings.push(`event：章标题读取失败（${(e as Error).message}），L2 名称回退「第{seq}章」`)
  }
  return out
}

export const eventStep: LocalTaskStep = {
  id: 'event',
  async run(rt: TaskRuntime): Promise<unknown> {
    rt.log('本地步骤 event：由 seg/plot 产物机械派生全书事件树（不发请求）')
    if (typeof rt.readUpstream !== 'function') {
      throw new Error('event 产物读取失败：运行期未提供 readUpstream（rt 须由编排器 makeRuntime 构造）')
    }
    const warnings: string[] = []
    /** 收口：warning 双写（payload 供 view/导出看，rt.warnings 进持久化信封）。 */
    const finish = (payload: Record<string, unknown>): unknown => {
      for (const w of warnings) rt.warnings.push(w)
      return warnings.length > 0 ? { ...payload, warnings: warnings.slice() } : payload
    }

    // ---- ① L4 来源：seg 叙事段 ----
    const beats = await readSegBeats(rt, warnings)
    if (beats.length === 0) {
      warnings.push(EVENT_NO_SEG_WARNING)
      return finish({ aggregates: [], atomics: [], memberships: [] })
    }

    // ---- ② 章标题 / 章摘要 ----
    const titles = await readChapterTitles(rt, warnings)
    const chapterSummaries = await readPlotChapterSummaries(rt)

    // ---- ③ L4 atomics（全局 E-beat-{n} 连续编号；segmentId = seg-{chunk}-{段序}）----
    const atomics: Record<string, unknown>[] = []
    /** chapterSeq → 该章之下 L4 的 summary（按 beats 顺序，供 L2 摘要回退） */
    const summariesByChapter = new Map<number, string[]>()
    /** chapterSeq → 该章之下 L4 的 id（L2 存在性判定用） */
    const beatsByChapter = new Map<number, string[]>()
    /** 「章 → 段」归属边（按 beats 顺序；L1 摘要与 memberships 共用同一次遍历） */
    const beatEdges: { parentId: string; childId: string }[] = []
    const allSummaries: string[] = []
    beats.forEach((b, i) => {
      const n = i + 1
      const name = b.name.trim() !== '' ? b.name.trim() : `片段${n}`
      const id = `E-beat-${n}`
      atomics.push({
        id,
        level: 4,
        name,
        summary: b.summary,
        segmentId: `seg-${b.chunkIndex}-${b.indexInChunk}`,
        chapterSeq: b.chapterSeq,
        chunkIndex: b.chunkIndex,
        l1Id: EVENT_ROOT_ID
      })
      const list = beatsByChapter.get(b.chapterSeq)
      if (list) list.push(id)
      else beatsByChapter.set(b.chapterSeq, [id])
      const sums = summariesByChapter.get(b.chapterSeq)
      if (sums) sums.push(b.summary)
      else summariesByChapter.set(b.chapterSeq, [b.summary])
      beatEdges.push({ parentId: `E-ch-${b.chapterSeq}`, childId: id })
      allSummaries.push(b.summary)
    })

    // ---- ④ L2 aggregates（每章一个；章号升序）----
    const chapterSeqs = [...beatsByChapter.keys()].sort((a, b) => a - b)
    const chapterAggregates: Record<string, unknown>[] = chapterSeqs.map((seq) => {
      const title = (titles.get(seq) ?? '').trim()
      const plotSummary = chapterSummaries.get(seq) ?? ''
      return {
        id: `E-ch-${seq}`,
        level: 2,
        l1Id: EVENT_ROOT_ID,
        name: title !== '' ? title : `第${seq}章`,
        summary:
          plotSummary !== ''
            ? plotSummary
            : joinSummaries(summariesByChapter.get(seq) ?? [], EVENT_SUMMARY_LIMIT),
        chapterSeqs: [seq]
      }
    })

    // ---- ⑤ L1 aggregate（全书一个；放首位以对齐真实库 aggregates[0]）----
    const title = typeof rt.title === 'string' ? rt.title.trim() : ''
    const root: Record<string, unknown> = {
      id: EVENT_ROOT_ID,
      level: 1,
      l1Id: EVENT_ROOT_ID,
      name: title !== '' ? title : '全书',
      summary: joinSummaries(allSummaries, EVENT_SUMMARY_LIMIT),
      chapterSeqs
    }
    const aggregates: Record<string, unknown>[] = [root, ...chapterAggregates]

    // ---- ⑥ memberships（先全部「根→章」，再全部「章→段」）----
    const memberships: Record<string, unknown>[] = []
    for (const seq of chapterSeqs) {
      memberships.push({ parentId: EVENT_ROOT_ID, childId: `E-ch-${seq}` })
    }
    for (const e of beatEdges) memberships.push({ parentId: e.parentId, childId: e.childId })

    rt.log(`本地步骤 event：L1 1 + L2 ${chapterAggregates.length} + L4 ${atomics.length}，归属边 ${memberships.length}`)
    return finish({ aggregates, atomics, memberships })
  }
}

export const LOCAL_STEPS: LocalTaskStep[] = [mergeStep, canonicalStep, draftAlignStep, eventStep]

/** 四条本地步骤的 id（与 `model:false` 一一对应）。 */
export const LOCAL_TASK_IDS: readonly string[] = ['merge', 'canonical', 'draftAlign', 'event']

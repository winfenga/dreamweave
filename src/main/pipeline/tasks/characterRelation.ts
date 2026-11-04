/**
 * `characterRelation` 任务适配器（T6-H 第八批；模板 `character_relation_extract_user_prompt`）。
 *
 * 产物：`records/results/characterRelation.json`（per-chunk 任务每 chunk 一条目，key 形如
 * `<pkgId>:<revisionId>:characterRelation:<n>`；路由见 `../upstream.ts` 的
 * `matchesTaskFile` → 默认 `resultsShardFile('characterRelation')`）。
 * 消费端：view **不直接消费**——关系图谱投影见 `workspace/reproject.ts` 的
 * `entities/relations.json`（`{ file: 'entities/relations.json', taskId: 'characterRelation' }`）。
 *
 * 输入：**带行号原文**（与 cacheWarming/seg/plot/plotLocation/lineAnnotation 逐字同构：各章
 * 从 1 重新编号、每章外包 `【原文行：1-N】`；见 `../chunk-source` 的 `numberLines`）——
 * `inputText` 只产原文，其余模板变量在 `buildMessages` 现算（读上游组装一律在此做，parse 是
 * 同步函数，见 T6-F ① 接口约束）。
 *
 * 【模板变量（以模板实际占位符为准，逐字读过 `character_relation_extract_user_prompt.txt`）】共 5 个：
 *  - `chunkIndex` = `rt.chunkIndex ?? 0`；
 *  - `startChapterSeq` / `endChapterSeq` = **本 chunk 首章 / 末章 seq**（从 `rt.chunkChapters`
 *    推，单章时相等；缺 chunkChapters → 回退 1/1）。模板原文「章节范围：第{{{startChapterSeq}}}
 *    章到第{{{endChapterSeq}}}章」，配合「必须位于当前 chunk 内」的契约——模型据此把
 *    `fromChapterSeq`/`toChapterSeq` 落在范围里，parse 侧再做钳制兜底；
 *  - `chunkReadingMemory` = `renderMemory(buildReadingMemory(plot 产物, self))` 现算（同
 *    draft/plotLocation/lineAnnotation；plot 产物为空 → 空记忆，chunk 0 本就空，合法；
 *    未挂 readUpstream → 可读错误）；
 *  - `chunkCharacterWorldObjList` = **本片人物名单**：`rt.readUpstream('draftAlign')` 取 key
 *    末段数字 == self 的条目 → 双形态解包 `value?.data ?? value` → `characters` → 每人只留
 *    `{id, name, aliases}`（模板原文「characterA.name / characterB.name：使用人物名单中的
 *    标准 name；aliases 是别名字符串数组，用于辨认原文称呼」——人物形象/外貌与关系提取
 *    无关，不传）。`aliases` 两代形状归一成字符串数组（新契约字符串数组 / 老数据
 *    `[{alias,type}]` 对象数组）。**无 draftAlign 产物或无本片条目 → `'[]'` +
 *    `rt.warnings` 记一条，不抛**（模板人物名单只用于「标准 name 对照」，缺失仍可从原文
 *    提取；与 plotLocation 的 `characters` 同宽容口径）。
 *
 * 【为什么 buildMessages 发 3 条消息（与 locationTree 等的 2 条不同）】
 * 模板【输入】区只嵌变量，原文**不作变量嵌入**——模板原文：「当前 chunk 原文：前面的带行号
 * user 消息」。故原文必须单独作一条 user 消息先行喂入：system + user（带行号原文）+
 * user（渲染后的任务指令）= 3 条（与 plotLocation/lineAnnotation/draft 系同构）。
 *
 * 【parse：章序钳制 + 双方结构校验 + 程序补 chunkIndex（顺序不可乱）】
 *  1. `parseJsonLoose` → `characterRelations` 必须是数组（缺 → `{characterRelations:[],
 *     warnings, raw}` 兜底，不抛崩）；
 *  2. 逐条复制八项校验：
 *     - `fromChapterSeq` / `toChapterSeq` 需有限整数，**越出本 chunk 章序范围 → 钳到范围内 +
 *       warning（不是跳过）**——模板「必须位于当前 chunk 内」是模型侧的软约束，程序侧钳制
 *       保证产物自洽（一条范围越界的关系仍含有效正文信息，丢弃比钳制损失更大）；非有限整数
 *       → 回退范围端点 + warning；
 *     - `characterA` / `characterB` 各需 `{name: 非空字符串, relationToOther:{overview:string,
 *       summary:string}}`（结构不整 → **跳过该条** + warning；关系缺一方主体即不可用）；
 *       `overview` / `summary` 缺省 `''`；
 *     - `relationSummary` 字符串缺省 `''`；
 *     - 长度契约（`overview` ≤10 字 / `summary` ≤50 字 / `relationSummary` ≤300 字）：
 *       **只 warning 不截断**——模板措辞是「最多 N 字」，模型轻微超额不构成事实错误，
 *       截断反而会切坏句子（字数按码点计，中文一字一码点）；
 *     - A、B 的 `name` 相同 → 跳过 + warning（模板明令「不输出自己与自己的关系」）；
 *     - **程序补 `chunkIndex: rt?.chunkIndex ?? 0`**（对齐真实库产物每条第 9 个字段
 *       `chunkIndex`；模型不产此字段，由程序按实例归属写入）；
 *  3. 空数组是合法输出（模板明示「没有符合条件的关系时返回 {"characterRelations":[]}」）。
 *
 * 【与真实库 `5662f1d3` 的 `records/results/characterRelation.json` 逐字段对比结论】
 * 对齐：每 chunk 一条目；data 顶层 `{characterRelations:[…]}`（真实库还有 `warnings` 视
 * 模型是否产出）；条目字段集与顺序 `{fromChapterSeq, toChapterSeq, characterA:{name,
 * relationToOther:{overview, summary}}, characterB:{…}, relationSummary, chunkIndex}` 逐字一致；
 * `chunkIndex` 同为程序补齐的实例归属。
 * 有意差异：① 真实库 value 外包 `{data, responsePath, cacheReadyAt}`（persistence 信封，
 * 与适配器无关——parse 只负责 data 内容）；② 真实库未见的 `raw` 兜底键仅在本适配器解析
 * 失败时出现（保形状稳定，供排查）。
 *
 * 合并策略：`concat-dedup-order`，**不提供 keyOf**——关系记录没有稳定 id，唯一可用的复合键
 * （`A|B|from`）会把同一对人物在**不同章节范围内**的多条合法记录误判为重复而塌掉（模板
 * 明确允许「同一对人物仅在关系显著改变时拆成多条」），故交给 dedupeDeep 的默认键
 * （整条 JSON 串）——完全相同的关系记录（跨批重复产出）才相消。
 * 理由同 `mergeReview` 只用组键、`characterAppearance` 形象对象退化为 JSON 串的取舍：
 * **宁可留重复，不可误删**。
 */
import type { ChatMessage, LlmTaskAdapter, TaskRuntime, UpstreamEntry } from '../../../shared/pipeline-types'
import { numberLines } from '../chunk-source'
import { buildReadingMemory, renderMemory } from '../memory'
import { parseJsonLoose } from './cacheWarming'

/** 别名归一为字符串数组（新模板契约字符串数组 / 老数据对象数组 `[{alias,type}]` 两代形状都收）。 */
function aliasArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const x of v) {
    if (typeof x === 'string') out.push(x)
    else if (x && typeof x === 'object' && !Array.isArray(x) && typeof (x as Record<string, unknown>).alias === 'string') {
      out.push((x as Record<string, unknown>).alias as string)
    }
  }
  return out
}

/** 双形态解包：`{data:{…}}` 信封 → data；裸值原样。 */
function unwrapData(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const d = (value as Record<string, unknown>).data
    if (d !== undefined && d !== null) return d
  }
  return value
}

/** 条目 key 末段数字（`<pkgId>:<revisionId>:<taskId>:<n>`；解析不到 → null）。 */
function chunkIndexOfKey(key: string): number | null {
  const segs = String(key ?? '').split(':')
  const last = segs[segs.length - 1] ?? ''
  return /^\d+$/.test(last) ? Number(last) : null
}

/** 本 chunk 的章节视图（缺 chunkChapters 时视作单章 seq=1；与 inputText/numberLines 同口径）。 */
function chaptersOf(rt: TaskRuntime): { seq: number; title: string; text: string }[] {
  return rt.chunkChapters ?? [{ seq: 1, title: '（单章原文）', text: rt.chunkText }]
}

/** 本 chunk 的章节序号（只留有限数字；可能乱序跳号，故排序后取首末）。 */
function chapterSeqsOf(rt: TaskRuntime): number[] {
  return chaptersOf(rt)
    .map((c) => c.seq)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
}

/** 本 chunk 的章序范围（min/max；无章节信息 → 1/1，与模板回退口径一致）。 */
function chapterRangeOf(rt?: TaskRuntime): { min: number; max: number } {
  const seqs = rt ? chapterSeqsOf(rt) : []
  if (!seqs.length) return { min: 1, max: 1 }
  return { min: seqs[0], max: seqs[seqs.length - 1] }
}

/** 读 plot 产物（阅读记忆的唯一来源）；未挂 readUpstream → 可读错误（与 draft/plotLocation 同口径）。 */
async function readPlotEntries(rt: TaskRuntime): Promise<UpstreamEntry[]> {
  if (typeof rt.readUpstream !== 'function') {
    throw new Error('characterRelation 需要 plot 产物（阅读记忆的唯一来源）：运行期未提供 readUpstream（rt 须由编排器 makeRuntime 构造）')
  }
  // plot 产物为空 → 空记忆（chunk 0 本就空，合法），不抛错
  return rt.readUpstream('plot')
}

/**
 * 本片人物名单（模板 `chunkCharacterWorldObjList` 变量，预序列化 JSON 字符串）。
 *
 * draftAlign 产物中 key 末段数字 == self 的条目 → `characters` → 每人 `{id, name, aliases}`。
 * 无产物 / 未挂 readUpstream / 本片无条目 → `'[]'` + `rt.warnings` 记一条，**不抛**
 * （模板人物名单只用于标准 name 对照，缺失不阻断关系提取）。
 */
async function readChunkCharacterList(rt: TaskRuntime): Promise<string> {
  const self = rt.chunkIndex ?? 0
  if (typeof rt.readUpstream !== 'function') {
    rt.warnings.push('characterRelation：运行期未提供 readUpstream——本片人物名单传空数组（仅缺标准 name 对照，不阻断）')
    return '[]'
  }
  const entries = await rt.readUpstream('draftAlign')
  for (const e of entries) {
    if (chunkIndexOfKey(e.key) !== self) continue
    const data = unwrapData(e.value)
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue
    const chars = (data as Record<string, unknown>).characters
    if (!Array.isArray(chars)) break
    const persons = chars
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && !Array.isArray(c))
      .map((c) => ({
        id: typeof c.id === 'string' ? c.id : '',
        name: typeof c.name === 'string' ? c.name : '',
        // 两代别名形状归一（理由见文件头模板变量段）
        aliases: aliasArray(c.aliases)
      }))
    return JSON.stringify(persons)
  }
  rt.warnings.push(`characterRelation：chunk ${self} 无 draftAlign 产物——本片人物名单传空数组（仅缺标准 name 对照，不阻断）`)
  return '[]'
}

/**
 * 从 rt 推导模板变量（`character_relation_extract_user_prompt` 的 5 个 `{{{var}}}` 占位符）。
 * 缺 chunkChapters 时视作单章（seq=1）并给合理回退，绝不传 undefined。
 */
async function characterRelationTemplateVars(rt: TaskRuntime): Promise<Record<string, unknown>> {
  const range = chapterRangeOf(rt)
  const selfChunkIndex = rt.chunkIndex ?? 0
  return {
    chunkIndex: selfChunkIndex,
    // 章节范围：本 chunk 首章/末章（单章时相等；无章节信息回退 1/1）
    startChapterSeq: range.min,
    endChapterSeq: range.max,
    // 阅读记忆：chunks 0..i-1 的 plot 摘要，现算（见 ../memory.ts）
    chunkReadingMemory: renderMemory(buildReadingMemory(await readPlotEntries(rt), selfChunkIndex)),
    // 本片人物名单（预序列化 JSON 字符串；prompt-loader 对 JS 数组会换行拼接）
    chunkCharacterWorldObjList: await readChunkCharacterList(rt)
  }
}

/** 关系条目的一方（`characterA` / `characterB`）。 */
interface RawSide {
  name: string
  overview: string
  summary: string
}

/**
 * 读一方结构：`{name: 非空字符串, relationToOther:{overview:string, summary:string}}`。
 * 结构不整（缺 name / relationToOther 非对象）→ 返回 null（调用方跳过该条 + warning）；
 * `overview` / `summary` 非字符串 → 缺省 `''`（模板「无依据时说明态度未明」，缺字段可空）。
 */
function readSide(v: unknown): RawSide | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (typeof o.name !== 'string' || o.name.trim().length === 0) return null
  const rel = o.relationToOther
  if (!rel || typeof rel !== 'object' || Array.isArray(rel)) return null
  const r = rel as Record<string, unknown>
  return {
    name: o.name,
    overview: typeof r.overview === 'string' ? r.overview : '',
    summary: typeof r.summary === 'string' ? r.summary : ''
  }
}

/** 字数（码点计：中文一字一码点，与模板「最多 N 字」同口径）。 */
function charCount(s: string): number {
  return Array.from(s).length
}

export const characterRelationAdapter: LlmTaskAdapter = {
  id: 'characterRelation',
  mergeStrategy: 'concat-dedup-order',
  // 不提供 keyOf：关系无稳定 id，复合键会把同对人物不同范围的多条合法记录误塌（见文件头）

  async inputText(rt: TaskRuntime): Promise<string> {
    // 与 cacheWarming/seg/plot/plotLocation/lineAnnotation 逐字同构：有章节切片按「各章从 1
    // 重新编号」组装；否则（调用方直接注入 chunkText）视作单章原文。
    return numberLines(chaptersOf(rt))
  },

  async buildMessages(batchText: string, rt: TaskRuntime): Promise<ChatMessage[]> {
    const system = await rt.render('common_system_prompt', {})
    const instruction = await rt.render('character_relation_extract_user_prompt', await characterRelationTemplateVars(rt))
    // 原文单独一条 user 消息在前、任务指令放最后（模板「当前 chunk 原文：前面的带行号 user 消息」）
    return [
      { role: 'system', content: system },
      { role: 'user', content: batchText },
      { role: 'user', content: instruction }
    ]
  },

  parse(content: string, rt?: TaskRuntime): unknown {
    const warnings: string[] = []
    const warn = (msg: string): void => {
      warnings.push(msg)
    }
    // 程序补齐的实例归属（rt 缺失按 0 兜底——测试/合成调用；同步字段直读，无 IO）
    const chunkIndex = rt?.chunkIndex ?? 0
    const range = chapterRangeOf(rt)
    const obj = parseJsonLoose(content)
    const o = obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null

    // ---- 1. 协议校验：characterRelations 必须是数组（缺 → raw 兜底，不抛崩）----
    if (!o || !Array.isArray(o.characterRelations)) {
      warn('characterRelation：模型输出无法解析为人物关系协议（缺 characterRelations 数组），走 raw 兜底')
      return { characterRelations: [], warnings, raw: (content ?? '').slice(0, 500) }
    }

    /** 章序取值：有限整数且在范围内则原值；越界钳制；非整数回退端点（均 warning，不跳过）。 */
    const clampSeq = (v: unknown, fallback: number, label: string): number => {
      if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
        warn(`characterRelation：${label}=${JSON.stringify(v) ?? 'undefined'} 非有限整数，按本 chunk 章序端点 ${fallback} 处理`)
        return fallback
      }
      if (v < range.min) {
        warn(`characterRelation：${label}=${v} 越出本 chunk 章序范围 ${range.min}..${range.max}，钳到 ${range.min}`)
        return range.min
      }
      if (v > range.max) {
        warn(`characterRelation：${label}=${v} 越出本 chunk 章序范围 ${range.min}..${range.max}，钳到 ${range.max}`)
        return range.max
      }
      return v
    }

    // ---- 2. 逐条校验 + 章序钳制 + 程序补 chunkIndex ----
    const characterRelations: Record<string, unknown>[] = []
    for (const item of o.characterRelations) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        warn(`characterRelation：跳过非对象的关系条目（${JSON.stringify(item)?.slice(0, 80) ?? 'null'}）`)
        continue
      }
      const r = item as Record<string, unknown>
      const fromChapterSeq = clampSeq(r.fromChapterSeq, range.min, 'fromChapterSeq')
      const toChapterSeq = clampSeq(r.toChapterSeq, range.max, 'toChapterSeq')
      const sideA = readSide(r.characterA)
      if (!sideA) {
        warn(`characterRelation：跳过 characterA 结构不完整的关系条目（需 {name, relationToOther:{overview, summary}}）：${JSON.stringify(r.characterA)?.slice(0, 80) ?? 'null'}`)
        continue
      }
      const sideB = readSide(r.characterB)
      if (!sideB) {
        warn(`characterRelation：跳过 characterB 结构不完整的关系条目（需 {name, relationToOther:{overview, summary}}）：${JSON.stringify(r.characterB)?.slice(0, 80) ?? 'null'}`)
        continue
      }
      // 自己与自己的关系不成立（模板明令「不输出自己与自己的关系」）
      if (sideA.name === sideB.name) {
        warn(`characterRelation：跳过 A、B 同名的关系条目（${sideA.name}）——不输出自己与自己的关系`)
        continue
      }
      const relationSummary = typeof r.relationSummary === 'string' ? r.relationSummary : ''
      // 长度契约：只 warning 不截断（模板措辞「最多 N 字」；截断会切坏句子）
      if (charCount(sideA.overview) > 10) {
        warn(`characterRelation：${sideA.name} 的 overview 超 10 字（${charCount(sideA.overview)} 字），保留原文不截断`)
      }
      if (charCount(sideB.overview) > 10) {
        warn(`characterRelation：${sideB.name} 的 overview 超 10 字（${charCount(sideB.overview)} 字），保留原文不截断`)
      }
      if (charCount(sideA.summary) > 50) {
        warn(`characterRelation：${sideA.name} 的 summary 超 50 字（${charCount(sideA.summary)} 字），保留原文不截断`)
      }
      if (charCount(sideB.summary) > 50) {
        warn(`characterRelation：${sideB.name} 的 summary 超 50 字（${charCount(sideB.summary)} 字），保留原文不截断`)
      }
      if (charCount(relationSummary) > 300) {
        warn(`characterRelation：关系 ${sideA.name}/${sideB.name} 的 relationSummary 超 300 字（${charCount(relationSummary)} 字），保留原文不截断`)
      }
      characterRelations.push({
        fromChapterSeq,
        toChapterSeq,
        characterA: { name: sideA.name, relationToOther: { overview: sideA.overview, summary: sideA.summary } },
        characterB: { name: sideB.name, relationToOther: { overview: sideB.overview, summary: sideB.summary } },
        relationSummary,
        // 程序字段：实例归属（模型不产，对齐真实库产物第 9 个字段）
        chunkIndex
      })
    }

    // ---- 3. 输出（空数组是合法输出）----
    return { characterRelations, warnings }
  }
}

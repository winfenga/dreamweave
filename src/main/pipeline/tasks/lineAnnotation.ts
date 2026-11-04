/**
 * `lineAnnotation` 任务适配器（T6-G 第七批；模板 `line_annotation_user_prompt`）。
 *
 * 产物：`script/line-annotation.json`（**叶真源单文件**，per-chunk 任务每 chunk 一条目，
 * key 形如 `<pkgId>:<revisionId>:lineAnnotation:<n>`；投影登记见 `../reproject.ts` 的
 * `script/line-annotation.json`，路由见 `../upstream.ts` 的 `matchesTaskFile`）。
 * 消费端：view **不直接消费**——下游 effectAnnotation 的 addresses 消费（T6-I）。
 *
 * 输入：**带行号原文**（与 cacheWarming/seg/plot/plotLocation 逐字同构：各章从 1 重新
 * 编号、每章外包 `【原文行：1-N】`；见 `../chunk-source` 的 `numberLines`）——`inputText`
 * 只产原文，其余模板变量在 `buildMessages` 现算（读上游组装一律在此做，parse 是同步
 * 函数，见 T6-F ① 接口约束）。
 *
 * 【为什么声明 `batching:{inputBudgetTokens:100000}`（本适配器核心纪律）】
 * lineAnnotation 输入是全 chunk 带行号原文（最小书也有 ~24K tokens，必被默认 8000 预算
 * 切批）；其输出是「**本地 id 地点目录 + 逐行引用本地 id**」——切批后各批模型各自从
 * l1 编号，**跨批本地 id 碰撞**，而合并发生在 parse **之前**的 raw 文本层面、无法事后
 * 消歧 → 行引用会错乱（l1 在批 A 是「客栈内」、批 B 是「王座大厅」，合并后行引用指向
 * 哪个都可能是错的）。真实生态该任务 maxTokens=120000 即单次调用。chunking 策略
 * targetTokens=42000 保证单 chunk ≤ ~42K tokens，故声明 100000（单批意图 + 输入上界）。
 * 【覆盖如何生效（T6-G 修正后，实证于验证脚本 C3）】orchestrator 合并覆盖不经
 * `defaultBatchingConfig` 夹紧，且 `planBatches` **信任 cfg 入参**（T6-G 修正：原先的
 * 二次夹紧会把 100000 压回 24000，大 chunk 仍被切 2 批 → 跨批本地 id 碰撞 → parse 防御
 * 把地点引用全部置 null → 大书上逐行地点标注全丢；已修，仅防运行期脏值回退默认）→ **100000
 * 全量生效，chunk ≤42K tokens 稳定单批**。parse 侧**重复本地 id 检测**（引用置 null 不猜，
 * 见步骤 2）仍是纵深防御——单批是主防线、防御是底线。
 *
 * 【模板变量（以模板实际占位符为准，逐字读过 `line_annotation_user_prompt.txt`）】共 6 个：
 *  - `chunkIndex` = `rt.chunkIndex ?? 0`；
 *  - `chapterSeqs` = 本章序号 join 字符串（同 plotLocation/chunkLocationSummary 口径，
 *    无章节信息回退 `'1'`——模板为直接插值用法，传数组会被 stringifyVar 换行拼接）；
 *  - `chapterLineCounts` = **JSON 数组字符串** `[{"chapterSeq":1,"lineCount":606},…]`
 *    （行数 = 该章 `text.split('\n').length`，从 rt.chunkChapters 现算，与 numberLines
 *    同口径——模型据此保证「每个 lines 数组覆盖本章全部原文行」）；
 *  - `chunkReadingMemory` = `renderMemory(buildReadingMemory(plot 产物, self))` 现算
 *    （同 plotLocation；plot 产物为空 → 空记忆，chunk 0 本就空，合法；未挂 readUpstream
 *    → 可读错误）；
 *  - `characters` = **从 characterAppearance 产物构造**：`readUpstream('characterAppearance')`
 *    取主条目 map（key 以 `:characterAppearance` 结尾；双形态 `value?.data ?? value`）→
 *    每人 `{id, name, appearances:[{appearanceId, name}]}` 序列化为 JSON 字符串；无产物 →
 *    抛可读错误「lineAnnotation 需要 characterAppearance 产物」。**name 传空串**：
 *    characterAppearance 产物按 charId 索引形象、不含人物姓名（parse 输出字段集固定），
 *    模板明言「不填写人物 ID 或姓名」，appearanceId 才是引用键；
 *  - `mapLocationTree` = `mapLocationTreeJson(locationTree 产物)`（`../location-inputs`，
 *    完整树不剪枝，同 plotLocation）；无 locationTree 产物 → 抛可读错误。
 *
 * 【为什么 buildMessages 发 3 条消息（与 locationTree 等的 2 条不同）】
 * 模板【输入】区只嵌变量，原文**不作变量嵌入**——模板原文：「当前 chunk 原文：见前面的
 * 带行号 user 消息」。故原文必须单独作一条 user 消息先行喂入：system +
 * user（带行号原文）+ user（渲染后的任务指令）= 3 条（与 plotLocation/draft 系同构）。
 *
 * 【parse：本地 id 重编 + 行展开 + 行覆盖校验（三步，顺序不可乱）】
 *  1. parseJsonLoose → 校验 `chapters` 是数组（缺 → raw 兜底不抛崩）；`plotLocations`
 *     缺省 `[]`；
 *  2. **plotLocations 校验 + id 重编**：逐条——`id` 非空字符串（暂留模型本地 id）、
 *     `name` 非空（缺 → 跳过 + warning）、`mapLocationId` 字符串或 **null**（模板契约
 *     「没有精确节点填 null」——注意与 plotLocation 的「省略」不同，此处显式 null；
 *     非字符串非 null → null + warning）、`identInfos` 字符串数组缺省 `[]`、
 *     `summary`/`sceneDescription` 缺省 `''`。**检测重复本地 id**（多批事故的防御）：
 *     重复 → warning，且引用该 id 的行后续全部置 null + warning（不可消歧即不猜）；
 *     重复条目本身仍存活（是有效的场景描述），只是其 id 不进 oldId→newId 映射。按存活
 *     条目顺序重编 `L-{rt.chunkIndex ?? 0}-l{n+1}`（同 plotLocation 规则，编号连续无洞），
 *     输出条目带 `chunkIndex`；
 *  3. **chapters 合并 + 行展开**：同 chapterSeq 的多条（跨批防御）合并——lines 拼接、
 *     按行号升序、行号重复首现获胜。逐行条目（数组）展开：
 *      - `[n]` = **继承上一行完整标注**（展开为上一行解析后的 `[n, locId, ...apps]`；
 *        每章第一行不允许继承，出现即当 `[n,null]` + warning）；
 *      - `[n,null]` = 无地点无人；`[n,null,...apps]` = 无地点有人（自然推广）；
 *      - `[n,locId,...apps]`——locId 过 oldId→newId 映射（歧义/未知 → null + warning）；
 *        appearanceIds 逐项查快照集合（未知/非字符串 → 丢弃 + warning，同行重复首现获胜）；
 *      - 规范化输出形如 `[n, newLocId|null, ...appearanceIds]`；
 *  4. **行覆盖校验**（快照的 expectedLines 与 rt.chunkChapters 双重来源，前者缺失时
 *     退回后者；输出章序以 rt.chunkChapters 为权威）：每章 lines 必须恰好覆盖
 *     1..lineCount——缺号补 `[n,null]` + warning、超范围丢弃 + warning；rt.chunkChapters
 *     里有但模型没给的章 → 全 `[n,null]` + warning；模型给了但不在输入章序里的章 → 整章
 *     丢弃 + warning（输出章集合必须镜像输入）；
 *  5. 输出 `{plotLocations: [重编后], chapters: [{chapterSeq, lines: [展开后]}], warnings}`。
 *
 * 【与真实库 `5662f1d3` 的 `script/line-annotation.json` 逐字段对比结论】
 * 对齐：每 chunk 一条目；data 顶层 `{plotLocations, chapters, warnings}`；行条目
 * `[行号, 地点ID|null, appearanceId,...]` 与简写继承 `[行号]`；章条目 `{chapterSeq, lines}`。
 * 有意差异：① 真实库行内 id 是平台归一的 `L-0-l1`（本适配器用**同一规则**据
 * rt.chunkIndex 重编，等效）；② 真实库 plotLocations 的 `mapLocationId` 无对应时
 * **省略该字段**，本适配器按模板契约「没有精确节点填 null」**显式 null**；
 * ③ 真实库 appearanceId 来自平台形象归并（`D-0-C-1-A-1` 形态），本适配器消费自家
 * characterAppearance 产物（同一形态）。
 *
 * 合并策略：`concat-dedup-order` + 显式 `keyOf`（plotLocations 按 `name`——本地 id 跨批
 * 碰撞的防御，同 plotLocation 双轨思路；chapters 按 `chapter:${seq}:${首行号}`——跨批
 * 同章不同行段都能存活；行条目（数组）退化为 JSON.stringify；理由见 `lineAnnotationKeyOf`
 * 处注释）。
 */
import type { ChatMessage, LlmTaskAdapter, TaskRuntime, UpstreamEntry } from '../../../shared/pipeline-types'
import { numberLines } from '../chunk-source'
import { buildReadingMemory, renderMemory } from '../memory'
import { mapLocationTreeJson } from '../location-inputs'
import { parseJsonLoose } from './cacheWarming'
import { readRtSnapshot, stashRtSnapshot } from '../rt-stash'

/** 程序分配的剧情地点 id 形态（`L-{chunk}-l{n}`；keyOf 双轨与重编规则共用同一判定）。 */
const PLOT_LOCATION_ID_RE = /^L-\d+-l\d+$/

/** 字符串数组成员过滤（非字符串元素剔除；非数组 → `[]`）。 */
function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** 双形态解包：`{data:{…}}` 信封 → data；裸值原样。 */
function unwrapData(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const d = (value as Record<string, unknown>).data
    if (d !== undefined && d !== null) return d
  }
  return value
}

/**
 * 行标注条目的稳定键（供 `concat-dedup-order` 的 dedupeDeep 用）。
 *
 * 【为什么不能只按 id（合并先于 parse 的现实约束，重要）】`mergeOutputs` 在 parse
 * **之前**对**原始模型文本**合并（orchestrator：`runWithBatching(input, …, {keyOf}) →
 * adapter.parse(result.output, rt)`），故 keyOf 看到的是模型输出：
 *  - **章条目**按 `chapter:${seq}:${首行号}`：L2 若按行切批，各批覆盖同一章的不同行段
 *    （首行号不同 → 不相消，都能存活供 parse 合并）；首行号也相同的重复章条目才相消
 *    （首现获胜）；
 *  - **plotLocations 条目**分双轨：程序分配的 id（`L-{chunk}-l{n}`；parse 产物再合并
 *    的前向兼容）→ 按 id 键（全局唯一）；模型本地 id 或缺 id → 按 `name` 键（同实体
 *    跨批重名才相消，同 `plotLocationKeyOf` 的 rationale——模型本地 id 每批都从 l1 起，
 *    按 id 去重会跨批碰撞整批误删）；
 *  - **行条目（数组）**与其余脏条目 → JSON 串兜底。
 */
export function lineAnnotationKeyOf(part: unknown): string {
  if (Array.isArray(part)) {
    try {
      return JSON.stringify(part)
    } catch {
      return String(part)
    }
  }
  if (part && typeof part === 'object') {
    const o = part as Record<string, unknown>
    if (Array.isArray(o.lines)) {
      const seq = typeof o.chapterSeq === 'number' ? o.chapterSeq : String(o.chapterSeq ?? '')
      const first = o.lines[0]
      const firstN = Array.isArray(first) && typeof first[0] === 'number' ? first[0] : ''
      return `chapter:${seq}:${firstN}`
    }
    if (typeof o.id === 'string' && PLOT_LOCATION_ID_RE.test(o.id)) return o.id
    if (typeof o.name === 'string' && o.name.trim().length > 0) return `name:${o.name.trim()}`
  }
  try {
    return JSON.stringify(part)
  } catch {
    return String(part)
  }
}

/** 读 plot 产物（阅读记忆的唯一来源）；未挂 readUpstream → 可读错误（与 draft/plotLocation 同口径）。 */
async function readPlotEntries(rt: TaskRuntime): Promise<UpstreamEntry[]> {
  if (typeof rt.readUpstream !== 'function') {
    throw new Error('lineAnnotation 需要 plot 产物（阅读记忆的唯一来源）：运行期未提供 readUpstream（rt 须由编排器 makeRuntime 构造）')
  }
  // plot 产物为空 → 空记忆（chunk 0 本就空，合法），不抛错
  return rt.readUpstream('plot')
}

/**
 * 取 locationTree 产物数据（双形态 `value?.data ?? value`，取首条可用对象）。
 * 无产物/未挂 readUpstream → 抛可读错误（模板 `mapLocationTree` 变量是必填输入）。
 */
async function readLocationTreeData(rt: TaskRuntime): Promise<Record<string, unknown>> {
  if (typeof rt.readUpstream !== 'function') {
    throw new Error('lineAnnotation 需要 locationTree 产物：运行期未提供 readUpstream（rt 须由编排器 makeRuntime 构造）')
  }
  const entries = await rt.readUpstream('locationTree')
  for (const e of entries) {
    const v = e.value as { data?: unknown } | null
    const data = v && typeof v === 'object' && v.data && typeof v.data === 'object' ? v.data : v
    if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>
  }
  throw new Error('lineAnnotation 需要 locationTree 产物：工作库中没有任何 locationTree 结果，请先运行 locationTree 任务')
}

/**
 * 读 characterAppearance 主条目（key 以 `:characterAppearance` 结尾的 map 形态产物；
 * 双形态解包）→ 模板 `characters` 用的人物名单 + 合法 appearanceId 集合（parse 校验用）。
 *
 * 无产物/未挂 readUpstream → 抛可读错误（模板 characters 变量是必填输入）。无可用形象
 * 的人物（appearanceId 缺失）不进名单 + warning。`name` 传空串的理由见文件头。
 */
async function readAppearancePersons(rt: TaskRuntime): Promise<{
  persons: Record<string, unknown>[]
  appearanceIds: Set<string>
}> {
  if (typeof rt.readUpstream !== 'function') {
    throw new Error('lineAnnotation 需要 characterAppearance 产物：运行期未提供 readUpstream（rt 须由编排器 makeRuntime 构造）')
  }
  const entries = await rt.readUpstream('characterAppearance')
  let map: Record<string, unknown> | null = null
  for (const e of entries) {
    // 只取主条目（`…:characterAppearance`；排除 `:batch:` 等变体与单角色子条目）
    if (!String(e.key).endsWith(':characterAppearance')) continue
    const data = unwrapData(e.value)
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      map = data as Record<string, unknown>
      break
    }
  }
  if (!map) {
    throw new Error('lineAnnotation 需要 characterAppearance 产物：工作库中没有任何 characterAppearance 主条目，请先运行 characterAppearance 任务')
  }
  const persons: Record<string, unknown>[] = []
  const appearanceIds = new Set<string>()
  for (const [charId, arr] of Object.entries(map)) {
    if (!Array.isArray(arr)) continue
    const appearances: Record<string, unknown>[] = []
    for (const ap of arr) {
      if (!ap || typeof ap !== 'object' || Array.isArray(ap)) continue
      const o = ap as Record<string, unknown>
      if (typeof o.appearanceId !== 'string' || !o.appearanceId) continue
      appearanceIds.add(o.appearanceId)
      appearances.push({ appearanceId: o.appearanceId, name: typeof o.name === 'string' ? o.name : '' })
    }
    if (!appearances.length) {
      rt.warnings.push(`lineAnnotation：人物 ${charId} 无可用形象（appearanceId 缺失），未进模板人物名单`)
      continue
    }
    persons.push({ id: charId, name: '', appearances })
  }
  return { persons, appearanceIds }
}

/** buildMessages 挂载、parse 读取的快照（合法 appearanceId 集合 + 各章预期行数）。 */
interface LineAnnotationSnapshot {
  appearanceIds: Set<string>
  expectedLines: Map<number, number>
}

/** 本 chunk 的章节视图（缺 chunkChapters 时视作单章 seq=1；与 inputText/numberLines 同口径）。 */
function chaptersOf(rt: TaskRuntime): { seq: number; title: string; text: string }[] {
  return rt.chunkChapters ?? [{ seq: 1, title: '（单章原文）', text: rt.chunkText }]
}

/** 该章行数（`text.split('\n').length`——与 numberLines 逐字同口径，空串算 1 行）。 */
function lineCountOf(text: string): number {
  return (text ?? '').split('\n').length
}

/**
 * 从 rt 推导模板变量（`line_annotation_user_prompt` 的 6 个 `{{{var}}}` 占位符）。
 * @param persons 调用方已读好的 characterAppearance 人物名单（避免重复读上游）
 */
async function lineAnnotationTemplateVars(rt: TaskRuntime, persons: Record<string, unknown>[]): Promise<Record<string, unknown>> {
  const chapters = chaptersOf(rt)
  const seqs = chapters.map((c) => c.seq).filter((n) => Number.isFinite(n))
  const selfChunkIndex = rt.chunkIndex ?? 0
  return {
    chunkIndex: selfChunkIndex,
    // 模板为直接插值用法 → 传 join 后的字符串；无章节信息时回退 '1'
    chapterSeqs: seqs.length ? seqs.join(',') : '1',
    // 各章行数：JSON 数组字符串（模型据此保证每章 lines 覆盖全部原文行）
    chapterLineCounts: JSON.stringify(chapters.map((c) => ({ chapterSeq: c.seq, lineCount: lineCountOf(c.text) }))),
    // 阅读记忆：chunks 0..i-1 的 plot 摘要，现算（见 ../memory.ts）
    chunkReadingMemory: renderMemory(buildReadingMemory(await readPlotEntries(rt), selfChunkIndex)),
    // 人物与形象名单（预序列化 JSON 字符串；prompt-loader 对 JS 数组会换行拼接）
    characters: JSON.stringify(persons),
    // 地图地点完整树（不剪枝，理由见 ../location-inputs 文件头）
    mapLocationTree: mapLocationTreeJson(await readLocationTreeData(rt))
  }
}

export const lineAnnotationAdapter: LlmTaskAdapter = {
  id: 'lineAnnotation',
  mergeStrategy: 'concat-dedup-order',
  keyOf: lineAnnotationKeyOf,
  // T6-G ①：按任务覆盖分批预算（输入是全 chunk 带行号原文必被默认预算切批，而输出含
  // 跨批必碰撞的本地行引用——切批即错乱；planBatches 信任 cfg 使覆盖全量生效，
  // parse 侧重复本地 id 检测为纵深防御，见文件头）
  batching: { inputBudgetTokens: 100000 },

  async inputText(rt: TaskRuntime): Promise<string> {
    // 与 cacheWarming/seg/plot/plotLocation 逐字同构：有章节切片按「各章从 1 重新编号」组装；
    // 否则（调用方直接注入 chunkText）视作单章原文。
    return numberLines(chaptersOf(rt))
  },

  async buildMessages(batchText: string, rt: TaskRuntime): Promise<ChatMessage[]> {
    const { persons, appearanceIds } = await readAppearancePersons(rt)
    // 快照：合法 appearanceId 集合（行展开校验用）+ 各章预期行数（行覆盖校验用）。
    // 必须在 buildMessages stash（inputText 的 rt0 与 parse 的 rt 不是同一实例，见 ../rt-stash 文件头）
    const expectedLines = new Map<number, number>()
    for (const c of chaptersOf(rt)) {
      if (Number.isFinite(c.seq)) expectedLines.set(c.seq, lineCountOf(c.text))
    }
    stashRtSnapshot(rt, { appearanceIds, expectedLines } satisfies LineAnnotationSnapshot)
    const system = await rt.render('common_system_prompt', {})
    const instruction = await rt.render('line_annotation_user_prompt', await lineAnnotationTemplateVars(rt, persons))
    // 原文单独一条 user 消息在前、任务指令放最后（模板「当前 chunk 原文：见前面的带行号 user 消息」）
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
    // 程序重编 id 的 chunk 段（rt 缺失按 0 兜底——测试/合成调用；同步字段直读，无 IO）
    const chunkIndex = rt?.chunkIndex ?? 0
    const snapshot = readRtSnapshot<LineAnnotationSnapshot>(rt)
    const obj = parseJsonLoose(content)
    const o = obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null

    // ---- 1. 协议校验：chapters 必须是数组（缺 → raw 兜底，不抛崩）----
    if (!o || !Array.isArray(o.chapters)) {
      warn('lineAnnotation：模型输出无法解析为逐行标注协议（缺 chapters 数组），走 raw 兜底')
      return { plotLocations: [], chapters: [], warnings, raw: (content ?? '').slice(0, 500) }
    }

    // ---- 2. plotLocations 校验 + id 重编 ----
    interface RawLoc {
      oldId: string
      name: string
      mapLocationId: string | null
      identInfos: string[]
      summary: string
      sceneDescription: string
    }
    const rawLocs: RawLoc[] = []
    const seenLocalIds = new Set<string>()
    const ambiguousIds = new Set<string>()
    const rawPlotLocations = Array.isArray(o.plotLocations) ? o.plotLocations : []
    for (const item of rawPlotLocations) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        warn(`lineAnnotation：跳过非对象的 plotLocations 条目（${JSON.stringify(item)?.slice(0, 80) ?? 'null'}）`)
        continue
      }
      const p = item as Record<string, unknown>
      // id 非空字符串（暂留模型本地 id——模板契约「本次目录内唯一的短 ID，如 l1」）
      if (typeof p.id !== 'string' || !p.id) {
        warn(`lineAnnotation：跳过缺 id 的 plotLocations 条目（${JSON.stringify(p)?.slice(0, 80) ?? 'null'}）`)
        continue
      }
      // name 非空字符串（模板「每项包含 id、name…」）
      if (typeof p.name !== 'string' || p.name.trim().length === 0) {
        warn(`lineAnnotation：跳过缺 name 的 plotLocations 条目（id=${p.id}）`)
        continue
      }
      // mapLocationId：字符串或 null（模板契约「没有精确节点填 null」——与 plotLocation 的
      // 「省略」不同，此处显式 null）；非字符串非 null → null + warning
      let mapLocationId: string | null = null
      if (typeof p.mapLocationId === 'string') {
        mapLocationId = p.mapLocationId
      } else if (p.mapLocationId !== undefined && p.mapLocationId !== null) {
        warn(`lineAnnotation：plotLocations ${p.id} 的 mapLocationId 非字符串非 null（${JSON.stringify(p.mapLocationId)}），置 null`)
      }
      // 重复本地 id（多批碰撞/模型违规防御）：不可消歧 → 引用该 id 的行全部置 null
      if (seenLocalIds.has(p.id)) {
        ambiguousIds.add(p.id)
        warn(`lineAnnotation：检测到重复本地地点 id=${p.id}（多批碰撞或模型违规）——引用该 id 的行将全部置 null（不可消歧即不猜）`)
      }
      seenLocalIds.add(p.id)
      rawLocs.push({
        oldId: p.id,
        name: p.name,
        mapLocationId,
        identInfos: stringArray(p.identInfos),
        summary: typeof p.summary === 'string' ? p.summary : '',
        sceneDescription: typeof p.sceneDescription === 'string' ? p.sceneDescription : ''
      })
    }
    // 按存活条目顺序重编 L-{chunk}-l{n+1}（同 plotLocation 规则，编号连续无洞）；
    // 歧义 id 不进 oldId→newId 映射（引用置 null）
    const oldToNew = new Map<string, string>()
    const plotLocations: Record<string, unknown>[] = rawLocs.map((r, n) => {
      const id = `L-${chunkIndex}-l${n + 1}`
      if (!ambiguousIds.has(r.oldId)) oldToNew.set(r.oldId, id)
      return {
        id,
        name: r.name,
        mapLocationId: r.mapLocationId,
        identInfos: r.identInfos,
        summary: r.summary,
        sceneDescription: r.sceneDescription,
        chunkIndex
      }
    })

    // ---- 3. chapters 合并 + 行展开 ----
    // 同 chapterSeq 的多条（跨批防御）合并：lines 拼接（后续按行号升序、重复首现获胜）
    const mergedLines = new Map<number, unknown[][]>()
    const modelChapterOrder: number[] = []
    for (const item of o.chapters) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        warn(`lineAnnotation：跳过非对象的 chapters 条目（${JSON.stringify(item)?.slice(0, 80) ?? 'null'}）`)
        continue
      }
      const ch = item as Record<string, unknown>
      const seq = typeof ch.chapterSeq === 'number' && Number.isFinite(ch.chapterSeq) ? ch.chapterSeq : null
      if (seq === null) {
        warn(`lineAnnotation：跳过缺 chapterSeq 的 chapters 条目（${JSON.stringify(ch).slice(0, 80)}）`)
        continue
      }
      if (!Array.isArray(ch.lines)) {
        warn(`lineAnnotation：章 ${seq} 缺 lines 数组，跳过该章条目`)
        continue
      }
      if (!mergedLines.has(seq)) {
        mergedLines.set(seq, [])
        modelChapterOrder.push(seq)
      }
      mergedLines.get(seq)!.push(...ch.lines)
    }

    const appearanceIds = snapshot?.appearanceIds ?? null
    /**
     * 展开一行：`[n]` 继承 / `[n,null(,...apps)]` / `[n,locId,...apps]`
     * → 规范化 `[n, newLocId|null, ...appearanceIds]`。
     * @param prev 上一行**解析后**的完整标注（继承用；每章第一行为 null）
     */
    const expandLine = (seq: number, n: number, raw: unknown[], prev: unknown[] | null): unknown[] => {
      const apps: string[] = []
      const seenApps = new Set<string>()
      const pushApp = (v: unknown): void => {
        if (typeof v !== 'string' || !v) {
          warn(`lineAnnotation：章 ${seq} 第 ${n} 行 appearanceId 非非空字符串（${JSON.stringify(v) ?? 'undefined'}），丢弃`)
          return
        }
        if (appearanceIds && !appearanceIds.has(v)) {
          warn(`lineAnnotation：章 ${seq} 第 ${n} 行 appearanceId=${v} 不在 characterAppearance 产物中，丢弃`)
          return
        }
        if (seenApps.has(v)) return // 同一行重复形象去重（首现获胜）
        seenApps.add(v)
        apps.push(v)
      }
      // [n] = 继承上一行完整标注（每章第一行不允许继承——模板契约）
      if (raw.length <= 1) {
        if (!prev) {
          warn(`lineAnnotation：章 ${seq} 第 ${n} 行简写继承但本章第一行不允许继承（模板契约），按无地点无人处理`)
          return [n, null]
        }
        return [n, ...prev.slice(1)]
      }
      // [n, locId, ...apps]
      const locRaw = raw[1]
      let locId: string | null = null
      if (locRaw === null || locRaw === undefined) {
        locId = null
      } else if (typeof locRaw === 'string' && locRaw) {
        if (ambiguousIds.has(locRaw)) {
          warn(`lineAnnotation：章 ${seq} 第 ${n} 行引用歧义本地地点 id=${locRaw}，置 null（不可消歧即不猜）`)
        } else if (oldToNew.has(locRaw)) {
          locId = oldToNew.get(locRaw)!
        } else {
          warn(`lineAnnotation：章 ${seq} 第 ${n} 行引用未知本地地点 id=${locRaw}，置 null`)
        }
      } else {
        warn(`lineAnnotation：章 ${seq} 第 ${n} 行地点 ID 非字符串（${JSON.stringify(locRaw) ?? 'undefined'}），置 null`)
      }
      for (let k = 2; k < raw.length; k++) pushApp(raw[k])
      return [n, locId, ...apps]
    }

    // ---- 4. 行覆盖校验 ----
    // 章序与行数的权威来源：rt.chunkChapters（与 buildMessages 同源）；rt 缺失时退回快照
    // expectedLines（双重来源，防御测试/合成调用）
    const sourceChapters: { seq: number; lineCount: number }[] = []
    if (rt?.chunkChapters?.length) {
      for (const c of rt.chunkChapters) {
        if (Number.isFinite(c.seq)) sourceChapters.push({ seq: c.seq, lineCount: lineCountOf(c.text) })
      }
    } else if (snapshot) {
      for (const [seq, lineCount] of snapshot.expectedLines) sourceChapters.push({ seq, lineCount })
    }
    const sourceSeqSet = new Set(sourceChapters.map((c) => c.seq))
    // 模型给了但不在输入章序里的章 → 整章丢弃 + warning（输出章集合必须镜像输入）
    for (const seq of modelChapterOrder) {
      if (sourceSeqSet.size && !sourceSeqSet.has(seq)) {
        warn(`lineAnnotation：模型输出的章 ${seq} 不在本 chunk 章节中，整章丢弃`)
      }
    }

    const chaptersOut: { chapterSeq: number; lines: unknown[][] }[] = []
    if (sourceChapters.length) {
      for (const src of sourceChapters) {
        const rawLines = mergedLines.get(src.seq) ?? []
        const wholeChapterMissing = rawLines.length === 0
        if (wholeChapterMissing) {
          warn(`lineAnnotation：章 ${src.seq} 在模型输出中缺失，全章补 [n,null]（共 ${src.lineCount} 行）`)
        }
        // 按行号升序、行号重复首现获胜（跨批防御）
        const byNum = new Map<number, unknown[]>()
        const dupNums = new Set<number>()
        for (const raw of rawLines) {
          if (!Array.isArray(raw)) {
            warn(`lineAnnotation：章 ${src.seq} 跳过非数组的行条目（${JSON.stringify(raw)?.slice(0, 80) ?? 'null'}）`)
            continue
          }
          const n = raw[0]
          if (typeof n !== 'number' || !Number.isFinite(n)) {
            warn(`lineAnnotation：章 ${src.seq} 跳过首元素非行号的行条目（${JSON.stringify(raw).slice(0, 80)}）`)
            continue
          }
          if (byNum.has(n)) {
            dupNums.add(n)
            continue
          }
          byNum.set(n, raw)
        }
        for (const n of dupNums) {
          warn(`lineAnnotation：章 ${src.seq} 第 ${n} 行重复标注，保留首现`)
        }
        // 超范围行号丢弃 + warning
        for (const n of byNum.keys()) {
          if (n < 1 || n > src.lineCount) {
            warn(`lineAnnotation：章 ${src.seq} 第 ${n} 行超出本章行数 1..${src.lineCount}，丢弃`)
            byNum.delete(n)
          }
        }
        const lines: unknown[][] = []
        let prev: unknown[] | null = null
        for (let n = 1; n <= src.lineCount; n++) {
          const raw = byNum.get(n)
          if (raw === undefined) {
            // 缺号补 [n,null]（整章缺失时已在章级 warning，不逐行重复刷）
            if (!wholeChapterMissing) warn(`lineAnnotation：章 ${src.seq} 第 ${n} 行缺失，补 [${n},null]`)
            lines.push([n, null])
            prev = [n, null] // 补齐行即成为下一行的「上一行」（继承基线）
            continue
          }
          const expanded = expandLine(src.seq, n, raw, prev)
          lines.push(expanded)
          prev = expanded
        }
        chaptersOut.push({ chapterSeq: src.seq, lines })
      }
    } else {
      // 无权威章源（rt 与快照均缺）：按模型章序原样展开，不做覆盖校验（防御路径）
      for (const seq of modelChapterOrder) {
        const lines: unknown[][] = []
        let prev: unknown[] | null = null
        const sorted = (mergedLines.get(seq) ?? [])
          .filter((raw): raw is unknown[] => Array.isArray(raw) && typeof raw[0] === 'number' && Number.isFinite(raw[0]))
          .slice()
          .sort((a, b) => (a[0] as number) - (b[0] as number))
        for (const raw of sorted) {
          const expanded = expandLine(seq, raw[0] as number, raw, prev)
          lines.push(expanded)
          prev = expanded
        }
        chaptersOut.push({ chapterSeq: seq, lines })
      }
    }

    // ---- 5. 输出 ----
    return { plotLocations, chapters: chaptersOut, warnings }
  }
}

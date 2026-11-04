/**
 * `storyScript` 任务适配器（T6-H 第八批；模板 `story_script_user_prompt` /
 * `story_script_coherent_user_prompt`）。
 *
 * 产物：**叶真源** `script/story-script.<chunk>.json`（per-chunk 任务每 chunk 一文件/一条目，
 * key 形如 `<pkgId>:<revisionId>:storyScript:<n>`；写路由见 `workspace/shard-write.ts`，
 * 读路由见 `../upstream.ts` 的 `matchesTaskFile` → `STORY_SCRIPT_FILE_PREFIX` 前缀匹配）。
 * 消费端：`t2w/view.ts:288-315`——合并全部 chunk 级 storyScript 的 `actions`（按
 * chapterSeq/order 排序）与 `plotLocations`（按 id 去重）；`view.ts:290` 读顶层 `protocol`。
 *
 * ---------------------------------------------------------------------------
 * 【为什么声明 `batching:{inputBudgetTokens:100000}`（同 lineAnnotation）】
 * 输出是 `actions` 引用**本地 id 目录**（`lId`/`flId`/`tlId` 指 `L-{chunk}-l{n}`）+ 大量
 * 跨行动引用（`aId`/`cId`/`tIds`）；输入是全 chunk 带行号原文（最小书也远超默认 8000
 * 预算，必被切批）。切批后各批模型各自从「本批看到的那部分原文与地点目录」出发，跨批的
 * 行动顺序、地点引用与形象引用都会错乱，而合并发生在 parse **之前**的 raw 文本层面、
 * 无法事后消歧。真实生态该任务 maxTokens=120000 即单次调用；chunking 策略
 * targetTokens=42000 保证单 chunk ≤ ~42K tokens，故声明 100000（单批意图 + 输入上界）。
 * 生效方式见 `shared/pipeline-types.ts` 的 `LlmTaskAdapter.batching` 注释（T6-G 修正后
 * orchestrator 合并不夹紧、`planBatches` 信任 cfg）。
 *
 * 【模板变体选择（本适配器第二处核心逻辑）】
 * 读 `readIndex(rt.root)`（`../../workspace/index-store`，无 electron 依赖）的
 * `manifest.project.storyScriptStyle`：
 *  - `'coherent'` → `story_script_coherent_user_prompt`（真实库 `5662f1d3` 实测即此值）；
 *  - `'legacy'` / `'coherent-legacy'` → **回落 base 模板 + warning**。理由：legacy 变体要求
 *    模型**自产** `plotLocations` 目录（含 mapLocationId/identInfos/summary/sceneDescription），
 *    与 plotLocation 任务职责重复，且自产 id（`l1`/`l2`）与 plotLocation 的程序 id
 *    `L-{chunk}-l{n}` 无法对齐 → 下游 lineAnnotation / plotLocationMerge / view 的场景引用
 *    会指向不存在的 id。本架构的 plotLocations 一律来自 plotLocation 产物（parse 从快照
 *    原样复制，实测真实库 storyScript.plotLocations 与 plotLocation 产物 id 逐一相同、11=11）；
 *  - 其余（含 txt 书的 `''`、读取 index.json 失败、未挂 rt.root）→ base 模板。
 * 选模板在 buildMessages 里做（不是 inputText）：模板只影响指令文本，与切批输入无关。
 *
 * 【模板变量（以模板实际占位符为准，逐字读过两套模板，各 7 个、占位符完全相同）】
 *  - `chunkIndex` = `rt.chunkIndex ?? 0`；
 *  - `chapterSeqs` = 本 chunk 章序号 join 字符串（同 plotLocation/lineAnnotation 口径，
 *    无章节信息回退 `'1'`——模板为直接插值用法）；
 *  - `chunkReadingMemory` = `renderMemory(buildReadingMemory(plot 产物, self))` 现算（同
 *    draft/plotLocation/lineAnnotation；plot 空 → 空记忆合法；未挂 readUpstream → 可读错误）；
 *  - `characters` = **从 characterAppearance 产物构造**：`readUpstream('characterAppearance')`
 *    取主条目（key 以 `:characterAppearance` 结尾；双形态 `value?.data ?? value`）→ 每人
 *    `{id, name, aliases, appearances:[{appearanceId, name, sex, appearanceSummary,
 *    visualKeywords}]}` → JSON 字符串；无产物 → 抛可读错误「storyScript 需要
 *    characterAppearance 产物」。**`name`/`aliases` 取不到**：characterAppearance 产物是
 *    「charId → 形象数组」的 map、不含人物姓名与别名（姓名在 canonical），故传 `''` /
 *    `[]`——`appearanceId` 是本阶段唯一的引用键（模板「aId：主体当前形象 ID，取自该人物
 *    appearances 中的 appearanceId」），与 lineAnnotation 同一处理与同一理由；
 *  - `mapLocationTree` = `mapLocationTreeJson(locationTree 产物)`（`../location-inputs`，
 *    **完整树不剪枝**——剧情地点常绑定不可展示节点，理由见该模块文件头）；无 locationTree
 *    产物 → 抛可读错误；
 *  - `plotLocations` = **本 chunk 的 plotLocation 产物**：`readUpstream('plotLocation')` 取
 *    key 末段数字 == self 的条目 → 双形态解包 → `plotLocations`（**保留其 `L-{chunk}-l{n}`
 *    程序 id 原样**，不重编——它是全链路的场景引用基准）→ JSON 字符串；无 → 抛可读错误；
 *  - `plotLocationRules` = **适配器内 authored 规则短文常量**（见 `PLOT_LOCATION_RULES`；
 *    依据：模板族「【剧情地点】{{{plotLocationRules}}}」是留给调用方注入地点引用规则的位置，
 *    本仓无对应资源文件，故按模板正文与 `plot_location_user_prompt` 同族措辞逐条对齐撰写）。
 *
 * 【为什么 buildMessages 发 3 条消息（与 characterAppearance/plotLocationMerge 的 2 条不同）】
 * 模板【本次输入】区只嵌变量，原文**不作变量嵌入**——模板原文：「当前 chunk 原文：见前面的
 * 带行号 user 消息」。故原文单独作一条 user 消息先行喂入：system + user（带行号原文）+
 * user（渲染后的任务指令）= 3 条。
 *
 * 【parse：短字段协议 story-fields-v2 → 长字段 + 引用解析（顺序不可乱）】
 *  1. `parseJsonLoose` → `actions` 必须是数组（缺 → `{protocol:'map-plot-v1', actions:[],
 *     plotLocations:[], warnings, raw}` 兜底，不抛崩）；
 *  2. 逐条校验（短字段 `t`/`cs`/`txt`/`o`/`lId`/`aId`/`cId`/`tIds`/`flId`/`tlId`）：
 *     - `t` ∈ `n/s/t/b/m`（否则跳过 + warning）；
 *     - `cs` ∈ 本 chunk 章序（否则跳过 + warning）；
 *     - **引用解析**：`txt` 里的 `@#12#@` / `@#12-15#@` / `@#12 14 16-17#@` 形（`@#` 起、
 *       `#@` 止，内含行号 / 连续区间 / 空格分隔列表）→ 用 `chapterLines[cs]` 取对应行
 *       （行号从 1 计、含首尾）以 `\n` 连接替换整个标记；越界或无法解析 → warning +
 *       **保留原标记串**（不猜）；解析后 `txt` 仍为空 → 跳过 + warning；
 *     - `lId`（n/s/t/b）必须 ∈ 快照 plotLocations 的 id 集（否则跳过 + warning）；`m` 不输出
 *       locationId（恒 `''`），`flId`/`tlId` 有则必须 ∈ id 集（否则省略为空 + warning）；
 *     - `tIds`（仅 b）：字符串数组，逐项 ∈ characterIds（未知丢弃 + warning）；
 *     - `aId` 有则必须 ∈ `appearanceToChar`（否则省略 + warning）；
 *       **characterId = `cId ?? appearanceToChar[aId] ?? ''`**；
 *     - s/t/b 拿不到 characterId → 跳过 + warning；n 可无主体；m 无主体 → 保留 + warning；
 *  3. **order 防御性重编号**：每章按 `o` 升序**稳定**排序（非整数 `o` 不参与比较以保住
 *     模型顺序），重编 `order = 0..n-1`；模型 `o` 有洞 / 重序 / 非整数 → warning；
 *  4. 输出**长字段**（严格 10 键，对齐真实产物）：
 *     `{appearanceId, chapterSeq, order, type, characterId, locationId, fromLocationId,
 *     toLocationId, targetIds, text}`；`type` 展开
 *     `n→narration / s→say / t→think / b→battle / m→move`；空值用 `''`
 *     （characterId/locationId/fromLocationId/toLocationId/appearanceId）与 `[]`（targetIds）；
 *  5. **plotLocations 从快照原样复制**（= plotLocation 任务产物；已实测真实库
 *     `5662f1d3` 的 `script/story-script.0.json` 的 plotLocations 与 `world/plot-locations.json`
 *     chunk 0 条目**逐字节相同、11=11**）；
 *  6. 输出 `{protocol:'map-plot-v1', actions, plotLocations, warnings}`（`protocol` 是程序字段）。
 *
 * 【10 键短→长字段映射表（模板契约 → 真实产物字段）】
 *  | 模板短字段 | 产物长字段      | 取值规则                                                     |
 *  |-----------|----------------|--------------------------------------------------------------|
 *  | `t`       | `type`         | n/s/t/b/m → narration/say/think/battle/move                   |
 *  | `cs`      | `chapterSeq`   | 原值（必须 ∈ 本 chunk 章序）                                  |
 *  | `o`       | `order`        | 章内重编 0..n-1（不信任模型给的洞/乱序）                      |
 *  | `cId`     | `characterId`  | `cId ?? appearanceToChar[aId] ?? ''`                          |
 *  | `aId`     | `appearanceId` | 原值（必须 ∈ characterAppearance 形象集）或 `''`              |
 *  | `lId`     | `locationId`   | 原值（必须 ∈ 本 chunk plotLocations id 集）；m 恒 `''`        |
 *  | `flId`    | `fromLocationId` | m 专用；不在 id 集/未给 → `''`                              |
 *  | `tlId`    | `toLocationId`   | m 专用；不在 id 集/未给 → `''`                              |
 *  | `tIds`    | `targetIds`    | 仅 b；逐项过滤到 characterIds，其余 `[]`                       |
 *  | `txt`     | `text`         | 引用标记解析为原文行文本（越界保留标记）；空正文行动跳过      |
 *
 * 【与真实库 `5662f1d3` 的 `script/story-script.0.json` 逐字段对比结论】
 * 对齐：data 顶层 `{protocol:'map-plot-v1', actions, plotLocations, warnings}`；actions 按
 * chapterSeq/order 升序；plotLocations = plotLocation 产物原样（11 条 id 逐一相同）。
 * 有意差异：① 真实库**省略**空 `appearanceId`（661 条中 107 条无该键）且 `locationId`/
 * `fromLocationId`/`toLocationId` 缺值写 **null**；本适配器按 `StageAction` 类型
 * （`app-types.ts:266`：characterId/locationId 为 string，from/toLocationId 为 string|null）
 * 写**严格 10 键**、缺值 `''`/`[]`——键集恒定更利于消费侧与差分比对，view 对 `''` 与
 * null 均按「无」处理（`view.ts` 只做透传）；② 真实库 `warnings` 是模型自述的地点缺失
 * 提示，本适配器的 warnings 是程序校验留痕（模型 warnings 数组若存在也一并收）。
 *
 * 合并策略：`concat-dedup-order` + 显式 `keyOf`（actions 无 id → 整串 JSON 兜底；plotLocations
 * 程序 id `L-*` 按 id、其余按 name——与 `lineAnnotationKeyOf` 双轨思路一致，理由见
 * `storyScriptKeyOf` 处注释）。
 */
import type { ChatMessage, LlmTaskAdapter, TaskRuntime, UpstreamEntry } from '../../../shared/pipeline-types'
import { numberLines } from '../chunk-source'
import { buildReadingMemory, renderMemory } from '../memory'
import { mapLocationTreeJson } from '../location-inputs'
import { readIndex } from '../../workspace/index-store'
import { parseJsonLoose } from './cacheWarming'
import { readRtSnapshot, stashRtSnapshot } from '../rt-stash'

/** 程序分配的剧情地点 id 形态（`L-{chunk}-l{n}`；keyOf 双轨与引用校验共用同一判定）。 */
const PLOT_LOCATION_ID_RE = /^L-\d+-l\d+$/

/** 模板名（变体选择见文件头）。 */
const BASE_TEMPLATE = 'story_script_user_prompt'
const COHERENT_TEMPLATE = 'story_script_coherent_user_prompt'

/** legacy 系风格值（回落 base 模板 + warning，理由见文件头）。 */
const LEGACY_STYLES: ReadonlySet<string> = new Set(['legacy', 'coherent-legacy'])

/** 短字段类型 → 长字段类型名（模板「t 表示 narration / s 表示 say / t 表示 think / b 表示 battle / m 表示 move」）。 */
const TYPE_NAMES: Readonly<Record<string, string>> = {
  n: 'narration',
  s: 'say',
  t: 'think',
  b: 'battle',
  m: 'move'
}

/**
 * 剧情地点引用规则短文（模板 `plotLocationRules` 变量；模板族把「【剧情地点】」小节留给
 * 调用方注入，本仓无对应资源文件，故按两套模板正文 + `plot_location_user_prompt` 的同族
 * 措辞逐条撰写：lId 引用输入中的 id、n/s/t/b 必填 lId、m 用 flId/tlId 且不输出 lId、
 * 谈论地名 ≠ 当前所在地、远程/回忆/梦境各自处理、不绑定世界根节点 novel-world）。
 */
const PLOT_LOCATION_RULES = [
  'lId 必须引用输入 plotLocations 中已存在的地点 id（形如 L-<chunk>-l<n>），不得自造、不得改写、不得引用其他 chunk 的 id。',
  'n/s/t/b 必须填写有效的 lId（该行动实际发生的剧情地点）；m 不输出 lId，起点与终点使用 flId、tlId，未知时省略。',
  '谈论到的地名不等于当前所在地：地点按行动实际发生的场景选择，角色口述某地不代表场景切换。',
  '远程交流按两侧各自的所在地填写；回忆与梦境按各自呈现的场景填写，不与现实场景混为一处。',
  '场景可以绑定到 mapLocationTree 中的具体地图地点；不要把场景绑定到世界根节点 novel-world——根节点表示全书世界，不是可演出的具体地点。',
  '地点目录已由前一阶段归纳，本阶段只引用不扩充：不新建地点、不合并地点、不改写地点名称。'
].join('\n')

/** 双形态解包：`{data:{…}}` 信封 → data；裸值原样。 */
function unwrapData(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const d = (value as Record<string, unknown>).data
    if (d !== undefined && d !== null) return d
  }
  return value
}

/** 字符串数组成员过滤（非字符串元素剔除；非数组 → `[]`）。 */
function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
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

/** 该章原文行（`text.split('\n')`——与 `numberLines` 逐行编号同口径，空串算 1 行）。 */
function linesOf(text: string): string[] {
  return (text ?? '').split('\n')
}

/** 一个输入人物形象（模板 `characters[].appearances[]`；字段集即契约）。 */
interface StoryAppearance {
  appearanceId: string
  name: string
  sex: string
  appearanceSummary: string
  visualKeywords: string[]
}

/** 一个输入人物（模板 `characters[]`；`name`/`aliases` 取不到见文件头）。 */
interface StoryCharacter {
  id: string
  name: string
  aliases: string[]
  appearances: StoryAppearance[]
}

/** buildMessages 挂载、parse 读取的快照（引用解析与主体归属的唯一依据）。 */
interface StoryScriptSnapshot {
  /** 本 chunk 的 plotLocations（parse 原样复制回去） */
  plotLocations: Record<string, unknown>[]
  /** appearanceId → charId（aId 派生 characterId） */
  appearanceToChar: Map<string, string>
  /** 合法人物 id 集合（cId/tIds 校验） */
  characterIds: Set<string>
  /** 本 chunk 章序（cs 校验） */
  chapterSeqs: number[]
  /** 各章原文行（引用解析；行号从 1 计） */
  chapterLines: Map<number, string[]>
}

/** 读 plot 产物（阅读记忆的唯一来源）；未挂 readUpstream → 可读错误（同 draft/plotLocation）。 */
async function readPlotEntries(rt: TaskRuntime): Promise<UpstreamEntry[]> {
  if (typeof rt.readUpstream !== 'function') {
    throw new Error('storyScript 需要 plot 产物（阅读记忆的唯一来源）：运行期未提供 readUpstream（rt 须由编排器 makeRuntime 构造）')
  }
  // plot 产物为空 → 空记忆（chunk 0 本就空，合法），不抛错
  return rt.readUpstream('plot')
}

/**
 * 读 characterAppearance 主条目 → 模板 `characters` 人物数组 + appearanceId→charId 映射 +
 * 合法人物 id 集合。无产物/无主条目 → 抛可读错误（模板 characters 是必填输入）。
 * 无可用形象的人物不进名单 + warning（模板要求 appearances 提供 appearanceId，缺则不可引用）。
 */
async function readCharacters(rt: TaskRuntime): Promise<{
  persons: StoryCharacter[]
  appearanceToChar: Map<string, string>
  characterIds: Set<string>
}> {
  if (typeof rt.readUpstream !== 'function') {
    throw new Error('storyScript 需要 characterAppearance 产物：运行期未提供 readUpstream（rt 须由编排器 makeRuntime 构造）')
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
    throw new Error('storyScript 需要 characterAppearance 产物：工作库中没有任何 characterAppearance 主条目，请先运行 characterAppearance 任务')
  }
  const persons: StoryCharacter[] = []
  const appearanceToChar = new Map<string, string>()
  const characterIds = new Set<string>()
  for (const [charId, arr] of Object.entries(map)) {
    characterIds.add(charId)
    if (!Array.isArray(arr)) continue
    const appearances: StoryAppearance[] = []
    for (const ap of arr) {
      if (!ap || typeof ap !== 'object' || Array.isArray(ap)) continue
      const o = ap as Record<string, unknown>
      if (typeof o.appearanceId !== 'string' || !o.appearanceId) continue
      appearanceToChar.set(o.appearanceId, charId)
      appearances.push({
        appearanceId: o.appearanceId,
        name: typeof o.name === 'string' ? o.name : '',
        sex: typeof o.sex === 'string' ? o.sex : '',
        appearanceSummary: typeof o.appearanceSummary === 'string' ? o.appearanceSummary : '',
        visualKeywords: stringArray(o.visualKeywords)
      })
    }
    if (!appearances.length) {
      rt.warnings.push(`storyScript：人物 ${charId} 无可用形象（appearanceId 缺失），未进模板人物名单（该人物仍可只填 cId）`)
      continue
    }
    // name/aliases 取不到（产物按 charId 索引形象、不含姓名与别名，见文件头）
    persons.push({ id: charId, name: '', aliases: [], appearances })
  }
  return { persons, appearanceToChar, characterIds }
}

/** 本 chunk 的 plotLocation 产物条目（`{id:'L-0-l1', …}`；程序 id 原样保留）。 */
async function readChunkPlotLocations(rt: TaskRuntime): Promise<Record<string, unknown>[]> {
  const self = rt.chunkIndex ?? 0
  if (typeof rt.readUpstream !== 'function') {
    throw new Error('storyScript 需要 plotLocation 产物：运行期未提供 readUpstream（rt 须由编排器 makeRuntime 构造）')
  }
  const entries = await rt.readUpstream('plotLocation')
  for (const e of entries) {
    if (chunkIndexOfKey(e.key) !== self) continue
    const data = unwrapData(e.value)
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue
    const plotLocations = (data as Record<string, unknown>).plotLocations
    if (!Array.isArray(plotLocations)) continue
    return plotLocations.filter(
      (p): p is Record<string, unknown> => !!p && typeof p === 'object' && !Array.isArray(p) && typeof (p as Record<string, unknown>).id === 'string'
    )
  }
  throw new Error(`storyScript 需要 plotLocation 产物：工作库中没有 chunk ${self} 的 plotLocation 结果，请先运行 plotLocation 任务`)
}

/**
 * 取 locationTree 产物数据（双形态 `value?.data ?? value`，取首条可用对象）。
 * 无产物/未挂 readUpstream → 抛可读错误（模板 `mapLocationTree` 变量是必填输入）。
 */
async function readLocationTreeData(rt: TaskRuntime): Promise<Record<string, unknown>> {
  if (typeof rt.readUpstream !== 'function') {
    throw new Error('storyScript 需要 locationTree 产物：运行期未提供 readUpstream（rt 须由编排器 makeRuntime 构造）')
  }
  const entries = await rt.readUpstream('locationTree')
  for (const e of entries) {
    const v = e.value as { data?: unknown } | null
    const data = v && typeof v === 'object' && v.data && typeof v.data === 'object' ? v.data : v
    if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>
  }
  throw new Error('storyScript 需要 locationTree 产物：工作库中没有任何 locationTree 结果，请先运行 locationTree 任务')
}

/**
 * 选模板变体（读 `manifest.project.storyScriptStyle`；规则与理由见文件头）。
 * 读不到（未挂 rt.root / index.json 缺失或损坏）→ base + warning，**不抛**——模板选择
 * 是表现层细节，不该阻断任务。
 */
async function pickTemplate(rt: TaskRuntime): Promise<string> {
  if (!rt.root) {
    rt.warnings.push('storyScript：运行期未提供工作库根（rt.root），无法读取 manifest.project.storyScriptStyle，回落 base 模板')
    return BASE_TEMPLATE
  }
  let style = ''
  try {
    const idx = await readIndex(rt.root)
    const project = idx.manifest?.project ?? {}
    const v = (project as Record<string, unknown>).storyScriptStyle
    style = typeof v === 'string' ? v.trim() : ''
  } catch (e) {
    rt.warnings.push(`storyScript：读取工作库索引失败（${(e as Error).message}），无法判定 storyScriptStyle，回落 base 模板`)
    return BASE_TEMPLATE
  }
  if (style === 'coherent') return COHERENT_TEMPLATE
  if (LEGACY_STYLES.has(style)) {
    rt.warnings.push(`storyScript：storyScriptStyle="${style}" 属 legacy 系变体，本架构不支持（legacy 要求模型自产 plotLocations 目录，与 plotLocation 任务重复且自产 id 无法与 L-{chunk}-l{n} 对齐），回落 base 模板`)
    return BASE_TEMPLATE
  }
  return BASE_TEMPLATE
}

/** 引用标记（`@#` 起、`#@` 止，内含行号/区间/空格分隔列表；模板【原文行引用】段）。 */
const REF_MARKER_RE = /@#([^#]*)#@/g

/** 引用标记内部的单个 token（`12` 或 `12-15`）。 */
const REF_TOKEN_RE = /^(\d+)(?:-(\d+))?$/

/**
 * 把一条正文里的引用标记解析为原文行文本。
 *
 * 规则（模板【原文行引用】段逐字）：`@#12#@` 单行 / `@#12-15#@` 连续行 / `@#12 14 16-17#@`
 * 不连续行；范围含首尾；行号来自当前 action.cs 对应章节（不跨章、不重新计数）。
 * **不可解析或越界 → warning + 保留原标记串**（不猜、不截断——猜错比留标记更坏，
 * 留标记至少能让人看见模型原本引用了哪几行）。
 */
function resolveRefs(
  text: string,
  chapterSeq: number,
  lines: string[] | undefined,
  warn: (msg: string) => void
): string {
  return text.replace(REF_MARKER_RE, (whole: string, inner: string) => {
    if (!lines) {
      warn(`storyScript：章 ${chapterSeq} 无原文行表（缺快照），保留引用标记 ${whole}`)
      return whole
    }
    const tokens = String(inner)
      .trim()
      .split(/[\s,，、]+/)
      .filter((t) => t.length > 0)
    if (!tokens.length) {
      warn(`storyScript：章 ${chapterSeq} 的引用标记 ${whole} 未含行号，保留原标记`)
      return whole
    }
    const nums: number[] = []
    for (const tok of tokens) {
      const m = REF_TOKEN_RE.exec(tok)
      if (!m) {
        warn(`storyScript：章 ${chapterSeq} 的引用标记 ${whole} 含无法解析的片段「${tok}」，保留原标记`)
        return whole
      }
      const a = Number(m[1])
      const b = m[2] === undefined ? a : Number(m[2])
      if (a > b) {
        warn(`storyScript：章 ${chapterSeq} 的引用区间 ${tok} 首尾颠倒，保留原标记 ${whole}`)
        return whole
      }
      for (let n = a; n <= b; n++) nums.push(n)
    }
    const outOfRange = nums.find((n) => n < 1 || n > lines.length)
    if (outOfRange !== undefined) {
      warn(`storyScript：章 ${chapterSeq} 的引用行号 ${outOfRange} 越出本章 1..${lines.length}，保留原标记 ${whole}`)
      return whole
    }
    return nums.map((n) => lines[n - 1]).join('\n')
  })
}

/**
 * actions / plotLocations 的稳定键（供 `concat-dedup-order` 的 dedupeDeep 用）。
 *
 * 【为什么不能只按 id（合并先于 parse 的现实约束）】`mergeOutputs` 在 parse **之前**对
 * **原始模型文本**合并（orchestrator：`runWithBatching(…) → adapter.parse(result.output, rt)`），
 * 故 keyOf 看到的是**短字段** actions（`cs`/`o`/`t`/`txt`…）——它们没有 id，只能整串 JSON
 * 兜底（同一批里完全相同的行动才相消；跨批同章的行动因 `o` 不同而不同串，不会误塌）。
 * plotLocations 双轨（同 `lineAnnotationKeyOf`）：程序 id `L-{chunk}-l{n}` → 按 id（全局唯一）；
 * 其余（理论上本适配器不产，前向兼容手工产物）→ 按 `name`——模型本地 id 每批都从 l1 起，
 * 按 id 去重会跨批碰撞整批误删。
 */
export function storyScriptKeyOf(part: unknown): string {
  if (Array.isArray(part)) {
    try {
      return JSON.stringify(part)
    } catch {
      return String(part)
    }
  }
  if (part && typeof part === 'object') {
    const o = part as Record<string, unknown>
    if (typeof o.id === 'string' && PLOT_LOCATION_ID_RE.test(o.id)) return o.id
    if (typeof o.name === 'string' && o.name.trim().length > 0) return `name:${o.name.trim()}`
  }
  try {
    return JSON.stringify(part)
  } catch {
    return String(part)
  }
}

export const storyScriptAdapter: LlmTaskAdapter = {
  id: 'storyScript',
  mergeStrategy: 'concat-dedup-order',
  keyOf: storyScriptKeyOf,
  // 输出 actions 引用本地地点/形象 id，切批必然错乱（理由见文件头）→ 声明单批意图
  batching: { inputBudgetTokens: 100000 },

  async inputText(rt: TaskRuntime): Promise<string> {
    // 与 cacheWarming/seg/plot/plotLocation/lineAnnotation 逐字同构
    return numberLines(chaptersOf(rt))
  },

  async buildMessages(batchText: string, rt: TaskRuntime): Promise<ChatMessage[]> {
    const { persons, appearanceToChar, characterIds } = await readCharacters(rt)
    const plotLocations = await readChunkPlotLocations(rt)
    const treeData = await readLocationTreeData(rt)
    const chapters = chaptersOf(rt)
    const chapterSeqs = chapters.map((c) => c.seq).filter((n) => Number.isFinite(n))
    // 各章原文行（引用解析用；行号从 1 计）
    const chapterLines = new Map<number, string[]>()
    for (const c of chapters) {
      if (Number.isFinite(c.seq)) chapterLines.set(c.seq, linesOf(c.text))
    }
    // 快照：parse 的引用解析/主体归属/地点复制全部依赖它。必须在 buildMessages stash
    //（inputText 的 rt0 与 parse 的 rt 不是同一实例，见 ../rt-stash 文件头）
    stashRtSnapshot(rt, {
      plotLocations,
      appearanceToChar,
      characterIds,
      chapterSeqs,
      chapterLines
    } satisfies StoryScriptSnapshot)

    const system = await rt.render('common_system_prompt', {})
    const templateName = await pickTemplate(rt)
    const instruction = await rt.render(templateName, {
      chunkIndex: rt.chunkIndex ?? 0,
      // 模板为直接插值用法 → 传 join 后的字符串；无章节信息时回退 '1'
      chapterSeqs: chapterSeqs.length ? chapterSeqs.join(',') : '1',
      // 阅读记忆：chunks 0..i-1 的 plot 摘要，现算（见 ../memory.ts）
      chunkReadingMemory: renderMemory(buildReadingMemory(await readPlotEntries(rt), rt.chunkIndex ?? 0)),
      // 人物与形象名单（预序列化 JSON 字符串；prompt-loader 对 JS 数组会换行拼接）
      characters: JSON.stringify(persons),
      // 地图地点完整树（不剪枝，理由见 ../location-inputs 文件头）
      mapLocationTree: mapLocationTreeJson(treeData),
      // 本 chunk 剧情地点目录（程序 id L-{chunk}-l{n} 原样，是场景引用基准）
      plotLocations: JSON.stringify(plotLocations),
      // 地点引用规则（适配器内 authored 常量，见 PLOT_LOCATION_RULES）
      plotLocationRules: PLOT_LOCATION_RULES
    })
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
    const snapshot = readRtSnapshot<StoryScriptSnapshot>(rt)
    const obj = parseJsonLoose(content)
    const o = obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null

    // ---- 1. 协议校验：actions 必须是数组（缺 → raw 兜底，不抛崩）----
    if (!o || !Array.isArray(o.actions)) {
      warn('storyScript：模型输出无法解析为脚本协议（缺 actions 数组），走 raw 兜底')
      return {
        protocol: 'map-plot-v1',
        actions: [],
        plotLocations: [],
        warnings,
        raw: (content ?? '').slice(0, 500)
      }
    }
    // 模型自述 warnings（数组则收，非数组忽略）
    if (Array.isArray(o.warnings)) {
      for (const w of o.warnings) {
        if (typeof w === 'string' && w) warnings.push(w)
      }
    }

    // 快照派生（缺快照 → 各自降级：地点/形象引用不校验，章序退回 rt.chunkChapters）
    const snapshotPlotLocations = snapshot?.plotLocations ?? []
    const locIds = new Set<string>()
    for (const p of snapshotPlotLocations) {
      const id = p.id
      if (typeof id === 'string' && id) locIds.add(id)
    }
    const hasLocSnapshot = locIds.size > 0
    const appearanceToChar = snapshot?.appearanceToChar ?? null
    const characterIds = snapshot?.characterIds ?? null
    const chapterLines = snapshot?.chapterLines ?? null
    const chapterSeqs = snapshot?.chapterSeqs?.length
      ? snapshot.chapterSeqs
      : (rt?.chunkChapters ?? []).map((c) => c.seq).filter((n) => Number.isFinite(n))
    const seqSet = new Set(chapterSeqs)
    let warnedUnknownCid = false

    /** 归一后的一条行动（order 尚未重编）。 */
    interface NormAction {
      chapterSeq: number
      /** 模型给的短字段 o（非有限整数时按数组位置兜底，见重编号段） */
      o: number
      type: string
      characterId: string
      locationId: string
      fromLocationId: string
      toLocationId: string
      targetIds: string[]
      text: string
      appearanceId: string
    }
    const norms: NormAction[] = []

    // ---- 2. 逐条短字段校验 + 引用解析 ----
    for (const item of o.actions) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        warn(`storyScript：跳过非对象的 actions 条目（${JSON.stringify(item)?.slice(0, 80) ?? 'null'}）`)
        continue
      }
      const a = item as Record<string, unknown>
      // t ∈ n/s/t/b/m
      const shortType = typeof a.t === 'string' ? a.t : ''
      if (!Object.prototype.hasOwnProperty.call(TYPE_NAMES, shortType)) {
        warn(`storyScript：跳过行动类型非法的条目（t=${JSON.stringify(a.t) ?? 'undefined'}，合法值 n/s/t/b/m）`)
        continue
      }
      const type = TYPE_NAMES[shortType]
      // cs ∈ 本 chunk 章序
      const cs = typeof a.cs === 'number' && Number.isFinite(a.cs) && Number.isInteger(a.cs) ? a.cs : null
      if (cs === null) {
        warn(`storyScript：跳过章序号非整数的条目（cs=${JSON.stringify(a.cs) ?? 'undefined'}）`)
        continue
      }
      if (seqSet.size && !seqSet.has(cs)) {
        warn(`storyScript：跳过章序号越界的条目（cs=${cs} 不在本 chunk 章序 ${chapterSeqs.join(',')}）`)
        continue
      }
      // 引用解析（行号来自当前 action.cs 对应章节）
      const rawText = typeof a.txt === 'string' ? a.txt : ''
      const text = resolveRefs(rawText, cs, chapterLines?.get(cs), warn)
      if (text.trim().length === 0) {
        warn(`storyScript：跳过空正文行动（cs=${cs}，t=${shortType}；模板「不输出空正文行动」）`)
        continue
      }
      // 地点引用
      let locationId = ''
      let fromLocationId = ''
      let toLocationId = ''
      if (shortType === 'm') {
        // m 不输出 locationId；起终点用 flId/tlId
        for (const [field, raw] of [
          ['flId', a.flId],
          ['tlId', a.tlId]
        ] as [string, unknown][]) {
          if (raw === undefined || raw === null || raw === '') continue
          if (typeof raw !== 'string') {
            warn(`storyScript：跳过非法 ${field}（cs=${cs}，值 ${JSON.stringify(raw)}）`)
            continue
          }
          if (hasLocSnapshot && !locIds.has(raw)) {
            warn(`storyScript：${field}=${raw} 不在本 chunk 剧情地点目录中，省略该字段（cs=${cs}）`)
            continue
          }
          if (field === 'flId') fromLocationId = raw
          else toLocationId = raw
        }
      } else {
        const lId = typeof a.lId === 'string' ? a.lId : ''
        if (!lId) {
          warn(`storyScript：跳过缺 lId 的 ${shortType} 行动（cs=${cs}；模板「n/s/t/b 必须填写有效 lId」）`)
          continue
        }
        if (hasLocSnapshot && !locIds.has(lId)) {
          warn(`storyScript：跳过 lId=${lId} 无效的 ${shortType} 行动（cs=${cs}；不在本 chunk 剧情地点目录中）`)
          continue
        }
        locationId = lId
      }
      // 交战目标（仅 b）
      const targetIds: string[] = []
      if (shortType === 'b') {
        for (const t of Array.isArray(a.tIds) ? a.tIds : []) {
          if (typeof t !== 'string' || !t) {
            warn(`storyScript：b 行动（cs=${cs}）的 targetId 非非空字符串（${JSON.stringify(t) ?? 'undefined'}），丢弃`)
            continue
          }
          if (characterIds && !characterIds.has(t)) {
            warn(`storyScript：b 行动（cs=${cs}）的 targetId=${t} 不在人物名单中，丢弃`)
            continue
          }
          if (targetIds.includes(t)) continue // 同一行动重复目标去重（首现获胜）
          targetIds.push(t)
        }
      }
      // 主体与形象
      const rawAid = typeof a.aId === 'string' ? a.aId : ''
      let appearanceId = ''
      let derivedCharId = ''
      if (rawAid) {
        if (appearanceToChar && !appearanceToChar.has(rawAid)) {
          warn(`storyScript：aId=${rawAid} 不在 characterAppearance 形象集中，省略该字段（cs=${cs}）`)
        } else {
          appearanceId = rawAid
          derivedCharId = appearanceToChar?.get(rawAid) ?? ''
        }
      }
      let characterId = typeof a.cId === 'string' && a.cId ? a.cId : derivedCharId
      if (characterId && characterIds && !characterIds.has(characterId) && !warnedUnknownCid) {
        warnedUnknownCid = true
        warn(`storyScript：cId=${characterId} 不在人物名单中（保留原值，交由下游判定）`)
      }
      // 主体要求：s/t/b 必须有主体；n 可无；m 无主体保留但 warning
      if (!characterId && (shortType === 's' || shortType === 't' || shortType === 'b')) {
        warn(`storyScript：跳过无主体的 ${shortType} 行动（cs=${cs}；模板「没有展示人物时省略」仅适用于旁白）`)
        continue
      }
      if (!characterId && shortType === 'm') {
        warn(`storyScript：m 行动无主体（cs=${cs}），保留该行动（移动可由旁白叙述）`)
      }
      // o：非有限整数时按数组位置兜底（重编号段会再报一次汇总 warning）
      const oRaw = a.o
      const orderRaw = typeof oRaw === 'number' && Number.isFinite(oRaw) ? oRaw : norms.length
      norms.push({
        chapterSeq: cs,
        o: orderRaw,
        type,
        characterId,
        locationId,
        fromLocationId,
        toLocationId,
        targetIds,
        text,
        appearanceId
      })
    }

    // ---- 3. order 防御性重编号（每章按 o 升序稳定排序 → 0..n-1）----
    const byChapter = new Map<number, NormAction[]>()
    for (const n of norms) {
      const list = byChapter.get(n.chapterSeq)
      if (list) list.push(n)
      else byChapter.set(n.chapterSeq, [n])
    }
    const actions: Record<string, unknown>[] = []
    for (const cs of [...byChapter.keys()].sort((x, y) => x - y)) {
      const list = byChapter.get(cs)!
      // 稳定排序：两侧 o 都是有限数字才比较（脏值保持模型顺序，避免把行动挪到章尾）
      const sorted = list
        .slice()
        .sort((x, y) => (Number.isFinite(x.o) && Number.isFinite(y.o) ? x.o - y.o : 0))
      const needsRenumber = sorted.some((x, i) => x.o !== i)
      if (needsRenumber) {
        warn(`storyScript：章 ${cs} 的 order 需重编号（模型 o=[${list.map((x) => String(x.o)).join(',')}]，重编 0..${list.length - 1}）`)
      }
      sorted.forEach((x, i) => {
        // ---- 4. 输出严格 10 键长字段（空值 '' / []）----
        actions.push({
          appearanceId: x.appearanceId,
          chapterSeq: cs,
          order: i,
          type: x.type,
          characterId: x.characterId,
          locationId: x.locationId,
          fromLocationId: x.fromLocationId,
          toLocationId: x.toLocationId,
          targetIds: x.targetIds,
          text: x.text
        })
      })
    }

    // ---- 5. plotLocations 从快照原样复制（= plotLocation 产物）+ 6. protocol 程序字段 ----
    return {
      protocol: 'map-plot-v1',
      actions,
      plotLocations: snapshotPlotLocations.map((p) => ({ ...p })),
      warnings
    }
  }
}

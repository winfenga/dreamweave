/**
 * `plotLocation` 任务适配器（T6-F 第六批；模板 `plot_location_user_prompt`）。
 *
 * 产物：`world/plot-locations.json`（**叶真源单文件**，per-chunk 任务每 chunk 一条目，
 * key 形如 `<pkgId>:<revisionId>:plotLocation:<n>`；路由见 `../upstream.ts` 的
 * `matchesTaskFile` → `PLOT_LOCATIONS_FILE`）。
 * 消费端：`t2w/view.ts:310-315` 从 storyScript 各 chunk 的 `plotLocations` 汇入、
 * `view.ts:415-443` 生成 scenes/scenesByNode（读 `p.id/p.name/p.mapLocationId/p.ancId/
 * p.identInfos/p.summary/p.sceneDescription/p.chunkIndex`）。
 *
 * 输入：**带行号原文**（与 cacheWarming/seg/plot 逐字同构：各章从 1 重新编号、每章外包
 * `【原文行：1-N】`；见 `../chunk-source`）——`inputText` 只产原文，其余模板变量在
 * `buildMessages` 现算（读上游组装一律在此做，parse 是同步函数，见 T6-F ① 接口约束）。
 *
 * 【模板变量（以模板实际占位符为准，逐字读过 `plot_location_user_prompt.txt`）】共 5 个：
 *  - `chunkIndex` = `rt.chunkIndex ?? 0`；
 *  - `chapterSeqs` = 本章序号 join 字符串（同 chunkLocationSummary 口径：`"5,6"`，
 *    无章节信息回退 `'1'`——模板为直接插值用法，传数组会被 stringifyVar 换行拼接）；
 *  - `chunkReadingMemory` = `renderMemory(buildReadingMemory(plot 产物, self))` 现算
 *    （阅读记忆是 plot 产物的纯派生数据，见 `../memory.ts`；plot 产物为空 → 空记忆，
 *    chunk 0 本就空，合法；未挂 readUpstream → 可读错误，与 draft 同口径）；
 *  - `characters` = **本片人物**：`rt.readUpstream('draftAlign')` 取 key 以
 *    `:draftAlign:{self}` 结尾的条目 → `data.characters` → 只取 id/name/aliases 三字段
 *    （模板原文「人物名单用于辨认“某人的住处”等空间，不需要人物形象」）序列化为 JSON
 *    字符串；无 draftAlign 产物 → 空数组 `[]` + rt.warnings 记一条，**不抛**（人物仅
 *    辅助空间辨认，缺失不阻断）；
 *  - `mapLocationTree` = `mapLocationTreeJson(locationTree 产物)`（`../location-inputs`；
 *    **完整树不剪枝**——剧情地点常绑定不可展示节点，理由见该模块文件头）；无 locationTree
 *    产物 → 抛可读错误。
 *
 * 【为什么 buildMessages 发 3 条消息（与 worldImpression/locationTree 的 2 条不同）】
 * 模板【本次输入】区只嵌变量（chunkIndex/chapterSeqs/chunkReadingMemory/characters/
 * mapLocationTree），原文**不作变量嵌入**——模板原文：「当前 chunk 原文：见前面的带行号
 * user 消息」。故原文必须单独作一条 user 消息先行喂入：system（common_system_prompt）+
 * user（带行号原文）+ user（渲染后的任务指令）= 3 条（与 cacheWarming/seg/plot/draft 同构）。
 *
 * 【parse：程序重编全局唯一 id（醒目，本适配器核心纪律）】
 * 模型输出的 `plotLocations` 数组按序分配 `L-{rt.chunkIndex ?? 0}-l{n+1}`（n 从 0 计，
 * **只对保留条目递增**——编号连续无洞，对齐真实数据 `L-0-l1`/`L-0-l2` 形态）。**模型自产
 * id（模板契约「本次目录内唯一的短 ID，如 l1、l2」）是 chunk 本地短 id，跨 chunk 必然
 * 碰撞**（每 chunk 都从 l1 起），故程序重编、**模型 id 一律不保留**。rt 缺失（测试/合成
 * 调用）时 chunkIndex 按 0 兜底。
 * 逐条校验（无效条目跳过 + warning，不抛崩）：
 *  - `name` 非空字符串（模板「必填」）——缺 → 跳过 + warning；
 *  - `mapLocationId` / `ancId` 非空字符串才保留（否则**省略**——模板「没有则省略」）；
 *  - `identInfos` 字符串数组（缺省 `[]`）；
 *  - `summary` / `sceneDescription` 字符串（缺省 `''`）；
 *  - 每条输出带 `chunkIndex`（view.ts:432 读 `p.chunkIndex ?? 0`）。
 * 输出：`{protocol:'map-plot-v1', actions:[], plotLocations:[…], warnings}`——**protocol
 * 与空 actions 是程序字段**（对齐真实库同文件族 storyScript 的形状；模板只让模型产
 * plotLocations，且明言「不要输出 actions 或逐行地点标注」）。模型 warnings（数组则收）。
 *
 * 【id 的引用基准地位（T6-G 直接消费）】`L-{chunk}-l{n}` 是后续 storyScript /
 * lineAnnotation / plotLocationMerge 对该 chunk 剧情地点的引用键——storyScript 的
 * `locationId`、lineAnnotation 的逐行地点标注都按它指认场景，故重编规则（chunkIndex +
 * 保留序）必须确定、稳定、跨 run 一致。本批**不实现 lineAnnotation**（它依赖
 * characterAppearance，尚未实现）。
 *
 * 【与真实库 `5662f1d3` 的 `world/plot-locations.json` 逐字段对比结论】
 * 对齐：每 chunk 一条目（key `…:plotLocation:<n>`）；data 顶层
 * `{protocol:'map-plot-v1', actions:[], plotLocations:[…], warnings}`；条目字段
 * `{id:'L-0-l1', name, mapLocationId, ancId, identInfos, summary, sceneDescription,
 * chunkIndex}`。
 * 有意差异：① 真实库 `mapLocationId` 无对应节点时保留**null 字段**（实测 `L-0-l2`
 * `mapLocationId:null` + `ancId:'M-9'`），本适配器按模板「没有则省略」**省略该字段**；
 * ② 真实库条目 value 外包 `{data, responsePath, cacheReadyAt}`（persistence 信封，
 * 与适配器无关——parse 只负责 data 内容）。
 *
 * 合并策略：`concat-dedup-order` + 显式 `keyOf`（按程序分配的 id；合并先于 parse 的
 * 现实约束与 name 兜底理由见 `plotLocationKeyOf` 处注释）。
 */
import type { ChatMessage, LlmTaskAdapter, TaskRuntime, UpstreamEntry } from '../../../shared/pipeline-types'
import { numberLines } from '../chunk-source'
import { buildReadingMemory, renderMemory } from '../memory'
import { mapLocationTreeJson } from '../location-inputs'
import { parseJsonLoose } from './cacheWarming'

/** 程序分配的剧情地点 id 形态（`L-{chunk}-l{n}`；keyOf 与重编规则共用同一判定）。 */
const PLOT_LOCATION_ID_RE = /^L-\d+-l\d+$/

/**
 * plotLocations 条目的稳定键（供 `concat-dedup-order` 的 dedupeDeep 用）。
 *
 * 【为什么不能只按 id（读引擎后结论，重要）】`mergeOutputs` 在 parse **之前**对**原始
 * 模型文本**合并（orchestrator：`runWithBatching(input, …, {keyOf}) → adapter.parse(
 * result.output, rt)`），故合并时 keyOf 看到的是模型自产的 chunk 本地短 id（l1/l2）——
 * 若只按 id 去重，L2 切批时各批都从 l1 起编号，跨批 l1 互相碰撞、后批条目被整批误删。
 * 故分三种键：
 *  - 程序分配的 id（`L-{chunk}-l{n}`；parse 产物再合并的场景）→ 按 id 键（全局唯一，
 *    跨批/跨 chunk 不相消——per-chunk 条目各自落盘，正常不经此路径，此为前向兼容）；
 *  - 模型本地 id 或缺 id → 按 `name` 键（同实体跨批重名才相消，与 `draftKeyOf` 同
 *    rationale：模板契约「同一 chunk 内同一实际地点使用一个 ID」，name 是 chunk 内唯一
 *    稳定标识；缺省 `defaultKeyOf` 会误取模型短 id `id` 字段造成上述碰撞）；
 *  - 字符串元素（warnings 形态）→ `warn:` 前缀键，避免与地点条目相消。
 */
export function plotLocationKeyOf(part: unknown): string {
  if (typeof part === 'string') return `warn:${part}`
  if (part && typeof part === 'object' && !Array.isArray(part)) {
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

/** 字符串数组成员过滤（非字符串元素剔除；非数组 → `[]`）。 */
function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

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

/** 读 plot 产物（阅读记忆的唯一来源）；未挂 readUpstream → 可读错误（与 draft 同口径）。 */
async function readPlotEntries(rt: TaskRuntime): Promise<UpstreamEntry[]> {
  if (typeof rt.readUpstream !== 'function') {
    throw new Error('plotLocation 需要 plot 产物（阅读记忆的唯一来源）：运行期未提供 readUpstream（rt 须由编排器 makeRuntime 构造）')
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
    throw new Error('plotLocation 需要 locationTree 产物：运行期未提供 readUpstream（rt 须由编排器 makeRuntime 构造）')
  }
  const entries = await rt.readUpstream('locationTree')
  for (const e of entries) {
    const v = e.value as { data?: unknown } | null
    const data = v && typeof v === 'object' && v.data && typeof v.data === 'object' ? v.data : v
    if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>
  }
  throw new Error('plotLocation 需要 locationTree 产物：工作库中没有任何 locationTree 结果，请先运行 locationTree 任务')
}

/**
 * 本片人物（模板 `characters` 变量）：draftAlign 产物中 key 以 `:draftAlign:{self}` 结尾
 * 的条目 → `data.characters` → 只取 id/name/aliases 三字段（模板「不需要人物形象」）。
 * 无产物/未挂 readUpstream/本 chunk 无条目 → 空数组 + rt.warnings 记一条，**不抛**
 * （人物仅辅助空间辨认，缺失不阻断）。
 */
async function readChunkCharacters(rt: TaskRuntime): Promise<Record<string, unknown>[]> {
  const self = rt.chunkIndex ?? 0
  if (typeof rt.readUpstream !== 'function') {
    rt.warnings.push('plotLocation：运行期未提供 readUpstream——本片人物传空数组（模板仅用于空间辨认，不阻断）')
    return []
  }
  const entries = await rt.readUpstream('draftAlign')
  const suffix = `:draftAlign:${self}`
  for (const e of entries) {
    if (!String(e.key).endsWith(suffix)) continue
    const v = e.value as { data?: unknown } | null
    const data = v && typeof v === 'object' && v.data && typeof v.data === 'object' ? v.data : v
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue
    const chars = (data as Record<string, unknown>).characters
    if (!Array.isArray(chars)) break
    return chars
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && !Array.isArray(c))
      .map((c) => ({
        id: typeof c.id === 'string' ? c.id : '',
        name: typeof c.name === 'string' ? c.name : '',
        aliases: aliasArray(c.aliases)
      }))
  }
  rt.warnings.push(`plotLocation：chunk ${self} 无 draftAlign 产物——本片人物传空数组（模板仅用于空间辨认，不阻断）`)
  return []
}

/**
 * 从 rt 推导模板变量（`plot_location_user_prompt` 的 5 个 `{{{var}}}` 占位符）。
 * 缺 chunkChapters 时视作单章（seq=1）并给合理回退，绝不传 undefined。
 */
async function plotLocationTemplateVars(rt: TaskRuntime): Promise<Record<string, unknown>> {
  const chapters = rt.chunkChapters ?? [{ seq: 1, title: '（单章原文）', text: rt.chunkText }]
  const seqs = chapters.map((c) => c.seq).filter((n) => Number.isFinite(n))
  const selfChunkIndex = rt.chunkIndex ?? 0
  const lt = await readLocationTreeData(rt)
  return {
    chunkIndex: selfChunkIndex,
    // 模板为直接插值用法 → 传 join 后的字符串；无章节信息时回退 '1'
    chapterSeqs: seqs.length ? seqs.join(',') : '1',
    // 阅读记忆：chunks 0..i-1 的 plot 摘要，现算（见 ../memory.ts）
    chunkReadingMemory: renderMemory(buildReadingMemory(await readPlotEntries(rt), selfChunkIndex)),
    // 本片人物：预序列化 JSON 字符串（prompt-loader 对 JS 数组会换行拼接）
    characters: JSON.stringify(await readChunkCharacters(rt)),
    // 地图地点完整树（不剪枝，理由见 ../location-inputs 文件头）
    mapLocationTree: mapLocationTreeJson(lt)
  }
}

export const plotLocationAdapter: LlmTaskAdapter = {
  id: 'plotLocation',
  mergeStrategy: 'concat-dedup-order',
  keyOf: plotLocationKeyOf,

  async inputText(rt: TaskRuntime): Promise<string> {
    // 与 cacheWarming/seg/plot 逐字同构：有章节切片按「各章从 1 重新编号」组装；
    // 否则（调用方直接注入 chunkText）视作单章原文。
    const chapters = rt.chunkChapters ?? [{ seq: 1, title: '（单章原文）', text: rt.chunkText }]
    return numberLines(chapters)
  },

  async buildMessages(batchText: string, rt: TaskRuntime): Promise<ChatMessage[]> {
    const system = await rt.render('common_system_prompt', {})
    const instruction = await rt.render('plot_location_user_prompt', await plotLocationTemplateVars(rt))
    // 原文单独一条 user 消息在前、任务指令放最后（模板「当前 chunk 原文：见前面的带行号 user 消息」）
    return [
      { role: 'system', content: system },
      { role: 'user', content: batchText },
      { role: 'user', content: instruction }
    ]
  },

  parse(content: string, rt?: TaskRuntime): unknown {
    const warnings: string[] = []
    // 程序重编 id 的 chunk 段（rt 缺失按 0 兜底——测试/合成调用；同步字段直读，无 IO）
    const chunkIndex = rt?.chunkIndex ?? 0
    const obj = parseJsonLoose(content)
    const o = obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null

    // ---- 协议校验：plotLocations 必须是数组（缺 → raw 兜底，不抛崩）----
    if (!o || !Array.isArray(o.plotLocations)) {
      warnings.push('plotLocation：模型输出无法解析为剧情地点目录协议（缺 plotLocations 数组），走 raw 兜底')
      return {
        protocol: 'map-plot-v1',
        actions: [],
        plotLocations: [],
        warnings,
        raw: (content ?? '').slice(0, 500)
      }
    }
    // 模型 warnings（数组则收，非数组忽略）
    if (Array.isArray(o.warnings)) {
      for (const w of o.warnings) {
        if (typeof w === 'string' && w) warnings.push(w)
      }
    }

    // ---- 逐条校验 + 程序重编 id（无效条目跳过 + warning，不抛崩）----
    const plotLocations: Record<string, unknown>[] = []
    let n = 0
    for (const item of o.plotLocations) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        warnings.push(`plotLocation：跳过非对象的 plotLocations 条目（${JSON.stringify(item)?.slice(0, 80) ?? 'null'}）`)
        continue
      }
      const p = item as Record<string, unknown>
      // name 必填非空字符串（模板「name：具体场景名称，必填」）
      if (typeof p.name !== 'string' || p.name.trim().length === 0) {
        warnings.push(`plotLocation：跳过缺 name 的 plotLocations 条目（${JSON.stringify(p)?.slice(0, 80) ?? 'null'}）`)
        continue
      }
      n++
      plotLocations.push({
        // 程序分配全局唯一 id（模型自产 id 是 chunk 本地短 id、跨 chunk 碰撞，不保留）
        id: `L-${chunkIndex}-l${n}`,
        name: p.name,
        // mapLocationId/ancId 非空字符串才保留（模板「没有则省略」）
        ...(typeof p.mapLocationId === 'string' && p.mapLocationId ? { mapLocationId: p.mapLocationId } : {}),
        ...(typeof p.ancId === 'string' && p.ancId ? { ancId: p.ancId } : {}),
        identInfos: stringArray(p.identInfos),
        summary: typeof p.summary === 'string' ? p.summary : '',
        sceneDescription: typeof p.sceneDescription === 'string' ? p.sceneDescription : '',
        chunkIndex
      })
    }

    // protocol + 空 actions 是程序字段（对齐真实库同文件族 storyScript 形状，见文件头）
    return { protocol: 'map-plot-v1', actions: [], plotLocations, warnings }
  }
}

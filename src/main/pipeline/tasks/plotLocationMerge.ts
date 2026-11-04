/**
 * `plotLocationMerge` 任务适配器（T6-H 第八批；模板 `plot_location_merge_user_prompt`）。
 *
 * 产物：`records/results/plotLocationMerge.json`（**global** 任务每书一次，key =
 * `<pkgId>:<revisionId>:plotLocationMerge`；路由见 `../upstream.ts` 默认分支
 * `resultsShardFile('plotLocationMerge')`；投影登记见 `workspace/reproject.ts` 的
 * `world/plot-location-merge.json`）。
 * 消费端：`t2w/view.ts:338-346`——`merge.locations[]` 与 `merge.idMap`（`idMap` 缺失时用
 * `locations[].sourceLocationIds` 反查兜底）；`view.ts:340` 注释写明 idMap 是「合并前 id →
 * 合并后 id」，用于把 `actions[].locationId`（合并前 `L-<chunk>-l<n>`）换到 reader
 * `:scene-images` 的 key（合并后 `PL-*`）。
 *
 * ---------------------------------------------------------------------------
 * 【为什么声明 `batching:{inputBudgetTokens:100000}`】
 * 合并是**全局视野**任务：同一实际地点常在不同 chunk 的 plotLocation 产物里各出现一次
 * （真实库 `5662f1d3` 的 `L-0-l3 王城国王寝室` 与 `L-2-l16` 即合并为 `PL-5`）。若按输入
 * 预算切批，各批只看到自己那部分地点，同一地点会在不同批各自成组 → 一次合并变成多次
 * 局部合并，idMap 也各自编号 `PL-1..`，跨批 `PL-*` 必然碰撞、view 的场景图映射全乱。
 * 真实生态该任务 maxTokens=120000 即单次调用；`execution` 字段亦写明「剧情地点及已选
 * 故事脚本完成后，按输入预算分批并行」——本架构选择**单批**（本书量级 plotLocations 全量
 * 在数万 token 内），覆盖方式见 `shared/pipeline-types.ts` 的 `LlmTaskAdapter.batching`。
 *
 * 【为什么 buildMessages 只发 2 条消息】
 * 模板 2 个变量（`mapLocations` / `plotLocations`）**全嵌指令**——正文【地图地点】/
 * 【剧情地点】两节直接插值，全文没有「见前面的 user 消息」这类外部素材指引。故
 * system（common_system_prompt）+ user（渲染后的任务指令）= 2 条（与
 * characterAppearance / mergeReview / locationTree 同构）。
 *
 * 【inputText】
 *  - `rt.readUpstream('plotLocation')` 的**全部条目**（跨 chunk）→ 逐条目双形态解包
 *    `value?.data ?? value` → `plotLocations` 全量收集（**保序：分片序 × 条目序**，即
 *    阅读序）；每条带其 `chunkIndex`（条目自身有 `chunkIndex` 字段则以其为准，否则用 key
 *    末段数字——前者是我们 plotLocation 适配器写入的程序字段，后者兼容老数据）；
 *  - `rt.readUpstream('locationTree')` → `showableMapLocations`（`../location-inputs`；与
 *    impressionLayout 同口径：只收可展示节点，剪枝按整支剪）→ JSON 字符串；
 *  - 两路任一空/缺 → **抛可读错误**（分别写明缺哪个），绝不静默产出空合并。
 *
 * 【parse：组校验（先到先得）→ 按输入序汇编 PL 编号 → idMap】
 *  1. `parseJsonLoose` → `groups` 必须是数组（缺 → `{locations:[], idMap:{}, warnings, raw}`
 *     兜底，不抛崩）；
 *  2. 逐组校验：
 *     - `ids` 字符串数组且**长度 ≥2**（模板「只列出至少两个地点的合并组」；不足 → 跳过 +
 *       warning）；组内重复 id 先去重（首现保留）；
 *     - 每个 id 必须 ∈ 快照 `byId`（未知 → 跳过该 id + warning；剩余不足 2 → 整组跳过）；
 *     - **同一 id 出现在多个组 → 后续组跳过该 id**（先到先得；剩余不足 2 → 整组跳过 +
 *       warning）——模板「每个 ID 最多出现一次」，程序侧以先出现者为准，保证 idMap 是函数；
 *     - `name` 非空字符串（缺 → 用组内首条 name + warning）；`sceneDescription` 字符串
 *       缺省 `''`；
 *  3. **汇编**（按快照 plotLocations **输入序**遍历）：遇某条目属于已登记组且该组尚未产出
 *     → 产出合并条目并分配 `PL-{n+1}`（n 为已产出数），组内其余条目 → idMap 指向该 PL；
 *     不属于任何组 → 独自产出 `PL-{n+1}`；
 *      合并条目：`{id: 'PL-*', name: 组 name, mapLocationId/identInfos/summary/chunkIndex:
 *      组内输入序首条, sceneDescription: 组 sceneDescription, sourceLocationIds: 组内全部
 *      id（输入序）, chunkIndexes: 成员 chunkIndex 去重升序}`（首条有 `ancId` 时一并带出）；
 *      独立条目：`{id: 'PL-*', 原字段原值, sourceLocationIds: [原 id], chunkIndexes: [原
 *      chunkIndex]}`；
 *  4. `idMap`：全部输入 id → 各自 PL id（含独立条目的新 id）；
 *  5. 输出 `{locations: [按 PL 序], idMap}`（**不写 `:grouped:*` / `:plan` 变体条目**——
 *     真实库并存这些中间产物，本引擎单实例架构只写主条目，见文件头末段）。
 *  parse 期 warning 进 `rt.warnings`（主条目形状对齐真实库，不塞 warnings 键；raw 兜底时
 *  另带 `warnings` + `raw` 供排查）。
 *
 * 【PL 编号规则与真实库 `5662f1d3` 的实测对拍结论（重要，读前必看）】
 *  - 规则：**输入序遇组首条才分配**，合并组占据其输入序首个成员的位置；独立地点按输入序
 *    依次递增。实测真实库 `plotLocationMerge.locations` 的 id 严格是 `PL-1..PL-50` 顺序
 *    递增（与 `sourceLocationIds` 覆盖的输入序一致），如 `PL-5 = [L-0-l3, L-2-l16]`
 *    （chunk 0 的 l3 出现在 chunk 2 的 l16 之前 → 取前者的位置），本适配器逐条复现该规则；
 *  - **次序差异（有意）**：真实库 `idMap` 的键序是 `L-0-l1, L-0-l10, L-0-l11, L-0-l2, …`
 *    （**按 id 字符串字典序**），故其 PL 编号也呈字典序（`PL-2 = L-0-l10`）。本适配器按
 *    `world/plot-locations.json` 的**数组序**（`L-0-l1, L-0-l2, …`，即 plotLocation 适配器
 *    的产出序）遍历，故同一本书会得到 `PL-2 = L-0-l2`。差异根源是**上游输入次序不同**
 *    （真实平台喂入前按 id 字符串排了序），**编号规则本身一致**；`idMap` 的键值对集合
 *    完全相同（51 条 → 50 个 PL，含 1 个双源组），只是键序不同——view 只用 `idMap[src]`
 *    取值，不受键序影响。
 *
 * 【有意差异汇总（与真实库主条目对比）】
 *  ① 不写 `:grouped:batch:0` / `:grouped:plan` 变体条目（单实例架构，理由同上）；
 *  ② 合并条目的 `mapLocationId` 在首条缺值时写 **null**（真实库 `PL-4` 即
 *     `mapLocationId:null, ancId:'M-9'`），而 plotLocation 产物本身是**省略**该字段
 *     （模板「没有则省略」）——合并阶段补 null 是为了让「有 ancId 无 mapLocationId」的
 *     情形在消费侧形状稳定；
 *  ③ 真实库 value 外包 `{data, responsePath, cacheReadyAt}`（persistence 信封，与适配器无关）。
 *
 * 合并策略：`concat-dedup-order` + 显式 `keyOf`（组按 `ids` **排序后** join('+')——组内顺序
 * 不影响语义，排序保证跨批同组键稳定、首现获胜；字符串元素给 `warn:` 前缀避免与组相消）。
 */
import type { ChatMessage, LlmTaskAdapter, TaskRuntime, UpstreamEntry } from '../../../shared/pipeline-types'
import { showableMapLocations } from '../location-inputs'
import { parseJsonLoose } from './cacheWarming'
import { readRtSnapshot, stashRtSnapshot } from '../rt-stash'

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

/** 条目 key 末段数字（`<pkgId>:<revisionId>:plotLocation:<n>`；解析不到 → null）。 */
function chunkIndexOfKey(key: string): number | null {
  const segs = String(key ?? '').split(':')
  const last = segs[segs.length - 1] ?? ''
  return /^\d+$/.test(last) ? Number(last) : null
}

/** 一条待合并的剧情地点（输入序 + 归属 chunk）。 */
interface MergePlotLocation {
  id: string
  chunkIndex: number
  data: Record<string, unknown>
}

/** buildMessages 挂载、parse 读取的快照（汇编与 id 校验的唯一依据）。 */
interface PlotLocationMergeSnapshot {
  /** 全量平铺（分片序 × 条目序 = 阅读序） */
  plotLocations: MergePlotLocation[]
  /** id → 条目 */
  byId: Map<string, MergePlotLocation>
}

/**
 * 读全量 plotLocations（跨 chunk，保序）+ byId 索引。
 * 无产物/未挂 readUpstream → 抛可读错误（plotLocations 是模板必填输入）。
 */
async function readAllPlotLocations(rt: TaskRuntime): Promise<{
  plotLocations: MergePlotLocation[]
  byId: Map<string, MergePlotLocation>
}> {
  if (typeof rt.readUpstream !== 'function') {
    throw new Error('plotLocationMerge 需要 plotLocation 产物：运行期未提供 readUpstream（rt 须由编排器 makeRuntime 构造）')
  }
  const entries: UpstreamEntry[] = await rt.readUpstream('plotLocation')
  const plotLocations: MergePlotLocation[] = []
  const byId = new Map<string, MergePlotLocation>()
  for (const e of entries) {
    const data = unwrapData(e.value)
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue
    const list = (data as Record<string, unknown>).plotLocations
    if (!Array.isArray(list)) continue
    const keyChunk = chunkIndexOfKey(e.key)
    for (const item of list) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const raw = item as Record<string, unknown>
      if (typeof raw.id !== 'string' || !raw.id) continue
      // chunkIndex：条目自身字段优先（plotLocation 适配器写入的程序字段），否则 key 末段
      const own = raw.chunkIndex
      const chunkIndex =
        typeof own === 'number' && Number.isFinite(own) ? own : (keyChunk ?? 0)
      // 同一 id 重复（多分片重跑等异常）→ 首现获胜（保序不重排）
      if (byId.has(raw.id)) continue
      const entry: MergePlotLocation = { id: raw.id, chunkIndex, data: { ...raw, chunkIndex } }
      plotLocations.push(entry)
      byId.set(raw.id, entry)
    }
  }
  if (!plotLocations.length) {
    throw new Error('plotLocationMerge 需要 plotLocation 产物：工作库中没有任何 plotLocation 结果，请先运行 plotLocation 任务')
  }
  return { plotLocations, byId }
}

/** 读可展示地图地点（`showableMapLocations`；空/缺 → 抛可读错误，模板 mapLocations 必填）。 */
async function readShowableLocations(rt: TaskRuntime): Promise<Record<string, unknown>[]> {
  if (typeof rt.readUpstream !== 'function') {
    throw new Error('plotLocationMerge 需要 locationTree 产物：运行期未提供 readUpstream（rt 须由编排器 makeRuntime 构造）')
  }
  const entries = await rt.readUpstream('locationTree')
  for (const e of entries) {
    const data = unwrapData(e.value)
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue
    const list = showableMapLocations(data)
    if (list.length) return list as unknown as Record<string, unknown>[]
  }
  throw new Error('plotLocationMerge 需要 locationTree 产物：工作库中没有任何 locationTree 结果，请先运行 locationTree 任务')
}

/**
 * 合并组的稳定键（供 `concat-dedup-order` 的 dedupeDeep 用）。
 *
 * 组按 `ids` **排序后** join('+')：组内顺序不影响语义（[A,B] ≡ [B,A]），排序保证同一组在
 * 不同批次 / 不同模型输出顺序下键一致，「重复组首现获胜」才成立（同 `mergeReviewKeyOf`）。
 * 字符串元素（warnings 形态）给 `warn:` 前缀避免与组相消。
 */
export function plotLocationMergeKeyOf(part: unknown): string {
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

export const plotLocationMergeAdapter: LlmTaskAdapter = {
  id: 'plotLocationMerge',
  mergeStrategy: 'concat-dedup-order',
  keyOf: plotLocationMergeKeyOf,
  // 合并需全局视野：切批会让同一地点在不同批各自分组、PL-* 跨批碰撞（理由见文件头）
  batching: { inputBudgetTokens: 100000 },

  async inputText(rt: TaskRuntime): Promise<string> {
    const { plotLocations } = await readAllPlotLocations(rt)
    // 地图侧仅校验存在性（其内容在 buildMessages 里嵌模板；inputText 的产出用于预算估算）
    await readShowableLocations(rt)
    return JSON.stringify(plotLocations.map((p) => p.data))
  },

  async buildMessages(_batchText: string, rt: TaskRuntime): Promise<ChatMessage[]> {
    // batchText 不拆用：输入是两段 JSON，切半即非法片段，且合并必须看全量（理由见文件头）
    const { plotLocations, byId } = await readAllPlotLocations(rt)
    const mapLocations = await readShowableLocations(rt)
    // parse 汇编的唯一依据。必须在 buildMessages stash（inputText 的 rt0 与 parse 的 rt
    // 不是同一实例，见 ../rt-stash 文件头）
    stashRtSnapshot(rt, { plotLocations, byId } satisfies PlotLocationMergeSnapshot)

    const system = await rt.render('common_system_prompt', {})
    const instruction = await rt.render('plot_location_merge_user_prompt', {
      // 预序列化 JSON 字符串（prompt-loader 对 JS 数组会换行拼接）
      mapLocations: JSON.stringify(mapLocations),
      plotLocations: JSON.stringify(plotLocations.map((p) => p.data))
    })
    // 两个变量全嵌指令（无外部素材消息）→ system + user(指令) = 2 条
    return [
      { role: 'system', content: system },
      { role: 'user', content: instruction }
    ]
  },

  parse(content: string, rt?: TaskRuntime): unknown {
    const warnings: string[] = []
    const warn = (msg: string): void => {
      warnings.push(msg)
      // 主条目形状对齐真实库（只有 locations/idMap），故 parse 期 warning 进 rt.warnings
      rt?.warnings.push(msg)
    }
    const snapshot = readRtSnapshot<PlotLocationMergeSnapshot>(rt)
    const obj = parseJsonLoose(content)
    const o = obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null

    // ---- 1. 协议校验：groups 必须是数组（缺 → raw 兜底，不抛崩）----
    if (!o || !Array.isArray(o.groups)) {
      warn('plotLocationMerge：模型输出无法解析为合并组协议（缺 groups 数组），走 raw 兜底')
      return { locations: [], idMap: {}, warnings, raw: (content ?? '').slice(0, 500) }
    }

    const byId = snapshot?.byId ?? null
    const plotLocations = snapshot?.plotLocations ?? []
    if (!byId || !plotLocations.length) {
      warn('plotLocationMerge：缺输入快照（buildMessages 未运行或 rt 不同实例），无法汇编合并结果')
      return { locations: [], idMap: {} }
    }
    // 输入序（id → 位置；首现获胜）
    const posOf = new Map<string, number>()
    plotLocations.forEach((p, i) => {
      if (!posOf.has(p.id)) posOf.set(p.id, i)
    })

    /** 校验通过的合并组。 */
    interface AcceptedGroup {
      /** 组内 id，已按**输入序**排好 */
      ids: string[]
      name: string
      sceneDescription: string
    }
    const groups: AcceptedGroup[] = []
    /** id → 组下标（先到先得；保证 idMap 是函数） */
    const claimed = new Map<string, number>()

    // ---- 2. 逐组校验 ----
    for (const item of o.groups) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        warn(`plotLocationMerge：跳过非对象的 groups 条目（${JSON.stringify(item)?.slice(0, 80) ?? 'null'}）`)
        continue
      }
      const g = item as Record<string, unknown>
      const rawIds = Array.isArray(g.ids) ? g.ids.filter((x): x is string => typeof x === 'string' && x.length > 0) : []
      // 组内重复 id 去重（首现保留）
      const uniq: string[] = []
      for (const id of rawIds) {
        if (!uniq.includes(id)) uniq.push(id)
      }
      if (uniq.length < 2) {
        warn(`plotLocationMerge：跳过 ids 不足 2 个的合并组（模板「只列出至少两个地点的合并组」：${JSON.stringify(g.ids ?? null)}）`)
        continue
      }
      // 逐 id 校验：未知 id / 已被前组登记 → 跳过该 id
      const kept: string[] = []
      for (const id of uniq) {
        if (!byId.has(id)) {
          warn(`plotLocationMerge：合并组内 id=${id} 不在剧情地点目录中，跳过该 id`)
          continue
        }
        if (claimed.has(id)) {
          warn(`plotLocationMerge：id=${id} 已在前一合并组登记（每组 id 最多出现一次），后续组跳过该 id`)
          continue
        }
        kept.push(id)
      }
      if (kept.length < 2) {
        warn(`plotLocationMerge：跳过 ids 不足 2 个的合并组（原始 [${uniq.join(',')}] 校验后仅剩 [${kept.join(',')}]）`)
        continue
      }
      // 按输入序排列（sourceLocationIds 的顺序契约）
      kept.sort((x, y) => (posOf.get(x) ?? 0) - (posOf.get(y) ?? 0))
      // name：非空字符串（缺 → 组内首条 name + warning）
      let name = typeof g.name === 'string' ? g.name.trim() : ''
      if (!name) {
        const first = byId.get(kept[0])?.data.name
        name = typeof first === 'string' ? first : ''
        warn(`plotLocationMerge：合并组 [${kept.join(',')}] 缺 name，用组内首条名称「${name}」`)
      }
      const groupIndex = groups.length
      for (const id of kept) claimed.set(id, groupIndex)
      groups.push({
        ids: kept,
        name,
        sceneDescription: typeof g.sceneDescription === 'string' ? g.sceneDescription : ''
      })
    }

    // ---- 3. 汇编（按输入序遍历；组在其首个成员位置产出 PL）----
    const locations: Record<string, unknown>[] = []
    const idMap: Record<string, string> = {}
    const emittedGroups = new Set<number>()
    let produced = 0
    for (const entry of plotLocations) {
      const groupIndex = claimed.get(entry.id)
      if (groupIndex !== undefined) {
        // 组已产出 → 该成员已在 idMap（跳过）
        if (emittedGroups.has(groupIndex)) continue
        emittedGroups.add(groupIndex)
        const group = groups[groupIndex]
        const members = group.ids
          .map((id) => byId.get(id))
          .filter((m): m is MergePlotLocation => !!m)
        if (!members.length) continue
        const first = members[0]
        produced++
        const plId = `PL-${produced}`
        const chunkIndexes = [...new Set(members.map((m) => m.chunkIndex))].sort((x, y) => x - y)
        locations.push({
          id: plId,
          name: group.name,
          mapLocationId: typeof first.data.mapLocationId === 'string' ? first.data.mapLocationId : null,
          ...(typeof first.data.ancId === 'string' && first.data.ancId ? { ancId: first.data.ancId } : {}),
          identInfos: stringArray(first.data.identInfos),
          summary: typeof first.data.summary === 'string' ? first.data.summary : '',
          sceneDescription: group.sceneDescription,
          chunkIndex: first.chunkIndex,
          sourceLocationIds: group.ids.slice(),
          chunkIndexes
        })
        for (const id of group.ids) idMap[id] = plId
        continue
      }
      // 独立条目：原字段原值 + 单源 id / 单 chunk
      produced++
      const plId = `PL-${produced}`
      const data = entry.data
      locations.push({
        id: plId,
        name: typeof data.name === 'string' ? data.name : '',
        mapLocationId: typeof data.mapLocationId === 'string' ? data.mapLocationId : null,
        ...(typeof data.ancId === 'string' && data.ancId ? { ancId: data.ancId } : {}),
        identInfos: stringArray(data.identInfos),
        summary: typeof data.summary === 'string' ? data.summary : '',
        sceneDescription: typeof data.sceneDescription === 'string' ? data.sceneDescription : '',
        chunkIndex: entry.chunkIndex,
        sourceLocationIds: [entry.id],
        chunkIndexes: [entry.chunkIndex]
      })
      idMap[entry.id] = plId
    }

    // ---- 4./5. 输出 {locations, idMap}（主条目形状对齐真实库）----
    return { locations, idMap }
  }
}

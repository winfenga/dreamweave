/**
 * `locationTree` 任务适配器（T6-C；模板 `location_tree_user_prompt`，输出协议 `location-numeric-v1`）。
 *
 * 产物：`records/results/locationTree.json`（条目 key = 实例键；global 任务每书一次）。
 * 输入：**全部 chunk 的 chunkLocationSummary 空间摘要**——经 `rt.readUpstream('chunkLocationSummary')`
 * （上游产物读取的唯一入口，见 `../upstream.ts`）取本工作库全部产物条目，逐条取
 * `value.chunkLocationSummary`，按 `【Chunk {i} · 空间摘要】\n{summary}` 编号拼接
 * （chunkIndex 从条目 key 末段数字解析，解析不到按出现序；缺字段条目跳过并记 rt.warnings；
 * 无任何产物 → 抛可读错误）。
 *
 * 输出（与真实工作库 `5662f1d3` 的 `:locationTree` 主条目对齐，逐字段对比见文末）：
 * ```jsonc
 * { "locations": [ { "id": "1", "name": "某住宅", "aliases": [], "locationType": "住宅",
 *     "identInfos": [], "showOnImpressionMap": false,
 *     "parentLocationId": null, "ancestorLocationId": null } ],
 *   "tree": { "id": "novel-world", "name": "小说世界", "locationType": "世界", "aliases": [],
 *     "identInfos": [], "parentLocationId": null, "ancestorLocationId": null, "children": [ … ] },
 *   "warnings": [ … ] }
 * ```
 * 消费端：`t2w/view.ts:318-319` 读 `lt.locations`（mapNodes 平铺）、`view.ts:459-460` 读
 * `lt.tree`（`buildTree` 递归 children；view.ts:445 注释「根节点通常不在 locations 里」，
 * 故合成根 `novel-world` **不进** locations）。
 *
 * 【已知限制（醒目）· 单轮全文模式】
 * 模板是**增量批协议**：latestMapLocations 为累积状态、每批只产 delta（`{upserts, merges}`）。
 * 而当前引擎是单实例 + L2 并行分批（各批互相不可见、都看到空状态），若真的按增量协议
 * 多轮推进，大批次书的各批会数字 ID 碰撞。故本适配器按 lead 裁定走**单轮全文模式**：
 * `latestMapLocations` 恒传 `[]`（JSON 空数组）、`batchIndex` 恒传 `0`，模型一次产全书
 * delta → L2 合并（keyOf 按纯数字 id / merge 按 keepId 去重，首现获胜）→ parse 收**合并后
 * 文本**组装最终态。已知限制：摘要总量 >8000 tokens 的超大书会被 L2 切批，各批看到空的
 * latestMapLocations → 数字 ID 碰撞 → dedupe 首现获胜、后来者被丢（当前书量级单批收敛，
 * depth=0、calls=1）；多轮增量待编排器支持跨批状态后启用，届时本文件 inputText/buildMessages
 * 的常量注入点（batchIndex/latestMapLocations）即为接线处。
 *
 * 【为什么 buildMessages 只发 2 条消息（与 cacheWarming/seg 等的 3 条不同）】
 * `location_tree_user_prompt` 的【当前批次】区把输入**嵌在指令里**
 * （`chunkLocationSummaries：{{{chunkLocationSummaries}}}` 在该模板内），因此批文本直接
 * 经 `{{chunkLocationSummaries}}` 渲染进 user 指令即可；若再补一条 user 原文消息，同一批
 * 输入会出现两次。故：system（common_system_prompt）+ user（渲染后的任务指令）= 2 条
 * （与 worldImpression 同构）。
 *
 * parse 组装顺序（不可乱，详见各步注释）：
 *  1. parseJsonLoose → 校验 `upserts` 是数组（缺 → raw 兜底不抛崩）；`merges` 缺省 `[]`；
 *  2. 逐条校验 upsert（无效条目跳过 + warning，不抛崩）：id 非空**纯数字字符串**
 *     （模板契约：无字母/前缀/小数/符号/前导零）；name 非空字符串；aliases/identInfos
 *     缺省 `[]`（元素须字符串）；locationType 缺省 `''`；showOnImpressionMap 缺省 `false`；
 *     parentLocationId/ancestorLocationId 为字符串或 null（缺省 null）；
 *  3. 应用 merges：keepId 必须存在于 upserts（不在 → 跳过该 merge + warning）；构建
 *     removeId → keepId 直映射并求**传递闭包**（a→b, b→c 解析成 a→c，带环保护，环链整体
 *     不应用）；删掉 id ∈ removeIds 的 upsert（keepId 自身除外）；把所有 upsert 的
 *     parentLocationId/ancestorLocationId 过重映射（映射到不存在的 → null + warning）；
 *  4. 平铺 locations：8 字段严格集（见 LocationRecord），按 id 去重（首现获胜，防御性）；
 *  5. 组装 tree：children 按 parentLocationId；根 = parentLocationId 为 null **或指向不存在
 *     的 id**（悬空 → warning 并按根处理）；**环检测**（沿祖先链走，遇环 → 在环入口截断挂根
 *     + warning）；包一层合成根 `novel-world`（不进 locations），子节点递归同构（含 children）；
 *  6. warnings = 模型 warnings（数组则收，非数组忽略）+ 全部组装期 warning；
 *  7. upserts 为空 → `{locations: [], tree: 合成根(children:[]), warnings:[…'模型未产出任何地点']}`；
 *  8. 返回 `{locations, tree, warnings}`。
 *
 * 【与真实库 `5662f1d3` 的 `:locationTree` 主条目逐字段对比结论】
 * 对齐：顶层 `locations` + `tree` + `warnings`（真实库还有 `attachments`，全仓无消费者
 *  ——`view.ts` 只读 locations/tree —— 故不生成）；树根 `novel-world / 小说世界 / 世界`，
 *  根不在 locations 里；树子节点字段集（id/name/aliases/locationType/identInfos/
 *  parentLocationId/ancestorLocationId/showOnImpressionMap/children）。
 * 有意差异：① locations 元素**不含 `indexes`**（真实库恒为 `[]`，模板 location-numeric-v1
 *  无此字段且 view 不消费）；② 树节点**不含 `effectiveParentId` / `attachmentBasis`**
 *  （真实库的挂接机制字段，属 attachments 机制，本适配器不生成挂接记录）；③ 真实库 id 为
 *  `M-1` 式（旧协议），本适配器按模板 `location-numeric-v1` 契约为**纯数字字符串**
 *  （"1"/"2"，无字母/前缀/前导零）——view 消费端对 id 只做字符串key 使用，不限定格式；
 *  ④ 真实库同 key 下还有 `:batch:N` 增量条目（`{delta, warnings}`），本引擎 global 单实例
 *  只写主条目一次（单轮全文模式，见上）。
 */
import type { ChatMessage, LlmTaskAdapter, TaskRuntime, UpstreamEntry } from '../../../shared/pipeline-types'
import { parseJsonLoose } from './cacheWarming'

/**
 * 供 dedupeDeep 用的稳定键（T6-C）：upsert 按纯数字 id 去重、merge 按 keepId 去重，
 * 其余（脏条目）JSON 串兜底。数字 ID 碰撞时 dedupe **首现获胜**（见文件头已知限制）。
 */
export function locationTreeKeyOf(part: unknown): string {
  if (part && typeof part === 'object' && !Array.isArray(part)) {
    const o = part as Record<string, unknown>
    if (typeof o.id === 'string' && o.id) return o.id
    if (typeof o.keepId === 'string' && o.keepId) return `merge:${o.keepId}`
  }
  try {
    return JSON.stringify(part)
  } catch {
    return String(part)
  }
}

/** chunkLocationSummary 产物条目 → chunkIndex（key 形如 `<pkgId>:<revisionId>:chunkLocationSummary:0`，末段为 chunk 序号）。 */
function chunkIndexOfKey(key: string): number | null {
  const segs = key.split(':')
  const last = segs[segs.length - 1] ?? ''
  return /^\d+$/.test(last) ? Number(last) : null
}

/** 非空字符串判定（模板契约：摘要正文必须有非空内容）。 */
function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/** 模板 id 契约：非负整数字符串，无字母/前缀/小数/符号/前导零（"0" 合法，"01" 非法）。 */
function isPureNumericId(v: unknown): v is string {
  return typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v)
}

/** 字符串数组成员过滤（非字符串元素剔除；非数组 → 缺省 `[]`）。 */
function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** 字符串或 null（非字符串 → null；空串视作未填 → null）。 */
function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** 地点记录（平铺 locations 的元素；字段集严格等于这 8 个，顺序即契约）。 */
interface LocationRecord {
  id: string
  name: string
  aliases: string[]
  locationType: string
  identInfos: string[]
  showOnImpressionMap: boolean
  parentLocationId: string | null
  ancestorLocationId: string | null
}

/**
 * 树节点 = 地点记录 + children（view.ts `buildTree` 递归 children 的形状）。
 * `showOnImpressionMap` 可选：真实库合成根无该字段（view 对根走 `?? true` 兜底），
 * 本适配器如实对齐——子节点必有、合成根不设。
 */
interface LocationTreeNode {
  id: string
  name: string
  aliases: string[]
  locationType: string
  identInfos: string[]
  showOnImpressionMap?: boolean
  parentLocationId: string | null
  ancestorLocationId: string | null
  children: LocationTreeNode[]
}

/** 合成根（对齐真实数据 `novel-world`；view.ts:445 注释「根节点通常不在 locations 里」→ 不进 locations）。 */
function syntheticRoot(children: LocationTreeNode[]): LocationTreeNode {
  return {
    id: 'novel-world',
    name: '小说世界',
    locationType: '世界',
    aliases: [],
    identInfos: [],
    parentLocationId: null,
    ancestorLocationId: null,
    children
  }
}

export const locationTreeAdapter: LlmTaskAdapter = {
  id: 'locationTree',
  mergeStrategy: 'concat-dedup-order',
  keyOf: locationTreeKeyOf,

  async inputText(rt: TaskRuntime): Promise<string> {
    if (typeof rt.readUpstream !== 'function') {
      throw new Error('locationTree 需要 chunkLocationSummary 产物：运行期未提供 readUpstream（rt 须由编排器 makeRuntime 构造）')
    }
    const entries: UpstreamEntry[] = await rt.readUpstream('chunkLocationSummary')
    if (!entries.length) {
      throw new Error('locationTree 需要 chunkLocationSummary 产物：工作库中没有任何 chunkLocationSummary 结果，请先运行 chunkLocationSummary 任务')
    }
    const blocks: string[] = []
    let occurrence = 0
    for (const e of entries) {
      const v = e.value as { chunkLocationSummary?: unknown } | null
      const summary = v && typeof v === 'object' ? (v as Record<string, unknown>).chunkLocationSummary : undefined
      if (!nonEmptyString(summary)) {
        // 缺 chunkLocationSummary 的条目跳过并留痕（如 raw 兜底产物），不阻断全书聚合
        rt.warnings.push(`locationTree：跳过无 chunkLocationSummary 的上游条目（key=${e.key}）`)
        continue
      }
      // key 末段数字为 chunkIndex（形如 `…:chunkLocationSummary:0`）；解析不到 → 按出现序编号
      const idx = chunkIndexOfKey(e.key) ?? occurrence
      blocks.push(`【Chunk ${idx} · 空间摘要】\n${summary}`)
      occurrence++
    }
    if (!blocks.length) {
      throw new Error('locationTree 需要 chunkLocationSummary 产物：全部 chunkLocationSummary 条目均无摘要正文，请先运行 chunkLocationSummary 任务')
    }
    return blocks.join('\n')
  },

  async buildMessages(batchText: string, rt: TaskRuntime): Promise<ChatMessage[]> {
    const system = await rt.render('common_system_prompt', {})
    // 单轮全文模式：latestMapLocations 恒传 JSON 空数组、batchIndex 恒传 0（理由见文件头已知限制）
    const instruction = await rt.render('location_tree_user_prompt', {
      batchIndex: 0,
      latestMapLocations: '[]',
      chunkLocationSummaries: batchText
    })
    // 输入嵌在模板【当前批次】区（{{chunkLocationSummaries}}），故只 2 条消息（理由见文件头）
    return [
      { role: 'system', content: system },
      { role: 'user', content: instruction }
    ]
  },

  parse(content: string): unknown {
    const warnings: string[] = []
    const obj = parseJsonLoose(content)
    const o = obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null

    // ---- 1. 协议校验：upserts 必须是数组（缺 → raw 兜底，不抛崩）----
    if (!o || !Array.isArray(o.upserts)) {
      warnings.push('locationTree：模型输出无法解析为 location-numeric-v1 协议（缺 upserts 数组），走 raw 兜底')
      return {
        locations: [],
        tree: syntheticRoot([]),
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

    // ---- 2. 逐条校验 upsert（无效条目跳过 + warning，不抛崩）----
    const valid: LocationRecord[] = []
    for (const item of o.upserts) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        warnings.push(`locationTree：跳过非对象的 upsert 条目（${JSON.stringify(item)?.slice(0, 80) ?? 'null'}）`)
        continue
      }
      const u = item as Record<string, unknown>
      if (!isPureNumericId(u.id)) {
        warnings.push(`locationTree：跳过 id 非纯数字字符串的 upsert（id=${JSON.stringify(u.id) ?? 'undefined'}）`)
        continue
      }
      if (!nonEmptyString(u.name)) {
        warnings.push(`locationTree：跳过缺 name 的 upsert（id=${u.id}）`)
        continue
      }
      valid.push({
        id: u.id,
        name: u.name,
        aliases: stringArray(u.aliases),
        locationType: typeof u.locationType === 'string' ? u.locationType : '',
        identInfos: stringArray(u.identInfos),
        showOnImpressionMap: u.showOnImpressionMap === true,
        parentLocationId: stringOrNull(u.parentLocationId),
        ancestorLocationId: stringOrNull(u.ancestorLocationId)
      })
    }

    // ---- 7. upserts 为空 → 空树 + warning（不抛崩）----
    if (!valid.length) {
      warnings.push('模型未产出任何地点')
      return { locations: [], tree: syntheticRoot([]), warnings }
    }

    // ---- 3. 应用 merges ----
    const validIds = new Set(valid.map((r) => r.id))
    const keepIds = new Set<string>()
    const removeIdsAll = new Set<string>()
    /** applied merge 的直映射 removeId → keepId（同 removeId 多 merge 争夺时首现获胜） */
    const direct = new Map<string, string>()
    const rawMerges = Array.isArray(o.merges) ? o.merges : []
    for (const m of rawMerges) {
      if (!m || typeof m !== 'object' || Array.isArray(m)) {
        warnings.push(`locationTree：跳过非对象的 merge 条目（${JSON.stringify(m)?.slice(0, 80) ?? 'null'}）`)
        continue
      }
      const mm = m as Record<string, unknown>
      const keepId = mm.keepId
      if (typeof keepId !== 'string' || !keepId) {
        warnings.push('locationTree：跳过缺 keepId 的 merge 条目')
        continue
      }
      if (!validIds.has(keepId)) {
        warnings.push(`locationTree：merge 的 keepId=${keepId} 不存在于 upserts，跳过该 merge`)
        continue
      }
      if (mm.removeIds !== undefined && !Array.isArray(mm.removeIds)) {
        warnings.push(`locationTree：merge（keepId=${keepId}）的 removeIds 不是数组，跳过该 merge`)
        continue
      }
      const removeIds = stringArray(mm.removeIds)
      if (!removeIds.length) continue // 空 removeIds = 合法空操作，不警告
      keepIds.add(keepId)
      for (const rid of removeIds) {
        removeIdsAll.add(rid)
        if (rid === keepId) {
          // 模板契约：removeIds 不得包含 keepId；防御性忽略
          warnings.push(`locationTree：merge（keepId=${keepId}）的 removeIds 含 keepId 自身，忽略该 removeId`)
          continue
        }
        if (direct.has(rid)) {
          if (direct.get(rid) !== keepId) {
            warnings.push(`locationTree：removeId=${rid} 被多个 merge 争夺（${direct.get(rid)} / ${keepId}），保留首现`)
          }
          continue
        }
        direct.set(rid, keepId)
      }
    }

    // ---- 传递闭包：a→b, b→c 解析成 a→c；环链整体不应用 ----
    const remap = new Map<string, string>()
    for (const start of direct.keys()) {
      const seen = new Set<string>([start])
      let cur: string | undefined = direct.get(start)
      let cyclic = false
      while (cur !== undefined && direct.has(cur)) {
        if (seen.has(cur)) {
          cyclic = true
          break
        }
        seen.add(cur)
        cur = direct.get(cur)
      }
      if (cyclic) {
        warnings.push(`locationTree：merge 链存在环（起点 removeId=${start}），该链整体不应用`)
        continue
      }
      if (cur === undefined || cur === start) continue // 防御：直映射缺失或自指
      remap.set(start, cur)
    }

    // ---- 删除被合并的 upsert（keepId 自身除外）----
    const deleteSet = new Set<string>([...removeIdsAll].filter((id) => !keepIds.has(id)))
    const survivors = valid.filter((r) => !deleteSet.has(r.id))
    const survivorIds = new Set(survivors.map((r) => r.id))

    // ---- 引用重映射：parentLocationId / ancestorLocationId（映射到不存在的 → null + warning）----
    const remapRef = (ref: string | null, ownerId: string, field: 'parentLocationId' | 'ancestorLocationId'): string | null => {
      if (ref === null) return null
      const mapped = remap.get(ref)
      if (mapped === undefined) return ref // 未参与 merge 的引用原样保留（悬空由树组装步骤处理）
      if (!survivorIds.has(mapped)) {
        warnings.push(`locationTree：${ownerId} 的 ${field} 经 merge 重映射到 ${mapped}，但该 id 不存在，置 null`)
        return null
      }
      return mapped
    }
    for (const r of survivors) {
      r.parentLocationId = remapRef(r.parentLocationId, r.id, 'parentLocationId')
      r.ancestorLocationId = remapRef(r.ancestorLocationId, r.id, 'ancestorLocationId')
    }

    // ---- 4. 平铺 locations（8 字段严格集；按 id 去重，首现获胜，防御性）----
    const locations: LocationRecord[] = []
    const seenLoc = new Set<string>()
    for (const r of survivors) {
      if (seenLoc.has(r.id)) continue
      seenLoc.add(r.id)
      locations.push({
        id: r.id,
        name: r.name,
        aliases: r.aliases,
        locationType: r.locationType,
        identInfos: r.identInfos,
        showOnImpressionMap: r.showOnImpressionMap,
        parentLocationId: r.parentLocationId,
        ancestorLocationId: r.ancestorLocationId
      })
    }

    // ---- 5. 组装 tree ----
    const idSet = new Set(locations.map((l) => l.id))
    const byId = new Map(locations.map((l) => [l.id, l]))
    // 环检测：沿祖先链走，遇环 → 在环入口截断挂根（功能图中每连通分量至多一个环，
    // 在首个重复节点处截断即可完全破除；后续 walk 到达已截断入口即止）。
    const cycleEntry = new Set<string>()
    for (const l of locations) {
      const seen = new Set<string>()
      let cur: string | null = l.id
      while (cur !== null) {
        if (cycleEntry.has(cur)) break
        if (seen.has(cur)) {
          cycleEntry.add(cur)
          break
        }
        seen.add(cur)
        const p: string | null = byId.get(cur)?.parentLocationId ?? null
        cur = p !== null && idSet.has(p) ? p : null
      }
    }
    for (const entry of cycleEntry) {
      warnings.push(`locationTree：检测到地点层级环（入口 id=${entry}），已截断并挂到合成根下`)
    }
    const childrenOf = new Map<string, LocationRecord[]>()
    const roots: LocationRecord[] = []
    for (const l of locations) {
      const p = l.parentLocationId
      if (p !== null && !idSet.has(p)) {
        // 悬空父：指向不存在的 id → 按根处理并留痕
        warnings.push(`locationTree：${l.id}（${l.name}）的 parentLocationId=${p} 指向不存在的地点，按根节点处理`)
      }
      if (p === null || !idSet.has(p) || cycleEntry.has(l.id)) {
        roots.push(l)
      } else {
        const arr = childrenOf.get(p) ?? []
        arr.push(l)
        childrenOf.set(p, arr)
      }
    }
    const buildNode = (rec: LocationRecord): LocationTreeNode => ({
      id: rec.id,
      name: rec.name,
      aliases: rec.aliases,
      locationType: rec.locationType,
      identInfos: rec.identInfos,
      showOnImpressionMap: rec.showOnImpressionMap,
      parentLocationId: rec.parentLocationId,
      ancestorLocationId: rec.ancestorLocationId,
      children: (childrenOf.get(rec.id) ?? []).map(buildNode)
    })

    // ---- 6/8. 返回最终态 ----
    return { locations, tree: syntheticRoot(roots.map(buildNode)), warnings }
  }
}

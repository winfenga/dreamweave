/**
 * 把包内 records 整理成「地图互动 / 视觉互动」两个视图直接可用的渲染模型。
 *
 * 只读 manifest，不做任何格式层操作；不发起任何 LLM 请求。
 *
 * 数据来源与关键坑（已用 7 个样本包实证）：
 *   1) `:storyScript:<chunkIndex>` 是**按 chunk** 产出的 —— 多 chunk 包有 N 条
 *      （如 chunkCount=11 的包有 storyScript:0..10），必须**全部合并**，
 *      只取第一条会把演出缩到 1/N（实测 745 → 8015 条）。
 *      另有 `:storyScript:<n>:batch:<支> ` 变体，属同一 chunk 的分批，需排除避免重复计数。
 *   2) `records.reader[:scene-images].individual` 的 key 用的是 **合并后**的场景 id
 *      （`plotLocationMerge.idMap` 的**值**，形如 `PL-73`），而 `actions[].locationId`
 *      与 `storyScript.plotLocations[].id` 用的是**合并前**的 `L-<chunk>-l<n>`。
 *      两者**没有交集**，必须用 idMap 转换后再取图（单 chunk 且无 merge 的包才会恰好相等）。
 *   3) `records.results` 条目值分两种形态：带 `.data` 层与否，见 unwrap()。
 *   4) 立绘全量形象有两个来源，需按 (charId, appearanceId) 合并：
 *      `reader:character-images`（charId → [{appearanceId, imagePath}]，给图）
 *      与 `results::characterAppearance`（给 name/sex/summary/keywords，且存在
 *      `…:characterAppearance:<charId>` 单角色键与 `:batch:` 变体并存）。
 *   5) 配音在 `reader::dubbing:clip:<chapterSeq>:<order>`，`path` 是包内 mp3 成员，
 *      与 `:dubbing:attempt:<uuid>`（中间产物）和 `:dubbing:voice:<charId>`（音色档案）并存。
 *      canonical.objects.characters 带 importanceLevel/aliases（实测含 CORE/HIGH/MEDIUM/LOW/TEMP）。
 */
import type {
  ChapterSpan,
  CharacterPortrait,
  CharacterVisual,
  DubbingClip,
  DubbingVoice,
  ImpressionData,
  ImpressionLayoutGroup,
  MapLocation,
  MapTreeNode,
  ResultSource,
  SceneInfo,
  StageAction,
  ViewData
} from '../../shared/app-types'
import type { EffectMount, EffectRange } from '../../shared/effects-types'
import type { T2wManifest } from '../../shared/t2w-types'
import { isVariant, pickMainEntry, selectAllStoryScript, selectStoryScriptChunks } from '../workspace/variant'

interface Keyed<T = unknown> {
  key: string
  value: T
}
interface ActionResultData {
  protocol?: string
  actions?: StageAction[]
  plotLocations?: PlotLocationRaw[]
  /** P4：范围特效（记录级兄弟字段，与 actions 同级） */
  effectRanges?: EffectRange[]
}
interface PlotLocationRaw {
  id: string
  name?: string
  mapLocationId?: string | null
  /** 地图节点兜底：实测有 mapLocationId 为 null 但 ancId 有值的条目 */
  ancId?: string | null
  identInfos?: string[]
  summary?: string
  sceneDescription?: string
  chunkIndex?: number
  /** 仅 plotLocationMerge.locations 上有 */
  sourceLocationIds?: string[]
}
interface MergeData {
  locations?: PlotLocationRaw[]
  /** 合并前 id → 合并后 id */
  idMap?: Record<string, string>
}
interface ImpressionRaw {
  layout?: {
    gridSize?: number
    layouts?: { parentId?: string; mode?: string; placements?: { id?: string; rect?: Record<string, number> }[] }[]
  }
}
interface LocationRaw {
  id: string
  name?: string
  locationType?: string
  identInfos?: string[]
  parentLocationId?: string | null
  showOnImpressionMap?: boolean
  children?: LocationRaw[]
}
interface SceneImageEntry {
  /** character-images 条目上的形象 id（scene-images 条目没有该字段） */
  id?: string
  appearanceId?: string
  imagePath?: string
}
/** reader `:dubbing:clip:<chapterSeq>:<order>` */
interface DubbingClipRaw {
  v?: number
  actionType?: string
  chapterSeq?: number
  order?: number
  characterId?: string
  fingerprint?: string
  path?: string
  voiceChecksum?: string
}
/** reader `:dubbing:voice:<characterId>` */
interface DubbingVoiceRaw {
  characterId?: string
  /** 音色描述 */
  vi?: string
  path?: string
  checksum?: string
}
/** results `:characterAppearance[:<characterId>]` 的一个形象 */
interface AppearanceRaw {
  appearanceId?: string
  name?: string
  sex?: string
  appearanceSummary?: string
  visualKeywords?: string[]
  chunkIndexes?: number[]
  inferred?: boolean
}
interface CanonicalCharacterRaw {
  id?: string
  name?: string
  importanceLevel?: string
  aliases?: string[]
  characterAppearances?: AppearanceRaw[]
}

function toList<T>(node: unknown): Keyed<T>[] {
  if (Array.isArray(node)) return node as Keyed<T>[]
  if (node && typeof node === 'object') {
    return Object.entries(node as Record<string, T>).map(([key, value]) => ({ key, value }))
  }
  return []
}

/**
 * records.results 的条目值分两种形态（实测）：
 *   - 带 `.data` 层：{ data, responsePath, cacheReadyAt } —— plot/storyScript/plotLocation/settingSummary/
 *     characterRelation/draftCharacter/draftOther/worldImpression/locationTree/impressionLayout/mergeReview/event:finalize
 *   - 不带 `.data` 层：canonical（={objects,mapping}）、draftAlign:*、characterAppearance
 * 用「data 值非空才下钻」同时兜住两种；注意不能用 `'data' in value`，
 * 否则某条恰好存在 data:undefined 时会被解成 undefined。
 */
function unwrap<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') {
    const d = (value as Record<string, unknown>).data
    if (d !== undefined && d !== null) return d as T
  }
  return value as T
}

/**
 * 取某任务的「主记录」。
 * ⚠️ 变体（`:batch:<n>` / `:grouped:*` / `:plan` / `:repair`）会与主记录**并存**
 * （实测 `locationTree` 有 2 条、`plotLocationMerge` 有 3 条、`characterAppearance` 有 41 条），
 * 且它们是中间产物。这里显式排除，避免「恰好主记录排在最前」的运气依赖。
 */
function pickResult<T>(results: Keyed[], needle: string): T | null {
  // 「主条目」选取规则统一走 variant.ts（单一事实源，§9）
  const hit = pickMainEntry(results, needle)
  return unwrap<T>(hit?.value)
}

/**
 * 判定某条产物的**来源**（T7-A）。
 *
 * ⚠️ 只在**下钻 `.data` 之前**生效：本机标记 `source:'runtime'` 打在条目 value 的**顶层**
 * （`persistence.writeResult`），`unwrap()` 会把它换成 `value.data`，那时 `source` 就看不到了
 * （且 `data` 内部若有同名键会误判）。所以调用方必须先把整条 entry 的 value 交给本函数。
 *
 * 取值：`source === 'runtime'` → 本机运行产物；否则（含脏值/无标记）= 来源包自带。
 * 「根本没有该产物」不在本函数判定范围内（由调用方按 entry 是否存在给 `unknown`）。
 */
function sourceOfEntry(value: unknown): 'runtime' | 'inherited' {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if ((value as Record<string, unknown>).source === 'runtime') return 'runtime'
  }
  return 'inherited'
}

/** 某 needle 的产物来源三态（entry 不存在 → `unknown`）。 */
function pickResultSource(results: Keyed[], needle: string): ResultSource {
  const hit = pickMainEntry(results, needle)
  if (!hit) return 'unknown'
  return sourceOfEntry(hit.value)
}

/** 取所有 chunk 级 `:storyScript:<n>`（排除 `:batch:<b>` 变体），按 chunk 序号升序（规则统一走 variant.ts）。 */
function pickStoryScriptChunks(results: Keyed[]): ActionResultData[] {
  const list = selectStoryScriptChunks(results)
    .map((r) => unwrap<ActionResultData>(r.value))
    .filter((d): d is ActionResultData => !!d)
  if (list.length) return list
  // 兜底：若只有 batch 级产物，则退回第一条（至少能显示一部分）
  return selectAllStoryScript(results)
    .map((r) => unwrap<ActionResultData>(r.value))
    .filter((d): d is ActionResultData => !!d)
    .slice(0, 1)
}

function pickReader<T>(reader: Keyed[], needle: string): T | null {
  const hit = reader.find((r) => typeof r.key === 'string' && r.key.includes(needle))
  return unwrap<T>(hit?.value)
}

/**
 * 汇总所有 `:characterAppearance` 记录的形象元数据。
 *
 * 实测两种键形态并存（MMT 包 27 角色）：
 *   - `…:characterAppearance`           —— 值为 { charId: AppearanceRaw[] } 全量映射
 *   - `…:characterAppearance:D-0-C-1`   —— 值为 AppearanceRaw[]，只属该角色
 * 另有 `:batch:0` / `:plan` 变体需排除。
 * 合并粒度是 (charId, appearanceId)，先到先得，保证确定性。
 */
function collectAppearances(results: Keyed[]): Map<string, Map<string, AppearanceRaw>> {
  const out = new Map<string, Map<string, AppearanceRaw>>()
  const put = (charId: string, ap: AppearanceRaw): void => {
    if (!charId || !ap?.appearanceId) return
    let m = out.get(charId)
    if (!m) {
      m = new Map()
      out.set(charId, m)
    }
    if (!m.has(ap.appearanceId)) m.set(ap.appearanceId, ap)
  }
  for (const r of results) {
    if (typeof r.key !== 'string' || !r.key.includes(':characterAppearance') || isVariant(r.key)) continue
    const val = unwrap<unknown>(r.value)
    if (!val || typeof val !== 'object') continue
    if (Array.isArray(val)) {
      // 单角色形态：角色 id 取键后缀
      const i = r.key.indexOf(':characterAppearance')
      const charId = r.key.slice(i + ':characterAppearance'.length).replace(/^:/, '')
      for (const ap of val as AppearanceRaw[]) put(charId, ap)
      continue
    }
    for (const [charId, arr] of Object.entries(val as Record<string, AppearanceRaw[]>)) {
      if (!Array.isArray(arr)) continue
      for (const ap of arr) put(charId, ap)
    }
  }
  return out
}

/** 单句特效三元键（chapterSeq+order+type，不读 text） */
function effectsKey(a: { chapterSeq?: number; order?: number; type?: string }): string {
  return `${a.chapterSeq}|${a.order}|${a.type}`
}

/**
 * 收集所有 storyScript 副本的 `actions[].effects`（按三元键取首个非空）。
 * 写回会把同一份 effects 写进所有副本（含 `:batch:`），故此处**不过滤 batch**；
 * 副本间应逐字相等，取首个非空即可（后续若更长则采纳更长者以保守保留）。
 */
function collectActionEffects(results: Keyed[]): Map<string, EffectMount[]> {
  const out = new Map<string, EffectMount[]>()
  for (const r of results) {
    if (typeof r.key !== 'string' || !r.key.includes(':storyScript')) continue
    const d = unwrap<ActionResultData>(r.value)
    const actions = d?.actions
    if (!Array.isArray(actions)) continue
    for (const a of actions) {
      const fx = a?.effects
      if (!Array.isArray(fx) || fx.length === 0) continue
      const k = effectsKey(a)
      const prev = out.get(k)
      if (!prev || fx.length > prev.length) out.set(k, fx)
    }
  }
  return out
}

/** 范围特效身份键（用于跨副本去重） */
function rangeIdentity(r: EffectRange): string {
  return [r.scope, r.chapterSeq, r.sceneId ?? '', r.orderStart ?? '', r.orderEnd ?? '', r.effectId].join('|')
}

/** 收集所有 storyScript 副本的 `data.effectRanges`，按身份去重（多副本会重复） */
function collectEffectRanges(results: Keyed[]): EffectRange[] {
  const seen = new Set<string>()
  const out: EffectRange[] = []
  for (const r of results) {
    if (typeof r.key !== 'string' || !r.key.includes(':storyScript')) continue
    const d = unwrap<ActionResultData>(r.value)
    const ranges = d?.effectRanges
    if (!Array.isArray(ranges)) continue
    for (const rg of ranges) {
      if (!rg || typeof rg !== 'object' || typeof rg.effectId !== 'string') continue
      const k = rangeIdentity(rg)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(rg)
    }
  }
  return out
}

/**
 * 由**注入的 manifest** 构建 view 渲染模型（数据来源切换为工作库装配结果，设计 §2.2/§D10）。
 * 解析算法与今日**逐字不变**，仅数据来源从「会话内的整包 manifest」改为「调用方注入的 manifest」。
 */
export function buildViewData(manifest: T2wManifest, assetBase: string): ViewData {
  const records = (manifest.records ?? {}) as Record<string, unknown>
  const results = toList<unknown>(records.results)
  const reader = toList<unknown>(records.reader)

  const url = (entryPath: string | null | undefined): string | null =>
    entryPath ? assetBase + entryPath : null

  // ---- 剧本：合并全部 chunk 级 storyScript ----
  const ssChunks = pickStoryScriptChunks(results)
  const protocol = ssChunks.find((d) => d.protocol)?.protocol ?? ''

  // P4：单句特效（跨全部副本按三元键取首个非空）+ 范围特效（跨副本去重）
  const effectsMap = collectActionEffects(results)
  const effectRanges = collectEffectRanges(results)

  const actionKey = (a: StageAction): string =>
    `${a.chapterSeq}|${a.order}|${a.type}|${a.characterId}|${a.locationId}|${a.text.length}`
  const seenAction = new Set<string>()
  const actions: StageAction[] = []
  const plById = new Map<string, PlotLocationRaw>()
  for (const d of ssChunks) {
    for (const a of d.actions ?? []) {
      const k = actionKey(a)
      if (seenAction.has(k)) continue
      seenAction.add(k)
      const fx = effectsMap.get(effectsKey(a))
      if (fx && fx.length) a.effects = fx
      actions.push(a)
    }
    for (const p of d.plotLocations ?? []) {
      if (p?.id && !plById.has(p.id)) plById.set(p.id, p)
    }
  }
  actions.sort((a, b) => (a.chapterSeq !== b.chapterSeq ? a.chapterSeq - b.chapterSeq : a.order - b.order))
  const plotLocations = [...plById.values()]

  // ---- 地图 ----
  // T7-A：来源取自主条目 value 顶层（**在 unwrap 下钻 data 之前**），三态见 ResultSource
  const locationTreeSource = pickResultSource(results, ':locationTree')
  const lt = pickResult<{ locations?: LocationRaw[]; tree?: LocationRaw }>(results, ':locationTree') ?? {}
  const rawLocations: LocationRaw[] = lt.locations ?? []
  const mapNodes: MapLocation[] = rawLocations.map((l) => ({
    id: l.id,
    name: l.name ?? l.id,
    locationType: l.locationType ?? '未知',
    identInfos: l.identInfos ?? [],
    parentLocationId: l.parentLocationId ?? null,
    showOnImpressionMap: l.showOnImpressionMap !== false
  }))
  const nodeById = new Map(mapNodes.map((n) => [n.id, n]))

  // ---- 场景图：reader 的 key 是「合并后 id」，需要用 plotLocationMerge.idMap 转换 ----
  const sceneImages =
    pickReader<{ shared?: Record<string, SceneImageEntry[]>; individual?: Record<string, string> }>(
      reader,
      ':scene-images'
    ) ?? {}
  const sceneImageMap: Record<string, string> = sceneImages.individual ?? {}

  const merge = pickResult<MergeData>(results, ':plotLocationMerge') ?? {}
  /** 合并前 id → 合并后 id */
  const idMap: Record<string, string> = { ...(merge.idMap ?? {}) }
  // idMap 缺失时用 merge.locations[].sourceLocationIds 反查兜底
  for (const l of merge.locations ?? []) {
    for (const src of l.sourceLocationIds ?? []) {
      if (src && l.id && !idMap[src]) idMap[src] = l.id
    }
  }

  /** 场景 id → 图片 entryPath：先直配，再用 idMap 换到合并 id 配 */
  const imagePathFor = (sceneId: string): string | null => {
    const direct = sceneImageMap[sceneId]
    if (direct) return direct
    const merged = idMap[sceneId]
    if (merged && sceneImageMap[merged]) return sceneImageMap[merged]
    return null
  }

  // ---- 角色图表（characterId → entryPath） ----
  const charImages = pickReader<Record<string, SceneImageEntry[]>>(reader, ':character-images') ?? {}

  // ---- 地点类型图标（reader `:location-icons`：Record<locationType, entryPath>；新通道，加性）----
  const locationIcons = pickReader<Record<string, string>>(reader, ':location-icons') ?? {}

  // ---- 角色中文名 / 分级 / 别名（canonical.objects.characters）----
  const canonical = pickResult<{ objects?: { characters?: CanonicalCharacterRaw[] } }>(results, ':canonical')
  const characterNames = new Map<string, string>()
  /** charId -> importanceLevel 原值（含未预见的 TEMP 等，不写死枚举） */
  const characterLevel = new Map<string, string>()
  const characterAliases = new Map<string, string[]>()
  for (const c of canonical?.objects?.characters ?? []) {
    if (!c?.id) continue
    characterNames.set(c.id, c.name ?? c.id)
    if (typeof c.importanceLevel === 'string') characterLevel.set(c.id, c.importanceLevel)
    if (Array.isArray(c.aliases)) {
      characterAliases.set(
        c.id,
        c.aliases.filter((a): a is string => typeof a === 'string' && !!a)
      )
    }
  }

  // ---- 形象元数据：:characterAppearance 记录 + canonical.characters[].characterAppearances 双来源 ----
  const appearanceMeta = collectAppearances(results)
  for (const c of canonical?.objects?.characters ?? []) {
    if (!c?.id || !Array.isArray(c.characterAppearances)) continue
    let m = appearanceMeta.get(c.id)
    if (!m) {
      m = new Map()
      appearanceMeta.set(c.id, m)
    }
    for (const ap of c.characterAppearances) {
      if (ap?.appearanceId && !m.has(ap.appearanceId)) m.set(ap.appearanceId, ap)
    }
  }

  // ---- 动作统计 ----
  const actionCountByLocation = new Map<string, number>()
  const actionCountByCharacter = new Map<string, number>()
  const actionTypes: Record<string, number> = {}
  let moveCount = 0
  let moveWithoutTarget = 0
  let battleCount = 0
  let battleWithTargets = 0
  for (const a of actions) {
    if (a.locationId) actionCountByLocation.set(a.locationId, (actionCountByLocation.get(a.locationId) ?? 0) + 1)
    if (a.characterId) actionCountByCharacter.set(a.characterId, (actionCountByCharacter.get(a.characterId) ?? 0) + 1)
    actionTypes[a.type] = (actionTypes[a.type] ?? 0) + 1
    if (a.type === 'move') {
      moveCount++
      // 「只有起点、没有终点」是合法数据（实测 29 条里有 3 条），必须能优雅降级
      if (!a.toLocationId) moveWithoutTarget++
    } else if (a.type === 'battle') {
      battleCount++
      if ((a.targetIds ?? []).length) battleWithTargets++
    }
  }

  // ---- 场景 ----
  const scenes: SceneInfo[] = plotLocations.map((p) => {
    // mapLocationId 可能为 null，但 ancId 有值（实测 plotLocationMerge.locations 里存在）
    const nodeId = p.mapLocationId ?? p.ancId ?? null
    const node = nodeId ? nodeById.get(nodeId) : undefined
    const imagePath = imagePathFor(p.id)
    return {
      id: p.id,
      name: p.name ?? p.id,
      mapLocationId: p.mapLocationId ?? null,
      mapLocationName: node?.name ?? null,
      mapLocationType: node?.locationType ?? null,
      identInfos: p.identInfos ?? [],
      summary: p.summary ?? '',
      sceneDescription: p.sceneDescription ?? '',
      imagePath,
      imageUrl: url(imagePath),
      actionCount: actionCountByLocation.get(p.id) ?? 0,
      chunkIndex: p.chunkIndex ?? 0
    }
  })

  const scenesByNode: Record<string, string[]> = {}
  for (const p of plotLocations) {
    if (!p.id) continue
    // 与 scenes[] 用同一套节点判定（含 ancId 兜底）
    const nodeId = p.mapLocationId ?? p.ancId ?? null
    if (!nodeId) continue
    ;(scenesByNode[nodeId] ??= []).push(p.id)
  }

  // ---- 地图树（把场景挂到对应节点上；根节点通常不在 locations 里） ----
  const buildTree = (raw: LocationRaw): MapTreeNode => {
    const base = nodeById.get(raw.id)
    const locationType = raw.locationType ?? base?.locationType ?? '未知'
    const iconPath = locationIcons[locationType] ?? null
    return {
      id: raw.id,
      name: raw.name ?? base?.name ?? raw.id,
      locationType,
      identInfos: raw.identInfos ?? base?.identInfos ?? [],
      parentLocationId: raw.parentLocationId ?? base?.parentLocationId ?? null,
      showOnImpressionMap: raw.showOnImpressionMap ?? base?.showOnImpressionMap ?? true,
      sceneIds: scenesByNode[raw.id] ?? [],
      children: (raw.children ?? []).map(buildTree),
      iconPath,
      iconUrl: url(iconPath)
    }
  }
  const mapRoot: MapTreeNode = lt.tree
    ? buildTree(lt.tree)
    : {
        id: 'root',
        name: '（无地图数据）',
        locationType: '世界',
        identInfos: [],
        parentLocationId: null,
        showOnImpressionMap: true,
        sceneIds: [],
        children: []
      }

  const countTree = (n: MapTreeNode): number => 1 + n.children.reduce((s, c) => s + countTree(c), 0)
  const countTreeWithScenes = (n: MapTreeNode): number =>
    (n.sceneIds.length ? 1 : 0) + n.children.reduce((s, c) => s + countTreeWithScenes(c), 0)

  // ---- 角色立绘（含全量形象：character-images × characterAppearance）----
  const characters: CharacterVisual[] = Object.entries(charImages)
    .map(([id, arr]) => {
      const meta = appearanceMeta.get(id)
      /** appearanceId -> 立绘 entryPath（同形象多图取第一张） */
      const imageByAppearance = new Map<string, string>()
      for (const e of arr ?? []) {
        const apId = e?.appearanceId ?? e?.id ?? ''
        if (e?.imagePath && apId && !imageByAppearance.has(apId)) imageByAppearance.set(apId, e.imagePath)
      }
      // 形象并集：以 character-images 的顺序为准，元数据里多出来的形象补在后面
      const seen = new Set<string>()
      const portraits: CharacterPortrait[] = []
      const pushPortrait = (apId: string): void => {
        if (!apId || seen.has(apId)) return
        seen.add(apId)
        const m = meta?.get(apId)
        const imagePath = imageByAppearance.get(apId) ?? null
        portraits.push({
          appearanceId: apId,
          name: m?.name ?? apId,
          sex: m?.sex ?? '',
          appearanceSummary: m?.appearanceSummary ?? '',
          visualKeywords: (m?.visualKeywords ?? []).filter((k): k is string => typeof k === 'string'),
          imagePath,
          imageUrl: url(imagePath)
        })
      }
      for (const e of arr ?? []) pushPortrait(e?.appearanceId ?? e?.id ?? '')
      for (const apId of meta?.keys() ?? []) pushPortrait(apId)

      const first = portraits.find((p) => p.imageUrl) ?? portraits[0]
      return {
        id,
        name: characterNames.get(id) ?? id,
        imagePath: first?.imagePath ?? null,
        imageUrl: first?.imageUrl ?? null,
        actionCount: actionCountByCharacter.get(id) ?? 0,
        importanceLevel: characterLevel.get(id) ?? '',
        aliases: characterAliases.get(id) ?? [],
        portraits
      }
    })
    .sort((a, b) => b.actionCount - a.actionCount)

  // ---- 配音片段（reader `:dubbing:clip:<chapterSeq>:<order>`，path 为包内 mp3）----
  const dubbing: DubbingClip[] = []
  for (const r of reader) {
    if (typeof r.key !== 'string' || !r.key.includes(':dubbing:clip:')) continue
    const c = unwrap<DubbingClipRaw>(r.value)
    if (!c || typeof c.path !== 'string' || !c.path) continue
    const actionType = c.actionType ?? ''
    const chapterSeq = Number(c.chapterSeq ?? 0)
    const order = Number(c.order ?? 0)
    dubbing.push({
      key: `${actionType}|${chapterSeq}|${order}`,
      actionType,
      chapterSeq,
      order,
      characterId: c.characterId ?? '',
      path: c.path,
      url: url(c.path) as string,
      fingerprint: c.fingerprint ?? '',
      voiceChecksum: c.voiceChecksum ?? ''
    })
  }
  dubbing.sort((a, b) => (a.chapterSeq !== b.chapterSeq ? a.chapterSeq - b.chapterSeq : a.order - b.order))

  // ---- 音色档案（reader `:dubbing:voice:<characterId>`）----
  const dubbingVoices: DubbingVoice[] = []
  for (const r of reader) {
    if (typeof r.key !== 'string' || !r.key.includes(':dubbing:voice:')) continue
    const v = unwrap<DubbingVoiceRaw>(r.value)
    if (!v) continue
    const i = r.key.indexOf(':dubbing:voice:')
    const characterId = v.characterId ?? r.key.slice(i + ':dubbing:voice:'.length)
    if (!characterId) continue
    dubbingVoices.push({
      characterId,
      description: v.vi ?? '',
      samplePath: v.path ?? '',
      sampleUrl: v.path ? (url(v.path) as string) : ''
    })
  }

  // ---- 分章索引 ----
  const chapterTitles = new Map<number, string>()
  for (const it of toList<{ seq?: number; title?: string }>(records.chapters)) {
    const v = it.value
    if (v && typeof v.seq === 'number' && v.title) chapterTitles.set(v.seq, v.title)
  }
  const chapters: ChapterSpan[] = []
  actions.forEach((a, i) => {
    const last = chapters[chapters.length - 1]
    if (!last || last.chapterSeq !== a.chapterSeq) {
      if (last) last.end = i
      chapters.push({
        chapterSeq: a.chapterSeq,
        title: chapterTitles.get(a.chapterSeq) ?? `第 ${a.chapterSeq} 章`,
        start: i,
        end: actions.length,
        count: 0,
        sceneIds: []
      })
    }
    const cur = chapters[chapters.length - 1]
    cur.count += 1
    if (a.locationId && !cur.sceneIds.includes(a.locationId)) cur.sceneIds.push(a.locationId)
  })

  const characterArt = pickReader<{ text?: string }>(reader, ':character-art-style')
  const sceneArt = pickReader<{ text?: string }>(reader, ':scene-art-style')

  // ---- 印象图谱（impressionLayout.data.layout，注意 layouts 不在顶层） ----
  const impRaw = pickResult<ImpressionRaw>(results, ':impressionLayout')
  const impLayout = impRaw?.layout
  const rawGroups = impLayout?.layouts ?? []
  const groups: ImpressionLayoutGroup[] = rawGroups
    .filter((g) => g && typeof g.parentId === 'string')
    .map((g) => ({
      parentId: String(g.parentId),
      mode: String(g.mode ?? ''),
      placements: (g.placements ?? [])
        .filter((p) => p && typeof p.id === 'string' && p.rect)
        .map((p) => ({
          id: String(p.id),
          rect: {
            x: Number(p.rect?.x ?? 0),
            y: Number(p.rect?.y ?? 0),
            width: Number(p.rect?.width ?? 0),
            height: Number(p.rect?.height ?? 0)
          }
        }))
    }))
    .filter((g) => g.placements.length > 0)

  // 根：作为 parentId 出现、但自身从未被摆放的那个（通常是 novel-world）
  const parentIds = new Set(groups.map((g) => g.parentId))
  const placedIds = new Set(groups.flatMap((g) => g.placements.map((p) => p.id)))
  const rootParentId = [...parentIds].find((id) => !placedIds.has(id)) ?? mapRoot.id

  const impression: ImpressionData | null = groups.length
    ? {
        gridSize: Number(impLayout?.gridSize ?? 100),
        layouts: groups,
        rootParentId
      }
    : null

  const distinctActionLocations = new Set(actions.map((a) => a.locationId).filter(Boolean)).size
  const distinctActionCharacters = new Set(actions.map((a) => a.characterId).filter(Boolean)).size

  return {
    assetBase,
    protocol,
    mapRoot,
    mapNodes,
    scenes,
    scenesByNode,
    characters,
    actions,
    chapters,
    artStyles: { character: characterArt?.text ?? '', scene: sceneArt?.text ?? '' },
    impression,
    dubbing,
    dubbingVoices,
    effectRanges,
    stats: {
      storyScriptChunks: ssChunks.length,
      sceneIdMappings: Object.keys(idMap).length,
      scenesWithImage: scenes.filter((s) => !!s.imageUrl).length,
      mapNodeCount: countTree(mapRoot),
      mapNodeCountWithScenes: countTreeWithScenes(mapRoot),
      sceneCount: scenes.length,
      characterCount: characters.length,
      actionCount: actions.length,
      actionTypes,
      distinctActionLocations,
      distinctActionCharacters,
      moveCount,
      moveWithoutTarget,
      battleCount,
      battleWithTargets,
      impressionPlacementCount: groups.reduce((s, g) => s + g.placements.length, 0),
      impressionLevelCount: groups.length,
      dubbingClipCount: dubbing.length,
      dubbingVoiceCount: dubbingVoices.length,
      portraitCount: characters.reduce((s, c) => s + c.portraits.length, 0),
      locationTreeSource
    }
  }
}

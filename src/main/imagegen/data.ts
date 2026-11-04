/**
 * 生图目标清单 + 提示词上下文（纯读，绝不写盘）。
 *
 * 数据来源（与 `t2w/view.ts` 的解析口径**逐字一致**，两处消费同一份产物）：
 *   - 人物形象：`:characterAppearance`（含 `…:characterAppearance:<charId>` 单角色键，
 *     排除 `:batch:`/`:plan` 变体）+ `:canonical`（名字/别名/characterAppearances 双来源合并）；
 *     缺图判定读 reader `:character-images`（appearanceId 命中已有 imagePath）。
 *   - 场景：`:plotLocation` 各 chunk 产物（**排除** `:plotLocationMerge` —— includes 会误命中）
 *     + `:plotLocationMerge`（合并后 locations + idMap）；key 用**合并后 id**（idMap[src] ?? src），
 *     缺图判定读 reader `:scene-images.individual`。
 *   - 地点类型：`:locationTree` 展开全部节点的 locationType 去重；已有图标读 reader `:location-icons`。
 *   - 上下文：`:worldImpression`（worldImpression / novelGenre / locationIconArtStyle）+ reader 画风文本。
 */
import type { CharTarget, IconTarget, ImagegenContext, SceneTarget } from '../../shared/imagegen-types'
import { assembleManifest } from '../workspace/manifest-assembler'
import { readIndex } from '../workspace/index-store'
import { pickMainEntry, isVariant } from '../workspace/variant'

interface Keyed<T = unknown> {
  key: string
  value: T
}

interface AppearanceRaw {
  appearanceId?: string
  name?: string
  sex?: string
  appearanceSummary?: string
  visualKeywords?: string[]
}
interface CanonicalCharacterRaw {
  id?: string
  name?: string
  aliases?: string[]
  characterAppearances?: AppearanceRaw[]
}
interface PlotLocationRaw {
  id: string
  name?: string
  summary?: string
  sceneDescription?: string
  chunkIndex?: number
  sourceLocationIds?: string[]
}
interface LocationRaw {
  id?: string
  name?: string
  locationType?: string
  children?: LocationRaw[]
}
interface SceneImageEntry {
  id?: string
  appearanceId?: string
  imagePath?: string
}

/** results 条目值两种形态（带/不带 .data 层）——与 view.ts unwrap 同款语义。 */
function unwrap<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') {
    const d = (value as Record<string, unknown>).data
    if (d !== undefined && d !== null) return d as T
  }
  return value as T
}

function toList<T>(node: unknown): Keyed<T>[] {
  if (Array.isArray(node)) return node as Keyed<T>[]
  if (node && typeof node === 'object') {
    return Object.entries(node as Record<string, T>).map(([key, value]) => ({ key, value }))
  }
  return []
}

/** 取某 needle 的主条目值（主条目规则统一走 variant.ts）。 */
function pickResult<T>(results: Keyed[], needle: string): T | null {
  return unwrap<T>(pickMainEntry(results, needle)?.value)
}

/** 汇总 :characterAppearance 的形象元数据（与 view.ts collectAppearances 同款合并语义）。 */
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

/** 展开地图树全部节点的 locationType。 */
function collectLocationTypes(raw: LocationRaw, out: Set<string>): void {
  if (typeof raw.locationType === 'string' && raw.locationType.trim()) out.add(raw.locationType.trim())
  for (const c of raw.children ?? []) collectLocationTypes(c, out)
}

export interface ImagegenTargets {
  chars: CharTarget[]
  scenes: SceneTarget[]
  icons: IconTarget[]
  context: ImagegenContext
}

/**
 * 读取工作库的生图目标清单（纯读）。
 * @param root 工作库根目录
 */
export async function readImagegenTargets(root: string): Promise<ImagegenTargets> {
  const idx = await readIndex(root)
  const manifest = await assembleManifest(root, idx)
  const records = (manifest.records ?? {}) as Record<string, unknown>
  const results = toList<unknown>(records.results)
  const reader = toList<unknown>(records.reader)

  const pickReader = <T>(needle: string): T | null => {
    const hit = reader.find((r) => typeof r.key === 'string' && r.key.includes(needle))
    return unwrap<T>(hit?.value)
  }

  // ---- 上下文 ----
  // C1：`worldImpression` 里含剧情脉络（「故事从马赛港开始…到巴黎…」），
  // 那是给人看的背景理解；绘图模型只需要**画面事实**。
  // 新包会有独立的 `visualImpression`（纯视觉基调），优先用它；
  // 旧包没有该字段 → 回落到 worldImpression（行为与改造前一致，不破坏存量）。
  const wi = pickResult<{
    worldImpression?: string
    visualImpression?: string
    novelGenre?: string
    locationIconArtStyle?: string
  }>(results, ':worldImpression')
  const visual = (wi?.visualImpression ?? '').trim()
  const context: ImagegenContext = {
    worldImpression: visual || (wi?.worldImpression ?? ''),
    worldImpressionRaw: wi?.worldImpression ?? '',
    novelGenre: wi?.novelGenre ?? '',
    iconStyle: wi?.locationIconArtStyle ?? '',
    charArtStyle: pickReader<{ text?: string }>(':character-art-style')?.text ?? '',
    sceneArtStyle: pickReader<{ text?: string }>(':scene-art-style')?.text ?? ''
  }

  // ---- 人物 ----
  const charImages =
    pickReader<Record<string, SceneImageEntry[]>>(':character-images') ?? {}
  const canonical = pickResult<{ objects?: { characters?: CanonicalCharacterRaw[] } }>(results, ':canonical')
  const nameById = new Map<string, string>()
  const aliasesById = new Map<string, string[]>()
  for (const c of canonical?.objects?.characters ?? []) {
    if (!c?.id) continue
    if (c.name) nameById.set(c.id, c.name)
    if (Array.isArray(c.aliases)) {
      aliasesById.set(c.id, c.aliases.filter((a): a is string => typeof a === 'string' && !!a))
    }
  }
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
  const chars: CharTarget[] = []
  for (const [charId, appearances] of appearanceMeta) {
    const existing = charImages[charId] ?? []
    for (const [appearanceId, ap] of appearances) {
      // 与 view.ts 同款判定：appearanceId 缺失时退回条目 id 字段
      const hit = existing.find((e) => (e?.appearanceId ?? e?.id ?? '') === appearanceId && !!e?.imagePath)
      chars.push({
        charId,
        charName: nameById.get(charId) ?? charId,
        appearanceId,
        appearanceName: ap?.name ?? appearanceId,
        sex: ap?.sex ?? '',
        appearanceSummary: ap?.appearanceSummary ?? '',
        visualKeywords: (ap?.visualKeywords ?? []).filter((k): k is string => typeof k === 'string'),
        hasImage: !!hit,
        imagePath: hit?.imagePath ?? '',
        aliases: aliasesById.get(charId) ?? []
      })
    }
  }

  // ---- 场景（key 用合并后 id）----
  const sceneImages = pickReader<{ shared?: Record<string, string>; individual?: Record<string, string> }>(':scene-images')
  const sceneImageMap: Record<string, string> = sceneImages?.individual ?? {}
  const merge = pickResult<{ locations?: PlotLocationRaw[]; idMap?: Record<string, string> }>(
    results,
    ':plotLocationMerge'
  )
  const idMap: Record<string, string> = { ...(merge?.idMap ?? {}) }
  for (const l of merge?.locations ?? []) {
    for (const src of l.sourceLocationIds ?? []) {
      if (src && l.id && !idMap[src]) idMap[src] = l.id
    }
  }
  /** mergedId → 场景信息（merge 的 locations 优先，plotLocation 兜底） */
  const sceneById = new Map<string, { name: string; summary: string; sceneDescription: string }>()
  for (const l of merge?.locations ?? []) {
    if (!l?.id) continue
    sceneById.set(l.id, {
      name: l.name ?? l.id,
      summary: l.summary ?? '',
      sceneDescription: l.sceneDescription ?? ''
    })
  }
  // plotLocation 各 chunk 产物（needle 必须排除 :plotLocationMerge，includes 才不会误命中）
  for (const r of results) {
    if (typeof r.key !== 'string' || !r.key.includes(':plotLocation') || r.key.includes(':plotLocationMerge')) continue
    if (isVariant(r.key)) continue
    const d = unwrap<{ plotLocations?: PlotLocationRaw[] }>(r.value)
    for (const p of d?.plotLocations ?? []) {
      if (!p?.id) continue
      const mergedId = idMap[p.id] ?? p.id
      if (!sceneById.has(mergedId)) {
        sceneById.set(mergedId, {
          name: p.name ?? mergedId,
          summary: p.summary ?? '',
          sceneDescription: p.sceneDescription ?? ''
        })
      }
    }
  }
  const scenes: SceneTarget[] = [...sceneById.entries()].map(([sceneId, info]) => {
    const imagePath = sceneImageMap[sceneId] ?? ''
    return {
      sceneId,
      name: info.name,
      summary: info.summary,
      sceneDescription: info.sceneDescription,
      hasImage: !!imagePath,
      imagePath
    }
  })

  // ---- 地点类型（locationTree 展开去重）----
  const locationIcons = pickReader<Record<string, string>>(':location-icons') ?? {}
  const lt = pickResult<{ locations?: LocationRaw[]; tree?: LocationRaw }>(results, ':locationTree') ?? {}
  const typeSet = new Set<string>()
  for (const l of lt.locations ?? []) {
    if (l?.locationType?.trim()) typeSet.add(l.locationType.trim())
  }
  if (lt.tree) collectLocationTypes(lt.tree, typeSet)
  const icons: IconTarget[] = [...typeSet].map((locationType) => ({
    locationType,
    hasIcon: !!locationIcons[locationType],
    iconPath: locationIcons[locationType] ?? ''
  }))

  return { chars, scenes, icons, context }
}

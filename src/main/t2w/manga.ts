/**
 * 漫画线投影：把 manifest 的 `mangaScript` / `manga-performance` / `manga-images` /
 * `mangaEffects` / `mangaMusic` / 漫画配音 整理成 `MangaViewData`。
 *
 * 与 `t2w/view.ts` **完全独立**：漫画线不产出 storyScript，两条线的数据形态也不同，
 * 强行塞进同一个 ViewData 会让两边都变脏。共用的是 `workspace/variant.ts` 的变体规则。
 *
 * 只读 manifest，不发起任何 LLM 请求，不落盘。
 */
import type { T2wManifest } from '../../shared/t2w-types'
import type {
  MangaChapter,
  MangaDubbingClip,
  MangaDubbingSettings,
  MangaMusicBrief,
  MangaMusicTrack,
  MangaPage,
  MangaPanel,
  MangaRect,
  MangaSpeech,
  MangaViewData,
  MangaVoice
} from '../../shared/manga-types'
import { isVariant } from '../workspace/variant'

interface Keyed<T = unknown> {
  key: string
  value: T
}

/** results 条目的两种形态（带/不带 .data 层），与 view.ts 同规则 */
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

/** 包内原始分镜 */
interface RawPanel {
  no?: number
  lines?: number[][]
  scene?: string
  content?: string
  speech?: { type?: string; speaker?: string; text?: string }[]
}
interface RawPage {
  context?: string
  characters?: { name?: string; appearanceId?: string }[]
  panels?: RawPanel[]
}
interface RawChapter {
  chapterSeq?: number
  pages?: RawPage[]
}
interface RawMangaScript {
  chapters?: RawChapter[]
  warnings?: string[]
}

/** reader `manga-performance:<key>` */
interface RawPerformance {
  imagePath?: string
  drawingHash?: string
  frames?: { no?: number; rect?: Partial<MangaRect>; method?: string }[]
  regions?: { text?: string; rect?: Partial<MangaRect> }[]
  ocr?: boolean
  note?: string
}

/** reader `manga-images` → { "manga-1-1": {imagePath, scriptHash, colorMode} } */
interface RawImageEntry {
  imagePath?: string
  scriptHash?: string
  colorMode?: string
}

/** results `mangaEffects:chapter:...` */
interface RawEffects {
  effects?: {
    chapterSeq?: number
    page?: number
    panel?: number
    effects?: { id?: string; color?: string; opacity?: number }[]
  }[]
  scriptHash?: string
}

/** 章级配乐：mangaMusic 有三种键形态，值结构都是 {groups:[{plan,selection}]} */
interface RawMusicGroup {
  plan?: {
    musicBrief?: Partial<MangaMusicBrief>
    chapters?: { chapterSeq?: number; ranges?: { fromPage?: number; toPage?: number }[] }[]
  }
  selection?: {
    track?: {
      id?: string
      title?: string
      author?: string
      url?: string
      bpm?: number
      duration?: number
      license?: { id?: string; attribution?: string }
    }
    reason?: string
  }
}
interface RawMusic {
  groups?: RawMusicGroup[]
  scriptHash?: string
}

interface RawDubbingClip {
  v?: number
  actionType?: string
  chapterSeq?: number
  order?: number
  characterId?: string
  fingerprint?: string
  textFingerprint?: string
  path?: string
  voiceChecksum?: string
}
interface RawVoice {
  characterId?: string
  vt?: string
  vi?: string
  path?: string
  checksum?: string
}
interface RawDubbingSettings {
  kinds?: string[]
  narrator?: string
  playbackRate?: number
}

/** 归一化矩形：容忍 undefined / 越界，全部钳到 0..1 */
function normRect(r: Partial<MangaRect> | undefined | null): MangaRect | null {
  if (!r) return null
  const n = (v: unknown): number => {
    const x = Number(v)
    return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0
  }
  const x = n(r.x)
  const y = n(r.y)
  const width = n(r.width)
  const height = n(r.height)
  // 全 0 或零面积视为无效（实测存在空 rect 的兜底场景）
  if (width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

/**
 * 从 project-edits（reader `project-edits`）里取 `results["mangaScript:0"]` 的 data。
 *
 * 这是**最高优先级**的数据源：panels 带 speech[]（编辑后的台词），
 * 而 results 原条目没有 speech 字段。
 * 键可能是 `mangaScript:0`，也可能带项目前缀，故按 includes 匹配。
 */
function pickEditedScript(reader: Keyed[]): RawMangaScript | null {
  const hit = reader.find((r) => typeof r.key === 'string' && r.key.length === 'project-edits'.length && r.key === 'project-edits')
    ?? reader.find((r) => typeof r.key === 'string' && r.key.includes('project-edits'))
  if (!hit) return null
  const val = hit.value as { results?: Record<string, unknown> } | null
  if (!val || typeof val !== 'object') return null
  const results = val.results
  if (!results || typeof results !== 'object') return null
  // 优先精确键，其次任意包含 mangaScript 且非 batch 的键
  const direct = results['mangaScript:0']
  const fallback = Object.entries(results).find(
    ([k]) => k.includes('mangaScript') && !isVariant(k)
  )?.[1]
  const entry = direct ?? fallback
  if (!entry) return null
  const data = unwrap<RawMangaScript>(entry)
  return data && Array.isArray(data.chapters) ? data : null
}

/** 从 results 取原始 mangaScript（多 chunk 合并；排除 :batch: 变体） */
function pickRawScript(results: Keyed[]): RawMangaScript | null {
  const chunks = results
    .filter((r) => typeof r.key === 'string' && r.key.includes('mangaScript') && !r.key.includes(':batch:'))
    .sort((a, b) => {
      const ra = /mangaScript:(\d+)/.exec(a.key)
      const rb = /mangaScript:(\d+)/.exec(b.key)
      return Number(ra?.[1] ?? 0) - Number(rb?.[1] ?? 0)
    })
  if (!chunks.length) {
    // 兜底：只有 batch 时至少取第一条，别整页空白
    const any = results.find((r) => typeof r.key === 'string' && r.key.includes('mangaScript'))
    if (!any) return null
    const one = unwrap<RawMangaScript>(any.value)
    return one && Array.isArray(one.chapters) ? one : null
  }
  // 合并各 chunk 的 chapters（按 chapterSeq 去重，先到先得）
  const merged: RawChapter[] = []
  const seen = new Set<number>()
  for (const c of chunks) {
    const d = unwrap<RawMangaScript>(c.value)
    if (!d || !Array.isArray(d.chapters)) continue
    for (const ch of d.chapters) {
      const seq = Number(ch?.chapterSeq ?? 0)
      if (!seq || seen.has(seq)) continue
      seen.add(seq)
      merged.push(ch)
    }
  }
  if (!merged.length) return null
  merged.sort((a, b) => Number(a.chapterSeq ?? 0) - Number(b.chapterSeq ?? 0))
  return { chapters: merged }
}

/** 收集 reader 里所有 `manga-performance:<pageKey>` → pageKey -> frames */
function collectPerformances(reader: Keyed[]): Map<string, RawPerformance> {
  const out = new Map<string, RawPerformance>()
  const NEEDLE = 'manga-performance:'
  for (const r of reader) {
    if (typeof r.key !== 'string') continue
    const i = r.key.indexOf(NEEDLE)
    if (i < 0) continue
    const pageKey = r.key.slice(i + NEEDLE.length)
    if (!pageKey || out.has(pageKey)) continue
    const p = unwrap<RawPerformance>(r.value)
    if (p) out.set(pageKey, p)
  }
  return out
}

/** 收集章级特效：chapterSeq -> (page|panel -> effectIds[]) */
function collectEffects(results: Keyed[]): Map<number, Map<string, string[]>> {
  const out = new Map<number, Map<string, string[]>>()
  for (const r of results) {
    if (typeof r.key !== 'string' || !r.key.includes('mangaEffects')) continue
    // 章级键形如 mangaEffects:chapter:<ch>:<hash>:<hash>；排除 :plan/:select 变体
    if (isVariant(r.key)) continue
    if (!r.key.includes(':chapter:')) continue
    const d = unwrap<RawEffects>(r.value)
    if (!d || !Array.isArray(d.effects)) continue
    for (const item of d.effects) {
      const ch = Number(item?.chapterSeq ?? 0)
      const page = Number(item?.page ?? 0)
      const panel = Number(item?.panel ?? 0)
      if (!ch || !page) continue
      const ids = (item.effects ?? [])
        .map((e) => (typeof e?.id === 'string' ? e.id : ''))
        .filter((x): x is string => !!x)
      if (!ids.length) continue
      let byCh = out.get(ch)
      if (!byCh) {
        byCh = new Map()
        out.set(ch, byCh)
      }
      const k = `${page}|${panel}`
      const prev = byCh.get(k)
      byCh.set(k, prev ? [...prev, ...ids.filter((x) => !prev.includes(x))] : ids)
    }
  }
  return out
}

/** 收集配乐：chapterSeq -> {brief, track} */
function collectMusic(results: Keyed[]): Map<number, { brief: MangaMusicBrief | null; track: MangaMusicTrack | null }> {
  const out = new Map<number, { brief: MangaMusicBrief | null; track: MangaMusicTrack | null }>()
  // 只看章级（含 :chapter: 的键）与非 plan/select 变体；music: 前缀那批是 brief/tracks 中间产物
  const candidates = results.filter(
    (r) => typeof r.key === 'string' && r.key.includes('mangaMusic') && r.key.includes(':chapter:') && !isVariant(r.key)
  )
  // 若没有章级，退回任意非变体的 mangaMusic
  const list = candidates.length
    ? candidates
    : results.filter((r) => typeof r.key === 'string' && r.key.includes('mangaMusic') && !isVariant(r.key))
  for (const r of list) {
    const d = unwrap<RawMusic>(r.value)
    if (!d || !Array.isArray(d.groups)) continue
    for (const g of d.groups) {
      const brief = g?.plan?.musicBrief
      const track = g?.selection?.track
      const chs = g?.plan?.chapters ?? []
      const seqs = chs
        .map((c) => Number(c?.chapterSeq ?? 0))
        .filter((n) => Number.isFinite(n) && n > 0)
      // 章列表为空时无法归属，跳过（不猜）
      for (const seq of seqs) {
        const prev = out.get(seq) ?? { brief: null, track: null }
        out.set(seq, {
          brief: prev.brief ?? (brief && typeof brief === 'object' ? narrowBrief(brief) : null),
          track: prev.track ?? (track && typeof track === 'object' ? narrowTrack(track) : null)
        })
      }
    }
  }
  return out
}

function narrowBrief(b: Partial<MangaMusicBrief>): MangaMusicBrief {
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []
  return {
    purpose: typeof b.purpose === 'string' ? b.purpose : '',
    mood: arr(b.mood),
    style: arr(b.style),
    energy: Number.isFinite(Number(b.energy)) ? Number(b.energy) : 0,
    pace: typeof b.pace === 'string' ? b.pace : '',
    avoid: arr(b.avoid)
  }
}

function narrowTrack(t: NonNullable<NonNullable<RawMusicGroup['selection']>['track']>): MangaMusicTrack {
  return {
    id: typeof t.id === 'string' ? t.id : '',
    title: typeof t.title === 'string' ? t.title : '',
    author: typeof t.author === 'string' ? t.author : '',
    url: typeof t.url === 'string' ? t.url : '',
    bpm: Number.isFinite(Number(t.bpm)) ? Number(t.bpm) : 0,
    durationSec: Number.isFinite(Number(t.duration)) ? Number(t.duration) : 0,
    licenseId: typeof t.license?.id === 'string' ? t.license.id : '',
    attribution: typeof t.license?.attribution === 'string' ? t.license.attribution : ''
  }
}

/** 章节标题（records.chapters） */
function collectChapterTitles(manifest: T2wManifest): Map<number, string> {
  const out = new Map<number, string>()
  const recs = (manifest.records ?? {}) as Record<string, unknown>
  for (const it of toList<{ seq?: number; title?: string }>(recs.chapters)) {
    const v = it.value
    if (v && typeof v.seq === 'number' && v.title) out.set(v.seq, v.title)
  }
  return out
}

/**
 * 构建漫画视图模型。
 *
 * `hasManga` 为 false 时返回 `null` —— 调用方据此判定「本包没有漫画线」，
 * 不要用「chapters 为空」判定（有漫画任务但全部失败的包，chapters 也是空的）。
 */
export function buildMangaView(manifest: T2wManifest, assetBase: string): MangaViewData | null {
  const records = (manifest.records ?? {}) as Record<string, unknown>
  const results = toList<unknown>(records.results)
  const reader = toList<unknown>(records.reader)

  const url = (p: string | null | undefined): string | null => (p ? assetBase + p : null)

  // 判定是否存在漫画线：只要有 mangaScript 或 manga-performance / manga-images 任一即可
  const hasMangaScript = results.some((r) => typeof r.key === 'string' && r.key.includes('mangaScript'))
  const hasPageArt = reader.some(
    (r) => typeof r.key === 'string' && (r.key.includes('manga-performance') || r.key.includes('manga-images'))
  )
  if (!hasMangaScript && !hasPageArt) return null

  // ---- 脚本：project-edits 优先 ----
  const edited = pickEditedScript(reader)
  const raw = pickRawScript(results)
  const script = edited ?? raw
  const scriptSource: 'edited' | 'raw' | 'none' = edited ? 'edited' : raw ? 'raw' : 'none'

  // ---- 页面图与热区 ----
  const imageEntries = unwrap<Record<string, RawImageEntry>>(
    reader.find((r) => typeof r.key === 'string' && r.key.includes('manga-images'))?.value
  ) ?? {}
  const performances = collectPerformances(reader)
  const effectsByCh = collectEffects(results)
  const musicByCh = collectMusic(results)
  const titles = collectChapterTitles(manifest)

  // ---- 装配 chapters ----
  const chapters: MangaChapter[] = []
  let pageCount = 0
  let panelCount = 0
  let speechCount = 0
  let pagesWithImage = 0
  let effectCount = 0
  let chaptersWithMusic = 0

  for (const rc of script?.chapters ?? []) {
    const chapterSeq = Number(rc?.chapterSeq ?? 0)
    if (!chapterSeq) continue
    const chEffects = effectsByCh.get(chapterSeq)
    const music = musicByCh.get(chapterSeq)
    const pages: MangaPage[] = []

    ;(rc.pages ?? []).forEach((rp, pageIdx) => {
      const pageNo = pageIdx + 1
      const key = `manga-${chapterSeq}-${pageNo}`
      const img = imageEntries[key]
      const perf = performances.get(key)
      // 图路径优先取 manga-images（权威），退回 performance.imagePath
      const imagePath = img?.imagePath ?? perf?.imagePath ?? null
      // frames 按 no 建索引，供 panels 对齐
      const frameByNo = new Map<number, MangaRect | null>()
      for (const f of perf?.frames ?? []) {
        const no = Number(f?.no ?? 0)
        if (!no) continue
        frameByNo.set(no, normRect(f.rect))
      }

      const panels: MangaPanel[] = (rp.panels ?? []).map((p, pIdx) => {
        const no = Number(p?.no ?? pIdx + 1)
        const speech: MangaSpeech[] = (p?.speech ?? [])
          .map((s) => ({
            type: typeof s?.type === 'string' && s.type ? s.type : 'narration',
            speaker: typeof s?.speaker === 'string' ? s.speaker : undefined,
            text: typeof s?.text === 'string' ? s.text : ''
          }))
          .filter((s) => !!s.text)
        const ids = chEffects?.get(`${pageNo}|${no}`) ?? []
        return {
          no,
          lines: Array.isArray(p?.lines)
            ? p.lines.filter((l): l is number[] => Array.isArray(l) && l.length >= 2)
            : [],
          content: typeof p?.content === 'string' ? p.content : '',
          scene: typeof p?.scene === 'string' ? p.scene : '',
          speech,
          rect: frameByNo.get(no) ?? null,
          effectIds: ids
        }
      })

      const pageEffects = panels.reduce((s, p) => s + p.effectIds.length, 0)
      effectCount += pageEffects
      panelCount += panels.length
      speechCount += panels.reduce((s, p) => s + p.speech.length, 0)
      pageCount++
      if (imagePath) pagesWithImage++

      pages.push({
        no: pageNo,
        key,
        imagePath,
        imageUrl: url(imagePath),
        colorMode: typeof img?.colorMode === 'string' ? img.colorMode : '',
        context: typeof rp?.context === 'string' ? rp.context : '',
        characters: (rp.characters ?? [])
          .map((c) => ({
            name: typeof c?.name === 'string' ? c.name : '',
            appearanceId: typeof c?.appearanceId === 'string' ? c.appearanceId : ''
          }))
          .filter((c) => !!c.name || !!c.appearanceId),
        panels,
        hasImage: !!imagePath
      })
    })

    if (music?.track) chaptersWithMusic++
    chapters.push({
      chapterSeq,
      title: titles.get(chapterSeq) ?? `第 ${chapterSeq} 章`,
      pages,
      effectCount: pages.reduce((s, p) => s + p.panels.reduce((a, pp) => a + pp.effectIds.length, 0), 0),
      music: music?.track ?? null
    })
  }

  // ---- 漫画配音 ----
  const dubbing: MangaDubbingClip[] = []
  for (const r of reader) {
    if (typeof r.key !== 'string' || !r.key.includes(':dubbing:clip:')) continue
    // 只要漫画专用（manga 前缀）片段；正片 :dubbing:clip: 由 view.ts 处理
    if (!r.key.includes('manga')) continue
    const c = unwrap<RawDubbingClip>(r.value)
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
      fingerprint: c.fingerprint ?? c.textFingerprint ?? '',
      voiceChecksum: c.voiceChecksum ?? ''
    })
  }
  dubbing.sort((a, b) => (a.chapterSeq !== b.chapterSeq ? a.chapterSeq - b.chapterSeq : a.order - b.order))

  // ---- 漫画音色 ----
  const voices: MangaVoice[] = []
  for (const r of reader) {
    if (typeof r.key !== 'string' || !r.key.includes(':dubbing:voice:')) continue
    if (!r.key.includes('manga')) continue
    const v = unwrap<RawVoice>(r.value)
    if (!v) continue
    const i = r.key.indexOf(':dubbing:voice:')
    const characterId = v.characterId ?? r.key.slice(i + ':dubbing:voice:'.length)
    if (!characterId) continue
    voices.push({
      characterId,
      vt: v.vt ?? '',
      vi: v.vi ?? '',
      samplePath: v.path ?? '',
      sampleUrl: v.path ? (url(v.path) as string) : '',
      isNarrator: characterId === '$narrator'
    })
  }

  // ---- 配音设置 ----
  let dubbingSettings: MangaDubbingSettings | null = null
  const settingsHit = reader.find((r) => typeof r.key === 'string' && r.key.includes('manga') && r.key.endsWith(':dubbing:settings'))
  if (settingsHit) {
    const s = unwrap<RawDubbingSettings>(settingsHit.value)
    if (s) {
      dubbingSettings = {
        kinds: Array.isArray(s.kinds) ? s.kinds.filter((k): k is string => typeof k === 'string') : [],
        narrator: typeof s.narrator === 'string' ? s.narrator : '',
        playbackRate: Number.isFinite(Number(s.playbackRate)) ? Number(s.playbackRate) : 1
      }
    }
  }

  return {
    chapters,
    dubbing,
    voices,
    dubbingSettings,
    stats: {
      chapterCount: chapters.length,
      pageCount,
      panelCount,
      speechCount,
      pagesWithImage,
      effectCount,
      chaptersWithMusic,
      dubbingClipCount: dubbing.length,
      voiceCount: voices.length,
      scriptSource,
      editsApplied: !!edited && scriptSource === 'edited'
    }
  }
}

/**
 * 配乐需求（brief）单独取一次。
 *
 * ⚠️ 实测（gmzz-10）`mangaMusic:music:<ch>:…:brief` 的值是
 * `{ scriptHash, musicGroups: [{ musicBrief, chapters }] }` —— 键叫 **musicGroups**，
 * 而不是章级 `:chapter:` 条目的 `groups`。两者结构同形但键名不同，必须都认。
 * 另有 `:brief:plan:0` 变体（只有 musicGroups），由 isVariant 排除。
 */
export function buildMangaMusicBriefs(manifest: T2wManifest): Map<number, MangaMusicBrief> {
  const out = new Map<number, MangaMusicBrief>()
  const results = toList<unknown>(((manifest.records ?? {}) as Record<string, unknown>).results)
  for (const r of results) {
    if (typeof r.key !== 'string' || !r.key.includes('mangaMusic')) continue
    if (!r.key.includes(':brief')) continue
    if (isVariant(r.key)) continue
    const d = unwrap<{ scriptHash?: string; musicGroups?: RawMusicGroup[]; groups?: RawMusicGroup[] }>(r.value)
    const groups = d?.musicGroups ?? d?.groups
    if (!Array.isArray(groups)) continue
    for (const g of groups) {
      const brief = g?.plan?.musicBrief ?? (g as { musicBrief?: Partial<MangaMusicBrief> })?.musicBrief
      if (!brief || typeof brief !== 'object') continue
      const chs = g?.plan?.chapters ?? (g as { chapters?: { chapterSeq?: number }[] })?.chapters ?? []
      for (const c of chs) {
        const seq = Number(c?.chapterSeq ?? 0)
        if (seq > 0 && !out.has(seq)) out.set(seq, narrowBrief(brief))
      }
    }
  }
  return out
}

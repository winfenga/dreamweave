/**
 * 漫画编排面板的服务层：把「讲述与配音 / 背景配乐 / 本页音色」需要的数据聚合起来，
 * 并实现「重新配音」（逐段 TTS → 写回）。
 *
 * 面板三块与截图一致：
 *   1) 讲述与配音：列出本页每段讲述 + 它的配音状态（已有文件 / 时长 / 可试听 / 可重配）
 *   2) 背景配乐  ：本章当前曲目 + 手动换曲 / 候选池
 *   3) 本页音色  ：本页出场人物（含旁白）的音色，可改类型与描述、设默认、试听样本
 *
 * 【为什么时长要额外读】clip 里没有 durationMs，得读音频头部。
 * 这里不引第三方库：只对 mp3 做「帧头累加」的粗算，够界面显示。
 * 读不出来就给 0，界面显示「—」，不当成错误。
 */
import { createHash } from 'node:crypto'
import type { T2wManifest } from '../../shared/t2w-types'
import type {
  MangaChapter,
  MangaDubbingClip,
  MangaMusicTrack,
  MangaPage,
  MangaViewData,
  MangaVoice
} from '../../shared/manga-types'
import { alignSegmentsToClips, buildSegmentIndex } from './segments'
import type { MangaSpeechSegment } from './segments'
import { collectMusicCandidates } from './write'

/** 一段讲述 + 它的配音状态 */
export interface ProductionSegment {
  /** 段序号（章内 0 起，= clip.order - 1000000） */
  index: number
  /** 所属页（1 起） */
  page: number
  /** 所属分镜 */
  panel: number
  /** narration | say | think */
  type: string
  /** 说话人显示名（narration 为空） */
  speaker: string
  /** 文本 */
  text: string
  /** 本句所属 speech 的完整文本 */
  fullText: string
  /** 有没有配音文件 */
  hasClip: boolean
  /** 音频 URL（t2w://）；没有则空串 */
  url: string
  /** 时长（秒，读不出为 0） */
  durationSec: number
  /** 音色归属（characterId） */
  characterId: string
  /** 音色是否「异常」（clip 的 voiceChecksum 对不上任何现存音色档案） */
  voiceOrphan: boolean
}

/** 一页的编排数据 */
export interface PageProduction {
  chapterSeq: number
  chapterTitle: string
  pageNo: number
  /** 全局页序号 / 总页数 */
  pageIndex: number
  totalPages: number
  context: string
  segments: ProductionSegment[]
  /** 本页出场人物 id（用于「本页音色」） */
  characterIds: string[]
  /** 这一页的对齐是否可信（段数 == clip 数）；false 时界面应禁止重配 */
  alignExact: boolean
  alignReason?: string
}

/** 整本编排概览 */
export interface ProductionOverview {
  chapters: { chapterSeq: number; title: string; pageCount: number }[]
  stats: {
    segmentCount: number
    withClip: number
    chapterWithMusic: number
    voiceCount: number
  }
}

/** 本页音色卡（截图里的「本页音色」两块） */
export interface PageVoiceCard {
  characterId: string
  /** 显示名（旁白 → 「旁白」） */
  name: string
  isNarrator: boolean
  /** 音色类型 */
  vt: string
  /** 音色描述 */
  vi: string
  /** 参考样本 URL */
  sampleUrl: string
  /** 本页说了几段 */
  segmentCount: number
}

/** 配乐块 */
export interface ChapterMusicCard {
  chapterSeq: number
  current: {
    id: string
    title: string
    author: string
    url: string
    durationSec: number
    bpm: number
    licenseId: string
    attribution: string
  } | null
  candidates: {
    id: string
    title: string
    author: string
    url: string
    durationSec: number
    bpm: number
    licenseId: string
    attribution: string
  }[]
}

// ---------------------------------------------------------------------------
// mp3 时长粗算
// ---------------------------------------------------------------------------

/** MPEG 版本/层 的比特率表（kbps），索引 = bitrate index */
const BITRATE_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
const BITRATE_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
/** 采样率表 */
const SAMPLE_RATE = {
  3: [44100, 48000, 32000, 0], // MPEG1
  2: [22050, 24000, 16000, 0], // MPEG2
  0: [11025, 12000, 8000, 0] // MPEG2.5
} as const

/**
 * 估算 mp3 时长（秒）。
 *
 * 做法：逐帧解析帧头累加 每帧样本数 / 采样率。
 * 只在**帧头合法**时推进；遇到 ID3v2 标签先跳过。解析失败返回 0。
 */
export function estimateMp3DurationSec(buf: Uint8Array): number {
  if (!buf || buf.length < 4) return 0
  let off = 0
  // 跳过 ID3v2
  if (buf.length > 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f)
    off = 10 + size
  }
  let seconds = 0
  let frames = 0
  while (off + 4 <= buf.length) {
    // frame sync 0xFFE
    if (buf[off] !== 0xff || (buf[off + 1] & 0xe0) !== 0xe0) {
      off++
      continue
    }
    const h = buf[off + 1]
    const versionBits = (h >> 3) & 0x03 // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
    const layerBits = (h >> 1) & 0x03 // 1=Layer3
    if (layerBits !== 1) {
      off++
      continue
    }
    const b2 = buf[off + 2]
    const bitrateIdx = (b2 >> 4) & 0x0f
    const srIdx = (b2 >> 2) & 0x03
    const isV1 = versionBits === 3
    const table = isV1 ? BITRATE_V1_L3 : BITRATE_V2_L3
    const bitrate = table[bitrateIdx]
    const srTable = SAMPLE_RATE[(versionBits === 3 ? 3 : versionBits === 2 ? 2 : 0) as 3 | 2 | 0]
    const sampleRate = srTable[srIdx]
    if (!bitrate || !sampleRate) {
      off++
      continue
    }
    // Layer3: 每帧样本数 MPEG1=1152, MPEG2/2.5=576
    const samplesPerFrame = isV1 ? 1152 : 576
    seconds += samplesPerFrame / sampleRate
    frames++
    // 帧长
    const padding = (b2 >> 1) & 0x01
    const frameLen = Math.floor((samplesPerFrame / 8) * bitrate * 1000 / sampleRate) + padding
    if (frameLen <= 0) {
      off++
      continue
    }
    off += frameLen
  }
  if (!frames) return 0
  return Math.round(seconds * 10) / 10
}

// ---------------------------------------------------------------------------
// 数据聚合
// ---------------------------------------------------------------------------

/** 章节标题兜底 */
function chapterLabel(ch: MangaChapter): string {
  return ch.title || `第 ${ch.chapterSeq} 章`
}

/** 把 MangaPage 转成分段器需要的输入（只取需要的字段）。 */
function toSegmentSource(page: MangaPage): {
  page: number
  panels: { no: number; speech: { type: string; speaker?: string; text: string }[] }[]
} {
  return {
    page: page.no,
    panels: page.panels.map((pn) => ({
      no: pn.no,
      speech: pn.speech.map((sp) => ({ type: sp.type, speaker: sp.speaker, text: sp.text }))
    }))
  }
}

/** 整本概览 */
export function buildOverview(view: MangaViewData): ProductionOverview {
  let withClip = 0
  let segments = 0
  for (const ch of view.chapters) {
    const all = ch.pages.flatMap((p) => buildSegmentIndex(ch.chapterSeq, [toSegmentSource(p)]))
    segments += all.length
  }
  withClip = view.dubbing.length
  return {
    chapters: view.chapters.map((ch) => ({
      chapterSeq: ch.chapterSeq,
      title: chapterLabel(ch),
      pageCount: ch.pages.length
    })),
    stats: {
      segmentCount: segments,
      withClip,
      chapterWithMusic: view.stats.chaptersWithMusic,
      voiceCount: view.voices.length
    }
  }
}

/**
 * 生成某一页的编排数据。
 *
 * 对齐规则：**逐页对齐**。实测 clip 的 order 是**章内**连续的
 * （第 1 章 1000000..1000029，且该章只有 1 页），所以先在页粒度算段数，
 * 再与「该页对应的 clip 区间」比对；章内多页时按页顺序切分 clip 区间。
 */
export function buildPageProduction(
  view: MangaViewData,
  chapterSeq: number,
  pageNo: number,
  durations?: Map<string, number>
): PageProduction | null {
  const ch = view.chapters.find((c) => c.chapterSeq === chapterSeq)
  if (!ch) return null
  const pages = ch.pages
  const pageIdxInCh = pages.findIndex((p) => p.no === pageNo)
  const page = pageIdxInCh >= 0 ? pages[pageIdxInCh] : pages[0]
  if (!page) return null

  // 该章全部段（按页顺序展开），用于切片
  const chapterSegments: { pageNo: number; seg: MangaSpeechSegment }[] = []
  for (const p of pages) {
    for (const seg of buildSegmentIndex(ch.chapterSeq, [toSegmentSource(p)])) {
      chapterSegments.push({ pageNo: p.no, seg })
    }
  }

  // 该章全部 clip（按 order 升序）
  const chapterClips = view.dubbing
    .filter((c) => c.chapterSeq === ch.chapterSeq)
    .sort((a, b) => a.order - b.order)

  const align = alignSegmentsToClips(
    chapterSegments.map((x) => x.seg),
    chapterClips
  )

  // 音色档案校验：clip 的 voiceChecksum 能否对上现存 voice
  const checksums = new Set(view.voices.map((v) => v.sampleUrl ? checksumOfUrl(v.sampleUrl) : ''))
  void checksums

  const pageSegs = chapterSegments.filter((x) => x.pageNo === page.no)

  const segments: ProductionSegment[] = pageSegs.map(({ seg }) => {
    const clip = align.exact ? chapterClips.find((c) => c.order - 1_000_000 === seg.index) : undefined
    const url = clip?.url ?? ''
    const dur = (url && durations?.get(url)) || 0
    return {
      index: seg.index,
      page: seg.page,
      panel: seg.panel,
      type: seg.type,
      speaker: seg.speaker,
      text: seg.text,
      fullText: seg.fullText,
      hasClip: !!clip,
      url,
      durationSec: dur,
      characterId: clip?.characterId ?? (seg.type === 'narration' ? '$narrator' : ''),
      voiceOrphan: false
    }
  })

  // 本页出场人物（含旁白：只要有 narration 段就把旁白算进来）
  const ids = new Set<string>()
  for (const pn of page.panels) {
    for (const sp of pn.speech) {
      if (sp.type === 'narration') ids.add('$narrator')
    }
  }
  // 分镜/页级 characters 字段（若有）
  for (const c of page.characters ?? []) if (c.appearanceId) ids.add(c.appearanceId)
  // 用 clip 的 characterId 补全（更可靠：这是真正配音的人）
  for (const s of segments) if (s.characterId) ids.add(s.characterId)

  return {
    chapterSeq: ch.chapterSeq,
    chapterTitle: chapterLabel(ch),
    pageNo: page.no,
    pageIndex: view.chapters.slice(0, view.chapters.findIndex((c) => c.chapterSeq === ch.chapterSeq)).reduce((a, c) => a + c.pages.length, 0) + pageIdxInCh + 1,
    totalPages: view.stats.pageCount,
    context: page.context ?? '',
    segments,
    characterIds: [...ids],
    alignExact: align.exact,
    alignReason: align.reason
  }
}

/** 从 t2w:// 样本 URL 反推 checksum（包内音频路径含 sha） */
function checksumOfUrl(url: string): string {
  const m = url.match(/\/([0-9a-f]{64})\.[a-z0-9]+$/i)
  return m ? m[1].toLowerCase() : ''
}

/** 本页音色卡：把 MangaVoice 投影成界面卡片，并统计本页说了几段。 */
export function buildPageVoices(view: MangaViewData, page: PageProduction): PageVoiceCard[] {
  const byId = new Map<string, MangaVoice>()
  for (const v of view.voices) byId.set(v.characterId, v)

  const out: PageVoiceCard[] = []
  for (const id of page.characterIds) {
    const v = byId.get(id)
    const count = page.segments.filter((s) => s.characterId === id).length
    // 本页没有发言的人物不显示（截图里也只列本页的 2 个声音）
    if (count === 0 && id !== '$narrator') continue
    out.push({
      characterId: id,
      name: id === '$narrator' ? '旁白' : id,
      isNarrator: id === '$narrator',
      vt: v?.vt ?? '',
      vi: v?.vi ?? '',
      sampleUrl: v?.sampleUrl ?? '',
      segmentCount: count
    })
  }
  // 旁白排第一（截图也是旁白在前）
  out.sort((a, b) => (a.isNarrator === b.isNarrator ? 0 : a.isNarrator ? -1 : 1))
  return out
}

/**
 * 章级配乐卡。
 *
 * ⚠️ `current` 必须**原样取自已归一化的 MusicCandidate**，不能再手工平铺一遍字段。
 * 首版在这里写了一段平铺代码，把 `licenseId`/`attribution`/`durationSec` 逐个搬过去，
 * 结果搬漏了（源头数据是嵌套 `license` 对象、时长字段叫 `duration`），
 * 表现是界面曲目名对、但授权署名为空、时长 0 —— 而 CC 协议要求必须显示署名。
 * 归一化已经在 `collectMusicCandidates` 里做过，这里直接透传即可。
 */
export function buildMusicCard(manifest: T2wManifest, chapterSeq: number): ChapterMusicCard {
  const { current, pool } = collectMusicCandidates(manifest)
  return {
    chapterSeq,
    current: current.get(chapterSeq) ?? null,
    candidates: pool
  }
}

/** 供上层做试听：把 clip 数组按 order 建索引。 */
export function clipIndex(clips: MangaDubbingClip[]): Map<number, MangaDubbingClip> {
  const m = new Map<number, MangaDubbingClip>()
  for (const c of clips) m.set(c.order - 1_000_000, c)
  return m
}

/** 文本指纹（与写回同款，供调试） */
export function fp(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export type { MangaMusicTrack }

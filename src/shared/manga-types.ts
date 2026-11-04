/**
 * 漫画线数据结构（t2w `mangaScript` 系列任务产出的投影模型）。
 *
 * 设计原则：只描述**渲染所需**的字段，不复制包内 schema。所有字段一律可选，
 * 因为实测不同包的产出完整度不同（gmzz-10 只有 1 chunk / 10 章 / 11 页）。
 *
 * 数据来源与关键坑（gmzz-10.t2w 实证）：
 *   1) `results: "mangaScript:0"` 是**按 chunk** 产出的，多 chunk 包有 N 条，
 *      另有 `:batch:<n>` 变体（gmzz-10 有 batch:0/batch:1，分别是第 1—7 章、第 8—10 章）。
 *      → 取主条目 + 排除 `:batch:`，与 storyScript 同一套 variant 规则。
 *   2) **真正的显示来源是 `records.reader` 的 `project-edits`**（v2）：
 *      其 `results["mangaScript:0"]` 里 panels 多了 `speech[]`（用户/程序编辑后的台词），
 *      而 `results.mangaScript:0` 是**未编辑的原始产出，没有 speech**。
 *      优先级：project-edits > results 原条目。
 *   3) 分镜热区在 `records.reader: "manga-performance:manga-<ch>-<page>"`，
 *      `frames[].rect` 是 **0..1 归一化**坐标（相对整页图），与 panels[] 按 no 一一对应。
 *      实测 11 页 frames 合计 66 个 == panels 合计 66 个（gmzz-10）。
 *   4) 页面图在 `records.reader: "manga-images"` → `{ "manga-<ch>-<page>": { imagePath, scriptHash, colorMode } }`，
 *      key 的 `<ch>-<page>` 与 mangaScript 的 chapters[].pages[] **顺序**对应（不是 chapterSeq）。
 *   5) 配音：`records.reader: "manga:dubbing:clip:<chapterSeq>:<order>"`，
 *      order 是 **1000000 起步**的漫画专用序号（与正片 `:dubbing:clip:` 的 order 空间不同）。
 *      音色档案：`manga:dubbing:voice:<characterId>`，旁白用 `$narrator`。
 *   6) 特效与配乐是**章级**的：
 *      `results: "mangaEffects:chapter:<ch>:<scriptHash>:<hash>"` → `{effects:[{chapterSeq,page,panel,effects:[{id,color?,opacity?}]}]}`
 *      `results: "mangaMusic:chapter:..."` / `"mangaMusic:music:..."` → brief / tracks / selection。
 *      ⚠️ 漫画特效 id（e02/e13/a18/e14…）与正片 `effect-catalog.json` 的 id（portrait-cutin/rain…）
 *      是**两套不同命名空间**，不能混用目录查询。
 */

/** 漫画分镜里的一句台词/旁白 */
export interface MangaSpeech {
  /** narration | say | think（实测仅这三种） */
  type: string
  /** 说话人显示名；narration 缺省 */
  speaker?: string
  text: string
}

/** 一个分镜（panel） */
export interface MangaPanel {
  /** 分镜序号，页内从 1 起 */
  no: number
  /** 原文行区间 [[start,end],...]（正文行号，用于溯源） */
  lines: number[][]
  /** 分镜画面描述（生图提示词性质） */
  content: string
  /** 场景描述；实测常为空串 */
  scene: string
  /** 台词（来自 project-edits；原条目无此字段 → 空数组） */
  speech: MangaSpeech[]
  /**
   * 分镜热区（0..1 归一化，相对整页图）。
   * 来自 manga-performance：frames[] 与 panels[] 按 no 对应。
   * 缺失时视图按顺序均分估算。
   */
  rect: MangaRect | null
  /** 本分镜挂的漫画特效 id（章级 mangaEffects 按 page+panel 索引） */
  effectIds: string[]
}

/** 归一化矩形（0..1，相对整页图） */
export interface MangaRect {
  x: number
  y: number
  width: number
  height: number
}

/** 一页漫画 */
export interface MangaPage {
  /** 页序号，章内从 1 起 */
  no: number
  /** `manga-<ch>-<page>` 键（与 manga-production 的 page 字段对齐） */
  key: string
  /** 包内 PNG entryPath */
  imagePath: string | null
  /** 常驻 URL */
  imageUrl: string | null
  /** monochrome | color */
  colorMode: string
  /** 页面上下文（人物/环境总述） */
  context: string
  /** 本页出场角色 [{name, appearanceId}] */
  characters: { name: string; appearanceId: string }[]
  panels: MangaPanel[]
  /** 本页是否有可用图（无图时视图给空状态） */
  hasImage: boolean
}

/** 一章漫画 */
export interface MangaChapter {
  chapterSeq: number
  /** 章节标题（取自 records.chapters；缺失时 `第 N 章`） */
  title: string
  pages: MangaPage[]
  /** 本章特效条数（统计用） */
  effectCount: number
  /** 本章配乐（取章级 selection.track） */
  music: MangaMusicTrack | null
}

/** 配乐曲目（mangaMusic selection.track 的窄化投影） */
export interface MangaMusicTrack {
  id: string
  title: string
  author: string
  /** 在线 URL（包内通常不落音频，只有元数据） */
  url: string
  bpm: number
  durationSec: number
  /** 授权标识，如 CC-BY-3.0 */
  licenseId: string
  /** 完整署名文本（展示用） */
  attribution: string
}

/** 一章的配乐需求（brief） */
export interface MangaMusicBrief {
  purpose: string
  mood: string[]
  style: string[]
  /** 1..5 */
  energy: number
  pace: string
  avoid: string[]
}

/** 漫画配音片段（独立于正片 DubbingClip） */
export interface MangaDubbingClip {
  /** `${actionType}|${chapterSeq}|${order}` */
  key: string
  actionType: string
  chapterSeq: number
  order: number
  characterId: string
  path: string
  url: string
  fingerprint: string
  voiceChecksum: string
}

/** 漫画专用音色（旁白 + 角色） */
export interface MangaVoice {
  characterId: string
  /** 音色类型（young_male/girl/mature_male/... 或 androgynous） */
  vt: string
  /** 音色描述 */
  vi: string
  samplePath: string
  sampleUrl: string
  /** 是否是旁白（characterId === '$narrator'） */
  isNarrator: boolean
}

/** 漫画配音设置（reader `manga:dubbing:settings`） */
export interface MangaDubbingSettings {
  /** 产出的台词类型（narration/say/think） */
  kinds: string[]
  /** 旁白音色说明 */
  narrator: string
  playbackRate: number
}

/** 整本漫画视图模型 */
export interface MangaViewData {
  chapters: MangaChapter[]
  dubbing: MangaDubbingClip[]
  voices: MangaVoice[]
  dubbingSettings: MangaDubbingSettings | null
  stats: {
    chapterCount: number
    pageCount: number
    panelCount: number
    speechCount: number
    /** 有图的页数 */
    pagesWithImage: number
    effectCount: number
    /** 有几章拿到了配乐 */
    chaptersWithMusic: number
    dubbingClipCount: number
    voiceCount: number
    /** 数据来源：edited = 用了 project-edits；raw = 用了 results 原条目 */
    scriptSource: 'edited' | 'raw' | 'none'
    /** 原条目是否被 project-edits 覆盖 */
    editsApplied: boolean
  }
}

export interface MangaViewResult {
  ok: boolean
  error?: string
  data?: MangaViewData
}

/** 主进程 ↔ 渲染进程共享的应用层类型 */

import type { EffectMount, EffectRange } from './effects-types'
import type { LlmProvider, TtsProvider } from './pipeline-types'

/**
 * 本地 ComfyUI 生图设置（加性字段；旧 settings.json 缺失时由
 * `settings/store.ts` 整体补默认，见 `shared/imagegen-defaults.ts`）。
 */
export interface ComfyuiSettings {
  /** ComfyUI HTTP 服务地址（默认 http://127.0.0.1:8188） */
  baseUrl: string
  /** 出图模型名（空 = 用工作流 JSON 里写死的；非空时替换工作流里的 {{model}}） */
  model: string
  /** 出图宽高（整值占位 {{width}}/{{height}}） */
  width: number
  height: number
  /** 采样步数 / CFG（Qwen-Image 建议 cfg 低，默认 4） */
  steps: number
  cfg: number
  /** 负面提示词（工作流里的 {{negative}}） */
  negativePrompt: string
  /** 人物立绘正面提示词模板（{{name}} {{aliases}} {{sex}} {{appearanceSummary}} {{visualKeywords}} {{worldImpression}} {{novelGenre}}） */
  charPromptTemplate: string
  /** 地图图标正面提示词模板（{{locationType}} {{iconStyle}} {{novelGenre}}） */
  iconPromptTemplate: string
  /** ComfyUI API 格式工作流 JSON 字符串（含 {{prompt}}/{{negative}} 占位） */
  workflowJson: string
}

export interface ChapterInfo {
  seq: number
  title: string
  byteStart: number
  byteEnd: number
}

export interface FileInfo {
  path: string
  size: number
  /** 由扩展名推断的成员类型标签（非格式字段） */
  kind: string
}

export interface EntityCounts {
  characters: number
  factions: number
  items: number
  creatures: number
}

/** canonical.objects 各类别的名称列表（仅取 name，便于列表展示） */
export interface EntityNames {
  characters: string[]
  factions: string[]
  items: string[]
  creatures: string[]
}

export interface ImportSummary {
  filePath: string
  totalSize: number
  jsonLen: number
  blobStart: number
  project: {
    id: string
    title: string
    revisionId: string
    chapterCount: number
    charCount: number
    status: string
    encoding: string
    updatedAt: string
    parseMode: string
    storyScriptStyle: string
  }
  chapters: ChapterInfo[]
  entities: EntityCounts
  entityNames: EntityNames
  files: FileInfo[]
  verify: { total: number; passed: number; failed: number }
  guards: { sumSizeMatches: boolean; noTrailingBytes: boolean }
}

export interface ImportResult {
  ok: boolean
  canceled?: boolean
  error?: string
  summary?: ImportSummary
}

/**
 * 阅读原文的一段（`source:read` 返回）。
 *
 * 按章切好，**渲染层不做字节→字符换算**。`byteStart` 是唯一键（seq 可能为 null，
 * 表示「正文之外」的卷首/卷末段）。
 */
export interface ReadingSegment {
  /** 原书章节号；卷首/卷末这类正文之外的段为 null */
  seq: number | null
  title: string
  /** 本段起始字节（闭区间下界，已按前段 byteEnd 钳制） */
  byteStart: number
  /** 本段结束字节（开区间上界，= 下一段的 byteStart） */
  byteEnd: number
  text: string
}

/** `source:read` 的结果：切好的段落 + 章节导航 + 被跳过的章（区间为空） */
export interface SourceReadResult {
  ok: boolean
  error?: string
  segments?: ReadingSegment[]
  chapters?: ChapterInfo[]
  /** 钳制后区间为空、已跳过不渲染的章标题 */
  skippedChapters?: string[]
}

/**
 * 模型接入 + 演出/音频设置。
 *
 * 硬约束：模型接入只暴露「任意 OpenAI 兼容」三个字段，不绑定任何供应商；
 * 其余字段全部是**本地演出参数**，不涉及任何云端状态同步。
 */
export interface ModelSettings {
  baseURL: string
  apiKey: string
  model: string
  // —— TTS（兜底音源；默认不启用，见 autoplayPolicy）——
  /** 音色描述 / 音色 id，透传给 OpenAI 兼容 /audio/speech 的 voice 字段 */
  ttsVoice: string
  voiceVolume: number
  // —— 音频 ——
  /** 用户自选 BGM 的本地路径（空 = 无） */
  bgmPath: string
  bgmVolume: number
  // —— 演出 ——
  /** 舞台缩放 0.7 ~ 1.6，步进 0.05 */
  stageZoom: number
  dialogMode: 'normal' | 'transparent'
  /** 自动播放的节奏来源：包内配音 → TTS → 定时器 */
  autoplayPolicy: 'dubbing' | 'tts' | 'timer'
  /**
   * 按角色分级的名牌颜色。键为 canonical.importanceLevel 原值
   * （实测存在 CORE/HIGH/MEDIUM/LOW/TEMP，**不写死枚举**，未预见的级别走兜底色）。
   */
  roleColors: Record<string, string>

  // —— 多配置（N-4~N-8；旧单组 baseURL/apiKey/model 保留只读兼容并自动迁移）——
  /** 多组 LLM 配置 */
  llm: LlmProvider[]
  /** 多组 TTS 配置 */
  tts: TtsProvider[]
  /** 本题使用的 LLM 配置 id */
  activeLlmId: string
  /** 本题使用的 TTS 配置 id */
  activeTtsId: string
  /** 失败时按序换 LLM（空 = 仅在 llm[] 内轮询启用项） */
  fallbackChain: string[]

  /** 本地 ComfyUI 生图（加性；旧配置缺失时读取侧补默认） */
  comfyui: ComfyuiSettings
}

/** 名牌配色的兜底值（设置里被清空时使用） */
export const DEFAULT_ROLE_COLORS: Record<string, string> = {
  CORE: '#ffd76a',
  HIGH: '#8fd0ff',
  MEDIUM: '#9df5c0',
  LOW: '#c8c8d6',
  TEMP: '#d9a6ff'
}
/** 未预见分级的名牌兜底色 */
export const FALLBACK_ROLE_COLOR = '#e6e6f0'

/** TTS 合成结果（src/main/tts 与渲染进程共用，故放在 shared） */
export interface SpeakResult {
  ok: boolean
  /** cache://tts/<key>.<ext>，失败时为 undefined */
  url?: string
  /** true 表示命中磁盘缓存，没有发起请求 */
  cached?: boolean
  bytes?: number
  error?: string
}

// ---------------------------------------------------------------------------
// 地图互动 / 视觉互动 所需的渲染模型（由主进程从包内 records 整理后下发）
// ---------------------------------------------------------------------------

/** locationTree.data.locations[] 的一个节点 */
export interface MapLocation {
  id: string
  name: string
  locationType: string
  identInfos: string[]
  parentLocationId: string | null
  showOnImpressionMap: boolean
}

/** locationTree.data.tree 的嵌套节点 */
export interface MapTreeNode extends MapLocation {
  children: MapTreeNode[]
  /** 挂在该地图节点上的场景 id（来自 plotLocations[].mapLocationId → id） */
  sceneIds: string[]
  /**
   * 地点类型图标的包内 entryPath（reader `:location-icons` 按 locationType 查表；
   * 加性字段，无图标时为 null —— StageView 不消费，MapView 优先渲染图标、无图标退回色点。
   */
  iconPath?: string | null
  /** 常驻 URL（assetBase + iconPath）；无图标时为 null */
  iconUrl?: string | null
}

/** storyScript.data.plotLocations[] 的一个场景 */
export interface SceneInfo {
  /** 场景 id，形如 S-deck 或 L-0-l1（随包不同，勿按前缀判断） */
  id: string
  name: string
  /** 对应地图节点 M-5；可能为 null */
  mapLocationId: string | null
  mapLocationName: string | null
  mapLocationType: string | null
  identInfos: string[]
  summary: string
  sceneDescription: string
  /** 包内 entryPath */
  imagePath: string | null
  /** 常驻 URL（assetBase + imagePath） */
  imageUrl: string | null
  /** 该场景在剧本中出现多少次 */
  actionCount: number
  chunkIndex: number
}

/** reader:character-images 的一个角色 */
export interface CharacterVisual {
  id: string
  name: string
  imagePath: string | null
  imageUrl: string | null
  /** 该角色在剧本中开口次数 */
  actionCount: number
  /**
   * canonical.importanceLevel 原值（CORE/HIGH/MEDIUM/LOW/TEMP…，按包取值）。
   * 缺失时为空串，由视图走兜底色。
   */
  importanceLevel: string
  /** canonical.aliases（别名，可能为空数组） */
  aliases: string[]
  /** 该角色的全部立绘形象（默认形象在前，按 appearanceId 去重） */
  portraits: CharacterPortrait[]
}

/** 一个角色的一个立绘形象（character-images × characterAppearance 合并结果） */
export interface CharacterPortrait {
  appearanceId: string
  /** 形象名，如「日常形象」「婚宴礼服」；缺失时退回 appearanceId */
  name: string
  sex: string
  appearanceSummary: string
  visualKeywords: string[]
  /** 包内 entryPath */
  imagePath: string | null
  /** 常驻 URL（assetBase + imagePath） */
  imageUrl: string | null
}

/**
 * 包内配音片段：reader `:dubbing:clip:<chapterSeq>:<order>`。
 * path 指向包内 mp3 成员，经 t2w:// 常驻访问，**不落盘**。
 */
export interface DubbingClip {
  /** `${actionType}|${chapterSeq}|${order}` —— 与动作表对齐用的复合键 */
  key: string
  actionType: string
  chapterSeq: number
  order: number
  characterId: string
  /** 包内 mp3 entryPath */
  path: string
  /** 常驻 URL（assetBase + path） */
  url: string
  /** 文本指纹（同文本复用同一片段的依据） */
  fingerprint: string
  /** 音色参考样本的 checksum */
  voiceChecksum: string
}

/** 音色档案：reader `:dubbing:voice:<characterId>` */
export interface DubbingVoice {
  characterId: string
  /** 音色描述（vi 字段） */
  description: string
  /** 音色参考样本 mp3 entryPath */
  samplePath: string
  sampleUrl: string
}

/** storyScript.data.actions[] 的一条 */
export interface StageAction {
  chapterSeq: number
  order: number
  /** narration | say | think | ... */
  type: string
  characterId: string
  locationId: string
  fromLocationId: string | null
  toLocationId: string | null
  targetIds: string[]
  text: string
  /** P4：本句已挂特效（无特效时缺省/空数组）——持久化于 actions[i].effects */
  effects?: EffectMount[]
}

/** 按 chapterSeq 切好的动作区间（start 含、end 不含） */
export interface ChapterSpan {
  chapterSeq: number
  title: string
  start: number
  end: number
  count: number
  /** 本章出现过的场景 id，按首次出现顺序 */
  sceneIds: string[]
}

/**
 * 印象图谱：impressionLayout.data.layout 的结构。
 * 注意 `layouts` 不是顶层键 —— 完整路径是 `impressionLayout.data.layout.layouts`。
 * gridSize=100 表示 rect 的 x/y/width/height 都是**父容器内的百分比**。
 */
export interface ImpressionPlacement {
  id: string
  rect: { x: number; y: number; width: number; height: number }
}
export interface ImpressionLayoutGroup {
  parentId: string
  /** separated | partition */
  mode: string
  placements: ImpressionPlacement[]
}
export interface ImpressionData {
  gridSize: number
  layouts: ImpressionLayoutGroup[]
  /** 作为 parentId 出现但自身从未被摆放的根（通常是 novel-world） */
  rootParentId: string
}

/**
 * 产物来源（T7-A；只增不改——`StageView.vue` 消费同一类型，故一律可选字段）。
 *
 * 判定依据是条目 value **顶层**的 `source`（`persistence.writeResult` 写入时打的本机标记）：
 *   - `runtime`：本机运行写出的产物；
 *   - `inherited`：有该产物但没有 runtime 标记（= 来源包自带的包内历史产物）；
 *   - `unknown`：根本没有该产物。
 */
export type ResultSource = 'runtime' | 'inherited' | 'unknown'

export interface ViewData {
  assetBase: string
  protocol: string
  mapRoot: MapTreeNode
  mapNodes: MapLocation[]
  scenes: SceneInfo[]
  /** mapLocationId -> sceneIds */
  scenesByNode: Record<string, string[]>
  characters: CharacterVisual[]
  actions: StageAction[]
  chapters: ChapterSpan[]
  artStyles: { character: string; scene: string }
  impression: ImpressionData | null
  /** 包内配音片段（无配音的包为空数组，不是 null） */
  dubbing: DubbingClip[]
  /** 音色档案（克隆音色的参考样本与描述） */
  dubbingVoices: DubbingVoice[]
  /** P4：范围特效（已跨副本去重）——持久化于 data.effectRanges */
  effectRanges: EffectRange[]
  stats: {
    /** 合并了几个 chunk 级 :storyScript:<n> */
    storyScriptChunks: number
    /** plotLocationMerge.idMap 的条数（合并前 id → 合并后 id） */
    sceneIdMappings: number
    scenesWithImage: number
    mapNodeCount: number
    mapNodeCountWithScenes: number
    sceneCount: number
    characterCount: number
    actionCount: number
    actionTypes: Record<string, number>
    distinctActionLocations: number
    distinctActionCharacters: number
    /** type=move 的条数 */
    moveCount: number
    /** move 中「只有起点、没有终点」的条数（必须优雅降级） */
    moveWithoutTarget: number
    /** type=battle 的条数 */
    battleCount: number
    /** battle 中 targetIds 非空的条数 */
    battleWithTargets: number
    /** 印象图谱的矩形总数（placements 之和） */
    impressionPlacementCount: number
    /** 印象图谱的层数（layouts 长度） */
    impressionLevelCount: number
    /** 包内配音片段条数（:dubbing:clip:*） */
    dubbingClipCount: number
    /** 音色档案条数（:dubbing:voice:*） */
    dubbingVoiceCount: number
    /** 全库立绘形象总数（Σ 每角色 portraits） */
    portraitCount: number
    /**
     * 地图数据（locationTree 主条目）的来源（T7-A 新增，可选——老数据/无产物时缺省）。
     * 三态见 `ResultSource`；地图页据此提示「本机运行产物」还是「来源包自带」。
     */
    locationTreeSource?: ResultSource
  }
}

export interface ViewResult {
  ok: boolean
  error?: string
  data?: ViewData
}


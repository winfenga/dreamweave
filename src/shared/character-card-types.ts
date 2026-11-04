/**
 * 角色卡 + 内置酒馆（SillyTavern 兼容）数据结构。
 *
 * 【为什么单独一份类型】角色卡不是「视图数据的一个字段」，它同时承载三个去向：
 *   1) 软件内的角色卡页面（canonical 档案 + 立绘 + 音色 + 关系网）；
 *   2) 导出给 SillyTavern 的 V2/V3 卡片（PNG tEXt `chara` / `ccv3`，或独立 JSON）；
 *   3) 内置酒馆的对话人格来源（description/personality/scenario/first_mes…）。
 * 所以它必须是**自足**的结构，不能依赖 ViewData（那个是舞台/地图用的投影）。
 *
 * 【数据来源（monte-cristo 实测）】
 *   - `results:":canonical"` → objects.characters[]：20 人，每人有
 *     id/name/importanceLevel/aliases/identInfos/summary/lifeStatus/
 *     appearanceChapterSeqs/characterAppearances[]；
 *   - `results:":characterRelation:n"` → characterRelations[]：A/B/关系描述/章节区间；
 *   - `results:":characterAppearance"` → 形象元数据（sex/appearanceSummary/visualKeywords）；
 *   - `reader:":character-images"` → 立绘 entryPath；
 *   - `reader:":dubbing:voice:<charId>"` → 音色描述 + 参考样本；
 *   - `results:":worldImpression"` → novelGenre / worldImpression（写卡片 scenario 用）。
 */

/** SillyTavern 卡片规格版本 */
export type CardSpec = 'chara_card_v2' | 'chara_card_v3'

/** 一个角色形象（立绘维度） */
export interface CardPortrait {
  appearanceId: string
  /** 形象名，如「日常形象」「婚宴礼服」 */
  name: string
  sex: string
  appearanceSummary: string
  visualKeywords: string[]
  /** 包内 entryPath */
  imagePath: string | null
  /** 常驻 URL（dwe://…） */
  imageUrl: string | null
  /** 是否是默认形象（角色卡首图） */
  isDefault: boolean
}

/** 音色档案（TTS / 克隆音色维度） */
export interface CardVoice {
  /** 音色类型（young_male/girl/androgynous…） */
  voiceType: string
  /** 音色描述（vt 之外的 vi 字段，可直接作为 TTS 的 voice 提示） */
  description: string
  /** 包内参考样本 entryPath（无样本时为空串） */
  samplePath: string
  sampleUrl: string
}

/** 关系条目（从该角色视角看另一人） */
export interface CardRelation {
  /** 对方角色名（canonical 名字） */
  otherName: string
  /** 对方角色 id（能对上时非空，否则为空串） */
  otherCharacterId: string
  /** 关系概述，如「相爱并订婚」 */
  overview: string
  /** 关系详述 */
  summary: string
  /** 出现章区间（1 起，含两端） */
  fromChapter: number
  toChapter: number
}

/** 世界观条目（世界书 / lorebook 的一条） */
export interface LorebookEntry {
  /** 稳定 id（导出用） */
  id: string
  /** 条目名（世界书里显示的标题） */
  name: string
  /** 触发关键词（SillyTavern 的 keys） */
  keys: string[]
  /** 正文 */
  content: string
  /** 是否常驻（不靠关键词，永远注入） */
  constant: boolean
  /** 注入顺序（小的先） */
  insertionOrder: number
  /** 来源：canonical 人物 / 关系 / 世界观设定，用于界面分组 */
  source: 'character' | 'relation' | 'world' | 'custom'
}

/**
 * 完整角色卡（软件内 + 导出共用）。
 *
 * V2 字段命名直接沿用 SillyTavern 的 `data.*`，避免导出时再翻译一次
 * （翻译过程最容易丢字段，也最容易出现「软件里看着对、导进酒馆就变样」）。
 */
export interface CharacterCard {
  /** 稳定 id（= canonical characterId） */
  id: string
  // ---- 软件内展示用 ----
  /** canonical 名字 */
  name: string
  aliases: string[]
  /** canonical.importanceLevel 原值（CORE/HIGH/MEDIUM/LOW/TEMP…，不写死枚举） */
  importanceLevel: string
  /** 身份信息，如 [「法老号大副」「老唐太斯之子」] */
  identInfos: string[]
  /** 人物档案正文（canonical.summary） */
  profile: string
  /** 生存状态（存活 / 死亡 / 未知…，原值透传） */
  lifeStatus: string
  /** 出场章序号（1 起） */
  appearanceChapters: number[]
  /** 立绘（默认形象在前） */
  portraits: CardPortrait[]
  /** 音色（无音色档案时为 null） */
  voice: CardVoice | null
  /** 从该角色视角的关系列表 */
  relations: CardRelation[]
  /** 该角色在剧本中开口次数（排序/筛选用） */
  actionCount: number

  // ---- 导出用（SillyTavern V2 data.*）----
  /** 角色描述：把 profile + identInfos + 外貌合成一段（酒馆里最常被读的字段） */
  description: string
  /** 性格：canonical 没有独立「性格」字段，从 profile 里提取的语气/行为特征 */
  personality: string
  /** 场景：初次相遇的情境（取首个出场章 + 世界观） */
  scenario: string
  /** 开场白（酒馆进入对话时角色的第一句话） */
  firstMes: string
  /** 对话示例（空串 = 不提供） */
  mesExample: string
  /** 作者备注（给创作者看，不进上下文） */
  creatorNotes: string
  /** 系统提示覆盖（空串 = 用酒馆默认） */
  systemPrompt: string

  // ---- 导出元信息 ----
  /** 卡片创建者署名 */
  creator: string
  /** 卡片版本（导出版本号，改一次加一） */
  cardVersion: string
  /** 生成时间 ISO */
  createdAt: string
  /** 来源书库名（project title） */
  sourceTitle: string
  /** 小说题材 */
  novelGenre: string
}

/** 内置酒馆的一条对话消息 */
export interface TavernMessage {
  /** 稳定 id（前端 key 用） */
  id: string
  /** user = 玩家；assistant = 角色；system = 系统注入（世界书等，不显示或折叠） */
  role: 'user' | 'assistant' | 'system'
  /** 消息正文 */
  content: string
  /** 该条实际注入的卡片 id（assistant 用） */
  speakerId?: string
  /** 该条说话人显示名 */
  speakerName?: string
  /** 该条命中的世界书条目 id（调试可见） */
  loreHits?: string[]
  /** 时间戳 */
  at: number
}

/**
 * 酒馆的生成参数（用户明确说「复杂的是温度、惩罚这些模型参数」）。
 *
 * 这里每一项都对应 OpenAI 兼容接口的真实字段；`null` 表示**不发送**该字段
 * （不是发 0 —— 二者语义完全不同：0 是显式取值，不发才是用模型默认）。
 */
export interface TavernParams {
  /**
   * 采样温度。null = 不发送。
   * 实测：本仓 llm-client 历史上**故意不发 temperature**（抓包口径），
   * 但酒馆场景下用户需要能调，故这里单独支持，仅用于酒馆对话链路。
   */
  temperature: number | null
  /** 核采样。null = 不发送。 */
  topP: number | null
  /** top-k（部分 OpenAI 兼容端点支持） */
  topK: number | null
  /** 频率惩罚 [-2,2] */
  frequencyPenalty: number | null
  /** 存在惩罚 [-2,2] */
  presencePenalty: number | null
  /** 重复惩罚（非 OpenAI 标准字段，部分端点支持） */
  repetitionPenalty: number | null
  /** 输出上限 token */
  maxTokens: number
  /** 停止词（空数组 = 不发送） */
  stop: string[]
  /** 随机种子（null = 每次随机） */
  seed: number | null
}

/** 酒馆会话（一个角色一份，可多角色） */
export interface TavernSession {
  /** 会话 id */
  id: string
  /** 绑定的角色卡 id */
  cardId: string
  /** 消息列表（含第一条 first_mes） */
  messages: TavernMessage[]
  /** 该会话的参数覆盖（null = 用全局默认） */
  params: TavernParams | null
  /** 创建 / 最后活动时间 */
  createdAt: number
  updatedAt: number
}

/** 角色卡列表项（列表页用，不含大字段） */
export interface CharacterCardSummary {
  id: string
  name: string
  aliases: string[]
  importanceLevel: string
  identInfos: string[]
  /** 首张立绘 URL */
  avatarUrl: string | null
  /** 开口次数 */
  actionCount: number
  /** 立绘张数 */
  portraitCount: number
  /** 有无音色 */
  hasVoice: boolean
  /** 关系条数 */
  relationCount: number
}

/** 角色卡列表结果 */
export interface CharacterCardListResult {
  ok: boolean
  error?: string
  items?: CharacterCardSummary[]
  stats?: {
    cardCount: number
    withVoice: number
    withPortrait: number
    relationCount: number
  }
}

/** 单张角色卡结果 */
export interface CharacterCardResult {
  ok: boolean
  error?: string
  card?: CharacterCard
  /** 世界书条目（与卡片一起给出，酒馆直接用） */
  lorebook?: LorebookEntry[]
  /** 该卡的酒馆会话（无则 null） */
  session?: TavernSession | null
}

// —— 导出 ——

/** 导出格式：png = SillyTavern 卡片 PNG（内嵌 tEXt）；json = 独立 JSON */
export type CardExportFormat = 'png' | 'json'

export interface CardExportRequest {
  /** 要导出的卡片 id（可多选） */
  cardIds: string[]
  format: CardExportFormat
  /** png 时用哪张立绘当底图（默认第一张有图的）；json 时忽略 */
  portraitAppearanceId?: string
  /** 导出目录（不传则弹目录选择框） */
  outDir?: string
}

export interface CardExportResult {
  ok: boolean
  error?: string
  /** 实际写出的文件路径 */
  paths?: string[]
  /** 跳过的卡片及原因 */
  skipped?: { cardId: string; reason: string }[]
  /** 取消（用户关了选择框） */
  canceled?: boolean
}

// —— 酒馆 ——

/** 酒馆生成请求 */
export interface TavernGenerateRequest {
  cardId: string
  /** 现有消息（不含本次要生成的回复） */
  messages: TavernMessage[]
  params: TavernParams
  /** 是否注入世界书 */
  useLorebook: boolean
}

export interface TavernGenerateResult {
  ok: boolean
  error?: string
  /** 生成的角色回复 */
  content?: string
  /** 本次命中的世界书条目 id */
  loreHits?: string[]
  /** 实际使用的参数（回显，便于调试「为什么这么写」） */
  usedParams?: Record<string, unknown>
  /** 用量 */
  usage?: { input: number; output: number } | null
  /** 是否被内容审查拦截 */
  blocked?: boolean
}

/** 酒馆设置（全局默认参数 + 显示偏好） */
export interface TavernSettings {
  /** 默认参数 */
  params: TavernParams
  /** 是否自动注入世界书 */
  useLorebook: boolean
  /** 每次注入的世界书条目上限（防止上下文爆掉） */
  lorebookLimit: number
  /** 保留多少条历史消息进上下文（0 = 全部） */
  historyLimit: number
  /** 回复的最大条数（连续生成几条） */
  replyCount: number
}

/** 酒馆存储结果 */
export interface TavernSaveResult {
  ok: boolean
  error?: string
  session?: TavernSession
}

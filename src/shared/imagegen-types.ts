/**
 * 生图（本地 ComfyUI）—— 主进程 ↔ 渲染进程共享类型。
 *
 * 三类生成目标：人物立绘（char）/ 场景图（scene）/ 地图地点图标（icon）。
 * 回填数据通道（reader `:character-images` / `:scene-images` / `:location-icons`）
 * 的消费端在 `t2w/view.ts`，view 层自动生效。
 */

/** 生成目标类别 */
export type ImagegenKind = 'char' | 'scene' | 'icon'

// ---------------------------------------------------------------------------
// 待生成清单（imagegen:targets 返回，纯读）
// ---------------------------------------------------------------------------

/** 人物立绘目标：一个角色的一个形象 */
export interface CharTarget {
  /** 角色 id（如 D-0-C-0，随包不同） */
  charId: string
  /** 角色名（canonical 缺失时退回 charId） */
  charName: string
  /** 形象 id */
  appearanceId: string
  /** 形象名（如「日常形象」；缺失时退回 appearanceId） */
  appearanceName: string
  sex: string
  appearanceSummary: string
  visualKeywords: string[]
  /** 该形象在 `:character-images` 已有立绘 → true（默认只补缺图） */
  hasImage: boolean
  /** 已有立绘的 entryPath（无则空串） */
  imagePath: string
  /** canonical.aliases */
  aliases: string[]
}

/** 场景图目标（key 用**合并后**场景 id；写入也挂到合并后 id） */
export interface SceneTarget {
  /** 合并后场景 id（如 PL-73；无 merge 的包即原始 id） */
  sceneId: string
  name: string
  summary: string
  sceneDescription: string
  hasImage: boolean
  imagePath: string
}

/** 地点图标目标：一个 locationType 一枚图标 */
export interface IconTarget {
  locationType: string
  hasIcon: boolean
  iconPath: string
}

/** 提示词上下文（由 worldImpression 产物 + reader 画风条目汇集） */
export interface ImagegenContext {
  /** worldImpression 产物正文 */
  worldImpression: string
  /** worldImpression.novelGenre */
  novelGenre: string
  /** worldImpression.locationIconArtStyle（图标画风） */
  iconStyle: string
  /** reader `:character-art-style` 文本（可空） */
  charArtStyle: string
  /** reader `:scene-art-style` 文本（可空） */
  sceneArtStyle: string
}

/** `imagegen:targets` 结果 */
export interface ImagegenTargetsResult {
  ok: boolean
  error?: string
  targets?: {
    chars: CharTarget[]
    scenes: SceneTarget[]
    icons: IconTarget[]
    context: ImagegenContext
  }
}

// ---------------------------------------------------------------------------
// 生成请求 / 结果（imagegen:generate）
// ---------------------------------------------------------------------------

/** 单张生成请求 */
export interface ImagegenGenerateRequest {
  kind: ImagegenKind
  /**
   * 目标 id：
   *   - char → `${charId}::${appearanceId}`（两段拼接，避免 id 自身含分隔符歧义）；
   *   - scene → 合并后场景 id（SceneTarget.sceneId）；
   *   - icon → locationType。
   */
  targetId: string
  /** true = 重新生成（已有图也覆盖：写新资产 + 条目指向新 entryPath） */
  force?: boolean
}

/** 单张生成结果 */
export interface ImagegenGenerateResult {
  ok: boolean
  /** 已有图且未 force → skipped（ok=true） */
  skipped?: boolean
  /** 新写入（或已有）的 entryPath（`<pkgId>/images/<sha>.png`） */
  entryPath?: string
  /** 非致命警告（如悬空场景 id 被跳过的说明放 error；此处留给可读提示） */
  warning?: string
  error?: string
}

// ---------------------------------------------------------------------------
// 探活（imagegen:probe）
// ---------------------------------------------------------------------------

export interface ImagegenProbeResult {
  ok: boolean
  /** ComfyUI 版本 / 系统摘要（探活成功时给一段可读信息） */
  info?: string
  error?: string
}

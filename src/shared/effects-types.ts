/**
 * P4 特效系统 · 共享类型与常量（单一事实来源）。
 *
 * 约定：
 * - 7 大类（EFFECT_CATEGORIES）与 14 种已知轨道 kind（KNOWN_TRACK_KINDS）**只在此处定义一次**，
 *   目录加载、校验、选择器分组、处理器注册表都从这里取，任何文件不得再写一份字面量。
 * - 类型文件与 app-types.ts 之间是**类型级**双向引用（都用 `import type`），编译期擦除，无运行期循环。
 * - 单句特效持久化进 `actions[i].effects`（三元键定位）；范围特效持久化进记录级 `data.effectRanges[]`。
 *   目录/处理器/运行时**不硬编码任何特效 id / 角色 / 场景前缀**，一律走数据查找。
 */

import type { StageAction } from './app-types'

/** 7 大类（与目录 / PRD 附录 A 一致，不硬编码任何 id） */
export const EFFECT_CATEGORIES = [
  '镜头系统',
  '主观感知',
  '天气系统',
  '环境系统',
  '人物表现',
  '演出标记',
  '复合演出'
] as const
export type EffectCategory = (typeof EFFECT_CATEGORIES)[number]

/** 已知 14 种轨道 kind（目录 §附录 B）；新 kind 允许出现，仅告警不阻断 */
export const KNOWN_TRACK_KINDS = [
  'overlay',
  'text',
  'tone',
  'camera',
  'ambient',
  'particles',
  'actor',
  'eyelids',
  'birds',
  'blur',
  'shake',
  'distortion',
  'flash',
  'cutin'
] as const
export type TrackKind = (typeof KNOWN_TRACK_KINDS)[number]

/** 一条轨道：at / duration 单位为【秒】（与目录一致），其余参数透传给 handler */
export interface EffectTrack {
  kind: TrackKind | string
  at: number
  duration: number
  [param: string]: unknown // variant / strength / color / count / wind / text / anchor / motion …
}

/** 目录中的一项特效（= recon/schema_effect_catalog.json 的一条） */
export interface EffectCatalogEntry {
  id: string
  name: string
  category: EffectCategory | string
  duration: number
  description: string
  sound: string // 本期仅展示，不播放（Q6）
  tracks: EffectTrack[]
}

export type EffectSource = 'manual' | 'ai'

/** 单句挂载项（持久化进 actions[i].effects） */
export interface EffectMount {
  effectId: string
  source: EffectSource
}

export type RangeScope = 'scene' | 'orders'

/** 范围特效（持久化进记录级 data.effectRanges[]） */
export interface EffectRange {
  scope: RangeScope
  chapterSeq: number
  /** scope='scene' 时必填（用 actions[].locationId 判进入） */
  sceneId?: string
  /** scope='orders' 时必填（含） */
  orderStart?: number
  /** scope='orders' 时必填（含） */
  orderEnd?: number
  effectId: string
  source: EffectSource
}

// ---------------------------------------------------------------------------
// IPC 出入参
// ---------------------------------------------------------------------------

export interface EffectCatalogResult {
  ok: boolean
  entries?: EffectCatalogEntry[]
  /** 结构自检告警（P0-3），非致命 */
  warnings?: string[]
  /** 目录缺失/损坏 -> 可读错误（P0-2） */
  error?: string
}

/** 单句写入目标：**三元键定位，不含 text**（P0-8 / P0-23） */
export interface EffectsSaveTarget {
  chapterSeq: number
  order: number
  type: string
  /** 期望的完整列表（可为 []） */
  effects: EffectMount[]
}

/** 一次写回的期望状态（声明式；main 做 diff+定位，renderer 不传增量） */
export interface EffectsSavePayload {
  sentence?: EffectsSaveTarget
  /** 期望的完整范围列表（缺省=不改） */
  ranges?: EffectRange[]
}

export interface EffectsSaveResult {
  ok: boolean
  error?: string
  backupPath?: string
  /** 命中的副本动作 */
  updated?: { recordKey: string; actionIndex: number }[]
  rangesUpdated?: number
  verify?: { total: number; passed: number; failed: number }
  /** 兼容保留（分片级写回后无整包字节数，填 touchedShards 计数） */
  writtenBytes?: number
  /** 实际写盘的 storyScript 分片文件（相对工作库根；M1-T3） */
  writtenShards?: string[]
}

export interface EffectSuggestInput {
  text: string
  speaker?: string
  scene?: string
  type?: string
}

export interface EffectSuggestItem {
  effectId: string
  name?: string
  reason?: string
  confidence?: number
}

export interface EffectSuggestResult {
  ok: boolean
  error?: string
  items?: EffectSuggestItem[]
  /** 被白名单过滤掉、模型臆造的 id（P0-12） */
  dropped?: string[]
}

// ---------------------------------------------------------------------------
// 处理器契约（可扩展性的核心 API，见设计 §3.3）
// ---------------------------------------------------------------------------

export type SceneTransformPart = 'camera' | 'shake'
export type SceneFilterPart = 'blur' | 'tone'

/** camera/shake 的 transform 贡献；x/y 供震动，其余供镜头 */
export interface SceneTransform {
  scale?: number
  panX?: number
  panY?: number
  angle?: number
  x?: number
  y?: number
}

/** blur/tone 的 filter 贡献；blurPx 归 blur，其余归 tone */
export interface SceneFilter {
  blurPx?: number
  sepia?: number
  grayscale?: number
  hue?: number
  brightness?: number
  contrast?: number
  invert?: number
  saturate?: number
}

/** handler 声明贡献的通道：绝不直接写场景 DOM，由运行时统一合成 */
export interface SceneTarget {
  setTransform(part: SceneTransformPart, t: SceneTransform | null): void
  setFilter(part: SceneFilterPart, f: SceneFilter | null): void
}

export interface TrackContext {
  /**
   * 特效层容器（inset:0 / pointer-events:none）：overlay/text/flash 在此建自有节点。
   * shared 层**不引入 DOM lib**（node tsconfig 无 DOM），故仅声明 handler 所需的最小接口；
   * 渲染进程传入真实 `HTMLElement`，结构上满足本接口。
   */
  overlay: FxOverlayHost
  /** 场景层合成通道：camera/shake/blur/tone 用 */
  scene: SceneTarget
  /** 触发该特效的动作（只读，用于取说话人/场景做锚点） */
  action: StageAction | null
  /** 目录项（含 name/description/category，可供 handler 取默认参数） */
  entry: EffectCatalogEntry
}

/**
 * 特效层容器的最小接口（避免 shared 依赖 DOM lib）。
 * 渲染进程的 `HTMLElement` 因方法参数双变而结构兼容本接口。
 */
export interface FxOverlayHost {
  appendChild(node: unknown): unknown
}

export interface TrackInstance {
  /** 必须彻底清理：移除自有节点、取消 RAF/timer、把声明的场景通道置 null */
  stop(): void
}

export interface TrackHandler {
  kind: string
  /** 到 `track.at` 时被调用；返回实例，运行时在 `at+duration` 调 stop() */
  start(track: EffectTrack, ctx: TrackContext): TrackInstance | null
}

/**
 * 轨道处理器模块（`handlers/*.ts` 的默认导出形态）：
 * `import.meta.glob('./*.ts', { eager: true })` 收集后取 `default`。
 */
export interface TrackHandlerModule {
  default?: TrackHandler
}

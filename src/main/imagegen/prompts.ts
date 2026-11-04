/**
 * 提示词模板渲染（生图）。
 *
 * 模板默认值在 `shared/imagegen-defaults.ts`（设置页「恢复默认」与主进程共用一份）。
 * 渲染规则：`{{key}}` → vars[key]；缺失变量填**空串**；渲染后做轻量清理
 * （压缩 3+ 连续空行、重复标点、空括号），保证缺变量时句子依然通顺。
 */
import {
  DEFAULT_CHAR_PROMPT_TEMPLATE,
  DEFAULT_ICON_PROMPT_TEMPLATE,
  DEFAULT_SCENE_PROMPT_TEMPLATE,
  charArtStyleOf,
  sceneArtStyleOf
} from '../../shared/imagegen-defaults'
import type { ArtStylePreset } from '../../shared/imagegen-defaults'
import type { CharTarget, ImagegenContext, IconTarget, SceneTarget } from '../../shared/imagegen-types'

/** 人物模板的全部合法占位符（校验/说明用） */
export const CHAR_TEMPLATE_VARS = [
  'name',
  'aliases',
  'sex',
  'appearanceSummary',
  'visualKeywords',
  'worldImpression',
  'novelGenre',
  'artStyle'
] as const

/** 图标模板的全部合法占位符 */
export const ICON_TEMPLATE_VARS = ['locationType', 'iconStyle', 'novelGenre'] as const

/** 场景模板的全部合法占位符 */
export const SCENE_TEMPLATE_VARS = [
  'sceneName',
  'summary',
  'sceneDescription',
  'worldImpression',
  'novelGenre',
  'artStyle'
] as const

/** 模板渲染：替换 {{key}}；缺失变量填空串。 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  const out = template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_m, key: string) =>
    typeof vars[key] === 'string' ? vars[key] : ''
  )
  return cleanupPrompt(out)
}

/** 轻量清理：压缩空行、去掉空括号/引号残留、重复标点、首尾空白。 */
function cleanupPrompt(s: string): string {
  return s
    .replace(/「\s*」/g, '')
    .replace(/（\s*）/g, '')
    .replace(/()\s*。\s*。/g, '。')
    .replace(/，\s*，/g, '，')
    .replace(/。\s*，/g, '。')
    .replace(/，\s*。/g, '。')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, arr) => !(l === '' && i === arr.length - 1))
    .join('\n')
    .trim()
}

/** 别名列表 → 模板用片段（无别名 → 空串）。 */
function aliasText(aliases: string[]): string {
  const list = aliases.filter((a) => typeof a === 'string' && a.trim())
  return list.length ? `（别名：${list.join('、')}）` : ''
}

/**
 * 人物立绘模板变量（基于 characterAppearance 字段 + worldImpression 产物）。
 *
 * `artStyle`（§5 新增）的取值规则，**核心是避免重复**：
 *
 *   实测（monte-cristo 工作库）`reader :character-art-style` 的正文
 *   **就是** `visual_novel_art_style` 原文 —— 因为该包本身就是用这份提示词生成的。
 *   若把「内置基座」+「包内文本」简单拼接，画风段落会出现两遍（已验证会发生），
 *   后半段还会带上与历史题材无关的「都市题材的造型」段落。
 *
 * 所以顺序反过来：
 *   1) 包内自带 `:character-art-style` → **优先且唯一**，它已是成品画风指导；
 *   2) 包内没有 → 用设置里的画风基座（anime 默认 / realistic / custom）；
 *   3) 包内文本和基座高度重合（前 80 字相同）→ 视为同一份，只用包内的。
 */
export function buildCharPromptVars(
  target: CharTarget,
  ctx: ImagegenContext,
  preset?: ArtStylePreset,
  customArtStyle?: string
): Record<string, string> {
  const pkgStyle = (ctx.charArtStyle ?? '').trim()
  const base = charArtStyleOf(preset, customArtStyle)
  const artStyle = pickArtStyle(pkgStyle, base)
  return {
    name: target.charName || target.charId,
    aliases: aliasText(target.aliases),
    sex: (target.sex ?? '').trim(),
    appearanceSummary: (target.appearanceSummary ?? '').trim(),
    visualKeywords: (target.visualKeywords ?? []).filter((k) => typeof k === 'string' && k.trim()).join('、'),
    worldImpression: (ctx.worldImpression ?? '').trim(),
    novelGenre: (ctx.novelGenre ?? '').trim(),
    artStyle
  }
}

/**
 * 选画风文本：包内优先；包内缺失才用基座。
 *
 * 为什么不是「基座 + 包内」拼接：两者是**同一维度的替代品**，不是互补项。
 * 基座是「没有包内指导时的默认答案」，包内是「这本书的具体答案」。
 * 同时给会重复，且可能引入与题材冲突的段落（如历史小说配「都市题材造型」）。
 */
function pickArtStyle(pkgStyle: string, base: string): string {
  if (!pkgStyle) return base
  if (!base) return pkgStyle
  // 高度重合 → 同一份，取包内（更完整，可能带本书专属调整）
  const head = (s: string): string => s.replace(/\s+/g, '').slice(0, 80)
  if (head(pkgStyle) === head(base)) return pkgStyle
  // 不重合：包内是这本书的答案，仍以包内为准（基座只作兜底）
  return pkgStyle
}

/** 地图图标模板变量。 */
export function buildIconPromptVars(target: IconTarget, ctx: ImagegenContext): Record<string, string> {
  return {
    locationType: (target.locationType ?? '').trim(),
    iconStyle: (ctx.iconStyle ?? '').trim(),
    novelGenre: (ctx.novelGenre ?? '').trim()
  }
}

/**
 * 场景背景图模板变量。
 *
 * `artStyle` 与人物同一规则（见 `pickArtStyle`）：包内 `:scene-art-style` 优先，
 * 缺失才用基座。实测 monte-cristo 的 `:scene-art-style` 就是
 * `visual_novel_scene_art_style` 原文，两份拼接会重复。
 */
export function buildScenePromptVars(
  target: SceneTarget,
  ctx: ImagegenContext,
  preset?: ArtStylePreset,
  customArtStyle?: string
): Record<string, string> {
  const pkgStyle = (ctx.sceneArtStyle ?? '').trim()
  const base = sceneArtStyleOf(preset === 'realistic' ? 'anime' : preset, customArtStyle)
  const artStyle = pickArtStyle(pkgStyle, base)
  return {
    sceneName: (target.name ?? target.sceneId ?? '').trim(),
    summary: (target.summary ?? '').trim(),
    sceneDescription: (target.sceneDescription ?? '').trim(),
    worldImpression: (ctx.worldImpression ?? '').trim(),
    novelGenre: (ctx.novelGenre ?? '').trim(),
    artStyle
  }
}

/** 渲染人物立绘正面提示词。 */
export function renderCharPrompt(
  target: CharTarget,
  ctx: ImagegenContext,
  template?: string,
  preset?: ArtStylePreset,
  customArtStyle?: string
): string {
  return renderTemplate(
    template || DEFAULT_CHAR_PROMPT_TEMPLATE,
    buildCharPromptVars(target, ctx, preset, customArtStyle)
  )
}

/** 渲染地点图标正面提示词。 */
export function renderIconPrompt(target: IconTarget, ctx: ImagegenContext, template?: string): string {
  return renderTemplate(template || DEFAULT_ICON_PROMPT_TEMPLATE, buildIconPromptVars(target, ctx))
}

/** 渲染场景背景正面提示词。 */
export function renderScenePrompt(
  target: SceneTarget,
  ctx: ImagegenContext,
  template?: string,
  preset?: ArtStylePreset,
  customArtStyle?: string
): string {
  return renderTemplate(
    template || DEFAULT_SCENE_PROMPT_TEMPLATE,
    buildScenePromptVars(target, ctx, preset, customArtStyle)
  )
}

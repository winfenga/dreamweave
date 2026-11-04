/**
 * 提示词模板渲染（生图）。
 *
 * 模板默认值在 `shared/imagegen-defaults.ts`（设置页「恢复默认」与主进程共用一份）。
 * 渲染规则：`{{key}}` → vars[key]；缺失变量填**空串**；渲染后做轻量清理
 * （压缩 3+ 连续空行、重复标点、空括号），保证缺变量时句子依然通顺。
 */
import { DEFAULT_CHAR_PROMPT_TEMPLATE, DEFAULT_ICON_PROMPT_TEMPLATE } from '../../shared/imagegen-defaults'
import type { CharTarget, ImagegenContext, IconTarget } from '../../shared/imagegen-types'

/** 人物模板的全部合法占位符（校验/说明用） */
export const CHAR_TEMPLATE_VARS = [
  'name',
  'aliases',
  'sex',
  'appearanceSummary',
  'visualKeywords',
  'worldImpression',
  'novelGenre'
] as const

/** 图标模板的全部合法占位符 */
export const ICON_TEMPLATE_VARS = ['locationType', 'iconStyle', 'novelGenre'] as const

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

/** 人物立绘模板变量（基于 characterAppearance 字段 + worldImpression 产物）。 */
export function buildCharPromptVars(target: CharTarget, ctx: ImagegenContext): Record<string, string> {
  return {
    name: target.charName || target.charId,
    aliases: aliasText(target.aliases),
    sex: (target.sex ?? '').trim(),
    appearanceSummary: (target.appearanceSummary ?? '').trim(),
    visualKeywords: (target.visualKeywords ?? []).filter((k) => typeof k === 'string' && k.trim()).join('、'),
    worldImpression: (ctx.worldImpression ?? '').trim(),
    novelGenre: (ctx.novelGenre ?? '').trim()
  }
}

/** 地图图标模板变量。 */
export function buildIconPromptVars(target: IconTarget, ctx: ImagegenContext): Record<string, string> {
  return {
    locationType: (target.locationType ?? '').trim(),
    iconStyle: (ctx.iconStyle ?? '').trim(),
    novelGenre: (ctx.novelGenre ?? '').trim()
  }
}

/** 渲染人物立绘正面提示词。 */
export function renderCharPrompt(target: CharTarget, ctx: ImagegenContext, template?: string): string {
  return renderTemplate(template || DEFAULT_CHAR_PROMPT_TEMPLATE, buildCharPromptVars(target, ctx))
}

/** 渲染地点图标正面提示词。 */
export function renderIconPrompt(target: IconTarget, ctx: ImagegenContext, template?: string): string {
  return renderTemplate(template || DEFAULT_ICON_PROMPT_TEMPLATE, buildIconPromptVars(target, ctx))
}

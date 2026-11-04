/**
 * 角色名牌配色：按 canonical.importanceLevel 取色。
 *
 * 关键约束：importanceLevel 的取值**随包而异**（实测 CORE/HIGH/MEDIUM/LOW/TEMP，
 * 不排除未来出现别的级别），因此：
 * - 查找顺序 = 用户自定义(settings.roleColors) → 内置默认 → 全局兜底色；
 * - 一律不把级别枚举写死在视图里，未知级别也能得到稳定颜色。
 */
import { DEFAULT_ROLE_COLORS, FALLBACK_ROLE_COLOR } from '../../../shared/app-types'

export { DEFAULT_ROLE_COLORS, FALLBACK_ROLE_COLOR }

/** 取某个分级的颜色；custom 优先，缺失时回落默认，再回落兜底色 */
export function roleColor(
  level: string | null | undefined,
  custom?: Record<string, string>
): string {
  const key = (level ?? '').trim()
  if (!key) return FALLBACK_ROLE_COLOR
  const upper = key.toUpperCase()
  const pick = (src: Record<string, string> | undefined, k: string): string | undefined => {
    if (!src) return undefined
    return src[k] ?? src[k.toUpperCase()] ?? src[k.toLowerCase()]
  }
  return pick(custom, key) ?? pick(DEFAULT_ROLE_COLORS, key) ?? pick(custom, upper) ?? FALLBACK_ROLE_COLOR
}

/** 设置面板展示用的常见级别（其余级别仍可用，只是不预置色板） */
export const COMMON_LEVELS = ['CORE', 'HIGH', 'MEDIUM', 'LOW', 'TEMP'] as const

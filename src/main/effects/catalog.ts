/**
 * 特效目录加载层（主进程）。
 *
 * 目录是**构建期静态资产**（随源码交付，`resources/effects/effect-catalog.json`，
 * 与 `resources/prompts/` 同模式），非随包数据。策略：惰性加载 + 内存缓存 +
 * 结构自检（id 唯一 / category ∈ 7 类 / tracks[].kind ∈ 14）。自检违规**只告警不阻断**，
 * 保证个别脏数据不会让整套特效不可用（P0-3）。
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import {
  EFFECT_CATEGORIES,
  KNOWN_TRACK_KINDS,
  type EffectCatalogEntry,
  type EffectCatalogResult
} from '../../shared/effects-types'

/** 进程内缓存：首次加载后复用，避免重复读盘（同进程内目录不变） */
let cache: EffectCatalogResult | null = null

/**
 * 定位 resources 目录。
 * 优先 `app.getAppPath()/resources`（electron-vite 下为项目根）；实测不符时回落
 * `__dirname/../../resources`（编译后 out/main → 项目根/resources）。两条路都试，取存在者。
 */
export function resourcesDir(): string {
  const candidates = [join(app.getAppPath(), 'resources'), join(__dirname, '..', '..', 'resources')]
  for (const c of candidates) {
    try {
      if (existsSync(join(c, 'effects', 'effect-catalog.json'))) return c
    } catch {
      // 忽略探测失败，继续下一个候选
    }
  }
  // 都不存在时返回首选，交由 loadCatalog 报可读错误
  return candidates[0]
}

function catalogPath(): string {
  return join(resourcesDir(), 'effects', 'effect-catalog.json')
}

/** 结构自检：返回告警（不抛错）。允许未知 category/kind 存在，仅提示。 */
function validate(entries: EffectCatalogEntry[]): string[] {
  const warnings: string[] = []
  const allowedCats = new Set<string>(EFFECT_CATEGORIES)
  const allowedKinds = new Set<string>(KNOWN_TRACK_KINDS)
  const seen = new Set<string>()
  entries.forEach((e, i) => {
    if (!e || typeof e !== 'object') {
      warnings.push(`第 ${i} 项不是对象，已忽略`)
      return
    }
    if (!e.id || typeof e.id !== 'string') {
      warnings.push(`第 ${i} 项缺少合法 id`)
    } else if (seen.has(e.id)) {
      warnings.push(`重复 id：${e.id}`)
    } else {
      seen.add(e.id)
    }
    if (typeof e.category === 'string' && !allowedCats.has(e.category)) {
      warnings.push(`未知 category：${String(e.category)}（${e.id ?? i}）`)
    }
    if (Array.isArray(e.tracks)) {
      for (const t of e.tracks) {
        if (t && typeof t.kind === 'string' && !allowedKinds.has(t.kind)) {
          warnings.push(`未知 track kind：${t.kind}（${e.id ?? i}）`)
        }
      }
    } else {
      warnings.push(`缺少 tracks[]（${e.id ?? i}）`)
    }
  })
  return warnings
}

/** 归一化为条目数组：兼容纯数组与 { entries | effects: [] } 两种形态 */
function normalizeCatalog(raw: unknown): EffectCatalogEntry[] {
  if (Array.isArray(raw)) return raw as EffectCatalogEntry[]
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    const list = o.entries ?? o.effects ?? o.catalog
    if (Array.isArray(list)) return list as EffectCatalogEntry[]
  }
  return []
}

/**
 * 加载特效目录（带缓存）。
 * - 文件缺失/解析失败 → `{ ok:false, error:'特效目录不可用：…' }`（可读错误，应用不崩）
 * - 结构违规 → `{ ok:true, entries, warnings }`（告警但不阻断）
 */
export async function loadCatalog(): Promise<EffectCatalogResult> {
  if (cache) return cache
  let text: string
  try {
    text = await readFile(catalogPath(), 'utf8')
  } catch (e) {
    return { ok: false, error: `特效目录不可用：无法读取 ${catalogPath()}（${(e as Error).message}）` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `特效目录不可用：JSON 解析失败（${(e as Error).message}）` }
  }
  const entries = normalizeCatalog(parsed)
  if (!entries.length) {
    return { ok: false, error: '特效目录不可用：未解析到任何特效条目' }
  }
  const warnings = validate(entries)
  if (warnings.length) {
    for (const w of warnings) console.warn('[effects/catalog]', w)
  }
  cache = { ok: true, entries, warnings }
  return cache
}

/** 仅测试/热更用：清空缓存（正式流程不需要） */
export function clearCatalogCache(): void {
  cache = null
}

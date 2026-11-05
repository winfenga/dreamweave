/**
 * `effectAnnotation` 的漫画分支适配器（C 线；模板 `manga_effects_system_prompt`）。
 *
 * ⚠️ 命名注意：注册表里已有的 `effectAnnotation` 是**正片（视觉小说）**的特效标注，
 *    走 `effect_semantics_*` 那套提示词。漫画特效是**另一套**：
 *      - 目录不同（漫画用 e01/e02/e13/a18 这类 id，VN 用 portrait-cutin/rain 这类）
 *      - 粒度不同（漫画按 chapterSeq+page+panel 定位，VN 按 storyScript 的 order）
 *      - 输入不同（漫画喂整份 mangaScript，VN 喂 storyScript 片段）
 *    因此本适配器 id 为 `mangaEffects`，与 VN 的 `effectAnnotation` 并列而非覆盖。
 *
 * 产物：`records/results/mangaEffects:chapter:<ch>:<scriptHash>`（按章逐条）。
 * 输入：`readUpstream('mangaScript')` 的**整份脚本 JSON**（模板明确要求 user 消息是
 *       漫画脚本 JSON，一次给全批，不是一句一次）。
 *
 * 输出契约（模板原文）：
 * ```jsonc
 * { "effects": [
 *     { "chapterSeq": 1, "page": 1, "panel": 1,
 *       "effects": [ { "id": "e10" }, { "id": "a18", "color": "#8B1A1A", "opacity": 0.18 } ] }
 *   ] }
 * ```
 * 规则要点（parse 侧落实到校验里）：
 *   - 无特效的格子**不输出**
 *   - 同一格只出现一次，同格内 id 不重复
 *   - `a18`（自定义颜色滤镜）必须带 `color`（#RRGGBB），可选 `opacity`（0~1）
 *   - 只从目录里选，不创造目录外 id
 */
import type { ChatMessage, LlmTaskAdapter, TaskRuntime } from '../../../shared/pipeline-types'
import { parseJsonLoose } from './cacheWarming'

/** 漫画特效目录（这是与 VN 的那套**完全不同**的命名空间） */
interface MangaEffectCatalogItem {
  id: string
  name: string
  guide: string
}

/**
 * 漫画可用特效目录。
 *
 * 依据 `gmzz-10.t2w` 实测出现的 id（e02/e13/a18/e14 等）与新版 FB 目录的交集，
 * 加上模板 guide 原文。注意这是**独立常量**，不复用 `resources/effects/effect-catalog.json`
 * ——那份是 VN 的 74 条，id 空间不同（portrait-cutin vs e01）。
 *
 * 只收录「在整页漫画上说得通」的：漫画不能定位人物、不能替换背景、不能分离角色，
 * 所以 portrait-cutin / actor-* 这类 VN 专属的**不在此列**。
 */
export const MANGA_EFFECT_CATALOG: MangaEffectCatalogItem[] = [
  {
    id: 'e02',
    name: '睁眼',
    guide: '眼睑艰难张开、视野恢复；用于虚弱苏醒的主观视角，不用于普通抬眼。'
  },
  {
    id: 'e03',
    name: '推进冲击震动',
    guide: '镜头推进并短促震动；用于重击、突发冲击，不用于平淡惊讶。'
  },
  {
    id: 'e04',
    name: '天色由暗变亮',
    guide: '场景逐渐变亮；用于明确的黎明或环境照明变化，不表达心情变好。'
  },
  {
    id: 'e05',
    name: '天色由亮变暗',
    guide: '场景逐渐变暗；用于日暮或光源熄灭，不把隐喻当实际天色。'
  },
  {
    id: 'e06',
    name: '惊醒',
    guide: '镜头骤然拉近并轻微震动，配合睁眼；用于从噩梦中猛然惊醒，不用于普通转头。'
  },
  {
    id: 'e07',
    name: '电影上下遮幅',
    guide: '上下黑边收束构图；用于重要景观或庄重转场，不用于连续对白。'
  },
  {
    id: 'e08',
    name: '横向摇镜',
    guide: '镜头横向巡视；用于视线扫过环境或寻找目标，不用于普通人物走动。'
  },
  {
    id: 'e10',
    name: '漫画速度线',
    guide: '从屏幕边缘向画面中心收束的漫画速度线，持续至行动结束；用于疾冲、追逐和急速动作。'
  },
  {
    id: 'e11',
    name: '冲击集中线',
    guide: '从画面边缘向画面中心收束；用于强烈撞击、重大震惊或爆发式反驳、怒喝，不用于普通强调或每次感叹。'
  },
  {
    id: 'e12',
    name: '心跳收缩',
    guide: '画面随双拍心跳收缩；用于强烈恐惧、紧张或悸动，不泛用于所有心声。'
  },
  {
    id: 'e13',
    name: '缓慢推进与拉回',
    guide: '镜头缓慢推进再拉回；用于凝视、发现和情绪重点，不用于所有对白。'
  },
  {
    id: 'e14',
    name: '从模糊到清晰',
    guide: '两秒内从失焦恢复清晰；用于恍惚后看清场景，不用于普通知觉。'
  },
  {
    id: 'e15',
    name: '仰视移镜',
    guide: '向上移动视线；用于抬头观察高大目标，不用于一般敬佩。'
  },
  {
    id: 'e16',
    name: '眩晕镜头',
    guide: '画面旋转晃动；用于眩晕、失神或意识模糊，不用于普通紧张。'
  },
  {
    id: 'e17',
    name: '缓缓闭眼',
    guide: '眼睑缓慢闭合；用于入睡、昏迷或明确闭眼，不用于普通停顿。'
  },
  {
    id: 'e19',
    name: '梦境',
    guide: '柔和光晕与漂浮粒子；用于明确梦境或回忆段落，不用于现实场景渲染气氛。'
  },
  {
    id: 'e20',
    name: '刀光斩击',
    guide: '短暂黑场中刀光掠过，随后恢复场景；用于明确挥砍，不用于威胁性台词。'
  },
  {
    id: 'a01',
    name: '热浪',
    guide: '空气热扭曲；用于高温、火场或灼热地面，不用于情绪热烈。'
  },
  {
    id: 'a02',
    name: '花瓣飘落',
    guide: '花瓣随风飘落；有花木或明确花雨时使用，不自动装饰浪漫对白。'
  },
  {
    id: 'a03',
    name: '落叶飘落',
    guide: '落叶翻飞；用于林木落叶或风吹树叶，不用于无植被室内。'
  },
  {
    id: 'a04',
    name: '萤火虫',
    guide: '暗处点点萤光；用于明确萤火虫或相符的夜间野外，不作为通用魔法。'
  },
  {
    id: 'a05',
    name: '火星上升',
    guide: '炽热余烬上升；用于火堆、燃烧和锻造，不用于普通暖色灯光。'
  },
  {
    id: 'a06',
    name: '水中气泡',
    guide: '气泡向上漂浮；水中、水底场景均可用，水边或船上不用。'
  },
  {
    id: 'a07',
    name: '闪电',
    guide: '暗环境中间歇分叉闪电照亮画面；用于实际雷电，不用于比喻；天气已有闪电时不重复选。'
  },
  {
    id: 'a08',
    name: '夜色降临',
    guide: '进入并维持蓝黑夜色；用于需要突出夜晚的场景，不把室内对白一律压暗。'
  },
  {
    id: 'a09',
    name: '暖色回忆',
    guide: '柔暖色调；用于温暖回忆，不用于当下暖灯环境。'
  },
  {
    id: 'a10',
    name: '旧照片回忆',
    guide: '褐色旧照片质感；用于久远往事，不与暖色回忆叠加。'
  },
  {
    id: 'a11',
    name: '负片冲击',
    guide: '维持反相色调；仅用于极端精神冲击或异常感知，慎用，不用于一般吃惊。'
  },
  {
    id: 'a14',
    name: '暗角压迫',
    guide: '环境明确压迫或不祥时收暗画面边缘。'
  },
  {
    id: 'a18',
    name: '自定义颜色滤镜',
    guide:
      '全场景染色；color 必填 #RRGGBB，opacity 为 0—1，默认 0.2。仅用于明确有色照明、魔法或异常视野。'
  }
]

/** 目录 → 模板 `catalog` 变量（模板要求 id/name/guide 三元组） */
function catalogText(): string {
  return MANGA_EFFECT_CATALOG.map((e) => `- ${e.id} | ${e.name} | ${e.guide}`).join('\n')
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/
/** 需要额外 color 的特效（模板明确点名只有 a18） */
const NEEDS_COLOR = new Set(['a18'])

/** 从上游条目里取第一份可用 mangaScript 的 chapters */
function pickMangaChapters(value: unknown): Record<string, unknown>[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const o = value as Record<string, unknown>
  const d = o.data && typeof o.data === 'object' && !Array.isArray(o.data) ? (o.data as Record<string, unknown>) : o
  const chapters = d.chapters
  if (!Array.isArray(chapters)) return null
  return chapters.filter(
    (c): c is Record<string, unknown> => !!c && typeof c === 'object' && !Array.isArray(c)
  )
}

export const mangaEffectsAdapter: LlmTaskAdapter = {
  id: 'mangaEffects',
  mergeStrategy: 'concat-dedup-order',
  // 整份脚本一次给模型（模板设计要求），切批会让 page/panel 坐标跨批错位
  batching: { inputBudgetTokens: 100000 },

  /**
   * 稳定键：`chapterSeq|page|panel`。
   *
   * 实测包里的 mangaEffects 是**按章**产出的（`mangaEffects:chapter:1:<hash>`），
   * 一章一条，所以章级去重就够。但为了兼容「整份一次产出」的形态，
   * 这里按格子去重，保证同一格不会因重复产出出现两条冲突的特效列表。
   */
  keyOf(part: unknown): string {
    if (typeof part === 'string') return `warn:${part}`
    if (part && typeof part === 'object' && !Array.isArray(part)) {
      const o = part as Record<string, unknown>
      const ch = typeof o.chapterSeq === 'number' ? o.chapterSeq : ''
      const pg = typeof o.page === 'number' ? o.page : ''
      const pn = typeof o.panel === 'number' ? o.panel : ''
      if (ch !== '' && pg !== '' && pn !== '') return `cell:${ch}|${pg}|${pn}`
    }
    try {
      return JSON.stringify(part)
    } catch {
      return String(part)
    }
  },

  /**
   * 输入 = 整份漫画脚本 JSON。
   *
   * 为什么不是 `numberLines`：模板明确说「user 消息是漫画脚本 JSON」，
   * 模型需要看到 chapterSeq / pages 位置 / panels.no / speech / context 才能定位格子。
   */
  async inputText(rt: TaskRuntime): Promise<string> {
    if (typeof rt.readUpstream !== 'function') {
      throw new Error('mangaEffects 需要 mangaScript 产物：运行期未提供 readUpstream')
    }
    const entries = await rt.readUpstream('mangaScript')
    if (!entries.length) {
      throw new Error('mangaEffects 需要 mangaScript 产物：工作库中没有任何 mangaScript 结果，请先运行漫画脚本任务')
    }
    // 合并全部 chunk 的 chapters（多 chunk 包会有多条）
    const all: Record<string, unknown>[] = []
    const seen = new Set<number>()
    for (const e of entries) {
      const chapters = pickMangaChapters(e.value)
      if (!chapters) continue
      for (const c of chapters) {
        const seq = typeof c.chapterSeq === 'number' ? c.chapterSeq : 0
        if (!seq || seen.has(seq)) continue
        seen.add(seq)
        all.push(c)
      }
    }
    if (!all.length) {
      throw new Error('mangaScript 产物里没有任何 chapters，无法标注特效')
    }
    all.sort((a, b) => Number(a.chapterSeq ?? 0) - Number(b.chapterSeq ?? 0))
    // 只喂模型判定所需的字段，避免把无关字段（lines 的行号数组）撑大 token
    const slim = all.map((c) => ({
      chapterSeq: c.chapterSeq,
      pages: (Array.isArray(c.pages) ? c.pages : []).map((p) => {
        const pg = p as Record<string, unknown>
        return {
          context: pg.context ?? '',
          panels: (Array.isArray(pg.panels) ? pg.panels : []).map((pn) => {
            const x = pn as Record<string, unknown>
            return {
              no: x.no,
              scene: x.scene ?? '',
              content: x.content ?? '',
              speech: x.speech ?? []
            }
          })
        }
      })
    }))
    return JSON.stringify({ chapters: slim }, null, 1)
  },

  async buildMessages(batchText: string, rt: TaskRuntime): Promise<ChatMessage[]> {
    // 模板是 system 型（本身就含"你为漫画解说演出选择屏幕特效"与输出契约），
    // 所以这里 system = 模板渲染 + 目录，user = 脚本 JSON。
    const system = await rt.render('manga_effects_system_prompt', { catalog: catalogText() })
    if (!system.trim()) {
      rt.warnings.push('mangaEffects：manga_effects_system_prompt 模板为空')
    }
    return [
      { role: 'system', content: system },
      { role: 'user', content: batchText }
    ]
  },

  parse(content: string): unknown {
    const obj = parseJsonLoose(content)
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const o = obj as Record<string, unknown>
      if (!Array.isArray(o.effects)) {
        throw new Error(
          `mangaEffects 解析失败：顶层 effects 不是数组（实际字段：${Object.keys(o).join(',') || '无'}）`
        )
      }
      const list = o.effects
      if (Array.isArray(list)) {
        const known = new Set(MANGA_EFFECT_CATALOG.map((e) => e.id))
        const seenCell = new Set<string>()
        const out: Record<string, unknown>[] = []
        for (const item of list) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue
          const it = item as Record<string, unknown>
          const ch = typeof it.chapterSeq === 'number' ? it.chapterSeq : 0
          const pg = typeof it.page === 'number' ? it.page : 0
          const pn = typeof it.panel === 'number' ? it.panel : 0
          if (!ch || !pg || !pn) continue
          const cell = `${ch}|${pg}|${pn}`
          if (seenCell.has(cell)) continue // 同格只输出一次
          const fxRaw = it.effects
          if (!Array.isArray(fxRaw)) continue
          const fxs: Record<string, unknown>[] = []
          const usedIds = new Set<string>()
          for (const f of fxRaw) {
            if (!f || typeof f !== 'object' || Array.isArray(f)) continue
            const fx = f as Record<string, unknown>
            const id = typeof fx.id === 'string' ? fx.id.trim() : ''
            if (!id) continue
            if (!known.has(id)) continue // 只从目录选，不创造
            if (usedIds.has(id)) continue // 同格内 id 不重复
            usedIds.add(id)
            if (NEEDS_COLOR.has(id)) {
              const color = typeof fx.color === 'string' ? fx.color.trim() : ''
              // a18 必须带合法 #RRGGBB，否则丢弃这条（模板硬约束）
              if (!HEX_RE.test(color)) continue
              const rec: Record<string, unknown> = { id, color }
              if (typeof fx.opacity === 'number' && Number.isFinite(fx.opacity)) {
                rec.opacity = Math.min(1, Math.max(0, fx.opacity))
              }
              fxs.push(rec)
            } else {
              fxs.push({ id })
            }
          }
          if (!fxs.length) continue // 无特效的格子不输出
          seenCell.add(cell)
          out.push({ chapterSeq: ch, page: pg, panel: pn, effects: fxs })
        }
        return { effects: out, scriptHash: typeof o.scriptHash === 'string' ? o.scriptHash : undefined }
      }
    }
    // 解析失败 → 抛错（不要静默产出空产物：那会让任务显示成功、下游却拿不到数据，
    // 用户看到的只是「跑完了但什么都没有」）。同时保留足够信息用于定位。
    const text = String(content ?? '')
    const failed = parseJsonLoose(text)
    const why =
      failed === null
        ? 'parseJsonLoose 返回 null（响应不是合法 JSON）'
        : typeof failed !== 'object' || Array.isArray(failed)
          ? `解析结果不是对象（实际 ${Array.isArray(failed) ? 'array' : typeof failed}）`
          : `顶层缺少 effects 数组（实际字段：${Object.keys(failed as Record<string, unknown>).join(',') || '无'}）`
    throw new Error(
      `mangaEffects 解析失败：${why}。响应共 ${text.length} 字符，结尾 ${JSON.stringify(text.slice(-160))}`
    )
  }
}

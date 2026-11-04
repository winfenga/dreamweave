/**
 * 漫画世界书：把人物档案与世界观整理成可查询、可搜索的设定条目。
 *
 * 【范围】只做两类条目：
 *   - 人物（`kind: 'character'`）：名字、别名、身份、档案、外貌、音色；
 *   - 世界观（`kind: 'world'`）：题材 + 世界印象，常驻。
 *
 * **不做人物关系。** 关系数据只有小说解析链路才有产出（`characterRelation` 任务），
 * 漫画链路的任务清单里没有它，包里也确实没有这份数据。
 * 我们不从别处补、也不猜 —— 缺就是缺，界面上不出现空的「关系」区块。
 *
 * 【为什么单独一份投影，直接读 canonical 而不走角色卡】
 * 因为要给的是「读者查设定」用的一屏内容，字段取舍与角色卡不同：
 *   - 只要外貌摘要与视觉关键词，不要立绘图（阅读器里已经有画了）；
 *   - 音色直接读 canonical 内嵌的 `vt`/`vi`，不必再去音频记录里绕；
 *   - 排序看「这人在这本漫画里说了多少话」，那个数字在分镜台词里，不在 canonical。
 */
import type { T2wManifest } from '../../shared/t2w-types'
import { getCards } from '../character-card'

/** 世界书条目分类 */
export type MangaLoreKind = 'character' | 'world'

export interface MangaLoreEntry {
  id: string
  kind: MangaLoreKind
  /** 条目名（人物名 / 设定名） */
  name: string
  /** 别名（人物） */
  aliases: string[]
  /** 触发关键词（导出酒馆时用） */
  keys: string[]
  /** 正文 */
  content: string
  /** 是否常驻（世界观这类永远有效） */
  constant: boolean
  /** 重要性 / 分组标签 */
  tag: string
  /** 出场章节（人物） */
  chapters: number[]
  /** 生存状态（人物） */
  lifeStatus: string
  /** 身份信息（人物） */
  identInfos: string[]
  /** 音色类型与描述（人物，来自 canonical 的 vt/vi） */
  voiceType: string
  voiceDesc: string
  /** 该角色在剧本中的开口次数（排序用） */
  actionCount: number
}

/** 整本世界书 */
export interface MangaLorebook {
  entries: MangaLoreEntry[]
  stats: {
    characterCount: number
    worldCount: number
    totalCount: number
    withAliases: number
    withVoice: number
  }
  /** 数据来源提示（缺产物时界面可提示） */
  warning?: string
}

/** canonical 人物在漫画包里的真实形状 */
interface SpriteInfo {
  appearanceSummary?: string
  visualKeywords?: string[]
  sex?: string
  chunkIndex?: number
}

interface MangaCharacterRaw {
  id?: string
  name?: string
  importanceLevel?: string
  summary?: string
  identInfos?: string[]
  aliases?: string[]
  lifeStatus?: string
  /** 音色类型（漫画包内嵌在 canonical） */
  vt?: string
  /** 音色描述 */
  vi?: string
  wikiSectionType?: string
  characterSpriteInfos?: SpriteInfo[]
  chunkSummaryList?: { chunkIndex?: number; summaryText?: string }[]
}

function toEntries(node: unknown): { key: string; value: unknown }[] {
  if (Array.isArray(node)) {
    return (node as { key?: unknown; value?: unknown }[]).map((e) => ({
      key: String(e?.key ?? ''),
      value: e?.value
    }))
  }
  if (node && typeof node === 'object') {
    return Object.entries(node as Record<string, unknown>).map(([key, value]) => ({ key, value }))
  }
  return []
}

/** 条目值可能是 {key,value} 包一层、也可能再套 .data —— 两级都剥。 */
function unwrap<T>(raw: unknown): T | null {
  let v: unknown = raw
  if (v && typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
    v = (v as Record<string, unknown>).value
  }
  if (v === null || v === undefined) return null
  if (typeof v === 'object') {
    const d = (v as Record<string, unknown>).data
    if (d !== undefined && d !== null) return d as T
  }
  return v as T
}

/** 取 canonical 人物（漫画包形状） */
function pickCharacters(manifest: T2wManifest): MangaCharacterRaw[] {
  const results = toEntries(((manifest.records ?? {}) as Record<string, unknown>).results)
  const hit =
    results.find((r) => r.key.endsWith(':canonical')) ?? results.find((r) => r.key.includes(':canonical'))
  if (!hit) return []
  const d = unwrap<{ objects?: { characters?: MangaCharacterRaw[] } }>(hit.value)
  return (d?.objects?.characters ?? []).filter((c): c is MangaCharacterRaw => !!c && !!c.name)
}

/** 取世界观 */
function pickWorld(manifest: T2wManifest): { novelGenre: string; impression: string } {
  const results = toEntries(((manifest.records ?? {}).results as Record<string, unknown>) ?? {})
  const hit = results.find((r) => r.key.endsWith(':worldImpression'))
  if (!hit) return { novelGenre: '', impression: '' }
  const d = unwrap<{ novelGenre?: string; worldImpression?: string; visualImpression?: string }>(hit.value)
  return {
    novelGenre: typeof d?.novelGenre === 'string' ? d.novelGenre : '',
    impression: typeof d?.worldImpression === 'string' ? d.worldImpression : ''
  }
}

/** 取项目标题 */
function pickTitle(manifest: T2wManifest): string {
  const p = manifest.project as { title?: string } | undefined
  return typeof p?.title === 'string' ? p.title : ''
}

/**
 * 构建漫画世界书。
 *
 * @param manifest 工作库装配后的 manifest
 * @param assetBase 资产 URL 前缀（复用角色卡的开口次数统计，可为空串）
 * @param view 漫画投影模型（可选）。**排序用它的台词数据**：
 *   漫画包通常不产出 storyScript，`actionCount` 会全是 0，排序就退化成按名字；
 *   而「读者最常查谁」应看**这个人在这本漫画里说了多少话**，那个数字就在 view 里。
 */
export function buildMangaLorebook(
  manifest: T2wManifest,
  assetBase: string,
  view?: { chapters?: { pages?: { panels?: { speech?: { speaker?: string }[] }[] }[] }[] }
): MangaLorebook {
  const chars = pickCharacters(manifest)
  const world = pickWorld(manifest)
  const title = pickTitle(manifest)

  // 复用角色卡那套已算好的开口次数（有 storyScript 的包才有值）
  let actionCounts = new Map<string, number>()
  try {
    const { cards } = getCards(manifest, assetBase)
    actionCounts = new Map(cards.map((c) => [c.id, c.actionCount]))
  } catch {
    actionCounts = new Map()
  }

  /**
   * 漫画侧的真实「出场热度」：统计每页台词里提到的说话人名。
   *
   * 注意用**名字**而不是 characterId：漫画分镜的 speech.speaker 存的是显示名
   * （实测「阿尔杰·威尔逊」这种），不是 D-0-C-0 这种 id。
   */
  const spokenByName = new Map<string, number>()
  for (const ch of view?.chapters ?? []) {
    for (const pg of ch.pages ?? []) {
      for (const pn of pg.panels ?? []) {
        for (const sp of pn.speech ?? []) {
          const n = (sp?.speaker ?? '').trim()
          if (!n) continue
          spokenByName.set(n, (spokenByName.get(n) ?? 0) + 1)
        }
      }
    }
  }

  const entries: MangaLoreEntry[] = []

  for (const c of chars) {
    if (!c.id) continue
    const name = c.name ?? c.id
    const aliases = (c.aliases ?? []).filter((s): s is string => typeof s === 'string' && !!s)
    const identInfos = (c.identInfos ?? []).filter((s): s is string => typeof s === 'string' && !!s)
    const sprite = (c.characterSpriteInfos ?? [])[0]

    // 正文：身份 → 档案 → 外貌 → 视觉关键词 → 状态
    const body: string[] = []
    if (identInfos.length) body.push(`身份：${identInfos.join('；')}`)
    if (c.summary) body.push(c.summary)
    if (sprite?.appearanceSummary) body.push(`外貌：${sprite.appearanceSummary}`)
    const kw = (sprite?.visualKeywords ?? []).filter((s): s is string => typeof s === 'string' && !!s)
    if (kw.length) body.push(`视觉关键词：${kw.join('、')}`)
    if (c.lifeStatus) body.push(`当前状态：${c.lifeStatus}`)

    // 热度：优先用漫画台词里真正出现的次数（按名字与别名都算），退回落 storyScript 计数
    let spoken = spokenByName.get(name) ?? 0
    for (const a of aliases) spoken += spokenByName.get(a) ?? 0
    const actionCount = spoken > 0 ? spoken : (actionCounts.get(c.id) ?? 0)

    entries.push({
      id: `char:${c.id}`,
      kind: 'character',
      name,
      aliases,
      keys: [name, ...aliases].filter(Boolean),
      content: body.join('\n'),
      constant: false,
      tag: c.importanceLevel || '',
      chapters: [],
      lifeStatus: c.lifeStatus ?? '',
      identInfos,
      voiceType: c.vt ?? '',
      voiceDesc: c.vi ?? '',
      actionCount
    })
  }

  // 世界观一条，常驻
  if (world.impression || world.novelGenre) {
    const body: string[] = []
    if (world.novelGenre) body.push(`题材：${world.novelGenre}`)
    if (title) body.push(`作品：${title}`)
    if (world.impression) body.push(world.impression)
    entries.push({
      id: 'world:main',
      kind: 'world',
      name: '世界观',
      aliases: [],
      keys: [],
      content: body.join('\n'),
      constant: true,
      tag: world.novelGenre,
      chapters: [],
      lifeStatus: '',
      identInfos: [],
      voiceType: '',
      voiceDesc: '',
      actionCount: 0
    })
  }

  // 排序：世界观在前，其余按开口次数降序（读者最常查的自然是主角）
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'world' ? -1 : 1
    return b.actionCount - a.actionCount || a.name.localeCompare(b.name, 'zh')
  })

  const warning = chars.length
    ? undefined
    : '本包没有 canonical 人物产物，世界书为空（可用解析链路补跑 canonical 任务）'

  return {
    entries,
    stats: {
      characterCount: entries.filter((e) => e.kind === 'character').length,
      worldCount: entries.filter((e) => e.kind === 'world').length,
      totalCount: entries.length,
      withAliases: entries.filter((e) => e.kind === 'character' && e.aliases.length > 0).length,
      withVoice: entries.filter((e) => e.kind === 'character' && !!e.voiceType).length
    },
    warning
  }
}

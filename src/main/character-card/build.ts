/**
 * 角色卡构建：把 t2w 包的 canonical/关系/形象/音色投影成 `CharacterCard`。
 *
 * 【为什么不复用 `t2w/view.ts` 的结果】view.ts 产出的是**舞台/地图**投影
 * （CharacterVisual 只有名字、立绘、分级、别名），而角色卡需要人物档案、
 * 身份、关系网、音色、出场章和酒馆用的 5 个 text 字段。两套需求的数据形状
 * 差别很大，硬塞进 ViewData 会让那个结构变成什么都装的大杂烩
 * （而且 ViewData 已被地图/舞台/印象图谱/脚本编辑器四处消费，改动风险高）。
 * 所以这里独立读包、独立投影 —— 代价是多解一次 manifest，换的是互不牵连。
 *
 * 【数据来源与实测坑（monte-cristo-10ch.t2w）】
 *   1) `results:":canonical"` 的 `objects.characters[]` 有 **20 人**，
 *      每人带 summary/identInfos/lifeStatus/appearanceChapterSeqs/characterAppearances。
 *      ⚠️ 条目值有两层包装：`{key, value}` 里 `value` 有时再套 `{data: …}`。
 *   2) `results:":characterRelation:n"` 的 `characterRelations[]` 是**成对**的：
 *      每条含 characterA/characterB 各自的 relationToOther。所以「唐太斯→美塞苔丝」
 *      要从**两个方向**各取一次，不能只按 A 侧收集（否则关系网只有单向）。
 *   3) 立绘在 `reader:":character-images"`，音色在 `reader:":dubbing:voice:<charId>"`。
 *      canonical 的 characterAppearances 与 characterAppearance 记录**双来源**，
 *      两者都要认（实测同一形象可能只出现在其中一边）。
 */
import type {
  CardPortrait,
  CardRelation,
  CardVoice,
  CharacterCard,
  CharacterCardSummary,
  LorebookEntry
} from '../../shared/character-card-types'
import type { T2wManifest } from '../../shared/t2w-types'

interface Keyed<T = unknown> {
  key: string
  value: T
}

/** canonical.objects.characters[] 的原始形状 */
interface RawCanonicalCharacter {
  id?: string
  name?: string
  importanceLevel?: string
  aliases?: string[]
  identInfos?: string[]
  summary?: string
  lifeStatus?: string
  appearanceChapterSeqs?: number[]
  characterAppearances?: RawAppearance[]
}

interface RawAppearance {
  appearanceId?: string
  name?: string
  sex?: string
  appearanceSummary?: string
  visualKeywords?: string[]
}

/** characterRelation 的原始形状 */
interface RawRelationPair {
  chunkIndex?: number
  fromChapterSeq?: number
  toChapterSeq?: number
  characterA?: { name?: string; relationToOther?: { overview?: string; summary?: string } }
  characterB?: { name?: string; relationToOther?: { overview?: string; summary?: string } }
  relationSummary?: string
}

interface RawVoice {
  characterId?: string
  vt?: string
  vi?: string
  path?: string
}

function toList<T>(node: unknown): Keyed<T>[] {
  if (Array.isArray(node)) return node as Keyed<T>[]
  if (node && typeof node === 'object') {
    return Object.entries(node as Record<string, T>).map(([key, value]) => ({ key, value }))
  }
  return []
}

/**
 * 解包条目值。
 *
 * 实测两种形态并存（`view.ts` 里同一段注释也记过这件事）：
 *   - 带 `.data` 层：plot/storyScript/worldImpression/characterRelation…
 *   - 不带：canonical / characterAppearance / draftAlign:*…
 * 且 toList 产出的元素还可能再包一层 `{key, value}`，故这里两级都剥。
 */
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

function pickResult<T>(results: Keyed[], suffix: string): T | null {
  const hit = results.find((r) => typeof r.key === 'string' && r.key.endsWith(suffix))
    ?? results.find((r) => typeof r.key === 'string' && r.key.includes(suffix))
  return hit ? unwrap<T>(hit.value) : null
}

function pickReader<T>(reader: Keyed[], suffix: string): T | null {
  const hit = reader.find((r) => typeof r.key === 'string' && r.key.includes(suffix))
  return hit ? unwrap<T>(hit.value) : null
}

/** 从 manifest 里取出构建需要的全部原始材料（一次解包，多处复用） */
export interface CardSource {
  characters: RawCanonicalCharacter[]
  relations: RawRelationPair[]
  /** appearanceId -> 元数据 */
  appearanceMeta: Map<string, Map<string, RawAppearance>>
  /** charId -> 立绘 entryPath（按 appearanceId） */
  imagesByChar: Map<string, { appearanceId: string; imagePath: string }[]>
  /** charId -> 音色 */
  voices: Map<string, RawVoice>
  /** charId -> 开口次数 */
  actionCounts: Map<string, number>
  novelGenre: string
  worldImpression: string
  projectTitle: string
  /** entryPath -> 常驻 URL（由调用方注入 t2w:// 前缀） */
  urlOf: (entryPath: string | null) => string | null
}

/** 从 manifest 抽取角色卡所需的全部原始材料。 */
export function collectCardSource(
  manifest: T2wManifest,
  urlOf: (entryPath: string | null) => string | null,
  opts?: { actionCounts?: Map<string, number>; projectTitle?: string }
): CardSource {
  const records = (manifest.records ?? {}) as Record<string, unknown>
  const results = toList(records.results)
  const reader = toList(records.reader)

  // ---- canonical ----
  const canonical = pickResult<{ objects?: { characters?: RawCanonicalCharacter[] } }>(results, ':canonical')
  const characters = (canonical?.objects?.characters ?? []).filter(
    (c): c is RawCanonicalCharacter => !!c && !!c.id
  )

  // ---- 关系（成对，A/B 两侧都要收）----
  const relations: RawRelationPair[] = []
  for (const r of results) {
    if (typeof r.key !== 'string' || !r.key.includes(':characterRelation')) continue
    const d = unwrap<{ characterRelations?: RawRelationPair[] }>(r.value)
    for (const p of d?.characterRelations ?? []) {
      if (p && p.characterA?.name && p.characterB?.name) relations.push(p)
    }
  }

  // ---- 形象元数据：两个来源合并 ----
  const appearanceMeta = new Map<string, Map<string, RawAppearance>>()
  const ensureMeta = (charId: string): Map<string, RawAppearance> => {
    let m = appearanceMeta.get(charId)
    if (!m) {
      m = new Map()
      appearanceMeta.set(charId, m)
    }
    return m
  }
  // 来源 1：:characterAppearance 记录（实测形状是 { <charId>: RawAppearance[] } 或数组）
  const appRec = pickResult<Record<string, RawAppearance | RawAppearance[]>>(results, ':characterAppearance')
  if (appRec && typeof appRec === 'object') {
    for (const [charId, val] of Object.entries(appRec)) {
      const list = Array.isArray(val) ? val : [val]
      const m = ensureMeta(charId)
      for (const ap of list) {
        if (ap?.appearanceId && !m.has(ap.appearanceId)) m.set(ap.appearanceId, ap)
      }
    }
  }
  // 来源 2：canonical 内嵌的 characterAppearances
  for (const c of characters) {
    if (!c.id || !Array.isArray(c.characterAppearances)) continue
    const m = ensureMeta(c.id)
    for (const ap of c.characterAppearances) {
      if (ap?.appearanceId) m.set(ap.appearanceId, { ...m.get(ap.appearanceId), ...ap })
    }
  }

  // ---- 立绘 ----
  const imagesByChar = new Map<string, { appearanceId: string; imagePath: string }[]>()
  const charImages = pickReader<Record<string, unknown>>(reader, ':character-images')
  if (charImages && typeof charImages === 'object') {
    for (const [charId, val] of Object.entries(charImages)) {
      const list = Array.isArray(val) ? val : [val]
      const out: { appearanceId: string; imagePath: string }[] = []
      for (const e of list as { appearanceId?: string; id?: string; imagePath?: string }[]) {
        const apId = e?.appearanceId ?? e?.id ?? ''
        if (apId && e?.imagePath) out.push({ appearanceId: apId, imagePath: e.imagePath })
      }
      if (out.length) imagesByChar.set(charId, out)
    }
  }

  // ---- 音色 ----
  const voices = new Map<string, RawVoice>()
  for (const r of reader) {
    if (typeof r.key !== 'string' || !r.key.includes(':dubbing:voice:')) continue
    const v = unwrap<RawVoice>(r.value)
    if (!v) continue
    const i = r.key.indexOf(':dubbing:voice:')
    const charId = v.characterId ?? r.key.slice(i + ':dubbing:voice:'.length)
    if (charId) voices.set(charId, v)
  }

  // ---- 世界观 ----
  const wi = pickResult<{ novelGenre?: string; worldImpression?: string; visualImpression?: string }>(
    results,
    ':worldImpression'
  )

  return {
    characters,
    relations,
    appearanceMeta,
    imagesByChar,
    voices,
    actionCounts: opts?.actionCounts ?? new Map(),
    novelGenre: typeof wi?.novelGenre === 'string' ? wi.novelGenre : '',
    worldImpression: typeof wi?.worldImpression === 'string' ? wi.worldImpression : '',
    projectTitle: opts?.projectTitle ?? '',
    urlOf
  }
}

/** 把 canonical 人物 + 材料合成为完整角色卡。 */
export function buildCharacterCards(src: CardSource, now = new Date()): CharacterCard[] {
  const idByName = new Map<string, string>()
  for (const c of src.characters) if (c.id && c.name) idByName.set(c.name, c.id)

  const cards: CharacterCard[] = []
  for (const c of src.characters) {
    if (!c.id) continue
    const name = c.name ?? c.id

    // ---- 立绘 ----
    const meta = src.appearanceMeta.get(c.id)
    const imgs = src.imagesByChar.get(c.id) ?? []
    const seen = new Set<string>()
    const portraits: CardPortrait[] = []
    const pushPortrait = (apId: string, imagePath: string | null): void => {
      if (!apId || seen.has(apId)) return
      seen.add(apId)
      const m = meta?.get(apId)
      portraits.push({
        appearanceId: apId,
        name: m?.name ?? apId,
        sex: m?.sex ?? '',
        appearanceSummary: m?.appearanceSummary ?? '',
        visualKeywords: (m?.visualKeywords ?? []).filter((k): k is string => typeof k === 'string' && !!k),
        imagePath,
        imageUrl: src.urlOf(imagePath),
        isDefault: false
      })
    }
    // 有图的在前（列表首图必须是图，不能是只有元数据的形象）
    for (const e of imgs) pushPortrait(e.appearanceId, e.imagePath)
    for (const apId of meta?.keys() ?? []) pushPortrait(apId, null)
    if (portraits.length) portraits[0].isDefault = true

    // ---- 音色 ----
    const rv = src.voices.get(c.id)
    const voice: CardVoice | null = rv
      ? {
          voiceType: rv.vt ?? '',
          description: rv.vi ?? '',
          samplePath: rv.path ?? '',
          sampleUrl: rv.path ? (src.urlOf(rv.path) ?? '') : ''
        }
      : null

    // ---- 关系（从该角色视角；A/B 两侧都收集）----
    const relations: CardRelation[] = []
    for (const p of src.relations) {
      const aName = p.characterA?.name ?? ''
      const bName = p.characterB?.name ?? ''
      const from = Number(p.fromChapterSeq ?? 0)
      const to = Number(p.toChapterSeq ?? 0)
      if (aName === name) {
        relations.push({
          otherName: bName,
          otherCharacterId: idByName.get(bName) ?? '',
          overview: p.characterA?.relationToOther?.overview ?? '',
          summary: p.characterA?.relationToOther?.summary ?? p.relationSummary ?? '',
          fromChapter: from,
          toChapter: to
        })
      } else if (bName === name) {
        relations.push({
          otherName: aName,
          otherCharacterId: idByName.get(aName) ?? '',
          overview: p.characterB?.relationToOther?.overview ?? '',
          summary: p.characterB?.relationToOther?.summary ?? p.relationSummary ?? '',
          fromChapter: from,
          toChapter: to
        })
      }
    }
    // 同一对可能因 chunk 不同而出现多次：按对方名去重，保留第一个有 overview 的
    const relSeen = new Set<string>()
    const relDedup = relations.filter((r) => {
      const k = r.otherName
      if (!k || relSeen.has(k)) return false
      relSeen.add(k)
      return true
    })

    const identInfos = (c.identInfos ?? []).filter((s): s is string => typeof s === 'string' && !!s)
    const aliases = (c.aliases ?? []).filter((s): s is string => typeof s === 'string' && !!s)
    const profile = c.summary ?? ''
    const appearanceChapters = (c.appearanceChapterSeqs ?? []).filter((n) => Number.isFinite(n))
    const defaultPortrait = portraits[0]
    const actionCount = src.actionCounts.get(c.id) ?? 0

    // ---- 酒馆用的 5 个文本字段 ----
    // 这些字段的目标是「进酒馆能直接聊」，所以用中文自然语言写，不用 JSON。
    const descParts: string[] = []
    if (identInfos.length) descParts.push(`身份：${identInfos.join('；')}。`)
    if (profile) descParts.push(profile)
    if (defaultPortrait?.appearanceSummary) descParts.push(`外貌：${defaultPortrait.appearanceSummary}`)
    if (relDedup.length) {
      descParts.push(
        `关系：${relDedup.map((r) => `${r.otherName}（${r.overview || '有关联'}）`).join('、')}。`
      )
    }
    if (c.lifeStatus) descParts.push(`当前状态：${c.lifeStatus}。`)

    const personality = buildPersonality(profile, identInfos, relDedup)
    const scenario = buildScenario(src, name, appearanceChapters)
    const firstMes = buildFirstMes(name, profile, identInfos, relDedup)

    cards.push({
      id: c.id,
      name,
      aliases,
      importanceLevel: c.importanceLevel ?? '',
      identInfos,
      profile,
      lifeStatus: c.lifeStatus ?? '',
      appearanceChapters,
      portraits,
      voice,
      relations: relDedup,
      actionCount,
      description: descParts.join('\n'),
      personality,
      scenario,
      firstMes,
      mesExample: '',
      creatorNotes: `由 DreamWeave 从《${src.projectTitle || '本地书库'}》自动生成；人物档案与关系均取自包内 canonical 产物。`,
      systemPrompt: '',
      creator: 'DreamWeave',
      cardVersion: '1.0',
      createdAt: now.toISOString(),
      sourceTitle: src.projectTitle,
      novelGenre: src.novelGenre
    })
  }

  return cards.sort((a, b) => b.actionCount - a.actionCount || a.name.localeCompare(b.name, 'zh'))
}

/**
 * 性格字段：canonical 没有独立的「性格」产物。
 *
 * 与其编造，不如从**已有事实**归纳成可读短句：身份标签 + 关系里的自我定位
 * （「忠贞的未婚妻」「赏识并营救」这类 overview 本身就是别人视角下的性格评价）。
 * 这比让 LLM 现编一段更忠实，也不需要额外调用。
 */
function buildPersonality(profile: string, identInfos: string[], relations: CardRelation[]): string {
  const parts: string[] = []
  if (identInfos.length) parts.push(identInfos.join('；'))
  const selfViews = relations
    .map((r) => r.overview)
    .filter((s) => !!s)
    .slice(0, 5)
  if (selfViews.length) parts.push(`在他人眼中：${selfViews.join('、')}`)
  // 从档案里取首句作为行为特征线索（canonical 的 summary 首句通常是人物定位）
  const firstSentence = profile.split(/[。；]/).map((s) => s.trim()).find((s) => s.length > 0) ?? ''
  if (firstSentence) parts.push(firstSentence)
  return parts.join('。')
}

/** 场景字段：首个出场章 + 世界观，给酒馆一个明确的「从哪儿开始」。 */
function buildScenario(src: CardSource, name: string, chapters: number[]): string {
  const ch = chapters.length ? Math.min(...chapters) : 0
  const where = ch ? `第 ${ch} 章` : '故事开头'
  const genre = src.novelGenre ? `这是一部${src.novelGenre}。` : ''
  return `${genre}你与「${name}」的对话开始于${where}的节点。${src.worldImpression.slice(0, 300)}`
}

/**
 * 开场白：酒馆进入对话时角色说的第一句。
 *
 * 用「向玩家搭话」的口吻，把身份标签融进去，避免生成一段没人称旁白
 * （酒馆里 first_mes 是角色**说出口**的话，不是设定说明）。
 */
function buildFirstMes(name: string, profile: string, identInfos: string[], relations: CardRelation[]): string {
  const tag = identInfos[0] ?? ''
  const rel = relations[0]
  const lines: string[] = []
  lines.push(tag ? `我是${name}，${tag}。` : `我是${name}。`)
  if (rel) lines.push(`眼下最要紧的，是${rel.otherName}的事。`)
  const hook = profile.split(/[。]/).map((s) => s.trim()).filter(Boolean)[0]
  if (hook) lines.push(`${hook}。`)
  lines.push('你想问什么，尽管说。')
  return lines.join('')
}

/** 列表项投影（不含大字段，列表页不必要把 20 份档案全传过去）。 */
export function toCardSummary(card: CharacterCard): CharacterCardSummary {
  return {
    id: card.id,
    name: card.name,
    aliases: card.aliases,
    importanceLevel: card.importanceLevel,
    identInfos: card.identInfos,
    avatarUrl: card.portraits.find((p) => p.imageUrl)?.imageUrl ?? null,
    actionCount: card.actionCount,
    portraitCount: card.portraits.length,
    hasVoice: !!card.voice,
    relationCount: card.relations.length
  }
}

/**
 * 从角色卡构建世界书条目。
 *
 * 三类：
 *   1) 每个人物一条（keys = 名字 + 别名）—— 酒馆里提到谁就注入谁的档案；
 *   2) 每组关系一条（keys = 双方名字）—— 提到这层关系时注入语境；
 *   3) 一条世界观条目（constant，永远注入）。
 *
 * 为什么不把关系塞进人物条目：一条里既有 A 又有 B，一旦这两条都命中就会
 * 重复注入同一段（SillyTavern 会按条目去重，但内容重复仍会占 token）。
 */
export function buildLorebook(cards: CharacterCard[], src: CardSource): LorebookEntry[] {
  const out: LorebookEntry[] = []
  let order = 100

  for (const c of cards) {
    const keys = [c.name, ...c.aliases].filter(Boolean)
    const body: string[] = []
    if (c.identInfos.length) body.push(`身份：${c.identInfos.join('；')}`)
    if (c.profile) body.push(c.profile)
    const ap = c.portraits[0]?.appearanceSummary
    if (ap) body.push(`外貌：${ap}`)
    if (c.lifeStatus) body.push(`当前状态：${c.lifeStatus}`)
    out.push({
      id: `char:${c.id}`,
      name: c.name,
      keys,
      content: body.join('\n'),
      constant: false,
      insertionOrder: order++,
      source: 'character'
    })
  }

  for (const p of src.relations) {
    const aName = p.characterA?.name ?? ''
    const bName = p.characterB?.name ?? ''
    if (!aName || !bName) continue
    const text = p.relationSummary ?? p.characterA?.relationToOther?.summary ?? ''
    if (!text) continue
    out.push({
      id: `rel:${aName}::${bName}:${p.fromChapterSeq ?? 0}-${p.toChapterSeq ?? 0}`,
      name: `${aName} × ${bName}`,
      keys: [aName, bName],
      content:
        `${aName}对${bName}：${p.characterA?.relationToOther?.overview ?? ''}\n` +
        `${bName}对${aName}：${p.characterB?.relationToOther?.overview ?? ''}\n` +
        text,
      constant: false,
      insertionOrder: order++,
      source: 'relation'
    })
  }

  if (src.worldImpression || src.novelGenre) {
    out.push({
      id: 'world:main',
      name: '世界观',
      keys: [],
      content: [src.novelGenre ? `题材：${src.novelGenre}` : '', src.worldImpression].filter(Boolean).join('\n'),
      constant: true,
      insertionOrder: 1,
      source: 'world'
    })
  }

  return out
}

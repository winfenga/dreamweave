/**
 * 角色卡 + 酒馆的主进程服务（IPC 背后的实现）。
 *
 * 职责边界：
 *   - 读包 → 构建卡片/世界书（`build.ts`）；
 *   - 导出 PNG/JSON（`export.ts`）；
 *   - 会话持久化（存到工作库目录下的 `records/cards/`，跟书走，不跟人走）；
 *   - 代调 LLM（`tavern.ts`）。
 *
 * 【会话存哪儿】存在**工作库目录**（`<workspace>/cards/sessions.json`）而不是
 * appData 全局配置里：角色卡来自这本书，换书就该换一套会话；
 * 放全局会导致「打开另一本书还能看到上一本角色的对话」这种荒诞状态。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
  CardExportRequest,
  CardExportResult,
  CharacterCard,
  CharacterCardListResult,
  CharacterCardResult,
  LorebookEntry,
  TavernGenerateRequest,
  TavernGenerateResult,
  TavernMessage,
  TavernSaveResult,
  TavernSession,
  TavernSettings
} from '../../shared/character-card-types'
import type { T2wManifest } from '../../shared/t2w-types'
import { buildCharacterCards, buildLorebook, collectCardSource, toCardSummary } from './build'
import { buildPngCard, cardToV2Json, makePlaceholderPng } from './export'
import { defaultTavernSettings, generateTavernReply } from './tavern'

/** 会话文件的相对位置（相对工作库根） */
const SESSION_DIR = 'cards'
const SESSION_FILE = 'cards/tavern-sessions.json'

/** 一次构建的缓存（同一 manifest 反复点列表不必重解） */
interface CardCache {
  /** 缓存键：manifest 的 project.revisionId + charCount，换版本即失效 */
  key: string
  cards: CharacterCard[]
  lorebook: LorebookEntry[]
}
let cache: CardCache | null = null

function cacheKeyOf(manifest: T2wManifest): string {
  const p = manifest.project
  return `${p.id}|${p.revisionId}|${p.charCount}|${manifest.files?.length ?? 0}`
}

/**
 * 取（或构建）角色卡集合。
 *
 * 缓存键里放 `revisionId`：同一本书编辑后 revision 会变，缓存自然失效；
 * 只放 project.id 的话会一直拿到旧卡片。
 */
export function getCards(manifest: T2wManifest, assetBase: string): { cards: CharacterCard[]; lorebook: LorebookEntry[] } {
  const key = cacheKeyOf(manifest)
  if (cache && cache.key === key) return { cards: cache.cards, lorebook: cache.lorebook }

  const urlOf = (entryPath: string | null): string | null => (entryPath ? assetBase + entryPath : null)
  const src = collectCardSource(manifest, urlOf, { projectTitle: manifest.project?.title ?? '' })
  const cards = buildCharacterCards(src)
  const lorebook = buildLorebook(cards, src)
  cache = { key, cards, lorebook }
  return { cards, lorebook }
}

/** 清缓存（切书/重新导入时调）。 */
export function invalidateCardCache(): void {
  cache = null
}

// ---------------------------------------------------------------------------
// 列表 / 详情
// ---------------------------------------------------------------------------

export function listCards(manifest: T2wManifest, assetBase: string): CharacterCardListResult {
  try {
    const { cards } = getCards(manifest, assetBase)
    return {
      ok: true,
      items: cards.map(toCardSummary),
      stats: {
        cardCount: cards.length,
        withVoice: cards.filter((c) => c.voice).length,
        withPortrait: cards.filter((c) => c.portraits.some((p) => p.imageUrl)).length,
        relationCount: cards.reduce((s, c) => s + c.relations.length, 0)
      }
    }
  } catch (e) {
    return { ok: false, error: `角色卡构建失败：${(e as Error).message}` }
  }
}

export async function getCard(
  manifest: T2wManifest,
  assetBase: string,
  workspaceRoot: string | null,
  cardId: string
): Promise<CharacterCardResult> {
  try {
    const { cards, lorebook } = getCards(manifest, assetBase)
    const card = cards.find((c) => c.id === cardId)
    if (!card) return { ok: false, error: `未找到角色卡：${cardId}` }
    // 只返回与该角色相关的世界书条目（全量可能上百条，界面用不上）
    const related = lorebook.filter(
      (e) => e.id === `char:${cardId}` || e.constant || (e.source === 'relation' && e.keys.includes(card.name))
    )
    const session = workspaceRoot ? await loadSession(workspaceRoot, cardId) : null
    return { ok: true, card, lorebook: related, session }
  } catch (e) {
    return { ok: false, error: `读取角色卡失败：${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

/**
 * 导出角色卡。
 *
 * PNG 走 SillyTavern 官方做法（立绘 + tEXt 内嵌 JSON）；
 * 角色没有立绘时用**生成的占位图**，而不是拒绝导出 ——
 * 一张没立绘的卡仍然可以是有用的（设定、世界书、开场白都在）。
 */
export async function exportCards(
  manifest: T2wManifest,
  assetBase: string,
  req: CardExportRequest,
  readEntry: (entryPath: string) => Promise<Uint8Array | null>,
  outDir: string
): Promise<CardExportResult> {
  try {
    const { cards, lorebook } = getCards(manifest, assetBase)
    await mkdir(outDir, { recursive: true })

    const paths: string[] = []
    const skipped: { cardId: string; reason: string }[] = []

    for (const id of req.cardIds) {
      const card = cards.find((c) => c.id === id)
      if (!card) {
        skipped.push({ cardId: id, reason: '角色卡不存在' })
        continue
      }
      const safeName = sanitizeFileName(card.name) || card.id
      const relatedLore = lorebook.filter(
        (e) => e.id === `char:${id}` || e.constant || (e.source === 'relation' && e.keys.includes(card.name))
      )

      if (req.format === 'json') {
        const json = cardToV2Json(card, relatedLore)
        const p = join(outDir, `${safeName}.json`)
        await writeFile(p, JSON.stringify(json, null, 2), 'utf8')
        paths.push(p)
        continue
      }

      // PNG：优先用指定形象 → 默认形象 → 任意有图的形象 → 占位图
      const preferred =
        (req.portraitAppearanceId
          ? card.portraits.find((p) => p.appearanceId === req.portraitAppearanceId)
          : null) ??
        card.portraits.find((p) => p.imagePath) ??
        null
      let pngBytes: Uint8Array | null = null
      if (preferred?.imagePath) {
        pngBytes = await readEntry(preferred.imagePath)
      }
      if (!pngBytes) pngBytes = makePlaceholderPng(512)

      const out = buildPngCard(card, pngBytes, relatedLore)
      if (!out) {
        // 底图不是合法 PNG（例如包内放的是 jpg）→ 明确跳过，不产出坏文件
        skipped.push({ cardId: id, reason: '底图不是合法 PNG，无法内嵌卡片数据（请改用 JSON 导出）' })
        continue
      }
      const p = join(outDir, `${safeName}.png`)
      await writeFile(p, out)
      paths.push(p)
    }

    return { ok: paths.length > 0, paths, skipped: skipped.length ? skipped : undefined }
  } catch (e) {
    return { ok: false, error: `导出失败：${(e as Error).message}` }
  }
}

/** 文件名清洗：去掉 Windows 非法字符，避免「导出成功但打不开」。 */
export function sanitizeFileName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80)
}

// ---------------------------------------------------------------------------
// 会话持久化
// ---------------------------------------------------------------------------

interface SessionFile {
  version: 1
  sessions: TavernSession[]
  settings?: TavernSettings
}

async function readSessionFile(root: string): Promise<SessionFile> {
  const p = join(root, SESSION_FILE)
  if (!existsSync(p)) return { version: 1, sessions: [] }
  try {
    const raw = await readFile(p, 'utf8')
    const d = JSON.parse(raw) as SessionFile
    if (!d || !Array.isArray(d.sessions)) return { version: 1, sessions: [] }
    return { version: 1, sessions: d.sessions, settings: d.settings }
  } catch {
    // 损坏的会话文件不该让整个角色卡功能不可用：当作空
    return { version: 1, sessions: [] }
  }
}

async function writeSessionFile(root: string, file: SessionFile): Promise<void> {
  await mkdir(join(root, SESSION_DIR), { recursive: true })
  await writeFile(join(root, SESSION_FILE), JSON.stringify(file, null, 2), 'utf8')
}

export async function loadSession(root: string, cardId: string): Promise<TavernSession | null> {
  const f = await readSessionFile(root)
  return f.sessions.find((s) => s.cardId === cardId) ?? null
}

export async function saveSession(
  root: string,
  cardId: string,
  messages: TavernMessage[],
  params: TavernSession['params']
): Promise<TavernSaveResult> {
  try {
    const f = await readSessionFile(root)
    const now = Date.now()
    const idx = f.sessions.findIndex((s) => s.cardId === cardId)
    const next: TavernSession = {
      id: idx >= 0 ? f.sessions[idx].id : `tavern-${cardId}-${now}`,
      cardId,
      messages,
      params,
      createdAt: idx >= 0 ? f.sessions[idx].createdAt : now,
      updatedAt: now
    }
    if (idx >= 0) f.sessions[idx] = next
    else f.sessions.push(next)
    await writeSessionFile(root, f)
    return { ok: true, session: next }
  } catch (e) {
    return { ok: false, error: `保存对话失败：${(e as Error).message}` }
  }
}

export async function loadTavernSettings(root: string): Promise<TavernSettings> {
  const f = await readSessionFile(root)
  return f.settings ?? defaultTavernSettings()
}

export async function saveTavernSettings(root: string, settings: TavernSettings): Promise<{ ok: boolean; error?: string }> {
  try {
    const f = await readSessionFile(root)
    f.settings = settings
    await writeSessionFile(root, f)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `保存设置失败：${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// 对话
// ---------------------------------------------------------------------------

/**
 * 生成一条回复。
 *
 * 这里只做「取卡片 → 校验 → 转交 tavern.ts」；真正拼请求体在 tavern.ts，
 * 便于那边被单测覆盖（本文件依赖 electron/文件系统，不好直接测）。
 */
export async function tavernGenerate(
  manifest: T2wManifest,
  assetBase: string,
  root: string | null,
  req: TavernGenerateRequest,
  provider: { id: string; label: string; baseURL: string; apiKey: string; model: string; enabled: boolean; providerKind?: string } | null
): Promise<TavernGenerateResult> {
  try {
    const { cards, lorebook } = getCards(manifest, assetBase)
    const card = cards.find((c) => c.id === req.cardId)
    if (!card) return { ok: false, error: `未找到角色卡：${req.cardId}` }

    if (!provider) return { ok: false, error: '尚未配置模型接入（设置 → 模型接入）' }

    const settings: TavernSettings = root
      ? await loadTavernSettings(root)
      : defaultTavernSettings()

    // 世界书匹配与请求体构造都在 tavern.ts 里做（那边有单测覆盖）。
    // 这里只负责：取卡片、读设置、转交、把结果原样带回（含 usedParams/loreHits 回显）。
    const r = await generateTavernReply(
      card,
      req.messages,
      req.params,
      lorebook,
      { ...settings, useLorebook: req.useLorebook },
      provider as never
    )
    return r
  } catch (e) {
    return { ok: false, error: `对话失败：${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// 杂项
// ---------------------------------------------------------------------------

/** 列出某工作库已有的会话（供「继续上次对话」）。 */
export async function listSessions(root: string): Promise<TavernSession[]> {
  const f = await readSessionFile(root)
  return f.sessions
}

/** 生成默认导出目录名（`<outDir>/cards-<书名>` 由调用方拼）。 */
export function defaultExportDirName(title: string): string {
  return sanitizeFileName(`角色卡-${title || '未命名'}-${new Date().toISOString().slice(0, 10)}`)
}

/** 读取某个目录下的文件清单（导出后给界面显示用）。 */
export async function listExported(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir)
    return names.map((n) => join(dir, basename(n)))
  } catch {
    return []
  }
}

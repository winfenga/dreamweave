/**
 * 漫画编排的 IPC 服务：把数据层（index.ts）与写回层（write.ts）接到真实工作库。
 *
 * 与 `character-card/index.ts` 同一套结构：读 manifest → 投影 → 需要写时走工作库分片。
 */
import { join } from 'node:path'
import type { T2wManifest } from '../../shared/t2w-types'
import type { MangaViewData } from '../../shared/manga-types'
import type {
  ChapterMusicCard,
  PageProduction,
  PageVoiceCard,
  ProductionOverview
} from './index'
import {
  buildMusicCard,
  buildOverview,
  buildPageProduction,
  buildPageVoices,
  estimateMp3DurationSec
} from './index'
import { saveChapterMusic, saveVoiceProfile, writeRedubClips } from './write'
import type { MusicEditInput, MusicEditResult, RedubResult, VoiceEditInput, VoiceEditResult } from './write'
import { readAsset } from '../workspace/assets'
import { ttsSpeakBytes } from '../tts'

/** 编排页的完整数据包 */
export interface ProductionPageResult {
  ok: boolean
  error?: string
  overview?: ProductionOverview
  page?: PageProduction
  voices?: PageVoiceCard[]
  music?: ChapterMusicCard
}

/** 时长缓存（按 t2w:// URL）：同一 URL 只读一次音频头 */
const durationCache = new Map<string, number>()

/** 读音频字节并估算时长；失败返回 0（界面显示「—」，不算错误）。 */
async function durationOf(root: string, entryPath: string, url: string): Promise<number> {
  const hit = durationCache.get(url)
  if (hit !== undefined) return hit
  try {
    const buf = await readAsset(root, entryPath)
    const d = estimateMp3DurationSec(buf)
    durationCache.set(url, d)
    return d
  } catch {
    durationCache.set(url, 0)
    return 0
  }
}

/** 从 MangaViewData 里抽出「页」用于对齐的最小信息（与 t2w/manga 的字段一致）。 */
function pagesOf(view: MangaViewData, chapterSeq: number) {
  const ch = view.chapters.find((c) => c.chapterSeq === chapterSeq)
  return ch?.pages ?? []
}

/**
 * 取编排页数据。
 *
 * 时长需要读音频头部，因此按「当前页涉及的 clip」**按需**读，不一次性读全书
 * （gmzz-10 有 30 段还好，但长漫画可能上千段，全读会卡住界面）。
 */
export async function getProductionPage(
  manifest: T2wManifest,
  view: MangaViewData,
  root: string,
  chapterSeq: number,
  pageNo: number
): Promise<ProductionPageResult> {
  try {
    const overview = buildOverview(view)
    const page = buildPageProduction(view, chapterSeq, pageNo)
    if (!page) return { ok: false, error: `没有第 ${chapterSeq} 章第 ${pageNo} 页` }

    // 按需读本页段的时长
    const pages = pagesOf(view, chapterSeq)
    const pageObj = pages.find((p) => p.no === pageNo) ?? pages[0]
    const durations = new Map<string, number>()
    if (pageObj) {
      for (const s of page.segments) {
        if (!s.url) continue
        // 从 URL 反推 entryPath 不靠谱（t2w://<assetKey>/<entryPath>），
        // 直接用 clip 的 path 更准确；这里用 dubbing 表反查
        const clip = view.dubbing.find((c) => c.chapterSeq === chapterSeq && c.url === s.url)
        const entryPath = clip?.path
        if (entryPath) durations.set(s.url, await durationOf(root, entryPath, s.url))
      }
    }
    // 把时长写回段
    const pageWithDur: PageProduction = {
      ...page,
      segments: page.segments.map((s) => ({ ...s, durationSec: durations.get(s.url) ?? s.durationSec }))
    }

    const voices = buildPageVoices(view, pageWithDur)
    const music = buildMusicCard(manifest, chapterSeq)
    return { ok: true, overview, page: pageWithDur, voices, music }
  } catch (e) {
    return { ok: false, error: `读取编排数据失败：${(e as Error).message}` }
  }
}

/** 保存音色（走工作库分片）。 */
export async function savePageVoice(root: string, input: VoiceEditInput): Promise<VoiceEditResult> {
  return saveVoiceProfile(root, input)
}

/**
 * 重新配音：对指定段逐段合成，然后一次性写回。
 *
 * 【为什么先全合成再写】写回是"全或无"的更安全：
 * 若边合成边写，中途失败会留下「前几段是新音频、后面还是旧的」的混合状态，
 * 用户很难察觉，也会让 fingerprint 与音频错配。这里先把所有音频拿到内存，
 * 再一次性写 clip，失败则不落盘。
 */
export async function redubPage(
  root: string,
  view: MangaViewData,
  chapterSeq: number,
  pageNo: number,
  voiceOf: (characterId: string) => string | undefined,
  onProgress?: (done: number, total: number) => void
): Promise<RedubResult & { synthesized?: number }> {
  try {
    const page = buildPageProduction(view, chapterSeq, pageNo)
    if (!page) return { ok: false, error: `没有第 ${chapterSeq} 章第 ${pageNo} 页` }
    if (!page.alignExact) {
      return {
        ok: false,
        error: `本页段落与配音段无法安全对齐（${page.alignReason ?? '数量不一致'}），已拒绝写回以免错配。`
      }
    }
    const targets = page.segments.filter((s) => s.text.trim())
    if (!targets.length) return { ok: false, error: '本页没有可配音的文本' }

    const clips: { order: number; bytes: Buffer; ext: string }[] = []
    let done = 0
    for (const seg of targets) {
      const voice = voiceOf(seg.characterId) || undefined
      const r = await ttsSpeakBytes(seg.text, { voice })
      if (!r.ok || !r.bytes) {
        return {
          ok: false,
          error: `第 ${seg.index + 1} 段合成失败：${r.error ?? '未知错误'}（已中止，未写回任何更改）`
        }
      }
      clips.push({ order: seg.index + 1_000_000, bytes: r.bytes, ext: r.ext || 'mp3' })
      done++
      onProgress?.(done, targets.length)
    }

    const written = await writeRedubClips(root, { chapterSeq, clips })
    if (!written.ok) return written
    return { ...written, synthesized: clips.length }
  } catch (e) {
    return { ok: false, error: `重新配音失败：${(e as Error).message}` }
  }
}

/** 换章级配乐。 */
export async function saveMusic(root: string, input: MusicEditInput): Promise<MusicEditResult> {
  return saveChapterMusic(root, input)
}

/** 清时长缓存（重新配音后时长会变）。 */
export function invalidateDurations(): void {
  durationCache.clear()
}

/** 供调试：本机工作库根下的临时音频目录 */
export function tmpAudioDir(root: string): string {
  return join(root, 'tmp-audio')
}

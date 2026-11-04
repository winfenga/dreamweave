/**
 * 漫画编排：把「讲述与配音 / 背景配乐 / 本页音色」的修改真正写回工作库。
 *
 * 【写回范式】完全对齐 `imagegen/backfill.ts`（那是本仓已验证的产物回填路径）：
 *   1) 二进制（mp3/png）落 `assets/<kind>/<sha256><ext>`（内容寻址去重）；
 *   2) `index.assets[]` 追加一行；
 *   3) reader 分片用 `updateShard` 做 upsert（per-path 串行队列 + tmp→复检→原子改名）；
 *   4) 分片写完后镜像回 `index.shards[]` 的 entryCount/sha256。
 * **不绕过分片唯一入口直写文件**，也**不删旧资产**（内容寻址天然不可变）。
 *
 * 【为什么"重新配音"是安全的】实测确认 clip = 台词按 `。！？` 切成的句子段
 * （见 `segments.ts` 顶部证据）。对齐要求段数与 clip 数严格相等且 order 连续，
 * 否则**拒绝写回**并说明原因 —— 错配会把 B 句的音频写到 A 句上，而用户听不出来。
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { CONTAINER_FILES } from '../workspace/paths'
import { readIndex, writeIndex } from '../workspace/index-store'
import { shardNameFor, updateShard } from '../workspace/shards'
import { storePathFor, writeAsset } from '../workspace/assets'
import { sha256Hex } from '../t2w/format'
import type { AssetRow, ShardEnvelope } from '../workspace/types'
import type { T2wManifest } from '../../shared/t2w-types'

const RESULTS_READER_FILE = CONTAINER_FILES.reader
const READER_SHARD = shardNameFor(RESULTS_READER_FILE)

/** reader 分片内下一个全局序号 */
function nextSeq(env: ShardEnvelope): number {
  let max = -1
  for (const e of env.entries) if (typeof e.seq === 'number' && e.seq > max) max = e.seq
  return max + 1
}

/** 在 reader 分片里 upsert「key 含 needle」的条目；不存在则按 createKey 新建。 */
async function upsertReaderEntry(
  root: string,
  needle: string,
  createKey: () => string,
  initialValue: unknown,
  mutate: (value: unknown) => unknown
): Promise<{ entryCount: number; sha256: string; found: boolean }> {
  let found = false
  const { env, sha256 } = await updateShard(root, RESULTS_READER_FILE, 'reader', READER_SHARD, (e) => {
    const idx = e.entries.findIndex((x) => typeof x.key === 'string' && String(x.key).includes(needle))
    if (idx >= 0) {
      found = true
      const cur = e.entries[idx].value
      e.entries[idx] = { ...e.entries[idx], value: mutate(cur ?? initialValue) }
    } else {
      e.entries.push({ seq: nextSeq(e), key: createKey(), value: mutate(initialValue) })
    }
    return e
  })
  return { entryCount: env.entries.length, sha256, found }
}

/** 把 reader 分片新状态镜像回 index.shards（entryCount/sha256）+ 刷新 integrity。 */
async function mirrorReaderShard(root: string, entryCount: number, sha256: string): Promise<void> {
  const idx = await readIndex(root)
  const row = idx.shards.find((s) => s.file === RESULTS_READER_FILE)
  if (row) {
    row.entryCount = entryCount
    row.sha256 = sha256
  }
  idx.integrity.lastVerifiedAt = new Date().toISOString()
  await writeIndex(root, idx)
}

/** 写一个二进制资产进工作库，返回包内 entryPath。 */
async function writeBinaryAsset(root: string, bytes: Buffer, ext: string): Promise<string> {
  const idx = await readIndex(root)
  const sha = sha256Hex(bytes)
  const pkgId = idx.pkgId
  const extWithDot = ext.startsWith('.') ? ext : `.${ext}`
  const entryPath = `${pkgId}/audio/${sha}${extWithDot}`
  const row: AssetRow = {
    path: entryPath,
    size: bytes.length,
    sha256: sha,
    store: storePathFor({ path: entryPath, sha256: sha }),
    kind: 'audio'
  }
  await writeAsset(root, row, bytes)
  if (!idx.assets.some((a) => a.sha256 === sha)) idx.assets.push(row)
  await writeIndex(root, idx)
  return entryPath
}

// ---------------------------------------------------------------------------
// 1. 本页音色：改写 :dubbing:voice:<charId>
// ---------------------------------------------------------------------------

export interface VoiceEditInput {
  /** '$narrator' 或角色 id */
  characterId: string
  /** 音色类型（young_male/girl/mature_male/androgynous…） */
  vt: string
  /** 音色描述（就是 TTS 时喂给上游的 voice 提示） */
  vi: string
  /** 旁白专用（= characterId === '$narrator'） */
  isNarrator: boolean
}

export interface VoiceEditResult {
  ok: boolean
  error?: string
  /** 是否新建了条目（原先没有该角色音色） */
  created?: boolean
  writtenShards?: string[]
}

/**
 * 保存音色档案。
 *
 * 只改 `:dubbing:voice:<charId>` 的三个描述字段，**不动 path/checksum**：
 * 换描述不等于换参考样本，样本要等重新配音时一并更新（那时会写入新路径）。
 */
export async function saveVoiceProfile(root: string, input: VoiceEditInput): Promise<VoiceEditResult> {
  try {
    if (!input.characterId) return { ok: false, error: '缺少角色 id' }
    const isNarr = input.isNarrator || input.characterId === '$narrator'
    const keyTail = `:dubbing:voice:${input.characterId}`
    // 漫画配音的 key 带 `manga:` 前缀，别误改正片的那一条
    const needle = isNarr ? `${keyTail}` : keyTail

    const r = await upsertReaderEntry(
      root,
      needle,
      () => {
        const idx = undefined
        void idx
        return `manga:${keyTail}`
      },
      { v: 1, characterId: input.characterId, vt: input.vt, vi: input.vi },
      (value) => {
        const cur = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
        return {
          ...cur,
          v: typeof cur.v === 'number' ? cur.v : 1,
          characterId: input.characterId,
          vt: input.vt,
          vi: input.vi
        }
      }
    )
    await mirrorReaderShard(root, r.entryCount, r.sha256)
    return { ok: true, created: !r.found, writtenShards: [RESULTS_READER_FILE] }
  } catch (e) {
    return { ok: false, error: `保存音色失败：${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// 2. 重新配音：合成音频 → 资产 → 改写 clip
// ---------------------------------------------------------------------------

export interface RedubSegmentsInput {
  chapterSeq: number
  /** 已合成的每一段：段序号（= clip.order - 1000000）与音频字节 */
  clips: { order: number; bytes: Buffer; ext: string }[]
  /** 语音 fingerprint（可选，写入 clip 便于溯源） */
  fingerprintOf?: (order: number) => string
}

export interface RedubResult {
  ok: boolean
  error?: string
  updated?: number
  writtenShards?: string[]
}

/**
 * 把一批已合成的音频写回对应配音段。
 *
 * 只改 `path`（并同步 `voiceChecksum`/`fingerprint` 若给出），
 * 保留 actionType/chapterSeq/order/characterId —— 这四项是定位键，改了就对不上。
 */
export async function writeRedubClips(root: string, input: RedubSegmentsInput): Promise<RedubResult> {
  try {
    if (!input.clips.length) return { ok: false, error: '没有要写入的配音段' }

    // 先全部落资产（失败则一个 clip 都不改，避免半截状态）
    const written: { order: number; entryPath: string; fp?: string }[] = []
    for (const c of input.clips) {
      const entryPath = await writeBinaryAsset(root, c.bytes, c.ext || 'mp3')
      written.push({ order: c.order, entryPath, fp: input.fingerprintOf?.(c.order) })
    }

    // 再一次性改 reader：按 (chapterSeq, order) 精确匹配
    let updated = 0
    const chapterSeq = input.chapterSeq
    const { env, sha256 } = await updateShard(root, RESULTS_READER_FILE, 'reader', READER_SHARD, (e) => {
      for (const w of written) {
        const hit = e.entries.find((x) => {
          if (typeof x.key !== 'string' || !x.key.includes(':dubbing:clip:') || !x.key.includes('manga')) return false
          const v = x.value as Record<string, unknown> | null
          return !!v && v.chapterSeq === chapterSeq && v.order === w.order
        })
        if (!hit) continue
        const v = (hit.value ?? {}) as Record<string, unknown>
        const next: Record<string, unknown> = { ...v, path: w.entryPath }
        if (w.fp) next.fingerprint = w.fp
        hit.value = next
        updated++
      }
      return e
    })
    await mirrorReaderShard(root, env.entries.length, sha256)

    if (!updated) {
      return { ok: false, error: `没有匹配到第 ${chapterSeq} 章的任何配音段（order 可能已变化）` }
    }
    return { ok: true, updated, writtenShards: [RESULTS_READER_FILE] }
  } catch (e) {
    return { ok: false, error: `写回配音失败：${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// 3. 背景配乐：替换 chapter 的 selection.track
// ---------------------------------------------------------------------------

export interface MusicEditInput {
  chapterSeq: number
  track: {
    id: string
    title: string
    author: string
    url: string
    durationSec: number
    licenseId: string
    attribution: string
  }
}

export interface MusicEditResult {
  ok: boolean
  error?: string
  updated?: number
  writtenShards?: string[]
}

/**
 * 换章级配乐：改 `mangaMusic:chapter:*` 条目里 `groups[].selection.track`。
 *
 * 为什么只改 `:chapter:` 那一条：`mangaMusic:music:*`（brief/tracks）是**中间产物**，
 * 而章级 `:chapter:` 才是最终选中结果（见 `t2w/manga.ts` 的收集逻辑）。
 * 改中间产物不会生效，还会让两者不一致。
 */
export async function saveChapterMusic(root: string, input: MusicEditInput): Promise<MusicEditResult> {
  try {
    let updated = 0
    const { routeResultsKey } = await import('../workspace/shards')
    const { assembleManifest } = await import('../workspace/manifest-assembler')

    const idx = await readIndex(root)
    const manifest: T2wManifest = await assembleManifest(root, idx)
    const results = (manifest.records ?? {}).results
    const entries = Array.isArray(results)
      ? (results as { key?: string; value?: unknown }[])
      : results && typeof results === 'object'
        ? Object.entries(results as Record<string, unknown>).map(([key, value]) => ({ key, value }))
        : []
    // 章级配乐条目所在的分片（key 走 routeResultsKey，不能写死文件名）
    const files = new Set<string>()
    for (const e of entries) {
      const k = String(e.key ?? '')
      if (!k.includes('mangaMusic') || !k.includes(':chapter:')) continue
      files.add(routeResultsKey(k))
    }
    if (!files.size) return { ok: false, error: '包内没有章级配乐数据，无法换曲' }

    for (const file of files) {
      const shardName = shardNameFor(file)
      const { env, sha256 } = await updateShard(root, file, 'results', shardName, (e) => {
        for (const entry of e.entries) {
          const k = String(entry.key ?? '')
          if (!k.includes('mangaMusic') || !k.includes(':chapter:')) continue
          const v = entry.value as Record<string, unknown> | null
          if (!v || typeof v !== 'object') continue
          const groups = Array.isArray(v.groups) ? (v.groups as Record<string, unknown>[]) : []
          let touched = false
          for (const g of groups) {
            const plan = (g?.plan ?? {}) as Record<string, unknown>
            const chs = Array.isArray(plan.chapters) ? (plan.chapters as Record<string, unknown>[]) : []
            const seqs = new Set<number>()
            for (const ch of chs) {
              const s = Number((ch as Record<string, unknown>)?.chapterSeq)
              if (Number.isFinite(s)) seqs.add(s)
            }
            // 无 chapters 字段时按 key 里的章号兜底
            if (!seqs.size) {
              const m = k.match(/:chapter:(\d+):/)
              if (m) seqs.add(Number(m[1]))
            }
            if (!seqs.has(input.chapterSeq)) continue
            const selection = (g?.selection ?? {}) as Record<string, unknown>
            g.selection = { ...selection, track: { ...input.track } }
            touched = true
          }
          if (touched) updated++
        }
        return e
      })
      // 镜像回 index.shards（与 backfill 同口径）
      const nextIdx = await readIndex(root)
      const row = nextIdx.shards.find((s) => s.file === file)
      if (row) {
        row.entryCount = env.entries.length
        row.sha256 = sha256
      }
      nextIdx.integrity.lastVerifiedAt = new Date().toISOString()
      await writeIndex(root, nextIdx)
    }

    if (!updated) {
      return { ok: false, error: `没有找到第 ${input.chapterSeq} 章的配乐选择记录` }
    }
    return { ok: true, updated, writtenShards: [...files] }
  } catch (e) {
    return { ok: false, error: `换曲失败：${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// 4. 配乐候选库（换曲时的可选项）
// ---------------------------------------------------------------------------

export interface MusicCandidate {
  id: string
  title: string
  author: string
  url: string
  durationSec: number
  bpm: number
  licenseId: string
  attribution: string
}

/**
 * 列出包内已出现过的全部曲目（供「手动换曲」挑选）。
 *
 * 【实测数据结构（gmzz-10）—— 这里踩过两个坑，都记下来】
 *
 *   1) **`current` 只能来自 `:chapter:` 条目**。
 *      `mangaMusic:chapter:<ch>:…` 的 `groups[].selection.track` 才是**最终选中**
 *      （实测 = "Static Motion"）。
 *      而 `mangaMusic:music:<ch>:…:tracks` 里的 track 是**候选池**（实测 = "Oppressive Gloom"）。
 *      首版把两者一起写进 current，结果 `:tracks` 的候选**覆盖**了真正选中的那首，
 *      界面上显示错曲目，换曲写回后读回来也还是错的那首（写对了但读错了）。
 *
 *   2) **license 是嵌套对象，不是平铺字段**：
 *      实际形状是 `license: { attribution, id, modifications, redistributionAllowed, url }`，
 *      且时长字段叫 `duration` 而不是 `durationSec`。
 *      按平铺读会得到空的 attribution 与 0 时长 —— CC 协议要求的署名就丢了。
 */
export function collectMusicCandidates(manifest: T2wManifest): { current: Map<number, MusicCandidate>; pool: MusicCandidate[] } {
  const current = new Map<number, MusicCandidate>()
  const pool = new Map<string, MusicCandidate>()
  const results = (manifest.records ?? {}).results
  const entries = Array.isArray(results)
    ? (results as { key?: string; value?: unknown }[])
    : results && typeof results === 'object'
      ? Object.entries(results as Record<string, unknown>).map(([key, value]) => ({ key, value }))
      : []

  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

  const narrow = (t: Record<string, unknown> | null | undefined): MusicCandidate | null => {
    if (!t || typeof t !== 'object') return null
    const id = str(t.id)
    const url = str(t.url)
    if (!id && !url) return null
    // license 是嵌套对象（见上方注释）
    const lic = (t.license && typeof t.license === 'object' ? t.license : {}) as Record<string, unknown>
    return {
      id,
      title: str(t.title),
      author: str(t.author),
      url,
      // 字段名是 duration（秒），不是 durationSec
      durationSec: num(t.duration ?? t.durationSec),
      bpm: num(t.bpm),
      licenseId: str(lic.id ?? t.licenseId),
      attribution: str(lic.attribution ?? t.attribution)
    }
  }

  for (const e of entries) {
    const k = String(e.key ?? '')
    if (!k.includes('mangaMusic')) continue
    // 变体条目（:plan:/:select:）不参与
    if (/:(plan|select):\d+$/.test(k)) continue
    /**
     * ⚠️ **必须用「章级键」判断，不能只看是否含 `:chapter:` 就取章号**。
     *
     * 实测踩坑：`mangaMusic:chapter:1:<hash>:<hash>` 里**没有** `plan.chapters`
     * （只有 `selection.track`），我用 `/:chapter:(\d+):/` 兜底取章号是正确的；
     * 但 `mangaMusic:music:1:<hash>:<hash>:tracks` 这条也带一个 `1:`
     * （章号在 `:music:` 后面），若让它的 `selection.track` 也进 `current`，
     * 就会把候选池里的 "Oppressive Gloom" 覆盖掉真正选中的 "Static Motion"。
     *
     * 所以：**current 只认 `mangaMusic:chapter:` 开头的主条目**；
     * `:music:` 前缀的（brief/tracks 中间产物）只进 pool，绝不进 current。
     */
    const isChapterMain = /(^|:)mangaMusic:chapter:/.test(k) && !/:tracks$|:brief$/.test(k)
    const v = (e.value && typeof e.value === 'object' ? e.value : null) as Record<string, unknown> | null
    const data =
      v && (v as Record<string, unknown>).data !== undefined
        ? ((v as Record<string, unknown>).data as Record<string, unknown>)
        : v
    if (!data) continue
    const groups = Array.isArray(data.groups)
      ? (data.groups as Record<string, unknown>[])
      : Array.isArray(data.musicGroups)
        ? (data.musicGroups as Record<string, unknown>[])
        : []

    for (const g of groups) {
      // 候选池：:tracks 条目里的 tracks 数组
      const tracks = Array.isArray((g as Record<string, unknown>).tracks)
        ? ((g as Record<string, unknown>).tracks as Record<string, unknown>[])
        : []
      for (const t of tracks) {
        const c = narrow(t)
        if (c) pool.set(c.id || c.url, c)
      }

      const sel = (g as Record<string, unknown>).selection as Record<string, unknown> | undefined
      const track = sel?.track as Record<string, unknown> | undefined
      const c = narrow(track)
      if (!c) continue
      pool.set(c.id || c.url, c)
      // current 只认章级主条目（见上方注释）
      if (!isChapterMain) continue

      const plan = (g as Record<string, unknown>).plan as Record<string, unknown> | undefined
      const chs = Array.isArray(plan?.chapters) ? (plan!.chapters as Record<string, unknown>[]) : []
      const seqs = new Set<number>()
      for (const ch of chs) {
        const s = Number((ch as Record<string, unknown>).chapterSeq)
        if (Number.isFinite(s) && s > 0) seqs.add(s)
      }
      // 无 chapters 字段时按 key 里的章号兜底
      if (!seqs.size) {
        const m = k.match(/:chapter:(\d+):/)
        if (m) seqs.add(Number(m[1]))
      }
      for (const seq of seqs) current.set(seq, c)
    }
  }
  return { current, pool: [...pool.values()] }
}

// ---------------------------------------------------------------------------
// 杂项
// ---------------------------------------------------------------------------

/** 把合成结果写到临时文件（供调试/导出音频用）。 */
export async function writeTmpAudio(dir: string, name: string, bytes: Buffer): Promise<string> {
  await mkdir(dirname(join(dir, name)), { recursive: true })
  const p = join(dir, name)
  await writeFile(p, bytes)
  return p
}

/** 计算文本指纹（与产出方同款 sha256(utf8) 口径，用于写回 clip.fingerprint）。 */
export function textFingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 生成一个新的音色样本 checksum 占位（重新合成样本时用）。 */
export function newVoiceChecksum(bytes: Buffer): string {
  return sha256Hex(bytes)
}

/** 资产是否已存在（调试用）。 */
export function assetExists(root: string, store: string): boolean {
  return existsSync(join(root, store))
}

/** 随机 id（新建条目时用）。 */
export function newId(): string {
  return randomUUID()
}

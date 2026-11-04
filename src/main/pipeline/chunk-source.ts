/**
 * chunk 原文来源（A1）：从工作库把「每个 chunk 的原文」按章节切出来。
 *
 * 背景（为什么需要这一层）：
 *  工作库 `records/chunks.json` 每条的 `value` **只有结构字段**
 *  （`{index, chapterSeqs, startChapterSeq, endChapterSeq, estimatedSourceTokens}`），**没有 `text`**。
 *  因此编排器不能直接读 `chunks[].text`，必须：
 *    chunk 章节范围 → `records/chapters.json` 取这些章的 `byteStart/byteEnd`
 *    → 用**字节区间**从原文资产 `<pkgId>/source/body.utf8.txt` 切出
 *    → 按章顺序拼成该 chunk 的原文。
 *  字节级 `Buffer.subarray(a,b).toString('utf8')` 天然避免把一个多字节汉字切两半。
 *
 * 本模块**不依赖 electron**，可被 node 验证脚本直接打包执行。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChapterInfo } from '../../shared/app-types'
import type { ChapterSlice } from '../../shared/pipeline-types'
import type { WorkspaceIndex } from '../../shared/workspace-types'
import { CONTAINER_FILES } from '../workspace/paths'
import { isSourceEntry } from '../workspace/library'
import { readShard } from '../workspace/shards'
import { extractChapters } from '../t2w/summary'

/** 一个 chunk 的原文来源：纯文本 + 按章切片。 */
export interface ChunkSource {
  /** chunk 纯原文（各章正文按顺序以 `\n` 拼接；不含行号/包装） */
  text: string
  /** 该 chunk 覆盖的章节切片（按 chunk 声明的顺序） */
  chapters: ChapterSlice[]
}

/**
 * 章节包装字面量（**外部标记，不属于原文**；提示词明确要求模型忽略之）。
 *
 * 证据：`recon/chunk_storySource-Blmpr7Sh.js` 的正则
 * `/@#(…)#@|【原文行：(-?\d+)-(-?\d+)】/g` —— `【原文行：a-b】` 为单段范围包装。
 * 见本模块文件末「格式不确定性」注释。
 */
export function chapterWrapper(start: number, end: number): string {
  return `【原文行：${start}-${end}】`
}

/**
 * 把若干章组装成「带行号原文」：
 *  - 每行开头 = `行号 + 一个空格`；
 *  - **各章从 1 重新编号**（不是全书/整片连续）；
 *  - 标题行与空行也占行号（即按 `\n` 切分后逐行编号）；
 *  - 每章外包一层 `【原文行：1-<该章行数>】`（外部章节包装，不属于原文）。
 */
export function numberLines(chapters: ChapterSlice[]): string {
  const blocks: string[] = []
  for (const ch of chapters) {
    const lines = (ch.text ?? '').split('\n')
    const numbered = lines.map((l, i) => `${i + 1} ${l}`).join('\n')
    blocks.push(`${chapterWrapper(1, lines.length)}\n${numbered}`)
  }
  return blocks.join('\n')
}

/** 读取原文资产字节；找不到原文成员 → 抛可读错误（不再静默退化）。 */
async function readSourceBuffer(root: string, index: WorkspaceIndex): Promise<Buffer> {
  const row = index.assets.find((a) => isSourceEntry(a.path))
  if (!row) {
    throw new Error('该包未包含原文成员（source/body.utf8.txt），无法构造解析输入')
  }
  return Buffer.from(await readFile(join(root, row.store)))
}

/** 用字节区间从原文缓冲切出某一章（越界自动钳制；字节切片避免切裂多字节字符）。 */
function sliceChapter(buf: Buffer, c: ChapterInfo): string {
  const from = Math.max(0, Math.min(c.byteStart, buf.length))
  const to = Math.max(from, Math.min(c.byteEnd, buf.length))
  return Buffer.from(buf.subarray(from, to)).toString('utf8')
}

/** 从一个 chunk 的 value 解析其章节序号列表（优先 `chapterSeqs`，退回 `startChapterSeq~endChapterSeq`）。 */
function chunkChapterSeqs(v: Record<string, unknown>): number[] {
  const list = v.chapterSeqs
  if (Array.isArray(list) && list.length) {
    return list.map((x) => Number(x)).filter((n) => Number.isFinite(n))
  }
  const a = Number(v.startChapterSeq)
  const b = Number(v.endChapterSeq)
  if (Number.isFinite(a) && Number.isFinite(b) && b >= a) {
    const out: number[] = []
    for (let s = a; s <= b; s++) out.push(s)
    return out
  }
  return []
}

/**
 * 读取并装配工作库内**全部 chunk** 的原文来源。
 *
 * 失败（缺 chunks/chapters 分片、缺原文资产、chunk 声明了不存在的章节、章节范围为空）
 * 一律**抛可读错误**——绝不退化成「拿书名当正文」。
 */
export async function loadChunkSources(root: string, index: WorkspaceIndex): Promise<ChunkSource[]> {
  // 章节
  let chapterInfos: ChapterInfo[]
  try {
    const env = await readShard(root, CONTAINER_FILES.chapters)
    chapterInfos = extractChapters({ chapters: env.entries.map((e) => e.value) })
  } catch (e) {
    throw new Error(`读取章节分片失败：${(e as Error).message}`)
  }
  if (!chapterInfos.length) {
    throw new Error('工作库缺少章节信息（records/chapters.json 为空），无法构造解析输入')
  }

  // chunk 划分
  let chunkValues: Record<string, unknown>[]
  try {
    const env = await readShard(root, CONTAINER_FILES.chunks)
    chunkValues = env.entries
      .map((e) => e.value)
      .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
  } catch (e) {
    throw new Error(`读取 chunk 分片失败：${(e as Error).message}`)
  }
  if (!chunkValues.length) {
    throw new Error('工作库缺少 chunk 划分（records/chunks.json 为空），无法构造解析输入')
  }

  const buf = await readSourceBuffer(root, index)
  const bySeq = new Map<number, ChapterInfo>()
  for (const c of chapterInfos) bySeq.set(c.seq, c)

  const sorted = chunkValues.slice().sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
  const out: ChunkSource[] = []
  for (const v of sorted) {
    const seqs = chunkChapterSeqs(v)
    if (!seqs.length) {
      throw new Error(`chunk ${String(v.index)} 未声明章节范围，无法构造解析输入`)
    }
    const chapters: ChapterSlice[] = []
    for (const s of seqs) {
      const c = bySeq.get(s)
      if (!c) throw new Error(`chunk ${String(v.index)} 引用了不存在的章节 seq=${s}`)
      chapters.push({ seq: c.seq, title: c.title, text: sliceChapter(buf, c) })
    }
    out.push({ text: chapters.map((c) => c.text).join('\n'), chapters })
  }
  return out
}

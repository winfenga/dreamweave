/**
 * `.txt` → 工作库（导入器；与 `.t2w` 解包 `unpack()` 完全同构）。
 *
 * 同构点（设计口径：无条件新建、零提示）：
 *  - **无条件新建**：目录名由调用方 `allocWorkspaceDirName()` 现场分配，与文件内容彻底解耦 ——
 *    同一个 .txt 反复导入各自独立成书，互不影响；没有「已存在则复用/覆盖」分支，也无任何重复提示；
 *  - 列表标题 = 来源文件名（`listWorkspaces` 取 `origin.t2wPath` 的 basename）；
 *  - 资产走 `writeAsset`、分片走 `writeShard`、索引走 `writeIndex`（唯一写入口，不绕过硬写）；
 *  - 失败清理与 `unpack` 同策略：删 `index.json` 后 rethrow，绝不留下看似可用的半成品。
 *
 * 本模块**不依赖 electron**，可被 node 验证脚本经 esbuild 打包后直接执行。
 *
 * 编码检测**只用 Node 内置 `TextDecoder`**（Node v22 full ICU，实测 `gb18030` / `utf-16le` /
 * `utf-16be` 均可用），不引任何第三方包（`package.json` 的 dependencies 保持 `{}`）。
 */
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { sha256Hex } from '../t2w/format'
import { kindOf, storePathFor, writeAsset } from './assets'
import { readIndex, writeIndex } from './index-store'
import { CONTAINER_FILES, INDEX_FILE, INDEX_VERSION, WORKSPACE_FORMAT } from './paths'
import { shardNameFor, writeShard } from './shards'
import type {
  AssetRow,
  KeyedEntry,
  ManifestSkeleton,
  OriginInfo,
  ShardRow,
  WorkspaceIndex
} from './types'

// ---------------------------------------------------------------------------
// 编码检测 + 解码
// ---------------------------------------------------------------------------

/**
 * 检测并解码文本文件字节（BOM 优先，无 BOM 走「严格 UTF-8 → GB18030」降级链）。
 *
 * 返回的 `encoding` 就是**检测到的标签**（`utf-8` / `utf-16le` / `utf-16be` / `gb18030`），
 * 仅作元数据记录 —— **不用任何元数据字段做编码门禁**，字节说了算。
 *
 * - BOM：`EF BB BF`→utf-8；`FF FE`→utf-16le；`FE FF`→utf-16be（均剥 BOM 后解码）；
 * - 无 BOM：先严格 UTF-8 整块校验，通过即 `utf-8`；失败再严格 GB18030；
 * - 两者皆败 → 抛可读错误（文件可能为二进制或损坏）。
 */
export function detectAndDecode(buf: Buffer): { text: string; encoding: string } {
  // —— BOM 优先（WHATWG 编码嗅探顺序）——
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf-8' }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    try {
      return { text: new TextDecoder('utf-16le', { fatal: true }).decode(buf.subarray(2)), encoding: 'utf-16le' }
    } catch {
      throw new Error('无法识别的文本编码：识别到 UTF-16LE BOM，但剩余字节不是有效的 UTF-16LE（文件可能已损坏）')
    }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE 走 TextDecoder('utf-16be')（Node v22 full ICU 支持该 WHATWG 标签），
    // 而非手写「逐 16 位交换」：后者要自行处理代理对/奇数尾字节，脆弱且无收益。
    // 若运行环境缺 full ICU，构造 TextDecoder 即抛 → 转成可读错误，绝不静默产出乱码。
    try {
      return { text: new TextDecoder('utf-16be', { fatal: true }).decode(buf.subarray(2)), encoding: 'utf-16be' }
    } catch {
      throw new Error(
        '无法识别的文本编码：识别到 UTF-16BE BOM，但当前运行环境不支持 utf-16be 解码或剩余字节已损坏'
      )
    }
  }

  // —— 无 BOM：严格 UTF-8 → GB18030 ——
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' }
  } catch {
    /* 不是合法 UTF-8，落入 GB18030 尝试 */
  }
  try {
    return { text: new TextDecoder('gb18030', { fatal: true }).decode(buf), encoding: 'gb18030' }
  } catch {
    /* 两者皆败，落入统一可读错误 */
  }
  throw new Error('无法识别的文本编码：既不是有效 UTF-8，也不是 GB18030（文件可能为二进制或损坏）')
}

// ---------------------------------------------------------------------------
// 章节切分（字符区间）
// ---------------------------------------------------------------------------

/** 字符区间章节（charEnd 不含）。 */
export interface CharChapter {
  title: string
  charStart: number
  charEnd: number
}

/**
 * 章标题关键词后的**分隔符集合**（lookahead 把关与分隔符消费共用同一集合，单一事实源）。
 *
 * 字符类内 `-` 置于末尾（否则与相邻字符误成范围），`[` `]` 需转义。
 */
const SEP_CLASS = '[\\s　:：、，。．.！!？?·—－（）()【】\\[\\]「」『』～~-]'

/**
 * 章标题正则集合（**顺序即优先级**，逐行 try）。
 *
 * - `第X章/回/部/卷…` 与 `#{1,3}` Markdown 标题信号足够强（正文行首不会误现），保持原样；
 * - 关键词型（序章/跋/前言/尾声/番外/Chapter N…）**关键词后必须跟分隔符或行尾**
 *   （lookahead 把关 + 消费段同一集合）—— 否则「跋涉千里…」「前言不搭后语…」「尾声语：完。」
 *   这类正文行首会被误判为章标题，假章区间还会把后续正文吞进去。
 */
const CHAPTER_PATTERNS: readonly RegExp[] = [
  /^第[0-9零一二三四五六七八九十百千两]+[章回部卷集话篇][\s　]*(.*)$/,
  new RegExp(`^(序章|序言|序曲|楔子|前言|引子|尾声|终章|后记|跋)(?=${SEP_CLASS}|$)${SEP_CLASS}*(.*)$`),
  new RegExp(`^番外[篇话]?(?=${SEP_CLASS}|$)${SEP_CLASS}*(.*)$`),
  new RegExp(`^Chapter\\s+[0-9]+(?=${SEP_CLASS}|$)${SEP_CLASS}*(.*)$`, 'i'),
  /^#{1,3}\s+(.+)$/
]

/** 捕获组清洗：剥**前导/尾随**分隔符后再 trim（「：完」→「完」、「（大结局）」→「大结局」）。 */
const SEP_PREFIX_RE = new RegExp(`^${SEP_CLASS}+`)
const SEP_SUFFIX_RE = new RegExp(`${SEP_CLASS}+$`)

/**
 * 按行切分章节（字符区间，`charEnd` 不含）。
 *
 * - 按 `\n` 切行逐行匹配（行首锚定；匹配前 trim 行首空白，但 `charStart` 取**标题行第一个
 *   非空白字符**的位置）；
 * - 标题 = 捕获组剥前导/尾随分隔符后 trim；为空则用整行 trim（如「第一章」「楔子」的兜底）；
 * - 第 i 章区间 = [第 i 个标题行 charStart, 第 i+1 个标题行 charStart)，末章到 `text.length`；
 * - 一章都没匹配到 → **全书单章兜底**（`title = fallbackTitle`，一个字符都不丢）；
 * - 去重防护：匹配行若与上一章标题行位置相同则跳过（同一行不会被两个正则重复计入）。
 *
 * @param fallbackTitle 零章节兜底时使用的书名（由调用方从文件名推导）
 */
export function splitChapters(text: string, fallbackTitle: string): CharChapter[] {
  const found: CharChapter[] = []
  let pos = 0
  for (const line of text.split('\n')) {
    const lineStart = pos
    pos += line.length + 1 // +1 = '\n'（末行无 '\n' 也无害，仅作累计）

    const trimmed = line.trimStart()
    if (trimmed.length === 0) continue
    // 兼容 CRLF：行尾 '\r' 会让正则 `$` 锚点失配（JS 的 `.` 不匹配 '\r'，无 /m 时 `$` 只认串尾），
    // 故匹配前再去掉行尾空白；charStart 仍按**行首**空白长度计算（首个非空白字符）。
    const body = trimmed.trimEnd()
    if (body.length === 0) continue

    for (const re of CHAPTER_PATTERNS) {
      const m = re.exec(body)
      if (!m) continue
      const charStart = lineStart + (line.length - trimmed.length)
      // 去重防护：同一位置不重复入章
      if (found.length > 0 && found[found.length - 1].charStart === charStart) break
      // 标题取**最后一个捕获组**：关键词型正则的 alternation 自身占第 1 组（m[1]=关键词），
      // 标题后缀是末组（m[2]）；单组正则（第X章 / 番外 / Chapter / #）末组即 m[1]。
      const captured = (m[m.length - 1] ?? '')
        .replace(SEP_PREFIX_RE, '')
        .replace(SEP_SUFFIX_RE, '')
        .trim()
      found.push({
        title: captured.length > 0 ? captured : body,
        charStart,
        charEnd: -1 // 稍后统一回填
      })
      break
    }
  }

  if (found.length === 0) {
    return [{ title: fallbackTitle, charStart: 0, charEnd: text.length }]
  }
  for (let i = 0; i < found.length; i++) {
    found[i].charEnd = i + 1 < found.length ? found[i + 1].charStart : text.length
  }
  return found
}

// ---------------------------------------------------------------------------
// 章节字节区间（O(n) 精确法）
// ---------------------------------------------------------------------------

/** 字节区间章节（byteEnd 不含；UTF-8 字节口径，与原文资产 body.utf8.txt 对齐）。 */
interface ByteChapter extends CharChapter {
  seq: number
  byteStart: number
  byteEnd: number
}

/**
 * 字符区间 → UTF-8 字节区间（**单遍 O(n)**）。
 *
 * 逐行累计 `charPos`/`bytePos`；命中章标题行时记**行起始** bytePos 为 `byteStart`
 * （含行首空白 —— 阅读器按字节钳制，行首空白归前一章/本章都不丢字符）。
 * `byteEnd` = 下一章 `byteStart`；末章到 `utf8Len`。
 */
function computeByteRanges(text: string, utf8Len: number, chapters: CharChapter[]): ByteChapter[] {
  const out: ByteChapter[] = []
  let ci = 0
  let charPos = 0
  let bytePos = 0

  for (const line of text.split('\n')) {
    const lineByteStart = bytePos
    charPos += line.length + 1
    bytePos += Buffer.byteLength(line, 'utf8') + 1
    // 本章标题行的 charStart 必落在本行字符区间内（章节行首锚定 → 天然单调）
    while (ci < chapters.length && chapters[ci].charStart < charPos) {
      out.push({
        ...chapters[ci],
        seq: out.length + 1,
        byteStart: Math.max(0, Math.min(lineByteStart, utf8Len)),
        byteEnd: -1
      })
      ci++
    }
  }
  // 防御性兜底：charStart 越界（理论上不可达）时钳到文末
  while (ci < chapters.length) {
    out.push({ ...chapters[ci], seq: out.length + 1, byteStart: utf8Len, byteEnd: -1 })
    ci++
  }

  for (let i = 0; i < out.length; i++) {
    out[i].byteEnd = i + 1 < out.length ? out[i + 1].byteStart : utf8Len
  }
  return out
}

/** 字节区间合法性校验：落在 [0, utf8Len] 且单调不减；任一不符即抛可读错误。 */
function validateByteRanges(ranges: ByteChapter[], utf8Len: number): void {
  let prevStart = -1
  for (const r of ranges) {
    if (!Number.isInteger(r.byteStart) || r.byteStart < 0 || r.byteStart > utf8Len) {
      throw new Error(`章节字节区间非法：seq=${r.seq} byteStart=${r.byteStart}（全书 ${utf8Len} 字节）`)
    }
    if (!Number.isInteger(r.byteEnd) || r.byteEnd < r.byteStart || r.byteEnd > utf8Len) {
      throw new Error(
        `章节字节区间非法：seq=${r.seq} byteEnd=${r.byteEnd}（byteStart=${r.byteStart}，全书 ${utf8Len} 字节）`
      )
    }
    if (r.byteStart < prevStart) {
      throw new Error(`章节字节区间非单调递增：seq=${r.seq} byteStart=${r.byteStart} < ${prevStart}`)
    }
    prevStart = r.byteStart
  }
}

// ---------------------------------------------------------------------------
// chunk 划分（weighted-source-v1）
// ---------------------------------------------------------------------------

/** chunk 装箱目标 tokens（与真包同口径）。 */
const CHUNK_TARGET_TOKENS = 42000
/** 尾段不足该值且非唯一 → 并进上一箱。 */
const CHUNK_TAIL_MERGE_TOKENS = 8000
/** 实测口径：真包 65057 字符章 = 38747 tokens（≈ 1.7 字符/token）。 */
const CHARS_PER_TOKEN = 1.7

/** 一个 chunk 箱：覆盖的章序列表 + 估算 tokens。 */
interface ChunkBox {
  chapterSeqs: number[]
  tokens: number
}

/**
 * 按章序贪心装箱（weighted-source-v1）。
 *
 * - `estimatedSourceTokens = Math.round(章字符数 / 1.7)`；
 * - 累计到 `CHUNK_TARGET_TOKENS` 即封箱（单章超限时独占一箱，章节不再切半）；
 * - 最后一段 < `CHUNK_TAIL_MERGE_TOKENS` 且非唯一 → 并进上一箱。
 */
function packChunks(ranges: ByteChapter[]): ChunkBox[] {
  const boxes: ChunkBox[] = []
  for (const c of ranges) {
    const tokens = Math.round((c.charEnd - c.charStart) / CHARS_PER_TOKEN)
    const last = boxes[boxes.length - 1]
    if (last && last.tokens + tokens > CHUNK_TARGET_TOKENS) {
      boxes.push({ chapterSeqs: [c.seq], tokens })
    } else if (last) {
      last.chapterSeqs.push(c.seq)
      last.tokens += tokens
    } else {
      boxes.push({ chapterSeqs: [c.seq], tokens })
    }
  }
  if (boxes.length >= 2) {
    const tail = boxes[boxes.length - 1]
    if (tail.tokens < CHUNK_TAIL_MERGE_TOKENS) {
      boxes.pop()
      const prev = boxes[boxes.length - 1]
      prev.chapterSeqs.push(...tail.chapterSeqs)
      prev.tokens += tail.tokens
    }
  }
  return boxes
}

// ---------------------------------------------------------------------------
// 组装工作库
// ---------------------------------------------------------------------------

/**
 * `.txt` → 工作库（root 由调用方 `allocWorkspaceDirName()` 分配好）。
 *
 * 步骤与 `unpack()` 同构：
 *   1. 读文件 → 编码检测/解码 → UTF-8 规范化正文（`body.utf8.txt` 即阅读/解析的唯一真源）；
 *   2. 章节切分（字符区间 → UTF-8 字节区间，O(n) + 合法性校验）；
 *   3. 资产两行：规范化正文 + 原始字节（内容寻址，走 `writeAsset`）；
 *   4. 分片三行：chapters / chunks（weighted-source-v1）/ tasks（空信封），走 `writeShard`；
 *   5. `index.json`（与 unpack 产出的 `WorkspaceIndex` 完全同构），走 `writeIndex`；
 *   6. `readIndex` 自校验（能读回才算成功）。
 *
 * 任一步异常 → 删 `index.json` 后 rethrow（与 unpack 同策略，绝不留下半成品）。
 */
export async function buildTxtWorkspace(txtPath: string, root: string): Promise<WorkspaceIndex> {
  const raw = await readFile(txtPath)
  const { text, encoding } = detectAndDecode(raw)
  const utf8Buf = Buffer.from(text, 'utf8')
  const bodyHash = sha256Hex(utf8Buf)
  const rawSha256 = sha256Hex(raw)

  const pkgId = randomUUID()
  const revisionId = `txt-import-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
  const title = basename(txtPath).replace(/\.[^.]+$/, '')
  const now = new Date().toISOString()

  const charChapters = splitChapters(text, title)
  const ranges = computeByteRanges(text, utf8Buf.length, charChapters)
  validateByteRanges(ranges, utf8Buf.length)
  const boxes = packChunks(ranges)

  try {
    // —— 资产两行（body.utf8.txt = 规范化正文；original.bin = 原始文件字节）——
    const bodyPath = `${pkgId}/source/body.utf8.txt`
    const originalPath = `${pkgId}/source/original.bin`
    const assets: AssetRow[] = []
    for (const spec of [
      { path: bodyPath, bytes: utf8Buf },
      { path: originalPath, bytes: raw }
    ]) {
      const sha = sha256Hex(spec.bytes)
      const row: AssetRow = {
        path: spec.path,
        size: spec.bytes.length,
        sha256: sha,
        store: storePathFor({ path: spec.path, sha256: sha }),
        kind: kindOf(spec.path)
      }
      await writeAsset(root, row, spec.bytes)
      assets.push(row)
    }

    // —— chapters 分片（value 与真包 chapters 条目同构）——
    const chapterEntries: KeyedEntry[] = ranges.map((c, i) => ({
      seq: i,
      key: `${pkgId}:${i + 1}`,
      value: {
        projectId: pkgId,
        seq: i + 1,
        title: c.title,
        sectionIndex: 0,
        sectionTitle: '全书',
        sectionChapterSeq: i + 1,
        byteStart: c.byteStart,
        byteEnd: c.byteEnd
      }
    }))
    const chaptersSha = await writeShard(root, CONTAINER_FILES.chapters, {
      shard: shardNameFor(CONTAINER_FILES.chapters),
      container: 'chapters',
      entries: chapterEntries
    })

    // —— chunks 分片（weighted-source-v1；只有结构字段，原文按章字节区间切）——
    const chunkEntries: KeyedEntry[] = boxes.map((b, i) => ({
      seq: i,
      key: `${pkgId}:${i}`,
      value: {
        projectId: pkgId,
        index: i,
        chapterSeqs: b.chapterSeqs,
        startChapterSeq: b.chapterSeqs[0],
        endChapterSeq: b.chapterSeqs[b.chapterSeqs.length - 1],
        estimatedSourceTokens: b.tokens
      }
    }))
    const chunksSha = await writeShard(root, CONTAINER_FILES.chunks, {
      shard: shardNameFor(CONTAINER_FILES.chunks),
      container: 'chunks',
      entries: chunkEntries
    })

    // —— tasks 分片（空信封：新书零任务历史）——
    const tasksSha = await writeShard(root, CONTAINER_FILES.tasks, {
      shard: shardNameFor(CONTAINER_FILES.tasks),
      container: 'tasks',
      entries: []
    })

    const shards: ShardRow[] = [
      {
        name: shardNameFor(CONTAINER_FILES.chapters),
        file: CONTAINER_FILES.chapters,
        container: 'chapters',
        entryCount: chapterEntries.length,
        sha256: chaptersSha
      },
      {
        name: shardNameFor(CONTAINER_FILES.chunks),
        file: CONTAINER_FILES.chunks,
        container: 'chunks',
        entryCount: chunkEntries.length,
        sha256: chunksSha
      },
      {
        name: shardNameFor(CONTAINER_FILES.tasks),
        file: CONTAINER_FILES.tasks,
        container: 'tasks',
        entryCount: 0,
        sha256: tasksSha
      }
    ]

    const origin: OriginInfo = {
      t2wPath: txtPath,
      t2wSize: raw.length,
      t2wSha256: rawSha256,
      manifestJsonSha256: '',
      hasOriginHeader: false,
      projectId: pkgId,
      revisionId,
      createdAt: now
    }

    const project = {
      id: pkgId,
      title,
      revisionId,
      parseMode: 'txt-import',
      storyScriptStyle: '',
      parseProtocol: 'txt-import-v1',
      status: 'ready',
      createdAt: now,
      updatedAt: now,
      encoding,
      chapterCount: ranges.length,
      chunkCount: boxes.length,
      charCount: text.length,
      cutChars: 0,
      sourcePath: originalPath,
      bodyPath,
      bodyHash,
      features: [],
      hasSource: true,
      sourceNormalization: 'none',
      chunking: {
        strategy: 'weighted-source-v1',
        targetTokens: CHUNK_TARGET_TOKENS,
        tailMergeTokens: CHUNK_TAIL_MERGE_TOKENS
      }
    }

    const skeleton: ManifestSkeleton = {
      includesSource: true,
      topLevelKeys: ['format', 'includesSource', 'project', 'records', 'files'],
      extra: {},
      recordsKeys: ['chapters', 'chunks', 'tasks'],
      containers: { chapters: 'array', chunks: 'array', tasks: 'array' },
      containerKeyed: { chapters: true, chunks: true, tasks: true },
      project
    }

    const index: WorkspaceIndex = {
      indexVersion: INDEX_VERSION,
      format: WORKSPACE_FORMAT,
      pkgId,
      title,
      origin,
      manifest: skeleton,
      shards,
      assets,
      tasks: {},
      integrity: { createdAt: now, lastVerifiedAt: null }
    }

    await writeIndex(root, index)
    // 自校验：能读回（且结构校验通过）才算成功
    await readIndex(root)
    return index
  } catch (e) {
    // 失败清理：只删 index.json（单文件删除），使工作库落到「无有效索引」的可读状态，
    // 绝不留下一个"看似可用"的半成品（分片/资产残留不会被任何索引引用）。与 unpack 同策略。
    await rm(join(root, INDEX_FILE), { force: true }).catch(() => undefined)
    throw e
  }
}

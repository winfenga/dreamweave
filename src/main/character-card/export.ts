/**
 * 角色卡导出：SillyTavern V2/V3 格式。
 *
 * 【PNG 方案（官方做法）】SillyTavern 的「PNG 角色卡」= 一张普通 PNG，
 * 在 PNG 的 **tEXt 文本块**里塞入 JSON：
 *   - `chara`  → base64(UTF-8 JSON)，V2 规格（`spec: 'chara_card_v2'`）；
 *   - `ccv3`   → base64(UTF-8 JSON)，V3 规格（`spec: 'chara_card_v3'`）。
 * 两张块同时写是通行做法（老版本读 chara，新版本读 ccv3）。
 *
 * 【为什么不用第三方库】本仓 `dependencies: {}`，PNG 编码器要靠 Electron 的
 * nativeImage 或手写。这里选择**手写最小 PNG 编码器**：
 *   - 只需要「原图字节 + 追加一个 tEXt 块」——不用重新编码像素，
 *     因为 tEXt 是独立块，插在 IEND 之前即可，原图 IDAT 完全不用动；
 *   - 这样既保留原立绘品质（不重编码），又不引入依赖。
 *
 * 【关键坑】PNG 块结构 = length(4B BE) + type(4B) + data + crc32(4B)，
 * CRC 覆盖 **type + data**（不含 length）。CRC 算错，SillyTavern 会直接
 * 判定「不是有效的 PNG 角色卡」。
 */
import { deflateSync } from 'node:zlib'
import type { CharacterCard, CardSpec, LorebookEntry } from '../../shared/character-card-types'

// ---------------------------------------------------------------------------
// CRC32（PNG 规范指定的多项式，与 zlib 的不同：这里必须是 PNG 的那一个）
// ---------------------------------------------------------------------------

let crcTable: Uint32Array | null = null
function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
}

/** PNG 的 CRC32：从 0xFFFFFFFF 开始、末尾异或 0xFFFFFFFF。 */
export function crc32(buf: Uint8Array): number {
  if (!crcTable) crcTable = makeCrcTable()
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4)
  b[0] = (n >>> 24) & 0xff
  b[1] = (n >>> 16) & 0xff
  b[2] = (n >>> 8) & 0xff
  b[3] = n & 0xff
  return b
}

/** 组一个 PNG 块：length + type + data + crc(type+data)。 */
export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([...type].map((ch) => ch.charCodeAt(0)))
  const body = new Uint8Array(typeBytes.length + data.length)
  body.set(typeBytes, 0)
  body.set(data, typeBytes.length)
  const out = new Uint8Array(4 + body.length + 4)
  out.set(u32be(data.length), 0)
  out.set(body, 4)
  out.set(u32be(crc32(body)), 4 + body.length)
  return out
}

/**
 * 追加一个 tEXt 块（keyword + \0 + text）。
 *
 * PNG 规范：keyword 1–79 字节，Latin-1，不允许 \0；text 是 Latin-1。
 * base64 结果保证落在 Latin-1 范围内，所以 base64 后的卡片 JSON 安全。
 */
export function pngTextChunk(keyword: string, text: string): Uint8Array {
  const kw = Buffer.from(keyword, 'latin1')
  const tx = Buffer.from(text, 'latin1')
  const data = Buffer.alloc(kw.length + 1 + tx.length)
  kw.copy(data, 0)
  data[kw.length] = 0
  tx.copy(data, kw.length + 1)
  return pngChunk('tEXt', new Uint8Array(data))
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * 把任意 PNG 字节 + 一组 tEXt 块合成新 PNG。
 *
 * 做法：原样拷贝到 IEND 之前，插入新块，再写 IEND。
 * **不重新编码像素**，所以画质与体积基本不变。
 *
 * 若输入不是合法 PNG（没有 IEND），返回 null —— 调用方据此改走 JSON 导出，
 * 而不是产出一个「看起来是 png 其实酒馆读不了」的文件。
 */
export function embedPngText(png: Uint8Array, texts: { keyword: string; text: string }[]): Uint8Array | null {
  if (png.length < 8 || !PNG_SIG.every((b, i) => png[i] === b)) return null
  // 扫块找 IEND 起点
  let off = 8
  let iendStart = -1
  while (off + 8 <= png.length) {
    const len = (png[off] << 24) | (png[off + 1] << 16) | (png[off + 2] << 8) | png[off + 3]
    const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7])
    if (type === 'IEND') {
      iendStart = off
      break
    }
    off += 4 + 4 + len + 4
  }
  if (iendStart < 0) return null

  const extra = texts.map((t) => pngTextChunk(t.keyword, t.text))
  const extraLen = extra.reduce((s, c) => s + c.length, 0)
  const out = new Uint8Array(png.length + extraLen)
  out.set(png.subarray(0, iendStart), 0)
  let p = iendStart
  for (const c of extra) {
    out.set(c, p)
    p += c.length
  }
  out.set(png.subarray(iendStart), p)
  return out
}

// ---------------------------------------------------------------------------
// SillyTavern 卡片 JSON
// ---------------------------------------------------------------------------

/**
 * 卡片 JSON（V2 主体）。
 *
 * V2 的约定是「顶层保留 name/description 等旧字段，真正的数据在 data 里」——
 * 只写 data 的话，老版本酒馆读不出名字；只写顶层的话，新版本读不到 lorebook。
 * 所以两边都写（SillyTavern 自己的导出也是这么做的）。
 */
interface CharacterBookEntry {
  keys: string[]
  content: string
  extensions: Record<string, unknown>
  enabled: boolean
  insertion_order: number
  case_sensitive: boolean
  name: string
  priority: number
  id: number
  comment: string
  selective: boolean
  secondary_keys: string[]
  constant: boolean
  position: 'before_char' | 'after_char'
}

function loreToCharacterBook(entries: LorebookEntry[]): Record<string, unknown> | null {
  if (!entries.length) return null
  const bookEntries: CharacterBookEntry[] = entries.map((e, i) => ({
    keys: e.keys,
    content: e.content,
    extensions: {},
    enabled: true,
    insertion_order: e.insertionOrder,
    case_sensitive: false,
    name: e.name,
    priority: 10,
    id: i,
    comment: e.source === 'world' ? '世界观（常驻）' : e.source === 'relation' ? '人物关系' : '人物档案',
    selective: false,
    secondary_keys: [],
    constant: e.constant,
    position: e.constant ? 'before_char' : 'after_char'
  }))
  return {
    name: 'DreamWeave 世界书',
    description: '由 DreamWeave 从书籍解析结果自动生成：人物档案、关系与世界观。',
    scan_depth: 4,
    token_budget: 1024,
    recursive_scanning: false,
    extensions: {},
    entries: bookEntries
  }
}

export function cardToV2Json(card: CharacterCard, lorebook: LorebookEntry[] = []): Record<string, unknown> {
  const book = loreToCharacterBook(lorebook)
  const data: Record<string, unknown> = {
    name: card.name,
    description: card.description,
    personality: card.personality,
    scenario: card.scenario,
    first_mes: card.firstMes,
    mes_example: card.mesExample,
    creator_notes: card.creatorNotes,
    system_prompt: card.systemPrompt,
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [card.novelGenre, card.importanceLevel, ...card.aliases].filter(Boolean),
    creator: card.creator,
    character_version: card.cardVersion,
    extensions: {
      // 保留软件内的额外信息，导回 DreamWeave 时可用（酒馆会原样保存这个对象）
      dreamweave: {
        characterId: card.id,
        importanceLevel: card.importanceLevel,
        identInfos: card.identInfos,
        lifeStatus: card.lifeStatus,
        appearanceChapters: card.appearanceChapters,
        relations: card.relations.map((r) => ({
          other: r.otherName,
          overview: r.overview,
          from: r.fromChapter,
          to: r.toChapter
        })),
        voice: card.voice ? { type: card.voice.voiceType, description: card.voice.description } : null,
        sourceTitle: card.sourceTitle
      }
    }
  }
  if (book) data.character_book = book

  return {
    // 顶层兼容字段（老版本酒馆读这些）
    name: card.name,
    description: card.description,
    personality: card.personality,
    scenario: card.scenario,
    first_mes: card.firstMes,
    mes_example: card.mesExample,
    // V2 规格主体
    spec: 'chara_card_v2' satisfies CardSpec,
    spec_version: '2.0',
    data
  }
}

/** 打包成可写入 PNG tEXt 的 base64。 */
export function cardToBase64(json: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(json), 'utf8').toString('base64')
}

/**
 * 生成一张 SillyTavern PNG 角色卡。
 *
 * @param pngBytes 底图（通常是角色立绘）
 * @returns 写入好的 PNG 字节；底图不是合法 PNG 时返回 null
 */
export function buildPngCard(
  card: CharacterCard,
  pngBytes: Uint8Array,
  lorebook: LorebookEntry[] = []
): Uint8Array | null {
  const v2 = cardToV2Json(card, lorebook)
  const b64 = cardToBase64(v2)
  // chara = V2（所有版本都认）；ccv3 = V3（新版本优先，内容同 V2 结构，spec 由酒馆自行补）
  return embedPngText(pngBytes, [
    { keyword: 'chara', text: b64 },
    { keyword: 'ccv3', text: b64 }
  ])
}

/**
 * 从 PNG 里**读回**角色卡（验证用；也供将来「导入酒馆卡片」复用）。
 *
 * 只解析 tEXt 的 `chara` / `ccv3`，返回解出来的 JSON。
 */
export function readPngCard(png: Uint8Array): Record<string, unknown> | null {
  if (png.length < 8 || !PNG_SIG.every((b, i) => png[i] === b)) return null
  let off = 8
  let found: string | null = null
  while (off + 8 <= png.length) {
    const len = (png[off] << 24) | (png[off + 1] << 16) | (png[off + 2] << 8) | png[off + 3]
    const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7])
    if (type === 'tEXt') {
      const data = png.subarray(off + 8, off + 8 + len)
      const nul = data.indexOf(0)
      if (nul > 0) {
        const kw = Buffer.from(data.subarray(0, nul)).toString('latin1')
        const text = Buffer.from(data.subarray(nul + 1)).toString('latin1')
        if (kw === 'chara' || kw === 'ccv3') {
          found = text
          // ccv3 优先：命名上就是新版本
          if (kw === 'ccv3') break
        }
      }
    }
    if (type === 'IEND') break
    off += 4 + 4 + len + 4
  }
  if (!found) return null
  try {
    return JSON.parse(Buffer.from(found, 'base64').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** 生成一张纯色占位 PNG（角色没有立绘时，导出 PNG 卡需要底图）。 */
export function makePlaceholderPng(size = 512, rgb: [number, number, number] = [243, 236, 226]): Uint8Array {
  const width = size
  const height = size
  // 每行：1 字节 filter(0) + width*3 字节 RGB
  const rowLen = 1 + width * 3
  const raw = Buffer.alloc(rowLen * height)
  for (let y = 0; y < height; y++) {
    const base = y * rowLen
    raw[base] = 0
    for (let x = 0; x < width; x++) {
      const p = base + 1 + x * 3
      raw[p] = rgb[0]
      raw[p + 1] = rgb[1]
      raw[p + 2] = rgb[2]
    }
  }
  const idat = deflateSync(raw)
  const ihdr = new Uint8Array(13)
  const w = u32be(width)
  const h = u32be(height)
  ihdr.set(w, 0)
  ihdr.set(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type 2 = truecolor RGB
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  const chunks = [
    new Uint8Array(PNG_SIG),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', new Uint8Array(idat)),
    pngChunk('IEND', new Uint8Array(0))
  ]
  const total = chunks.reduce((s, c) => s + c.length, 0)
  const out = new Uint8Array(total)
  let p = 0
  for (const c of chunks) {
    out.set(c, p)
    p += c.length
  }
  return out
}

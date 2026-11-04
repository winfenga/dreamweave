/**
 * 角色卡导出的 PNG 层验证（node 直跑，不启动 Electron）。
 *
 * 重点验证 SillyTavern 角色卡**真的能被读回来**：
 *   - PNG 块结构 / CRC32 正确（CRC 算错酒馆会直接判定「不是有效角色卡」）；
 *   - tEXt 的 chara / ccv3 两个块都在，base64 → JSON 还原后字段齐全；
 *   - V2 的顶层兼容字段与 data.* 主体同时存在；
 *   - character_book 由世界书条目正确生成；
 *   - 追加块**不动原图 IDAT**（像素零损失）；
 *   - 非 PNG 输入返回 null，而不是产出坏文件；
 *   - 内置的 crc32 与已知向量一致。
 *
 * 用法：node scripts/verify-card-export.mjs
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inflateSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(here, '..')
const BUILD_DIR = join(FEATHER, 'out', '.verify-card-export')

const require = createRequire(join(FEATHER, 'package.json'))
const { build } = require('esbuild')

function electronStub() {
  return {
    name: 'electron-stub',
    setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }))
      b.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
        contents:
          `export const app = { getAppPath: () => ${JSON.stringify(FEATHER)}, getPath: () => ${JSON.stringify(join(FEATHER, 'out', '.tmp'))} };\n` +
          `export const ipcMain = { handle(){}, on(){} };\n` +
          `export const BrowserWindow = { getAllWindows: () => [], fromWebContents: () => null };\n` +
          `export default { app, ipcMain, BrowserWindow };\n`,
        loader: 'js'
      }))
    }
  }
}

await rm(BUILD_DIR, { recursive: true, force: true })
await mkdir(BUILD_DIR, { recursive: true })

const result = await build({
  entryPoints: [join(FEATHER, 'src/main/character-card/export.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  external: ['node:*'],
  logLevel: 'silent',
  plugins: [electronStub()]
})
const outPath = join(BUILD_DIR, 'export.mjs')
await writeFile(outPath, result.outputFiles[0].text, 'utf8')
const mod = await import(pathToFileURL(outPath).href)

const {
  crc32,
  pngChunk,
  embedPngText,
  buildPngCard,
  readPngCard,
  cardToV2Json,
  cardToBase64,
  makePlaceholderPng
} = mod

const checks = []
function check(name, cond, detail = '') {
  checks.push({ name, ok: !!cond, detail })
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : detail ? `  — ${detail}` : ''}`)
}

// ---------------------------------------------------------------------------
// ① crc32 已知向量
// ---------------------------------------------------------------------------
// PNG 规范给出的标准向量：ASCII "IEND" 的 CRC = 0xAE426082
check('crc32("IEND") == 0xAE426082', crc32(Buffer.from('IEND', 'latin1')) === 0xae426082, '0x' + crc32(Buffer.from('IEND', 'latin1')).toString(16))
check('crc32 空串 == 0', crc32(new Uint8Array(0)) === 0, String(crc32(new Uint8Array(0))))
check('crc32("123456789") == 0xCBF43926', crc32(Buffer.from('123456789')) === 0xcbf43926, '0x' + crc32(Buffer.from('123456789')).toString(16))

// ---------------------------------------------------------------------------
// ② 占位 PNG 本身合法（能解析出自己的块）
// ---------------------------------------------------------------------------
const ph = makePlaceholderPng(64, [243, 236, 226])
check('占位 PNG 有正确签名', [0x89, 0x50, 0x4e, 0x47].every((b, i) => ph[i] === b), '')
const phType = String.fromCharCode(ph[12], ph[13], ph[14], ph[15])
check('占位 PNG 第一个块是 IHDR', phType === 'IHDR', phType)

// 遍历块并校验每个块的 CRC
function listChunks(png) {
  const out = []
  let off = 8
  while (off + 8 <= png.length) {
    const len = (png[off] << 24) | (png[off + 1] << 16) | (png[off + 2] << 8) | png[off + 3]
    const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7])
    const data = png.subarray(off + 8, off + 8 + len)
    const crcStored = ((png[off + 8 + len] << 24) | (png[off + 8 + len + 1] << 16) | (png[off + 8 + len + 2] << 8) | png[off + 8 + len + 3]) >>> 0
    const crcCalc = crc32(png.subarray(off + 4, off + 8 + len))
    out.push({ type, len, data, crcOk: crcStored === crcCalc })
    if (type === 'IEND') break
    off += 4 + 4 + len + 4
  }
  return out
}
const phChunks = listChunks(ph)
check('占位 PNG 每块 CRC 正确', phChunks.every((c) => c.crcOk), JSON.stringify(phChunks.map((c) => c.type)))
check('占位 PNG 以 IEND 结尾', phChunks[phChunks.length - 1].type === 'IEND', phChunks[phChunks.length - 1].type)
// 解 IDAT，确认尺寸/像素数量对得上
const idat = Buffer.concat(phChunks.filter((c) => c.type === 'IDAT').map((c) => Buffer.from(c.data)))
const raw = inflateSync(idat)
check('占位 PNG IDAT 解压后长度正确（含 filter 字节）', raw.length === (1 + 64 * 3) * 64, `${raw.length} vs ${(1 + 64 * 3) * 64}`)
check('占位 PNG 像素是设定色', raw[1] === 243 && raw[2] === 236 && raw[3] === 226, `${raw[1]},${raw[2]},${raw[3]}`)

// ---------------------------------------------------------------------------
// ③ 构造一张卡片 + 世界书
// ---------------------------------------------------------------------------
const CARD = {
  id: 'dantes',
  name: '爱德蒙·唐太斯',
  aliases: ['唐太斯', '爱德蒙'],
  importanceLevel: 'CORE',
  identInfos: ['法老号大副', '老唐太斯之子'],
  profile: '航海归来，接任病故船长指挥。婚宴被捕后仍信任司法。',
  lifeStatus: '存活',
  appearanceChapters: [1, 2, 3],
  portraits: [],
  voice: { voiceType: 'young_male', description: '中低音，沉稳', samplePath: '', sampleUrl: '' },
  relations: [{ otherName: '美塞苔丝', otherCharacterId: 'mercedes', overview: '相爱并订婚', summary: '两人期待婚后生活。', fromChapter: 1, toChapter: 9 }],
  actionCount: 42,
  description: '身份：法老号大副。航海归来。外貌：黑发黑眼。',
  personality: '法老号大副；在他人眼中：相爱并订婚',
  scenario: '历史现实主义冒险小说。你与「爱德蒙·唐太斯」的对话开始于第 1 章。',
  firstMes: '我是爱德蒙·唐太斯，法老号大副。你想问什么，尽管说。',
  mesExample: '',
  creatorNotes: '由 DreamWeave 生成',
  systemPrompt: '',
  creator: 'DreamWeave',
  cardVersion: '1.0',
  createdAt: '2026-11-04T00:00:00.000Z',
  sourceTitle: '基督山伯爵',
  novelGenre: '历史现实主义冒险小说'
}
const LORE = [
  { id: 'char:dantes', name: '爱德蒙·唐太斯', keys: ['爱德蒙·唐太斯', '唐太斯', '爱德蒙'], content: '身份：法老号大副', constant: false, insertionOrder: 100, source: 'character' },
  { id: 'rel:a::b', name: '爱德蒙 × 美塞苔丝', keys: ['爱德蒙·唐太斯', '美塞苔丝'], content: '相爱并订婚', constant: false, insertionOrder: 101, source: 'relation' },
  { id: 'world:main', name: '世界观', keys: [], content: '题材：历史现实主义冒险小说\n1815 年法国', constant: true, insertionOrder: 1, source: 'world' }
]

// ---------------------------------------------------------------------------
// ④ V2 JSON 结构
// ---------------------------------------------------------------------------
const v2 = cardToV2Json(CARD, LORE)
check('V2 spec = chara_card_v2', v2.spec === 'chara_card_v2', String(v2.spec))
check('V2 spec_version = 2.0', v2.spec_version === '2.0', String(v2.spec_version))
check('V2 顶层有 name（老版本兼容）', v2.name === '爱德蒙·唐太斯', String(v2.name))
check('V2 顶层有 first_mes（老版本兼容）', typeof v2.first_mes === 'string' && v2.first_mes.length > 0, '')
check('V2 data.name 与顶层一致', v2.data?.name === v2.name, `${v2.data?.name} vs ${v2.name}`)
check('V2 data 五个核心文本字段齐备', ['description', 'personality', 'scenario', 'first_mes', 'mes_example'].every((k) => typeof v2.data[k] === 'string'), JSON.stringify(Object.keys(v2.data).slice(0, 8)))
check('V2 带 character_book', !!v2.data.character_book, 'missing')
const bookEntries = v2.data?.character_book?.entries ?? []
check('世界书条目数正确', bookEntries.length === LORE.length, `${bookEntries.length}/${LORE.length}`)
check('世界观条目 constant = true', bookEntries.find((e) => e.constant)?.position === 'before_char', '')
check('人物条目 keys 含别名', (bookEntries.find((e) => e.name === '爱德蒙·唐太斯')?.keys ?? []).includes('爱德蒙'), '')
check('extensions.dreamweave 保留软件内信息', v2.data?.extensions?.dreamweave?.characterId === 'dantes', '')

// base64 往返
const b64 = cardToBase64(v2)
const back = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
check('base64 往返后 JSON 完全一致', JSON.stringify(back) === JSON.stringify(v2), '')

// ---------------------------------------------------------------------------
// ⑤ 写入 PNG 并读回（SillyTavern 的真实读取路径）
// ---------------------------------------------------------------------------
const cardPng = buildPngCard(CARD, ph, LORE)
check('buildPngCard 返回字节', !!cardPng, 'null')
const chunks2 = listChunks(cardPng)
check('卡片 PNG 每块 CRC 正确', chunks2.every((c) => c.crcOk), JSON.stringify(chunks2.filter((c) => !c.crcOk).map((c) => c.type)))
const textChunks = chunks2.filter((c) => c.type === 'tEXt')
check('写入两个 tEXt 块（chara + ccv3）', textChunks.length === 2, String(textChunks.length))
const kwNames = textChunks.map((c) => Buffer.from(c.data.subarray(0, c.data.indexOf(0))).toString('latin1')).sort()
check('tEXt 关键字是 chara 与 ccv3', JSON.stringify(kwNames) === JSON.stringify(['ccv3', 'chara']), JSON.stringify(kwNames))
check('多出两块后 IEND 仍在最后', chunks2[chunks2.length - 1].type === 'IEND', '')

// 原 IDAT 未被改动（像素零损失）
const idat2 = Buffer.concat(chunks2.filter((c) => c.type === 'IDAT').map((c) => Buffer.from(c.data)))
check('原图 IDAT 字节完全未变（无重编码）', idat2.equals(idat), `${idat2.length} vs ${idat.length}`)

// 读回
const readBack = readPngCard(cardPng)
check('readPngCard 能读回卡片', !!readBack, 'null')
check('读回的名字正确', readBack?.name === '爱德蒙·唐太斯', String(readBack?.name))
check('读回的 spec 正确', readBack?.spec === 'chara_card_v2', String(readBack?.spec))
check('读回的世界书条目数正确', (readBack?.data?.character_book?.entries ?? []).length === LORE.length, '')

// ---------------------------------------------------------------------------
// ⑥ 异常输入
// ---------------------------------------------------------------------------
check('非 PNG 输入 embedPngText 返回 null', embedPngText(Buffer.from('not a png at all'), [{ keyword: 'chara', text: 'x' }]) === null, '')
check('非 PNG 输入 readPngCard 返回 null', readPngCard(Buffer.from('nope')) === null, '')
// 合法签名但无 IEND
const truncated = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)])
check('有签名但无 IEND 也返回 null', embedPngText(truncated, [{ keyword: 'chara', text: 'x' }]) === null, '')
check('没有 tEXt 的 PNG 读回 null', readPngCard(ph) === null, '')
// 空世界书 → 不产生 character_book
const v2NoLore = cardToV2Json(CARD, [])
check('无世界书时不生成 character_book', v2NoLore.data.character_book === undefined, String(v2NoLore.data.character_book))
check('无世界书时卡片仍完整', typeof v2NoLore.data.first_mes === 'string', '')

// ---------------------------------------------------------------------------
// ⑦ pngChunk 结构自检
// ---------------------------------------------------------------------------
const single = pngChunk('tEXt', Buffer.from('k\0v', 'latin1'))
check('pngChunk 长度字段 = data 长度', ((single[0] << 24) | (single[1] << 16) | (single[2] << 8) | single[3]) === 3, String(single[3]))
check('pngChunk 总长 = 12 + data', single.length === 12 + 3, String(single.length))

await rm(BUILD_DIR, { recursive: true, force: true })

const bar = '─'.repeat(64)
const fails = checks.filter((c) => !c.ok)
console.log(`\n${bar}\n  角色卡 PNG 导出验证\n${bar}`)
console.log(`  共 ${checks.length} 项`)
console.log(bar)
if (fails.length) {
  console.log(`  ✗ ${fails.length} 项失败\n${bar}\n`)
  process.exit(1)
}
console.log(`  ✓ ${checks.length} 项全部通过\n${bar}\n`)

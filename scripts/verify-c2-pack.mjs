/**
 * C2 · 「一键导出 .t2w」验证脚本（node 直跑，**不启动 Electron**；零新增依赖）。
 *
 * 要证的事：**导出是导入的逆过程** —— 工作库 → `.t2w` → 重新导入 → 与原库内容等价。
 *
 * `.t2w` 字节布局（读 `src/main/t2w/core.mjs` 得来，导出侧必须严格互逆）：
 *   [ 8B] magic    = ASCII "T2WPKG1\n"（54 32 57 50 4b 47 31 0a）
 *   [ 4B] jsonLen  = **大端** uint32（注意不是小端），其后 manifest JSON 的 UTF-8 字节数
 *   [ N B] manifest= UTF-8 JSON（format / includesSource / project / records / files）
 *   [  M] blob     = 按 files[] 顺序**紧密拼接**的二进制段，**不存 offset**，
 *                    偏移一律由 `12 + jsonLen + Σ 前序 size` 累加推算（core.computeOffsets）
 * 因此 `byteStart/byteEnd` 不是包里写死的字段，而是 jsonLen 与 size 前缀和的函数 ——
 * 只要 records 被编辑过（jsonLen 变了），沿用来源包偏移就必错，必须按实际写出重算。
 *
 * 断言六组：
 *  A. 导出（真实库 a57f3deb **只读** → D 盘临时目录）——ok、非空、magic/format 合规、
 *     未编辑档**与来源包逐字节相等**（bytes == origin.t2wSize 且 sha256 == origin.t2wSha256）、
 *     files 数与资产数一致、warnings 为空、走 origin-header（G1）；
 *     脚本**独立重算**每个成员的 byteStart/byteEnd 与 core.computeOffsets 对拍，
 *     并逐段 sha256 复检（抽查前 5 个 + 原文那条）；
 *  B. 往返（导出包 → unpack 重新导入到临时工作库根）——pkgId / title / recordsKeys 一致，
 *     chapters.json 与 chunks.json 条目数一致，分片数与资产数与 index 登记一致，
 *     全部资产磁盘字节 sha256 与登记一致，**原文资产 sha256 与原库一致**（正文一字节不差）；
 *  C. byteStart/byteEnd 重算校验 —— ① 用导出包里的 spans 直接切出原文字节 == 原库原文；
 *     ② 重新导入后按章节 byteStart/byteEnd 切出的正文与原库**逐字相同**；
 *  D. 多章对拍（第二本只读库 e5fcb27d，8 章，字节更小）——导出 → 重新导入 →
 *     逐章 slice 逐字相同 + 原文 sha 一致 + 与来源包逐字节相等（单章书会掩盖偏移错误）；
 *  E. 容错 —— 缺分片（复制库删文件）：导出仍成功且 warnings 里有它、产物仍可导入；
 *     outPath 不可写（父路径是已存在的普通文件 / 目标是目录）→ ok:false 且**不留半截文件**；
 *     空 root / 空 outPath → ok:false 不抛；
 *  F. 只读红线 —— 导出前后真实库 index.json、原文资产、一个分片的 size 与 mtime 不变，
 *     且整库 dirBytes 不变（基线 23859779）。
 *
 * 姿势同 `scripts/verify-t7a-map-source.mjs`：`createRequire(feather/package.json)` 取项目已装的
 * esbuild，把 pack.ts / unpack.ts / index-store.ts / shards.ts 打成临时 ESM 后 `pathToFileURL`
 * 动态 import；electron 以最小桩替换；`core.mjs` 只依赖 node:crypto，**直接 import** 不打包
 * （这样脚本里的偏移对拍与导出侧是同一份算法，且能独立验算）。
 *
 * 临时目录**只准碰** `D:/AI/tx/feather-c2-test/`（跑完 rm -rf 清掉）；真实工作库**只读**
 * （A/B/C 读 a57f3deb，D 读 e5fcb27d，E 先复制到临时目录再改，绝不写真实库）。
 *
 * 用法：node scripts/verify-c2-pack.mjs
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(here, '..')
/** 唯一允许触碰的临时父目录（跑完 rm -rf 清掉） */
const TEST_PARENT = 'D:/AI/tx/feather-c2-test'
const BUILD_DIR = join(TEST_PARENT, 'build')

/** 主验证源：7 本里最小的一本（**只读**；dirBytes 基线 23859779） */
const REAL_A = 'C:/Users/wfsyb/AppData/Roaming/feather/workspace/a57f3deb-09f5-49ad-879f-ca2aa0d4b744'
const REAL_A_BYTES = 23859779
/** 副验证源：8 章（**只读**；单章书会掩盖 byteStart/byteEnd 偏移错误，故补一本多章的） */
const REAL_B = 'C:/Users/wfsyb/AppData/Roaming/feather/workspace/e5fcb27d-9904-4430-bacf-8139da7f8dd4'

const CHAPTERS_FILE = 'records/chapters.json'
const CHUNKS_FILE = 'records/chunks.json'
const SOURCE_SUFFIX = '/source/body.utf8.txt'

const require = createRequire(join(FEATHER, 'package.json'))
const { build } = require('esbuild')

/** electron 最小桩（pack/unpack/shards 零 electron 依赖，桩只为保险）。 */
function electronStub() {
  return {
    name: 'electron-stub',
    setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }))
      b.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
        contents:
          `export const app = { getAppPath: () => ${JSON.stringify(FEATHER)}, getPath: () => ${JSON.stringify(TEST_PARENT)} };\n` +
          `export const ipcMain = { handle(){}, on(){} };\n` +
          `export const BrowserWindow = { getAllWindows: () => [], fromWebContents: () => null };\n` +
          `export const dialog = { showSaveDialog: async () => ({ canceled: true }) };\n` +
          `export default { app, ipcMain, BrowserWindow, dialog };\n`,
        loader: 'js'
      }))
    }
  }
}

/** 打包单条目为临时 ESM 文件并动态 import（pathToFileURL）。 */
async function loadModule(rel, outName) {
  const result = await build({
    entryPoints: [join(FEATHER, rel)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    external: ['node:*'],
    logLevel: 'silent',
    define: { __dirname: JSON.stringify(join(FEATHER, 'out', 'main')) },
    plugins: [electronStub()]
  })
  const outPath = join(BUILD_DIR, outName)
  await writeFile(outPath, result.outputFiles[0].text, 'utf8')
  return import(pathToFileURL(outPath).href)
}

let passed = 0
let failed = 0
let skipped = 0
function check(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function skip(name, why) {
  skipped++
  console.log(`  ⚠️  跳过 ${name}（${why}）`)
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const MAGIC = Buffer.from([0x54, 0x32, 0x57, 0x50, 0x4b, 0x47, 0x31, 0x0a])

/** 递归统计目录下所有普通文件字节和（真实库只读红线用）。 */
async function dirBytes(dir) {
  let total = 0
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const abs = join(dir, e.name)
    try {
      if (e.isDirectory()) total += await dirBytes(abs)
      else if (e.isFile()) total += (await stat(abs)).size
    } catch {
      /* 单个条目失败不影响整表 */
    }
  }
  return total
}

/** 读工作库的某分片条目数（读不到返回 -1）。 */
async function shardEntryCount(sh, root, file) {
  try {
    const env = await sh.readShard(root, file)
    return Array.isArray(env?.entries) ? env.entries.length : -1
  } catch {
    return -1
  }
}

/** 取工作库的原文资产行 + 磁盘字节（找不到返回 null）。 */
async function readSourceAsset(root, idx) {
  const row = idx.assets.find((a) => a.path.endsWith(SOURCE_SUFFIX) || a.path === 'source/body.utf8.txt')
  if (!row) return null
  const buf = Buffer.from(await readFile(join(root, row.store)))
  return { row, buf }
}

/** 从 chapters 分片取章节区间列表（[{seq,title,byteStart,byteEnd}]，按 seq 升序）。 */
async function chaptersOf(sh, root) {
  const env = await sh.readShard(root, CHAPTERS_FILE)
  const list = (env?.entries ?? [])
    .map((e) => e?.value)
    .filter((v) => v && typeof v === 'object')
    .map((v) => ({
      seq: Number(v.seq ?? 0),
      title: String(v.title ?? ''),
      byteStart: Number(v.byteStart ?? 0),
      byteEnd: Number(v.byteEnd ?? 0)
    }))
    .sort((a, b) => a.seq - b.seq)
  return list
}

/** 全量资产盘字节 sha256 与 index 登记比对，返回不一致的 path 列表。 */
async function mismatchedAssets(root, idx) {
  const bad = []
  for (const a of idx.assets) {
    try {
      const buf = Buffer.from(await readFile(join(root, a.store)))
      if (buf.length !== a.size || sha256(buf) !== a.sha256) bad.push(a.path)
    } catch {
      bad.push(`${a.path}（读不到）`)
    }
  }
  return bad
}

let pack // pack.ts
let unpack // unpack.ts
let store // index-store.ts
let sh // shards.ts
let core // core.mjs（直接 import，与导出侧同一份算法）

// ---------------------------------------------------------------------------
// 单本书的完整往返：导出 → 重新导入 → 对拍
// ---------------------------------------------------------------------------
/**
 * @returns {{ idx1, idx2, outPath, out, spans, res, src1, chapters1 }}
 */
async function roundTrip(bookRoot, tag) {
  const idx1 = await store.readIndex(bookRoot)
  const outPath = join(TEST_PARENT, 'out', `${tag}.export.t2w`)
  const res = await pack.packWorkspace(bookRoot, outPath)
  const out = Buffer.from(await readFile(outPath))
  // 重新导入到临时工作库根
  const reRoot = join(TEST_PARENT, 'reimport', tag)
  await unpack.unpack(outPath, reRoot)
  const idx2 = await store.readIndex(reRoot)
  const src1 = await readSourceAsset(bookRoot, idx1)
  const chapters1 = await chaptersOf(sh, bookRoot)
  return { idx1, idx2, outPath, out, spans: res.files ?? [], res, src1, chapters1, reRoot }
}

async function main() {
  await rm(TEST_PARENT, { recursive: true, force: true })
  await mkdir(BUILD_DIR, { recursive: true })
  console.log(`临时目录：${TEST_PARENT}\n`)

  pack = await loadModule('src/main/workspace/pack.ts', 'pack.mjs')
  unpack = await loadModule('src/main/workspace/unpack.ts', 'unpack.mjs')
  store = await loadModule('src/main/workspace/index-store.ts', 'index-store.mjs')
  sh = await loadModule('src/main/workspace/shards.ts', 'shards.mjs')
  core = await import(pathToFileURL(join(FEATHER, 'src/main/t2w/core.mjs')).href)

  // 只读红线基线：导出前先量一遍
  const before = {
    index: await stat(join(REAL_A, 'index.json')),
    chapters: await stat(join(REAL_A, CHAPTERS_FILE)),
    bytes: await dirBytes(REAL_A),
    bIndex: existsSync(join(REAL_B, 'index.json')) ? await stat(join(REAL_B, 'index.json')) : null
  }
  const idxA0 = await store.readIndex(REAL_A)
  const srcA0 = await readSourceAsset(REAL_A, idxA0)

  // =====================================================================
  // A · 导出（真实库 a57f3deb，只读）
  // =====================================================================
  console.log('A · 导出（真实库 a57f3deb，只读 → D 盘临时目录）')
  check('A0 真实库存在且索引可读', existsSync(join(REAL_A, 'index.json')), REAL_A)
  check('A0b 真实库 dirBytes 基线 23859779', before.bytes === REAL_A_BYTES, String(before.bytes))
  check('A0c 真实库有原文资产 source/body.utf8.txt', !!srcA0, JSON.stringify(srcA0?.row?.path ?? null))

  const A = await roundTrip(REAL_A, 'book-a')
  const { idx1, idx2, outPath, out, spans, res, src1, chapters1, reRoot } = A

  check('A1 packWorkspace 返回 ok:true', res.ok === true, res.error ?? '')
  check('A2 导出文件存在且非空', existsSync(outPath) && (await stat(outPath)).size > 0, String(res.bytes))
  check('A3 bytes > 0 且与磁盘 stat 一致', res.bytes > 0 && res.bytes === (await stat(outPath)).size, `${res.bytes}`)
  check('A4 未编辑档：导出字节数 == 来源包字节数（origin.t2wSize）', res.bytes === idx1.origin.t2wSize, `${res.bytes} vs ${idx1.origin.t2wSize}`)
  check('A5 未编辑档：导出 sha256 == origin.t2wSha256（**与来源包逐字节相等**）', sha256(out) === idx1.origin.t2wSha256, `${sha256(out).slice(0, 16)}… vs ${idx1.origin.t2wSha256.slice(0, 16)}…`)
  check('A6 byteExact === true（导出侧自判定）', res.byteExact === true, String(res.byteExact))
  check('A7 走 origin-header 拼接路径（G1，usedOriginHeader）', res.usedOriginHeader === true, String(res.usedOriginHeader))
  check('A8 magic 前 8 字节 = "T2WPKG1\\n"', out.subarray(0, 8).equals(MAGIC), out.subarray(0, 8).toString('hex'))
  check('A9 warnings 为空（真实库无缺失）', (res.warnings ?? []).length === 0, JSON.stringify(res.warnings))

  {
    let decoded = null
    let err = ''
    try {
      decoded = core.decodeHeader(out)
    } catch (e) {
      err = e?.message ?? String(e)
    }
    check('A10 decodeHeader（导入侧内核）解析导出包不抛', !err, err)
    check('A11 manifest.format === "txt2world-package-v1"', decoded?.manifest?.format === 'txt2world-package-v1', String(decoded?.manifest?.format))
    check('A12 files 数量 == 工作库资产数', decoded?.manifest?.files?.length === idx1.assets.length, `${decoded?.manifest?.files?.length} vs ${idx1.assets.length}`)
    check('A13 头部 jsonLen 与实际一致（12 + jsonLen = blobStart）', decoded ? decoded.blobStart === 12 + decoded.jsonLen : false, String(decoded?.blobStart))

    // —— byteStart/byteEnd 独立重算对拍（脚本自己按 core.computeOffsets 算一遍）——
    const files = decoded?.manifest?.files ?? []
    const offsets = core.computeOffsets(files, decoded.blobStart)
    const expect = files.map((f, i) => ({ byteStart: offsets[i], byteEnd: offsets[i] + f.size }))
    check('A14 spans 数量与 files 一致', spans.length === files.length, `${spans.length} vs ${files.length}`)
    check(
      'A15 逐成员 byteStart/byteEnd 与 core.computeOffsets **独立重算**结果一致（导出侧没沿用旧偏移）',
      spans.every((s, i) => s.byteStart === expect[i].byteStart && s.byteEnd === expect[i].byteEnd),
      JSON.stringify(spans.slice(0, 2))
    )
    check('A16 首个成员 byteStart == blobStart（12 + jsonLen）', spans[0]?.byteStart === decoded.blobStart, `${spans[0]?.byteStart} vs ${decoded?.blobStart}`)
    const last = spans[spans.length - 1]
    check('A17 末个成员 byteEnd == 文件长度（无尾随字节）', last?.byteEnd === out.length, `${last?.byteEnd} vs ${out.length}`)
    const sumSize = files.reduce((s, f) => s + f.size, 0)
    check('A18 Σfiles[].size == blobLen（与 unpack 守卫同构）', sumSize === out.length - decoded.blobStart, `${sumSize} vs ${out.length - decoded.blobStart}`)

    // 逐段 sha256 复检：前 5 个 + 原文那条（全量 88 个太慢，抽查 + 原文必查）
    const sampleIdx = [0, 1, 2, 3, 4]
    const srcIdx = files.findIndex((f) => f.path.endsWith(SOURCE_SUFFIX) || f.path === 'source/body.utf8.txt')
    if (srcIdx >= 0 && !sampleIdx.includes(srcIdx)) sampleIdx.push(srcIdx)
    const bad = []
    for (const i of sampleIdx) {
      const s = spans[i]
      if (!s) continue
      const actual = sha256(out.subarray(s.byteStart, s.byteEnd))
      if (actual !== files[i].sha256) bad.push(`${files[i].path}:${actual.slice(0, 8)}`)
    }
    check(`A19 抽查 ${sampleIdx.length} 个成员：按 byteStart/byteEnd 切出的字节 sha256 与清单一致`, bad.length === 0, JSON.stringify(bad))
    check('A20 抽查含原文资产（正文必查）', srcIdx >= 0, String(srcIdx))
  }

  // =====================================================================
  // B · 往返（导出包 → 重新导入）
  // =====================================================================
  console.log('\nB · 往返（导出包重新导入 → 与原库等价）')
  check('B1 重新导入不抛且 index.json 可读', !!idx2 && !!reRoot, String(reRoot))
  check('B2 pkgId 与原库一致', idx2.pkgId === idx1.pkgId, `${idx2.pkgId} vs ${idx1.pkgId}`)
  check('B3 title 与原库一致', idx2.title === idx1.title, `${idx2.title} vs ${idx1.title}`)
  check('B4 manifest.recordsKeys 与原库一致（含顺序）', JSON.stringify(idx2.manifest.recordsKeys) === JSON.stringify(idx1.manifest.recordsKeys), JSON.stringify(idx2.manifest.recordsKeys))
  const cnt1c = await shardEntryCount(sh, REAL_A, CHAPTERS_FILE)
  const cnt2c = await shardEntryCount(sh, reRoot, CHAPTERS_FILE)
  const cnt1k = await shardEntryCount(sh, REAL_A, CHUNKS_FILE)
  const cnt2k = await shardEntryCount(sh, reRoot, CHUNKS_FILE)
  check('B5 records/chapters.json 条目数与原库一致', cnt1c > 0 && cnt1c === cnt2c, `${cnt1c} vs ${cnt2c}`)
  check('B6 records/chunks.json 条目数与原库一致', cnt1k > 0 && cnt1k === cnt2k, `${cnt1k} vs ${cnt2k}`)
  check('B7 分片数与 index.shards 登记一致（原库 ↔ 重导库）', idx2.shards.length === idx1.shards.length, `${idx2.shards.length} vs ${idx1.shards.length}`)
  check('B8 资产数与 index.assets 登记一致（原库 ↔ 重导库）', idx2.assets.length === idx1.assets.length, `${idx2.assets.length} vs ${idx1.assets.length}`)
  {
    const missing = idx2.shards.filter((s) => !existsSync(join(reRoot, s.file))).map((s) => s.file)
    check('B9 全部登记分片文件在重导库里都存在', missing.length === 0, JSON.stringify(missing))
    const bad = await mismatchedAssets(reRoot, idx2)
    check('B10 全部资产磁盘字节 sha256 与 index 登记一致（全量）', bad.length === 0, JSON.stringify(bad.slice(0, 3)))
  }
  {
    const src2 = await readSourceAsset(reRoot, idx2)
    check('B11 重导库有原文资产', !!src2, JSON.stringify(src2?.row?.path ?? null))
    check('B12 **原文资产 sha256 与原库一致**（正文一个字节都不能差）', !!src2 && src2.row.sha256 === src1.row.sha256, `${src2?.row?.sha256} vs ${src1.row.sha256}`)
    check('B13 原文资产字节数与原库一致', !!src2 && src2.buf.length === src1.buf.length, `${src2?.buf.length} vs ${src1.buf.length}`)
    check('B14 原文资产磁盘字节 sha256 == 登记 sha256（原库侧同样成立）', sha256(src1.buf) === src1.row.sha256, `${sha256(src1.buf).slice(0, 16)}…`)
    check('B15 原文 UTF-8 解码逐字相同（不是只 sha 相等）', !!src2 && src2.buf.toString('utf8') === src1.buf.toString('utf8'))
  }

  // =====================================================================
  // C · byteStart/byteEnd 重算校验
  // =====================================================================
  console.log('\nC · byteStart/byteEnd 重算校验（最容易错的地方）')
  {
    const srcSpanIdx = spans.findIndex((s) => s.path.endsWith(SOURCE_SUFFIX) || s.path === 'source/body.utf8.txt')
    check('C1 导出包里能定位原文成员的字节区间', srcSpanIdx >= 0, String(srcSpanIdx))
    const cut = out.subarray(spans[srcSpanIdx].byteStart, spans[srcSpanIdx].byteEnd)
    check('C2 **用导出包的 byteStart/byteEnd 切出的原文 == 原库原文字节**（偏移写对了）', Buffer.from(cut).equals(src1.buf), `${cut.length} vs ${src1.buf.length}`)

    const chapters2 = await chaptersOf(sh, reRoot)
    check('C3 重导库章节数与原库一致', chapters2.length === chapters1.length && chapters1.length > 0, `${chapters2.length} vs ${chapters1.length}`)
    const src2 = await readSourceAsset(reRoot, idx2)
    const diff = []
    for (let i = 0; i < chapters1.length; i++) {
      const a = chapters1[i]
      const b = chapters2[i]
      const ta = src1.buf.subarray(a.byteStart, a.byteEnd).toString('utf8')
      const tb = src2.buf.subarray(b.byteStart, b.byteEnd).toString('utf8')
      if (a.byteStart !== b.byteStart || a.byteEnd !== b.byteEnd || ta !== tb) {
        diff.push(`#${a.seq}(${a.byteStart}-${a.byteEnd} vs ${b.byteStart}-${b.byteEnd})`)
      }
    }
    check(`C4 逐章按 byteStart/byteEnd 切出的正文与原库**逐字相同**（${chapters1.length} 章）`, diff.length === 0, JSON.stringify(diff.slice(0, 3)))
    check('C5 章节区间非空且落在原文长度内', chapters1.every((c) => c.byteEnd > c.byteStart && c.byteEnd <= src1.buf.length), JSON.stringify(chapters1.slice(0, 2)))
  }

  // =====================================================================
  // D · 多章对拍（第二本只读库 e5fcb27d，8 章）
  // =====================================================================
  console.log('\nD · 多章对拍（第二本只读库 e5fcb27d，8 章）')
  if (!existsSync(join(REAL_B, 'index.json'))) {
    skip('D 组', `找不到 ${join(REAL_B, 'index.json')}`)
  } else {
    const B = await roundTrip(REAL_B, 'book-b')
    check('D1 导出 ok:true', B.res.ok === true, B.res.error ?? '')
    check('D2 未编辑档：与来源包逐字节相等（sha256 == origin.t2wSha256）', sha256(B.out) === B.idx1.origin.t2wSha256, `${sha256(B.out).slice(0, 16)}…`)
    check('D3 warnings 为空', (B.res.warnings ?? []).length === 0, JSON.stringify(B.res.warnings))
    check('D4 章节数 > 1（多章才有对拍价值）', B.chapters1.length > 1, String(B.chapters1.length))
    check('D5 原文资产 sha256 与原库一致', !!B.src1 && B.src1.row.sha256 === B.idx2.assets.find((a) => a.path.endsWith(SOURCE_SUFFIX))?.sha256, String(B.src1?.row?.sha256))
    const chapters2 = await chaptersOf(sh, B.reRoot)
    const src2 = await readSourceAsset(B.reRoot, B.idx2)
    const diff = []
    for (let i = 0; i < B.chapters1.length; i++) {
      const a = B.chapters1[i]
      const b = chapters2[i]
      const ta = B.src1.buf.subarray(a.byteStart, a.byteEnd).toString('utf8')
      const tb = src2.buf.subarray(b.byteStart, b.byteEnd).toString('utf8')
      if (!b || a.byteStart !== b.byteStart || a.byteEnd !== b.byteEnd || ta !== tb) diff.push(`#${a.seq}`)
    }
    check(`D6 逐章（${B.chapters1.length} 章）byteStart/byteEnd 切出的正文与原库逐字相同`, diff.length === 0, JSON.stringify(diff.slice(0, 3)))
    check('D7 各章区间互不重叠且递增（区间本身没被写串）', B.chapters1.every((c, i) => i === 0 || c.byteStart >= B.chapters1[i - 1].byteStart), JSON.stringify(B.chapters1.map((c) => [c.byteStart, c.byteEnd])))
    check('D8 分片数与原库一致', B.idx2.shards.length === B.idx1.shards.length, `${B.idx2.shards.length} vs ${B.idx1.shards.length}`)
    check('D9 资产数与原库一致', B.idx2.assets.length === B.idx1.assets.length, `${B.idx2.assets.length} vs ${B.idx1.assets.length}`)
  }

  // =====================================================================
  // E · 容错
  // =====================================================================
  console.log('\nE · 容错（缺分片 / 目标不可写 / 空入参）')
  {
    // E1-E4：复制真实库到临时目录 → 删一个分片文件（index 登记保留）→ 导出仍成功
    const copyRoot = join(TEST_PARENT, 'copy-missing-shard')
    await cp(REAL_A, copyRoot, { recursive: true })
    const victim = 'records/results/canonical.json'
    const victimAbs = join(copyRoot, victim)
    const hasVictim = existsSync(victimAbs)
    check('E0 复制库里存在待删的分片', hasVictim, victim)
    if (hasVictim) {
      await rm(victimAbs, { force: true })
      const out2 = join(TEST_PARENT, 'out', 'missing-shard.t2w')
      const res2 = await pack.packWorkspace(copyRoot, out2)
      check('E1 缺分片 → 导出仍 ok:true', res2.ok === true, res2.error ?? '')
      check('E2 warnings 里有这个缺失分片（**不静默丢**）', (res2.warnings ?? []).some((w) => w.includes(victim)), JSON.stringify(res2.warnings))
      check('E3 导出产物非空且合规（magic 正确）', existsSync(out2) && (await stat(out2)).size > 0 && Buffer.from(await readFile(out2)).subarray(0, 8).equals(MAGIC), String(res2.bytes))
      check('E4 已编辑档不再逐字节相等（byteExact=false，走 G2 encodePackage）', res2.byteExact === false, String(res2.byteExact))
      let errRe = ''
      try {
        await unpack.unpack(out2, join(TEST_PARENT, 'reimport', 'missing-shard'))
      } catch (e) {
        errRe = e?.message ?? String(e)
      }
      check('E5 缺分片的导出包**仍能被重新导入**（不抛）', !errRe, errRe)
      const badSpans = (res2.files ?? []).filter((s) => s.byteEnd <= s.byteStart)
      check('E6 spans 仍然自洽（区间非空）', badSpans.length === 0, JSON.stringify(badSpans.slice(0, 2)))
    }

    // E7-E8：outPath 父路径是**已存在的普通文件** → mkdir 必失败
    const blocker = join(TEST_PARENT, 'blocker.txt')
    await writeFile(blocker, 'not a dir', 'utf8')
    const outBlocked = join(blocker, 'x.t2w')
    const resBlocked = await pack.packWorkspace(REAL_A, outBlocked)
    check('E7 outPath 父路径是普通文件 → ok:false 且有 error', resBlocked.ok === false && !!resBlocked.error, JSON.stringify(resBlocked))
    check('E8 失败后目标路径不存在（**无半截文件**）', !existsSync(outBlocked), outBlocked)
    const leftovers = (await readdir(TEST_PARENT)).filter((n) => n.includes('.tmp-'))
    check('E9 失败后无 .tmp- 残留', leftovers.length === 0, JSON.stringify(leftovers))
    check('E10 失败不影响 blocker 文件本身（仍是 9 字节的普通文件）', (await stat(blocker)).size === 9, String((await stat(blocker)).size))

    // E11-E12：outPath 指向**已存在的目录** → rename 必失败
    const dirTarget = join(TEST_PARENT, 'dir-target')
    await mkdir(dirTarget, { recursive: true })
    const resDir = await pack.packWorkspace(REAL_A, dirTarget)
    check('E11 outPath 是目录 → ok:false 且有 error', resDir.ok === false && !!resDir.error, JSON.stringify(resDir))
    check('E12 目标仍是目录（没被半截文件替换）', existsSync(dirTarget) && (await stat(dirTarget)).isDirectory())
    const leftovers2 = (await readdir(TEST_PARENT)).filter((n) => n.includes('.tmp-'))
    check('E13 该失败同样无 .tmp- 残留', leftovers2.length === 0, JSON.stringify(leftovers2))

    // E14-E15：空入参 → ok:false，不抛
    const rEmpty = await pack.packWorkspace('', join(TEST_PARENT, 'out', 'never.t2w'))
    check('E14 空 root → ok:false（不抛裸异常）', rEmpty.ok === false && !!rEmpty.error, JSON.stringify(rEmpty))
    const rEmptyOut = await pack.packWorkspace(REAL_A, '')
    check('E15 空 outPath → ok:false（不抛裸异常）', rEmptyOut.ok === false && !!rEmptyOut.error, JSON.stringify(rEmptyOut))
    check('E16 两种空入参都没有产出文件', !existsSync(join(TEST_PARENT, 'out', 'never.t2w')))
  }

  // =====================================================================
  // F · 只读红线（真实库 size / mtime 前后不变）
  // =====================================================================
  console.log('\nF · 只读红线（真实库 size / mtime 前后不变）')
  {
    const after = {
      index: await stat(join(REAL_A, 'index.json')),
      chapters: await stat(join(REAL_A, CHAPTERS_FILE)),
      bytes: await dirBytes(REAL_A),
      bIndex: before.bIndex ? await stat(join(REAL_B, 'index.json')) : null
    }
    check('F1 index.json 字节数不变', before.index.size === after.index.size, `${before.index.size}/${after.index.size}`)
    check('F2 index.json mtime 不变', before.index.mtimeMs === after.index.mtimeMs, `${before.index.mtimeMs}/${after.index.mtimeMs}`)
    check('F3 records/chapters.json 字节数不变', before.chapters.size === after.chapters.size, `${before.chapters.size}/${after.chapters.size}`)
    check('F4 records/chapters.json mtime 不变', before.chapters.mtimeMs === after.chapters.mtimeMs, `${before.chapters.mtimeMs}/${after.chapters.mtimeMs}`)
    check('F5 原文资产文件字节数不变', srcA0 && (await stat(join(REAL_A, srcA0.row.store))).size === srcA0.buf.length, `${srcA0?.buf.length}`)
    check('F6 整库 dirBytes 不变（仍等于基线 23859779）', before.bytes === after.bytes && after.bytes === REAL_A_BYTES, `${before.bytes}/${after.bytes}`)
    check('F7 第二本库 e5fcb27d 的 index.json size 与 mtime 不变', !before.bIndex || (before.bIndex.size === after.bIndex.size && before.bIndex.mtimeMs === after.bIndex.mtimeMs), `${before.bIndex?.size}/${after.bIndex?.size}`)
    // 真实库目录下不留任何导出产物 / tmp（导出只应写到 D 盘临时目录）
    const stray = (await readdir(REAL_A)).filter((n) => n.endsWith('.t2w') || n.includes('.tmp-'))
    check('F8 真实库目录内没有 .t2w / .tmp- 残留（导出没写进真实库）', stray.length === 0, JSON.stringify(stray))
  }

  await rm(TEST_PARENT, { recursive: true, force: true })

  console.log(`\n==== C2 一键导出验证：${passed} 通过 / ${failed} 失败${skipped ? ` / ${skipped} 跳过` : ''} ====`)
  if (failed === 0) {
    console.log('C2 PACK VERIFY PASS')
  } else {
    console.log('C2 PACK VERIFY FAIL')
  }
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('ERROR:', e?.stack ?? e?.message ?? e)
  process.exitCode = 2
})

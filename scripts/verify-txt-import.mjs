/**
 * T3 · .txt 导入验证脚本（node 直跑，**不启动 Electron**；零新增依赖）。
 *
 * 姿势与 `scripts/verify-workspace-units.mjs` 完全一致：用项目已装的 esbuild 把
 * `src/main/workspace/index.ts`（barrel，含 txt-import）打成单文件 ESM 后动态 import。
 *
 * 临时根**只准碰** `D:/AI/tx/feather-txt-import-test/ws/`（跑完 rm -rf 清掉）；
 * 绝不读写真实工作库目录。
 *
 * 覆盖：
 *   1. UTF-8 中文样本：章切分 / 字节区间逐章与原文一致 / chunks 覆盖不重不漏 / 资产 / 阅读切段守恒；
 *   2. GB18030 样本（手写字节字面量，Node 无 GB18030 编码器）：识别 + 导入 + 规范化 UTF-8；
 *   3. UTF-16LE BOM 样本（+ UTF-16BE BOM 附加项）；
 *   4. 二进制/随机字节：抛可读错误，且不留半成品工作库；
 *   5. 零章节样本：全书单章兜底，一个字符不丢；
 *   6. 幂等/隔离：同一 txt 导入两次 → 两个独立工作库；
 *   另含 splitChapters 单测（charStart 位置 / 各正则 / 空捕获兜底）与 listWorkspaces 标题口径。
 *
 * 用法：node scripts/verify-txt-import.mjs
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(here, '..')
/** 唯一允许触碰的临时父目录（跑完 rm -rf 清掉，含 ws/ 子目录） */
const TEST_PARENT = 'D:/AI/tx/feather-txt-import-test'
/** 临时工作库根（txt 来源文件 + buildTxtWorkspace 目标都在它下面） */
const TEST_ROOT = join(TEST_PARENT, 'ws')

/** 用 esbuild 把工作库 barrel 打成单文件 ESM，再用 data: URL 动态 import（零新增依赖）。 */
async function loadWorkspace() {
  const entry = join(FEATHER, 'src/main/workspace/index.ts')
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    external: ['node:*'],
    logLevel: 'silent'
  })
  const code = result.outputFiles[0].text
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
}

let passed = 0
let failed = 0
function check(name, cond) {
  if (cond) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.log(`  ❌ ${name}`)
  }
}

const ws = await loadWorkspace()

/** 导入计数器（用于 listWorkspaces 期望值） */
let importSeq = 0
let okCount = 0

/** 把一段字节当 .txt 写入临时根，并现场 alloc 一个工作库根跑 buildTxtWorkspace + readIndex 自校验。 */
async function importTxt(name, buf) {
  const txtPath = join(TEST_ROOT, `src-${importSeq}-${name}`)
  await writeFile(txtPath, buf)
  const root = join(TEST_ROOT, `lib-${importSeq++}`)
  const index = await ws.buildTxtWorkspace(txtPath, root)
  const reread = await ws.readIndex(root)
  okCount++
  return { txtPath, root, index, reread }
}

async function chaptersOf(r) {
  const env = await ws.readShard(r.root, 'records/chapters.json')
  return env.entries.map((e) => e.value)
}

async function chunkValuesOf(r) {
  const env = await ws.readShard(r.root, 'records/chunks.json')
  return env.entries.map((e) => e.value)
}

async function readAsset(r, suffix) {
  const row = r.index.assets.find((a) => a.path.endsWith(suffix))
  if (!row) throw new Error(`缺少资产：${suffix}`)
  return Buffer.from(await readFile(join(r.root, row.store)))
}

async function main() {
  await rm(TEST_PARENT, { recursive: true, force: true })
  await mkdir(TEST_ROOT, { recursive: true })
  console.log(`临时根：${TEST_ROOT}\n`)

  try {
    // ---- 1. UTF-8 中文样本 ----
    // 注：样本首行「卷一」以「卷」开头（不是「第…」），不命中章标题正则 → 本章话数为 2；
    // 标题取正则捕获组 trim（「第一章 起点」→「起点」；捕获为空才回退整行，如「第一章」）。
    console.log('1 · UTF-8 中文样本')
    const text1 = '卷一\n第一章 起点\n内容A\n第二章 中途\n内容B\n'
    const buf1 = Buffer.from(text1, 'utf8')
    const r1 = await importTxt('utf8-sample.txt', buf1)
    const p1 = r1.index.manifest.project

    check('readIndex 自校验通过（写后能读回）', JSON.stringify(r1.reread) === JSON.stringify(r1.index))
    check('index 与 unpack 同构（indexVersion=1 / format）', r1.index.indexVersion === 1 && r1.index.format === 'txt2world-workspace')
    check('chapters=2（「卷一」非「第」开头不命中；第一卷为卷首）', p1.chapterCount === 2)
    check('project.encoding=utf-8（检测标签落盘）', p1.encoding === 'utf-8')
    check('charCount=全文长度', p1.charCount === text1.length)
    check('origin.t2wSize=原始文件字节数', r1.index.origin.t2wSize === buf1.length)
    check('origin.hasOriginHeader=false（txt 无来源头）', r1.index.origin.hasOriginHeader === false)

    const ch1 = await chaptersOf(r1)
    check('章 seq 从 1 连续', ch1.map((c) => c.seq).join(',') === '1,2')
    check('章标题=捕获组 trim（起点 / 中途）', ch1.map((c) => c.title).join('|') === '起点|中途')
    let sliceOk = true
    for (const c of ch1) {
      const slice = Buffer.from(buf1.subarray(c.byteStart, c.byteEnd)).toString('utf8')
      if (!slice.includes(c.title)) {
        sliceOk = false
        console.log(`     章切片异常：${c.title} → ${JSON.stringify(slice)}`)
      }
    }
    check('逐章字节区间切出的文本含标题行', sliceOk)
    check('首章 byteStart=「第一章」行首 / 末章 byteEnd=全书字节数', ch1[0].byteStart === Buffer.byteLength('卷一\n', 'utf8') && ch1[1].byteEnd === buf1.length)
    check(
      '字节区间单调不减且首尾相接（前一章 byteEnd=后一章 byteStart）',
      ch1[1].byteStart >= ch1[0].byteStart && ch1[1].byteEnd === ch1[1].byteStart + (buf1.length - ch1[1].byteStart)
    )

    const chunks1 = await chunkValuesOf(r1)
    const covered = chunks1.flatMap((v) => v.chapterSeqs)
    check('chunks 覆盖章 seq 1..2 不重不漏', JSON.stringify([...covered].sort((a, b) => a - b)) === JSON.stringify([1, 2]))
    check('chunk index 从 0 连续', chunks1.map((v) => v.index).join(',') === chunks1.map((_, i) => i).join(','))
    check('chunk 键形如 <pkgId>:<index>', (await ws.readShard(r1.root, 'records/chunks.json')).entries.every((e, i) => e.key === `${r1.index.pkgId}:${i}`))
    check('tasks 空信封（新书零任务历史）', (await ws.readShard(r1.root, 'records/tasks.json')).entries.length === 0)
    check('shards 恰好 3 行（chapters/chunks/tasks）', r1.index.shards.length === 3 && r1.index.shards.map((s) => s.container).join(',') === 'chapters,chunks,tasks')

    check('资产两行（body.utf8.txt + original.bin）', r1.index.assets.length === 2)
    const bodyBytes1 = await readAsset(r1, '/source/body.utf8.txt')
    check('body 资产 = UTF-8 规范化正文（sha=bodyHash）', Buffer.compare(bodyBytes1, buf1) === 0 && p1.bodyHash === r1.index.assets.find((a) => a.path.endsWith('body.utf8.txt')).sha256)
    const origBytes1 = await readAsset(r1, '/source/original.bin')
    check('original 资产 = 原始文件字节', Buffer.compare(origBytes1, buf1) === 0)

    const seg1 = ws.buildReadingSegments(
      buf1,
      ch1.map((c) => ({ seq: c.seq, title: c.title, byteStart: c.byteStart, byteEnd: c.byteEnd }))
    )
    check('buildReadingSegments 一个字符不丢（字节数守恒）', seg1.segments.reduce((s, x) => s + (x.byteEnd - x.byteStart), 0) === buf1.length)
    check('buildReadingSegments 拼回全文逐字相等', seg1.segments.map((s) => s.text).join('') === text1)

    // ---- 2. GB18030 样本（手写字节字面量；Node 无 GB18030 编码器，故逐字节拼）----
    // 第一章 = B5 DA D2 BB D5 C2（实测 TextDecoder('gb18030') 解码正确）；其余为 ASCII。
    console.log('\n2 · GB18030 样本（手写字节字面量）')
    const gbText = '第一章\nABC\nChapter 2\nDEF\n'
    const gbBuf = Buffer.from([
      0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x0a, // 第一章\n
      0x41, 0x42, 0x43, 0x0a, // ABC\n
      0x43, 0x68, 0x61, 0x70, 0x74, 0x65, 0x72, 0x20, 0x32, 0x0a, // Chapter 2\n
      0x44, 0x45, 0x46, 0x0a // DEF\n
    ])
    const d2 = ws.detectAndDecode(gbBuf)
    check('GB18030 识别 + 解码正确（无 BOM 路径）', d2.encoding === 'gb18030' && d2.text === gbText)
    const r2 = await importTxt('gb18030-sample.txt', gbBuf)
    const utf8Buf2 = Buffer.from(gbText, 'utf8')
    check('GB18030 导入：encoding=gb18030', r2.index.manifest.project.encoding === 'gb18030')
    check('GB18030 导入：chapters=2（第一章 / Chapter 2）', r2.index.manifest.project.chapterCount === 2)
    const ch2 = await chaptersOf(r2)
    check('GB18030 导入：末章 byteEnd=规范化 UTF-8 字节数', ch2[1].byteEnd === utf8Buf2.length)
    check('GB18030 导入：body 资产=规范化 UTF-8', Buffer.compare(await readAsset(r2, '/source/body.utf8.txt'), utf8Buf2) === 0)
    check('GB18030 导入：original 资产=原始 GB18030 字节', Buffer.compare(await readAsset(r2, '/source/original.bin'), gbBuf) === 0)

    // ---- 3. UTF-16LE BOM 样本（附加 UTF-16BE BOM）----
    console.log('\n3 · UTF-16LE BOM 样本')
    const u16Text = '第一章 起点\n内容B\n'
    const u16Buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(u16Text, 'utf16le')])
    const d3 = ws.detectAndDecode(u16Buf)
    check('UTF-16LE BOM 识别 + 解码正确', d3.encoding === 'utf-16le' && d3.text === u16Text)
    const r3 = await importTxt('utf16le-sample.txt', u16Buf)
    check('UTF-16LE 导入：encoding=utf-16le + chapters=1（仅「第一章 起点」一行命中）', r3.index.manifest.project.encoding === 'utf-16le' && r3.index.manifest.project.chapterCount === 1)

    const beText = '第一章\nABC\n'
    const beBuf = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(beText, 'utf16le').swap16()])
    const d3b = ws.detectAndDecode(beBuf)
    check('UTF-16BE BOM 识别 + 解码正确（TextDecoder utf-16be）', d3b.encoding === 'utf-16be' && d3b.text === beText)

    // ---- 4. 失败样本：二进制/随机字节 → 可读错误 + 不留半成品 ----
    console.log('\n4 · 失败样本（二进制 → 可读错误 + 无半成品）')
    const badBufs = [
      Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x81]),
      Buffer.from([0xff, 0x00, 0x00, 0x00]),
      Buffer.from([0x41, 0x42, 0xff, 0x43]),
      Buffer.from([0xfe]),
      Buffer.from([0x81, 0x30, 0xff, 0x28])
    ]
    let badOk = true
    for (const [i, b] of badBufs.entries()) {
      try {
        ws.detectAndDecode(b)
        badOk = false
        console.log(`     未抛错的失败样本 #${i}：${b.toString('hex')}`)
      } catch (e) {
        if (!/无法识别的文本编码/.test(e.message)) {
          badOk = false
          console.log(`     错误不可读 #${i}：${e.message}`)
        }
      }
    }
    check('随机/二进制字节 → 抛可读错误（含「无法识别的文本编码」）', badOk)

    const badPath = join(TEST_ROOT, 'bad.bin')
    await writeFile(badPath, Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x81]))
    const badRoot = join(TEST_ROOT, 'lib-bad')
    let threwBad = false
    try {
      await ws.buildTxtWorkspace(badPath, badRoot)
    } catch {
      threwBad = true
    }
    check('二进制文件导入 → 抛错', threwBad)
    let noIndex = false
    try {
      await ws.readIndex(badRoot)
    } catch {
      noIndex = true
    }
    check('失败不留半成品工作库（无 index.json）', noIndex)

    // ---- 5. 零章节样本：全书单章兜底 ----
    console.log('\n5 · 零章节样本（单章兜底）')
    const text5 = '这是一段没有任何章节标题的正文。\n第二行也没有。\n'
    const buf5 = Buffer.from(text5, 'utf8')
    const r5 = await importTxt('nochapter-sample.txt', buf5)
    check('零章节 → 全书单章兜底', r5.index.manifest.project.chapterCount === 1)
    const ch5 = await chaptersOf(r5)
    check('兜底章标题=书名（来源文件名去扩展名）', ch5[0].title === basename(r5.txtPath).replace(/\.[^.]+$/, ''))
    check('兜底章覆盖全书（0..utf8Len）', ch5[0].byteStart === 0 && ch5[0].byteEnd === buf5.length)
    const seg5 = ws.buildReadingSegments(
      buf5,
      ch5.map((c) => ({ seq: c.seq, title: c.title, byteStart: c.byteStart, byteEnd: c.byteEnd }))
    )
    check('兜底章阅读切段全文守恒（一个字符不丢）', seg5.segments.map((s) => s.text).join('') === text5)
    const chunks5 = await chunkValuesOf(r5)
    check('兜底章仍有 1 个 chunk（chapterSeqs=[1]）', chunks5.length === 1 && JSON.stringify(chunks5[0].chapterSeqs) === '[1]')

    // ---- 5b. splitChapters 单测 ----
    console.log('\n5b · splitChapters 单元覆盖')
    const sc1 = ws.splitChapters('  第一章 起点\n正文', 'T')
    check('charStart=标题行第一个非空白字符位置（且标题=捕获组 trim）', sc1.length === 1 && sc1[0].charStart === 2 && sc1[0].title === '起点')
    check('第X部/卷/回 类命中（标题取「第X卷」之后的后缀）', ws.splitChapters('第十二卷 风\nx', 'T')[0].title === '风')
    check('序章/楔子/后记类命中', ['序章', '楔子', '后记'].every((t) => ws.splitChapters(`${t}\nx`, 'T')[0].title === t))
    check('番外[篇话]? 命中（前导分隔符被清洗）', ws.splitChapters('番外篇·后日谈\nx', 'T')[0].title === '后日谈' && ws.splitChapters('番外 后日谈\nx', 'T')[0].title === '后日谈')
    check('Chapter N 大小写不敏感', ws.splitChapters('chapter 3 启程\nx', 'T')[0].title === '启程')
    check('Markdown #/##/### 标题命中', ws.splitChapters('# 一\nx\n## 二\n### 三\n', 'T').map((c) => c.title).join('|') === '一|二|三')
    check('捕获为空 → 整行兜底（如「第三章」）', ws.splitChapters('第三章', 'T')[0].title === '第三章')
    check('零匹配 → 单章兜底且覆盖全文', (() => {
      const s = ws.splitChapters('纯正文，没有任何标题', '书名X')
      return s.length === 1 && s[0].title === '书名X' && s[0].charStart === 0 && s[0].charEnd === '纯正文，没有任何标题'.length
    })())
    const crlfText = '第一章 起点\r\n内容A\r\n第二章 中途\r\n'
    const rCrlf = await importTxt('crlf-sample.txt', Buffer.from(crlfText, 'utf8'))
    check('CRLF 文件章标题正常命中（行尾 \\r 不破坏 $ 锚点）', rCrlf.index.manifest.project.chapterCount === 2)
    const chCrlf = await chaptersOf(rCrlf)
    check(
      'CRLF 阅读切段全文守恒（\\r 归入行内，不丢字符）',
      ws.buildReadingSegments(
        Buffer.from(crlfText, 'utf8'),
        chCrlf.map((c) => ({ seq: c.seq, title: c.title, byteStart: c.byteStart, byteEnd: c.byteEnd }))
      ).segments.map((s) => s.text).join('') === crlfText
    )

    // ---- 5c. 关键词型章标题误判回归（正文行首出现关键词不得成章）----
    console.log('\n5c · 关键词型章标题误判回归（T3 修复）')
    // 不产章：单行无其它章标题 → 落全书单章兜底（title=FALLBACK 即证明没有任何行命中）
    const noChapter = (line) => {
      const s = ws.splitChapters(line, 'FALLBACK')
      return s.length === 1 && s[0].title === 'FALLBACK'
    }
    check('正文行「跋涉千里之外，他终于爬上了山。」不产章', noChapter('跋涉千里之外，他终于爬上了山。'))
    check('正文行「前言不搭后语地说。」不产章', noChapter('前言不搭后语地说。'))
    check('正文行「尾声语：完。」不产章', noChapter('尾声语：完。'))
    // 产章：关键词后必须跟分隔符或行尾；标题=剥前导/尾随分隔符后 trim
    const oneChapter = (line, expect) => {
      const s = ws.splitChapters(line, 'FALLBACK')
      return s.length === 1 && s[0].title === expect
    }
    check('「终章（大结局）」产章且标题=大结局', oneChapter('终章（大结局）', '大结局'))
    check('「后记：完」产章且标题=完', oneChapter('后记：完', '完'))
    check('「番外·拾遗」产章且标题=拾遗', oneChapter('番外·拾遗', '拾遗'))
    check('「Chapter 2: Dawn」产章且标题=Dawn', oneChapter('Chapter 2: Dawn', 'Dawn'))
    check('「楔子」单独一行产章且标题=楔子', oneChapter('楔子', '楔子'))
    check('「第一章 起点」标题仍是起点（清洗不弄坏强信号型）', oneChapter('第一章 起点', '起点'))

    // 端到端：卷首语 + 两章 + 假章诱饵行「尾声语：完。」→ 必须只有 2 章，
    // 且诱饵行作为正文归入第 2 章（修正前它被误立为第 3 章「语：完。」并吞掉「完。」）。
    const e2eText = `卷首语：这是一个开头。\n第一章 起点\n${'内容A。'.repeat(1200)}\n第二章 延续\n${'内容B。'.repeat(700)}\n尾声语：完。\n`
    const e2eBuf = Buffer.from(e2eText, 'utf8')
    const rE2e = await importTxt('e2e-false-positive.txt', e2eBuf)
    check('E2E：chapters===2（「尾声语：完。」不再被误判为假章）', rE2e.index.manifest.project.chapterCount === 2)
    const chE2e = await chaptersOf(rE2e)
    check('E2E：章标题为 起点/延续（无「语：完。」假章）', chE2e.map((c) => c.title).join('|') === '起点|延续')
    const segE2e = ws.buildReadingSegments(
      e2eBuf,
      chE2e.map((c) => ({ seq: c.seq, title: c.title, byteStart: c.byteStart, byteEnd: c.byteEnd }))
    )
    // 注：末章按设计延伸到 EOF，故 seq=null 的「正文之外」段只有卷首段、无卷末段——
    // 「尾声语：完。」正确归属第 2 章正文（修正前它被假章区间吞掉反而丢卷末）。
    check('E2E：buildReadingSegments 含 seq=null 的正文之外段（卷首）', segE2e.segments.some((s) => s.seq === null))
    check('E2E：全文逐字守恒（「尾声语：完。」一个字符不丢）', segE2e.segments.map((s) => s.text).join('') === e2eText)
    check('E2E：chunks 覆盖章 seq 1..2 不重不漏', JSON.stringify((await chunkValuesOf(rE2e)).flatMap((v) => v.chapterSeqs)) === '[1,2]')

    // ---- 6. 幂等/隔离：同一 txt 导入两次 ----
    console.log('\n6 · 幂等/隔离（同一 txt 导入两次）')
    const r6a = await importTxt('same.txt', buf1)
    const r6b = await importTxt('same.txt', buf1)
    check('两次导入 → 两个不同工作库根', r6a.root !== r6b.root)
    check('两次导入 → 不同 pkgId（无条件新建，无指纹复用/覆盖）', r6a.index.pkgId !== r6b.index.pkgId)
    check('两次导入内容一致（章数/字数相同）', r6a.index.manifest.project.chapterCount === r6b.index.manifest.project.chapterCount && r6a.index.manifest.project.charCount === r6b.index.manifest.project.charCount)

    // ---- 6b. listWorkspaces：列表标题=来源文件名 ----
    console.log('\n6b · listWorkspaces 口径')
    // 编码检测先于任何写盘失败 → 不会留下 lib-bad 目录（已由上一段断言「无 index.json」覆盖）；
    // 这里手工构造一个索引损坏的目录，验证列表层 broken[] 口径。
    await mkdir(join(TEST_ROOT, 'lib-corrupt'), { recursive: true })
    await writeFile(join(TEST_ROOT, 'lib-corrupt', 'index.json'), '{ 这不是合法 JSON', 'utf8')
    const list = await ws.listWorkspaces(TEST_ROOT)
    check('新导入工作库全部可列出', list.items.length === okCount)
    check('列表标题=来源文件名（含 .txt 扩展名，与 .t2w 同口径）', list.items.every((it) => it.title === basename(it.t2wPath) && it.title.endsWith('.txt')))
    check('索引损坏目录单列于 broken[]（不抛错）', list.broken.length === 1 && list.broken[0] === 'lib-corrupt')
  } finally {
    await rm(TEST_PARENT, { recursive: true, force: true })
  }

  console.log(`\n==== T3 txt 导入验证：${passed} 通过 / ${failed} 失败 ====`)
  if (failed === 0) {
    console.log('TXT-IMPORT VERIFY PASS')
  } else {
    console.log('TXT-IMPORT VERIFY FAIL')
  }
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('ERROR:', e?.stack ?? e?.message ?? e)
  process.exitCode = 2
})

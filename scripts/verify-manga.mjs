/**
 * 漫画线解析器验证（M0）：把真实 .t2w 喂给 `buildMangaView`，打印并校验投影模型。
 *
 * 用 esbuild 把 `.ts` 源码就地打成 CJS 再 require —— 源码里有**无扩展名**的相对导入
 * （`../workspace/variant`），Node 原生 strip-types 解析不了；esbuild 是 electron-vite
 * 已有的依赖（不用新增），且保证跑的是**真实源码**而非复制品。
 *
 * 用法：
 *   npm run verify:manga
 *   npm run verify:manga -- "D:/galcomic/gmzz-10.t2w"
 *   npm run verify:manga -- --json
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { decodeHeader } from '../src/main/t2w/core.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** 用 esbuild 把某 .ts 入口打成 CJS，再动态 require */
async function loadTs(entryRel) {
  const out = await build({
    entryPoints: [join(root, entryRel)],
    absWorkingDir: root,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    write: false,
    logLevel: 'silent',
    // .mjs 保持原样（Node 能直接跑），只打包 .ts
    external: ['electron']
  })
  const code = out.outputFiles[0].text
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', code)(mod, mod.exports, (id) => import(id))
  return mod.exports
}

const argv = process.argv.slice(2)
const jsonOnly = argv.includes('--json')
const target = argv.find((a) => !a.startsWith('--')) ?? 'D:/galcomic/gmzz-10.t2w'

const t0 = Date.now()
const buf = await readFile(target)
const h = decodeHeader(buf)
const manifest = h.manifest
const loadMs = Date.now() - t0

const { buildMangaView, buildMangaMusicBriefs } = await loadTs('src/main/t2w/manga.ts')

const t1 = Date.now()
const data = buildMangaView(manifest, 't2w://test/')
const parseMs = Date.now() - t1

if (!data) {
  console.error(`✗ ${basename(target)} 没有漫画线数据（buildMangaView 返回 null）`)
  process.exit(1)
}

const briefs = buildMangaMusicBriefs(manifest)
const s = data.stats

const failures = []
const checks = []
function check(name, cond, detail) {
  checks.push({ name, ok: !!cond, detail })
  if (!cond) failures.push({ name, detail })
}

// ---- 结构断言 ----
check('章节数 > 0', s.chapterCount > 0, `chapterCount=${s.chapterCount}`)
check('页数 > 0', s.pageCount > 0, `pageCount=${s.pageCount}`)
check('分镜数 > 0', s.panelCount > 0, `panelCount=${s.panelCount}`)
check('脚本来源 = edited（project-edits 优先）', s.scriptSource === 'edited', `scriptSource=${s.scriptSource}`)
check('project-edits 已生效', s.editsApplied === true, `editsApplied=${s.editsApplied}`)
check('台词数 > 0', s.speechCount > 0, `speechCount=${s.speechCount}`)
check('有图的页数 > 0', s.pagesWithImage > 0, `pagesWithImage=${s.pagesWithImage}`)
check('漫画配音片段 > 0', s.dubbingClipCount > 0, `dubbingClipCount=${s.dubbingClipCount}`)
check('漫画音色 >= 1（含旁白）', s.voiceCount >= 1, `voiceCount=${s.voiceCount}`)
check('旁白音色存在', data.voices.some((v) => v.isNarrator), `narrators=${data.voices.filter((v) => v.isNarrator).length}`)
check('配音设置已读到', !!data.dubbingSettings, `settings=${data.dubbingSettings ? 'yes' : 'no'}`)

// ---- 一致性 ----
let panelsTotal = 0
let panelsWithRect = 0
let pagesWithPanelsButNoImage = 0
for (const ch of data.chapters) {
  for (const p of ch.pages) {
    if (p.panels.length && !p.hasImage) pagesWithPanelsButNoImage++
    for (const pn of p.panels) {
      panelsTotal++
      if (pn.rect) panelsWithRect++
    }
  }
}
check('每个分镜都有热区 rect', panelsWithRect === panelsTotal, `${panelsWithRect}/${panelsTotal}`)
check('有分镜的页都有图', pagesWithPanelsButNoImage === 0, `缺图页=${pagesWithPanelsButNoImage}`)

// ---- URL 拼接 ----
let badUrl = 0
for (const ch of data.chapters) {
  for (const p of ch.pages) {
    if (p.imageUrl && !p.imageUrl.startsWith('t2w://test/')) badUrl++
    if (p.hasImage && !p.imageUrl) badUrl++
  }
}
check('页面图 URL 拼接正确', badUrl === 0, `异常=${badUrl}`)

// ---- 台词类型 ----
const types = {}
for (const ch of data.chapters) {
  for (const p of ch.pages) {
    for (const pn of p.panels) {
      for (const sp of pn.speech) types[sp.type] = (types[sp.type] ?? 0) + 1
    }
  }
}
check('台词类型非空', Object.keys(types).length > 0, JSON.stringify(types))

// ---- 配音有序 ----
let dubbingSorted = true
for (let i = 1; i < data.dubbing.length; i++) {
  const a = data.dubbing[i - 1]
  const b = data.dubbing[i]
  if (a.chapterSeq > b.chapterSeq || (a.chapterSeq === b.chapterSeq && a.order > b.order)) {
    dubbingSorted = false
    break
  }
}
check('配音按 (章,顺序) 有序', dubbingSorted, `clips=${data.dubbing.length}`)

// ---- 配乐 ----
check('至少一章有配乐', s.chaptersWithMusic > 0, `chaptersWithMusic=${s.chaptersWithMusic}`)
check('配乐 brief 可解析', briefs.size > 0, `briefs=${briefs.size}`)

if (jsonOnly) {
  console.log(
    JSON.stringify(
      { package: basename(target), ok: failures.length === 0, loadMs, parseMs, stats: s, speechTypes: types, musicBriefs: briefs.size, failures },
      null,
      2
    )
  )
  process.exit(failures.length === 0 ? 0 : 1)
}

const bar = '─'.repeat(64)
console.log(`\n${bar}\n  漫画线解析验证 · ${basename(target)}\n${bar}`)
console.log(`  加载 ${loadMs}ms · 解析 ${parseMs}ms`)
console.log(`\n【统计】`)
console.log(`  章节 ${s.chapterCount} · 页 ${s.pageCount} · 分镜 ${s.panelCount} · 台词 ${s.speechCount}`)
console.log(`  有图页 ${s.pagesWithImage}/${s.pageCount} · 特效 ${s.effectCount} · 有配乐章 ${s.chaptersWithMusic}`)
console.log(`  配音片段 ${s.dubbingClipCount} · 音色 ${s.voiceCount}`)
console.log(`  脚本来源 ${s.scriptSource} · project-edits ${s.editsApplied ? '已生效' : '未生效'}`)
console.log(`  台词类型 ${JSON.stringify(types)}`)

console.log(`\n【章节明细】`)
for (const ch of data.chapters) {
  const pages = ch.pages.map((p) => `p${p.no}(${p.panels.length}格${p.hasImage ? '' : '·无图'})`).join(' ')
  const music = ch.music ? ` ♪${ch.music.title}(${ch.music.bpm}bpm)` : ''
  console.log(`  第${String(ch.chapterSeq).padStart(2)}章 ${ch.title.padEnd(12)} ${pages}${music}`)
}

console.log(`\n【音色】`)
for (const v of data.voices) {
  const tag = v.isNarrator ? '旁白' : v.characterId
  console.log(`  ${tag.padEnd(14)} vt=${v.vt || '-'} ${v.vi.slice(0, 40)}${v.vi.length > 40 ? '…' : ''}`)
}

if (data.dubbingSettings) {
  console.log(`\n【配音设置】kinds=${JSON.stringify(data.dubbingSettings.kinds)} rate=${data.dubbingSettings.playbackRate}`)
  console.log(`  旁白说明：${data.dubbingSettings.narrator.slice(0, 60)}…`)
}

console.log(`\n${bar}`)
if (failures.length) {
  console.log(`  ✗ ${failures.length} 项断言失败：`)
  for (const f of failures) console.log(`     - ${f.name}（${f.detail}）`)
  console.log(bar)
  process.exit(1)
}
console.log(`  ✓ ${checks.length} 项断言全部通过`)
console.log(bar + '\n')

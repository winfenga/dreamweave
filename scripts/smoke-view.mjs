/**
 * 运行时冒烟测试：把应用真实的渲染模型模块 src/main/t2w/view.ts 用 esbuild 打包后直跑，
 * 打印地图/演出/印象/配音视图将消费的同一份 ViewData（截断长数组）。
 *
 * 之所以走 esbuild 而不是 --experimental-strip-types：应用内是 bundler 风格的
 * 无扩展名相对导入（./format、../session），node 原生 ESM 解析不了。
 *
 * 用法：
 *   npm run smoke:view -- "<某个 .t2w 绝对路径>"
 */
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { decodeHeader, computeOffsets, sha256Hex } from '../src/main/t2w/core.mjs'

const root = process.cwd()
const target = process.argv[2] ?? 'D:/aaaTemp/基督山伯爵 · 前十章｜归航与陷阱 (1).t2w'
const outfile = join(root, '.tmp-smoke', 'view-bundle.mjs')

await rm(join(root, '.tmp-smoke'), { recursive: true, force: true })
await build({
  stdin: {
    contents: `export { buildViewData } from '../src/main/t2w/view'`,
    resolveDir: join(root, 'scripts'),
    loader: 'ts',
    sourcefile: 'smoke-entry.ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  logLevel: 'warning'
})
const { buildViewData } = await import(pathToFileURL(outfile).href)

// 与 src/main/t2w/index.ts 的 readPackage 同构（仅取 header 信息）
const buf = await readFile(target)
const h = decodeHeader(buf)
const v = buildViewData(h.manifest, 't2w://smoke/')

console.log('== stats ==')
console.log(JSON.stringify(v.stats, null, 2))

console.log('\n== characters (前 6) ==')
for (const c of v.characters.slice(0, 6)) {
  console.log(
    `  ${c.id} | ${c.name} | level=${c.importanceLevel || '(空)'} | aliases=${c.aliases.join('/') || '(无)'} | portraits=${c.portraits.length} | lines=${c.actionCount}`
  )
  for (const p of c.portraits) {
    console.log(
      `      - ${p.appearanceId} 「${p.name}」 sex=${p.sex || '?'} img=${p.imagePath ? '有' : '无'} kw=${p.visualKeywords.length}`
    )
  }
}

console.log('\n== dubbing ==')
console.log('  clips:', v.dubbing.length, ' voices:', v.dubbingVoices.length)
for (const d of v.dubbing.slice(0, 3)) {
  console.log(`  ${d.key} char=${d.characterId} file=${d.path.split('/').pop()} url=${d.url.slice(0, 40)}…`)
}
for (const vc of v.dubbingVoices) {
  console.log(`  voice ${vc.characterId}: ${vc.description.slice(0, 40)} sample=${vc.samplePath.split('/').pop()}`)
}

const multi = v.characters.filter((c) => c.portraits.length > 1)
console.log('\n== 多形象角色 ==', multi.map((c) => `${c.id}×${c.portraits.length}`).join(', ') || '(无)')

const dist = {}
for (const c of v.characters) dist[c.importanceLevel || '(空)'] = (dist[c.importanceLevel || '(空)'] ?? 0) + 1
console.log('== importanceLevel 分布 ==', JSON.stringify(dist))

await rm(join(root, '.tmp-smoke'), { recursive: true, force: true })

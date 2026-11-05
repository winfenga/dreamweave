/**
 * 漫画链任务「解析失败必须抛错」回归。
 *
 * 事故（用户实测）：模型成功返回了 8216 / 14197 / 11613 token 的内容，
 * 但四个漫画任务的 parse 全部落空 → 静默 return `{chapters: [], raw: slice(0,500)}`，
 * 任务状态却是 `succeeded`。于是：
 *   · mangaEffects / mangaMusic 报「mangaScript 产物里没有任何 chapters」
 *   · 用户在界面上看到漫画任务全绿，却「什么都没有」
 *   · raw 只存 500 字符 → 事后完全无法判断是模型输出残缺还是解析有 bug
 *
 * 修复：解析失败一律抛错（任务标 failed、可重跑），并在消息里带足诊断信息。
 *
 * 用法：node scripts/verify-manga-parse-strict.mjs
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = join(here, '..')
const BUILD_DIR = join(ROOT_DIR, 'out', '.verify-manga-parse')

const require = createRequire(join(ROOT_DIR, 'package.json'))
const { build } = require('esbuild')

function electronStub() {
  return {
    name: 'electron-stub',
    setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }))
      b.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
        contents:
          `export const app = { getAppPath: () => ${JSON.stringify(ROOT_DIR)}, getPath: () => ${JSON.stringify(join(ROOT_DIR, 'out', '.tmp'))} };\n` +
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
const entry = join(BUILD_DIR, 'entry.ts')
await writeFile(
  entry,
  [
    "export { mangaScriptAdapter } from '../../src/main/pipeline/tasks/mangaScript'",
    "export { mangaEffectsAdapter } from '../../src/main/pipeline/tasks/mangaEffects'",
    "export { mangaMusicAdapter } from '../../src/main/pipeline/tasks/mangaMusic'",
    "export { mangaMusicMergeAdapter } from '../../src/main/pipeline/tasks/mangaMusicMerge'",
    ''
  ].join('\n'),
  'utf8'
)
const built = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  external: ['node:*'],
  logLevel: 'silent',
  plugins: [electronStub()]
})
const outPath = join(BUILD_DIR, 'bundle.mjs')
await writeFile(outPath, built.outputFiles[0].text, 'utf8')
const m = await import(pathToFileURL(outPath).href)
const { mangaScriptAdapter, mangaEffectsAdapter, mangaMusicAdapter, mangaMusicMergeAdapter } = m

const checks = []
function check(name, cond, detail = '') {
  checks.push({ name, ok: !!cond, detail })
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : detail ? `  — ${detail}` : ''}`)
}
function expectThrow(fn) {
  try {
    const r = fn()
    return { threw: false, result: r }
  } catch (e) {
    return { threw: true, message: e.message }
  }
}

// ===========================================================================
// ① mangaScript：空 chapters / 非法 JSON / 合法内容
// ===========================================================================
console.log('\n① mangaScript.parse')

// 空 chapters → 必须抛错
const r1 = expectThrow(() => mangaScriptAdapter.parse('{"chapters":[]}'))
check('空 chapters 抛错（不再静默成功）', r1.threw === true, r1.threw ? '' : JSON.stringify(r1.result))
check('错误消息提到 chapters', /chapters/i.test(r1.message ?? ''), r1.message ?? '')

// 非 JSON（拒绝语/垃圾）→ 抛错
const r2 = expectThrow(() => mangaScriptAdapter.parse('对不起，我不能生成这个内容。'))
check('非 JSON 抛错', r2.threw === true, '')
check('错误消息带响应长度', /字符/.test(r2.message ?? ''), r2.message ?? '')

// 截断的 JSON → 抛错，且消息里能看出结尾（便于定位截断）
const truncated = '{"chapters":[{"chapterSeq":1,"pages":[{"context":"某事'
const r3 = expectThrow(() => mangaScriptAdapter.parse(truncated))
check('截断 JSON 抛错', r3.threw === true, '')
check('错误消息含结尾片段（可定位截断）', /结尾/.test(r3.message ?? ''), r3.message ?? '')

// 缺少 chapters 字段 → 抛错并列出实际字段
const r4 = expectThrow(() => mangaScriptAdapter.parse('{"pageCount":3,"note":"xx"}'))
check('缺 chapters 抛错', r4.threw === true, '')
check('错误消息列出实际字段', /pageCount/.test(r4.message ?? ''), r4.message ?? '')

// 合法内容 → 正常解析
const good = JSON.stringify({
  chapters: [
    {
      chapterSeq: 1,
      pages: [
        {
          context: '场景描述',
          characters: [{ name: '艾莉娜', appearanceId: 'elina' }],
          panels: [{ no: 1, lines: [[1, 5]], scene: '', content: '画面内容', speech: [{ type: 'say', speaker: '艾莉娜', text: '台词' }] }]
        }
      ]
    }
  ]
})
const ok1 = mangaScriptAdapter.parse(good)
check('合法内容解析成功', Array.isArray(ok1.chapters) && ok1.chapters.length === 1, JSON.stringify(ok1).slice(0, 100))
check('章节内容正确', ok1.chapters[0]?.pages?.[0]?.panels?.[0]?.content === '画面内容', '')
check('speech 规范化保留', ok1.chapters[0]?.pages?.[0]?.panels?.[0]?.speech?.[0]?.text === '台词', '')

// ===========================================================================
// ② mangaEffects：缺 effects / 合法
// ===========================================================================
console.log('\n② mangaEffects.parse')
const e1 = expectThrow(() => mangaEffectsAdapter.parse('{"oops":1}'))
check('缺 effects 抛错', e1.threw === true, '')
check('错误消息提到 effects', /effects/.test(e1.message ?? ''), e1.message ?? '')

const e2 = expectThrow(() => mangaEffectsAdapter.parse('not json at all'))
check('非 JSON 抛错', e2.threw === true, '')

const okE = mangaEffectsAdapter.parse(JSON.stringify({ effects: [], scriptHash: 'abc' }))
check('合法空 effects 可接受（真的没有特效）', Array.isArray(okE.effects) && okE.effects.length === 0, JSON.stringify(okE))

// ===========================================================================
// ③ mangaMusic / mangaMusicMerge
// ===========================================================================
console.log('\n③ mangaMusic / mangaMusicMerge.parse')
const mm1 = expectThrow(() => mangaMusicAdapter.parse('{"wrong":1}'))
check('mangaMusic 缺 musicGroups 抛错', mm1.threw === true, '')
const mm2 = expectThrow(() => mangaMusicMergeAdapter.parse('{}'))
check('mangaMusicMerge 缺 musicGroups 抛错', mm2.threw === true, '')

const okMusic = mangaMusicAdapter.parse(JSON.stringify({ musicGroups: [] }))
check('mangaMusic 合法空数组可接受', Array.isArray(okMusic.musicGroups), JSON.stringify(okMusic))
const okMerge = mangaMusicMergeAdapter.parse(JSON.stringify({ musicGroups: [] }))
check('mangaMusicMerge 合法空数组可接受', Array.isArray(okMerge.musicGroups), JSON.stringify(okMerge))

// ===========================================================================
// ④ 源码层：确认不再有 slice(0, 500) 之类的静默兜底
// ===========================================================================
console.log('\n④ 源码层：无静默兜底残留')
const { readFileSync } = await import('node:fs')
for (const f of ['mangaScript', 'mangaEffects', 'mangaMusic', 'mangaMusicMerge']) {
  const src = readFileSync(join(ROOT_DIR, `src/main/pipeline/tasks/${f}.ts`), 'utf8')
  // 只看**代码行**（去掉 // 注释与 /* */ 块注释里的历史说明）
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')
  const has = /slice\(0,\s*500\)/.test(codeOnly)
  check(`${f}.ts 无 slice(0,500) 静默兜底`, !has, '仍存在截断兜底')
}

await rm(BUILD_DIR, { recursive: true, force: true })

const bar = '─'.repeat(64)
const fails = checks.filter((c) => !c.ok)
console.log(`\n${bar}\n  漫画链解析严格性回归\n${bar}`)
console.log(`  共 ${checks.length} 项`)
console.log(bar)
if (fails.length) {
  console.log(`  ✗ ${fails.length} 项失败\n${bar}\n`)
  process.exit(1)
}
console.log(`  ✓ ${checks.length} 项全部通过\n${bar}\n`)

/**
 * M1-T2 · `variant.ts` 收敛 + view/reproject 主条目集合逐条相等（真跑 1 号样本包）。
 *
 * 验收口径（设计 v3.4 §7 M1-T2）：
 *   ① `variant.ts` 收敛 view.ts 两处分散规则（4 后缀 isVariant + storyScript 单独排除 :batch:）；
 *   ② **对含 11 chunk + `:batch:` 变体的 1 号样本包**（`D:/aaaTemp/【主角档案】 作者_空禁千唯S.t2w`），
 *      `view` 选出的主条目与 `reproject` 落盘的投影**逐条相等**（key + unwrap(value) 深等）。
 *
 * 同时自证形态：chunk 级 storyScript = 11、`:batch:` 副本 > 0（证明不是单 chunk 包）。
 *
 * 用法：node scripts/verify-m1-t2.mjs
 */
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(here, '..')
const SCRATCH = join(FEATHER, 'scratch', 'm1-verify')

/** 1 号样本包：11 chunk + `:batch:` 变体 */
const PKG = 'D:/aaaTemp/【主角档案】 作者_空禁千唯S.t2w'

async function loadBundle() {
  const result = await build({
    stdin: {
      contents: [
        `export { buildViewData } from '../src/main/t2w/view'`,
        `export * from '../src/main/workspace/index'`
      ].join('\n'),
      resolveDir: join(FEATHER, 'scripts'),
      loader: 'ts',
      sourcefile: 'm1t2-entry.ts'
    },
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

const ws = await loadBundle()

function toKeyed(node) {
  if (Array.isArray(node)) return node.map((it, i) => ({ key: String(it?.key ?? i), value: it?.value }))
  if (node && typeof node === 'object') return Object.entries(node).map(([key, value]) => ({ key, value }))
  return []
}
function unwrap(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'object') {
    const d = v.data
    if (d !== undefined && d !== null) return d
  }
  return v
}

const passed = []
const failed = []
const check = (name, ok, detail = '') => {
  ;(ok ? passed : failed).push(name)
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

/** view 与 reproject 语义重叠的任务：view 用 needle 模糊匹配，reproject 按 taskId 精确匹配 */
const OVERLAP = [
  { taskId: 'canonical', needle: ':canonical', proj: 'entities/canonical.json' },
  { taskId: 'characterAppearance', needle: ':characterAppearance', proj: 'entities/appearances.json' },
  { taskId: 'characterRelation', needle: ':characterRelation', proj: 'entities/relations.json' },
  { taskId: 'locationTree', needle: ':locationTree', proj: 'world/location-tree.json' },
  { taskId: 'plotLocationMerge', needle: ':plotLocationMerge', proj: 'world/plot-location-merge.json' },
  { taskId: 'impressionLayout', needle: ':impressionLayout', proj: 'world/impression-layout.json' }
]

async function main() {
  await rm(SCRATCH, { recursive: true, force: true })
  await mkdir(SCRATCH, { recursive: true })

  const root = join(SCRATCH, 'ws')
  console.log(`M1-T2 · variant 收敛 + 主条目逐条相等\n样本包: ${PKG}\n`)
  await ws.unpack(PKG, root)
  const idx = await ws.readIndex(root)
  const manifest = await ws.assembleManifest(root, idx)
  const results = toKeyed(manifest.records?.results ?? {})

  // ---- 形态自证：11 chunk + :batch: ----
  const ssChunks = ws.selectStoryScriptChunks(results)
  const ssBatch = ws.selectAllStoryScript(results).filter((e) => e.key.includes(':batch:'))
  check('形态自证：chunk 级 storyScript == 11', ssChunks.length === 11, `实际 ${ssChunks.length}`)
  check('形态自证：`:batch:` 副本 > 0', ssBatch.length > 0, `实际 ${ssBatch.length} 条`)

  // ---- variant.ts 规则本身 ----
  check('variant: 4 后缀判定',
    ws.isVariant('a:b:storyScript:0:batch:1') &&
    ws.isVariant('a:b:plotLocationMerge:grouped:batch:0') &&
    ws.isVariant('a:b:cacheWarming:0:plan') &&
    ws.isVariant('a:b:storyScript:2:repair') &&
    !ws.isVariant('a:b:storyScript:0'))
  check('variant: storyScript 主条目排除 :batch:',
    ws.selectStoryScriptChunks(results).every((e) => !e.key.includes(':batch:')))

  // ---- 真跑 view ----
  const view = ws.buildViewData(manifest, 't2w://m1t2/')
  check('view.stats.storyScriptChunks == 11', view.stats.storyScriptChunks === 11, `实际 ${view.stats.storyScriptChunks}`)
  check('view 合并动作数 > 0（多 chunk 合并）', view.stats.actionCount > 0, `actions=${view.stats.actionCount}`)

  // ---- 真跑 reproject 并读投影 ----
  const r = await ws.reproject(root, idx)
  check('reproject 生成投影', r.touched.length > 0, `${r.touched.length} 个`)

  // ---- 逐条相等：view 选出的主条目 vs reproject 落盘的投影 ----
  console.log('\n主条目逐条相等（view 的 pickMainEntry 选取 vs reproject 投影落盘）:')
  for (const t of OVERLAP) {
    // view 侧：pickMainEntry（view.ts pickResult 的同源实现）+ unwrap
    const viewEntry = ws.pickMainEntry(results, t.needle)
    const viewValue = viewEntry ? unwrap(viewEntry.value) : undefined
    // reproject 侧：投影文件内容
    let projValue
    try {
      projValue = JSON.parse(await readFile(join(root, t.proj), 'utf8'))
    } catch {
      projValue = undefined
    }
    const ok =
      viewEntry !== undefined &&
      projValue !== undefined &&
      JSON.stringify(viewValue) === JSON.stringify(projValue)
    check(`  ${t.taskId}`, ok, ok ? `key=${viewEntry.key.slice(-40)}` : 'view 选取与 reproject 投影不一致')
  }

  // ---- storyScript 主条目集合逐条相等（view 合并序 vs 无损层 chunk 级集合） ----
  const ssKeys = ssChunks.map((e) => e.key)
  check('storyScript chunk 级主条目集合完整（11 条唯一 key）', new Set(ssKeys).size === 11)
  // view 的合并动作数 == 各 chunk 级动作数之和（证明 view 全量合并、未只取第一条）
  const sumChunkActions = ssChunks.reduce((s, e) => s + ((unwrap(e.value)?.actions?.length) ?? 0), 0)
  check('view 动作数 == 各 chunk 动作数之和', view.stats.actionCount === sumChunkActions,
    `view=${view.stats.actionCount} Σchunk=${sumChunkActions}`)

  await rm(SCRATCH, { recursive: true, force: true })

  console.log(`\n==== M1-T2：${passed.length} 通过 / ${failed.length} 失败 ====`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('ERROR:', e?.stack ?? e?.message ?? e)
  process.exitCode = 2
})

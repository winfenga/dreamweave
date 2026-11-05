/**
 * 上游产物读取 + 归属修正 回归（三处真实事故）。
 *
 * 事故 A `worldImpression` 漏做 `unwrapData`：
 *   报「全部 plot 条目均无 chunkSummary」，而 plot.json 里摘要明明有内容。
 *   原因：本机产物的 value 是 `{data:{chunkSummary}}` 信封，适配器直接读
 *   `e.value.chunkSummary` → 恒 undefined。
 *
 * 事故 B `workspaceDir` 缺失（前端拿包内 ID 当目录名）：
 *   报「工作库索引缺失或不可读：…/672d589e-…/index.json (ENOENT)」，
 *   解析面板所有计数错乱。`project.id`（包内 pkgId）≠ 落盘目录名。
 *
 * 事故 C `pipelineStart` 未按 pkgId 定位 root：
 *   产物写进了「当前会话」的书，而面板读的是目标书 → 一个说成功一个说空。
 *
 * 用法：node scripts/verify-upstream-read.mjs
 */
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = join(here, '..')
const BUILD_DIR = join(ROOT_DIR, 'out', '.verify-upstream-read')

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
    "export { unwrapData, readUpstreamData, readUpstreamResults } from '../../src/main/pipeline/upstream'",
    "export { worldImpressionAdapter } from '../../src/main/pipeline/tasks/worldImpression'",
    "export { updateShard } from '../../src/main/workspace/shards'",
    "export { writeIndex, readIndex } from '../../src/main/workspace/index-store'",
    "export { WORKSPACE_FORMAT, INDEX_VERSION } from '../../src/main/workspace/paths'",
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
const { unwrapData, readUpstreamData, readUpstreamResults, worldImpressionAdapter, updateShard, writeIndex, readIndex, WORKSPACE_FORMAT, INDEX_VERSION } = m

const checks = []
function check(name, cond, detail = '') {
  checks.push({ name, ok: !!cond, detail })
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : detail ? `  — ${detail}` : ''}`)
}

// ===========================================================================
// ① unwrapData 双形态
// ===========================================================================
console.log('\n① unwrapData 双形态解包')
check('剥 {data:…} 信封', unwrapData({ data: { a: 1 } }).a === 1, JSON.stringify(unwrapData({ data: { a: 1 } })))
check('裸对象原样返回', unwrapData({ a: 1 }).a === 1, '')
check('data 为 null 时返回原值', unwrapData({ data: null, a: 2 }).a === 2, '')
check('数组原样返回', Array.isArray(unwrapData([1, 2])), '')
check('标量原样返回', unwrapData('x') === 'x', '')
check('null 原样返回', unwrapData(null) === null, '')

// ===========================================================================
// ② worldImpression 能从信封形态读出 chunkSummary（事故 A 直接回归）
// ===========================================================================
console.log('\n② worldImpression 读信封形态的 plot 产物')
const tmpRoot = await mkdtemp(join(ROOT_DIR, 'out', '.tmp-upstream-'))
const ROOT = join(tmpRoot, 'ws')
await mkdir(ROOT, { recursive: true })
await writeIndex(ROOT, {
  indexVersion: INDEX_VERSION,
  format: WORKSPACE_FORMAT,
  pkgId: 'pkgA',
  title: '测试书',
  revisionId: 'rev1',
  origin: { kind: 'txt', t2wPath: null },
  manifest: { containers: {}, containerKeyed: {} },
  shards: [],
  assets: [],
  tasks: {},
  integrity: { lastVerifiedAt: new Date().toISOString() }
})

// 造 plot 产物：value 带 data 信封（本机运行的正常形态）
for (const [i, summary] of ['第一章摘要：主角进城', '第二章摘要：遭遇敌人', '第三章摘要：决战'].entries()) {
  await updateShard(ROOT, 'records/results/plot.json', 'results', 'records/results/plot', (env) => {
    env.entries.push({
      seq: i,
      key: `pkgA:rev1:plot:${i}`,
      value: { data: { chunkSummary: summary, chapters: [] }, depth: 0, calls: 1, at: '2026-01-01T00:00:00.000Z', source: 'runtime' }
    })
  })
}

const ups = await readUpstreamResults(ROOT, 'plot')
check('读到 3 条 plot 产物', ups.length === 3, String(ups.length))
const unwrapped = await readUpstreamData(ROOT, 'plot')
check('readUpstreamData 已剥信封', unwrapped[0]?.data?.chunkSummary === '第一章摘要：主角进城', JSON.stringify(unwrapped[0]?.data))

// 用真实适配器的 inputText 跑（需要最小 rt）
const warnings = []
const rt = {
  task: { id: 'worldImpression', maxTokens: 1000, thinking: 'disabled', effort: 1 },
  pkgId: 'pkgA',
  revisionId: 'rev1',
  chunkIndex: null,
  instanceKey: 'pkgA:rev1:worldImpression',
  chunkText: '',
  root: ROOT,
  title: '测试书',
  readUpstream: (tid) => readUpstreamResults(ROOT, tid),
  warnings,
  render: async () => '',
  log: () => undefined,
  llm: async () => ({ content: '{}', providerId: '', model: '', usage: null })
}
let inputText = ''
try {
  inputText = await worldImpressionAdapter.inputText(rt)
} catch (e) {
  inputText = ''
  console.log(`     inputText 抛错：${e.message}`)
}
check('worldImpression.inputText 不抛「均无 chunkSummary」', inputText.length > 0, inputText || '(空)')
check('inputText 含三章摘要内容', inputText.includes('第一章摘要') && inputText.includes('第三章摘要'), inputText?.slice(0, 150))
check('inputText 带【Chunk N · 摘要】分块', (inputText.match(/【Chunk \d+ · 摘要】/g) || []).length === 3, String((inputText.match(/【Chunk \d+ · 摘要】/g) || []).length))
check('无「跳过无 chunkSummary」warning', !warnings.some((w) => w.includes('跳过无 chunkSummary')), warnings.join(' | '))

// 反向对照：若是**裸值**形态也必须能读（来源包自带的历史产物）
const ROOT2 = join(tmpRoot, 'ws2')
await mkdir(ROOT2, { recursive: true })
await writeIndex(ROOT2, {
  indexVersion: INDEX_VERSION,
  format: WORKSPACE_FORMAT,
  pkgId: 'pkgB',
  title: '老书',
  revisionId: 'rev1',
  origin: { kind: 't2w', t2wPath: null },
  manifest: { containers: {}, containerKeyed: {} },
  shards: [],
  assets: [],
  tasks: {},
  integrity: { lastVerifiedAt: new Date().toISOString() }
})
await updateShard(ROOT2, 'records/results/plot.json', 'results', 'records/results/plot', (env) => {
  env.entries.push({ seq: 0, key: 'pkgB:rev1:plot:0', value: { chunkSummary: '老产物裸值摘要' } })
})
const rt2 = { ...rt, pkgId: 'pkgB', root: ROOT2, readUpstream: (tid) => readUpstreamResults(ROOT2, tid) }
let inputText2 = ''
try {
  inputText2 = await worldImpressionAdapter.inputText(rt2)
} catch (e) {
  inputText2 = ''
}
check('裸值形态（来源包老产物）同样可读', inputText2.includes('老产物裸值摘要'), inputText2 || '(空)')

// ===========================================================================
// ③ workspaceDir 必填（事故 B）
// ===========================================================================
console.log('\n③ summary.workspaceDir 必填（类型层约束）')
const { readFileSync } = await import('node:fs')
const appTypes = readFileSync(join(ROOT_DIR, 'src/shared/app-types.ts'), 'utf8')
check('ImportSummary 声明了 workspaceDir', /workspaceDir:\s*string/.test(appTypes), '未找到 workspaceDir 字段')
check('workspaceDir 是必填（非 ?:）', !/workspaceDir\?:/.test(appTypes), '仍为可选字段')
const summarySrc = readFileSync(join(ROOT_DIR, 'src/main/t2w/summary.ts'), 'utf8')
check('SummarySource 声明 workspaceDir', /workspaceDir:\s*string/.test(summarySrc), '')
check('buildSummary 把 workspaceDir 传出去', /workspaceDir:\s*source\.workspaceDir/.test(summarySrc), '')
const sv = readFileSync(join(ROOT_DIR, 'src/renderer/src/components/SummaryView.vue'), 'utf8')
check('SummaryView 用 summary.workspaceDir（不是 p.id）', /:pkg-id="summary\.workspaceDir"/.test(sv), '')
check('SummaryView 不再传 p.id', !/:pkg-id="p\.id"/.test(sv), '仍在使用 p.id')

// ===========================================================================
// ④ pipelineStart 按 pkgId 定位 root（事故 C）
// ===========================================================================
console.log('\n④ pipelineStart 按目录名精确定位 root')
const ipcSrc = readFileSync(join(ROOT_DIR, 'src/main/ipc/index.ts'), 'utf8')
const startBlock = ipcSrc.slice(ipcSrc.indexOf('IPC.pipelineParseStart'), ipcSrc.indexOf('IPC.pipelineParseStatus'))
check('pipelineParseStart 显式算出 root', /const root = pkgId \? join\(workspaceRoot\(\), sanitizeSegment\(pkgId\)\)/.test(startBlock), '未按 pkgId 定位')
check('pipelineStart 收到 root 参数', /pipelineStart\(pkgId, \{ root,/.test(startBlock), '未传 root')

await rm(BUILD_DIR, { recursive: true, force: true })
await rm(tmpRoot, { recursive: true, force: true })

const bar = '─'.repeat(64)
const fails = checks.filter((c) => !c.ok)
console.log(`\n${bar}\n  上游产物读取 + 归属修正 回归\n${bar}`)
console.log(`  共 ${checks.length} 项`)
console.log(bar)
if (fails.length) {
  console.log(`  ✗ ${fails.length} 项失败\n${bar}\n`)
  process.exit(1)
}
console.log(`  ✓ ${checks.length} 项全部通过\n${bar}\n`)

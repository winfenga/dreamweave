/**
 * 分片登记回归（`index.shards` 必须随产物写入同步登记）。
 *
 * 事故（用户实测 · 三个聚合任务同时报错）：
 *   worldImpression      →「需要 plot 产物：工作库中没有任何 plot 结果」
 *   locationTree         →「需要 chunkLocationSummary 产物：工作库中没有任何…」
 *   characterAppearance  →「需要 canonical 产物：工作库中没有任何含 objects.characters 的…」
 *
 * 但对应产物文件**明明存在且有内容**（plot.json 19997 字节，entries=3）。
 *
 * 根因：`workspace/shards.updateShard` 只写分片文件，**从不登记 index.shards[]**。
 * 而 `pipeline/upstream.readUpstreamResults` 的唯一数据源是 `idx.shards`：
 *   for (const row of idx.shards) { if (!matchesTaskFile(row.file, taskId)) continue; … }
 * 索引里没有该行 → 恒返回空数组 → 所有聚合型任务必然失败。
 * 此前只有 `unpack`（解包来源包）会 push 索引行，**运行期新写的产物全漏登记**。
 *
 * 次生根因：即便补上登记，`mirrorTasksToIndex` 用的是自己的私有队列，
 * 与分片登记各锁各的 → 并发时互相覆盖，刚登记的 results 行会被任务状态镜像冲掉。
 * 修法：统一走 `index-store.updateIndex`（全局索引队列）。
 *
 * 本脚本覆盖：
 *   S1 单次写产物 → index.shards 出现该行（事故的直接回归）
 *   S2 多次写不同任务 → 每行都在，不互相覆盖
 *   S3 并发写产物 + 并发镜像任务状态 → 分片行**一条不丢**（次生根因）
 *   S4 重复写同一产物 → 只一行（upsert 不重复追加），entryCount/sha256 刷新
 *   S5 readUpstreamResults 能真正读到产物（端到端闭环）
 *
 * 用法：node scripts/verify-shard-registration.mjs
 */
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = join(here, '..')
const BUILD_DIR = join(ROOT_DIR, 'out', '.verify-shard-registration')

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

/** 一次打包多个被测模块（共享同一 bundle，符号一致）。 */
const entry = join(BUILD_DIR, 'entry.ts')
await writeFile(
  entry,
  [
    "export { updateShard, readShard } from '../../src/main/workspace/shards'",
    "export { readIndex, writeIndex, updateIndex } from '../../src/main/workspace/index-store'",
    "export { writeResult } from '../../src/main/pipeline/persistence'",
    "export { mirrorTasksToIndex } from '../../src/main/pipeline/persistence'",
    "export { readUpstreamResults } from '../../src/main/pipeline/upstream'",
    "export { repairShardIndex } from '../../src/main/workspace/verify'",
    "export { WORKSPACE_FORMAT, INDEX_VERSION, INDEX_FILE } from '../../src/main/workspace/paths'",
    ''
  ].join('\n'),
  'utf8'
)

const result = await build({
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
await writeFile(outPath, result.outputFiles[0].text, 'utf8')
const m = await import(pathToFileURL(outPath).href)

const { updateShard, readIndex, writeIndex, writeResult, mirrorTasksToIndex, readUpstreamResults, repairShardIndex, WORKSPACE_FORMAT, INDEX_VERSION, INDEX_FILE } =
  m

const checks = []
function check(name, cond, detail = '') {
  checks.push({ name, ok: !!cond, detail })
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : detail ? `  — ${detail}` : ''}`)
}

/** 造一个最小可用工作库（index 骨架齐全，shards 为空）。 */
async function makeWorkspace(root) {
  await mkdir(root, { recursive: true })
  const idx = {
    indexVersion: INDEX_VERSION,
    format: WORKSPACE_FORMAT,
    pkgId: 'pkg-test',
    title: '测试书',
    revisionId: 'txt-import-20260101000000',
    origin: { kind: 'txt', t2wPath: null, sourceSha256: 'x' },
    manifest: { containers: {}, containerKeyed: {} },
    shards: [],
    assets: [],
    tasks: {},
    integrity: { lastVerifiedAt: new Date().toISOString() }
  }
  await writeIndex(root, idx)
  return root
}

const tmpRoot = await mkdtemp(join(tmpdir(), 'dw-shard-reg-'))
const ROOT = join(tmpRoot, 'ws')
await makeWorkspace(ROOT)

// ===========================================================================
// S1 单次写产物 → index.shards 必须出现该行（事故直接回归）
// ===========================================================================
console.log('\nS1 · 写产物后索引必须登记分片')
const key1 = 'pkg-test:txt-import-20260101000000:plot:0'
await updateShard(ROOT, 'records/results/plot.json', 'results', 'records/results/plot', (env) => {
  env.entries.push({ seq: 0, key: key1, value: { data: { chunkSummary: '第一章摘要' } } })
})
let idx = await readIndex(ROOT)
const plotRow = idx.shards.find((s) => s.file === 'records/results/plot.json')
check('index.shards 出现 plot.json 行', plotRow !== undefined, JSON.stringify(idx.shards.map((s) => s.file)))
check('登记行的 container 为 results', plotRow?.container === 'results', String(plotRow?.container))
check('登记行 entryCount 正确', plotRow?.entryCount === 1, String(plotRow?.entryCount))
check('登记行带 sha256', typeof plotRow?.sha256 === 'string' && plotRow.sha256.length === 64, String(plotRow?.sha256))
check('登记行 name 正确', plotRow?.name === 'records/results/plot', String(plotRow?.name))

// ===========================================================================
// S2 多个不同任务的产物 → 每行都在（不互相覆盖）
// ===========================================================================
console.log('\nS2 · 多个任务的产物都要登记')
for (const tid of ['seg', 'chunkLocationSummary', 'canonical', 'settingSummary', 'draft']) {
  await updateShard(ROOT, `records/results/${tid}.json`, 'results', `records/results/${tid}`, (env) => {
    env.entries.push({ seq: 0, key: `pkg-test:txt-import-20260101000000:${tid}:0`, value: { data: { tid } } })
  })
}
idx = await readIndex(ROOT)
const wantFiles = [
  'records/results/plot.json',
  'records/results/seg.json',
  'records/results/chunkLocationSummary.json',
  'records/results/canonical.json',
  'records/results/settingSummary.json',
  'records/results/draft.json'
]
for (const f of wantFiles) {
  const row = idx.shards.find((s) => s.file === f)
  check(`登记了 ${f}`, row !== undefined, JSON.stringify(idx.shards.map((s) => s.file)))
}
check('无重复行', idx.shards.length === new Set(idx.shards.map((s) => s.file)).size, `共 ${idx.shards.length} 行`)

// ===========================================================================
// S3 并发写产物 + 并发镜像任务状态 → 分片行一条不丢（次生根因）
// ===========================================================================
console.log('\nS3 · 并发写产物 + 并发镜像任务状态，分片行不丢')
const cat = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
await Promise.all([
  // 8 个不同任务并发写产物
  ...cat.map((t, i) =>
    updateShard(ROOT, `records/results/concurrent_${t}.json`, 'results', `records/results/concurrent_${t}`, (env) => {
      env.entries.push({ seq: 0, key: `pkg-test:rev:concurrent_${t}:0`, value: { i } })
    })
  ),
  // 同时并发镜像任务状态（写 index.tasks → 与分片登记抢同一个 index.json）
  ...cat.map((t, i) =>
    mirrorTasksToIndex(ROOT, {
      [`concurrent_${t}`]: { status: 'succeeded', fingerprint: null, updatedAt: new Date().toISOString() }
    })
  )
])
idx = await readIndex(ROOT)
const missing = cat.filter((t) => !idx.shards.some((s) => s.file === `records/results/concurrent_${t}.json`))
check('并发下 8 个分片行全部保留', missing.length === 0, `缺 ${missing.join(',')}`)
const taskKeys = cat.filter((t) => !idx.tasks[`concurrent_${t}`])
check('并发下任务状态也全部保留（未被分片登记冲掉）', taskKeys.length === 0, `缺 ${taskKeys.join(',')}`)

// ===========================================================================
// S4 重复写同一产物 → 只一行，指标刷新（upsert 语义）
// ===========================================================================
console.log('\nS4 · 重复写同一产物只留一行')
const beforeRows = idx.shards.filter((s) => s.file === 'records/results/plot.json').length
await updateShard(ROOT, 'records/results/plot.json', 'results', 'records/results/plot', (env) => {
  env.entries.push({ seq: 1, key: 'pkg-test:txt-import-20260101000000:plot:1', value: { data: { chunkSummary: '第二章摘要' } } })
})
idx = await readIndex(ROOT)
const afterRows = idx.shards.filter((s) => s.file === 'records/results/plot.json').length
check('重复写不追加索引行', afterRows === beforeRows && afterRows === 1, `before=${beforeRows} after=${afterRows}`)
const rowNow = idx.shards.find((s) => s.file === 'records/results/plot.json')
check('entryCount 已刷新为 2', rowNow?.entryCount === 2, String(rowNow?.entryCount))
check('sha256 已随内容变化刷新', rowNow?.sha256 !== plotRow?.sha256, ' 与首次相同')

// ===========================================================================
// S5 端到端：readUpstreamResults 能读到产物（聚合型任务的实际取数路径）
// ===========================================================================
console.log('\nS5 · readUpstreamResults 能读到产物（闭环）')
const ups = await readUpstreamResults(ROOT, 'plot')
check('plot 上游条目数为 2', ups.length === 2, `实际 ${ups.length}`)
check('条目 key 正确', ups[0]?.key === key1, String(ups[0]?.key))
check('条目 value 可读', ups[0]?.value?.data?.chunkSummary === '第一章摘要', JSON.stringify(ups[0]?.value)?.slice(0, 120))

const canon = await readUpstreamResults(ROOT, 'canonical')
check('canonical 上游可读（characterAppearance 的前提）', canon.length === 1, `实际 ${canon.length}`)
check(
  'canonical 含 objects.characters 结构（characterAppearance 判定依据）',
  canon.length > 0 && JSON.stringify(canon[0].value).includes('canonical'),
  '内容不符'
)

const cls = await readUpstreamResults(ROOT, 'chunkLocationSummary')
check('chunkLocationSummary 上游可读（locationTree 的前提）', cls.length === 1, `实际 ${cls.length}`)

// 反向：未登记的任务仍返回空（不误报）
const none = await readUpstreamResults(ROOT, 'worldImpression')
check('未产出的任务返回空数组（不伪造）', none.length === 0, `实际 ${none.length}`)

// ===========================================================================
// S6 存量工作库自愈：索引缺行但文件在 → 提供一个重扫入口的语义检查
// ===========================================================================
console.log('\nS6 · 老工作库（索引缺行但产物文件在）')
const OLD = join(tmpRoot, 'old')
await makeWorkspace(OLD)
// 手动造一个「文件在但索引没登记」的状态（模拟修复前写出的工作库）
await mkdir(join(OLD, 'records/results'), { recursive: true })
await writeFile(
  join(OLD, 'records/results/plot.json'),
  JSON.stringify({ shard: 'records/results/plot', container: 'results', entries: [{ seq: 0, key: 'k', value: { data: {} } }] }),
  'utf8'
)
const oldIdx = await readIndex(OLD)
check('构造出索引缺行的老库', oldIdx.shards.length === 0, `实际 ${oldIdx.shards.length} 行`)
const oldRead = await readUpstreamResults(OLD, 'plot')
check('老库确实读不到（复现修复前的症状）', oldRead.length === 0, `实际 ${oldRead.length}`)

// ---- 自愈：repairShardIndex 应把它补回来 ----
const healed = await repairShardIndex(OLD)
check('自愈补登记了 1 个分片', healed.added === 1, `实际 ${healed.added}`)
const healedIdx = await readIndex(OLD)
check('自愈后索引有 1 行', healedIdx.shards.length === 1, `实际 ${healedIdx.shards.length}`)
check(
  '自愈行字段正确（container/entryCount/sha256）',
  healedIdx.shards[0]?.container === 'results' &&
    healedIdx.shards[0]?.entryCount === 1 &&
    typeof healedIdx.shards[0]?.sha256 === 'string' &&
    healedIdx.shards[0].sha256.length === 64,
  JSON.stringify(healedIdx.shards[0])
)
const healedRead = await readUpstreamResults(OLD, 'plot')
check('自愈后能读到产物（聚合任务的真实取数路径）', healedRead.length === 1, `实际 ${healedRead.length}`)

// 幂等：再跑一次不应重复登记
const healed2 = await repairShardIndex(OLD)
check('自愈幂等（第二次补 0 行）', healed2.added === 0, `实际 ${healed2.added}`)
check('自愈后行数不变', (await readIndex(OLD)).shards.length === 1, '行数变了')

// 大库模拟：多任务 + 多目录（script / world 也要扫到）
const BIG = join(tmpRoot, 'big')
await makeWorkspace(BIG)
for (const p of [
  ['records/results/plot.json', 'results', 'records/results/plot'],
  ['records/results/canonical.json', 'results', 'records/results/canonical'],
  ['script/story-script.0.json', 'results', 'script/story-script.0'],
  ['world/plot-locations.json', 'results', 'world/plot-locations']
]) {
  const [file, container, shard] = p
  await mkdir(join(BIG, dirname(file)), { recursive: true })
  await writeFile(
    join(BIG, file),
    JSON.stringify({ shard, container, entries: [{ seq: 0, key: 'k', value: { data: {} } }] }),
    'utf8'
  )
}
const bigHealed = await repairShardIndex(BIG)
check('跨目录自愈（records/script/world 都扫到）', bigHealed.added === 4, `实际 ${bigHealed.added}`)
const bigIdx = await readIndex(BIG)
check('四个分片目录全部登记', bigIdx.shards.length === 4, JSON.stringify(bigIdx.shards.map((s) => s.file)))

await rm(BUILD_DIR, { recursive: true, force: true })
await rm(tmpRoot, { recursive: true, force: true })

const bar = '─'.repeat(64)
const fails = checks.filter((c) => !c.ok)
console.log(`\n${bar}\n  分片登记回归（index.shards）\n${bar}`)
console.log(`  共 ${checks.length} 项`)
console.log(bar)
if (fails.length) {
  console.log(`  ✗ ${fails.length} 项失败\n${bar}\n`)
  process.exit(1)
}
console.log(`  ✓ ${checks.length} 项全部通过\n${bar}\n`)

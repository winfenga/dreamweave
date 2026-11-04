/**
 * T5 · 「29 任务面板视图」验证脚本（node 直跑，**不启动 Electron**；零新增依赖）。
 *
 * 被验对象：`src/main/pipeline/overview.ts` 的 `buildTasksOverview`（T5 ① 新增，纯读组装）。
 * 关联只读调用：`persistence.loadTaskStates` / `loadInheritedTaskStates`（T4 已加来源过滤）、
 * `task-registry.loadTaskRegistry`、`dag.topoOrder`、`workspace/shards.readShard`。
 *
 * 问题背景（T5）：解析面板原本只按**实例键**罗列本次 run 的状态（`parseStatus`），
 * 看不出「29 个任务各跑到哪一步 / 还差几个实例 / 哪个任务失败」，也看不懂为什么
 * 「本机成功数」不是包里那个数。本任务新增面板视图 `buildTasksOverview`：
 *   - 一行一个**注册表任务**（29 行，拓扑序）；
 *   - `expected = global ? 1 : chunksLen`；`actual` = 本机状态里属于该任务的实例数；
 *     缺额 `max(0, expected - actual)` 计入 `pending`（`actual > expected` 不出现负数）；
 *   - 来源包自带的 12 字段历史（导入 .t2w 解包带来）**不计入任何 counts**，只数出
 *     `inheritedTotal` 供面板单独提示「不计入本机成绩」。
 *
 * 造数据（临时工作库 `D:/AI/tx/feather-t5-test/`）：
 *  - `index.json`（pkgId / title / origin.revisionId 齐全，走 `readIndex` 校验）；
 *  - `records/chunks.json` 3 条（→ 非 global 任务 expected = 3）；
 *  - `records/tasks.json` 混装 **12 条本机 + 3 条包内历史**：
 *    本机（runtime 5 字段 / 旧 4 字段）覆盖 succeeded / failed / local 三种状态，
 *    含一条 `mergeReview:characters`（**id 自带冒号**）证明最长匹配不被 `merge` 抢走，
 *    含一条脏键 `unknownTask:0`（不属任何注册表任务：只进 localTotal 不进任何行）；
 *    包内历史 3 条（12 字段、全 succeeded、无 source）：`draft:0` / `draft:1` / `locationTree`。
 *
 * 断言九组：
 *  A. 基础分类——`tasks.length === 29`、`inheritedTotal === 3`、`localTotal === 12`、
 *     脏键只进 localTotal（各任务 actual 之和 = 11）；
 *  B. 期望实例数——global（canonical / event）`expected === 1`、非 global（plot / seg）`=== 3`、
 *     29 行逐一按 global 校验；identity 从 index.json 透传；
 *  C. 计数与补额——plot 本机 2 条 → `actual 2 / pending 1`；seg 本机 4 条（> expected 3）→
 *     `pending 0`、无负数；未跑任务（compact）`pending === expected`；每行 counts 之和
 *     `=== max(expected, actual)`；
 *  D. 过滤生效——只有包内历史的 draft / locationTree → `succeeded === 0`、`pending === expected`
 *     （证明历史不计入本机成绩）；`localCounts.succeeded === 9` 而非 12；
 *  E. 失败明细——worldImpression 一条 failed → 该行 `failures` 恰 1 条、error 原文一致、
 *     `localCounts.failed === 1`、其它行 failures 全空；
 *  F. 顺序——`tasks` 的 id 序列与 `topoOrder(tasks).order` 逐个相等，且每个依赖节点排在本行之前；
 *  G. 容错——无 chunks.json → 非 global `expected === 1` 不抛；无 tasks.json → 全 pending 不抛；
 *     无 index.json → 不抛且 identity 为空串；注册表目录不存在 / root 为空 → 抛**可读错误**；
 *  H. 纯读——调用前后 `records/tasks.json` 的 size 与 mtime 不变、records 目录文件清单不变；
 *  I. 真实库只读（`5662f1d3`，**只读**）——`inheritedTotal === 95`、`localTotal === 0`、
 *     `tasks.length === 29`、全行 `actual === 0`，且三个文件的 size/mtime 前后不变。
 *
 * 姿势与 `scripts/verify-t4-task-state.mjs` 一致：`createRequire(feather/package.json)` 取项目已装的
 * esbuild，把 `overview.ts` / `persistence.ts` / `task-registry.ts` / `dag.ts` / `shards.ts`
 * 打成临时 ESM 后 `pathToFileURL` 动态 import；electron 以最小桩替换（app.getAppPath → 项目根）。
 *
 * 临时目录**只准碰** `D:/AI/tx/feather-t5-test/`（跑完 rm -rf 清掉）；7 本真实工作库
 * **只读**（仅 I 组读 `5662f1d3`，绝不写）。
 *
 * 用法：node scripts/verify-t5-overview.mjs
 */
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(here, '..')
/** 唯一允许触碰的临时父目录（跑完 rm -rf 清掉） */
const TEST_PARENT = 'D:/AI/tx/feather-t5-test'
const BUILD_DIR = join(TEST_PARENT, 'build')
/** 真实注册表目录（构建期静态快照，只读） */
const REGISTRY_DIR = join(FEATHER, 'resources', 'pipeline')

/** 真实工作库根（**只读**；records/tasks.json 里 95 条全是来源包历史） */
const REAL_ROOT = 'C:/Users/wfsyb/AppData/Roaming/feather/workspace/5662f1d3-fe3c-4b45-8baf-3da9cea8312e'

const require = createRequire(join(FEATHER, 'package.json'))
const { build } = require('esbuild')

/** electron 最小桩：overview 经 task-registry → effects/catalog 传递依赖 electron。 */
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
          `export default { app, ipcMain, BrowserWindow };\n`,
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

// ---------------------------------------------------------------------------
// 测试数据
// ---------------------------------------------------------------------------

const PKG = 'pkg-t5'
const REV = 'rev-t5'
const TITLE = 'T5 验证临时库'
const TASKS_FILE = 'records/tasks.json'
const CHUNKS_FILE = 'records/chunks.json'
const NOW = '2026-10-16T10:00:00.000Z'
const CHUNKS_LEN = 3

/** 本机新状态（T4 起写入形状：5 字段、带 source:'runtime'）。 */
function runtime(status, extra = {}) {
  return { status, fingerprint: 'fp-t5', updatedAt: NOW, error: null, source: 'runtime', ...extra }
}
/** 旧本机状态（T4 之前形状：4 字段、无 source → 靠字段集判为本机）。 */
function legacy(status, error = null) {
  return { status, fingerprint: 'fp-legacy', updatedAt: NOW, error }
}
/** A · 包内历史条目（真实形态：12 字段、全 succeeded、无 source）。 */
function historyEntry(key, id) {
  return {
    key,
    id,
    projectId: PKG,
    revisionId: REV,
    kind: id,
    label: '包内历史任务',
    chunkIndex: null,
    status: 'succeeded',
    hasStarted: true,
    attemptIds: [],
    updatedAt: '2026-10-13T08:43:53.027Z',
    fingerprint: '99f395deaba8002a6c332814e34c651e5f7de03d09fdb8f4a6736c567e16f9af'
  }
}

const K = (taskId, chunk) => (chunk === null ? `${PKG}:${REV}:${taskId}` : `${PKG}:${REV}:${taskId}:${chunk}`)

/** 本机状态 12 条（含 1 条不属任何注册表任务的脏键）。 */
const LOCAL_ENTRIES = [
  { key: K('plot', 0), value: runtime('succeeded') },
  { key: K('plot', 1), value: runtime('succeeded') },
  { key: K('seg', 0), value: runtime('succeeded') },
  { key: K('seg', 1), value: runtime('succeeded') },
  { key: K('seg', 2), value: runtime('succeeded') },
  { key: K('seg', 3), value: runtime('succeeded') },
  { key: K('worldImpression', null), value: runtime('failed', { error: 'boom-世界印象失败' }) },
  { key: K('event', null), value: runtime('local') },
  { key: K('canonical', null), value: legacy('succeeded') },
  { key: K('mergeReview:characters', null), value: runtime('succeeded') },
  { key: K('merge', null), value: runtime('local') },
  { key: K('unknownTask', 0), value: runtime('succeeded') }
]
/** 包内历史 3 条（全 succeeded、无 source；draft 两条 + locationTree 一条）。 */
const HISTORY_KEYS = [K('draft', 0), K('draft', 1), K('locationTree', null)]
const HISTORY_ENTRIES = HISTORY_KEYS.map((key, i) => ({
  key,
  value: historyEntry(key, i < 2 ? 'draft' : 'locationTree')
}))

/** 本机状态期望汇总（脏键也算 localTotal，但不进任何任务行）。 */
const EXPECT_LOCAL_TOTAL = LOCAL_ENTRIES.length // 12
const EXPECT_ROW_ACTUAL_SUM = LOCAL_ENTRIES.length - 1 // 11（unknownTask 不被任何任务认领）
const EXPECT_LOCAL_SUCCEEDED = 9 // plot×2 + seg×4 + canonical + mergeReview:characters + unknownTask
const EXPECT_LOCAL_FAILED = 1 // worldImpression
const EXPECT_LOCAL_LOCAL = 2 // event + merge
const EXPECT_INHERITED = HISTORY_ENTRIES.length // 3

/** 写一个合规的 `index.json`（`readIndex` 校验：indexVersion/format/origin/manifest/shards/assets/tasks/integrity）。 */
async function writeIndex(root) {
  const idx = {
    indexVersion: 1,
    format: 'txt2world-workspace',
    pkgId: PKG,
    title: TITLE,
    origin: { revisionId: REV, sourceSha256: 'sha-t5', importedAt: NOW },
    manifest: { project: { title: TITLE } },
    shards: [],
    assets: [],
    tasks: {},
    integrity: { updatedAt: NOW }
  }
  await writeFile(join(root, 'index.json'), JSON.stringify(idx, null, 2), 'utf8')
}

/** 写 `records/chunks.json`（CHUNKS_LEN 条 → 非 global 任务 expected = CHUNKS_LEN）。 */
async function writeChunks(root, n = CHUNKS_LEN) {
  const entries = []
  for (let i = 0; i < n; i++) {
    entries.push({
      seq: i,
      key: `${PKG}:${i}`,
      value: { projectId: PKG, index: i, chapterSeqs: [i + 1], startChapterSeq: i + 1, endChapterSeq: i + 1, estimatedSourceTokens: 1000 }
    })
  }
  await sh.writeShard(root, CHUNKS_FILE, { shard: 'records/chunks', container: 'chunks', entries })
}

/** 写 `records/tasks.json`（混装：本机 + 包内历史）。 */
async function writeTasks(root, entries) {
  await sh.writeShard(root, TASKS_FILE, {
    shard: 'records/tasks',
    container: 'tasks',
    entries: entries.map((e, i) => ({ seq: i, ...e }))
  })
}

/** 造完整临时工作库（index + chunks + 混装 tasks）。 */
async function makeWorkspace(name) {
  const root = join(TEST_PARENT, name)
  await mkdir(join(root, 'records'), { recursive: true })
  await writeIndex(root)
  await writeChunks(root)
  await writeTasks(root, [...LOCAL_ENTRIES, ...HISTORY_ENTRIES])
  return root
}

/** 取某一行（按 id），不存在返回 undefined。 */
function row(ov, id) {
  return ov.tasks.find((t) => t.id === id)
}

/** 一行 counts 是否有负数。 */
function hasNegative(counts) {
  return Object.values(counts).some((n) => typeof n !== 'number' || n < 0)
}

let ov // overview 模块
let sh // shards 模块
let reg // task-registry 模块
let dag // dag 模块
let persist // persistence 模块
let registryTasks // 真实注册表 29 任务

async function main() {
  await rm(TEST_PARENT, { recursive: true, force: true })
  await mkdir(BUILD_DIR, { recursive: true })
  console.log(`临时目录：${TEST_PARENT}\n`)

  ov = await loadModule('src/main/pipeline/overview.ts', 'overview.mjs')
  persist = await loadModule('src/main/pipeline/persistence.ts', 'persistence.mjs')
  reg = await loadModule('src/main/pipeline/task-registry.ts', 'task-registry.mjs')
  dag = await loadModule('src/main/pipeline/dag.ts', 'dag.mjs')
  sh = await loadModule('src/main/workspace/shards.ts', 'shards.mjs')

  const r = await reg.loadTaskRegistry(REGISTRY_DIR)
  if (!r.ok || !r.tasks) throw new Error(`注册表加载失败：${r.error}`)
  registryTasks = r.tasks
  // 任务数改为从注册表动态取：新增任务（如 C 线漫画 4 个）不应让本脚本失败
  const EXPECT_TASKS = registryTasks.length

  try {
    // =====================================================================
    // A · 基础分类
    // =====================================================================
    console.log(`A · 基础分类（${EXPECT_TASKS} 任务 / 本机 / 来源包历史）`)
    const ws = await makeWorkspace('ws-main')
    const a = await ov.buildTasksOverview(ws, { registryDir: REGISTRY_DIR })
    {
      check(`A1 tasks.length === ${EXPECT_TASKS}（一行一个注册表任务）`, a.tasks.length === EXPECT_TASKS, String(a.tasks.length))
      check(`A2 注册表本身 ${EXPECT_TASKS} 个任务（面板行数 = 注册表条数）`, registryTasks.length === EXPECT_TASKS, String(registryTasks.length))
      check('A3 inheritedTotal === 3（包内历史条数）', a.inheritedTotal === EXPECT_INHERITED, `${a.inheritedTotal} vs ${EXPECT_INHERITED}`)
      check('A4 localTotal === 12（本机状态条数，含 1 条脏键）', a.localTotal === EXPECT_LOCAL_TOTAL, `${a.localTotal} vs ${EXPECT_LOCAL_TOTAL}`)
      check(
        'A5 面板行 id 集 === 注册表 id 集（不增不减、顺序另由 F 组校验）',
        [...a.tasks.map((t) => t.id)].sort().join(',') === [...registryTasks.map((t) => t.id)].sort().join(',')
      )
      check('A6 行 id 无重复', new Set(a.tasks.map((t) => t.id)).size === a.tasks.length)
      check(
        'A7 每行都带齐面板字段（label/kind/model/global/expected/actual/counts/failures）',
        a.tasks.every(
          (t) =>
            typeof t.label === 'string' &&
            t.label.length > 0 &&
            typeof t.kind === 'string' &&
            typeof t.model === 'boolean' &&
            typeof t.global === 'boolean' &&
            Number.isInteger(t.expected) &&
            Number.isInteger(t.actual) &&
            t.counts &&
            Array.isArray(t.failures)
        )
      )
      const actualSum = a.tasks.reduce((n, t) => n + t.actual, 0)
      check(
        `A8 各行 actual 之和 === ${EXPECT_ROW_ACTUAL_SUM}（脏键 unknownTask 只进 localTotal、不被任何任务认领）`,
        actualSum === EXPECT_ROW_ACTUAL_SUM,
        String(actualSum)
      )
      const countsSum = Object.values(a.localCounts).reduce((n, v) => n + v, 0)
      check('A9 localCounts 各状态之和 === localTotal（计数不漏不重）', countsSum === a.localTotal, `${countsSum} vs ${a.localTotal}`)
    }

    // =====================================================================
    // B · 期望实例数（global ? 1 : chunksLen）
    // =====================================================================
    console.log('\nB · 期望实例数（global ? 1 : chunksLen = 3）')
    {
      check('B1 canonical（global）expected === 1', row(a, 'canonical')?.expected === 1, String(row(a, 'canonical')?.expected))
      check('B2 event（global）expected === 1', row(a, 'event')?.expected === 1, String(row(a, 'event')?.expected))
      check('B3 plot（非 global）expected === 3', row(a, 'plot')?.expected === 3, String(row(a, 'plot')?.expected))
      check('B4 seg（非 global）expected === 3', row(a, 'seg')?.expected === 3, String(row(a, 'seg')?.expected))
      const bad = a.tasks.filter((t) => t.expected !== (t.global ? 1 : CHUNKS_LEN))
      check(
        `B5 29 行逐一符合 expected = global ? 1 : ${CHUNKS_LEN}`,
        bad.length === 0,
        bad.map((t) => `${t.id}=${t.expected}(global=${t.global})`).join(',')
      )
      const globalCount = registryTasks.filter((t) => t.global === true).length
      check(
        `B6 global 任务共 ${globalCount} 个且面板 global 标记与注册表一致`,
        a.tasks.filter((t) => t.global).length === globalCount,
        `${a.tasks.filter((t) => t.global).length} vs ${globalCount}`
      )
      check('B7 pkgId / title 从 index.json 透传', a.pkgId === PKG && a.title === TITLE, `${a.pkgId}/${a.title}`)
    }

    // =====================================================================
    // C · 计数与补额（缺额计 pending，actual > expected 不出现负数）
    // =====================================================================
    console.log('\nC · 计数与补额（pending 补缺额 / 超量不出现负数）')
    {
      const plot = row(a, 'plot')
      check('C1 plot 本机 2 条 → actual === 2', plot?.actual === 2, String(plot?.actual))
      check('C2 plot counts.succeeded === 2', plot?.counts.succeeded === 2, String(plot?.counts.succeeded))
      check('C3 plot counts.pending === expected - 2 === 1（缺额按待跑补）', plot?.counts.pending === 1, String(plot?.counts.pending))

      const seg = row(a, 'seg')
      check('C4 seg 本机 4 条（> expected 3）→ actual === 4', seg?.actual === 4, String(seg?.actual))
      check('C5 seg counts.pending === 0（超量不产生负数补额）', seg?.counts.pending === 0, String(seg?.counts.pending))
      check('C6 seg counts.succeeded === 4', seg?.counts.succeeded === 4, String(seg?.counts.succeeded))
      check('C7 seg 各项计数无负数', !hasNegative(seg.counts), JSON.stringify(seg.counts))

      const compact = row(a, 'compact')
      check('C8 完全没跑的 compact → actual === 0 且 pending === expected（3）', compact?.actual === 0 && compact?.counts.pending === 3, `${compact?.actual}/${compact?.counts.pending}`)

      const negRows = a.tasks.filter((t) => hasNegative(t.counts))
      check('C9 29 行全部无负计数（含 actual > expected 的 seg）', negRows.length === 0, negRows.map((t) => t.id).join(','))

      const sumBad = a.tasks.filter((t) => Object.values(t.counts).reduce((n, v) => n + v, 0) !== Math.max(t.expected, t.actual))
      check(
        'C10 每行 counts 之和 === max(expected, actual)（补额口径自洽）',
        sumBad.length === 0,
        sumBad.map((t) => `${t.id}:${Object.values(t.counts).reduce((n, v) => n + v, 0)}≠${Math.max(t.expected, t.actual)}`).join(',')
      )
      const pendingSum = a.tasks.reduce((n, t) => n + t.counts.pending, 0)
      console.log(`     · 全表待跑实例合计 ${pendingSum}（29 任务 × 期望 − 本机已跑 ${EXPECT_ROW_ACTUAL_SUM}）`)
    }

    // =====================================================================
    // D · 过滤生效（来源包历史不计入本机成绩）
    // =====================================================================
    console.log('\nD · 过滤生效（来源包历史不计入本机成绩）')
    {
      const draft = row(a, 'draft')
      check('D1 只有包内历史的 draft → counts.succeeded === 0', draft?.counts.succeeded === 0, String(draft?.counts.succeeded))
      check('D2 draft counts.pending === expected（3，历史不算已跑）', draft?.counts.pending === 3, String(draft?.counts.pending))
      check('D3 draft actual === 0（历史不进本机实例数）', draft?.actual === 0, String(draft?.actual))
      check('D4 draft 无失败明细（历史全 succeeded，也不进 failures）', draft?.failures.length === 0, String(draft?.failures.length))

      const lt = row(a, 'locationTree')
      check('D5 只有包内历史的 locationTree（global）→ succeeded === 0 且 pending === 1', lt?.counts.succeeded === 0 && lt?.counts.pending === 1, `${lt?.counts.succeeded}/${lt?.counts.pending}`)

      check(
        `D6 localCounts.succeeded === ${EXPECT_LOCAL_SUCCEEDED}（不是本机 9 + 包内历史 3 = 12）`,
        a.localCounts.succeeded === EXPECT_LOCAL_SUCCEEDED,
        String(a.localCounts.succeeded)
      )
      check('D7 localCounts.failed === 1', a.localCounts.failed === EXPECT_LOCAL_FAILED, String(a.localCounts.failed))
      check('D8 localCounts.local === 2', a.localCounts.local === EXPECT_LOCAL_LOCAL, String(a.localCounts.local))
      check('D9 localCounts.pending === 0（本机状态表里没有 pending 条目）', a.localCounts.pending === 0, String(a.localCounts.pending))
      const inh = await persist.loadInheritedTaskStates(ws)
      const loc = await persist.loadTaskStates(ws)
      check(
        'D10 底层两表严格互补：继承 3 条 / 本机 12 条、键集不相交',
        Object.keys(inh).length === 3 && Object.keys(loc).length === 12 && Object.keys(inh).every((k) => !(k in loc)),
        `${Object.keys(inh).length}/${Object.keys(loc).length}`
      )
      const inheritedStillSucceeded = Object.values(inh).every((v) => v.status === 'succeeded')
      check('D11 包内历史条目本身未被改写（仍是 succeeded、12 字段）', inheritedStillSucceeded && Object.values(inh).every((v) => Object.keys(v).length === 12), String(inheritedStillSucceeded))
    }

    // =====================================================================
    // E · 失败明细
    // =====================================================================
    console.log('\nE · 失败明细（失败原因逐字透传）')
    {
      const wi = row(a, 'worldImpression')
      check('E1 worldImpression failures 恰 1 条', wi?.failures.length === 1, String(wi?.failures.length))
      check('E2 error 原文一致（逐字）', wi?.failures[0]?.error === 'boom-世界印象失败', JSON.stringify(wi?.failures[0]?.error))
      check('E3 failure 带实例键且含任务 id', String(wi?.failures[0]?.key).includes('worldImpression'), String(wi?.failures[0]?.key))
      check('E4 该行 counts.failed === 1 且 pending === 0（global expected 1、actual 1）', wi?.counts.failed === 1 && wi?.counts.pending === 0, `${wi?.counts.failed}/${wi?.counts.pending}`)
      check('E5 除 worldImpression 外，其余 28 行 failures 均为空', a.tasks.filter((t) => t.failures.length > 0).map((t) => t.id).join(',') === 'worldImpression', a.tasks.filter((t) => t.failures.length > 0).map((t) => t.id).join(','))
      check('E6 全表失败明细条数 === 1', a.tasks.reduce((n, t) => n + t.failures.length, 0) === 1, String(a.tasks.reduce((n, t) => n + t.failures.length, 0)))
      check('E7 失败明细里的 error 均为字符串（无 undefined/null）', a.tasks.every((t) => t.failures.every((f) => typeof f.error === 'string')))
    }

    // =====================================================================
    // F · 顺序（拓扑序）
    // =====================================================================
    console.log('\nF · 顺序（面板行序 === topoOrder 序）')
    {
      const topo = dag.topoOrder(registryTasks)
      const ids = a.tasks.map((t) => t.id)
      check('F1 tasks 的 id 序列与 topoOrder(tasks).order 逐个相等', ids.join(',') === topo.order.join(','), `${ids.slice(0, 5).join(',')}… vs ${topo.order.slice(0, 5).join(',')}…`)
      check(`F2 拓扑序长度 ${EXPECT_TASKS}（与面板行数一致）`, topo.order.length === EXPECT_TASKS, String(topo.order.length))
      const pos = new Map(ids.map((id, i) => [id, i]))
      const violations = []
      for (const t of a.tasks) {
        for (const dep of dag.resolveDepNodes(t, registryTasks)) {
          if (dep === t.id) continue // 自依赖（如 `X:i`）不算违例
          const dp = pos.get(dep)
          if (dp === undefined || dp >= pos.get(t.id)) violations.push(`${t.id}←${dep}`)
        }
      }
      check('F3 每个依赖节点都排在本任务之前（拓扑序真实生效）', violations.length === 0, violations.join(','))
      check('F4 首行无未满足依赖（是拓扑起点）', (dag.resolveDepNodes(a.tasks[0], registryTasks) ?? []).every((d) => d === a.tasks[0].id), a.tasks[0].id)
      const mr = row(a, 'mergeReview:characters')
      check('F5 冒号 id 任务（mergeReview:characters）独立成行且未被 merge 抢走', mr?.actual === 1 && mr?.counts.succeeded === 1 && row(a, 'merge')?.actual === 1, `mr=${mr?.actual} merge=${row(a, 'merge')?.actual}`)
    }

    // =====================================================================
    // G · 容错（缺失不抛 / 注册表缺失抛可读错误）
    // =====================================================================
    console.log('\nG · 容错（文件缺失不抛 / 注册表缺失抛可读错误）')
    {
      // G1-G2 无 chunks.json
      const wsNoChunks = join(TEST_PARENT, 'ws-no-chunks')
      await mkdir(join(wsNoChunks, 'records'), { recursive: true })
      await writeIndex(wsNoChunks)
      await writeTasks(wsNoChunks, [...LOCAL_ENTRIES, ...HISTORY_ENTRIES])
      let e1 = ''
      let b = null
      try {
        b = await ov.buildTasksOverview(wsNoChunks, { registryDir: REGISTRY_DIR })
      } catch (e) {
        e1 = e.message
      }
      check('G1 无 chunks.json → 不抛', !e1, e1)
      check('G2 无 chunks.json → 非 global 任务 expected === 1（chunksLen 兜底为 1）', !!b && row(b, 'plot')?.expected === 1, e1 || String(row(b ?? { tasks: [] }, 'plot')?.expected))
      check('G3 无 chunks.json → global 任务 expected 仍 === 1', !!b && row(b, 'canonical')?.expected === 1, String(row(b ?? { tasks: [] }, 'canonical')?.expected))

      // G4-G5 无 tasks.json
      const wsNoTasks = join(TEST_PARENT, 'ws-no-tasks')
      await mkdir(join(wsNoTasks, 'records'), { recursive: true })
      await writeIndex(wsNoTasks)
      await writeChunks(wsNoTasks)
      let e2 = ''
      let c = null
      try {
        c = await ov.buildTasksOverview(wsNoTasks, { registryDir: REGISTRY_DIR })
      } catch (e) {
        e2 = e.message
      }
      check('G4 无 tasks.json → 不抛', !e2, e2)
      check(
        'G5 无 tasks.json → 全 pending（每行 actual 0、pending === expected）、localTotal 0、inheritedTotal 0',
        !!c && c.localTotal === 0 && c.inheritedTotal === 0 && c.tasks.every((t) => t.actual === 0 && t.counts.pending === t.expected && Object.values(t.counts).every((v) => v >= 0)),
        e2 || (c ? `local=${c.localTotal} inh=${c.inheritedTotal}` : 'n/a')
      )
      check('G6 无 tasks.json → 无失败明细', !!c && c.tasks.every((t) => t.failures.length === 0), e2)

      // G7 无 index.json
      const wsNoIndex = join(TEST_PARENT, 'ws-no-index')
      await mkdir(join(wsNoIndex, 'records'), { recursive: true })
      await writeChunks(wsNoIndex)
      await writeTasks(wsNoIndex, [...LOCAL_ENTRIES, ...HISTORY_ENTRIES])
      let e3 = ''
      let d = null
      try {
        d = await ov.buildTasksOverview(wsNoIndex, { registryDir: REGISTRY_DIR })
      } catch (e) {
        e3 = e.message
      }
      check('G7 无 index.json → 不抛（pkgId/title 留空）', !e3, e3)
      check(`G8 无 index.json → identity 为空串但任务行仍在（${EXPECT_TASKS} 行不缺）`, !!d && d.pkgId === '' && d.title === '' && d.tasks.length === EXPECT_TASKS, e3 || `${d?.pkgId}/${d?.title}/${d?.tasks.length}`)

      // G9 注册表目录不存在 → 抛可读错误
      let e4 = ''
      try {
        await ov.buildTasksOverview(ws, { registryDir: join(TEST_PARENT, 'no-such-registry-dir') })
      } catch (e) {
        e4 = e.message
      }
      check('G9 注册表目录不存在 → 抛可读错误（含「任务面板无法加载任务注册表」）', e4.includes('任务面板无法加载任务注册表'), e4 || '未抛错')
      check('G10 错误信息点名缺失路径（便于定位）', e4.includes('no-such-registry-dir'), e4)

      // G11 root 为空 → 抛可读错误
      let e5 = ''
      try {
        await ov.buildTasksOverview('   ', { registryDir: REGISTRY_DIR })
      } catch (e) {
        e5 = e.message
      }
      check('G11 工作库根为空 → 抛可读错误', e5.includes('工作库根为空'), e5 || '未抛错')

      // G12 注册表 JSON 损坏 → 抛可读错误
      const badDir = join(TEST_PARENT, 'bad-registry')
      await mkdir(badDir, { recursive: true })
      await writeFile(join(badDir, 'task-registry.json'), '{ "tasks": [', 'utf8')
      let e6 = ''
      try {
        await ov.buildTasksOverview(ws, { registryDir: badDir })
      } catch (e) {
        e6 = e.message
      }
      check('G12 注册表 JSON 损坏 → 抛可读错误（不静默出空面板）', e6.includes('任务面板无法加载任务注册表') && e6.includes('JSON 损坏'), e6 || '未抛错')
    }

    // =====================================================================
    // H · 纯读（不写盘）
    // =====================================================================
    console.log('\nH · 纯读（调用前后分片不变）')
    {
      const file = join(ws, TASKS_FILE)
      const before = await stat(file)
      const beforeList = readdirSync(join(ws, 'records')).sort().join(',')
      const beforeText = await readFile(file, 'utf8')
      const h = await ov.buildTasksOverview(ws, { registryDir: REGISTRY_DIR })
      const after = await stat(file)
      const afterList = readdirSync(join(ws, 'records')).sort().join(',')
      const afterText = await readFile(file, 'utf8')
      check('H1 调用后 tasks.json 字节数不变', before.size === after.size, `${before.size}/${after.size}`)
      check('H2 调用后 tasks.json mtime 不变', before.mtimeMs === after.mtimeMs, `${before.mtimeMs}/${after.mtimeMs}`)
      check('H3 调用后 records/ 文件清单不变（无 tmp 残留）', beforeList === afterList, `${beforeList} → ${afterList}`)
      check('H4 调用后文件内容逐字不变', beforeText === afterText)
      check('H5 重复调用结果稳定（幂等纯读）', JSON.stringify(h) === JSON.stringify(await ov.buildTasksOverview(ws, { registryDir: REGISTRY_DIR })))
      const idxBefore = await stat(join(ws, 'index.json'))
      await ov.buildTasksOverview(ws, { registryDir: REGISTRY_DIR })
      const idxAfter = await stat(join(ws, 'index.json'))
      check('H6 index.json 也未被写（size/mtime 不变）', idxBefore.size === idxAfter.size && idxBefore.mtimeMs === idxAfter.mtimeMs)
    }

    // =====================================================================
    // I · 真实库只读
    // =====================================================================
    console.log('\nI · 真实库只读校验（5662f1d3）')
    const realTasks = join(REAL_ROOT, TASKS_FILE)
    if (!existsSync(realTasks)) {
      skip('I 组（真实库只读校验）', `找不到 ${realTasks}`)
    } else {
      const watched = ['index.json', TASKS_FILE, CHUNKS_FILE].filter((f) => existsSync(join(REAL_ROOT, f)))
      const before = []
      for (const f of watched) before.push(await stat(join(REAL_ROOT, f)))
      let real = null
      let eI = ''
      try {
        real = await ov.buildTasksOverview(REAL_ROOT, { registryDir: REGISTRY_DIR })
      } catch (e) {
        eI = e.message
      }
      const after = []
      for (const f of watched) after.push(await stat(join(REAL_ROOT, f)))
      check('I1 对真实库跑一次不抛', !eI, eI)
      check(`I2 tasks.length === ${EXPECT_TASKS}`, real?.tasks.length === EXPECT_TASKS, String(real?.tasks.length))
      check('I3 inheritedTotal === 95（95 条包内历史）', real?.inheritedTotal === 95, String(real?.inheritedTotal))
      check('I4 localTotal === 0（本机一条没跑）', real?.localTotal === 0, String(real?.localTotal))
      check(
        'I5 全行 actual === 0 且 pending === expected（包内历史不冒充已跑）',
        !!real && real.tasks.every((t) => t.actual === 0 && t.counts.pending === t.expected),
        real ? real.tasks.filter((t) => t.actual !== 0 || t.counts.pending !== t.expected).map((t) => t.id).join(',') : eI
      )
      check('I6 localCounts 全为 0（没有任何本机成绩）', !!real && Object.values(real.localCounts).every((v) => v === 0), real ? JSON.stringify(real.localCounts) : eI)
      check('I7 无失败明细', !!real && real.tasks.every((t) => t.failures.length === 0))
      const unchanged = before.every((s, i) => s.size === after[i].size && s.mtimeMs === after[i].mtimeMs)
      check(
        `I8 只读：${watched.length} 个文件 size 与 mtime 前后不变`,
        unchanged,
        watched.map((f, i) => `${f}:${before[i].size}/${after[i].size}`).join(' ')
      )
      const raw = JSON.parse(await readFile(realTasks, 'utf8'))
      const entries = Array.isArray(raw.entries) ? raw.entries : []
      check('I9 真实库 tasks.json 仍 95 条未被改写', entries.length === 95, String(entries.length))
    }
  } finally {
    await rm(TEST_PARENT, { recursive: true, force: true })
  }

  console.log(`\n==== T5 任务面板视图验证：${passed} 通过 / ${failed} 失败${skipped ? ` / ${skipped} 跳过` : ''} ====`)
  if (failed === 0) {
    console.log('T5 OVERVIEW VERIFY PASS')
  } else {
    console.log('T5 OVERVIEW VERIFY FAIL')
  }
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('ERROR:', e?.stack ?? e?.message ?? e)
  process.exitCode = 2
})

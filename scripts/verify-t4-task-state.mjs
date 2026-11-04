/**
 * T4 · 「任务状态真值」验证脚本（node 直跑，**不启动 Electron**；零新增依赖）。
 *
 * 被验对象：
 *  - `src/main/pipeline/persistence.ts` 的 `isRuntimeState` / `loadTaskStates` /
 *    `loadInheritedTaskStates` / `saveTaskState`；
 *  - `src/main/pipeline/orchestrator.ts` 的 `depSatisfied`（**只读调用**，本任务不改它的逻辑）。
 *
 * 问题背景（问题 7）：真实工作库的 `records/tasks.json` 里带着**来源包自带的 95 条历史状态**
 * （原项目写出，12 字段，全 `succeeded`）。T4 之前 `loadTaskStates` 无条件全量读取 → 包内历史
 * 变成「本机状态」→ `depSatisfied` 让上游依赖**假就绪**、状态汇总把别人的成绩算成自己的。
 * 修复方式：`TaskState.source` 标记 + 读取侧过滤（**数据源**修复，orchestrator 判断一行未动）。
 *
 * 造数据（临时工作库，`writeShard` 写真分片 `records/tasks.json`）三类混装：
 *  - A 包内历史（3 条）：12 字段、`status:'succeeded'`、无 `source`；
 *  - B 本机新状态（2 条）：`{status,fingerprint,updatedAt,error,source:'runtime'}`；
 *  - C 旧本机状态（1 条，T4 之前的形状）：4 字段、无 `source`、`status:'failed'`。
 *
 * 断言七组：
 *  A. `loadTaskStates` 只返回 B + C（3 条），A 的 3 条一条都不在；
 *  B. `loadInheritedTaskStates` 只返回 A（3 条），B/C 不在，且条目保留 12 字段原样；
 *  C. `saveTaskState` 写出的条目 `value.source === 'runtime'`，且键集恰
 *     `status,fingerprint,updatedAt,error,source`（幂等判定所需字段齐备）；
 *  D. `depSatisfied` 实证对比：同一个依赖 `plot:0`，未过滤的原始状态表 → `true`（**污染**），
 *     `loadTaskStates` 过滤后 → `false`；再对本机写入 plot:0 的 runtime 成功状态 → `true`。
 *     顺带验证覆盖写入：历史 12 字段条目被替换为 5 字段 runtime 值（不再含 projectId 等）；
 *  E. 红线：orchestrator 的 `depSatisfied` 判据行与幂等判据行原文未变（未改判断，改的是数据源）；
 *  F. 容错：无 tasks.json / JSON 损坏 / 分片结构不符 → 两函数均返回空对象、不抛；
 *  G. 真实库只读校验（`5662f1d3`，**只读**）：`loadTaskStates` → **0 条**、
 *     `loadInheritedTaskStates` → **95 条**，且文件字节与 mtime 前后不变（证明未写）。
 *
 * 姿势与 `scripts/verify-d1-event.mjs` 一致：`createRequire(feather/package.json)` 取项目已装的
 * esbuild，把 `persistence.ts` / `shards.ts` / `orchestrator.ts` 打成单文件 ESM 写进临时目录后
 * `pathToFileURL` 动态 import；electron 以最小桩替换（app.getAppPath → 项目根）。
 *
 * 临时目录**只准碰** `D:/AI/tx/feather-t4-test/`（跑完 rm -rf 清掉）；7 本真实工作库
 * **只读**（仅 G 组读 `5662f1d3` 的 tasks.json，绝不写）。
 *
 * 用法：node scripts/verify-t4-task-state.mjs
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(here, '..')
/** 唯一允许触碰的临时父目录（跑完 rm -rf 清掉） */
const TEST_PARENT = 'D:/AI/tx/feather-t4-test'
const BUILD_DIR = join(TEST_PARENT, 'build')

/** 真实工作库根（**只读**；其 records/tasks.json 全是来源包历史，95 条 succeeded） */
const REAL_ROOT = 'C:/Users/wfsyb/AppData/Roaming/feather/workspace/5662f1d3-fe3c-4b45-8baf-3da9cea8312e'

const require = createRequire(join(FEATHER, 'package.json'))
const { build } = require('esbuild')

/** electron 最小桩：本被测链路不碰 electron，但 orchestrator 的传递依赖会引入。 */
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

const PKG = 'pkg-t4'
const REV = 'rev-t4'
const TASKS_FILE = 'records/tasks.json'
const NOW = '2026-10-14T10:00:00.000Z'

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

/** A 的三条包内历史（`plot:0` 供 D 组做 depSatisfied 证据）。 */
const A_HISTORY = [
  { key: `${PKG}:${REV}:plot:0`, value: historyEntry(`${PKG}:${REV}:plot:0`, 'plot') },
  { key: `${PKG}:${REV}:draft:0`, value: historyEntry(`${PKG}:${REV}:draft:0`, 'draft') },
  { key: `${PKG}:${REV}:batchLocationSummary`, value: historyEntry(`${PKG}:${REV}:batchLocationSummary`, 'batchLocationSummary') }
]

/** B 的两条本机新状态（T4 起写入形状：带 source:'runtime'）。 */
const B_RUNTIME = [
  { key: `${PKG}:${REV}:seg:1`, value: { status: 'succeeded', fingerprint: 'fp-x', updatedAt: NOW, error: null, source: 'runtime' } },
  { key: `${PKG}:${REV}:worldImpression`, value: { status: 'succeeded', fingerprint: 'fp-x2', updatedAt: NOW, error: null, source: 'runtime' } }
]

/** C 的一条旧本机状态（T4 之前的形状：4 字段、无 source）。 */
const C_LEGACY = [
  { key: `${PKG}:${REV}:settingSummary`, value: { status: 'failed', fingerprint: 'fp-y', updatedAt: NOW, error: 'boom' } }
]

const B_KEYS = B_RUNTIME.map((e) => e.key)
const C_KEYS = C_LEGACY.map((e) => e.key)
const A_KEYS = A_HISTORY.map((e) => e.key)
/** 期望 `loadTaskStates` 返回的键集（B + C）。 */
const EXPECTED_RUNTIME_KEYS = [...B_KEYS, ...C_KEYS].sort()
/** 期望 `loadInheritedTaskStates` 返回的键集（A）。 */
const EXPECTED_INHERITED_KEYS = [...A_KEYS].sort()

/** 写一个只有 tasks.json 的临时工作库（不需要 index：两个读函数只读分片）。 */
async function writeTasksShard(root, entries) {
  await mkdir(join(root, 'records'), { recursive: true })
  await sh.writeShard(root, TASKS_FILE, { shard: 'records/tasks', container: 'tasks', entries })
  return root
}

/** 造混装工作库（A 3 条 + B 2 条 + C 1 条，seq 依序). */
async function makeMixedWorkspace(name) {
  const root = join(TEST_PARENT, name)
  const entries = [...A_HISTORY, ...B_RUNTIME, ...C_LEGACY].map((e, i) => ({ seq: i, ...e }))
  return writeTasksShard(root, entries)
}

/** 合成 TaskDef（depSatisfied 只读 id/kind/global 等少数字段）。 */
function taskDef(id, kind) {
  return {
    id,
    kind: kind ?? id,
    code: id,
    label: `任务${id}`,
    feature: 'demo',
    execution: '',
    input: '',
    output: '',
    model: 'demo',
    thinking: 'disabled',
    effort: 1,
    maxTokens: 1000,
    global: false,
    setting: id,
    dependsOn: []
  }
}

let persist
let sh
let orch

async function main() {
  await rm(TEST_PARENT, { recursive: true, force: true })
  await mkdir(BUILD_DIR, { recursive: true })
  console.log(`临时目录：${TEST_PARENT}\n`)

  persist = await loadModule('src/main/pipeline/persistence.ts', 'persistence.mjs')
  sh = await loadModule('src/main/workspace/shards.ts', 'shards.mjs')
  orch = await loadModule('src/main/pipeline/orchestrator.ts', 'orchestrator.mjs')

  try {
    // =====================================================================
    // A · loadTaskStates 只返回本机状态
    // =====================================================================
    console.log('A · loadTaskStates 只返回本机状态')
    const ws = await makeMixedWorkspace('ws-mixed')
    {
      const states = await persist.loadTaskStates(ws)
      const keys = Object.keys(states).sort()
      check('A1 混装 6 条 → 只返回 B+C 共 3 条', keys.length === 3, `got=${keys.length} [${keys.join(' | ')}]`)
      check('A2 键集恰为 B+C（包内历史一条都不在）', keys.join(',') === EXPECTED_RUNTIME_KEYS.join(','), keys.join(','))
      check('A3 A 组 3 条历史键全部不在返回集内', A_KEYS.every((k) => !(k in states)), A_KEYS.filter((k) => k in states).join(','))
      check(
        'A4 B 的 2 条原样返回（status succeeded / source runtime 保留）',
        B_RUNTIME.every((e) => states[e.key]?.status === 'succeeded' && states[e.key]?.source === 'runtime')
      )
      check('A5 C 的 1 条旧本机状态保留（4 字段、无 source → 靠字段集判为本机）', states[C_KEYS[0]]?.status === 'failed' && states[C_KEYS[0]]?.source === undefined, JSON.stringify(states[C_KEYS[0]]))
      check(
        'A6 成功数口径 = 本机 2 条（不是包内 4 条 succeeded）',
        Object.values(states).filter((s) => s.status === 'succeeded').length === 2,
        String(Object.values(states).filter((s) => s.status === 'succeeded').length)
      )
    }

    // =====================================================================
    // B · loadInheritedTaskStates 只返回包内历史
    // =====================================================================
    console.log('\nB · loadInheritedTaskStates 只返回包内历史')
    {
      const inh = await persist.loadInheritedTaskStates(ws)
      const keys = Object.keys(inh).sort()
      check('B1 只返回 A 的 3 条', keys.length === 3, `got=${keys.length} [${keys.join(' | ')}]`)
      check('B2 键集恰为 A（B/C 不在）', keys.join(',') === EXPECTED_INHERITED_KEYS.join(','), keys.join(','))
      check('B3 B/C 的键全部不在继承集内', [...B_KEYS, ...C_KEYS].every((k) => !(k in inh)))
      const sample = inh[A_KEYS[0]] ?? {}
      check('B4 继承条目保留 12 字段原样（含 projectId/attemptIds 等历史特征）', Object.keys(sample).length === 12 && sample.projectId === PKG && Array.isArray(sample.attemptIds), Object.keys(sample).join(','))
      check('B5 继承条目 status 仍为 succeeded（原文未改）', sample.status === 'succeeded', String(sample.status))
      const union = new Set([...Object.keys(await persist.loadTaskStates(ws)), ...keys])
      check('B6 两函数严格互补：键集不相交、并集 = 分片全部 6 条', union.size === 6, String(union.size))
    }

    // =====================================================================
    // D · depSatisfied 不被历史污染（修复前后实证对比）
    // =====================================================================
    console.log('\nD · depSatisfied 不被历史污染（修复前后对比）')
    {
      const allTasks = [taskDef('plot'), taskDef('draft')]
      // 修复前：把分片全部条目（含包内历史）当成状态表 —— 旧 loadTaskStates 的行为
      const env = await sh.readShard(ws, TASKS_FILE)
      const rawStates = {}
      for (const e of env.entries) rawStates[String(e.key)] = e.value
      const rawSucceeded = Object.values(rawStates).filter((s) => s?.status === 'succeeded').length
      const polluted = orch.depSatisfied('plot:0', rawStates, allTasks, PKG, REV, 3, 0)
      console.log(`     · 未过滤状态表：${Object.keys(rawStates).length} 条（其中 succeeded ${rawSucceeded} 条）→ depSatisfied('plot:0') = ${polluted}`)

      const filtered = await persist.loadTaskStates(ws)
      const fixed = orch.depSatisfied('plot:0', filtered, allTasks, PKG, REV, 3, 0)
      console.log(`     · loadTaskStates 过滤后：${Object.keys(filtered).length} 条 → depSatisfied('plot:0') = ${fixed}`)

      check('D1 修复前：包内历史让上游依赖假就绪（depSatisfied = true）', polluted === true, String(polluted))
      check('D2 修复后：过滤掉包内历史 → depSatisfied = false（等待本机真跑）', fixed === false, String(fixed))
      check(
        'D3 未过滤表的 succeeded 数被包内历史虚增（5 = 包内 3 + 本机 2，实际本机只 2）',
        rawSucceeded === 5 && Object.values(filtered).filter((s) => s.status === 'succeeded').length === 2,
        `${rawSucceeded} vs ${Object.values(filtered).filter((s) => s.status === 'succeeded').length}`
      )

      // 本机真跑完 plot:0 → 依赖真就绪
      await persist.saveTaskState(ws, `${PKG}:${REV}:plot:0`, {
        status: 'succeeded',
        fingerprint: 'fp-plot',
        updatedAt: NOW,
        error: null
      })
      const after = await persist.loadTaskStates(ws)
      const nowOk = orch.depSatisfied('plot:0', after, allTasks, PKG, REV, 3, 0)
      check('D4 本机写入 plot:0 的 runtime 成功状态后 → depSatisfied = true', nowOk === true, String(nowOk))

      // 覆盖写入：历史 12 字段条目被替换为 5 字段 runtime 值
      const env2 = await sh.readShard(ws, TASKS_FILE)
      const row = env2.entries.find((e) => String(e.key) === `${PKG}:${REV}:plot:0`)
      check('D5 覆盖写入后该条目 value.source === "runtime"', row?.value?.source === 'runtime', JSON.stringify(row?.value?.source))
      check('D6 覆盖写入后历史字段消失（不再含 projectId/attemptIds/key）', row && !('projectId' in row.value) && !('attemptIds' in row.value) && !('key' in row.value), row ? Object.keys(row.value).join(',') : 'n/a')
      check('D7 该条目从此归入本机状态、退出继承集', `${PKG}:${REV}:plot:0` in after && !(`${PKG}:${REV}:plot:0` in (await persist.loadInheritedTaskStates(ws))))
    }

    // =====================================================================
    // C · saveTaskState 写入带 source 标记（幂等字段齐备）
    // =====================================================================
    console.log('\nC · saveTaskState 写入带 source 标记')
    {
      const newKey = `${PKG}:${REV}:event`
      await persist.saveTaskState(ws, newKey, { status: 'succeeded', fingerprint: 'fp-z', updatedAt: NOW, error: null })
      const env = await sh.readShard(ws, TASKS_FILE)
      const row = env.entries.find((e) => String(e.key) === newKey)
      check('C1 写出的条目 value.source === "runtime"', row?.value?.source === 'runtime', JSON.stringify(row?.value?.source))
      check(
        'C2 键集恰 status,fingerprint,updatedAt,error,source（幂等判据两字段都在）',
        row && Object.keys(row.value).sort().join(',') === 'error,fingerprint,source,status,updatedAt',
        row ? Object.keys(row.value).sort().join(',') : 'n/a'
      )
      check('C3 值未被 source 污染 status/fingerprint（幂等比较等价）', row?.value?.status === 'succeeded' && row?.value?.fingerprint === 'fp-z')
      const states = await persist.loadTaskStates(ws)
      check('C4 写入即被 loadTaskStates 读到（本机状态自洽）', states[newKey]?.status === 'succeeded' && states[newKey]?.source === 'runtime')
      check('C5 单条 upsert 不丢其它条目（原有 6 条 + 新键 = 7 条）', env.entries.length === 7, String(env.entries.length))
      await persist.saveTaskState(ws, newKey, { status: 'failed', fingerprint: 'fp-z', updatedAt: NOW, error: 'x' })
      const env2 = await sh.readShard(ws, TASKS_FILE)
      check('C6 同 key 再写是 upsert（条目数仍 7、状态被替换）', env2.entries.length === 7 && env2.entries.find((e) => String(e.key) === newKey)?.value?.status === 'failed', String(env2.entries.length))
    }

    // =====================================================================
    // E · 红线：orchestrator 判断逻辑原文未变
    // =====================================================================
    console.log('\nE · 红线：orchestrator 判断逻辑原文未变')
    {
      const src = await readFile(join(FEATHER, 'src/main/pipeline/orchestrator.ts'), 'utf8')
      check(
        "E1 depSatisfied 判据行原文未变（st !== 'succeeded' && st !== 'local'）",
        src.includes("if (st !== 'succeeded' && st !== 'local') return false")
      )
      check(
        'E2 幂等判据行原文未变（prev?.status === \'succeeded\' && prev.fingerprint === fp）',
        src.includes("if (prev?.status === 'succeeded' && prev.fingerprint === fp) {")
      )
      check('E3 orchestrator 仍只用 loadTaskStates 取 prevStates（未自行过滤/兜底）', src.includes('const prevStates = await loadTaskStates(root)'))
      const persistSrc = await readFile(join(FEATHER, 'src/main/pipeline/persistence.ts'), 'utf8')
      check('E4 过滤发生在数据源（loadTaskStates 调用 isRuntimeState 跳过历史条目）', persistSrc.includes('if (!isRuntimeState(e.value)) continue'))
      check('E5 saveTaskState 写入恒带 source 标记', persistSrc.includes("{ ...state, source: 'runtime' }"))
    }

    // =====================================================================
    // F · 空/损坏容错
    // =====================================================================
    console.log('\nF · 空/损坏容错')
    {
      // F1 无 tasks.json
      const wsEmpty = join(TEST_PARENT, 'ws-empty')
      await mkdir(wsEmpty, { recursive: true })
      let e1 = ''
      let s1 = null
      let i1 = null
      try {
        s1 = await persist.loadTaskStates(wsEmpty)
        i1 = await persist.loadInheritedTaskStates(wsEmpty)
      } catch (e) {
        e1 = e.message
      }
      check('F1 无 tasks.json → 两函数均返回空对象、不抛', !e1 && Object.keys(s1).length === 0 && Object.keys(i1).length === 0, e1 || `${Object.keys(s1 ?? {}).length}/${Object.keys(i1 ?? {}).length}`)

      // F2 分片 JSON 损坏
      const wsBroken = join(TEST_PARENT, 'ws-broken')
      await mkdir(join(wsBroken, 'records'), { recursive: true })
      await writeFile(join(wsBroken, TASKS_FILE), '{ "shard": "records/tasks", "entries": [', 'utf8')
      let e2 = ''
      let s2 = null
      let i2 = null
      try {
        s2 = await persist.loadTaskStates(wsBroken)
        i2 = await persist.loadInheritedTaskStates(wsBroken)
      } catch (e) {
        e2 = e.message
      }
      check('F2 JSON 损坏 → 两函数均返回空对象、不抛', !e2 && Object.keys(s2).length === 0 && Object.keys(i2).length === 0, e2 || `${Object.keys(s2 ?? {}).length}/${Object.keys(i2 ?? {}).length}`)

      // F3 分片结构不符（无 entries 数组）
      const wsShaped = join(TEST_PARENT, 'ws-shaped')
      await mkdir(join(wsShaped, 'records'), { recursive: true })
      await writeFile(join(wsShaped, TASKS_FILE), JSON.stringify({ shard: 'records/tasks', container: 'tasks' }), 'utf8')
      let e3 = ''
      let s3 = null
      let i3 = null
      try {
        s3 = await persist.loadTaskStates(wsShaped)
        i3 = await persist.loadInheritedTaskStates(wsShaped)
      } catch (e) {
        e3 = e.message
      }
      check('F3 分片结构不符（缺 entries）→ 两函数均返回空对象、不抛', !e3 && Object.keys(s3).length === 0 && Object.keys(i3).length === 0, e3 || `${Object.keys(s3 ?? {}).length}/${Object.keys(i3 ?? {}).length}`)

      // F4 坏文件不被静默清空重建（读失败不写盘）
      const bytesAfter = (await readFile(join(wsBroken, TASKS_FILE), 'utf8')).length
      check('F4 读取失败不触发任何写入（坏分片字节未变）', bytesAfter === '{ "shard": "records/tasks", "entries": ['.length, String(bytesAfter))

      // F5 非对象 value 被两边同时忽略（不虚增计数）
      const wsOdd = join(TEST_PARENT, 'ws-odd')
      await writeTasksShard(wsOdd, [
        { seq: 0, key: `${PKG}:${REV}:seg:0`, value: 'not-an-object' },
        { seq: 1, key: `${PKG}:${REV}:seg:1`, value: B_RUNTIME[0].value }
      ])
      const s5 = await persist.loadTaskStates(wsOdd)
      const i5 = await persist.loadInheritedTaskStates(wsOdd)
      check('F5 非对象 value 被忽略（本机 1 条 / 继承 0 条）', Object.keys(s5).length === 1 && Object.keys(i5).length === 0, `${Object.keys(s5).length}/${Object.keys(i5).length}`)
    }

    // =====================================================================
    // G · 真实库只读校验（0 / 95）
    // =====================================================================
    console.log('\nG · 真实库只读校验（5662f1d3）')
    const realFile = join(REAL_ROOT, TASKS_FILE)
    if (!existsSync(realFile)) {
      skip('G 组（真实库只读校验）', `找不到 ${realFile}`)
    } else {
      const before = await stat(realFile)
      const realStates = await persist.loadTaskStates(REAL_ROOT)
      const realInherited = await persist.loadInheritedTaskStates(REAL_ROOT)
      const after = await stat(realFile)
      const raw = JSON.parse(await readFile(realFile, 'utf8'))
      const rawEntries = Array.isArray(raw.entries) ? raw.entries : []
      check('G1 真实库 tasks.json 共 95 条（全 succeeded 的包内历史）', rawEntries.length === 95 && rawEntries.every((e) => e.value?.status === 'succeeded'), String(rawEntries.length))
      check('G2 loadTaskStates(真实库) 返回 0 条（95 条全是包内历史）', Object.keys(realStates).length === 0, String(Object.keys(realStates).length))
      check('G3 loadInheritedTaskStates(真实库) 返回 95 条', Object.keys(realInherited).length === 95, String(Object.keys(realInherited).length))
      check('G4 95 条继承条目均无 source 标记（确为导入带来，非本机写入）', Object.values(realInherited).every((v) => v && v.source === undefined))
      check(
        'G5 只读：文件大小与 mtime 前后不变',
        before.size === after.size && before.mtimeMs === after.mtimeMs,
        `${before.size}/${after.size} · ${before.mtimeMs}/${after.mtimeMs}`
      )
    }
  } finally {
    await rm(TEST_PARENT, { recursive: true, force: true })
  }

  console.log(`\n==== T4 任务状态真值验证：${passed} 通过 / ${failed} 失败${skipped ? ` / ${skipped} 跳过` : ''} ====`)
  if (failed === 0) {
    console.log('T4 TASK STATE VERIFY PASS')
  } else {
    console.log('T4 TASK STATE VERIFY FAIL')
  }
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('ERROR:', e?.stack ?? e?.message ?? e)
  process.exitCode = 2
})

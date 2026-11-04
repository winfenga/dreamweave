/**
 * D1 · `event` 本地步骤（纯程序零 LLM 事件树）验证脚本
 * （node 直跑，**不启动 Electron**；零新增依赖）。
 *
 * 被验对象：`src/main/pipeline/tasks/local.ts` 的 `eventStep`（`LOCAL_STEP_MAP.event`）——
 * 由 seg / plot 产物机械派生 `{aggregates, atomics, memberships}`（与真实工作库同构）。
 *
 * 造数据（临时工作库，writeShard 写真分片 + 手维护 index.json）：
 *  - seg 产物 **2 个 chunk**：chunk0 两章各 2 段（第 2 章第 2 段 name 故意为空，验证
 *    「片段{n}」回退）、chunk1 一章 1 段 → 共 5 段；
 *  - plot 产物：三章 chapterSummary；
 *  - chapters 分片：三个章标题（`records/chapters.json`，容器 chapters）。
 *
 * 断言八组（对应 D1 spec 验收项）：
 *  A. 基本形状：aggregates 恰 1 个 L1 + 3 个 L2、atomics 恰 5 条、memberships 恰 3+5=8 条，
 *     且输出只有 `{aggregates,atomics,memberships}` 三键（无告警时不带 warnings）。
 *  B. L4：`E-beat-1..5` 连续编号、`segmentId` = seg-0-0/seg-0-1/seg-0-2/seg-0-3/seg-1-0、
 *     chapterSeq 1,1,2,2,3、chunkIndex 0,0,0,0,1、l1Id 全 E-main、name/summary 与 seg 原文
 *     一致（含 name 空 → 「片段4」回退）、条目字段集恰 8 键。
 *  C. L2：`E-ch-{seq}` 三个、name 取 chapters 分片的章标题、summary 取 plot 的
 *     chapterSummary、chapterSeqs=[seq]、字段集恰 6 键。
 *  D. L1：`E-main`、name = rt.title、chapterSeqs 三章升序、summary = 全部 L4 摘要拼接、
 *     位于 aggregates[0]（对齐真实库）。
 *  E. memberships 完整性：每条 L4 恰一条父边、每条 L2 挂在 E-main、无悬空 childId、
 *     先全部「根→章」再全部「章→段」。
 *  F. 降级：无 seg 产物 → 三数组全空 + warning 含「seg」不抛崩；无 chapters 分片 →
 *     章标题回退 `第{seq}章` 不崩；未挂 rt.root → 同上；无 plot 产物 → L2 摘要回退
 *     「该章 L4 摘要拼接」；未挂 readUpstream → 抛可读错误（不是静默空树）。
 *  G. 注册与配置：`LOCAL_STEP_MAP.event` 存在且 id==='event'、`LOCAL_TASK_IDS` 含 event、
 *     `LLM_ADAPTERS` 里**没有** event、task-registry 的 event 行 `model===false` 且
 *     `global===true`。
 *  H. 与真实库同构：读真实工作库 `15de5d4f` 的 `records/results/event.json`（**只读**）→
 *     断言我们的 aggregates/atomics 元素字段集**包含**真实库的元素字段集（只校验字段契约，
 *     不与真实数据逐条比对——内容不同书必然不同）。
 *
 * 姿势与 `scripts/verify-t6h-stage-chain.mjs` 一致：`createRequire(feather/package.json)`
 * 取项目已装的 esbuild，把 `tasks/index.ts` + `upstream.ts` + `shards.ts` 打成单文件 ESM
 * 写进临时目录后 `pathToFileURL` 动态 import；electron 以最小桩替换（app.getAppPath →
 * 项目根）。
 *
 * 临时目录**只准碰** `D:/AI/tx/feather-d1-test/`（跑完 rm -rf 清掉）；7 本真实工作库
 * **只读**（仅 H 组读 `15de5d4f` 的 event.json，绝不写）。
 *
 * 用法：node scripts/verify-d1-event.mjs
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(here, '..')
/** 唯一允许触碰的临时父目录（跑完 rm -rf 清掉） */
const TEST_PARENT = 'D:/AI/tx/feather-d1-test'
const BUILD_DIR = join(TEST_PARENT, 'build')

/** 真实工作库 event 产物（**只读**参照，h 组字段契约对拍用） */
const REAL_EVENT = 'C:/Users/wfsyb/AppData/Roaming/feather/workspace/15de5d4f-45a3-49b3-8b00-74be2bdb8d11/records/results/event.json'

const require = createRequire(join(FEATHER, 'package.json'))
const { build } = require('esbuild')

/** electron 最小桩：本被测链路不碰 electron，但 tasks/index.ts 的传递依赖可能引入。 */
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

/** 合成 TaskDef（本地步骤只读 id/label 等少数字段）。 */
function taskDef(id) {
  return {
    id,
    kind: id,
    code: id,
    label: '事件脉络',
    feature: 'events',
    execution: '',
    input: '',
    output: '全书事件图',
    model: false,
    thinking: 'disabled',
    effort: 1,
    maxTokens: 60000,
    global: true,
    setting: 'event',
    dependsOn: ['plot:*', 'seg:*']
  }
}

// ---------------------------------------------------------------------------
// 临时工作库
// ---------------------------------------------------------------------------

const PKG = 'pkg-d1'
const REV = 'rev-d1'

/** 一个小工作库：writeShard 写真分片 + 手工维护 index.json 的 shards 登记。 */
function makeWorkspace(root) {
  const idx = {
    indexVersion: 1,
    format: 'txt2world-workspace',
    pkgId: PKG,
    title: 'D1 验证书',
    origin: { t2wPath: '', t2wSize: 0, t2wSha256: '', manifestJsonSha256: '', hasOriginHeader: false, projectId: PKG, revisionId: REV, createdAt: '' },
    manifest: { includesSource: true, topLevelKeys: [], extra: {}, recordsKeys: [], containers: {}, containerKeyed: {}, project: {} },
    shards: [],
    assets: [],
    tasks: {},
    integrity: { createdAt: '', lastVerifiedAt: null }
  }
  const flush = () => writeFile(join(root, 'index.json'), JSON.stringify(idx), 'utf8')
  const register = (file, container, entryCount) => {
    const row = idx.shards.find((r) => r.file === file)
    if (row) row.entryCount = entryCount
    else idx.shards.push({ name: file.replace(/\.json$/, ''), file, container, entryCount, sha256: '' })
  }
  return {
    root,
    /** 写 results 分片并登记 index（file 形如 records/results/seg.json）。 */
    async writeResults(file, entries) {
      const env = { shard: file.replace(/\.json$/, ''), container: 'results', entries: entries.map((e, i) => ({ seq: i, ...e })) }
      await sh.writeShard(root, file, env)
      register(file, 'results', entries.length)
      await flush()
    },
    /** 写 chapters 分片（容器 chapters，file 固定 records/chapters.json）。 */
    async writeChapters(list) {
      const file = 'records/chapters.json'
      const env = {
        shard: 'records/chapters',
        container: 'chapters',
        entries: list.map((c, i) => ({ seq: i, key: `${PKG}:${c.seq}`, value: { projectId: PKG, seq: c.seq, title: c.title } }))
      }
      await sh.writeShard(root, file, env)
      register(file, 'chapters', list.length)
      await flush()
    },
    async reset() {
      await rm(root, { recursive: true, force: true })
      await mkdir(root, { recursive: true })
      idx.shards.length = 0
      await flush()
    }
  }
}

/** LLM 任务产物信封（与 orchestrator 的 writeResult 写口一致）。 */
function llmEnvelope(data) {
  return { data, depth: 1, calls: 1, warnings: [], at: new Date().toISOString() }
}

// ---------------------------------------------------------------------------
// 测试数据
// ---------------------------------------------------------------------------

/** seg chunk 0（第 1 章 2 段 + 第 2 章 2 段；第 2 章第 2 段 name 故意为空）。 */
const SEG_CHUNK0 = {
  output: {
    chapters: [
      {
        chapterSeq: 1,
        segments: [
          { 起始行号: 1, 结束行号: 12, name: '归港', summary: '法老号安全返航，唐太斯解释莱克勒临终托付。' },
          { 起始行号: 13, 结束行号: 30, name: '船长之死', summary: '莱克勒船长病逝，年轻大副接过指挥。' }
        ]
      },
      {
        chapterSeq: 2,
        segments: [
          { 起始行号: 1, 结束行号: 20, name: '觐见船主', summary: '莫雷尔许诺为他争取船长之位。' },
          { 起始行号: 21, 结束行号: 40, name: '', summary: '唐太斯赶回家中与父亲和未婚妻重逢。' }
        ]
      }
    ]
  },
  warnings: []
}

/** seg chunk 1（第 3 章 1 段）。 */
const SEG_CHUNK1 = {
  output: {
    chapters: [
      {
        chapterSeq: 3,
        segments: [{ 起始行号: 1, 结束行号: 25, name: '阴谋', summary: '腾格拉尔与费尔南在酒馆写下告密信。' }]
      }
    ]
  },
  warnings: []
}

/** plot 三章摘要。 */
const PLOT_CHAPTERS = [
  { chapterSeq: 1, chapterSummary: '第一章：法老号归航，船长病逝，大副唐太斯接手指挥并获船主赏识。' },
  { chapterSeq: 2, chapterSummary: '第二章：唐太斯觐见船主后回家，与父亲和未婚妻梅尔塞苔丝重逢。' },
  { chapterSeq: 3, chapterSummary: '第三章：腾格拉尔与费尔南合谋，一封告密信把唐太斯推向深渊。' }
]

/** chapters 分片（章标题）。 */
const CHAPTER_LIST = [
  { seq: 1, title: '第一章　船到马赛' },
  { seq: 2, title: '第二章　父与子' },
  { seq: 3, title: '第三章　阴谋' }
]

/** 期望的 L4 序列（name 已含「片段4」回退、summary 为 seg 原文）。 */
const EXPECTED_BEATS = [
  { segmentId: 'seg-0-0', chapterSeq: 1, chunkIndex: 0, name: '归港', summary: SEG_CHUNK0.output.chapters[0].segments[0].summary },
  { segmentId: 'seg-0-1', chapterSeq: 1, chunkIndex: 0, name: '船长之死', summary: SEG_CHUNK0.output.chapters[0].segments[1].summary },
  { segmentId: 'seg-0-2', chapterSeq: 2, chunkIndex: 0, name: '觐见船主', summary: SEG_CHUNK0.output.chapters[1].segments[0].summary },
  { segmentId: 'seg-0-3', chapterSeq: 2, chunkIndex: 0, name: '片段4', summary: SEG_CHUNK0.output.chapters[1].segments[1].summary },
  { segmentId: 'seg-1-0', chapterSeq: 3, chunkIndex: 1, name: '阴谋', summary: SEG_CHUNK1.output.chapters[0].segments[0].summary }
]

/** L4 条目字段集（顺序即构造顺序）。 */
const ATOMIC_KEYS = 'chapterSeq,chunkIndex,id,l1Id,level,name,segmentId,summary'
/** L2/L1 条目字段集。 */
const AGGREGATE_KEYS = 'chapterSeqs,id,l1Id,level,name,summary'

let tasks
let up
let sh

/** 灌满（seg 两 chunk + plot + chapters）。 */
async function fillFull(ws) {
  await ws.reset()
  await ws.writeResults('records/results/seg.json', [
    { key: `${PKG}:${REV}:seg:0`, value: llmEnvelope(SEG_CHUNK0) },
    { key: `${PKG}:${REV}:seg:1`, value: llmEnvelope(SEG_CHUNK1) }
  ])
  await ws.writeResults('records/results/plot.json', [
    { key: `${PKG}:${REV}:plot:0`, value: llmEnvelope({ chunkSummary: '（全书三章摘要见 chapters）', chapters: PLOT_CHAPTERS }) }
  ])
  await ws.writeChapters(CHAPTER_LIST)
}

/** 合成 rt（readUpstream 走真 readUpstreamResults —— 真读分片）。 */
function makeRt(ws, { title = 'D1 验证书', root = ws.root, withReadUpstream = true } = {}) {
  const rt = {
    task: taskDef('event'),
    pkgId: PKG,
    revisionId: REV,
    chunkIndex: null,
    instanceKey: `${PKG}:${REV}:event`,
    chunkText: '',
    root,
    warnings: [],
    log: () => {},
    render: async () => '',
    llm: async () => {
      throw new Error('验证脚本不应触发真实 LLM 调用（event 是本地步骤）')
    }
  }
  if (title !== undefined) rt.title = title
  if (withReadUpstream) rt.readUpstream = (tid) => up.readUpstreamResults(ws.root, tid)
  return rt
}

async function main() {
  await rm(TEST_PARENT, { recursive: true, force: true })
  await mkdir(BUILD_DIR, { recursive: true })
  console.log(`临时目录：${TEST_PARENT}\n`)

  tasks = await loadModule('src/main/pipeline/tasks/index.ts', 'tasks-index.mjs')
  up = await loadModule('src/main/pipeline/upstream.ts', 'upstream.mjs')
  sh = await loadModule('src/main/workspace/shards.ts', 'shards.mjs')

  const ws = makeWorkspace(join(TEST_PARENT, 'ws'))
  const step = tasks.LOCAL_STEP_MAP.event

  try {
    // =====================================================================
    // A · 基本形状
    // =====================================================================
    console.log('A · 基本形状')
    await fillFull(ws)
    const rtA = makeRt(ws)
    const dA = await step.run(rtA)
    const aggA = dA.aggregates ?? []
    const atoA = dA.atomics ?? []
    const memA = dA.memberships ?? []
    const l1 = aggA.filter((a) => a.level === 1)
    const l2 = aggA.filter((a) => a.level === 2)
    {
      check('A1 aggregates 恰 4 项（1 个 L1 + 3 个 L2）', aggA.length === 4 && l1.length === 1 && l2.length === 3, `total=${aggA.length} l1=${l1.length} l2=${l2.length}`)
      check('A2 atomics 恰 5 条（= seg 段总数）', atoA.length === 5, String(atoA.length))
      check('A3 memberships 恰 8 条（3 根→章 + 5 章→段）', memA.length === 8, String(memA.length))
      check('A4 输出只有 aggregates/atomics/memberships 三键（无告警不带 warnings）', Object.keys(dA).sort().join(',') === 'aggregates,atomics,memberships', Object.keys(dA).join(','))
      check('A5 L1 位于 aggregates[0]（对齐真实库排序）', aggA[0]?.id === 'E-main' && aggA[0]?.level === 1, JSON.stringify(aggA[0]?.id))
      check('A6 无告警（全量输入是健康路径）', rtA.warnings.length === 0, JSON.stringify(rtA.warnings))
      check('A7 幂等（同输入重跑逐字相同）', JSON.stringify(await step.run(makeRt(ws))) === JSON.stringify(dA))
    }

    // =====================================================================
    // B · L4
    // =====================================================================
    console.log('\nB · L4 atomics')
    {
      check('B1 E-beat-1..5 编号连续', atoA.map((a) => a.id).join(',') === 'E-beat-1,E-beat-2,E-beat-3,E-beat-4,E-beat-5', atoA.map((a) => a.id).join(','))
      check('B2 level 全为 4', atoA.every((a) => a.level === 4))
      check('B3 segmentId 为 seg-{chunk}-{段序}（0-0/0-1/0-2/0-3/1-0）', atoA.map((a) => a.segmentId).join(',') === 'seg-0-0,seg-0-1,seg-0-2,seg-0-3,seg-1-0', atoA.map((a) => a.segmentId).join(','))
      check('B4 chunkIndex 为 0,0,0,0,1', atoA.map((a) => a.chunkIndex).join(',') === '0,0,0,0,1', atoA.map((a) => a.chunkIndex).join(','))
      check('B5 chapterSeq 为 1,1,2,2,3', atoA.map((a) => a.chapterSeq).join(',') === '1,1,2,2,3', atoA.map((a) => a.chapterSeq).join(','))
      check('B6 l1Id 全为 E-main', atoA.every((a) => a.l1Id === 'E-main'))
      check(
        'B7 name/summary 与 seg 原文一致（含 name 空 → 「片段4」回退）',
        atoA.every((a, i) => a.name === EXPECTED_BEATS[i].name && a.summary === EXPECTED_BEATS[i].summary),
        JSON.stringify(atoA.map((a) => a.name))
      )
      check('B8 每条字段集恰 8 键（对齐真实库元素契约）', atoA.every((a) => Object.keys(a).sort().join(',') === ATOMIC_KEYS), atoA[0] ? Object.keys(atoA[0]).sort().join(',') : 'n/a')
    }

    // =====================================================================
    // C · L2
    // =====================================================================
    console.log('\nC · L2 aggregates')
    {
      const byId = new Map(l2.map((a) => [a.id, a]))
      check('C1 E-ch-1 / E-ch-2 / E-ch-3 三个（按章号升序）', l2.map((a) => a.id).join(',') === 'E-ch-1,E-ch-2,E-ch-3', l2.map((a) => a.id).join(','))
      check('C2 level 全为 2 且 l1Id 全 E-main', l2.every((a) => a.level === 2 && a.l1Id === 'E-main'))
      check(
        'C3 name = chapters 分片的章标题',
        l2.every((a, i) => a.name === CHAPTER_LIST[i].title),
        JSON.stringify(l2.map((a) => a.name))
      )
      check(
        'C4 summary = plot 的 chapterSummary（逐字）',
        l2.every((a, i) => a.summary === PLOT_CHAPTERS[i].chapterSummary),
        JSON.stringify(l2.map((a) => a.summary))
      )
      check('C5 chapterSeqs = [seq]', l2.every((a, i) => JSON.stringify(a.chapterSeqs) === JSON.stringify([CHAPTER_LIST[i].seq])))
      check('C6 每条字段集恰 6 键（对齐真实库元素契约）', l2.every((a) => Object.keys(a).sort().join(',') === AGGREGATE_KEYS))
      check('C7 无 L3（真实库层级为 1/2/4）', !aggA.some((a) => a.level === 3))
      check('C8 E-ch-2 存在且摘要取第二章（非相邻章串味）', byId.get('E-ch-2')?.summary === PLOT_CHAPTERS[1].chapterSummary)
    }

    // =====================================================================
    // D · L1
    // =====================================================================
    console.log('\nD · L1 aggregate')
    {
      const root = aggA[0] ?? {}
      const joined = EXPECTED_BEATS.map((b) => b.summary).join('')
      check('D1 id = E-main 且 l1Id = E-main', root.id === 'E-main' && root.l1Id === 'E-main')
      check('D2 name = rt.title', root.name === 'D1 验证书', String(root.name))
      check('D3 chapterSeqs = 三章升序 [1,2,3]', JSON.stringify(root.chapterSeqs) === '[1,2,3]', JSON.stringify(root.chapterSeqs))
      check(
        'D4 summary = 全部 L4 摘要以「。」拼接（逐字）',
        root.summary === '法老号安全返航，唐太斯解释莱克勒临终托付。莱克勒船长病逝，年轻大副接过指挥。莫雷尔许诺为他争取船长之位。唐太斯赶回家中与父亲和未婚妻重逢。腾格拉尔与费尔南在酒馆写下告密信。',
        String(root.summary)
      )
      check('D5 summary 含全部 5 段关键内容（不多不少）', EXPECTED_BEATS.every((b) => root.summary.includes(b.summary.replace(/。$/, ''))) && joined.length > 0)
      check('D6 字段集恰 6 键', Object.keys(root).sort().join(',') === AGGREGATE_KEYS, Object.keys(root).sort().join(','))
    }

    // =====================================================================
    // E · memberships 完整性
    // =====================================================================
    console.log('\nE · memberships 完整性')
    {
      const aggIds = new Set(aggA.map((a) => a.id))
      const atoIds = new Set(atoA.map((a) => a.id))
      const dangling = memA.filter((m) => !aggIds.has(m.parentId) || !(aggIds.has(m.childId) || atoIds.has(m.childId)))
      check('E1 无悬空 childId / parentId', dangling.length === 0, JSON.stringify(dangling.slice(0, 3)))
      check(
        'E2 每条 L4 恰有一条父边',
        atoIds.size === 5 && [...atoIds].every((id) => memA.filter((m) => m.childId === id).length === 1)
      )
      const chapterEdges = memA.filter((m) => String(m.childId).startsWith('E-ch-'))
      check('E3 每条 L2 都挂在 E-main 下（3 条）', chapterEdges.length === 3 && chapterEdges.every((m) => m.parentId === 'E-main'))
      check(
        'E4 每条 L4 的父边指向其所在章的 E-ch-{seq}',
        EXPECTED_BEATS.every((b, i) => memA.some((m) => m.parentId === `E-ch-${b.chapterSeq}` && m.childId === `E-beat-${i + 1}`))
      )
      check(
        'E5 顺序同构（先全部根→章，再全部章→段）',
        memA.slice(0, 3).every((m) => m.parentId === 'E-main') && memA.slice(3).every((m) => String(m.parentId).startsWith('E-ch-')),
        JSON.stringify(memA.slice(0, 4))
      )
      check('E6 每条只有 parentId/childId 两键', memA.every((m) => Object.keys(m).sort().join(',') === 'childId,parentId'))
    }

    // =====================================================================
    // F · 降级
    // =====================================================================
    console.log('\nF · 降级行为')
    {
      // F1 无 seg 产物 → 三数组全空 + warning 含 seg，不抛崩
      const wsNoSeg = makeWorkspace(join(TEST_PARENT, 'ws-noseg'))
      await wsNoSeg.reset()
      await wsNoSeg.writeResults('records/results/plot.json', [
        { key: `${PKG}:${REV}:plot:0`, value: llmEnvelope({ chunkSummary: '', chapters: PLOT_CHAPTERS }) }
      ])
      await wsNoSeg.writeChapters(CHAPTER_LIST)
      const rtNoSeg = makeRt(wsNoSeg)
      let dNoSeg = null
      let errNoSeg = ''
      try {
        dNoSeg = await step.run(rtNoSeg)
      } catch (e) {
        errNoSeg = e.message
      }
      check(
        'F1 无 seg 产物 → 三数组全空 + warning 含「seg」，不抛崩',
        !errNoSeg &&
          Array.isArray(dNoSeg?.aggregates) &&
          dNoSeg.aggregates.length === 0 &&
          dNoSeg.atomics.length === 0 &&
          dNoSeg.memberships.length === 0 &&
          Array.isArray(dNoSeg.warnings) &&
          dNoSeg.warnings.some((w) => w.includes('seg')),
        errNoSeg || JSON.stringify(dNoSeg?.warnings)
      )
      check('F2 降级 warning 双写（payload.warnings 与 rt.warnings 都在）', rtNoSeg.warnings.some((w) => w.includes('seg')), JSON.stringify(rtNoSeg.warnings))

      // F3 seg 产物存在但 output.chapters 为空 → 同一降级
      const wsEmptySeg = makeWorkspace(join(TEST_PARENT, 'ws-emptyseg'))
      await wsEmptySeg.reset()
      await wsEmptySeg.writeResults('records/results/seg.json', [
        { key: `${PKG}:${REV}:seg:0`, value: llmEnvelope({ output: { chapters: [] }, warnings: [] }) }
      ])
      const rtEmptySeg = makeRt(wsEmptySeg)
      const dEmptySeg = await step.run(rtEmptySeg)
      check('F3 seg 产物无任何段 → 同样降级（不抛崩）', dEmptySeg.aggregates.length === 0 && dEmptySeg.warnings.some((w) => w.includes('seg')))

      // F4 无 chapters 分片 → 章标题回退 第{seq}章
      const wsNoCh = makeWorkspace(join(TEST_PARENT, 'ws-nochapters'))
      await wsNoCh.reset()
      await wsNoCh.writeResults('records/results/seg.json', [{ key: `${PKG}:${REV}:seg:0`, value: llmEnvelope(SEG_CHUNK0) }])
      await wsNoCh.writeResults('records/results/plot.json', [{ key: `${PKG}:${REV}:plot:0`, value: llmEnvelope({ chunkSummary: '', chapters: PLOT_CHAPTERS }) }])
      const rtNoCh = makeRt(wsNoCh)
      let dNoCh = null
      let errNoCh = ''
      try {
        dNoCh = await step.run(rtNoCh)
      } catch (e) {
        errNoCh = e.message
      }
      const namesNoCh = (dNoCh?.aggregates ?? []).filter((a) => a.level === 2).map((a) => a.name)
      check('F4 无 chapters 分片 → L2 名称回退「第{seq}章」不崩', !errNoCh && namesNoCh.join(',') === '第1章,第2章', errNoCh || namesNoCh.join(','))
      check('F5 章标题读取失败留 warning（含 chapters 字样）', rtNoCh.warnings.some((w) => w.includes('chapters')), JSON.stringify(rtNoCh.warnings))

      // F6 未挂 rt.root → 同样回退 + warning，不抛（root: null 绕开默认参数）
      const rtNoRoot = makeRt(ws, { root: null })
      let dNoRoot = null
      let errNoRoot = ''
      try {
        dNoRoot = await step.run(rtNoRoot)
      } catch (e) {
        errNoRoot = e.message
      }
      const namesNoRoot = (dNoRoot?.aggregates ?? []).filter((a) => a.level === 2).map((a) => a.name)
      check('F6 未挂 rt.root → L2 回退「第{seq}章」+ warning，不抛', !errNoRoot && namesNoRoot.join(',') === '第1章,第2章,第3章' && rtNoRoot.warnings.some((w) => w.includes('rt.root')), errNoRoot || JSON.stringify(rtNoRoot.warnings))

      // F7 无 plot 产物 → L2 摘要回退该章 L4 摘要拼接
      const wsNoPlot = makeWorkspace(join(TEST_PARENT, 'ws-noplot'))
      await wsNoPlot.reset()
      await wsNoPlot.writeResults('records/results/seg.json', [{ key: `${PKG}:${REV}:seg:0`, value: llmEnvelope(SEG_CHUNK0) }])
      await wsNoPlot.writeChapters(CHAPTER_LIST)
      const dNoPlot = await step.run(makeRt(wsNoPlot))
      const ch1 = (dNoPlot.aggregates ?? []).find((a) => a.id === 'E-ch-1')
      check(
        'F7 无 plot 产物 → L2 摘要回退「该章 L4 摘要拼接」',
        ch1?.summary === `${SEG_CHUNK0.output.chapters[0].segments[0].summary}${SEG_CHUNK0.output.chapters[0].segments[1].summary}`,
        String(ch1?.summary)
      )
      check('F8 回退摘要仍走章标题（plot 缺失不影响 name）', ch1?.name === '第一章　船到马赛', String(ch1?.name))

      // F9 未挂 readUpstream → 抛可读错误（不静默输出空树）
      const rtNoUp = makeRt(ws, { withReadUpstream: false })
      let errNoUp = ''
      try {
        await step.run(rtNoUp)
      } catch (e) {
        errNoUp = e.message
      }
      check('F9 未挂 readUpstream → 抛可读错误（含 readUpstream / event）', /readUpstream/.test(errNoUp) && /event/.test(errNoUp), errNoUp)

      // F10 同 chunkIndex 多条 seg 产物 → 取首条 + warning
      const wsDup = makeWorkspace(join(TEST_PARENT, 'ws-dupseg'))
      await wsDup.reset()
      await wsDup.writeResults('records/results/seg.json', [
        { key: `${PKG}:${REV}:seg:0`, value: llmEnvelope(SEG_CHUNK0) },
        { key: `${PKG}:${REV}:seg:0`, value: llmEnvelope(SEG_CHUNK1) }
      ])
      const rtDup = makeRt(wsDup)
      const dDup = await step.run(rtDup)
      check(
        'F10 同 chunk 多条 seg 产物 → 取首条（5 段仍是前两条章）+ warning',
        dDup.atomics.length === 4 && rtDup.warnings.some((w) => w.includes('多条')),
        `${dDup.atomics.length} | ${JSON.stringify(rtDup.warnings)}`
      )

      // F11 章条目缺 chapterSeq → 跳过该章 + warning，不崩
      const wsBadSeq = makeWorkspace(join(TEST_PARENT, 'ws-badseq'))
      await wsBadSeq.reset()
      await wsBadSeq.writeResults('records/results/seg.json', [
        {
          key: `${PKG}:${REV}:seg:0`,
          value: llmEnvelope({
            output: { chapters: [{ chapterSeq: 1, segments: [{ name: '甲', summary: '' }] }, { segments: [{ name: '乙', summary: '' }] }] },
            warnings: []
          })
        }
      ])
      const rtBadSeq = makeRt(wsBadSeq)
      const dBadSeq = await step.run(rtBadSeq)
      check(
        'F11 章条目缺 chapterSeq → 跳过该章 + warning 不崩',
        dBadSeq.atomics.length === 1 && rtBadSeq.warnings.some((w) => w.includes('chapterSeq')),
        `${dBadSeq.atomics.length} | ${JSON.stringify(rtBadSeq.warnings)}`
      )
    }

    // =====================================================================
    // G · 注册与配置
    // =====================================================================
    console.log('\nG · 注册与配置')
    {
      check('G1 LOCAL_STEP_MAP.event 存在且 id === "event"', step?.id === 'event', String(step?.id))
      check('G2 LOCAL_TASK_IDS 含 event（四条本地步骤）', Array.isArray(tasks.LOCAL_TASK_IDS) && tasks.LOCAL_TASK_IDS.includes('event') && tasks.LOCAL_TASK_IDS.length === 4, JSON.stringify(tasks.LOCAL_TASK_IDS))
      check('G3 LLM_ADAPTERS 里没有 event（本地步骤不进 LLM 分支）', tasks.LLM_ADAPTERS['event'] === undefined)
      check('G4 老三条本地步骤未丢（merge/canonical/draftAlign 仍在）', ['merge', 'canonical', 'draftAlign'].every((id) => tasks.LOCAL_STEP_MAP[id]?.id === id))

      const registry = JSON.parse(await readFile(join(FEATHER, 'resources', 'pipeline', 'task-registry.json'), 'utf8'))
      const list = Array.isArray(registry) ? registry : registry.tasks ?? []
      const row = list.find((t) => t.id === 'event')
      check('G5 task-registry 的 event 行 model === false', row?.model === false, JSON.stringify(row?.model))
      check('G6 task-registry 的 event 行 global === true', row?.global === true, JSON.stringify(row?.global))
      check(
        'G7 其余字段未动（id/kind/label/feature/dependsOn）',
        row?.kind === 'event' && row?.label === '事件脉络' && row?.feature === 'events' && JSON.stringify(row?.dependsOn) === '["plot:*","seg:*"]',
        JSON.stringify(row)
      )
    }

    // =====================================================================
    // H · 与真实库同构（字段契约，只读）
    // =====================================================================
    console.log('\nH · 与真实库同构（只读 15de5d4f/event.json）')
    if (!existsSync(REAL_EVENT)) {
      skip('H 组（真实库字段契约对拍）', `找不到 ${REAL_EVENT}`)
    } else {
      const real = JSON.parse(await readFile(REAL_EVENT, 'utf8'))
      const entry = real.entries?.[0]
      const realData = entry?.value?.data ?? entry?.value ?? {}
      const realAgg = Array.isArray(realData.aggregates) ? realData.aggregates : []
      const realAto = Array.isArray(realData.atomics) ? realData.atomics : []
      const realMem = Array.isArray(realData.memberships) ? realData.memberships : []
      const realAggKeys = realAgg.length ? Object.keys(realAgg[0]) : []
      const realAtoKeys = realAto.length ? Object.keys(realAto[0]) : []
      const realMemKeys = realMem.length ? Object.keys(realMem[0]) : []

      check('H1 真实库确为 {aggregates,atomics,memberships} 三键形态', ['aggregates', 'atomics', 'memberships'].every((k) => k in realData), Object.keys(realData).join(','))
      check('H2 我们的 aggregates 字段集包含真实库的 aggregates 字段集', realAggKeys.every((k) => k in (aggA[0] ?? {})), `real=${realAggKeys.join(',')} ours=${Object.keys(aggA[0] ?? {}).join(',')}`)
      check('H3 我们的 atomics 字段集包含真实库的 atomics 字段集', realAtoKeys.every((k) => k in (atoA[0] ?? {})), `real=${realAtoKeys.join(',')} ours=${Object.keys(atoA[0] ?? {}).join(',')}`)
      check('H4 我们的 memberships 字段集包含真实库的 memberships 字段集', realMemKeys.every((k) => k in (memA[0] ?? {})), `real=${realMemKeys.join(',')} ours=${Object.keys(memA[0] ?? {}).join(',')}`)
      check(
        'H5 真实库同样只有 1 个 L1（全书一个根节点）',
        realAgg.filter((a) => a.level === 1).length === 1 && realAgg.filter((a) => a.level === 2).length === realAgg.length - 1,
        `${realAgg.filter((a) => a.level === 1).length}/${realAgg.length}`
      )
      check('H6 真实库无 L3（层级 1/2/4 三档，与我们一致）', !realAgg.some((a) => a.level === 3) && !realAto.some((a) => a.level === 3))
      check('H7 真实库 id 前缀形态与我们一致（E-main / E-ch-* / E-beat-*）', realAgg[0]?.id === 'E-main' && realAgg.every((a, i) => (i === 0 ? true : /^E-ch-\d+$/.test(String(a.id)))) && realAto.every((a) => /^E-beat-\d+$/.test(String(a.id))), `${realAgg[0]?.id} | ${realAto[0]?.id}`)
      check(
        'H8 真实库 L4 的 l1Id 全指向根（与我们一致）',
        realAto.every((a) => a.l1Id === realAgg[0]?.id)
      )
      check(
        'H9 真实库 memberships = L2 数 + L4 数（每节点一条父边，与我们一致）',
        realMem.length === realAgg.length - 1 + realAto.length,
        `${realMem.length} vs ${realAgg.length - 1 + realAto.length}`
      )
    }
  } finally {
    await rm(TEST_PARENT, { recursive: true, force: true })
  }

  console.log(`\n==== D1 event 验证：${passed} 通过 / ${failed} 失败${skipped ? ` / ${skipped} 跳过` : ''} ====`)
  if (failed === 0) {
    console.log('D1 EVENT VERIFY PASS')
  } else {
    console.log('D1 EVENT VERIFY FAIL')
  }
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('ERROR:', e?.stack ?? e?.message ?? e)
  process.exitCode = 2
})

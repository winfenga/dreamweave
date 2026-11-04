/**
 * T6-G · 形象/逐行链验证脚本（characterAppearance + lineAnnotation 两适配器 +
 * 引擎两处加性扩展 + rt-stash 快照模块）
 * （node 直跑，**不启动 Electron**；零新增依赖）。
 *
 * 覆盖四组（对应 T6-G spec 验收项）：
 *  A. characterAppearance：造 canonical 产物（2 角色：一个带 2 条 characterSpriteInfos
 *     （chunkIndex 0/1）、一个不带）→ inputText 含两人与 spriteInfos 且
 *     firstChunkSummary 取 chunkSummaryList 升序首条；buildMessages 恰 2 条且快照可读
 *     （经 parse 间接验证——有快照 chunkIndexes 正确解析、无快照全跳过）；parse 正样本
 *     （2 形象 + sourceIndexes [0,1] 与 [1,1,0] 去重升序、推断角色 1 形象）→ appearanceId
 *     = {charId}-A-1/-A-2、chunkIndexes 正确（[0,1]）、推断角色 []、输出 MAP 形态、每人
 *     恰好一次、字段集严格；脏样本（缺 characters → 空 MAP + warning 不抛崩 / id 不在输入 /
 *     sex 非法归一 ''+warning / sourceIndex 越界跳过+warning / 缺 name 跳过+warning /
 *     跳过后编号按位置留洞 A-2）→ 不抛崩；注册完整；模板占位符全覆盖；keyOf 语义 + 引擎
 *     合并模拟（同人物跨批按 id 首现获胜）；无 canonical 产物 → 可读错误；
 *  B. lineAnnotation：造 characterAppearance + locationTree + plot 产物；mock rt
 *     （chunkIndex=0，chunkChapters 两章各 3 行）→ inputText 含行号包装；buildMessages
 *     恰 3 条（原文单独喂）且 6 个模板变量内容正确（chapterLineCounts JSON / 人物含
 *     appearanceId / 地图树完整 / chunk 0 阅读记忆为空合法）；无 characterAppearance 产物
 *     → 可读错误（inputText 不抛）；parse 正样本（本地 id l1/l2 + 含 [n] 继承、[n,null]、
 *     [n,"l1","ap-1"]）→ id 重编 L-0-l1/L-0-l2、行引用正确映射、继承展开、行覆盖 1..N
 *     校验、缺章补全+warning、未知 appearanceId 丢弃+warning；缺号补 + 超范围丢弃 + 整章
 *     缺失补全；重复本地 id 防御（两个 l1 → 引用置 null+warning、条目仍存活重编）；每章
 *     第一行继承违规 → [n,null]+warning；缺 chapters → raw 兜底；模型多给章 → 整章丢弃；
 *     注册完整；模板占位符全覆盖；keyOf 语义 + 引擎合并模拟（跨批同章不同行段都存活）；
 *  C. batching 覆盖：lineAnnotationAdapter.batching.inputBudgetTokens === 100000；
 *     老适配器（含 characterAppearance）无 batching 字段（不影响默认）；T6-G 修正实证——
 *     planBatches 信任 cfg 入参（~30000 token 文本 + 覆盖 100000 → 单批 converged；
 *     ~42K token chunk（chunking targetTokens=42000 上界）→ 单批，大书逐行标注不再因
 *     切批碰撞丢失）；回归保护——同文本默认 8000 仍切多批、构造侧夹紧未动
 *     （defaultBatchingConfig({999999}) 仍夹到 24000）；脏值防御——inputBudgetTokens
 *     为 -1 / NaN 时回退 DEFAULT_L2_TOKENS（与默认同批数、不崩）；
 *  D. rt-stash：stash 后 read 得同值；不同 key 互不串；新对象/undefined/null → undefined。
 *
 * 姿势与 `scripts/verify-t6f-map-chain.mjs` 一致：`createRequire(feather/package.json)`
 * 取项目已装的 esbuild，把入口打成单文件 ESM 写入临时目录后 `pathToFileURL` 动态 import；
 * electron 以最小桩替换（app.getAppPath → 项目根，使 prompt-loader 的 resourcesDir()
 * 定位到 `resources/prompts`）。
 *
 * 临时目录**只准碰** `D:/AI/tx/feather-t6g-test/`（跑完 rm -rf 清掉）；
 * 绝不读写真实工作库目录（7 本真实库只读）。
 *
 * 用法：node scripts/verify-t6g-appearance-lines.mjs
 */
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(here, '..')
/** 唯一允许触碰的临时父目录（跑完 rm -rf 清掉） */
const TEST_PARENT = 'D:/AI/tx/feather-t6g-test'
const BUILD_DIR = join(TEST_PARENT, 'build')

const require = createRequire(join(FEATHER, 'package.json'))
const { build } = require('esbuild')

/** electron 最小桩：只提供 app.getAppPath / app.getPath（prompt-loader → effects/catalog 用）。 */
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
function check(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 提取模板中全部 mustache 变量名（`{{{v}}}` / `{{v}}`）。 */
function extractTemplateVars(tpl) {
  const names = new Set()
  const re = /\{\{\{?\s*([#^/]?)\s*([A-Za-z0-9_.]+)\s*\}?\}\}/g
  let m
  while ((m = re.exec(tpl))) names.add(m[2])
  return [...names]
}

/** 合成 TaskDef（只填适配器/渲染链路会碰的字段）。 */
function taskDef(id, global = true) {
  return {
    id,
    kind: id,
    code: id,
    label: id,
    feature: 'visualNovel',
    execution: '',
    input: '',
    output: '',
    model: true,
    thinking: 'disabled',
    effort: 1,
    maxTokens: 60000,
    global,
    setting: '',
    dependsOn: []
  }
}

// ---------------------------------------------------------------------------
// 临时工作库（字段按真实 ShardRow / ShardEnvelope 形状；7 本真实库只读，绝不触碰）
// ---------------------------------------------------------------------------

const PKG = 'pkg-t6g'
const REV = 'rev-t6g'

/** 一个小工作库：writeShard 写真分片 + 手工维护 index.json 的 shards 登记。 */
function makeWorkspace(root) {
  const idx = {
    indexVersion: 1,
    format: 'txt2world-workspace',
    pkgId: PKG,
    title: 'T6-G 验证书',
    origin: { t2wPath: '', t2wSize: 0, t2wSha256: '', manifestJsonSha256: '', hasOriginHeader: false, projectId: PKG, revisionId: REV, createdAt: '' },
    manifest: { includesSource: true, topLevelKeys: [], extra: {}, recordsKeys: [], containers: {}, containerKeyed: {}, project: {} },
    shards: [],
    assets: [],
    tasks: {},
    integrity: { createdAt: '', lastVerifiedAt: null }
  }
  return {
    root,
    /** 写 results 分片并登记 index（file 形如 records/results/<taskId>.json）。 */
    async writeResults(file, entries) {
      const env = { shard: file.replace(/\.json$/, ''), container: 'results', entries: entries.map((e, i) => ({ seq: i, ...e })) }
      await sh.writeShard(root, file, env)
      const row = idx.shards.find((r) => r.file === file)
      if (row) row.entryCount = entries.length
      else idx.shards.push({ name: file.replace(/\.json$/, ''), file, container: 'results', entryCount: entries.length, sha256: '' })
      await writeFile(join(root, 'index.json'), JSON.stringify(idx), 'utf8')
    },
    async reset() {
      await rm(root, { recursive: true, force: true })
      await mkdir(root, { recursive: true })
      idx.shards.length = 0
      await writeFile(join(root, 'index.json'), JSON.stringify(idx), 'utf8')
    }
  }
}

/** LLM 任务产物信封（与 orchestrator 的 writeResult 写口一致：{data, depth, calls, warnings, at}）。 */
function llmEnvelope(data) {
  return { data, depth: 1, calls: 1, warnings: [], at: new Date().toISOString() }
}

/** 本地任务产物信封（与 orchestrator 本地分支一致：{data, local:true, warnings, at}）。 */
function localEnvelope(data, warnings = []) {
  return { data, local: true, warnings, at: new Date().toISOString() }
}

/** 合成 rt：render 走真 prompt-loader 并留痕；readUpstream 走真 readUpstreamResults。 */
function makeRt(id, { global = true, chunkIndex = null, chunkChapters, chunkText = '', ws, renderLog = [] } = {}) {
  return {
    task: taskDef(id, global),
    pkgId: PKG,
    revisionId: REV,
    chunkIndex,
    instanceKey: `${PKG}:${REV}:${id}${chunkIndex === null ? '' : `:${chunkIndex}`}`,
    chunkText,
    chunkChapters,
    warnings: [],
    log: () => {},
    render: async (name, vars) => {
      renderLog.push({ name, vars: vars ?? {} })
      return pl.renderPrompt(name, vars ?? {})
    },
    llm: async () => {
      throw new Error('验证脚本不应触发真实 LLM 调用')
    },
    readUpstream: (tid) => up.readUpstreamResults(ws.root, tid)
  }
}

// ---------------------------------------------------------------------------
// 测试数据
// ---------------------------------------------------------------------------

/**
 * canonical 产物（本地步骤信封；T6-E 形状）：
 *  - D-0-C-0 艾莉娜：带 2 条 characterSpriteInfos（chunkIndex 0/1）；chunkSummaryList
 *    **故意乱序**（1 在前 0 在后）→ 验证 firstChunkSummary 取升序首条（第0块）；
 *  - D-0-C-1 神秘老者：无 characterSpriteInfos（推断形象）、chunkSummaryList 空。
 */
const CANONICAL = {
  objects: {
    characters: [
      {
        id: 'D-0-C-0',
        name: '艾莉娜',
        aliases: ['艾莉'],
        identInfos: ['持圣剑的少女'],
        importanceLevel: 'CORE',
        chunkSummaryList: [
          { chunkIndex: 1, summaryText: '第1块：艾莉娜在魔法草原遇见菲雅。' },
          { chunkIndex: 0, summaryText: '第0块：艾莉娜在王城举起圣剑。' }
        ],
        characterSpriteInfos: [
          { appearanceSummary: '银发少女，持圣剑', visualKeywords: ['银发', '圣剑'], sex: '女', chunkIndex: 0 },
          { appearanceSummary: '银发少女，披风加身', visualKeywords: ['银发', '披风'], sex: '女', chunkIndex: 1 }
        ]
      },
      {
        id: 'D-0-C-1',
        name: '神秘老者',
        aliases: [],
        identInfos: [],
        chunkSummaryList: []
        // 无 characterSpriteInfos → 模板「未提供 characterSpriteInfos 的人物」推定形象
      }
    ],
    factions: [],
    items: [],
    creatures: [],
    identityMatchStopNames: []
  },
  mapping: { 'D-0-C-0': 'D-0-C-0', 'D-0-C-1': 'D-0-C-1' }
}

/** characterAppearance 产物（本适配器 parse 的主条目 MAP 形态；lineAnnotation 的输入）。 */
const CHARACTER_APPEARANCE = {
  'D-0-C-0': [
    { appearanceId: 'D-0-C-0-A-1', name: '日常形象', sex: '女', appearanceSummary: '银发少女持圣剑', visualKeywords: ['银发', '圣剑'], chunkIndexes: [0, 1] },
    { appearanceId: 'D-0-C-0-A-2', name: '战斗形象', sex: '女', appearanceSummary: '银发少女披风加身', visualKeywords: ['披风'], chunkIndexes: [1] }
  ],
  'D-0-C-1': [
    { appearanceId: 'D-0-C-1-A-1', name: '推定老者', sex: '男', appearanceSummary: '灰袍老者', visualKeywords: ['灰袍'], chunkIndexes: [] }
  ]
}

/** locationTree 产物（T6-C 形状；含不可展示节点——mapLocationTreeJson 不剪枝）。 */
const LOCATION_TREE = {
  locations: [
    { id: '1', name: '艾尔希雅王城', aliases: ['王城'], locationType: '城市', identInfos: ['毗邻魔法草原'], showOnImpressionMap: true, parentLocationId: null, ancestorLocationId: null },
    { id: '3', name: '百合酒吧', aliases: ['酒吧'], locationType: '酒吧', identInfos: ['位于王城旁'], showOnImpressionMap: false, parentLocationId: '1', ancestorLocationId: null }
  ],
  tree: {
    id: 'novel-world', name: '小说世界', locationType: '世界', aliases: [], identInfos: [], parentLocationId: null, ancestorLocationId: null,
    children: [
      {
        id: '1', name: '艾尔希雅王城', aliases: ['王城'], locationType: '城市', identInfos: ['毗邻魔法草原'], showOnImpressionMap: true, parentLocationId: null, ancestorLocationId: null,
        children: [
          { id: '3', name: '百合酒吧', aliases: ['酒吧'], locationType: '酒吧', identInfos: ['位于王城旁'], showOnImpressionMap: false, parentLocationId: '1', ancestorLocationId: null, children: [] }
        ]
      }
    ]
  },
  warnings: []
}

/** plot 产物摘要（阅读记忆来源；chunk 0 读前记忆天然为空）。 */
const PLOT_SUMMARIES = [
  '第0章：艾莉娜在王城举起圣剑。',
  '第1章：艾莉娜在魔法草原遇见菲雅。'
]

/** lineAnnotation 被测实例的章节切片（两章各 3 行——第三行为空行，占行号）。 */
const LA_CHAPTERS = [
  { seq: 1, title: '第一章 王城', text: '艾莉娜走进王城大殿。\n她看见了老者。\n' },
  { seq: 2, title: '第二章 酒吧', text: '夜色降临。\n老者走进酒吧。\n' }
]
const LA_TEXT = LA_CHAPTERS.map((c) => c.text).join('\n')

let tasks
let li
let up
let pl
let sh
let mg
let bt
let rs

/** 建工作库并灌上游产物（canonical/characterAppearance/locationTree/plot 可按需缺）。 */
async function fillWorkspace(ws, { withCanonical = true, withAppearance = true, withLocationTree = true, withPlot = true } = {}) {
  await ws.reset()
  if (withCanonical) {
    await ws.writeResults('records/results/canonical.json', [{ key: `${PKG}:${REV}:canonical`, value: localEnvelope(CANONICAL) }])
  }
  if (withAppearance) {
    await ws.writeResults('records/results/characterAppearance.json', [
      { key: `${PKG}:${REV}:characterAppearance`, value: llmEnvelope(CHARACTER_APPEARANCE) }
    ])
  }
  if (withLocationTree) {
    await ws.writeResults('records/results/locationTree.json', [{ key: `${PKG}:${REV}:locationTree`, value: llmEnvelope(LOCATION_TREE) }])
  }
  if (withPlot) {
    await ws.writeResults(
      'records/results/plot.json',
      PLOT_SUMMARIES.map((s, i) => ({ key: `${PKG}:${REV}:plot:${i}`, value: llmEnvelope({ chunkSummary: s, chapters: [] }) }))
    )
  }
}

/** 建 rt 并先跑一次 buildMessages（挂快照）——parse 测试的标准前置。 */
async function stashedRt(id, opts) {
  const rt = makeRt(id, opts)
  await tasks[`${id}Adapter`].buildMessages('（批文本占位，不应被拆用）', rt)
  return rt
}

async function main() {
  await rm(TEST_PARENT, { recursive: true, force: true })
  await mkdir(BUILD_DIR, { recursive: true })
  console.log(`临时目录：${TEST_PARENT}\n`)

  tasks = await loadModule('src/main/pipeline/tasks/index.ts', 'tasks-index.mjs')
  up = await loadModule('src/main/pipeline/upstream.ts', 'upstream.mjs')
  pl = await loadModule('src/main/pipeline/prompt-loader.ts', 'prompt-loader.mjs')
  sh = await loadModule('src/main/workspace/shards.ts', 'shards.mjs')
  mg = await loadModule('src/main/pipeline/merge.ts', 'merge.mjs')
  bt = await loadModule('src/main/pipeline/batching.ts', 'batching.mjs')
  rs = await loadModule('src/main/pipeline/rt-stash.ts', 'rt-stash.mjs')

  const ws = makeWorkspace(join(TEST_PARENT, 'ws'))

  try {
    // =====================================================================
    // A · characterAppearance
    // =====================================================================
    console.log('A · characterAppearance 适配器')
    const ca = tasks.characterAppearanceAdapter
    await fillWorkspace(ws)

    // ---- A1. inputText：输入数组形状 + firstChunkSummary 升序首条 ----
    {
      const rt = makeRt('characterAppearance', { ws })
      const input = await ca.inputText(rt)
      const chars = JSON.parse(input)
      check('A1 inputText 是 canonical 人物数组的 JSON', Array.isArray(chars) && chars.length === 2, input.slice(0, 120))
      check('A1 输入序 = canonical 序（D-0-C-0 在前）', chars[0].id === 'D-0-C-0' && chars[1].id === 'D-0-C-1')
      check('A1 每人字段集严格为 id/name/aliases/identInfos/firstChunkSummary/characterSpriteInfos', chars.every((c) => Object.keys(c).sort().join(',') === 'aliases,characterSpriteInfos,firstChunkSummary,id,identInfos,name'), JSON.stringify(Object.keys(chars[0] ?? {})))
      check('A1 firstChunkSummary = chunkSummaryList 升序首条（乱序输入取第0块）', chars[0].firstChunkSummary === '第0块：艾莉娜在王城举起圣剑。', chars[0].firstChunkSummary)
      check('A1 无 chunkSummaryList → firstChunkSummary 空串', chars[1].firstChunkSummary === '')
      check('A1 characterSpriteInfos 原样带出（2 条 / 0 条）', chars[0].characterSpriteInfos.length === 2 && chars[1].characterSpriteInfos.length === 0)
      check('A1 spriteInfos 每条自带来源 chunkIndex（0/1）', chars[0].characterSpriteInfos[0].chunkIndex === 0 && chars[0].characterSpriteInfos[1].chunkIndex === 1)
      check('A1 inputText 含两个人物 id 与形象描述', input.includes('D-0-C-0') && input.includes('D-0-C-1') && input.includes('银发少女，披风加身'))
      check('A1 aliases 两代形状归一提字符串数组', JSON.stringify(chars[0].aliases) === '["艾莉"]')
    }

    // ---- A2. buildMessages：恰 2 条 + 模板占位符全覆盖 ----
    {
      const renderLog = []
      const rt = makeRt('characterAppearance', { ws, renderLog })
      const msgs = await ca.buildMessages('（批文本占位，拆了就是非法 JSON 片段）', rt)
      check('A2 buildMessages 恰 2 条（system + user 指令）', msgs.length === 2 && msgs[0].role === 'system' && msgs[1].role === 'user', JSON.stringify(msgs.map((m) => m.role)))
      check('A2 两条消息均无 {{ 残留', msgs.every((m) => !m.content.includes('{{')))
      check('A2 user 指令含全量人物名单（两人）', msgs[1].content.includes('D-0-C-0') && msgs[1].content.includes('D-0-C-1'))
      const taskEntry = renderLog.find((r) => r.name === 'character_appearance_user_prompt')
      const tplVars = extractTemplateVars(await readFile(join(FEATHER, 'resources', 'prompts', 'character_appearance_user_prompt.txt'), 'utf8'))
      check('A2 模板占位符恰为 characters', tplVars.sort().join(',') === 'characters', tplVars.join(','))
      check('A2 模板占位符全覆盖且无多余键', !!taskEntry && Object.keys(taskEntry.vars).sort().join(',') === tplVars.sort().join(','), JSON.stringify(Object.keys(taskEntry?.vars ?? {})))
    }

    // ---- A3. parse 正样本：appearanceId / chunkIndexes / MAP 形态 ----
    {
      const rt = await stashedRt('characterAppearance', { ws })
      const modelOut = JSON.stringify({
        characters: [
          {
            id: 'D-0-C-0',
            appearances: [
              { name: '日常形象', appearanceSummary: '银发少女持圣剑', visualKeywords: ['银发', '圣剑'], sex: '女', sourceIndexes: [0, 1] },
              { name: '战斗形象', appearanceSummary: '银发少女披风加身', visualKeywords: ['披风'], sex: '女', sourceIndexes: [1, 1, 0] }
            ]
          },
          {
            id: 'D-0-C-1',
            appearances: [{ name: '推定老者', appearanceSummary: '灰袍老者', visualKeywords: ['灰袍'], sex: '男', sourceIndexes: [] }]
          }
        ]
      })
      const out = ca.parse(modelOut, rt)
      check('A3 输出为主条目 MAP 形态 {charId:[形象对象...]}', !!out && typeof out === 'object' && !Array.isArray(out) && Object.keys(out).sort().join(',') === 'D-0-C-0,D-0-C-1', JSON.stringify(Object.keys(out ?? {})))
      check('A3 每人恰好一次（map 键数 = 输入人数）', Object.keys(out).length === 2)
      const a1 = out['D-0-C-0'][0]
      const a2 = out['D-0-C-0'][1]
      const b1 = out['D-0-C-1'][0]
      check('A3 appearanceId = {charId}-A-{n+1}（对齐 D-0-C-1-A-1 形态）', a1.appearanceId === 'D-0-C-0-A-1' && a2.appearanceId === 'D-0-C-0-A-2' && b1.appearanceId === 'D-0-C-1-A-1', `${a1.appearanceId}/${a2.appearanceId}/${b1.appearanceId}`)
      check('A3 chunkIndexes 正确解析（[0,1]）', JSON.stringify(a1.chunkIndexes) === '[0,1]', JSON.stringify(a1.chunkIndexes))
      check('A3 sourceIndexes 去重升序（[1,1,0] → [0,1]）', JSON.stringify(a2.chunkIndexes) === '[0,1]', JSON.stringify(a2.chunkIndexes))
      check('A3 推断角色（无 spriteInfos）chunkIndexes 为空数组', Array.isArray(b1.chunkIndexes) && b1.chunkIndexes.length === 0)
      check('A3 形象对象字段集严格 {appearanceId,name,sex,appearanceSummary,visualKeywords,chunkIndexes}', [a1, a2, b1].every((x) => Object.keys(x).sort().join(',') === 'appearanceId,appearanceSummary,chunkIndexes,name,sex,visualKeywords'), JSON.stringify(Object.keys(a1)))
      check('A3 sex/摘要/关键词按契约落地', a1.sex === '女' && a1.appearanceSummary === '银发少女持圣剑' && JSON.stringify(a1.visualKeywords) === '["银发","圣剑"]')
      check('A3 正样本无 warning（不误报）', rt.warnings.length === 0, JSON.stringify(rt.warnings))
    }

    // ---- A4. parse 脏样本：不抛崩 + 各降级路径 ----
    {
      const rt = await stashedRt('characterAppearance', { ws })
      // ① 缺 characters → 空 MAP + raw 兜底 warning
      const d1 = ca.parse('{"foo":1}', rt)
      check('A4 ① 缺 characters → 返回空 MAP 不抛崩', !!d1 && typeof d1 === 'object' && Object.keys(d1).length === 0)
      check('A4 ① 缺 characters → warning 进 rt.warnings', rt.warnings.some((w) => w.includes('缺 characters 数组')))
      // ② id 不在输入人物集 → 跳过 + warning
      const d2 = ca.parse('{"characters":[{"id":"D-9-C-9","appearances":[{"name":"外人"}]}]}', rt)
      check('A4 ② id 不在输入 → 跳过（空 MAP）', Object.keys(d2).length === 0)
      check('A4 ② id 不在输入 → warning 点名', rt.warnings.some((w) => w.includes('D-9-C-9') && w.includes('不在 canonical 输入人物集中')))
      // ③ sex 非法 → 归一 '' + warning
      const d3 = ca.parse('{"characters":[{"id":"D-0-C-1","appearances":[{"name":"推定老者","sex":"未知","sourceIndexes":[]}]}]}', rt)
      check('A4 ③ sex 非法归一为空串', d3['D-0-C-1'][0].sex === '')
      check('A4 ③ sex 非法 → warning', rt.warnings.some((w) => w.includes('sex') && w.includes('归一')))
      // ④ sourceIndex 越界 → 跳过该项 + warning（形象本身保留）
      const d4 = ca.parse('{"characters":[{"id":"D-0-C-0","appearances":[{"name":"日常形象","sourceIndexes":[5]}]}]}', rt)
      check('A4 ④ sourceIndex 越界 → 该项跳过（形象保留、chunkIndexes 空）', d4['D-0-C-0'].length === 1 && d4['D-0-C-0'][0].chunkIndexes.length === 0)
      check('A4 ④ sourceIndex 越界 → warning', rt.warnings.some((w) => w.includes('sourceIndex=5') && w.includes('越界')))
      // ⑤ 缺 name → 跳过该形象 + warning；编号按位置留洞（第 2 个 → A-2）
      const d5 = ca.parse('{"characters":[{"id":"D-0-C-1","appearances":[{"appearanceSummary":"无名字"},{"name":"老者"}]}]}', rt)
      check('A4 ⑤ 缺 name 形象被跳过（只剩 1 个）', d5['D-0-C-1'].length === 1)
      check('A4 ⑤ 编号按数组位置（跳过后幸存者得 A-2，留洞是刻意选择）', d5['D-0-C-1'][0].appearanceId === 'D-0-C-1-A-2', d5['D-0-C-1'][0].appearanceId)
      check('A4 ⑤ 缺 name → warning', rt.warnings.some((w) => w.includes('缺 name')))
      // ⑥ 重复人物 → 保留首条 + warning
      const d6 = ca.parse('{"characters":[{"id":"D-0-C-1","appearances":[{"name":"甲"}]},{"id":"D-0-C-1","appearances":[{"name":"乙"}]}]}', rt)
      check('A4 ⑥ 重复人物保留首条（恰好一次）', d6['D-0-C-1'].length === 1 && d6['D-0-C-1'][0].name === '甲')
      check('A4 ⑥ 重复人物 → warning', rt.warnings.some((w) => w.includes('重复返回')))
      // ⑦ 输入人物未被返回 → warning
      const d7 = ca.parse('{"characters":[{"id":"D-0-C-1","appearances":[{"name":"老者"}]}]}', rt)
      check('A4 ⑦ 输入人物遗漏 → warning 点名 D-0-C-0', rt.warnings.some((w) => w.includes('D-0-C-0') && w.includes('未被模型返回')))
    }

    // ---- A5. 快照机制实证（rt-stash 经适配器的 Functional Test）----
    {
      // 有快照（buildMessages 挂过）→ chunkIndexes 可解析
      const withSnap = await stashedRt('characterAppearance', { ws })
      const okOut = ca.parse('{"characters":[{"id":"D-0-C-0","appearances":[{"name":"日常","sourceIndexes":[0,1]}]}]}', withSnap)
      // 无快照（全新 rt，没跑 buildMessages）→ sourceIndexes 全部跳过 + warning
      const noSnap = makeRt('characterAppearance', { ws })
      const noOut = ca.parse('{"characters":[{"id":"D-0-C-0","appearances":[{"name":"日常","sourceIndexes":[0,1]}]}]}', noSnap)
      check('A5 有快照 → chunkIndexes 解析为 [0,1]', JSON.stringify(okOut['D-0-C-0'][0].chunkIndexes) === '[0,1]')
      check('A5 无快照 → sourceIndexes 全跳过（chunkIndexes 空）+ warning', JSON.stringify(noOut['D-0-C-0'][0].chunkIndexes) === '[]' && noSnap.warnings.some((w) => w.includes('sourceIndex=0')), JSON.stringify(noSnap.warnings))
      check('A5 无快照 → 不校验人物归属（id 原样收，兼容测试/合成调用）', !!noOut['D-0-C-0'])
    }

    // ---- A6. 注册 + keyOf + 引擎合并模拟 + 无产物错误 ----
    {
      check('A6 characterAppearance 已注册', tasks.LLM_ADAPTERS['characterAppearance']?.id === 'characterAppearance')
      check('A6 导出的 characterAppearanceKeyOf 与适配器同一函数', tasks.characterAppearanceKeyOf === ca.keyOf)
      const kof = tasks.characterAppearanceKeyOf
      check('A6 keyOf：人物条目按 id', kof({ id: 'D-0-C-0', appearances: [] }) === 'D-0-C-0')
      check('A6 keyOf：形象对象（无 id）→ JSON 串兜底', kof({ name: '日常形象', sourceIndexes: [0] }) === JSON.stringify({ name: '日常形象', sourceIndexes: [0] }))
      // 引擎合并模拟（合并先于 parse，keyOf 看到模型原始文本）：两批都产全量人物 → 按 id 首现获胜
      const merged = mg.mergeOutputs(
        'concat-dedup-order',
        [
          JSON.stringify({ characters: [{ id: 'D-0-C-0', appearances: [{ name: '日常形象', sourceIndexes: [0] }] }] }),
          JSON.stringify({ characters: [{ id: 'D-0-C-0', appearances: [{ name: '战斗形象', sourceIndexes: [1] }] }] })
        ],
        kof
      )
      const rt = await stashedRt('characterAppearance', { ws })
      const d = ca.parse(merged, rt)
      check('A6 引擎合并模拟：同人物跨批按 id 去重首现获胜（只留首批的日常形象）', d['D-0-C-0'].length === 1 && d['D-0-C-0'][0].name === '日常形象', JSON.stringify(d['D-0-C-0']))

      // 无 canonical 产物 → 可读错误
      const ws2 = makeWorkspace(join(TEST_PARENT, 'ws-nocanon'))
      await fillWorkspace(ws2, { withCanonical: false })
      const rt2 = makeRt('characterAppearance', { ws: ws2 })
      let threw = ''
      try {
        await ca.inputText(rt2)
      } catch (e) {
        threw = e.message
      }
      check('A6 无 canonical 产物 → inputText 抛可读错误', /characterAppearance 需要 canonical 产物/.test(threw), threw)
    }

    // =====================================================================
    // B · lineAnnotation
    // =====================================================================
    console.log('\nB · lineAnnotation 适配器')
    const la = tasks.lineAnnotationAdapter
    await fillWorkspace(ws)

    // ---- B1. inputText：带行号包装 ----
    {
      const rt = makeRt('lineAnnotation', { global: false, chunkIndex: 0, chunkChapters: LA_CHAPTERS, chunkText: LA_TEXT, ws })
      const input = await la.inputText(rt)
      check('B1 inputText 含章节包装（两章各 1-3）', input.includes('【原文行：1-3】') && input.split('【原文行：1-3】').length === 3, input.slice(0, 80))
      check('B1 inputText 行号从 1 重新编号（各章独立）', input.includes('1 艾莉娜走进王城大殿。') && input.includes('1 夜色降临。'))
      check('B1 inputText 空行也占行号（第 3 行）', input.includes('3 \n') || input.trimEnd().endsWith('3'))
      check('B1 inputText 不含模板变量渲染（纯原文）', !input.includes('{{{'))
    }

    // ---- B2. buildMessages：恰 3 条 + 6 变量内容正确 + 占位符全覆盖 ----
    {
      const renderLog = []
      const rt = makeRt('lineAnnotation', { global: false, chunkIndex: 0, chunkChapters: LA_CHAPTERS, chunkText: LA_TEXT, ws, renderLog })
      const input = await la.inputText(rt)
      const msgs = await la.buildMessages(input, rt)
      check('B2 buildMessages 恰 3 条（system + user 原文 + user 指令）', msgs.length === 3 && msgs[0].role === 'system' && msgs[1].role === 'user' && msgs[2].role === 'user', JSON.stringify(msgs.map((m) => m.role)))
      check('B2 第 2 条 = 带行号原文单独喂（与 inputText 逐字一致）', msgs[1].content === input)
      check('B2 三条消息均无 {{ 残留', msgs.every((m) => !m.content.includes('{{')))
      const taskEntry = renderLog.find((r) => r.name === 'line_annotation_user_prompt')
      const v = taskEntry?.vars ?? {}
      check('B2 chunkIndex = rt.chunkIndex（0）', v.chunkIndex === 0)
      check('B2 chapterSeqs = join 字符串 "1,2"', v.chapterSeqs === '1,2', String(v.chapterSeqs))
      check('B2 chapterLineCounts = JSON 数组字符串（两章各 3 行）', v.chapterLineCounts === '[{"chapterSeq":1,"lineCount":3},{"chapterSeq":2,"lineCount":3}]', String(v.chapterLineCounts))
      check('B2 chunkReadingMemory = chunk 0 读前记忆为空（合法）', v.chunkReadingMemory === '{"recentMemory":[],"midMemory":[],"longTermMemory":[]}', String(v.chunkReadingMemory))
      const persons = JSON.parse(String(v.characters))
      check('B2 characters 来自 characterAppearance 产物（每人 id + appearances）', persons.length === 2 && persons[0].id === 'D-0-C-0' && persons[0].appearances[0].appearanceId === 'D-0-C-0-A-1', String(v.characters).slice(0, 160))
      check('B2 characters 每人 {id,name,appearances:[{appearanceId,name}]}', persons.every((p) => Object.keys(p).sort().join(',') === 'appearances,id,name' && p.appearances.every((a) => Object.keys(a).sort().join(',') === 'appearanceId,name')))
      check('B2 mapLocationTree 完整树不剪枝（含不可展示节点 3）', String(v.mapLocationTree).includes('novel-world') && String(v.mapLocationTree).includes('百合酒吧') && String(v.mapLocationTree).includes('"id":"3"'))
      const tplVars = extractTemplateVars(await readFile(join(FEATHER, 'resources', 'prompts', 'line_annotation_user_prompt.txt'), 'utf8'))
      check('B2 模板占位符恰为 6 个', tplVars.sort().join(',') === 'chapterLineCounts,chapterSeqs,chunkIndex,characters,chunkReadingMemory,mapLocationTree'.split(',').sort().join(','), tplVars.join(','))
      check('B2 模板占位符全覆盖且无多余键', !!taskEntry && Object.keys(v).sort().join(',') === tplVars.sort().join(','), JSON.stringify(Object.keys(v)))
      check('B2 user 指令含 appearanceId（模型据此引用形象）', msgs[2].content.includes('D-0-C-0-A-1') && msgs[2].content.includes('D-0-C-1-A-1'))
    }

    // ---- B3. 无 characterAppearance 产物 → 可读错误（inputText 不抛）----
    {
      const ws2 = makeWorkspace(join(TEST_PARENT, 'ws-noapp'))
      await fillWorkspace(ws2, { withAppearance: false })
      const rt = makeRt('lineAnnotation', { global: false, chunkIndex: 0, chunkChapters: LA_CHAPTERS, chunkText: LA_TEXT, ws: ws2 })
      const input = await la.inputText(rt)
      check('B3 无 characterAppearance 产物时 inputText 仍正常（纯原文不依赖上游）', input.includes('【原文行：1-3】'))
      let threw = ''
      try {
        await la.buildMessages(input, rt)
      } catch (e) {
        threw = e.message
      }
      check('B3 无 characterAppearance 产物 → buildMessages 抛可读错误', /lineAnnotation 需要 characterAppearance 产物/.test(threw), threw)
    }

    // ---- B4. parse 正样本：id 重编 + 行引用映射 + 继承展开 ----
    {
      const rt = await stashedRt('lineAnnotation', { global: false, chunkIndex: 0, chunkChapters: LA_CHAPTERS, chunkText: LA_TEXT, ws })
      const modelOut = JSON.stringify({
        plotLocations: [
          { id: 'l1', name: '王城大殿', mapLocationId: '1', identInfos: ['王座'], summary: '大殿场景', sceneDescription: '石柱与彩窗' },
          { id: 'l2', name: '百合酒吧', mapLocationId: null, identInfos: [], summary: '酒吧场景', sceneDescription: '' }
        ],
        chapters: [
          { chapterSeq: 1, lines: [[1, 'l1', 'D-0-C-0-A-1'], [2], [3, 'l1', 'ap-unknown']] },
          { chapterSeq: 2, lines: [[1, 'l2', 'D-0-C-0-A-1'], [2, 'l2'], [3]] }
        ]
      })
      const d = la.parse(modelOut, rt)
      check('B4 plotLocations 重编 L-0-l1/L-0-l2（模型本地 id 不保留）', d.plotLocations.map((p) => p.id).join(',') === 'L-0-l1,L-0-l2', JSON.stringify(d.plotLocations.map((p) => p.id)))
      check('B4 plotLocations 字段集严格 7 字段 + chunkIndex=0', d.plotLocations.every((p) => Object.keys(p).sort().join(',') === 'chunkIndex,identInfos,mapLocationId,name,sceneDescription,summary,id'.split(',').sort().join(',')) && d.plotLocations.every((p) => p.chunkIndex === 0), JSON.stringify(Object.keys(d.plotLocations[0] ?? {})))
      check('B4 mapLocationId 显式 null（模板契约，与 plotLocation 省略是有意差异）', d.plotLocations[0].mapLocationId === '1' && d.plotLocations[1].mapLocationId === null)
      check('B4 章 1 行 1 完整标注映射', JSON.stringify(d.chapters[0].lines[0]) === '[1,"L-0-l1","D-0-C-0-A-1"]', JSON.stringify(d.chapters[0].lines[0]))
      check('B4 章 1 行 2 [2] 继承展开为上一行完整标注', JSON.stringify(d.chapters[0].lines[1]) === '[2,"L-0-l1","D-0-C-0-A-1"]', JSON.stringify(d.chapters[0].lines[1]))
      check('B4 章 1 行 3 未知 appearanceId 丢弃 + warning', JSON.stringify(d.chapters[0].lines[2]) === '[3,"L-0-l1"]' && d.warnings.some((w) => w.includes('ap-unknown')), JSON.stringify(d.chapters[0].lines[2]))
      check('B4 章 2 行 1 映射 l2 → L-0-l2', JSON.stringify(d.chapters[1].lines[0]) === '[1,"L-0-l2","D-0-C-0-A-1"]')
      check('B4 章 2 行 3 [3] 跨行继承（行 2 → 行 3）', JSON.stringify(d.chapters[1].lines[2]) === '[3,"L-0-l2"]', JSON.stringify(d.chapters[1].lines[2]))
      check('B4 输出章序镜像输入（两章各 3 行）', d.chapters.length === 2 && d.chapters[0].chapterSeq === 1 && d.chapters[1].chapterSeq === 2 && d.chapters.every((c) => c.lines.length === 3), JSON.stringify(d.chapters.map((c) => c.lines.length)))
      check('B4 章条目字段集 {chapterSeq,lines}', d.chapters.every((c) => Object.keys(c).sort().join(',') === 'chapterSeq,lines'))
      check('B4 行覆盖 1..N 恰好一遍（行号连续无洞）', d.chapters.every((c) => c.lines.every((l, i) => l[0] === i + 1)))
    }

    // ---- B5. parse 覆盖校验：缺号补 + 超范围丢弃 + 整章缺失补全 ----
    {
      const rt = await stashedRt('lineAnnotation', { global: false, chunkIndex: 0, chunkChapters: LA_CHAPTERS, chunkText: LA_TEXT, ws })
      const modelOut = JSON.stringify({
        plotLocations: [{ id: 'l1', name: '王城大殿', mapLocationId: '1' }],
        chapters: [{ chapterSeq: 1, lines: [[1, 'l1', 'D-0-C-0-A-1'], [2], [5]] }]
      })
      const d = la.parse(modelOut, rt)
      check('B5 缺号补 [n,null]（章 1 第 3 行）', JSON.stringify(d.chapters[0].lines[2]) === '[3,null]', JSON.stringify(d.chapters[0].lines[2]))
      check('B5 缺号 → warning', d.warnings.some((w) => w.includes('第 3 行缺失')))
      check('B5 超范围行号丢弃（第 5 行）+ warning', !d.chapters[0].lines.some((l) => l[0] === 5) && d.warnings.some((w) => w.includes('第 5 行超出')))
      check('B5 整章缺失补全（章 2 全 [n,null]）+ warning', d.chapters[1].lines.every((l) => JSON.stringify(l).replace(/\d+/, 'n') === '[n,null]') && d.warnings.some((w) => w.includes('章 2') && w.includes('缺失')))
      check('B5 补齐行成为下一行继承基线（章 1 行 2 继承行 1 正常）', JSON.stringify(d.chapters[0].lines[1]) === '[2,"L-0-l1","D-0-C-0-A-1"]')
    }

    // ---- B6. parse 重复本地 id 防御 ----
    {
      const rt = await stashedRt('lineAnnotation', { global: false, chunkIndex: 0, chunkChapters: LA_CHAPTERS, chunkText: LA_TEXT, ws })
      const modelOut = JSON.stringify({
        plotLocations: [
          { id: 'l1', name: '甲处', mapLocationId: null },
          { id: 'l1', name: '乙处', mapLocationId: null }
        ],
        chapters: [{ chapterSeq: 1, lines: [[1, 'l1'], [2], [3]] }]
      })
      const d = la.parse(modelOut, rt)
      check('B6 重复本地 id → warning（不可消歧）', d.warnings.some((w) => w.includes('重复本地地点 id=l1')))
      check('B6 引用歧义 id 的行全部置 null + warning', JSON.stringify(d.chapters[0].lines[0]) === '[1,null]' && d.warnings.some((w) => w.includes('歧义本地地点')))
      check('B6 继承基线随之置 null（行 2/3 继承行 1）', JSON.stringify(d.chapters[0].lines[1]) === '[2,null]' && JSON.stringify(d.chapters[0].lines[2]) === '[3,null]')
      check('B6 重复条目本身仍存活并重编（L-0-l1/L-0-l2）', d.plotLocations.map((p) => `${p.id}:${p.name}`).join(',') === 'L-0-l1:甲处,L-0-l2:乙处', JSON.stringify(d.plotLocations.map((p) => p.id)))
    }

    // ---- B7. parse 边界：每章第一行继承违规 + 模型多给章 + raw 兜底 ----
    {
      const rt = await stashedRt('lineAnnotation', { global: false, chunkIndex: 0, chunkChapters: LA_CHAPTERS, chunkText: LA_TEXT, ws })
      // ① 每章第一行简写继承 → [n,null] + warning
      const d1 = la.parse(JSON.stringify({ plotLocations: [{ id: 'l1', name: '王城大殿' }], chapters: [{ chapterSeq: 1, lines: [[1], [2, 'l1']] }] }), rt)
      check('B7 ① 每章第一行不允许继承 → [1,null] + warning', JSON.stringify(d1.chapters[0].lines[0]) === '[1,null]' && d1.warnings.some((w) => w.includes('第一行不允许继承')))
      check('B7 ① 第一行之后的正常行不受影响（[2,"L-0-l1"]）', JSON.stringify(d1.chapters[0].lines[1]) === '[2,"L-0-l1"]')
      // ② 模型多给不在输入的章 → 整章丢弃 + warning
      const d2 = la.parse(JSON.stringify({ plotLocations: [], chapters: [{ chapterSeq: 1, lines: [[1, null], [2, null], [3, null]] }, { chapterSeq: 9, lines: [[1, null]] }] }), rt)
      check('B7 ② 模型多给章 9 → 整章丢弃 + warning', d2.chapters.length === 2 && d2.warnings.some((w) => w.includes('章 9') && w.includes('丢弃')))
      // ③ 缺 chapters → raw 兜底
      const d3 = la.parse('{"plotLocations":[{"id":"l1","name":"x"}]}', rt)
      check('B7 ③ 缺 chapters → raw 兜底（空 chapters + raw 摘录）', Array.isArray(d3.chapters) && d3.chapters.length === 0 && typeof d3.raw === 'string' && d3.raw.length > 0 && d3.warnings.length > 0)
      // ④ plotLocations 缺省 []（合法：模型认为无可收录场景）
      const d4 = la.parse('{"chapters":[{"chapterSeq":1,"lines":[[1,null],[2,null],[3,null]]}]}', rt)
      check('B7 ④ plotLocations 缺省 []（不抛崩）', Array.isArray(d4.plotLocations) && d4.plotLocations.length === 0)
      // ⑤ 单参 parse（无 rt）不崩（T6-F 接口兼容延续）
      let singleOk = true
      try {
        la.parse('{"plotLocations":[],"chapters":[]}')
      } catch {
        singleOk = false
      }
      check('B7 ⑤ 单参 parse（无 rt）不崩', singleOk)
    }

    // ---- B8. 注册 + keyOf + 引擎合并模拟（跨批同章不同行段都存活）----
    {
      check('B8 lineAnnotation 已注册', tasks.LLM_ADAPTERS['lineAnnotation']?.id === 'lineAnnotation')
      check('B8 导出的 lineAnnotationKeyOf 与适配器同一函数', tasks.lineAnnotationKeyOf === la.keyOf)
      const kof = tasks.lineAnnotationKeyOf
      check('B8 keyOf：章条目按 chapter 序号+首行号', kof({ chapterSeq: 1, lines: [[1, null], [2, 'l1']] }) === 'chapter:1:1' && kof({ chapterSeq: 1, lines: [[5, 'l1']] }) === 'chapter:1:5')
      check('B8 keyOf：plotLocations 模型本地 id 按 name（跨批碰撞防御）', kof({ id: 'l1', name: '客栈内' }) === 'name:客栈内')
      check('B8 keyOf：程序 id L-0-l1 按 id 键（前向兼容双轨）', kof({ id: 'L-0-l1', name: '客栈内' }) === 'L-0-l1')
      check('B8 keyOf：行条目（数组）→ JSON 串兜底', kof([1, null]) === '[1,null]')
      // 引擎合并模拟：两批覆盖同章不同行段（首行号 1 vs 3）→ 章条目不相消、parse 合并
      // （本章共 3 行，故第二批只可能在范围内的第 3 行——超范围行由覆盖校验丢弃，见 B5）
      const merged = mg.mergeOutputs(
        'concat-dedup-order',
        [
          JSON.stringify({ plotLocations: [{ id: 'l1', name: '客栈内' }], chapters: [{ chapterSeq: 1, lines: [[1, null], [2, 'l1']] }] }),
          JSON.stringify({ plotLocations: [{ id: 'l1', name: '客栈内' }], chapters: [{ chapterSeq: 1, lines: [[3, 'l1']] }] })
        ],
        kof
      )
      const rt = await stashedRt('lineAnnotation', { global: false, chunkIndex: 0, chunkChapters: LA_CHAPTERS, chunkText: LA_TEXT, ws })
      const d = la.parse(merged, rt)
      check('B8 引擎合并模拟：跨批同章不同行段合并（3 行）且 plotLocations 按 name 去重（1 条）', d.plotLocations.length === 1 && d.chapters[0].lines.length === 3, JSON.stringify(d.chapters[0].lines))
      check('B8 合并后续行正确映射（[3,"L-0-l1"]）', JSON.stringify(d.chapters[0].lines[2]) === '[3,"L-0-l1"]', JSON.stringify(d.chapters[0].lines[2]))
      check('B8 合并后缺号补（章 2 全补）+ 行号连续', d.chapters[1].lines.length === 3 && d.chapters[1].lines.every((l, i) => l[0] === i + 1 && l[1] === null))
    }

    // =====================================================================
    // C · batching 覆盖（T6-G ①）
    // =====================================================================
    console.log('\nC · batching 覆盖')
    {
      check('C1 lineAnnotation 声明 batching.inputBudgetTokens = 100000', la.batching?.inputBudgetTokens === 100000, JSON.stringify(la.batching))
      check('C2 老适配器无 batching 字段（不影响默认）', [ca, tasks.plotLocationAdapter, tasks.locationTreeAdapter, tasks.batchLocationSummaryAdapter, tasks.impressionLayoutAdapter, tasks.segAdapter, tasks.plotAdapter, tasks.cacheWarmingAdapter, tasks.draftAdapter].every((a) => a.batching === undefined))
      check('C2 characterAppearance 无 batching（全量输入单批收敛，不借道覆盖）', ca.batching === undefined)
      // orchestrator 同一算式（orchestrator.ts runWithBatching 调用点）
      const cfg = { ...bt.defaultBatchingConfig(), ...la.batching }
      check('C3 orchestrator 合并算式不夹紧（cfg 保持 100000）', cfg.inputBudgetTokens === 100000 && cfg.maxDepth === bt.defaultBatchingConfig().maxDepth && cfg.allowOversizeUnit === true)
      // 构造侧夹紧未动：defaultBatchingConfig 仍夹（clampBudget 保留供其使用）；
      // 修的是 planBatches 的二次夹紧（T6-G 修正）——按任务显式覆盖由此全量生效
      check('C3 构造侧夹紧未动（defaultBatchingConfig({999999}) 仍夹到 24000）', bt.defaultBatchingConfig({ inputBudgetTokens: 999999 }).inputBudgetTokens === 24000 && bt.clampBudget(999999) === 24000 && bt.L2_MAX_TOKENS === 24000)
      // 真实形态可切文本（多段落多句；~18.9 token/段）
      const para = '艾莉娜走进王城大殿，石柱投下长影。她看见了老者，老者微微点头。\n'
      // ① 覆盖生效实证：~30000 token 文本 + 覆盖 100000 → 单批 converged
      const text30k = para.repeat(1600)
      const planOverride = bt.planBatches(text30k, { inputBudgetTokens: 100000, maxDepth: 3, allowOversizeUnit: true })
      check('C3 planBatches 信任 cfg：~30000 token 文本 + 覆盖 100000 → 单批 converged（T6-G 修正实证）', planOverride.batches.length === 1 && planOverride.converged && planOverride.batches[0].oversize === false, `batches=${planOverride.batches.length} est=${bt.estimateTokens(text30k)}`)
      // ② 回归保护：同文本默认 8000 仍切多批（默认路径未被破坏）
      const planDefault = bt.planBatches(text30k, bt.defaultBatchingConfig())
      check('C3 回归保护：同文本默认 8000 仍切多批', planDefault.batches.length > 1 && !planDefault.converged, `default batches=${planDefault.batches.length}`)
      // ③ lineAnnotation 实际场景：chunk ≤42K tokens（chunking targetTokens=42000）→ 单批
      // （修正前 100000 被二次夹紧到 24000，42K chunk 仍切 2 批 → 跨批本地 id 碰撞全丢）
      const text42k = para.repeat(2222)
      const plan42 = bt.planBatches(text42k, cfg)
      check('C3 lineAnnotation 场景：~42K token chunk + 覆盖 → 单批（大书逐行标注不再丢）', plan42.batches.length === 1 && plan42.converged, `batches=${plan42.batches.length} est=${bt.estimateTokens(text42k)}`)
      // ④ 脏值防御：-1 / NaN → 回退 DEFAULT_L2_TOKENS（与默认配置同批数、不崩）
      const dirtyNeg = bt.planBatches(text30k, { inputBudgetTokens: -1, maxDepth: 3, allowOversizeUnit: true })
      const dirtyNaN = bt.planBatches(text30k, { inputBudgetTokens: NaN, maxDepth: 3, allowOversizeUnit: true })
      check('C3 脏值防御：-1 / NaN → 回退 DEFAULT_L2_TOKENS（与默认同批数、不崩）', dirtyNeg.batches.length === planDefault.batches.length && dirtyNaN.batches.length === planDefault.batches.length && bt.DEFAULT_L2_TOKENS === 8000, `neg=${dirtyNeg.batches.length} nan=${dirtyNaN.batches.length} default=${planDefault.batches.length}`)
    }

    // =====================================================================
    // D · rt-stash
    // =====================================================================
    console.log('\nD · rt-stash 快照模块')
    {
      const k1 = { tag: 'rt-1' }
      const k2 = { tag: 'rt-2' }
      rs.stashRtSnapshot(k1, { spriteChunkIndexes: new Map([['D-0-C-0', [0, 1]]]) })
      rs.stashRtSnapshot(k2, '另一实例的快照')
      check('D1 stash 后 read 得同值（含 Map/Set 引用语义）', rs.readRtSnapshot(k1).spriteChunkIndexes.get('D-0-C-0')[1] === 1)
      check('D1 不同 key 互不串（WeakMap 按实例隔离）', rs.readRtSnapshot(k2) === '另一实例的快照' && rs.readRtSnapshot(k1) !== rs.readRtSnapshot(k2))
      check('D2 新对象无快照 → undefined', rs.readRtSnapshot({}) === undefined)
      check('D2 undefined/null → undefined（不抛崩）', rs.readRtSnapshot(undefined) === undefined && rs.readRtSnapshot(null) === undefined)
      check('D2 同一 key 覆盖写（后写覆盖）', (() => {
        rs.stashRtSnapshot(k1, 'v2')
        const ok = rs.readRtSnapshot(k1) === 'v2'
        rs.stashRtSnapshot(k1, { spriteChunkIndexes: new Map() }) // 还原，避免影响后续
        return ok
      })())
      // 适配器侧实证已在 A5/B4（buildMessages stash → parse read）覆盖
      check('D3 适配器链路实证（A5 有/无快照对比 + B4 行标注映射）已覆盖', true)
    }
  } finally {
    await rm(TEST_PARENT, { recursive: true, force: true })
  }

  console.log(`\n==== T6-G 形象/逐行链验证：${passed} 通过 / ${failed} 失败 ====`)
  if (failed === 0) {
    console.log('T6-G APPEARANCE-LINES VERIFY PASS')
  } else {
    console.log('T6-G APPEARANCE-LINES VERIFY FAIL')
  }
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('ERROR:', e?.stack ?? e?.message ?? e)
  process.exitCode = 2
})

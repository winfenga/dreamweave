/**
 * T6-H · 演出链验证脚本（characterRelation + storyScript + plotLocationMerge 三适配器）
 * （node 直跑，**不启动 Electron**；零新增依赖）。
 *
 * 覆盖四组（对应 T6-H spec 验收项）：
 *  A. characterRelation（per-chunk）：造 draftAlign（chunk 1 两角色，别名两种形状）+ plot 产物
 *     → inputText 带行号包装；buildMessages 恰 3 条且 5 变量正确（chunkIndex / 首末章 seq /
 *     阅读记忆只含 chunk 0 / 本片人物名单两人且别名归一）；无 draftAlign 产物 → 名单 `[]` +
 *     warning 不抛；parse 正样本 → chunkIndex 程序补齐、字段集严格、长度契约只 warning 不
 *     截断；章序越界钳制 + warning；A=B 跳过；空数组合法；脏样本 raw 兜底；注册完整；无
 *     keyOf（关系无稳定 id）；模板占位符恰 5 个全覆盖。
 *  B. storyScript（per-chunk，叶真源）：造 characterAppearance / locationTree / plotLocation /
 *     plot 产物 + index.json（storyScriptStyle 三种取值）→ 模板变体选择（coherent / '' /
 *     legacy 回落 + warning，且 legacy 指令与 base 逐字相同）；inputText 带行号包装；
 *     buildMessages 恰 3 条且 7 变量正确（人物含 appearanceId、plotLocations 原样 L-0-l*、
 *     地图树、规则短文、阅读记忆）；缺 characterAppearance / plotLocation / locationTree
 *     各自 → 可读错误；parse 正样本（混合 n/s/t/b/m、`@#2-3#@` 引用、aId 无 cId、m 带
 *     flId/tlId）→ 短字段展开 10 键长字段、type 展开、引用解析为原文行文本、characterId
 *     从 aId 派生、order 重编号 0..n-1、plotLocations 复制、protocol 程序字段；契约违反
 *     （t 非法 / cs 越界 / lId 无效 / s 无主体 / txt 空 / 引用越界保留标记）各不抛崩；
 *     注册完整；两套模板各 7 个占位符全覆盖。
 *  C. plotLocationMerge（global）：造两 chunk 共 5 条 plotLocation（其中 3 条同 mapLocationId
 *     可合并）+ locationTree → inputText 含全量地点；buildMessages 恰 2 条；parse 正样本（一组
 *     3 个 + 2 独立）→ PL 编号按输入序、合并条目字段取自组内输入序首条 + 组 name/
 *     sceneDescription、sourceLocationIds/chunkIndexes 正确、idMap 全覆盖；边界（组 <2 /
 *     未知 id / 同 id 多组先到先得 / 无组全独立）；注册完整；keyOf 语义；模板占位符恰 2 个。
 *  D. batching：storyScript / plotLocationMerge 的 `batching.inputBudgetTokens === 100000`；
 *     characterRelation 无该字段（不借道覆盖）。
 *
 * 姿势与 `scripts/verify-t6g-appearance-lines.mjs` 一致：`createRequire(feather/package.json)`
 * 取项目已装的 esbuild，把入口打成单文件 ESM 写入临时目录后 `pathToFileURL` 动态 import；
 * electron 以最小桩替换（app.getAppPath → 项目根，使 prompt-loader 的 resourcesDir() 定位到
 * `resources/prompts`）。
 *
 * 临时目录**只准碰** `D:/AI/tx/feather-t6h-test/`（跑完 rm -rf 清掉）；
 * 绝不读写真实工作库目录（7 本真实库只读）。
 *
 * 用法：node scripts/verify-t6h-stage-chain.mjs
 */
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(here, '..')
/** 唯一允许触碰的临时父目录（跑完 rm -rf 清掉） */
const TEST_PARENT = 'D:/AI/tx/feather-t6h-test'
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
    maxTokens: 120000,
    global,
    setting: '',
    dependsOn: []
  }
}

// ---------------------------------------------------------------------------
// 临时工作库（字段按真实 ShardRow / ShardEnvelope 形状；7 本真实库只读，绝不触碰）
// ---------------------------------------------------------------------------

const PKG = 'pkg-t6h'
const REV = 'rev-t6h'

/** 一个小工作库：writeShard 写真分片 + 手工维护 index.json 的 shards 登记。 */
function makeWorkspace(root) {
  const idx = {
    indexVersion: 1,
    format: 'txt2world-workspace',
    pkgId: PKG,
    title: 'T6-H 验证书',
    origin: { t2wPath: '', t2wSize: 0, t2wSha256: '', manifestJsonSha256: '', hasOriginHeader: false, projectId: PKG, revisionId: REV, createdAt: '' },
    manifest: { includesSource: true, topLevelKeys: [], extra: {}, recordsKeys: [], containers: {}, containerKeyed: {}, project: {} },
    shards: [],
    assets: [],
    tasks: {},
    integrity: { createdAt: '', lastVerifiedAt: null }
  }
  const flush = () => writeFile(join(root, 'index.json'), JSON.stringify(idx), 'utf8')
  return {
    root,
    /** 写 results 分片并登记 index（file 形如 records/results/<taskId>.json / world/plot-locations.json）。 */
    async writeResults(file, entries) {
      const env = { shard: file.replace(/\.json$/, ''), container: 'results', entries: entries.map((e, i) => ({ seq: i, ...e })) }
      await sh.writeShard(root, file, env)
      const row = idx.shards.find((r) => r.file === file)
      if (row) row.entryCount = entries.length
      else idx.shards.push({ name: file.replace(/\.json$/, ''), file, container: 'results', entryCount: entries.length, sha256: '' })
      await flush()
    },
    /** 设置 manifest.project.storyScriptStyle（storyScript 模板变体选择的唯一依据）。 */
    async setStoryScriptStyle(style) {
      idx.manifest.project = { ...idx.manifest.project, storyScriptStyle: style }
      await flush()
    },
    async reset() {
      await rm(root, { recursive: true, force: true })
      await mkdir(root, { recursive: true })
      idx.shards.length = 0
      idx.manifest.project = {}
      await flush()
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
    root: ws.root,
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

/** draftAlign 产物（chunk 1 两个人；别名故意两种形状：字符串数组 / [{alias,type}]）。 */
const DRAFT_ALIGN_CHUNK1 = {
  characters: [
    { id: 'D-0-C-0', name: '艾莉娜', aliases: ['艾莉'] },
    { id: 'D-0-C-1', name: '菲雅', aliases: [{ alias: '菲', type: '简称' }] }
  ]
}

/** characterAppearance 产物（storyScript 的 characters 输入；lineAnnotation 同族形态）。 */
const CHARACTER_APPEARANCE = {
  'D-0-C-0': [
    { appearanceId: 'D-0-C-0-A-1', name: '日常形象', sex: '女', appearanceSummary: '银发少女持圣剑', visualKeywords: ['银发', '圣剑'], chunkIndexes: [0, 1] },
    { appearanceId: 'D-0-C-0-A-2', name: '战斗形象', sex: '女', appearanceSummary: '银发少女披风加身', visualKeywords: ['披风'], chunkIndexes: [1] }
  ],
  'D-0-C-1': [
    { appearanceId: 'D-0-C-1-A-1', name: '推定老者', sex: '男', appearanceSummary: '灰袍老者', visualKeywords: ['灰袍'], chunkIndexes: [] }
  ]
}

/** locationTree 产物（T6-C 形状；含不可展示节点）。 */
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

/**
 * plotLocation 产物（叶真源 world/plot-locations.json，两 chunk 共 5 条）：
 *  - chunk 0：L-0-l1 / L-0-l2（同 mapLocationId=M-6，可合并）、L-0-l3（mapLocationId=null + ancId）；
 *  - chunk 1：L-1-l1（同 M-6，与 chunk 0 的两条构成 3 条合并组）、L-1-l2（独立）。
 */
const PLOT_LOCATIONS = {
  0: [
    { id: 'L-0-l1', name: '地下室甲间', mapLocationId: 'M-6', identInfos: ['仅限VIP'], summary: '甲摘要', sceneDescription: '甲场景', chunkIndex: 0 },
    { id: 'L-0-l2', name: '地下室乙间', mapLocationId: 'M-6', identInfos: ['铁环'], summary: '乙摘要', sceneDescription: '乙场景', chunkIndex: 0 },
    { id: 'L-0-l3', name: '王座大厅', mapLocationId: null, ancId: 'M-9', identInfos: ['王座'], summary: '丙摘要', sceneDescription: '丙场景', chunkIndex: 0 }
  ],
  1: [
    { id: 'L-1-l1', name: '地下室甲间复现', mapLocationId: 'M-6', identInfos: ['仅限VIP'], summary: '甲二摘要', sceneDescription: '甲二场景', chunkIndex: 1 },
    { id: 'L-1-l2', name: '天台演武场', mapLocationId: 'M-65', identInfos: ['露天'], summary: '丁摘要', sceneDescription: '丁场景', chunkIndex: 1 }
  ]
}

/** plot 产物摘要（阅读记忆来源；chunk 0 读前记忆天然为空）。 */
const PLOT_SUMMARIES = ['第0章：艾莉娜离开王城。', '第1章：艾莉娜在魔法草原遇见菲雅。']

/** characterRelation 被测实例的章节切片（chunk 1 = 第 5、6 章）。 */
const CR_CHAPTERS = [
  { seq: 5, title: '第五章 出发', text: '艾莉娜背起行囊。\n菲雅在门口等她。\n' },
  { seq: 6, title: '第六章 草原', text: '两人同行。\n草原尽头有雾。\n' }
]
const CR_TEXT = CR_CHAPTERS.map((c) => c.text).join('\n')

/** storyScript 被测实例的章节切片（chunk 0 = 第 1 章，5 行——第 5 行为空行）。 */
const SS_CHAPTERS = [
  {
    seq: 1,
    title: '第一章 街道',
    text: '街道上布满巡逻的士兵。\n“看来我来晚了。”\n他心想：得尽快离开这里。\n他挡开守卫的长剑，趁隙退到街角。\n'
  }
]
const SS_TEXT = SS_CHAPTERS.map((c) => c.text).join('\n')
/** 该章原文行（引用解析断言用，与 numberLines 同口径）。 */
const SS_LINES = SS_CHAPTERS[0].text.split('\n')

let tasks
let up
let pl
let sh

/** 灌上游产物（可逐项缺省，用于「缺产物 → 可读错误」断言）。 */
async function fillWorkspace(ws, {
  withDraftAlign = true,
  withAppearance = true,
  withLocationTree = true,
  withPlotLocations = true,
  withPlot = true,
  style = 'coherent'
} = {}) {
  await ws.reset()
  if (withDraftAlign) {
    await ws.writeResults('records/results/draftAlign.json', [
      { key: `${PKG}:${REV}:draftAlign:1`, value: localEnvelope(DRAFT_ALIGN_CHUNK1) }
    ])
  }
  if (withAppearance) {
    await ws.writeResults('records/results/characterAppearance.json', [
      { key: `${PKG}:${REV}:characterAppearance`, value: llmEnvelope(CHARACTER_APPEARANCE) }
    ])
  }
  if (withLocationTree) {
    await ws.writeResults('records/results/locationTree.json', [{ key: `${PKG}:${REV}:locationTree`, value: llmEnvelope(LOCATION_TREE) }])
  }
  if (withPlotLocations) {
    await ws.writeResults(
      'world/plot-locations.json',
      Object.entries(PLOT_LOCATIONS).map(([chunk, list]) => ({
        key: `${PKG}:${REV}:plotLocation:${chunk}`,
        value: llmEnvelope({ protocol: 'map-plot-v1', actions: [], plotLocations: list, warnings: [] })
      }))
    )
  }
  if (withPlot) {
    await ws.writeResults(
      'records/results/plot.json',
      PLOT_SUMMARIES.map((s, i) => ({ key: `${PKG}:${REV}:plot:${i}`, value: llmEnvelope({ chunkSummary: s, chapters: [] }) }))
    )
  }
  await ws.setStoryScriptStyle(style)
}

/** 建 rt 并先跑一次 buildMessages（挂快照）——parse 测试的标准前置。 */
async function stashedRt(adapterName, opts) {
  const rt = makeRt(adapterName, opts)
  await tasks[`${adapterName}Adapter`].buildMessages('（批文本占位，不应被拆用）', rt)
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

  const ws = makeWorkspace(join(TEST_PARENT, 'ws'))

  try {
    // =====================================================================
    // A · characterRelation
    // =====================================================================
    console.log('A · characterRelation 适配器')
    const cr = tasks.characterRelationAdapter
    await fillWorkspace(ws)

    const crOpts = { global: false, chunkIndex: 1, chunkChapters: CR_CHAPTERS, chunkText: CR_TEXT, ws }

    // ---- A1. inputText：带行号包装（与 plotLocation/lineAnnotation 逐字同构）----
    {
      const rt = makeRt('characterRelation', crOpts)
      const input = await cr.inputText(rt)
      check('A1 inputText 含章节包装（两章各从 1 编号）', input.includes('【原文行：1-3】') && input.split('【原文行：1-3】').length === 3, input.slice(0, 80))
      check('A1 inputText 行号从 1 重新编号（各章独立）', input.includes('1 艾莉娜背起行囊。') && input.includes('1 两人同行。'))
      check('A1 inputText 不含模板变量渲染（纯原文）', !input.includes('{{{'))
    }

    // ---- A2. buildMessages：恰 3 条 + 5 变量内容正确 ----
    {
      const renderLog = []
      const rt = makeRt('characterRelation', { ...crOpts, renderLog })
      const input = await cr.inputText(rt)
      const msgs = await cr.buildMessages(input, rt)
      check('A2 buildMessages 恰 3 条（system + user 原文 + user 指令）', msgs.length === 3 && msgs[0].role === 'system' && msgs[1].role === 'user' && msgs[2].role === 'user', JSON.stringify(msgs.map((m) => m.role)))
      check('A2 第 2 条 = 带行号原文单独喂（与 inputText 逐字一致）', msgs[1].content === input)
      check('A2 三条消息均无 {{ 残留', msgs.every((m) => !m.content.includes('{{')))
      const entry = renderLog.find((r) => r.name === 'character_relation_extract_user_prompt')
      const v = entry?.vars ?? {}
      check('A2 chunkIndex = rt.chunkIndex（1）', v.chunkIndex === 1, String(v.chunkIndex))
      check('A2 startChapterSeq / endChapterSeq = 本 chunk 首末章（5 / 6）', v.startChapterSeq === 5 && v.endChapterSeq === 6, `${v.startChapterSeq}/${v.endChapterSeq}`)
      check('A2 chunkReadingMemory 只含 chunk 0（chunk 1 读前记忆）', v.chunkReadingMemory === '{"recentMemory":["第0章：艾莉娜离开王城。"],"midMemory":[],"longTermMemory":[]}', String(v.chunkReadingMemory))
      const persons = JSON.parse(String(v.chunkCharacterWorldObjList))
      check('A2 chunkCharacterWorldObjList 取本片（draftAlign:1）两人', Array.isArray(persons) && persons.length === 2 && persons[0].id === 'D-0-C-0' && persons[1].id === 'D-0-C-1', String(v.chunkCharacterWorldObjList).slice(0, 160))
      check('A2 每人字段集严格 {id,name,aliases}', persons.every((p) => Object.keys(p).sort().join(',') === 'aliases,id,name'))
      check('A2 aliases 两代形状归一提字符串数组', JSON.stringify(persons[0].aliases) === '["艾莉"]' && JSON.stringify(persons[1].aliases) === '["菲"]', JSON.stringify(persons.map((p) => p.aliases)))
      const tplVars = extractTemplateVars(await readFile(join(FEATHER, 'resources', 'prompts', 'character_relation_extract_user_prompt.txt'), 'utf8'))
      check('A2 模板占位符恰为 5 个且全覆盖无多余键', tplVars.sort().join(',') === 'chunkCharacterWorldObjList,chunkIndex,chunkReadingMemory,endChapterSeq,startChapterSeq' && Object.keys(v).sort().join(',') === tplVars.sort().join(','), `${tplVars.join(',')} | ${Object.keys(v).join(',')}`)
      check('A2 指令含人物名单与章节范围（渲染落位）', msgs[2].content.includes('D-0-C-0') && msgs[2].content.includes('第5章') && msgs[2].content.includes('第6章'))
    }

    // ---- A3. 无 draftAlign 产物 → 名单 '[]' + warning 不抛 ----
    {
      const ws2 = makeWorkspace(join(TEST_PARENT, 'ws-nodraft'))
      await fillWorkspace(ws2, { withDraftAlign: false })
      const rt = makeRt('characterRelation', { global: false, chunkIndex: 1, chunkChapters: CR_CHAPTERS, chunkText: CR_TEXT, ws: ws2 })
      const input = await cr.inputText(rt)
      const msgs = await cr.buildMessages(input, rt)
      const entry = rt.warnings.find((w) => w.includes('无 draftAlign 产物'))
      check('A3 无 draftAlign 产物 → 不抛，名单传 []', msgs.length === 3 && !!entry, JSON.stringify(rt.warnings))
      check('A3 无产物 warning 点名 chunk 1', !!entry && entry.includes('chunk 1'), String(entry))
    }

    // ---- A4. parse 正样本：chunkIndex 程序补齐 + 字段集严格 ----
    {
      const rt = makeRt('characterRelation', crOpts)
      const modelOut = JSON.stringify({
        characterRelations: [
          {
            fromChapterSeq: 5,
            toChapterSeq: 6,
            characterA: { name: '艾莉娜', relationToOther: { overview: '依赖的伙伴', summary: '信赖菲雅的指引。' } },
            characterB: { name: '菲雅', relationToOther: { overview: '看重的后辈', summary: '愿意带她穿越草原。' } },
            relationSummary: '两人结伴离开王城前往魔法草原。'
          }
        ]
      })
      const d = cr.parse(modelOut, rt)
      check('A4 输出 {characterRelations, warnings} 且 1 条', Array.isArray(d.characterRelations) && d.characterRelations.length === 1 && Array.isArray(d.warnings))
      const r = d.characterRelations[0]
      check('A4 条目字段集严格 6 键（含程序补的 chunkIndex）', Object.keys(r).sort().join(',') === 'characterA,characterB,chunkIndex,fromChapterSeq,relationSummary,toChapterSeq', JSON.stringify(Object.keys(r)))
      check('A4 chunkIndex = rt.chunkIndex（1，模型不产此字段）', r.chunkIndex === 1, String(r.chunkIndex))
      check('A4 chapterA/B 结构 {name, relationToOther:{overview,summary}}', Object.keys(r.characterA).sort().join(',') === 'name,relationToOther' && Object.keys(r.characterA.relationToOther).sort().join(',') === 'overview,summary')
      check('A4 章范围与正文原样保留', r.fromChapterSeq === 5 && r.toChapterSeq === 6 && r.relationSummary === '两人结伴离开王城前往魔法草原。')
      check('A4 正样本无 warning（长度契约内不误报）', d.warnings.length === 0, JSON.stringify(d.warnings))
    }

    // ---- A5. 章序越界 → 钳制 + warning（不是跳过）----
    {
      const rt = makeRt('characterRelation', crOpts)
      const modelOut = JSON.stringify({
        characterRelations: [
          {
            fromChapterSeq: 2,
            toChapterSeq: 9,
            characterA: { name: '艾莉娜', relationToOther: { overview: '甲', summary: '乙' } },
            characterB: { name: '菲雅', relationToOther: { overview: '丙', summary: '丁' } },
            relationSummary: '越界样本'
          }
        ]
      })
      const d = cr.parse(modelOut, rt)
      check('A5 越界章序被钳到 5..6（条目保留，不是跳过）', d.characterRelations.length === 1 && d.characterRelations[0].fromChapterSeq === 5 && d.characterRelations[0].toChapterSeq === 6, JSON.stringify(d.characterRelations[0] ?? {}))
      check('A5 钳制各留一条 warning', d.warnings.filter((w) => w.includes('钳到')).length === 2, JSON.stringify(d.warnings))
      // 非整数 → 回退端点 + warning
      const d2 = cr.parse(JSON.stringify({ characterRelations: [{ fromChapterSeq: 'x', toChapterSeq: null, characterA: { name: 'A', relationToOther: {} }, characterB: { name: 'B', relationToOther: {} }, relationSummary: '' }] }), rt)
      check('A5 非整数章序回退端点（5 / 6）+ warning', d2.characterRelations[0].fromChapterSeq === 5 && d2.characterRelations[0].toChapterSeq === 6 && d2.warnings.some((w) => w.includes('非有限整数')), JSON.stringify(d2.warnings.slice(0, 2)))
    }

    // ---- A6. A=B 跳过 / 结构不整跳过 / 长度契约只 warning ----
    {
      const rt = makeRt('characterRelation', crOpts)
      const dSelf = cr.parse(JSON.stringify({
        characterRelations: [{ fromChapterSeq: 5, toChapterSeq: 5, characterA: { name: '艾莉娜', relationToOther: { overview: '', summary: '' } }, characterB: { name: '艾莉娜', relationToOther: { overview: '', summary: '' } }, relationSummary: '' }]
      }), rt)
      check('A6 A=B 同名 → 跳过 + warning', dSelf.characterRelations.length === 0 && dSelf.warnings.some((w) => w.includes('自己与自己')), JSON.stringify(dSelf.warnings))
      const dBad = cr.parse(JSON.stringify({
        characterRelations: [{ fromChapterSeq: 5, toChapterSeq: 5, characterA: { name: '艾莉娜' }, characterB: { name: '菲雅', relationToOther: { overview: '', summary: '' } } }]
      }), rt)
      check('A6 characterA 缺 relationToOther → 跳过 + warning', dBad.characterRelations.length === 0 && dBad.warnings.some((w) => w.includes('characterA 结构不完整')), JSON.stringify(dBad.warnings))
      const longOverview = '一二三四五六七八九十甲'
      const dLong = cr.parse(JSON.stringify({
        characterRelations: [{ fromChapterSeq: 5, toChapterSeq: 5, characterA: { name: '艾莉娜', relationToOther: { overview: longOverview, summary: '' } }, characterB: { name: '菲雅', relationToOther: { overview: '', summary: '' } }, relationSummary: 'x'.repeat(301) }]
      }), rt)
      check('A6 长度契约只 warning 不截断（overview 11 字原样保留）', dLong.characterRelations.length === 1 && dLong.characterRelations[0].characterA.relationToOther.overview === longOverview, dLong.characterRelations[0]?.characterA?.relationToOther?.overview)
      check('A6 超长 relationSummary 保留原文 + warning', dLong.characterRelations[0].relationSummary.length === 301 && dLong.warnings.some((w) => w.includes('超 300 字')), JSON.stringify(dLong.warnings))
    }

    // ---- A7. 空数组合法 / 脏样本 raw 兜底 / 单参 parse ----
    {
      const rt = makeRt('characterRelation', crOpts)
      const dEmpty = cr.parse('{"characterRelations":[]}', rt)
      check('A7 空数组是合法输出（无 warning）', Array.isArray(dEmpty.characterRelations) && dEmpty.characterRelations.length === 0 && dEmpty.warnings.length === 0)
      const dDirty = cr.parse('总之我觉得他们关系不错', rt)
      check('A7 脏样本 → raw 兜底（不抛崩）', Array.isArray(dDirty.characterRelations) && dDirty.characterRelations.length === 0 && typeof dDirty.raw === 'string' && dDirty.warnings.length > 0)
      let singleOk = true
      try {
        cr.parse('{"characterRelations":[]}')
      } catch {
        singleOk = false
      }
      check('A7 单参 parse（无 rt）不崩', singleOk)
    }

    // ---- A8. 注册 + 无 keyOf ----
    {
      check('A8 characterRelation 已注册', tasks.LLM_ADAPTERS['characterRelation']?.id === 'characterRelation')
      check('A8 不提供 keyOf（关系无稳定 id，复合键会误塌同对人物多条合法记录）', cr.keyOf === undefined)
      check('A8 合并策略 concat-dedup-order', cr.mergeStrategy === 'concat-dedup-order')
    }

    // =====================================================================
    // B · storyScript
    // =====================================================================
    console.log('\nB · storyScript 适配器')
    const ss = tasks.storyScriptAdapter
    await fillWorkspace(ws, { style: 'coherent' })

    const ssOpts = { global: false, chunkIndex: 0, chunkChapters: SS_CHAPTERS, chunkText: SS_TEXT, ws }

    // ---- B1. inputText ----
    {
      const rt = makeRt('storyScript', ssOpts)
      const input = await ss.inputText(rt)
      check('B1 inputText 含章节包装（1-5，含末尾空行）', input.includes('【原文行：1-5】'), input.slice(0, 40))
      check('B1 inputText 行号从 1 编号', input.includes('1 街道上布满巡逻的士兵。'))
      check('B1 inputText 纯原文（不含模板变量）', !input.includes('{{'))
    }

    // ---- B2. 模板变体选择：coherent / '' / legacy ----
    {
      const readTpl = (n) => readFile(join(FEATHER, 'resources', 'prompts', `${n}.txt`), 'utf8')
      const coherentTpl = await readTpl('story_script_coherent_user_prompt')
      const baseTpl = await readTpl('story_script_user_prompt')
      // 两套模板的判别句（逐字取自模板正文，coherent 只允许性相关剧情用行引用）
      const coherentOnly = '只有性相关剧情的 action 可以使用原文行引用'
      const baseOnly = 'say、think 或性相关剧情的 action 可以使用原文行引用'
      check('B2 判别句确在两套模板中互斥出现', coherentTpl.includes(coherentOnly) && !coherentTpl.includes(baseOnly) && baseTpl.includes(baseOnly) && !baseTpl.includes(coherentOnly))

      // ① coherent
      await ws.setStoryScriptStyle('coherent')
      const logCoherent = []
      const rt1 = makeRt('storyScript', { ...ssOpts, renderLog: logCoherent })
      const in1 = await ss.inputText(rt1)
      const m1 = await ss.buildMessages(in1, rt1)
      const e1 = logCoherent.find((r) => r.name.startsWith('story_script'))
      check('B2 ① style=coherent → 渲染 story_script_coherent_user_prompt', e1?.name === 'story_script_coherent_user_prompt', String(e1?.name))
      check('B2 ① 指令为 coherent 变体（含判别句）', m1[2].content.includes(coherentOnly))
      check('B2 ① coherent 不产生 legacy warning', !rt1.warnings.some((w) => w.includes('legacy')), JSON.stringify(rt1.warnings))

      // ② ''（txt 书）→ base
      await ws.setStoryScriptStyle('')
      const logBase = []
      const rt2 = makeRt('storyScript', { ...ssOpts, renderLog: logBase })
      const in2 = await ss.inputText(rt2)
      const m2 = await ss.buildMessages(in2, rt2)
      const e2 = logBase.find((r) => r.name.startsWith('story_script'))
      check('B2 ② style=""（txt 书）→ base 模板', e2?.name === 'story_script_user_prompt' && m2[2].content.includes(baseOnly), String(e2?.name))

      // ③ legacy → base + warning
      await ws.setStoryScriptStyle('legacy')
      const logLegacy = []
      const rt3 = makeRt('storyScript', { ...ssOpts, renderLog: logLegacy })
      const in3 = await ss.inputText(rt3)
      const m3 = await ss.buildMessages(in3, rt3)
      const e3 = logLegacy.find((r) => r.name.startsWith('story_script'))
      check('B2 ③ style=legacy → 回落 base 模板 + warning', e3?.name === 'story_script_user_prompt' && rt3.warnings.some((w) => w.includes('legacy')), `${String(e3?.name)} | ${JSON.stringify(rt3.warnings)}`)
      check('B2 ③ legacy 回落后的指令与 base 逐字相同', m3[2].content === m2[2].content)
      // ④ coherent-legacy 同 legacy
      await ws.setStoryScriptStyle('coherent-legacy')
      const rt4 = makeRt('storyScript', ssOpts)
      const in4 = await ss.inputText(rt4)
      await ss.buildMessages(in4, rt4)
      check('B2 ④ style=coherent-legacy 同样回落 base + warning', rt4.warnings.some((w) => w.includes('legacy')))
      // ⑤ 读 index 失败（未挂 root）→ base + warning，不抛
      const rt5 = makeRt('storyScript', ssOpts)
      delete rt5.root
      const in5 = await ss.inputText(rt5)
      const m5 = await ss.buildMessages(in5, rt5)
      check('B2 ⑤ 未挂 rt.root → base + warning 不抛', m5.length === 3 && m5[2].content.includes(baseOnly) && rt5.warnings.some((w) => w.includes('rt.root')), JSON.stringify(rt5.warnings))
      await ws.setStoryScriptStyle('coherent')
    }

    // ---- B3. buildMessages：7 变量内容正确（coherent 场景）----
    {
      const renderLog = []
      const rt = makeRt('storyScript', { ...ssOpts, renderLog })
      const input = await ss.inputText(rt)
      const msgs = await ss.buildMessages(input, rt)
      check('B3 buildMessages 恰 3 条（system + user 原文 + user 指令）', msgs.length === 3 && msgs[1].content === input && msgs.every((m) => !m.content.includes('{{')), JSON.stringify(msgs.map((m) => m.role)))
      const v = renderLog.find((r) => r.name === 'story_script_coherent_user_prompt')?.vars ?? {}
      check('B3 chunkIndex / chapterSeqs 正确', v.chunkIndex === 0 && v.chapterSeqs === '1', `${v.chunkIndex}/${v.chapterSeqs}`)
      check('B3 chunkReadingMemory chunk 0 为空（合法）', v.chunkReadingMemory === '{"recentMemory":[],"midMemory":[],"longTermMemory":[]}', String(v.chunkReadingMemory))
      const chars = JSON.parse(String(v.characters))
      check('B3 characters 来自 characterAppearance（每人 id + appearances 含 appearanceId）', chars.length === 2 && chars[0].id === 'D-0-C-0' && chars[0].appearances[0].appearanceId === 'D-0-C-0-A-1', String(v.characters).slice(0, 160))
      check('B3 appearances 字段集 {appearanceId,name,sex,appearanceSummary,visualKeywords}', chars[0].appearances.every((a) => Object.keys(a).sort().join(',') === 'appearanceId,appearanceSummary,name,sex,visualKeywords'))
      check('B3 人物 name/aliases 为空（产物按 charId 索引形象、不含姓名，appearanceId 才是引用键）', chars.every((c) => c.name === '' && Array.isArray(c.aliases) && c.aliases.length === 0))
      const pls = JSON.parse(String(v.plotLocations))
      check('B3 plotLocations 只取本 chunk（chunk 0 三条，L-0-l* 原样）', pls.length === 3 && pls.map((p) => p.id).join(',') === 'L-0-l1,L-0-l2,L-0-l3', String(v.plotLocations).slice(0, 120))
      check('B3 plotLocations 不含其他 chunk（无 L-1-*）', !String(v.plotLocations).includes('L-1-'))
      check('B3 mapLocationTree 为完整树（含合成根与不可展示节点）', String(v.mapLocationTree).includes('novel-world') && String(v.mapLocationTree).includes('百合酒吧'))
      check('B3 plotLocationRules 规则短文含 lId / flId / novel-world 要点', String(v.plotLocationRules).includes('lId') && String(v.plotLocationRules).includes('flId') && String(v.plotLocationRules).includes('novel-world'), String(v.plotLocationRules).slice(0, 80))
      const tplVars = extractTemplateVars(await readFile(join(FEATHER, 'resources', 'prompts', 'story_script_coherent_user_prompt.txt'), 'utf8'))
      check('B3 coherent 模板占位符恰 7 个且全覆盖无多余键', tplVars.sort().join(',') === 'chapterSeqs,characters,chunkIndex,chunkReadingMemory,mapLocationTree,plotLocationRules,plotLocations' && Object.keys(v).sort().join(',') === tplVars.sort().join(','), `${tplVars.join(',')} | ${Object.keys(v).join(',')}`)
      const baseVars = extractTemplateVars(await readFile(join(FEATHER, 'resources', 'prompts', 'story_script_user_prompt.txt'), 'utf8'))
      check('B3 base 模板占位符同 7 个（两套模板一致）', baseVars.sort().join(',') === tplVars.sort().join(','))
    }

    // ---- B4. 缺上游产物 → 可读错误（断言文案含任务名）----
    {
      const wsNoApp = makeWorkspace(join(TEST_PARENT, 'ws-noapp'))
      await fillWorkspace(wsNoApp, { withAppearance: false })
      const rtApp = makeRt('storyScript', { global: false, chunkIndex: 0, chunkChapters: SS_CHAPTERS, chunkText: SS_TEXT, ws: wsNoApp })
      let e1 = ''
      try {
        await ss.buildMessages(await ss.inputText(rtApp), rtApp)
      } catch (e) {
        e1 = e.message
      }
      check('B4 缺 characterAppearance → 可读错误（含任务名）', /storyScript 需要 characterAppearance 产物/.test(e1), e1)

      const wsNoPl = makeWorkspace(join(TEST_PARENT, 'ws-nopl'))
      await fillWorkspace(wsNoPl, { withPlotLocations: false })
      const rtPl = makeRt('storyScript', { global: false, chunkIndex: 0, chunkChapters: SS_CHAPTERS, chunkText: SS_TEXT, ws: wsNoPl })
      let e2 = ''
      try {
        await ss.buildMessages(await ss.inputText(rtPl), rtPl)
      } catch (e) {
        e2 = e.message
      }
      check('B4 缺 plotLocation → 可读错误（点名 chunk 与任务名）', /storyScript 需要 plotLocation 产物/.test(e2) && e2.includes('chunk 0'), e2)

      const wsNoTree = makeWorkspace(join(TEST_PARENT, 'ws-notree'))
      await fillWorkspace(wsNoTree, { withLocationTree: false })
      const rtTree = makeRt('storyScript', { global: false, chunkIndex: 0, chunkChapters: SS_CHAPTERS, chunkText: SS_TEXT, ws: wsNoTree })
      let e3 = ''
      try {
        await ss.buildMessages(await ss.inputText(rtTree), rtTree)
      } catch (e) {
        e3 = e.message
      }
      check('B4 缺 locationTree → 可读错误（含任务名）', /storyScript 需要 locationTree 产物/.test(e3), e3)
      check('B4 inputText 不依赖上游（纯原文，不抛）', (await ss.inputText(rtTree)).includes('【原文行：1-5】'))
    }

    // ---- B5. parse 正样本：短字段 → 10 键长字段 + 引用解析 + order 重编号 ----
    let ssParseRt
    {
      await fillWorkspace(ws, { style: 'coherent' })
      ssParseRt = await stashedRt('storyScript', ssOpts)
      const modelOut = JSON.stringify({
        actions: [
          { cs: 1, o: 1, t: 'n', lId: 'L-0-l1', txt: '街道上布满巡逻的士兵。' },
          { cs: 1, o: 0, t: 's', aId: 'D-0-C-0-A-1', lId: 'L-0-l1', txt: '看来我来晚了。' },
          { cs: 1, o: 2, t: 't', cId: 'D-0-C-1', lId: 'L-0-l2', txt: '@#2-3#@' },
          { cs: 1, o: 3, t: 'b', aId: 'D-0-C-0-A-1', tIds: ['D-0-C-1', 'D-9-C-9'], lId: 'L-0-l1', txt: '他挡开守卫的长剑。' },
          { cs: 1, o: 4, t: 'm', cId: 'D-0-C-0', flId: 'L-0-l1', tlId: 'L-1-l1', txt: '他离开街道，走向城门。' }
        ]
      })
      const d = ss.parse(modelOut, ssParseRt)
      check('B5 输出 protocol 为程序字段 map-plot-v1', d.protocol === 'map-plot-v1')
      check('B5 actions 5 条且按 order 升序归位（o=0 的 say 在首位）', d.actions.length === 5 && d.actions[0].type === 'say' && d.actions[1].type === 'narration', JSON.stringify(d.actions.map((a) => `${a.order}:${a.type}`)))
      check('B5 order 重编号 0..n-1', d.actions.map((a) => a.order).join(',') === '0,1,2,3,4', d.actions.map((a) => a.order).join(','))
      check('B5 每条严格 10 键长字段', d.actions.every((a) => Object.keys(a).sort().join(',') === 'appearanceId,chapterSeq,characterId,fromLocationId,locationId,order,targetIds,text,toLocationId,type'), JSON.stringify(Object.keys(d.actions[0])))
      check('B5 type 展开（say/narration/think/battle/move）', d.actions.map((a) => a.type).join(',') === 'say,narration,think,battle,move', d.actions.map((a) => a.type).join(','))
      check('B5 引用 @#2-3#@ 解析为原文第 2、3 行', d.actions[2].text === `${SS_LINES[1]}\n${SS_LINES[2]}`, JSON.stringify(d.actions[2].text))
      check('B5 characterId 由 aId 派生（D-0-C-0-A-1 → D-0-C-0）', d.actions[0].characterId === 'D-0-C-0' && d.actions[0].appearanceId === 'D-0-C-0-A-1')
      check('B5 cId 优先（think 用 cId 且无 appearanceId）', d.actions[2].characterId === 'D-0-C-1' && d.actions[2].appearanceId === '')
      check('B5 battle 的 targetIds 过滤未知人物（只留 D-0-C-1）', JSON.stringify(d.actions[3].targetIds) === '["D-0-C-1"]', JSON.stringify(d.actions[3].targetIds))
      check('B5 targetIds 未知人物 → warning', d.warnings.some((w) => w.includes('D-9-C-9')), JSON.stringify(d.warnings))
      check('B5 m 不输出 locationId（恒空串）+ flId 保留 + 跨 chunk tlId 省略为 ""', d.actions[4].locationId === '' && d.actions[4].fromLocationId === 'L-0-l1' && d.actions[4].toLocationId === '', JSON.stringify(d.actions[4]))
      check('B5 tlId 越本 chunk 目录 → warning', d.warnings.some((w) => w.includes('tlId=L-1-l1')), JSON.stringify(d.warnings))
      check('B5 n/s/t/b 的 locationId 原样（L-0-l1 / L-0-l2）', d.actions[0].locationId === 'L-0-l1' && d.actions[2].locationId === 'L-0-l2')
      check('B5 plotLocations 从快照原样复制（= plotLocation 产物）', JSON.stringify(d.plotLocations) === JSON.stringify(PLOT_LOCATIONS[0]), JSON.stringify(d.plotLocations).slice(0, 120))
      check('B5 空值占位为 "" / []（不省略键）', d.actions[1].appearanceId === '' && d.actions[1].fromLocationId === '' && JSON.stringify(d.actions[1].targetIds) === '[]')
    }

    // ---- B6. 契约违反：各不抛崩 ----
    {
      const parse = (actions) => ss.parse(JSON.stringify({ actions }), ssParseRt)
      const ok = (fn) => {
        try {
          return fn()
        } catch (e) {
          return { __err: e.message }
        }
      }
      const dBadT = ok(() => parse([{ cs: 1, o: 0, t: 'x', lId: 'L-0-l1', txt: '正文' }]))
      check('B6 t 非法 → 跳过 + warning（不抛崩）', !dBadT.__err && dBadT.actions.length === 0 && dBadT.warnings.some((w) => w.includes('行动类型非法')), JSON.stringify(dBadT.warnings ?? dBadT))
      const dBadCs = ok(() => parse([{ cs: 9, o: 0, t: 'n', lId: 'L-0-l1', txt: '正文' }]))
      check('B6 cs 越界 → 跳过 + warning', !dBadCs.__err && dBadCs.actions.length === 0 && dBadCs.warnings.some((w) => w.includes('章序号越界')))
      const dBadLid = ok(() => parse([{ cs: 1, o: 0, t: 'n', lId: 'L-9-l9', txt: '正文' }]))
      check('B6 lId 无效 → 跳过 + warning', !dBadLid.__err && dBadLid.actions.length === 0 && dBadLid.warnings.some((w) => w.includes('lId=L-9-l9')))
      const dNoSubject = ok(() => parse([{ cs: 1, o: 0, t: 's', lId: 'L-0-l1', txt: '正文' }]))
      check('B6 s 无主体 → 跳过 + warning', !dNoSubject.__err && dNoSubject.actions.length === 0 && dNoSubject.warnings.some((w) => w.includes('无主体')))
      const dEmptyTxt = ok(() => parse([{ cs: 1, o: 0, t: 'n', lId: 'L-0-l1', txt: '   ' }]))
      check('B6 空正文 → 跳过 + warning', !dEmptyTxt.__err && dEmptyTxt.actions.length === 0 && dEmptyTxt.warnings.some((w) => w.includes('空正文')))
      const dRefOOR = ok(() => parse([{ cs: 1, o: 0, t: 'n', lId: 'L-0-l1', txt: '@#99#@' }]))
      check('B6 引用越界 → 保留原标记串 + warning（不猜）', !dRefOOR.__err && dRefOOR.actions.length === 1 && dRefOOR.actions[0].text === '@#99#@' && dRefOOR.warnings.some((w) => w.includes('越出本章')), JSON.stringify(dRefOOR.actions?.[0]).slice(0, 120))
      const dRefMulti = ok(() => parse([{ cs: 1, o: 0, t: 'n', lId: 'L-0-l1', txt: '@#1 3-4#@' }]))
      check('B6 引用列表/区间混合解析（@#1 3-4#@）', !dRefMulti.__err && dRefMulti.actions[0].text === `${SS_LINES[0]}\n${SS_LINES[2]}\n${SS_LINES[3]}`, JSON.stringify(dRefMulti.actions?.[0]?.text))
      const dOrder = ok(() => parse([{ cs: 1, o: 0, t: 'n', lId: 'L-0-l1', txt: '甲' }, { cs: 1, o: 0, t: 'n', lId: 'L-0-l1', txt: '乙' }, { cs: 1, o: 5, t: 'n', lId: 'L-0-l1', txt: '丙' }]))
      check('B6 o 有洞/重复 → 重编号 0..n-1 + warning', !dOrder.__err && dOrder.actions.map((a) => a.order).join(',') === '0,1,2' && dOrder.warnings.some((w) => w.includes('order 需重编号')), JSON.stringify(dOrder.warnings))
      const dNoActions = ok(() => ss.parse('{"foo":1}', ssParseRt))
      check('B6 缺 actions → raw 兜底（actions [] / plotLocations [] / protocol 程序字段）', !dNoActions.__err && Array.isArray(dNoActions.actions) && dNoActions.actions.length === 0 && dNoActions.protocol === 'map-plot-v1' && typeof dNoActions.raw === 'string')
      // 无快照（未跑 buildMessages）→ 不校验地点/形象归属，但不抛崩
      const rtNoSnap = makeRt('storyScript', ssOpts)
      const dNoSnap = ok(() => ss.parse(JSON.stringify({ actions: [{ cs: 1, o: 0, t: 'n', lId: 'L-0-l1', txt: '@#1#@' }] }), rtNoSnap))
      check('B6 无快照 → 引用标记保留 + warning，不抛崩', !dNoSnap.__err && dNoSnap.actions.length === 1 && dNoSnap.actions[0].text === '@#1#@' && dNoSnap.warnings.some((w) => w.includes('无原文行表')))
    }

    // ---- B7. 注册 + keyOf + 引擎合并语义（keyOf 双轨）----
    {
      check('B7 storyScript 已注册', tasks.LLM_ADAPTERS['storyScript']?.id === 'storyScript')
      check('B7 导出的 storyScriptKeyOf 与适配器同一函数', tasks.storyScriptKeyOf === ss.keyOf)
      const kof = tasks.storyScriptKeyOf
      check('B7 keyOf：plotLocations 程序 id 按 id', kof({ id: 'L-0-l1', name: '地下室' }) === 'L-0-l1')
      check('B7 keyOf：无程序 id 的地点按 name（跨批本地 id 碰撞防御）', kof({ id: 'l1', name: '地下室' }) === 'name:地下室')
      const actionKey = kof({ cs: 1, o: 0, t: 'n', lId: 'L-0-l1', txt: '正文' })
      check('B7 keyOf：actions 无 id → JSON 串兜底', actionKey === JSON.stringify({ cs: 1, o: 0, t: 'n', lId: 'L-0-l1', txt: '正文' }))
    }

    // =====================================================================
    // C · plotLocationMerge
    // =====================================================================
    console.log('\nC · plotLocationMerge 适配器')
    const pm = tasks.plotLocationMergeAdapter
    await fillWorkspace(ws, { style: 'coherent' })

    const pmOpts = { global: true, chunkIndex: null, ws }

    // ---- C1. inputText：全量地点（跨 chunk）+ 地图 ----
    {
      const rt = makeRt('plotLocationMerge', pmOpts)
      const input = await pm.inputText(rt)
      const list = JSON.parse(input)
      check('C1 inputText 含全部 5 条剧情地点（两 chunk，保序）', list.length === 5 && list.map((p) => p.id).join(',') === 'L-0-l1,L-0-l2,L-0-l3,L-1-l1,L-1-l2', list.map((p) => p.id).join(','))
      check('C1 每条带 chunkIndex（条目自有字段优先）', list.map((p) => p.chunkIndex).join(',') === '0,0,0,1,1', list.map((p) => p.chunkIndex).join(','))
    }

    // ---- C2. buildMessages：恰 2 条 + 2 变量 ----
    {
      const renderLog = []
      const rt = makeRt('plotLocationMerge', { ...pmOpts, renderLog })
      const msgs = await pm.buildMessages('（批文本占位）', rt)
      check('C2 buildMessages 恰 2 条（system + user 指令；变量全嵌指令）', msgs.length === 2 && msgs[0].role === 'system' && msgs[1].role === 'user' && msgs.every((m) => !m.content.includes('{{')), JSON.stringify(msgs.map((m) => m.role)))
      const v = renderLog.find((r) => r.name === 'plot_location_merge_user_prompt')?.vars ?? {}
      const tplVars = extractTemplateVars(await readFile(join(FEATHER, 'resources', 'prompts', 'plot_location_merge_user_prompt.txt'), 'utf8'))
      check('C2 模板占位符恰 2 个（mapLocations / plotLocations）且全覆盖', tplVars.sort().join(',') === 'mapLocations,plotLocations' && Object.keys(v).sort().join(',') === tplVars.sort().join(','), `${tplVars.join(',')} | ${Object.keys(v).join(',')}`)
      const mapLocs = JSON.parse(String(v.mapLocations))
      check('C2 mapLocations 为可展示地点（含合成根 + 王城，剪掉不可展示的酒吧）', mapLocs.length === 2 && mapLocs[0].id === 'novel-world' && mapLocs.some((m) => m.id === '1') && !mapLocs.some((m) => m.id === '3'), JSON.stringify(mapLocs.map((m) => m.id)))
      check('C2 plotLocations 为全量 5 条（跨 chunk 合并视野）', JSON.parse(String(v.plotLocations)).length === 5)
      check('C2 指令正文含两节输入（地图/剧情地点）', msgs[1].content.includes('M-6') && msgs[1].content.includes('L-0-l1'))
    }

    // ---- C3. parse 正样本：一组 3 个 + 2 独立 ----
    let pmParseRt
    {
      pmParseRt = await stashedRt('plotLocationMerge', pmOpts)
      const modelOut = JSON.stringify({
        groups: [{ ids: ['L-0-l1', 'L-1-l1', 'L-0-l2'], name: '百合酒吧特别定制地下室', sceneDescription: '合并后的地下密闭空间' }]
      })
      const d = pm.parse(modelOut, pmParseRt)
      check('C3 locations 3 条（1 组 + 2 独立）、idMap 覆盖 5 个输入 id', d.locations.length === 3 && Object.keys(d.idMap).length === 5, `${d.locations.length} / ${Object.keys(d.idMap).length}`)
      check('C3 PL 编号按输入序 1..3', d.locations.map((l) => l.id).join(',') === 'PL-1,PL-2,PL-3', d.locations.map((l) => l.id).join(','))
      const merged = d.locations[0]
      check('C3 合并条目 name/sceneDescription 取自组', merged.name === '百合酒吧特别定制地下室' && merged.sceneDescription === '合并后的地下密闭空间')
      check('C3 合并条目 mapLocationId/identInfos/summary/chunkIndex 取自组内输入序首条', merged.mapLocationId === 'M-6' && JSON.stringify(merged.identInfos) === '["仅限VIP"]' && merged.summary === '甲摘要' && merged.chunkIndex === 0, JSON.stringify(merged))
      check('C3 sourceLocationIds = 组内 id 的输入序（L-0-l1,L-0-l2,L-1-l1）', JSON.stringify(merged.sourceLocationIds) === '["L-0-l1","L-0-l2","L-1-l1"]', JSON.stringify(merged.sourceLocationIds))
      check('C3 chunkIndexes = 成员 chunkIndex 去重升序 [0,1]', JSON.stringify(merged.chunkIndexes) === '[0,1]', JSON.stringify(merged.chunkIndexes))
      check('C3 独立条目保留原字段（L-0-l3 的 null mapLocationId + ancId；L-1-l2 的 M-65）', d.locations[1].mapLocationId === null && d.locations[1].ancId === 'M-9' && d.locations[1].name === '王座大厅' && d.locations[2].mapLocationId === 'M-65')
      check('C3 独立条目 sourceLocationIds/chunkIndexes 为单源', JSON.stringify(d.locations[1].sourceLocationIds) === '["L-0-l3"]' && JSON.stringify(d.locations[2].chunkIndexes) === '[1]')
      check('C3 idMap 全量正确（合并 id 指向 PL-1）', d.idMap['L-0-l1'] === 'PL-1' && d.idMap['L-0-l2'] === 'PL-1' && d.idMap['L-1-l1'] === 'PL-1' && d.idMap['L-0-l3'] === 'PL-2' && d.idMap['L-1-l2'] === 'PL-3', JSON.stringify(d.idMap))
      check('C3 正样本无 warning', (pmParseRt.warnings ?? []).length === 0, JSON.stringify(pmParseRt.warnings))
      check('C3 条目字段集对齐真实库（id/name/mapLocationId/identInfos/summary/sceneDescription/chunkIndex/sourceLocationIds/chunkIndexes）', Object.keys(merged).sort().join(',') === 'chunkIndex,chunkIndexes,id,identInfos,mapLocationId,name,sceneDescription,sourceLocationIds,summary', JSON.stringify(Object.keys(merged)))
    }

    // ---- C4. 边界：组 <2 / 未知 id / 同 id 多组 / 无组 ----
    {
      const rt = await stashedRt('plotLocationMerge', pmOpts)
      const dSmall = pm.parse(JSON.stringify({ groups: [{ ids: ['L-0-l1'], name: 'x', sceneDescription: '' }] }), rt)
      check('C4 组 <2 → 跳过该组 + warning（全部独立）', dSmall.locations.length === 5 && rt.warnings.some((w) => w.includes('ids 不足 2 个')), JSON.stringify(dSmall.locations.map((l) => l.id)))

      const rt2 = await stashedRt('plotLocationMerge', pmOpts)
      const dUnknown = pm.parse(JSON.stringify({ groups: [{ ids: ['L-0-l1', 'L-9-l9'], name: 'x', sceneDescription: '' }] }), rt2)
      check('C4 未知 id → 跳过该 id + warning；剩余 <2 → 整组跳过', dUnknown.locations.length === 5 && rt2.warnings.some((w) => w.includes('L-9-l9')), JSON.stringify(rt2.warnings))

      const rt3 = await stashedRt('plotLocationMerge', pmOpts)
      const dMulti = pm.parse(JSON.stringify({
        groups: [
          { ids: ['L-0-l1', 'L-0-l2'], name: '甲组', sceneDescription: '' },
          { ids: ['L-0-l1', 'L-0-l3'], name: '乙组', sceneDescription: '' }
        ]
      }), rt3)
      check('C4 同一 id 多组 → 后续组跳过该 id（先到先得）+ warning；剩 1 条 → 整组跳过', dMulti.locations.length === 4 && rt3.warnings.some((w) => w.includes('已在前一合并组登记')) && dMulti.idMap['L-0-l3'] === 'PL-2', `${JSON.stringify(dMulti.idMap)} | ${JSON.stringify(rt3.warnings)}`)

      const rt4 = await stashedRt('plotLocationMerge', pmOpts)
      const dNone = pm.parse('{"groups":[]}', rt4)
      check('C4 无组 → 全独立（PL-1..PL-5）+ idMap 全覆盖', dNone.locations.length === 5 && dNone.locations.map((l) => l.id).join(',') === 'PL-1,PL-2,PL-3,PL-4,PL-5' && Object.keys(dNone.idMap).length === 5)

      const rt5 = await stashedRt('plotLocationMerge', pmOpts)
      const dDirty = pm.parse('这些地点可以合并', rt5)
      check('C4 脏样本 → {locations:[], idMap:{}, warnings, raw} 兜底', Array.isArray(dDirty.locations) && dDirty.locations.length === 0 && typeof dDirty.idMap === 'object' && typeof dDirty.raw === 'string' && dDirty.warnings.length > 0)

      const rt6 = await stashedRt('plotLocationMerge', pmOpts)
      const dNoName = pm.parse(JSON.stringify({ groups: [{ ids: ['L-0-l1', 'L-0-l2'] }] }), rt6)
      check('C4 组缺 name → 用组内首条 name + warning', dNoName.locations[0].name === '地下室甲间' && rt6.warnings.some((w) => w.includes('缺 name')), dNoName.locations[0].name)
    }

    // ---- C5. 缺上游产物 → 可读错误 + 注册 + keyOf ----
    {
      const wsNoPl = makeWorkspace(join(TEST_PARENT, 'ws-pm-nopl'))
      await fillWorkspace(wsNoPl, { withPlotLocations: false })
      const rtPl = makeRt('plotLocationMerge', { global: true, chunkIndex: null, ws: wsNoPl })
      let e1 = ''
      try {
        await pm.inputText(rtPl)
      } catch (e) {
        e1 = e.message
      }
      check('C5 缺 plotLocation → 可读错误（含任务名）', /plotLocationMerge 需要 plotLocation 产物/.test(e1), e1)

      const wsNoTree = makeWorkspace(join(TEST_PARENT, 'ws-pm-notree'))
      await fillWorkspace(wsNoTree, { withLocationTree: false })
      const rtTree = makeRt('plotLocationMerge', { global: true, chunkIndex: null, ws: wsNoTree })
      let e2 = ''
      try {
        await pm.inputText(rtTree)
      } catch (e) {
        e2 = e.message
      }
      check('C5 缺 locationTree → 可读错误（含任务名）', /plotLocationMerge 需要 locationTree 产物/.test(e2), e2)

      check('C5 plotLocationMerge 已注册', tasks.LLM_ADAPTERS['plotLocationMerge']?.id === 'plotLocationMerge')
      check('C5 导出的 keyOf 与适配器同一函数', tasks.plotLocationMergeKeyOf === pm.keyOf)
      const kof = tasks.plotLocationMergeKeyOf
      check('C5 keyOf：组按 ids 排序后 join（[B,A] ≡ [A,B]）', kof({ ids: ['B', 'A'] }) === kof({ ids: ['A', 'B'] }) && kof({ ids: ['A', 'B'] }) === 'group:A+B', kof({ ids: ['A', 'B'] }))
      check('C5 keyOf：字符串元素 warn: 前缀不与他项相消', kof('某条 warning') === 'warn:某条 warning')
    }

    // =====================================================================
    // D · batching 覆盖
    // =====================================================================
    console.log('\nD · batching')
    {
      check('D1 storyScript 声明 inputBudgetTokens = 100000', ss.batching?.inputBudgetTokens === 100000, JSON.stringify(ss.batching))
      check('D2 plotLocationMerge 声明 inputBudgetTokens = 100000', pm.batching?.inputBudgetTokens === 100000, JSON.stringify(pm.batching))
      check('D3 characterRelation 无 batching 字段（不借道覆盖）', cr.batching === undefined)
      check('D3 老适配器仍无 batching（回归保护）', [tasks.plotLocationAdapter, tasks.locationTreeAdapter, tasks.characterAppearanceAdapter, tasks.cacheWarmingAdapter, tasks.segAdapter, tasks.plotAdapter, tasks.draftAdapter].every((a) => a.batching === undefined))
    }
  } finally {
    await rm(TEST_PARENT, { recursive: true, force: true })
  }

  console.log(`\n==== T6-H 演出链验证：${passed} 通过 / ${failed} 失败 ====`)
  if (failed === 0) {
    console.log('T6-H STAGE CHAIN VERIFY PASS')
  } else {
    console.log('T6-H STAGE CHAIN VERIFY FAIL')
  }
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('ERROR:', e?.stack ?? e?.message ?? e)
  process.exitCode = 2
})

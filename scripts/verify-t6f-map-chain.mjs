/**
 * T6-F · 地图/空间链验证脚本（batchLocationSummary / impressionLayout / plotLocation
 * + location-inputs 共享构造器 + parse(content, rt?) 接口扩展）
 * （node 直跑，**不启动 Electron**；零新增依赖）。
 *
 * 覆盖五组（对应 T6-F spec 验收项）：
 *  A. location-inputs 纯函数：showableMapLocations 剪枝（showOnImpressionMap:false 节点
 *     及其整棵子树排除、合成根 novel-world 入列且 parentId=null、字段集正确）、
 *     locations/tree 不一致以 tree 为准（树独有节点入列、locations 独有节点不出列）、
 *     tree 缺字段用 locations 补、无 tree 时由 locations 平铺推导兜底；
 *     mapLocationTreeJson 完整树不剪枝（不可展示节点仍在，供 plotLocation 绑定）；
 *     summariesFromEntries 双形态解包 / chunkIndex 取 key 末段数字 / 解析不到按出现序 /
 *     非非空字符串条目跳过；
 *  B. batchLocationSummary：inputText 含 chunk 摘要与 mapLocations JSON；无 locationTree /
 *     无 chunkLocationSummary → 可读错误；buildMessages 恰 2 条无 `{{` 残留；parse 正/脏
 *     样本；注册完整；模板占位符全覆盖（读模板断言）；引擎合并模拟（首批获胜）；
 *  C. impressionLayout：inputText 含 mapLocations 与 batchLocationSummary；parse 合法样本
 *     全部保留、非法 rect（width<=0 / x+width>100 / 非数字 / 负坐标 / y+height>100）该
 *     placement 丢弃+warning 其余保留、无效 layout（缺 parentId / 坏 mode / 缺 placements）
 *     整条丢弃、缺 layouts → raw 兜底、gridSize 缺省 100；注册完整；模板占位符全覆盖；
 *     keyOf 语义 + 引擎合并模拟（跨批重复父区域首现获胜）；
 *  D. plotLocation：inputText 含行号包装；buildMessages 恰 3 条（原文单独喂）且 5 个模板
 *     变量内容正确（本片人物来自 draftAlign:2、阅读记忆来自 plot:0/1、地图树来自
 *     locationTree）；无 draftAlign → 空人物 + warning 不抛；parse id 重编为
 *     L-{chunk}-l{n}（mock rt.chunkIndex=2 → L-2-l1/L-2-l2，模型自产 id 不保留）、
 *     protocol/actions 程序字段在、缺 name 跳过+warning、mapLocationId 非字符串被省略、
 *     ancId 保留、脏样本 raw 兜底；注册完整；模板占位符全覆盖；引擎合并模拟（跨批模型
 *     本地短 id 不碰撞——按 name 键去重的实证）；
 *  E. 接口兼容：老适配器（seg/cacheWarming/locationTree/worldImpression/draft 等）以
 *     单参调用 parse 不崩（T6-F ① 加性可选签名的向后兼容实证）。
 *
 * 姿势与 `scripts/verify-t6e-entity-chain.mjs` 一致：`createRequire(feather/package.json)`
 * 取项目已装的 esbuild，把入口打成单文件 ESM 写入临时目录后 `pathToFileURL` 动态 import；
 * electron 以最小桩替换（app.getAppPath → 项目根，使 prompt-loader 的 resourcesDir()
 * 定位到 `resources/prompts`）。
 *
 * 临时目录**只准碰** `D:/AI/tx/feather-t6f-test/`（跑完 rm -rf 清掉）；
 * 绝不读写真实工作库目录（7 本真实库只读）。
 *
 * 用法：node scripts/verify-t6f-map-chain.mjs
 */
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(here, '..')
/** 唯一允许触碰的临时父目录（跑完 rm -rf 清掉） */
const TEST_PARENT = 'D:/AI/tx/feather-t6f-test'
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

const PKG = 'pkg-t6f'
const REV = 'rev-t6f'

/** 一个小工作库：writeShard 写真分片 + 手工维护 index.json 的 shards 登记。 */
function makeWorkspace(root) {
  const idx = {
    indexVersion: 1,
    format: 'txt2world-workspace',
    pkgId: PKG,
    title: 'T6-F 验证书',
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
function makeRt(id, { global = true, chunkIndex = null, chunkChapters, ws, renderLog = [] } = {}) {
  return {
    task: taskDef(id, global),
    pkgId: PKG,
    revisionId: REV,
    chunkIndex,
    instanceKey: `${PKG}:${REV}:${id}${chunkIndex === null ? '' : `:${chunkIndex}`}`,
    chunkText: CHUNK2_TEXT,
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
// 测试数据（艾尔希雅世界；含不可展示节点及其子树、树/locations 不一致、对象数组别名等）
// ---------------------------------------------------------------------------

/** chunk2（plotLocation 被测实例）的章节切片与纯文本。 */
const CHUNK2_CHAPTERS = [
  { seq: 5, title: '第五章 前往西尔瓦诺', text: '艾莉娜搭上便车。\n车厢内铺着柔软垫子。' },
  { seq: 6, title: '第六章 西尔瓦诺街市', text: '艾莉娜在街市啃面包闲逛。' }
]
const CHUNK2_TEXT = CHUNK2_CHAPTERS.map((c) => c.text).join('\n')

/**
 * locationTree 产物（T6-C 形状）：
 *  - id 2（大街）showOnImpressionMap:false → 整支排除；
 *  - id 3（百合酒吧）false 且带子 4（地下室，true）→ **子树整支排除**（剪枝规则实证）；
 *  - id 9 只在 locations、不在 tree → 不出列（tree 结构为准）；
 *  - tree 节点 7 不在 locations → 入列（tree 结构为准）；
 *  - tree 节点 6 缺 identInfos → 用 locations 同 id 条目补（['溪边可购食物']）。
 */
const LOCATION_TREE = {
  locations: [
    { id: '1', name: '艾尔希雅王城', aliases: ['王城'], locationType: '城市', identInfos: ['毗邻魔法草原'], showOnImpressionMap: true, parentLocationId: null, ancestorLocationId: null },
    { id: '2', name: '王城旁大街', aliases: [], locationType: '街道', identInfos: [], showOnImpressionMap: false, parentLocationId: '1', ancestorLocationId: null },
    { id: '3', name: '百合酒吧', aliases: ['酒吧'], locationType: '酒吧', identInfos: ['位于王城旁'], showOnImpressionMap: false, parentLocationId: '1', ancestorLocationId: null },
    { id: '4', name: '百合酒吧地下室', aliases: [], locationType: '地下室', identInfos: ['仅限VIP'], showOnImpressionMap: true, parentLocationId: '3', ancestorLocationId: null },
    { id: '5', name: '魔法草原', aliases: [], locationType: '草原', identInfos: ['毗邻王城'], showOnImpressionMap: true, parentLocationId: null, ancestorLocationId: null },
    { id: '6', name: '草原小溪', aliases: [], locationType: '河流', identInfos: ['溪边可购食物'], showOnImpressionMap: true, parentLocationId: '5', ancestorLocationId: null },
    { id: '9', name: '只在locations里的地点', aliases: [], locationType: '仓库', identInfos: [], showOnImpressionMap: true, parentLocationId: null, ancestorLocationId: null }
  ],
  tree: {
    id: 'novel-world', name: '小说世界', locationType: '世界', aliases: [], identInfos: [], parentLocationId: null, ancestorLocationId: null,
    children: [
      {
        id: '1', name: '艾尔希雅王城', aliases: ['王城'], locationType: '城市', identInfos: ['毗邻魔法草原'], showOnImpressionMap: true, parentLocationId: null, ancestorLocationId: null,
        children: [
          { id: '2', name: '王城旁大街', aliases: [], locationType: '街道', identInfos: [], showOnImpressionMap: false, parentLocationId: '1', ancestorLocationId: null, children: [] },
          {
            id: '3', name: '百合酒吧', aliases: ['酒吧'], locationType: '酒吧', identInfos: ['位于王城旁'], showOnImpressionMap: false, parentLocationId: '1', ancestorLocationId: null,
            children: [
              { id: '4', name: '百合酒吧地下室', aliases: [], locationType: '地下室', identInfos: ['仅限VIP'], showOnImpressionMap: true, parentLocationId: '3', ancestorLocationId: null, children: [] }
            ]
          }
        ]
      },
      {
        id: '5', name: '魔法草原', aliases: [], locationType: '草原', identInfos: [], showOnImpressionMap: true, parentLocationId: null, ancestorLocationId: null,
        children: [
          { id: '6', name: '草原小溪', aliases: [], locationType: '河流', showOnImpressionMap: true, parentLocationId: '5', ancestorLocationId: null, children: [] },
          { id: '7', name: '树独有地点', aliases: ['七'], locationType: '洞穴', identInfos: [], showOnImpressionMap: true, parentLocationId: '5', ancestorLocationId: null, children: [] }
        ]
      }
    ]
  },
  warnings: []
}

const CHUNK_SUMMARIES = [
  '第0块空间摘要：王城旁有大街，百合酒吧位于王城旁。',
  '第1块空间摘要：酒吧后门通往地下室，魔王城在遥远北方。',
  '第2块空间摘要：魔法草原毗邻王城，草原下有米尔巢穴。'
]
const BATCH_SUMMARY = '全书空间关系精炼摘要：王城—大街—百合酒吧（含VIP地下室）；魔法草原毗邻王城，草原下有米尔巢穴与小溪。'

const PLOT_SUMMARIES = [
  '第0章：艾莉娜在王城举起圣剑。',
  '第1章：艾莉娜在魔法草原遇见菲雅。',
  '第2章：艾莉娜乘马车前往西尔瓦诺。'
]

/** draftAlign 产物（本地步骤信封；chunk2 含对象数组别名，验证别名归一）。 */
const DRAFT_ALIGN = [
  { characters: [{ id: 'D-0-C-0', name: '艾莉娜', aliases: ['艾莉'] }, { id: 'D-0-C-1', name: '圣剑酱', aliases: [] }] },
  { characters: [{ id: 'D-1-C-0', name: '菲雅', aliases: ['菲雅酱'] }] },
  { characters: [{ id: 'D-2-C-0', name: '铃', aliases: [] }, { id: 'D-2-C-1', name: '莉莉', aliases: [{ alias: '莉莉ANA', type: '昵称' }] }] }
]

let tasks
let li
let up
let pl
let sh
let mg

/** 建一个装满全部上游产物的工作库（locationTree/chunkLocationSummary/batchLocationSummary/draftAlign/plot）。 */
async function fillWorkspace(ws, { withDraftAlign = true, withBatch = true, withLocationTree = true, withCls = true } = {}) {
  await ws.reset()
  if (withLocationTree) {
    await ws.writeResults('records/results/locationTree.json', [{ key: `${PKG}:${REV}:locationTree`, value: llmEnvelope(LOCATION_TREE) }])
  }
  if (withCls) {
    await ws.writeResults(
      'records/results/chunkLocationSummary.json',
      CHUNK_SUMMARIES.map((s, i) => ({ key: `${PKG}:${REV}:chunkLocationSummary:${i}`, value: llmEnvelope({ chunkLocationSummary: s }) }))
    )
  }
  if (withBatch) {
    await ws.writeResults('records/results/batchLocationSummary.json', [{ key: `${PKG}:${REV}:batchLocationSummary`, value: llmEnvelope({ batchLocationSummary: BATCH_SUMMARY }) }])
  }
  if (withDraftAlign) {
    await ws.writeResults(
      'records/results/draftAlign.json',
      DRAFT_ALIGN.map((d, i) => ({ key: `${PKG}:${REV}:draftAlign:${i}`, value: localEnvelope(d) }))
    )
  }
  await ws.writeResults(
    'records/results/plot.json',
    PLOT_SUMMARIES.map((s, i) => ({ key: `${PKG}:${REV}:plot:${i}`, value: llmEnvelope({ chunkSummary: s, chapters: [] }) }))
  )
}

async function main() {
  await rm(TEST_PARENT, { recursive: true, force: true })
  await mkdir(BUILD_DIR, { recursive: true })
  console.log(`临时目录：${TEST_PARENT}\n`)

  tasks = await loadModule('src/main/pipeline/tasks/index.ts', 'tasks-index.mjs')
  li = await loadModule('src/main/pipeline/location-inputs.ts', 'location-inputs.mjs')
  up = await loadModule('src/main/pipeline/upstream.ts', 'upstream.mjs')
  pl = await loadModule('src/main/pipeline/prompt-loader.ts', 'prompt-loader.mjs')
  sh = await loadModule('src/main/workspace/shards.ts', 'shards.mjs')
  mg = await loadModule('src/main/pipeline/merge.ts', 'merge.mjs')

  const ws = makeWorkspace(join(TEST_PARENT, 'ws'))
  await fillWorkspace(ws)

  try {
    // =====================================================================
    // A · location-inputs 纯函数
    // =====================================================================
    console.log('A · location-inputs 纯函数')

    // ---- A1. showableMapLocations：剪枝 + 合成根 + 字段集 ----
    {
      const list = li.showableMapLocations(LOCATION_TREE)
      const ids = list.map((l) => l.id)
      check('A1 可展示列表 = novel-world,1,5,6,7（先根序）', ids.join(',') === 'novel-world,1,5,6,7', ids.join(','))
      check('A1 不可展示节点 2（大街）被排除', !ids.includes('2'))
      check('A1 不可展示节点 3（百合酒吧）被排除', !ids.includes('3'))
      check('A1 3 的子树整支排除（4 地下室即使 showOnImpressionMap:true 也不在）', !ids.includes('4'))
      check('A1 合成根 novel-world 在列且 parentId=null', list[0].id === 'novel-world' && list[0].parentId === null)
      check('A1 字段集严格等于 id/name/aliases/locationType/identInfos/parentId', list.every((l) => Object.keys(l).sort().join(',') === 'aliases,id,identInfos,locationType,name,parentId'), JSON.stringify(Object.keys(list[0] ?? {})))
      check('A1 parentId 即原树父（1→novel-world，6→5）', list.find((l) => l.id === '1').parentId === 'novel-world' && list.find((l) => l.id === '6').parentId === '5')
      check('A1 树独有节点 7 入列（tree 结构为准）', ids.includes('7') && list.find((l) => l.id === '7').name === '树独有地点')
      check('A1 只在 locations 的 9 不出列（tree 结构为准）', !ids.includes('9'))
      check('A1 tree 缺 identInfos 用 locations 补（6 → 溪边可购食物）', JSON.stringify(list.find((l) => l.id === '6').identInfos) === '["溪边可购食物"]')
      check('A1 名称/别名/类型从 tree 取（王城/王城/城市）', list.find((l) => l.id === '1').name === '艾尔希雅王城' && list.find((l) => l.id === '1').aliases[0] === '王城' && list.find((l) => l.id === '1').locationType === '城市')
    }

    // ---- A2. 双形态解包 + 无 tree 兜底 + 空输入 ----
    {
      const wrapped = li.showableMapLocations({ data: LOCATION_TREE, responsePath: 'x' })
      check('A2 {data} 信封双形态解包（与裸值同结果）', wrapped.map((l) => l.id).join(',') === 'novel-world,1,5,6,7')
      const bare = li.showableMapLocations({ locations: LOCATION_TREE.locations, tree: LOCATION_TREE.tree })
      check('A2 裸值（无 data 层）同结果', bare.length === wrapped.length)
      const noTree = li.showableMapLocations({ locations: LOCATION_TREE.locations })
      check('A2 无 tree → 由 locations 平铺推导（合成根 + 剪枝仍生效：2/3 及其子树排除，9 入列）', noTree.map((l) => l.id).join(',') === 'novel-world,1,5,6,9', noTree.map((l) => l.id).join(','))
      check('A2 空/坏输入 → 空数组不抛', li.showableMapLocations(null).length === 0 && li.showableMapLocations({}).length === 0 && li.showableMapLocations('x').length === 0)
    }

    // ---- A3. mapLocationTreeJson：完整树不剪枝 ----
    {
      const json = li.mapLocationTreeJson(LOCATION_TREE)
      const tree = JSON.parse(json)
      check('A3 根 = novel-world（parentLocationId=null）', tree.id === 'novel-world' && tree.parentLocationId === null)
      check('A3 完整树含不可展示节点 2/3（不剪枝）', json.includes('"id":"2"') && json.includes('"id":"3"'))
      check('A3 完整树含 3 的子节点 4（地下室——真实库 L-0-l1 的绑定目标）', json.includes('"id":"4"') && json.includes('百合酒吧地下室'))
      check('A3 序列化是单行 JSON（无换行，便于模板变量直传）', !json.includes('\n'))
      check('A3 无产物 → "null"', li.mapLocationTreeJson(null) === 'null')
    }

    // ---- A4. summariesFromEntries ----
    {
      const mixed = [
        { key: `${PKG}:${REV}:chunkLocationSummary:0`, value: { data: { chunkLocationSummary: '摘要甲' } } },
        { key: `${PKG}:${REV}:chunkLocationSummary:1`, value: { chunkLocationSummary: '摘要乙' } },
        { key: `${PKG}:${REV}:chunkLocationSummary:2`, value: { data: { chunkLocationSummary: '   ' } } },
        { key: `${PKG}:${REV}:chunkLocationSummary:x`, value: { data: { chunkLocationSummary: '摘要丙' } } },
        { key: 'bad-key', value: { chunkLocationSummary: '摘要丁' } },
        { key: `${PKG}:${REV}:chunkLocationSummary:3`, value: null }
      ]
      const out = li.summariesFromEntries(mixed, 'chunkLocationSummary')
      check('A4 双形态解包 + 空白串跳过 + null 条目跳过（4 条）', out.length === 4, JSON.stringify(out))
      check('A4 index：key 末段数字优先（0/1），解析不到按出现序（丙=2、丁=3）', out.map((o) => `${o.index}:${o.text}`).join('|') === '0:摘要甲|1:摘要乙|2:摘要丙|3:摘要丁', JSON.stringify(out))
      check('A4 字段名不匹配 → 空数组', li.summariesFromEntries(mixed, 'batchLocationSummary').length === 0)
    }

    // =====================================================================
    // B · batchLocationSummary
    // =====================================================================
    console.log('\nB · batchLocationSummary 适配器')
    const bls = tasks.batchLocationSummaryAdapter

    // ---- B1. inputText：合稿含 mapLocations JSON + chunk 摘要 ----
    {
      const rt = makeRt('batchLocationSummary', { ws })
      const input = await bls.inputText(rt)
      const firstLine = input.split('\n')[0]
      let arr = null
      try {
        arr = JSON.parse(firstLine)
      } catch {
        /* 保持 null */
      }
      check('B1 inputText 首行是 mapLocations JSON（单行可解析）', Array.isArray(arr), firstLine.slice(0, 80))
      check('B1 mapLocations 只含可展示地点（novel-world,1,5,6,7）', Array.isArray(arr) && arr.map((l) => l.id).join(',') === 'novel-world,1,5,6,7', Array.isArray(arr) ? arr.map((l) => l.id).join(',') : 'n/a')
      check('B1 inputText 含 3 份 chunk 摘要', CHUNK_SUMMARIES.every((s) => input.includes(s)))
      check('B1 inputText 含【Chunk 0/1/2 · 空间摘要】标注', ['【Chunk 0 · 空间摘要】', '【Chunk 1 · 空间摘要】', '【Chunk 2 · 空间摘要】'].every((s) => input.includes(s)))
    }

    // ---- B2. 上游缺失 → 可读错误 ----
    {
      const wsNoLT = makeWorkspace(join(TEST_PARENT, 'ws-nolt'))
      await fillWorkspace(wsNoLT, { withLocationTree: false })
      const rt = makeRt('batchLocationSummary', { ws: wsNoLT })
      let msg = ''
      try {
        await bls.inputText(rt)
      } catch (e) {
        msg = e?.message ?? ''
      }
      check('B2 无 locationTree 产物 → 可读错误（含 locationTree 字样）', msg.includes('locationTree') && msg.includes('请先运行 locationTree 任务'), msg)

      const wsNoCls = makeWorkspace(join(TEST_PARENT, 'ws-nocls'))
      await fillWorkspace(wsNoCls, { withCls: false })
      await wsNoCls.writeResults('records/results/locationTree.json', [{ key: `${PKG}:${REV}:locationTree`, value: llmEnvelope(LOCATION_TREE) }])
      const rt2 = makeRt('batchLocationSummary', { ws: wsNoCls })
      let msg2 = ''
      try {
        await bls.inputText(rt2)
      } catch (e) {
        msg2 = e?.message ?? ''
      }
      check('B2 无 chunkLocationSummary 产物 → 可读错误（含 chunkLocationSummary 字样）', msg2.includes('chunkLocationSummary'), msg2)

      const rt3 = makeRt('batchLocationSummary', { ws })
      delete rt3.readUpstream
      let msg3 = ''
      try {
        await bls.inputText(rt3)
      } catch (e) {
        msg3 = e?.message ?? ''
      }
      check('B2 未挂 readUpstream → 可读错误', msg3.includes('readUpstream'), msg3)
    }

    // ---- B3. buildMessages：恰 2 条 + 模板占位符全覆盖 ----
    {
      const renderLog = []
      const rt = makeRt('batchLocationSummary', { ws, renderLog })
      const input = await bls.inputText(rt)
      const msgs = await bls.buildMessages(input, rt)
      check('B3 buildMessages 恰 2 条消息（输入内嵌于指令，不重复）', msgs.length === 2, `实际 ${msgs.length}`)
      check('B3 角色顺序 = system / user', msgs[0].role === 'system' && msgs[1].role === 'user')
      check('B3 system 来自 common_system_prompt', msgs[0].content.includes('【共同任务边界】'))
      check('B3 user 含全部 3 份摘要', CHUNK_SUMMARIES.every((s) => msgs[1].content.includes(s)))
      check('B3 user 含 batchIndex：0（单轮全文模式常量）', msgs[1].content.includes('batchIndex：0'))
      check('B3 两条消息均无 `{{` 残留', msgs.every((m) => !m.content.includes('{{')))

      const taskEntry = renderLog.find((r) => r.name === 'batch_location_summary_user_prompt')
      check('B3 渲染了 batch_location_summary_user_prompt', !!taskEntry)
      const tplVars = extractTemplateVars(await readFile(join(FEATHER, 'resources', 'prompts', 'batch_location_summary_user_prompt.txt'), 'utf8'))
      check('B3 模板占位符恰为 batchIndex/mapLocations/chunkLocationSummaries', tplVars.sort().join(',') === 'batchIndex,chunkLocationSummaries,mapLocations', tplVars.join(','))
      const missing = tplVars.filter((v) => !(v in taskEntry.vars) || taskEntry.vars[v] === undefined)
      check('B3 三个模板占位符全覆盖', missing.length === 0, `缺失: ${missing.join(',')}`)
      check('B3 传入 vars 无多余键', Object.keys(taskEntry.vars).sort().join(',') === tplVars.sort().join(','), `实际: ${Object.keys(taskEntry.vars).join(',')}`)
      check('B3 mapLocations 传预序列化 JSON 字符串（非 JS 数组）', typeof taskEntry.vars.mapLocations === 'string' && Array.isArray(JSON.parse(taskEntry.vars.mapLocations)))
      check('B3 batchIndex 传 0', taskEntry.vars.batchIndex === 0)
    }

    // ---- B4. parse 正/脏样本 ----
    {
      const d = bls.parse(JSON.stringify({ batchLocationSummary: BATCH_SUMMARY }))
      check('B4 正样本 → {batchLocationSummary}', d.batchLocationSummary === BATCH_SUMMARY && Object.keys(d).length === 1, JSON.stringify(d).slice(0, 120))
      const fence = bls.parse('```json\n{"batchLocationSummary":"围栏内摘要"}\n```')
      check('B4 ```json 围栏容忍', fence.batchLocationSummary === '围栏内摘要')
      const dirties = ['not a json at all', '{}', '{"batchLocationSummary":""}', '{"batchLocationSummary":"   "}', '{"batchLocationSummary":42}', '', '{"other":"x"}']
      let noThrow = true
      let shapeOk = true
      for (const dirty of dirties) {
        try {
          const dd = bls.parse(dirty)
          if (dd.batchLocationSummary !== null || typeof dd.raw !== 'string') {
            shapeOk = false
            console.log(`     兜底形状异常：${JSON.stringify(dirty).slice(0, 40)} → ${JSON.stringify(dd).slice(0, 120)}`)
          }
        } catch (e) {
          noThrow = false
          console.log(`     抛崩：${JSON.stringify(dirty).slice(0, 40)} → ${e.message}`)
        }
      }
      check('B4 脏样本（非 JSON / 缺键 / 空串 / 非字符串）不抛崩', noThrow)
      check('B4 脏样本兜底 = {batchLocationSummary:null, raw 截断}', shapeOk)
    }

    // ---- B5. 注册完整性 + 引擎合并模拟 ----
    {
      check('B5 LLM_ADAPTERS 含 batchLocationSummary 且 id 一致', typeof tasks.LLM_ADAPTERS.batchLocationSummary === 'object' && tasks.LLM_ADAPTERS.batchLocationSummary.id === 'batchLocationSummary')
      check('B5 mergeStrategy = concat-dedup-order', bls.mergeStrategy === 'concat-dedup-order')
      check('B5 不提供 keyOf（顶层单字符串无稳定键）', bls.keyOf === undefined)
      const merged = mg.mergeOutputs('concat-dedup-order', [
        JSON.stringify({ batchLocationSummary: '首批摘要' }),
        JSON.stringify({ batchLocationSummary: '次批摘要' })
      ])
      const d = bls.parse(merged)
      check('B5 引擎合并模拟：跨批 combineFirst 首批获胜（文件头注明的退化）', d.batchLocationSummary === '首批摘要', JSON.stringify(d).slice(0, 120))
    }

    // =====================================================================
    // C · impressionLayout
    // =====================================================================
    console.log('\nC · impressionLayout 适配器')
    const imp = tasks.impressionLayoutAdapter

    // ---- C1. inputText：合稿含 mapLocations JSON + batchLocationSummary ----
    {
      const rt = makeRt('impressionLayout', { ws })
      const input = await imp.inputText(rt)
      const firstLine = input.split('\n')[0]
      let arr = null
      try {
        arr = JSON.parse(firstLine)
      } catch {
        /* 保持 null */
      }
      check('C1 inputText 首行是 mapLocations JSON', Array.isArray(arr), firstLine.slice(0, 80))
      check('C1 mapLocations 只含可展示地点', Array.isArray(arr) && arr.map((l) => l.id).join(',') === 'novel-world,1,5,6,7')
      check('C1 inputText 含 batchLocationSummary 文本', input.includes(BATCH_SUMMARY))
    }

    // ---- C2. 无 batchLocationSummary 产物 → 可读错误 ----
    {
      const wsNoBatch = makeWorkspace(join(TEST_PARENT, 'ws-nobatch'))
      await fillWorkspace(wsNoBatch, { withBatch: false })
      const rt = makeRt('impressionLayout', { ws: wsNoBatch })
      let msg = ''
      try {
        await imp.inputText(rt)
      } catch (e) {
        msg = e?.message ?? ''
      }
      check('C2 无 batchLocationSummary 产物 → 可读错误', msg.includes('impressionLayout 需要 batchLocationSummary 产物'), msg)

      const wsNoLT = makeWorkspace(join(TEST_PARENT, 'ws-nolt2'))
      await fillWorkspace(wsNoLT, { withLocationTree: false })
      const rt2 = makeRt('impressionLayout', { ws: wsNoLT })
      let msg2 = ''
      try {
        await imp.inputText(rt2)
      } catch (e) {
        msg2 = e?.message ?? ''
      }
      check('C2 无 locationTree 产物 → 可读错误', msg2.includes('locationTree'), msg2)
    }

    // ---- C3. parse 合法样本：全部保留 + 输出包装 ----
    {
      const d = imp.parse(JSON.stringify({
        gridSize: 100,
        layouts: [
          { parentId: 'novel-world', mode: 'separated', placements: [{ id: '1', rect: { x: 5, y: 5, width: 40, height: 40 } }, { id: '5', rect: { x: 50, y: 10, width: 45, height: 80 } }] },
          { parentId: '5', mode: 'partition', placements: [{ id: '6', rect: { x: 10, y: 10, width: 30, height: 30 } }] }
        ]
      }))
      check('C3 输出包装 {layout:{gridSize,layouts},warnings}（view.ts:591 读这层）', !!d.layout && d.layout.gridSize === 100 && Array.isArray(d.layout.layouts) && Array.isArray(d.warnings), JSON.stringify(d).slice(0, 140))
      check('C3 合法样本 placement 全保留（3 个）', d.layout.layouts.reduce((n, g) => n + g.placements.length, 0) === 3)
      check('C3 layout 字段集严格 = parentId/mode/placements', d.layout.layouts.every((g) => Object.keys(g).sort().join(',') === 'mode,parentId,placements'))
      check('C3 placement 字段集严格 = id/rect（四字段）', d.layout.layouts.flatMap((g) => g.placements).every((p) => Object.keys(p).sort().join(',') === 'id,rect' && Object.keys(p.rect).sort().join(',') === 'height,width,x,y'))
      check('C3 mode 缺省 separated', imp.parse(JSON.stringify({ layouts: [{ parentId: 'x', placements: [] }] })).layout.layouts[0].mode === 'separated')
      check('C3 正样本 warnings 为空数组', d.warnings.length === 0, JSON.stringify(d.warnings))
    }

    // ---- C4. parse 非法 rect：该 placement 丢弃 + warning，其余保留 ----
    {
      const d = imp.parse(JSON.stringify({
        gridSize: 100,
        layouts: [
          {
            parentId: 'novel-world',
            mode: 'separated',
            placements: [
              { id: 'ok1', rect: { x: 5, y: 5, width: 40, height: 40 } },
              { id: 'bad-width0', rect: { x: 10, y: 10, width: 0, height: 20 } },
              { id: 'bad-height-neg', rect: { x: 10, y: 10, width: 20, height: -5 } },
              { id: 'bad-over-x', rect: { x: 60, y: 10, width: 50, height: 20 } },
              { id: 'bad-over-y', rect: { x: 10, y: 80, width: 20, height: 30 } },
              { id: 'bad-neg', rect: { x: -1, y: 10, width: 20, height: 20 } },
              { id: 'bad-nan', rect: { x: 'a', y: 10, width: 20, height: 20 } },
              { id: 'bad-no-rect', rect: undefined },
              { rect: { x: 1, y: 1, width: 10, height: 10 } },
              { id: 'ok2', rect: { x: 50, y: 10, width: 45, height: 80 } }
            ]
          }
        ]
      }))
      const ids = d.layout.layouts[0].placements.map((p) => p.id)
      check('C4 非法 rect 的 placement 丢弃、合法保留（仅 ok1/ok2）', ids.join(',') === 'ok1,ok2', ids.join(','))
      check('C4 每个无效 placement 记 warning（≥8 条）', d.warnings.length >= 8, JSON.stringify(d.warnings.length))
      check('C4 warning 含 parentId 上下文', d.warnings.every((w) => w.includes('novel-world')), JSON.stringify(d.warnings[0]))
      check('C4 x+width=100 / y+height=100 边界值合法（不大于即合规）', imp.parse(JSON.stringify({ layouts: [{ parentId: 'p', placements: [{ id: 'edge', rect: { x: 0, y: 0, width: 100, height: 100 } }] }] })).layout.layouts[0].placements.length === 1)
    }

    // ---- C5. parse 无效 layout 整条丢弃 ----
    {
      const d = imp.parse(JSON.stringify({
        layouts: [
          { mode: 'separated', placements: [{ id: '1', rect: { x: 1, y: 1, width: 10, height: 10 } }] },
          { parentId: '', placements: [] },
          { parentId: 'bad-mode', mode: 'grid', placements: [] },
          { parentId: 'no-placements', mode: 'separated' },
          'not-an-object',
          { parentId: 'good', placements: [{ id: '2', rect: { x: 1, y: 1, width: 10, height: 10 } }] }
        ]
      }))
      check('C5 缺 parentId / 坏 mode / 缺 placements / 非对象 → 整条丢弃，仅剩 good', d.layout.layouts.length === 1 && d.layout.layouts[0].parentId === 'good', JSON.stringify(d.layout.layouts.map((g) => g.parentId)))
      check('C5 无效 layout 记 warning（≥4 条）', d.warnings.length >= 4, JSON.stringify(d.warnings.length))
    }

    // ---- C6. parse 兜底与 gridSize ----
    {
      const dirties = ['not a json at all', '{}', '{"layouts":"not-array"}', '', '{"gridSize":100}']
      let noThrow = true
      let shapeOk = true
      for (const dirty of dirties) {
        try {
          const d = imp.parse(dirty)
          const ok = d.layout && Array.isArray(d.layout.layouts) && d.layout.layouts.length === 0 && Array.isArray(d.warnings)
          if (!ok) {
            shapeOk = false
            console.log(`     兜底形状异常：${JSON.stringify(dirty).slice(0, 40)} → ${JSON.stringify(d).slice(0, 140)}`)
          }
          if (dirty === 'not a json at all' && typeof d.raw !== 'string') {
            shapeOk = false
            console.log('     非 JSON 样本缺 raw 兜底字段')
          }
        } catch (e) {
          noThrow = false
          console.log(`     抛崩：${JSON.stringify(dirty).slice(0, 40)} → ${e.message}`)
        }
      }
      check('C6 缺 layouts 键 → raw 兜底不抛崩（形状 = layout{gridSize,layouts:[]}+warnings+raw）', noThrow && shapeOk)
      check('C6 gridSize 缺省 100', imp.parse(JSON.stringify({ layouts: [] })).layout.gridSize === 100)
      const badGrid = imp.parse(JSON.stringify({ gridSize: 'big', layouts: [] }))
      check('C6 gridSize 非有限数字 → 100 + warning', badGrid.layout.gridSize === 100 && badGrid.warnings.some((w) => w.includes('gridSize')), JSON.stringify(badGrid.warnings))
    }

    // ---- C7. buildMessages + 注册 + keyOf + 引擎合并 ----
    {
      const renderLog = []
      const rt = makeRt('impressionLayout', { ws, renderLog })
      const input = await imp.inputText(rt)
      const msgs = await imp.buildMessages(input, rt)
      check('C7 buildMessages 恰 2 条消息', msgs.length === 2, `实际 ${msgs.length}`)
      check('C7 user 含 batchLocationSummary 文本与 mapLocations JSON', msgs[1].content.includes(BATCH_SUMMARY) && msgs[1].content.includes('"parentId"'))
      check('C7 两条消息均无 `{{` 残留', msgs.every((m) => !m.content.includes('{{')))
      const taskEntry = renderLog.find((r) => r.name === 'impression_layout_user_prompt')
      const tplVars = extractTemplateVars(await readFile(join(FEATHER, 'resources', 'prompts', 'impression_layout_user_prompt.txt'), 'utf8'))
      check('C7 模板占位符恰为 mapLocations/batchLocationSummaries', tplVars.sort().join(',') === 'batchLocationSummaries,mapLocations', tplVars.join(','))
      const missing = tplVars.filter((v) => !(v in taskEntry.vars) || taskEntry.vars[v] === undefined)
      check('C7 两个模板占位符全覆盖且无多余键', missing.length === 0 && Object.keys(taskEntry.vars).sort().join(',') === tplVars.sort().join(','), `缺失: ${missing.join(',')}`)
      check('C7 LLM_ADAPTERS 含 impressionLayout 且 id 一致', typeof tasks.LLM_ADAPTERS.impressionLayout === 'object' && tasks.LLM_ADAPTERS.impressionLayout.id === 'impressionLayout')
      check('C7 mergeStrategy = concat-dedup-order', imp.mergeStrategy === 'concat-dedup-order')

      const kof = imp.keyOf
      check('C7 keyOf：{parentId:"novel-world"} → "layout:novel-world"', kof({ parentId: 'novel-world' }) === 'layout:novel-world')
      check('C7 keyOf：字符串 → warn: 前缀（避免与 layout 相消）', kof('某 warning') === 'warn:某 warning')
      check('C7 keyOf：无 parentId 对象 → JSON 串兜底', kof({ foo: 1 }) === '{"foo":1}')
      check('C7 与导出的 impressionLayoutKeyOf 同一函数', tasks.impressionLayoutKeyOf === kof)

      // 引擎合并模拟：两批各产 novel-world 组 → 按 parentId 首现获胜
      const merged = mg.mergeOutputs('concat-dedup-order', [
        JSON.stringify({ gridSize: 100, layouts: [{ parentId: 'novel-world', mode: 'separated', placements: [{ id: '1', rect: { x: 5, y: 5, width: 40, height: 40 } }] }] }),
        JSON.stringify({ gridSize: 100, layouts: [{ parentId: 'novel-world', mode: 'separated', placements: [{ id: '5', rect: { x: 50, y: 10, width: 45, height: 80 } }] }, { parentId: '5', mode: 'partition', placements: [{ id: '6', rect: { x: 10, y: 10, width: 30, height: 30 } }] }] })
      ], kof)
      const d = imp.parse(merged)
      check('C7 引擎合并模拟：跨批重复父区域首现获胜（novel-world 仅留首批的 1；5/6 组保留）', d.layout.layouts.length === 2 && d.layout.layouts[0].placements.map((p) => p.id).join(',') === '1' && d.layout.layouts[1].parentId === '5', JSON.stringify(d.layout.layouts).slice(0, 160))
    }

    // =====================================================================
    // D · plotLocation
    // =====================================================================
    console.log('\nD · plotLocation 适配器')
    const ploc = tasks.plotLocationAdapter

    // ---- D1. inputText：带行号原文 ----
    {
      const rt = makeRt('plotLocation', { global: false, chunkIndex: 2, chunkChapters: CHUNK2_CHAPTERS, ws })
      const input = await ploc.inputText(rt)
      check('D1 inputText 含章节包装【原文行：1-2】/【原文行：1-1】', input.includes('【原文行：1-2】') && input.includes('【原文行：1-1】'), input.slice(0, 80))
      check('D1 inputText 各行带行号（各章从 1 重新编号）', input.includes('1 艾莉娜搭上便车。') && input.includes('2 车厢内铺着柔软垫子。') && input.includes('1 艾莉娜在街市啃面包闲逛。'))
    }

    // ---- D2. buildMessages：恰 3 条（原文单独喂）+ 5 变量内容 ----
    {
      const renderLog = []
      const rt = makeRt('plotLocation', { global: false, chunkIndex: 2, chunkChapters: CHUNK2_CHAPTERS, ws, renderLog })
      const input = await ploc.inputText(rt)
      const msgs = await ploc.buildMessages(input, rt)
      check('D2 buildMessages 恰 3 条消息（原文单独喂）', msgs.length === 3, `实际 ${msgs.length}`)
      check('D2 角色顺序 = system / user(原文) / user(指令)', msgs[0].role === 'system' && msgs[1].role === 'user' && msgs[2].role === 'user')
      check('D2 第二条 = 带行号原文（与 inputText 逐字相同）', msgs[1].content === input)
      check('D2 三条消息均无 `{{` 残留', msgs.every((m) => !m.content.includes('{{')))
      check('D2 指令含「当前 chunk 原文：见前面的带行号 user 消息」', msgs[2].content.includes('当前 chunk 原文：见前面的带行号 user 消息'))

      const taskEntry = renderLog.find((r) => r.name === 'plot_location_user_prompt')
      check('D2 渲染了 plot_location_user_prompt', !!taskEntry)
      const v = taskEntry?.vars ?? {}
      check('D2 chunkIndex = 2', v.chunkIndex === 2)
      check('D2 chapterSeqs = "5,6"（join 字符串同 chunkLocationSummary 口径）', v.chapterSeqs === '5,6', JSON.stringify(v.chapterSeqs))
      const mem = JSON.parse(v.chunkReadingMemory)
      check('D2 chunkReadingMemory = chunks 0..1 的 plot 摘要（renderMemory 三层 JSON）', Array.isArray(mem.recentMemory) && mem.recentMemory.join('|') === PLOT_SUMMARIES[0] + '|' + PLOT_SUMMARIES[1] && mem.midMemory.length === 0 && mem.longTermMemory.length === 0, JSON.stringify(mem))
      const chars = JSON.parse(v.characters)
      check('D2 characters = 本片（chunk2）draftAlign 人物，只取 id/name/aliases', chars.length === 2 && chars[0].id === 'D-2-C-0' && chars[0].name === '铃' && chars[1].name === '莉莉' && chars[1].aliases[0] === '莉莉ANA' && Object.keys(chars[0]).sort().join(',') === 'aliases,id,name', JSON.stringify(chars))
      check('D2 characters 是预序列化 JSON 字符串（非 JS 数组）', typeof v.characters === 'string')
      const tree = JSON.parse(v.mapLocationTree)
      check('D2 mapLocationTree = 完整地点树（根 novel-world，含不可展示的 3/4）', tree.id === 'novel-world' && v.mapLocationTree.includes('百合酒吧地下室'))
      const tplVars = extractTemplateVars(await readFile(join(FEATHER, 'resources', 'prompts', 'plot_location_user_prompt.txt'), 'utf8'))
      check('D2 模板占位符恰为 5 个', tplVars.sort().join(',') === 'chapterSeqs,characters,chunkIndex,chunkReadingMemory,mapLocationTree', tplVars.join(','))
      const missing = tplVars.filter((k) => !(k in v) || v[k] === undefined)
      check('D2 五个模板占位符全覆盖且无多余键', missing.length === 0 && Object.keys(v).sort().join(',') === tplVars.sort().join(','), `缺失: ${missing.join(',')}`)
    }

    // ---- D3. 无 draftAlign 产物 → 空人物 + warning 不抛 ----
    {
      const wsNoDraft = makeWorkspace(join(TEST_PARENT, 'ws-nodraft'))
      await fillWorkspace(wsNoDraft, { withDraftAlign: false })
      const rt = makeRt('plotLocation', { global: false, chunkIndex: 2, chunkChapters: CHUNK2_CHAPTERS, ws: wsNoDraft })
      const msgs = await ploc.buildMessages(await ploc.inputText(rt), rt)
      check('D3 无 draftAlign → characters 空数组 [] + rt.warnings 记一条，不抛', msgs[2].content.includes('characters：[]') && rt.warnings.length === 1 && rt.warnings[0].includes('draftAlign'), JSON.stringify(rt.warnings))
    }

    // ---- D4. parse：id 重编 + 校验 + 程序字段 ----
    {
      const rt = { chunkIndex: 2 }
      const d = ploc.parse(JSON.stringify({
        plotLocations: [
          { id: 'l1', name: '马车车厢', mapLocationId: null, identInfos: ['铺有柔软垫子'], summary: '艾莉娜搭便车前往西尔瓦诺。', sceneDescription: '车厢内铺着柔软厚实的垫子。' },
          { id: 'l2', name: '西尔瓦诺街市', mapLocationId: 42, ancId: 'M-9', summary: '', sceneDescription: '' },
          { id: 'l3', name: '', summary: '缺 name 的坏条目' },
          { name: '无 id 条目', summary: '模型漏产 id' },
          'not-an-object'
        ],
        warnings: ['模型自报警告：某场景定位不确定']
      }), rt)
      check('D4 输出 {protocol,actions,plotLocations,warnings}（协议字段在）', d.protocol === 'map-plot-v1' && Array.isArray(d.actions) && d.actions.length === 0 && Array.isArray(d.plotLocations) && Array.isArray(d.warnings), JSON.stringify(Object.keys(d)))
      check('D4 id 重编为 L-2-l1/L-2-l2/L-2-l3（rt.chunkIndex=2；只对保留条目递增连续无洞）', d.plotLocations.map((p) => p.id).join(',') === 'L-2-l1,L-2-l2,L-2-l3', d.plotLocations.map((p) => p.id).join(','))
      check('D4 模型漏产 id 的条目也分到程序 id（无 id 条目 → L-2-l3）', d.plotLocations[2].name === '无 id 条目')
      check('D4 模型自产 id（l1/l2）不保留', d.plotLocations.every((p) => !/^l\d+$/.test(p.id)))
      check('D4 缺 name 的条目跳过 + warning', !d.plotLocations.some((p) => p.name === '') && d.warnings.some((w) => w.includes('缺 name')), JSON.stringify(d.warnings))
      check('D4 mapLocationId 非字符串（null/42）被省略', !('mapLocationId' in d.plotLocations[0]) && !('mapLocationId' in d.plotLocations[1]))
      check('D4 ancId 非空字符串保留（M-9）', d.plotLocations[1].ancId === 'M-9')
      check('D4 identInfos 字符串数组；summary/sceneDescription 缺省空串', JSON.stringify(d.plotLocations[0].identInfos) === '["铺有柔软垫子"]' && d.plotLocations[1].summary === '' && d.plotLocations[1].sceneDescription === '')
      check('D4 每条带 chunkIndex=2（view.ts:432 读）', d.plotLocations.every((p) => p.chunkIndex === 2))
      check('D4 条目字段集严格 = id/name/(mapLocationId)?/(ancId)?/identInfos/summary/sceneDescription/chunkIndex', Object.keys(d.plotLocations[1]).sort().join(',') === 'ancId,chunkIndex,id,identInfos,name,sceneDescription,summary', Object.keys(d.plotLocations[1]).join(','))
      check('D4 模型 warnings 被收取', d.warnings.includes('模型自报警告：某场景定位不确定'))
      const d0 = ploc.parse(JSON.stringify({ plotLocations: [{ id: 'l1', name: '场景甲' }] }), { chunkIndex: 0 })
      check('D4 chunkIndex=0 → L-0-l1（对齐真实数据形态）', d0.plotLocations[0].id === 'L-0-l1')
      const dNoRt = ploc.parse(JSON.stringify({ plotLocations: [{ id: 'l1', name: '场景乙' }] }))
      check('D4 rt 缺失 → chunkIndex 按 0 兜底（L-0-l1），不抛', dNoRt.plotLocations[0].id === 'L-0-l1')
      const dEmpty = ploc.parse(JSON.stringify({ plotLocations: [] }))
      check('D4 空 plotLocations → 空数组 + protocol/actions 仍在', dEmpty.plotLocations.length === 0 && dEmpty.protocol === 'map-plot-v1' && dEmpty.actions.length === 0)
      const dirties = ['not a json at all', '{}', '{"plotLocations":"not-array"}', '']
      let noThrow = true
      let shapeOk = true
      for (const dirty of dirties) {
        try {
          const dd = ploc.parse(dirty, rt)
          const ok = dd.protocol === 'map-plot-v1' && Array.isArray(dd.actions) && Array.isArray(dd.plotLocations) && dd.plotLocations.length === 0 && Array.isArray(dd.warnings)
          if (!ok) {
            shapeOk = false
            console.log(`     兜底形状异常：${JSON.stringify(dirty).slice(0, 40)} → ${JSON.stringify(dd).slice(0, 140)}`)
          }
          if (dirty === 'not a json at all' && typeof dd.raw !== 'string') shapeOk = false
        } catch (e) {
          noThrow = false
          console.log(`     抛崩：${JSON.stringify(dirty).slice(0, 40)} → ${e.message}`)
        }
      }
      check('D4 脏样本 raw 兜底不抛崩（protocol/actions/plotLocations 形状保持）', noThrow && shapeOk)
    }

    // ---- D5. keyOf + 注册 + 引擎合并模拟（跨批模型本地 id 不碰撞） ----
    {
      check('D5 LLM_ADAPTERS 含 plotLocation 且 id 一致', typeof tasks.LLM_ADAPTERS.plotLocation === 'object' && tasks.LLM_ADAPTERS.plotLocation.id === 'plotLocation')
      check('D5 mergeStrategy = concat-dedup-order', ploc.mergeStrategy === 'concat-dedup-order')
      const kof = ploc.keyOf
      check('D5 keyOf：程序 id L-2-l1 → "L-2-l1"', kof({ id: 'L-2-l1' }) === 'L-2-l1')
      check('D5 keyOf：模型本地 id 按 name 键（防跨批碰撞）', kof({ id: 'l1', name: '马车车厢' }) === 'name:马车车厢')
      check('D5 keyOf：无 name 对象 → JSON 串兜底', kof({ id: 'l1' }) === '{"id":"l1"}')
      check('D5 keyOf：字符串 → warn: 前缀', kof('w') === 'warn:w')
      check('D5 与导出的 plotLocationKeyOf 同一函数', tasks.plotLocationKeyOf === kof)

      // 引擎合并模拟（合并先于 parse，keyOf 看到的是模型本地 id）：
      // 两批各自从 l1 起编号 → 若按 id 去重会互相碰撞丢条目；按 name 键 3 条全留
      const merged = mg.mergeOutputs('concat-dedup-order', [
        JSON.stringify({ plotLocations: [{ id: 'l1', name: '马车车厢' }, { id: 'l2', name: '西尔瓦诺街市' }] }),
        JSON.stringify({ plotLocations: [{ id: 'l1', name: '王座大厅' }] })
      ], kof)
      const d = ploc.parse(merged, { chunkIndex: 2 })
      check('D5 引擎合并模拟：跨批模型本地短 id 不碰撞（3 条全留并重编 L-2-l1..l3）', d.plotLocations.map((p) => p.id).join(',') === 'L-2-l1,L-2-l2,L-2-l3' && d.plotLocations[2].name === '王座大厅', JSON.stringify(d.plotLocations.map((p) => p.id)))
    }

    // =====================================================================
    // E · 接口兼容（T6-F ① 加性可选签名的向后兼容实证）
    // =====================================================================
    console.log('\nE · 接口兼容（parse 单参调用）')
    {
      const cases = [
        ['seg', tasks.segAdapter, '{"output":{"chapters":[]}}'],
        ['cacheWarming', tasks.cacheWarmingAdapter, '{"answer":"ok"}'],
        ['plot', tasks.plotAdapter, '{"chunkSummary":"摘要","chapters":[]}'],
        ['locationTree', tasks.locationTreeAdapter, '{"upserts":[],"merges":[]}'],
        ['worldImpression', tasks.worldImpressionAdapter, '{"worldImpression":"印象","novelGenre":"类型","locationIconArtStyle":"风格"}'],
        ['draft', tasks.draftAdapter, '{"characters":[],"factions":[]}'],
        ['batchLocationSummary', tasks.batchLocationSummaryAdapter, '{"batchLocationSummary":"x"}'],
        ['impressionLayout', tasks.impressionLayoutAdapter, '{"gridSize":100,"layouts":[]}']
      ]
      let noThrow = true
      for (const [name, ad, sample] of cases) {
        try {
          ad.parse(sample) // 单参调用（老适配器不收 rt）
        } catch (e) {
          noThrow = false
          console.log(`     抛崩：${name} → ${e.message}`)
        }
      }
      check('E1 老适配器以单参调用 parse 不崩（8 条全覆盖）', noThrow)
      const d = tasks.segAdapter.parse('{"output":{"chapters":[]}}')
      check('E1 segAdapter 单参 parse 形状不变', !!d.output && Array.isArray(d.warnings))
      const two = tasks.plotLocationAdapter.parse('{"plotLocations":[{"id":"l1","name":"场景"}]}', { chunkIndex: 7 })
      check('E2 plotLocation 双参 parse 用 rt.chunkIndex 重编（L-7-l1）', two.plotLocations[0].id === 'L-7-l1')
      check('E3 三个新适配器均已注册（batchLocationSummary/impressionLayout/plotLocation）', ['batchLocationSummary', 'impressionLayout', 'plotLocation'].every((k) => tasks.LLM_ADAPTERS[k]?.id === k))
    }
  } finally {
    await rm(TEST_PARENT, { recursive: true, force: true })
  }

  console.log(`\n==== T6-F 地图/空间链验证：${passed} 通过 / ${failed} 失败 ====`)
  if (failed === 0) {
    console.log('T6-F MAP CHAIN VERIFY PASS')
  } else {
    console.log('T6-F MAP CHAIN VERIFY FAIL')
  }
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('ERROR:', e?.stack ?? e?.message ?? e)
  process.exitCode = 2
})

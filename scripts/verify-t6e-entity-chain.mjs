/**
 * T6-E · 实体合并链验证脚本（merge / mergeReview / canonical / draftAlign）
 * （node 直跑，**不启动 Electron**；零新增依赖）。
 *
 * 覆盖五组（对应 T6-E spec 验收项）：
 *  A. merge 本地步骤：2 个 chunk 的 draft 产物（同名合并 / name∈aliases 合并 /
 *     aliases 相交合并 / stopNames 三种交互 / 停用别名不合并）→ 调 step.run(mockRt)
 *     → 组数、keepId、draftIds、chunkSummaryList、summary 取最新 chunk、
 *     importanceLevel 取最高、identInfos/aliases 并集去重、
 *     identityMatchStopNames 并集、输出按 (chunk,n) **数值**升序（专门造
 *     D-0-C-10 与 D-0-C-2 验证数值排序）、value 双形态（{data} 信封 / 裸值）；
 *     空 draft → 四类空 + warning 不抛崩；draft 空 → 回退 draftCharacter +
 *     draftOther（拆分模式汇总）；
 *  B. mergeReview 适配器：inputText 含该类目实体与 id、无 merge → 可读错误、空类目
 *     → 可读错误；buildMessages 恰 2 条消息、无 `{{` 残留、模板占位符全覆盖
 *     （读模板文件提取）、worldObjs/stopNames 为预序列化 JSON 字符串、
 *     wikiSectionType 中文栏目名；parse 正样本（含 ```json 包裹）结构正确、脏样本
 *     （ids 长度1 / 缺 reason / 非 JSON / 缺键）→ 跳过或 raw 兜底不抛崩；注册
 *     完整性 ×4（4 键同一对象）；feature 兜底（id 冒号后缀解析）；keyOf 语义；
 *  C. canonical 本地步骤：merge 产物 + 手工 mergeReview 产物（characters 一组
 *     [D-0-C-2, D-0-C-10] → keep D-0-C-2）→ 被合并实体移除、keep 实体 draftIds
 *     尾部追加、chunkSummaryList 合并升序、summary 不重算、aliases 并集；mapping
 *     含全部 draftId→终态（恒等 + 被合并指向 keepId）；`:plan` 变体条目被过滤
 *     （造假 plan 条目断言不参与）；无效 id 组跳过 + warning；merge 缺失 → 空 +
 *     warning；
 *  D. draftAlign 本地步骤：mock rt（chunkIndex=1）→ 映射命中实体 id 改写、
 *     aliases 整体换 canonical 的、draftIds=[自身]；未命中原样；chunkSummaryList
 *     重建为 [{chunkIndex:1,…}]；输出无 identityMatchStopNames；重算 draftId 与
 *     merge 分配一致性（同位置同规则 → 必然命中 mapping）；本 chunk 无 draft →
 *     四类空 + warning；canonical 缺失 → 全原样 + warning；
 *  E. 链端到端：merge →（合成 mergeGroups 写库）→ canonical → draftAlign 全链跑
 *     一遍，断言最终 draftAlign 输出的 id 全部落在 canonical mapping 的值域内。
 *
 * 姿势与 `scripts/verify-t6d-drafts.mjs` 一致：`createRequire(feather/package.json)`
 * 取项目已装的 esbuild，把入口打成单文件 ESM 写入临时目录后 `pathToFileURL` 动态
 * import；electron 以最小桩替换（app.getAppPath → 项目根，使 prompt-loader 的
 * resourcesDir() 定位到 `resources/prompts`）。
 *
 * 临时目录**只准碰** `D:/AI/tx/feather-t6e-test/`（跑完 rm -rf 清掉）；
 * 绝不读写真实工作库目录（7 本真实库只读）。
 *
 * 用法：node scripts/verify-t6e-entity-chain.mjs
 */
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(here, '..')
/** 唯一允许触碰的临时父目录（跑完 rm -rf 清掉） */
const TEST_PARENT = 'D:/AI/tx/feather-t6e-test'
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

/** 合成 TaskDef（只填适配器/步骤会碰的字段）。 */
function taskDef(id, feature = 'always') {
  return {
    id,
    kind: id,
    code: id,
    label: id,
    feature,
    execution: '',
    input: '',
    output: '',
    model: true,
    thinking: 'disabled',
    effort: 1,
    maxTokens: 60000,
    global: false,
    setting: '',
    dependsOn: []
  }
}

// ---------------------------------------------------------------------------
// 临时工作库（字段按真实 ShardRow / ShardEnvelope 形状；7 本真实库只读，绝不触碰）
// ---------------------------------------------------------------------------

const PKG = 'pkg-t6e'
const REV = 'rev-t6e'

/** 一个小工作库：writeShard 写真分片 + 手工维护 index.json 的 shards 登记。 */
function makeWorkspace(root) {
  const idx = {
    indexVersion: 1,
    format: 'txt2world-workspace',
    pkgId: PKG,
    title: 'T6-E 验证书',
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
function makeRt(id, { feature = 'always', chunkIndex = null, ws, renderLog = [] } = {}) {
  return {
    task: taskDef(id, feature),
    pkgId: PKG,
    revisionId: REV,
    chunkIndex,
    instanceKey: `${PKG}:${REV}:${id}${chunkIndex === null ? '' : `:${chunkIndex}`}`,
    chunkText: '',
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

let tasks
let localSteps
let up
let pl
let sh

// ---------------------------------------------------------------------------
// 测试数据：2 个 chunk 的 draft 产物（合并案例全覆盖）
// ---------------------------------------------------------------------------

/** chunk0 characters 第 3..9 位：7 个互不合并的填充实体（用于数值排序断言）。 */
function fillerEntities() {
  return ['填充三', '填充四', '填充五', '填充六', '填充七', '填充八', '填充九'].map((name) => ({
    name,
    importanceLevel: 'LOW',
    summary: `第0章：${name}路过。`,
    identInfos: [],
    aliases: []
  }))
}

const CHUNK0_DRAFT = {
  characters: [
    { name: '艾莉娜', importanceLevel: 'CORE', summary: '第0章：艾莉娜初登场，举起圣剑。', identInfos: ['银发剑士', '灵魂互换者'], aliases: ['艾莉'], lifeStatus: '活着', wikiSectionType: '人物', characterSpriteInfos: [{ appearanceSummary: '金发少女', visualKeywords: ['金发'], sex: '女' }] },
    { name: '圣剑酱', importanceLevel: 'HIGH', summary: '第0章：圣剑酱守护勇者。', identInfos: ['剑之精灵'], aliases: [] },
    { name: '测试二号', importanceLevel: 'LOW', summary: '第0章：测试二号路过。', identInfos: [], aliases: [] },
    ...fillerEntities(),
    { name: '测试十号', importanceLevel: 'MEDIUM', summary: '第0章：测试十号第十个出场。', identInfos: [], aliases: [] },
    { name: '队长', importanceLevel: 'TEMP', summary: '第0章：队长登场。', identInfos: [], aliases: [] },
    { name: '别名相交甲', importanceLevel: 'LOW', summary: '第0章：甲持有共称号。', identInfos: [], aliases: ['共称号'] },
    { name: '停词别名丙', importanceLevel: 'LOW', summary: '第0章：丙别名是老板。', identInfos: [], aliases: ['老板'] }
  ],
  factions: [],
  items: [],
  creatures: [],
  identityMatchStopNames: ['队长']
}

const CHUNK1_DRAFT = {
  characters: [
    { name: '艾莉娜', importanceLevel: 'HIGH', summary: '第1章：艾莉娜与圣剑酱交换灵魂。', identInfos: ['互换后'], aliases: ['艾莉'], lifeStatus: '活着', characterSpriteInfos: [{ appearanceSummary: '互换后形象', visualKeywords: ['互换'], sex: '女' }] },
    { name: '圣剑酱·交换灵魂', importanceLevel: 'HIGH', summary: '第1章：圣剑酱与艾莉娜互换灵魂。', identInfos: ['互换者'], aliases: ['圣剑酱'] },
    { name: '测试十号', importanceLevel: 'LOW', summary: '第1章：测试十号再登场。', identInfos: [], aliases: [] },
    { name: '队长', importanceLevel: 'TEMP', summary: '第1章：队长再登场。', identInfos: [], aliases: [] },
    { name: '别名相交乙', importanceLevel: 'MEDIUM', summary: '第1章：乙也持有共称号。', identInfos: [], aliases: ['共称号'] },
    { name: '停词别名丁', importanceLevel: 'LOW', summary: '第1章：丁别名也是老板。', identInfos: [], aliases: ['老板'] }
  ],
  factions: [
    { name: '王国', importanceLevel: 'CORE', summary: '第1章：王国扩张。', identInfos: [], aliases: [] },
    { name: '冒险者公会', importanceLevel: 'HIGH', summary: '第1章：公会壮大。', identInfos: [], aliases: [] },
    { name: '王都', importanceLevel: 'MEDIUM', summary: '第1章：王都繁华。', identInfos: [], aliases: ['王城'] },
    { name: '王城', importanceLevel: 'MEDIUM', summary: '第1章：王城夜景。', identInfos: [], aliases: [] }
  ],
  items: [{ name: '圣剑', importanceLevel: 'CORE', summary: '第1章：圣剑发光。', identInfos: [], aliases: [] }],
  creatures: [{ name: '史莱姆', importanceLevel: 'LOW', summary: '第1章：史莱姆出现。', identInfos: [], aliases: [] }],
  identityMatchStopNames: ['队长', '老板']
}

/** 主工作库（A/B/C/D 共用）：draft 两个 chunk——chunk0 用 {data} 信封、chunk1 用裸值（双形态）。 */
async function seedMainWorkspace(ws) {
  await ws.reset()
  await ws.writeResults('records/results/draft.json', [
    { key: `${PKG}:${REV}:draft:0`, value: llmEnvelope(CHUNK0_DRAFT) },
    { key: `${PKG}:${REV}:draft:1`, value: CHUNK1_DRAFT }
  ])
}

async function main() {
  await rm(TEST_PARENT, { recursive: true, force: true })
  await mkdir(BUILD_DIR, { recursive: true })
  console.log(`临时目录：${TEST_PARENT}\n`)

  tasks = await loadModule('src/main/pipeline/tasks/index.ts', 'tasks-index.mjs')
  localSteps = await loadModule('src/main/pipeline/tasks/local.ts', 'local-steps.mjs')
  up = await loadModule('src/main/pipeline/upstream.ts', 'upstream.mjs')
  pl = await loadModule('src/main/pipeline/prompt-loader.ts', 'prompt-loader.mjs')
  sh = await loadModule('src/main/workspace/shards.ts', 'shards.mjs')

  const wsMain = makeWorkspace(join(TEST_PARENT, 'ws-main'))
  const wsEmpty = makeWorkspace(join(TEST_PARENT, 'ws-empty'))
  const wsFallback = makeWorkspace(join(TEST_PARENT, 'ws-fallback'))
  const wsNoCanonical = makeWorkspace(join(TEST_PARENT, 'ws-no-canonical'))
  const wsE2E = makeWorkspace(join(TEST_PARENT, 'ws-e2e'))

  try {
    // =====================================================================
    // A · merge 本地步骤
    // =====================================================================
    console.log('A · merge（机械合并实体草稿）')
    await seedMainWorkspace(wsMain)

    const rtMerge = makeRt('merge', { ws: wsMain })
    const mergeOut = await localSteps.mergeStep.run(rtMerge)
    const mo = mergeOut

    check('A1 输出键恰为四类 + identityMatchStopNames', Object.keys(mo).join(',') === 'characters,factions,items,creatures,identityMatchStopNames', Object.keys(mo).join(','))
    check('A1 characters=15（5 组合并 + 10 单例）', mo.characters.length === 15, `实际 ${mo.characters.length}`)
    check('A1 factions=3（王都+王城合并）', mo.factions.length === 3, `实际 ${mo.factions.length}`)
    check('A1 items=1 / creatures=1', mo.items.length === 1 && mo.creatures.length === 1)
    check('A1 不抛崩且无 warning（正常路径）', rtMerge.warnings.length === 0, JSON.stringify(rtMerge.warnings))

    // ---- A2. 分组与 keepId ----
    const byId = new Map(mo.characters.map((c) => [c.id, c]))
    check('A2 艾莉娜两组合并 keepId=D-0-C-0（name 相等）', byId.has('D-0-C-0') && JSON.stringify(byId.get('D-0-C-0').draftIds) === '["D-0-C-0","D-1-C-0"]', JSON.stringify(byId.get('D-0-C-0')?.draftIds))
    check('A2 圣剑酱与「圣剑酱·交换灵魂」合并 keepId=D-0-C-1（name∈aliases）', JSON.stringify(byId.get('D-0-C-1').draftIds) === '["D-0-C-1","D-1-C-1"]', JSON.stringify(byId.get('D-0-C-1')?.draftIds))
    check('A2 测试十号合并 keepId=D-0-C-10（name 相等）', JSON.stringify(byId.get('D-0-C-10').draftIds) === '["D-0-C-10","D-1-C-2"]', JSON.stringify(byId.get('D-0-C-10')?.draftIds))
    check('A2 队长两组合并（name 相等永远算数，即使命中 stopNames）', JSON.stringify(byId.get('D-0-C-11').draftIds) === '["D-0-C-11","D-1-C-3"]', JSON.stringify(byId.get('D-0-C-11')?.draftIds))
    check('A2 别名相交甲/乙合并 keepId=D-0-C-12（aliases 相交）', JSON.stringify(byId.get('D-0-C-12').draftIds) === '["D-0-C-12","D-1-C-4"]', JSON.stringify(byId.get('D-0-C-12')?.draftIds))
    check('A2 停词别名丙/丁**不**合并（老板 命中 stopNames）', byId.has('D-0-C-13') && byId.has('D-1-C-5') && JSON.stringify(byId.get('D-0-C-13').draftIds) === '["D-0-C-13"]' && JSON.stringify(byId.get('D-1-C-5').draftIds) === '["D-1-C-5"]')

    // ---- A3. 组内字段规则 ----
    const ellena = byId.get('D-0-C-0')
    check('A3 艾莉娜 chunkSummaryList 按 chunkIndex 升序两条', JSON.stringify(ellena.chunkSummaryList) === JSON.stringify([{ chunkIndex: 0, summaryText: '第0章：艾莉娜初登场，举起圣剑。' }, { chunkIndex: 1, summaryText: '第1章：艾莉娜与圣剑酱交换灵魂。' }]), JSON.stringify(ellena.chunkSummaryList))
    check('A3 艾莉娜 summary 取最新 chunk（不拼接）', ellena.summary === '第1章：艾莉娜与圣剑酱交换灵魂。')
    check('A3 艾莉娜 importanceLevel 取组内最高（CORE>HIGH）', ellena.importanceLevel === 'CORE')
    check('A3 艾莉娜 identInfos 并集保序去重', JSON.stringify(ellena.identInfos) === '["银发剑士","灵魂互换者","互换后"]', JSON.stringify(ellena.identInfos))
    check('A3 艾莉娜 aliases 并集去重（两边都有「艾莉」→一条）', JSON.stringify(ellena.aliases) === '["艾莉"]', JSON.stringify(ellena.aliases))
    check('A3 艾莉娜 lifeStatus 最新非空', ellena.lifeStatus === '活着')
    check('A3 艾莉娜 characterSpriteInfos 按 chunk 序拼接且带来源 chunkIndex', ellena.characterSpriteInfos.length === 2 && ellena.characterSpriteInfos[0].chunkIndex === 0 && ellena.characterSpriteInfos[1].chunkIndex === 1 && ellena.characterSpriteInfos[1].appearanceSummary === '互换后形象', JSON.stringify(ellena.characterSpriteInfos))
    check('A3 艾莉娜 其余字段取 keepId 实体（name/wikiSectionType）', ellena.name === '艾莉娜' && ellena.wikiSectionType === '人物')
    check('A3 圣剑酱 keep 实体 name 取 keepId 的「圣剑酱」、aliases 含被合并者的', byId.get('D-0-C-1').name === '圣剑酱' && JSON.stringify(byId.get('D-0-C-1').aliases) === '["圣剑酱"]')
    check('A3 测试十号 importanceLevel 取最高（MEDIUM>LOW）', byId.get('D-0-C-10').importanceLevel === 'MEDIUM')

    // ---- A4. factions：一方 name ∈ 另一方 aliases ----
    const wangdu = mo.factions.find((f) => f.id === 'D-1-factions-2')
    check('A4 王都+王城合并 keepId=D-1-factions-2（王城∈王都 aliases）', JSON.stringify(wangdu.draftIds) === '["D-1-factions-2","D-1-factions-3"]', JSON.stringify(wangdu?.draftIds))
    check('A4 王都 keep 实体 aliases 并集 = [王城]', JSON.stringify(wangdu.aliases) === '["王城"]', JSON.stringify(wangdu.aliases))
    check('A4 王都 name 取 keep 实体、summary 取同 chunk 序号大者（最新）', wangdu.name === '王都' && wangdu.summary === '第1章：王城夜景。', wangdu.summary)
    check('A4 factions ids = [王国, 冒险者公会, 王都]', mo.factions.map((f) => f.id).join(',') === 'D-1-factions-0,D-1-factions-1,D-1-factions-2', mo.factions.map((f) => f.id).join(','))

    // ---- A5. 顶层 stopNames 并集 + 数值排序 ----
    check('A5 identityMatchStopNames 并集保序去重 = [队长,老板]', JSON.stringify(mo.identityMatchStopNames) === '["队长","老板"]', JSON.stringify(mo.identityMatchStopNames))
    const charIds = mo.characters.map((c) => c.id)
    const expectedIds = ['D-0-C-0', 'D-0-C-1', 'D-0-C-2', 'D-0-C-3', 'D-0-C-4', 'D-0-C-5', 'D-0-C-6', 'D-0-C-7', 'D-0-C-8', 'D-0-C-9', 'D-0-C-10', 'D-0-C-11', 'D-0-C-12', 'D-0-C-13', 'D-1-C-5']
    check('A5 输出按 keepId (chunk,n) **数值**升序（D-0-C-10 在 D-0-C-2 之后）', charIds.join(',') === expectedIds.join(','), charIds.join(','))
    check('A5 反证：字符串排序会把 D-0-C-10 排到第 3 位（实测序≠字符串序）', charIds[2] === 'D-0-C-2' && charIds[10] === 'D-0-C-10')

    // ---- A6. 空 draft → 空输出 + warning 不抛崩 ----
    {
      await wsEmpty.reset()
      const rt = makeRt('merge', { ws: wsEmpty })
      let out = null
      let threw = false
      try {
        out = await localSteps.mergeStep.run(rt)
      } catch {
        threw = true
      }
      check('A6 空 draft 不抛崩', !threw)
      check('A6 空 draft → 四类空 + stopNames []', out && out.characters.length === 0 && out.factions.length === 0 && out.items.length === 0 && out.creatures.length === 0 && out.identityMatchStopNames.length === 0, JSON.stringify(out))
      check('A6 空 draft → warning 提示降级', rt.warnings.length === 1 && rt.warnings[0].includes('draft 产物为空'), JSON.stringify(rt.warnings))
    }

    // ---- A7. 回退：draft 空 → draftCharacter + draftOther（拆分模式汇总）----
    {
      await wsFallback.reset()
      await wsFallback.writeResults('records/results/draftCharacter.json', [
        { key: `${PKG}:${REV}:draftCharacter:0`, value: llmEnvelope({ characters: [{ name: '关羽', importanceLevel: 'CORE', summary: '第0章：关羽温酒斩华雄。', identInfos: ['字云长'], aliases: ['关云长'] }], identityMatchStopNames: ['主公'] }) }
      ])
      await wsFallback.writeResults('records/results/draftOther.json', [
        { key: `${PKG}:${REV}:draftOther:0`, value: llmEnvelope({ factions: [{ name: '桃园结义', importanceLevel: 'HIGH', summary: '第0章：桃园结义。', identInfos: ['刘关张'], aliases: [] }], items: [{ name: '青龙偃月刀', importanceLevel: 'HIGH', summary: '第0章：青龙偃月刀。', identInfos: ['刀'], aliases: [] }], creatures: [{ name: '赤兔马', importanceLevel: 'MEDIUM', summary: '第0章：赤兔马。', identInfos: [], aliases: [] }] }) }
      ])
      const rt = makeRt('merge', { ws: wsFallback })
      const out = await localSteps.mergeStep.run(rt)
      check('A7 回退后 characters 来自 draftCharacter（id 按位置分配 D-0-C-0）', out.characters.length === 1 && out.characters[0].id === 'D-0-C-0' && out.characters[0].name === '关羽', JSON.stringify(out.characters))
      check('A7 回退后 factions/items/creatures 来自 draftOther（id 规则一致）', out.factions[0].id === 'D-0-factions-0' && out.items[0].id === 'D-0-items-0' && out.creatures[0].id === 'D-0-creatures-0', JSON.stringify([out.factions[0]?.id, out.items[0]?.id, out.creatures[0]?.id]))
      check('A7 回退后 stopNames 来自 draftCharacter', JSON.stringify(out.identityMatchStopNames) === '["主公"]', JSON.stringify(out.identityMatchStopNames))
      check('A7 回退路径不记 warning（正常拆分模式）', rt.warnings.length === 0, JSON.stringify(rt.warnings))
    }

    // =====================================================================
    // B · mergeReview 适配器
    // =====================================================================
    console.log('\nB · mergeReview 适配器')

    // 把 A 的 merge 产物写进主工作库（本地信封），供 B/C/D 真读
    await wsMain.writeResults('records/results/merge.json', [{ key: `${PKG}:${REV}:merge`, value: localEnvelope(mo) }])

    const rtReview = makeRt('mergeReview:characters', { feature: 'characters', ws: wsMain })
    const reviewInput = await tasks.mergeReviewAdapter.inputText(rtReview)
    check('B1 inputText 含该类目实体与 id', reviewInput.includes('D-0-C-0') && reviewInput.includes('艾莉娜') && reviewInput.includes('D-1-C-5'), reviewInput.slice(0, 120))
    let parsedInput = null
    let parseThrew = false
    try {
      parsedInput = JSON.parse(reviewInput)
    } catch {
      parseThrew = true
    }
    check('B1 inputText 是预序列化的合法 JSON 字符串（数组 15 条）', !parseThrew && Array.isArray(parsedInput) && parsedInput.length === 15)

    // ---- B2. buildMessages：2 条消息 / 无残留 / 占位符全覆盖 ----
    {
      const renderLog = []
      const rt = makeRt('mergeReview:characters', { feature: 'characters', ws: wsMain, renderLog })
      const msgs = await tasks.mergeReviewAdapter.buildMessages(reviewInput, rt)
      check('B2 buildMessages 恰 2 条消息（素材全嵌指令，无外部 user 消息）', msgs.length === 2, `实际 ${msgs.length}`)
      check('B2 角色顺序 = system / user', msgs[0].role === 'system' && msgs[1].role === 'user')
      check('B2 system 来自 common_system_prompt', msgs[0].content.includes('【共同任务边界】'))
      check('B2 两条消息均无 `{{` 残留', msgs.every((m) => !m.content.includes('{{')))
      check('B2 指令含 wikiSectionType 中文栏目名「人物」', msgs[1].content.includes('统一 wikiSectionType：人物'), msgs[1].content.slice(-200))
      check('B2 指令含 worldObjs 实体与 id', msgs[1].content.includes('D-0-C-0') && msgs[1].content.includes('艾莉娜'))
      check('B2 指令含 identityMatchStopNames（队长/老板）', msgs[1].content.includes('队长') && msgs[1].content.includes('老板'))

      // 模板占位符全覆盖（读模板文件提取——防模板漂移）
      const tplVars = extractTemplateVars(await readFile(join(FEATHER, 'resources', 'prompts', 'wiki_entity_merge_review_user_prompt.txt'), 'utf8'))
      check('B2 模板占位符集合 = wikiSectionType,worldObjs,identityMatchStopNames', tplVars.slice().sort().join(',') === 'identityMatchStopNames,wikiSectionType,worldObjs', tplVars.join(','))
      const taskEntry = renderLog.find((r) => r.name === 'wiki_entity_merge_review_user_prompt')
      check('B2 渲染了 wiki_entity_merge_review_user_prompt', !!taskEntry)
      const missing = tplVars.filter((v) => !(v in taskEntry.vars) || taskEntry.vars[v] === undefined)
      check('B2 模板占位符全覆盖（无缺失）', missing.length === 0, `缺失: ${missing.join(',')}`)
      check('B2 传入 vars 无多余键（与模板占位符一致）', Object.keys(taskEntry.vars).sort().join(',') === tplVars.sort().join(','), Object.keys(taskEntry.vars).join(','))
      check('B2 wikiSectionType 传「人物」（中文栏目名映射）', taskEntry.vars.wikiSectionType === '人物')
      let objsOk = false
      let stopsOk = false
      try {
        objsOk = Array.isArray(JSON.parse(taskEntry.vars.worldObjs)) && JSON.parse(taskEntry.vars.worldObjs).length === 15
        stopsOk = JSON.stringify(JSON.parse(taskEntry.vars.identityMatchStopNames)) === '["队长","老板"]'
      } catch {
        /* 交由断言报错 */
      }
      check('B2 worldObjs vars 是合法 JSON 字符串（数组 15 条）', objsOk, String(taskEntry.vars.worldObjs).slice(0, 80))
      check('B2 identityMatchStopNames vars 是合法 JSON 字符串（merge 顶层透传）', stopsOk, String(taskEntry.vars.identityMatchStopNames).slice(0, 80))
    }

    // ---- B3. 类目映射（其余 3 类目）----
    for (const [cat, zh] of [['factions', '势力'], ['items', '物品'], ['creatures', '生物']]) {
      const rt = makeRt(`mergeReview:${cat}`, { feature: cat, ws: wsMain })
      const msgs = await tasks.mergeReviewAdapter.buildMessages('[]', rt)
      check(`B3 ${cat} → wikiSectionType「${zh}」`, msgs[1].content.includes(`统一 wikiSectionType：${zh}`))
    }

    // ---- B4. feature 兜底（id 冒号后缀解析）----
    {
      const rt = makeRt('mergeReview:factions', { feature: '', ws: wsMain })
      const input = await tasks.mergeReviewAdapter.inputText(rt)
      check('B4 feature 缺失 → 从 id 后缀解析类目（factions 3 条）', input.includes('D-1-factions-0') && input.includes('王国'), input.slice(0, 80))
    }

    // ---- B5. 无 merge / 空类目 → 可读错误 ----
    {
      const rt = makeRt('mergeReview:characters', { feature: 'characters', ws: wsEmpty })
      let msg = ''
      try {
        await tasks.mergeReviewAdapter.inputText(rt)
      } catch (e) {
        msg = e?.message ?? ''
      }
      check('B5 无 merge 产物 → 可读错误（含 mergeReview:characters 与 merge）', msg.includes('mergeReview:characters') && msg.includes('merge'), msg)
      const rt2 = makeRt('mergeReview:creatures', { feature: 'creatures', ws: wsEmpty })
      let msg2 = ''
      try {
        await tasks.mergeReviewAdapter.inputText(rt2)
      } catch (e) {
        msg2 = e?.message ?? ''
      }
      check('B5 空类目 → 可读错误', msg2.includes('需要 merge 产物'), msg2)
    }

    // ---- B6. parse 正样本 / 脏样本 ----
    {
      const adapter = tasks.mergeReviewAdapter
      const ok = adapter.parse('{"mergeGroups":[{"ids":["D-0-C-0","D-1-C-4"],"reason":"同一人"}]}')
      check('B6 正样本：mergeGroups 结构正确', JSON.stringify(ok.mergeGroups) === '[{"ids":["D-0-C-0","D-1-C-4"],"reason":"同一人"}]' && Array.isArray(ok.warnings) && ok.warnings.length === 0, JSON.stringify(ok))
      const fenced = adapter.parse('```json\n{"mergeGroups":[{"ids":["A","B"],"reason":"同一"}]}\n```')
      check('B6 ```json 包裹变体同样解析', fenced.mergeGroups.length === 1 && fenced.mergeGroups[0].ids.join(',') === 'A,B')
      const empty = adapter.parse('{"mergeGroups":[]}')
      check('B6 无合并项 → mergeGroups 空数组', empty.mergeGroups.length === 0 && empty.warnings.length === 0)
      const dirties = ['not a json at all', '', '{}', '{"mergeGroups":"x"}', '[]', 'null', '{"other":1}']
      let noThrow = true
      let shapeOk = true
      for (const dirty of dirties) {
        try {
          const dd = adapter.parse(dirty)
          if (!(dd.mergeGroups === null && Array.isArray(dd.warnings) && typeof dd.raw === 'string')) {
            shapeOk = false
            console.log(`     兜底形状异常：${JSON.stringify(dirty).slice(0, 30)} → ${JSON.stringify(dd).slice(0, 120)}`)
          }
        } catch (e) {
          noThrow = false
          console.log(`     抛崩：${JSON.stringify(dirty).slice(0, 30)} → ${e.message}`)
        }
      }
      check('B6 脏样本（非 JSON/缺 mergeGroups 键/数组/null）不抛崩', noThrow)
      check('B6 脏样本兜底形状 = mergeGroups null + warnings + raw 截断', shapeOk)
      const bad = adapter.parse('{"mergeGroups":[{"ids":["A"],"reason":"只有一个"},{"ids":["B","C"]},{"ids":["F",2,"G"],"reason":"含非字符串 id"}, "not-an-object"]}')
      check('B6 ids 长度1 / 缺 reason / 非对象组 → 跳过 + warnings（合法组保留，非字符串 id 被滤后仍≥2）', bad.mergeGroups.length === 1 && bad.mergeGroups[0].ids.join(',') === 'F,G' && bad.warnings.length === 3, JSON.stringify(bad))
      check('B6 跳过组不抛崩且 warnings 进 data', bad.warnings.every((w) => w.startsWith('mergeReview')))
    }

    // ---- B7. 注册完整性 ×4 + keyOf ----
    {
      const keys = ['mergeReview:characters', 'mergeReview:factions', 'mergeReview:items', 'mergeReview:creatures']
      check('B7 LLM_ADAPTERS 注册 4 键', keys.every((k) => typeof tasks.LLM_ADAPTERS[k] === 'object'))
      check('B7 4 键指向同一适配器对象', keys.every((k) => tasks.LLM_ADAPTERS[k] === tasks.mergeReviewAdapter))
      check('B7 适配器 id = mergeReview（与 4 条 TaskDef 的 kind 一致）', tasks.mergeReviewAdapter.id === 'mergeReview')
      check('B7 mergeStrategy = concat-dedup-order', tasks.mergeReviewAdapter.mergeStrategy === 'concat-dedup-order')
      check('B7 keyOf 是函数', typeof tasks.mergeReviewAdapter.keyOf === 'function')
      const kof = tasks.mergeReviewKeyOf
      check('B7 keyOf 组按 ids 排序后 join（[B,A]≡[A,B]）', kof({ ids: ['A', 'B'] }) === 'group:A+B' && kof({ ids: ['B', 'A'] }) === 'group:A+B', kof({ ids: ['B', 'A'] }))
      check('B7 keyOf 字符串元素 → warn: 前缀', kof('某警告') === 'warn:某警告')
      check('B7 keyOf 无 ids 对象 → JSON 串兜底', kof({ foo: 'bar' }) === '{"foo":"bar"}')
      check('B7 keyOf 标量 → String 兜底', kof(42) === '42' && kof(null) === 'null')
    }

    // =====================================================================
    // C · canonical 本地步骤
    // =====================================================================
    console.log('\nC · canonical（应用复核合并组）')

    // 手工造 mergeReview 产物：characters 一组 [D-0-C-2, D-0-C-10] → keep D-0-C-2；
    // 另造 :plan 变体条目（含阴谋组 [D-0-C-3, D-0-C-4]）与无效 id 组（应被跳过）
    await wsMain.writeResults('records/results/mergeReview.json', [
      { key: `${PKG}:${REV}:mergeReview:characters`, value: llmEnvelope({ mergeGroups: [{ ids: ['D-0-C-2', 'D-0-C-10'], reason: '测试二号与测试十号实为同一人' }, { ids: ['D-0-C-99', 'D-0-C-98'], reason: '无效 id 组' }], warnings: [] }) },
      { key: `${PKG}:${REV}:mergeReview:characters:plan`, value: { '0': [{ name: '假 plan 条目', aliases: [] }] } },
      { key: `${PKG}:${REV}:mergeReview:factions`, value: llmEnvelope({ mergeGroups: [], warnings: [] }) },
      { key: `${PKG}:${REV}:mergeReview:items`, value: llmEnvelope({ mergeGroups: [], warnings: [] }) },
      { key: `${PKG}:${REV}:mergeReview:creatures`, value: llmEnvelope({ mergeGroups: [], warnings: [] }) }
    ])

    const rtCanon = makeRt('canonical', { ws: wsMain })
    const canonOut = await localSteps.canonicalStep.run(rtCanon)
    check('C1 输出键 = objects + mapping', Object.keys(canonOut).join(',') === 'objects,mapping', Object.keys(canonOut).join(','))
    check('C1 objects 键 = 四类 + identityMatchStopNames', Object.keys(canonOut.objects).join(',') === 'characters,factions,items,creatures,identityMatchStopNames', Object.keys(canonOut.objects).join(','))
    check('C1 被合并实体 D-0-C-10 从 objects 移除（15→14）', canonOut.objects.characters.length === 14 && !canonOut.objects.characters.some((c) => c.id === 'D-0-C-10'), `实际 ${canonOut.objects.characters.length}`)

    const keep2 = canonOut.objects.characters.find((c) => c.id === 'D-0-C-2')
    check('C2 keep=D-0-C-2（组内首个 id）', !!keep2)
    check('C2 keep 实体 draftIds 尾部追加（按组内顺序，不按 chunk 重排）', JSON.stringify(keep2.draftIds) === '["D-0-C-2","D-0-C-10","D-1-C-2"]', JSON.stringify(keep2.draftIds))
    check('C2 keep 实体 chunkSummaryList 合并升序（同 chunkIndex keep 条目在前）', JSON.stringify(keep2.chunkSummaryList) === JSON.stringify([{ chunkIndex: 0, summaryText: '第0章：测试二号路过。' }, { chunkIndex: 0, summaryText: '第0章：测试十号第十个出场。' }, { chunkIndex: 1, summaryText: '第1章：测试十号再登场。' }]), JSON.stringify(keep2.chunkSummaryList))
    check('C2 keep 实体 summary **不重算**（保持 merge 的值）', keep2.summary === '第0章：测试二号路过。', keep2.summary)
    check('C2 keep 实体 name/importanceLevel 保持 merge 的值', keep2.name === '测试二号' && keep2.importanceLevel === 'LOW')
    check('C2 无效 id 组跳过 + warning', rtCanon.warnings.some((w) => w.includes('D-0-C-99')), JSON.stringify(rtCanon.warnings))
    check('C2 :plan 变体被过滤（D-0-C-3/D-0-C-4 未合并）', canonOut.objects.characters.some((c) => c.id === 'D-0-C-3') && canonOut.objects.characters.some((c) => c.id === 'D-0-C-4'))
    check('C2 其余实体原序保留（D-0-C-0 仍在首位）', canonOut.objects.characters[0].id === 'D-0-C-0')

    // ---- C3. mapping ----
    const mp = canonOut.mapping
    check('C3 mapping 恒等：D-0-C-0→D-0-C-0', mp['D-0-C-0'] === 'D-0-C-0')
    check('C3 mapping 恒等（merge 阶段已合并的 draftId）：D-1-C-0→D-0-C-0', mp['D-1-C-0'] === 'D-0-C-0', mp['D-1-C-0'])
    check('C3 mapping 被合并者 draftIds → keepId：D-0-C-10→D-0-C-2、D-1-C-2→D-0-C-2', mp['D-0-C-10'] === 'D-0-C-2' && mp['D-1-C-2'] === 'D-0-C-2', JSON.stringify([mp['D-0-C-10'], mp['D-1-C-2']]))
    check('C3 mapping 未合并者恒等：D-1-C-5→D-1-C-5', mp['D-1-C-5'] === 'D-1-C-5')
    check('C3 mapping 覆盖 factions 全部 draftId（含 merge 阶段合并的 D-1-factions-3）', mp['D-1-factions-2'] === 'D-1-factions-2' && mp['D-1-factions-3'] === 'D-1-factions-2', JSON.stringify([mp['D-1-factions-2'], mp['D-1-factions-3']]))
    check('C3 identityMatchStopNames 从 merge 透传', JSON.stringify(canonOut.objects.identityMatchStopNames) === '["队长","老板"]', JSON.stringify(canonOut.objects.identityMatchStopNames))

    // ---- C4. merge 缺失 → 空 + warning ----
    {
      const rt = makeRt('canonical', { ws: wsEmpty })
      const out = await localSteps.canonicalStep.run(rt)
      check('C4 merge 缺失 → 空 objects + 空 mapping 不抛崩', out.objects.characters.length === 0 && Object.keys(out.mapping).length === 0 && out.objects.identityMatchStopNames.length === 0, JSON.stringify(out).slice(0, 120))
      check('C4 merge 缺失 → warning', rt.warnings.some((w) => w.includes('merge 产物缺失')), JSON.stringify(rt.warnings))
    }

    // =====================================================================
    // D · draftAlign 本地步骤
    // =====================================================================
    console.log('\nD · draftAlign（本片草稿对齐 canonical）')

    // 把 C 的 canonical 产物写进主工作库（本地信封）
    await wsMain.writeResults('records/results/canonical.json', [{ key: `${PKG}:${REV}:canonical`, value: localEnvelope(canonOut) }])

    const rtAlign = makeRt('draftAlign', { chunkIndex: 1, ws: wsMain })
    const alignOut = await localSteps.draftAlignStep.run(rtAlign)
    check('D1 输出键恰为四类（无 identityMatchStopNames）', Object.keys(alignOut).join(',') === 'characters,factions,items,creatures', Object.keys(alignOut).join(','))
    check('D1 characters=6（chunk1 的 6 条）', alignOut.characters.length === 6, `实际 ${alignOut.characters.length}`)

    const align0 = alignOut.characters[0] // 艾莉娜（位置 0 → D-1-C-0）
    check('D2 命中：艾莉娜 id 改写为 canonical id D-0-C-0', align0.id === 'D-0-C-0', align0.id)
    check('D2 命中：aliases 整体替换为 canonical 实体的（[艾莉]）', JSON.stringify(align0.aliases) === '["艾莉"]', JSON.stringify(align0.aliases))
    check('D2 命中：draftIds 收缩为 [本片 draftId]', JSON.stringify(align0.draftIds) === '["D-1-C-0"]', JSON.stringify(align0.draftIds))
    check('D2 其余字段保留本片值（summary/identInfos/importanceLevel/name）', align0.summary === '第1章：艾莉娜与圣剑酱交换灵魂。' && align0.importanceLevel === 'HIGH' && align0.name === '艾莉娜' && JSON.stringify(align0.identInfos) === '["互换后"]', JSON.stringify({ s: align0.summary.slice(0, 20), i: align0.identInfos }))
    check('D2 chunkSummaryList 重建为 [{chunkIndex:1,…}]', JSON.stringify(align0.chunkSummaryList) === JSON.stringify([{ chunkIndex: 1, summaryText: '第1章：艾莉娜与圣剑酱交换灵魂。' }]), JSON.stringify(align0.chunkSummaryList))
    check('D2 characterSpriteInfos 打上本片 chunkIndex=1', align0.characterSpriteInfos.length === 1 && align0.characterSpriteInfos[0].chunkIndex === 1, JSON.stringify(align0.characterSpriteInfos))

    const align2 = alignOut.characters[2] // 测试十号（位置 2 → D-1-C-2，canonical 复核合并 → D-0-C-2）
    check('D2 命中（canonical 复核层）：测试十号 id → D-0-C-2', align2.id === 'D-0-C-2', align2.id)
    const align5 = alignOut.characters[5] // 停词别名丁（位置 5 → D-1-C-5，恒等）
    check('D3 未命中原样：id = 重算的自身 draftId、draftIds=[自身]、aliases 保留本片', align5.id === 'D-1-C-5' && JSON.stringify(align5.draftIds) === '["D-1-C-5"]' && JSON.stringify(align5.aliases) === '["老板"]', JSON.stringify({ id: align5.id, a: align5.aliases }))
    check('D3 未命中 chunkSummaryList 同样重建', JSON.stringify(align5.chunkSummaryList) === JSON.stringify([{ chunkIndex: 1, summaryText: '第1章：丁别名也是老板。' }]))

    const wangcheng = alignOut.factions[3] // 王城（位置 3 → D-1-factions-3，merge 阶段已并入 D-1-factions-2）
    check('D3 factions 王城命中 merge 阶段映射 → id D-1-factions-2', wangcheng.id === 'D-1-factions-2', wangcheng.id)
    check('D3 factions 王都（位置 2）恒等 → D-1-factions-2…不，D-1-factions-2', alignOut.factions[2].id === 'D-1-factions-2', alignOut.factions[2].id)

    // ---- D4. 重算 draftId 与 merge 分配一致性 ----
    {
      // 同一位置同一规则 → 必然命中 mapping（断言：chunk1 每个实体要么恒等要么落在 mapping 值域）
      const values = new Set(Object.values(canonOut.mapping))
      const allConsistent = alignOut.characters.every((c) => values.has(c.id))
      check('D4 重算一致性：draftAlign 输出 id 全部落在 canonical mapping 值域内', allConsistent, alignOut.characters.map((c) => c.id).join(','))
      check('D4 艾莉娜（D-1-C-0）经 mapping 命中——证明重算与 merge 分配同址', canonOut.mapping['D-1-C-0'] === 'D-0-C-0' && align0.id === 'D-0-C-0')
    }

    // ---- D5. 本 chunk 无 draft / canonical 缺失 ----
    {
      const rt = makeRt('draftAlign', { chunkIndex: 5, ws: wsMain })
      let out = null
      let threw = false
      try {
        out = await localSteps.draftAlignStep.run(rt)
      } catch {
        threw = true
      }
      check('D5 chunk 5 无 draft → 四类空 + warning 不抛崩', !threw && out.characters.length === 0 && out.factions.length === 0 && rt.warnings.some((w) => w.includes('chunk 5 无 draft')), JSON.stringify(rt.warnings))

      await wsNoCanonical.reset()
      await wsNoCanonical.writeResults('records/results/draft.json', [{ key: `${PKG}:${REV}:draft:1`, value: llmEnvelope(CHUNK1_DRAFT) }])
      const rt2 = makeRt('draftAlign', { chunkIndex: 1, ws: wsNoCanonical })
      const out2 = await localSteps.draftAlignStep.run(rt2)
      check('D5 canonical 缺失 → 全部原样（id 用重算自身 draftId）+ warning', out2.characters.length === 6 && out2.characters.every((c, n) => c.id === `D-1-C-${n}`) && rt2.warnings.some((w) => w.includes('canonical 产物缺失')), JSON.stringify(rt2.warnings))
    }

    // =====================================================================
    // E · 链端到端
    // =====================================================================
    console.log('\nE · 链端到端（merge → mergeReview 合成 → canonical → draftAlign）')
    {
      await wsE2E.reset()
      await wsE2E.writeResults('records/results/draft.json', [
        { key: `${PKG}:${REV}:draft:0`, value: llmEnvelope(CHUNK0_DRAFT) },
        { key: `${PKG}:${REV}:draft:1`, value: llmEnvelope(CHUNK1_DRAFT) }
      ])
      // 1) merge（真跑本地步骤）
      const rtM = makeRt('merge', { ws: wsE2E })
      const e2eMerge = await localSteps.mergeStep.run(rtM)
      await wsE2E.writeResults('records/results/merge.json', [{ key: `${PKG}:${REV}:merge`, value: localEnvelope(e2eMerge, rtM.warnings) }])
      check('E1 链·merge 产出 15 人物（与 A 一致）', e2eMerge.characters.length === 15)

      // 2) 合成 mergeReview 产物（模拟 LLM 输出经 parse 后的形状）：characters 合并
      //    [D-0-C-2, D-0-C-10]；factions 合并 [D-1-factions-0, D-1-factions-1]
      const e2eReview = {
        characters: { mergeGroups: [{ ids: ['D-0-C-2', 'D-0-C-10'], reason: '同一人' }], warnings: [] },
        factions: { mergeGroups: [{ ids: ['D-1-factions-0', 'D-1-factions-1'], reason: '同一势力' }], warnings: [] },
        items: { mergeGroups: [], warnings: [] },
        creatures: { mergeGroups: [], warnings: [] }
      }
      await wsE2E.writeResults('records/results/mergeReview.json', [
        { key: `${PKG}:${REV}:mergeReview:characters`, value: llmEnvelope(e2eReview.characters) },
        { key: `${PKG}:${REV}:mergeReview:factions`, value: llmEnvelope(e2eReview.factions) },
        { key: `${PKG}:${REV}:mergeReview:items`, value: llmEnvelope(e2eReview.items) },
        { key: `${PKG}:${REV}:mergeReview:creatures`, value: llmEnvelope(e2eReview.creatures) }
      ])

      // 3) canonical（真跑本地步骤）→ 写库
      const rtC = makeRt('canonical', { ws: wsE2E })
      const e2eCanon = await localSteps.canonicalStep.run(rtC)
      await wsE2E.writeResults('records/results/canonical.json', [{ key: `${PKG}:${REV}:canonical`, value: localEnvelope(e2eCanon, rtC.warnings) }])
      check('E2 链·canonical：characters 14（复核合并生效）', e2eCanon.objects.characters.length === 14, `实际 ${e2eCanon.objects.characters.length}`)
      check('E2 链·canonical：factions 2（王国+公会合并）', e2eCanon.objects.factions.length === 2, `实际 ${e2eCanon.objects.factions.length}`)

      // 4) draftAlign（chunk 1，真跑本地步骤）
      const rtA = makeRt('draftAlign', { chunkIndex: 1, ws: wsE2E })
      const e2eAlign = await localSteps.draftAlignStep.run(rtA)
      const valueDomain = new Set(Object.values(e2eCanon.mapping))
      const allInDomain = ['characters', 'factions', 'items', 'creatures'].every((cat) => e2eAlign[cat].every((e) => valueDomain.has(e.id)))
      check('E3 链·draftAlign：输出 id 全部落在 canonical mapping 值域内', allInDomain, ['characters', 'factions'].map((c) => e2eAlign[c].map((e) => e.id).join(',')).join(' | '))
      check('E3 链·draftAlign：艾莉娜 → D-0-C-0、测试十号 → D-0-C-2', e2eAlign.characters[0].id === 'D-0-C-0' && e2eAlign.characters[2].id === 'D-0-C-2')
      check('E3 链·draftAlign：公会（D-1-factions-1）→ 王国 keepId D-1-factions-0', e2eAlign.factions[1].id === 'D-1-factions-0', e2eAlign.factions[1].id)
      check('E3 链·draftAlign：停词别名丁恒等 D-1-C-5', e2eAlign.characters[5].id === 'D-1-C-5')
      check('E3 全链无 warning（正常数据）', rtM.warnings.length === 0 && rtC.warnings.length === 0 && rtA.warnings.length === 0, JSON.stringify([rtM.warnings, rtC.warnings, rtA.warnings]))
    }
  } finally {
    await rm(TEST_PARENT, { recursive: true, force: true })
  }

  console.log(`\n==== T6-E 实体合并链验证：${passed} 通过 / ${failed} 失败 ====`)
  if (failed === 0) {
    console.log('T6-E ENTITY CHAIN VERIFY PASS')
  } else {
    console.log('T6-E ENTITY CHAIN VERIFY FAIL')
  }
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('ERROR:', e?.stack ?? e?.message ?? e)
  process.exitCode = 2
})

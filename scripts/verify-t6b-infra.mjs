/**
 * T6-B · 解析流水线基础设施验证脚本（node 直跑，**不启动 Electron**；零新增依赖）。
 *
 * 覆盖三块：
 *  A. `readUpstreamResults`（src/main/pipeline/upstream.ts）：手工搭临时工作库
 *     （index.json + 分片信封，字段按真实 ShardRow/信封形状）→ taskId→文件路由
 *     （plot 普通路由 / storyScript 前缀多文件 / plotLocation 叶真源 / 不存在→空数组）、
 *     插入序拼接（分片序 × 信封序，不排序）、非 results 容器被忽略、登记但文件缺失跳过、
 *     分片 JSON 损坏抛可读错误（不静默）；
 *  B. worldImpression 适配器（src/main/pipeline/tasks/worldImpression.ts）：
 *     inputText（2 条 plot 条目 → 【Chunk 0/1】标注 + 两份摘要；空产物/无 readUpstream →
 *     可读错误；无 chunkSummary 条目跳过并记 warnings）、buildMessages（恰好 2 条、
 *     system 来自 common_system_prompt、指令含标题与两份摘要且无 `{{` 残留）、
 *     parse 正样本（三键非空，含 ```json 包裹变体）与脏样本（raw 兜底不抛崩）、
 *     注册完整性、模板变量一致性（world_impression_user_prompt 占位符全覆盖）；
 *  C. plot:next 末 chunk 修复（orchestrator.depSatisfied 已导出）：
 *     非末 chunk 的 next 未就绪 → 阻塞（false）；末 chunk 的 next 越界 → 不阻塞（true）；
 *     对照 per-chunk 全就绪语义不被破坏（plot:i 未就绪 → false，全就绪 → true）。
 *
 * 姿势与 `scripts/verify-t6a-adapters.mjs` 一致：`createRequire(feather/package.json)`
 * 取项目已装的 esbuild，把入口打成单文件 ESM 写入临时目录后 `pathToFileURL` 动态 import；
 * electron 以最小桩替换（app.getAppPath → 项目根，使 prompt-loader 的 resourcesDir()
 * 定位到 `resources/prompts`）。
 *
 * 临时目录**只准碰** `D:/AI/tx/feather-t6b-test/`（跑完 rm -rf 清掉）；
 * 绝不读写真实工作库目录（7 本真实库只读）。
 *
 * 用法：node scripts/verify-t6b-infra.mjs
 */
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(here, '..')
/** 唯一允许触碰的临时父目录（跑完 rm -rf 清掉） */
const TEST_PARENT = 'D:/AI/tx/feather-t6b-test'
const BUILD_DIR = join(TEST_PARENT, 'build')
const WS_ROOT = join(TEST_PARENT, 'ws')

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
function taskDef(id, global = false) {
  return {
    id,
    kind: id,
    code: id,
    label: id,
    feature: 'always',
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

/** 合成 rt：render 走真 prompt-loader 并留痕（vars 供模板一致性断言）。 */
function makeRt(id, pl, renderLog, extra = {}) {
  return {
    task: taskDef(id, true),
    pkgId: 'pkg-t6b',
    revisionId: 'rev-t6b',
    chunkIndex: null,
    instanceKey: `pkg-t6b:rev-t6b:${id}`,
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
    ...extra
  }
}

// ---------------------------------------------------------------------------
// 临时工作库夹具（字段按真实 ShardRow / ShardEnvelope 形状；7 本真实库只读，绝不触碰）
// ---------------------------------------------------------------------------

const PKG = 'pkg-t6b'
const REV = 'rev-t6b'

/** 分片信封（container=results）。 */
function envelope(name, entries) {
  return { shard: name, container: 'results', entries: entries.map((e, i) => ({ seq: i, ...e })) }
}

async function buildWorkspace() {
  await rm(WS_ROOT, { recursive: true, force: true })
  await mkdir(join(WS_ROOT, 'records', 'results'), { recursive: true })
  await mkdir(join(WS_ROOT, 'script'), { recursive: true })
  await mkdir(join(WS_ROOT, 'world'), { recursive: true })
  await mkdir(join(WS_ROOT, 'records'), { recursive: true })

  const files = {
    // plot：3 条，key 分别以 :0/:1/:2 结尾（同分片内即 chunk 序）
    'records/results/plot.json': envelope('records/results/plot', [
      { key: `${PKG}:${REV}:plot:0`, value: { chunkSummary: '第0块摘要：少年推开旧宅的木门，屋内空无一人。', chapters: [{ chapterSeq: 1, chapterSummary: '勇者击败魔王后被推上王位。' }] } },
      { key: `${PKG}:${REV}:plot:1`, value: { chunkSummary: '第1块摘要：他与圣剑灵魂互换，以艾莉娜身份外出再冒险。', chapters: [{ chapterSeq: 2, chapterSummary: '灵魂互换后西进冒险。' }] } },
      { key: `${PKG}:${REV}:plot:2`, value: { chunkSummary: '第2块摘要：百合酒吧位于王城旁，提供食物与住宿。', chapters: [{ chapterSeq: 3, chapterSummary: '酒吧后门通往地下室。' }] } }
    ]),
    // cacheWarming：1 条（证明不会串任务）
    'records/results/cacheWarming.json': envelope('records/results/cacheWarming', [
      { key: `${PKG}:${REV}:cacheWarming`, value: { answer: 'ok' } }
    ]),
    // storyScript：前缀多文件路由的代表（单文件 2 条）
    'script/story-script.0.json': envelope('script/story-script.0', [
      { key: `${PKG}:${REV}:storyScript:0`, value: { protocol: 'v1', actions: [{ chapterSeq: 1, order: 1, type: 'speak', text: '推开木门。' }] } },
      { key: `${PKG}:${REV}:storyScript:0:batch:1`, value: { protocol: 'v1', actions: [{ chapterSeq: 1, order: 2, type: 'speak', text: '低声自语。' }] } }
    ]),
    // plotLocation：叶真源单文件路由
    'world/plot-locations.json': envelope('world/plot-locations', [
      { key: `${PKG}:${REV}:plotLocation`, value: { id: 'loc-1', name: '旧宅', locationType: '建筑' } }
    ]),
    // tasks 容器（非 results）：含 plot 字样的 key，必须被容器过滤挡掉
    'records/tasks.json': envelope('records/tasks', [
      { key: `${PKG}:${REV}:plot:99`, value: { status: 'succeeded', fingerprint: null, updatedAt: '', error: null } }
    ])
  }
  for (const [file, env] of Object.entries(files)) {
    await writeFile(join(WS_ROOT, file), JSON.stringify(env), 'utf8')
  }
  // 登记但**文件缺失**的分片（range 重跑尚未产出）→ 读取时应跳过不抛
  // 登记但**JSON 损坏**的分片 → 读取时应抛可读错误
  await writeFile(join(WS_ROOT, 'records/results/broken.json'), '{ this is not valid json', 'utf8')

  const index = {
    indexVersion: 1,
    format: 'txt2world-workspace',
    pkgId: PKG,
    title: 'T6-B 验证书',
    origin: { t2wPath: '', t2wSize: 0, t2wSha256: '', manifestJsonSha256: '', hasOriginHeader: false, projectId: '', revisionId: REV, createdAt: '' },
    manifest: { includesSource: true, topLevelKeys: [], extra: {}, recordsKeys: [], containers: {}, containerKeyed: {}, project: {} },
    shards: [
      { name: 'records/results/plot', file: 'records/results/plot.json', container: 'results', entryCount: 3, sha256: '' },
      { name: 'records/results/cacheWarming', file: 'records/results/cacheWarming.json', container: 'results', entryCount: 1, sha256: '' },
      { name: 'script/story-script.0', file: 'script/story-script.0.json', container: 'results', entryCount: 2, sha256: '' },
      { name: 'world/plot-locations', file: 'world/plot-locations.json', container: 'results', entryCount: 1, sha256: '' },
      { name: 'records/tasks', file: 'records/tasks.json', container: 'tasks', entryCount: 1, sha256: '' },
      { name: 'records/results/draft', file: 'records/results/draft.json', container: 'results', entryCount: 1, sha256: '' },
      { name: 'records/results/broken', file: 'records/results/broken.json', container: 'results', entryCount: 1, sha256: '' }
    ],
    assets: [],
    tasks: {},
    integrity: { createdAt: '', lastVerifiedAt: null }
  }
  await writeFile(join(WS_ROOT, 'index.json'), JSON.stringify(index), 'utf8')
}

const WORLD_POSITIVE = {
  worldImpression: '旧大陆封建时代，魔法与机械并存，服饰以粗布与锁甲为主，建筑多石造高塔。',
  novelGenre: '异世界灵魂互换冒险',
  locationIconArtStyle: '扁平几何图标，暖褐色系，粗线条描边，统一 45° 等轴视角。'
}

async function main() {
  await rm(TEST_PARENT, { recursive: true, force: true })
  await mkdir(BUILD_DIR, { recursive: true })
  console.log(`临时目录：${TEST_PARENT}\n`)

  const up = await loadModule('src/main/pipeline/upstream.ts', 'upstream.mjs')
  const tasks = await loadModule('src/main/pipeline/tasks/index.ts', 'tasks-index.mjs')
  const orch = await loadModule('src/main/pipeline/orchestrator.ts', 'orchestrator.mjs')
  const pl = await loadModule('src/main/pipeline/prompt-loader.ts', 'prompt-loader.mjs')

  await buildWorkspace()

  try {
    // =====================================================================
    // A · readUpstreamResults：路由 / 顺序 / 边界
    // =====================================================================
    console.log('A · readUpstreamResults')

    const plotEntries = await up.readUpstreamResults(WS_ROOT, 'plot')
    check('plot：返回 3 条', plotEntries.length === 3, `实际 ${plotEntries.length}`)
    check('plot：顺序 = 信封插入序（chunk 0/1/2，不排序）', plotEntries.map((e) => e.key).join('|') === [`${PKG}:${REV}:plot:0`, `${PKG}:${REV}:plot:1`, `${PKG}:${REV}:plot:2`].join('|'), JSON.stringify(plotEntries.map((e) => e.key)))
    check('plot：key/value 完整透传', plotEntries.every((e) => typeof e.key === 'string' && e.value && typeof e.value === 'object' && typeof e.value.chunkSummary === 'string'))

    const ssEntries = await up.readUpstreamResults(WS_ROOT, 'storyScript')
    check('storyScript：前缀路由命中（返回 2 条）', ssEntries.length === 2 && ssEntries[0].key.endsWith(':storyScript:0') && ssEntries[1].key.endsWith(':storyScript:0:batch:1'), JSON.stringify(ssEntries.map((e) => e.key)))

    const plocEntries = await up.readUpstreamResults(WS_ROOT, 'plotLocation')
    check('plotLocation：叶真源单文件路由（返回 1 条）', plocEntries.length === 1 && plocEntries[0].value.name === '旧宅', JSON.stringify(plocEntries))

    const noneEntries = await up.readUpstreamResults(WS_ROOT, 'nonexistent')
    check('不存在的 taskId → 空数组', Array.isArray(noneEntries) && noneEntries.length === 0)

    check('非 results 容器被过滤（tasks 里的 plot:99 不出现）', plotEntries.every((e) => !e.key.endsWith(':99')))

    const draftEntries = await up.readUpstreamResults(WS_ROOT, 'draft')
    check('index 登记但文件缺失 → 跳过不抛（空数组）', Array.isArray(draftEntries) && draftEntries.length === 0)

    let brokenMsg = ''
    try {
      await up.readUpstreamResults(WS_ROOT, 'broken')
    } catch (e) {
      brokenMsg = e?.message ?? ''
    }
    check('分片 JSON 损坏 → 抛可读错误（不静默）', brokenMsg.includes('分片') && brokenMsg.includes('损坏'), brokenMsg)

    // =====================================================================
    // B · worldImpression 适配器
    // =====================================================================
    console.log('\nB · worldImpression 适配器')
    const wi = tasks.worldImpressionAdapter

    // ---- B1. inputText ----
    const plotUpstream = [
      { key: `${PKG}:${REV}:plot:0`, value: { chunkSummary: '第0块摘要：少年推开旧宅的木门。', chapters: [] } },
      { key: `${PKG}:${REV}:plot:1`, value: { chunkSummary: '第1块摘要：灵魂互换后西进冒险。', chapters: [] } }
    ]
    {
      const rt = makeRt('worldImpression', pl, [], { readUpstream: async () => plotUpstream })
      const input = await wi.inputText(rt)
      check('inputText：含两份 chunkSummary', input.includes('第0块摘要') && input.includes('第1块摘要'))
      check('inputText：含【Chunk 0】/【Chunk 1】标注（chunkIndex 取自 key 末段）', input.includes('【Chunk 0 · 摘要】') && input.includes('【Chunk 1 · 摘要】'))
    }
    {
      const rt = makeRt('worldImpression', pl, [], { readUpstream: async () => [] })
      let msg = ''
      try {
        await wi.inputText(rt)
      } catch (e) {
        msg = e?.message ?? ''
      }
      check('inputText：readUpstream 返回空 → 抛可读错误（含「plot」字样）', msg.includes('plot') && msg.includes('plot 任务'), msg)
    }
    {
      const rt = makeRt('worldImpression', pl, [])
      let msg = ''
      try {
        await wi.inputText(rt)
      } catch (e) {
        msg = e?.message ?? ''
      }
      check('inputText：未挂 readUpstream → 抛可读错误', msg.includes('readUpstream'), msg)
    }
    {
      // 缺 chunkSummary 的条目跳过并记 warnings；不阻断
      const rt = makeRt('worldImpression', pl, [], {
        readUpstream: async () => [
          { key: `${PKG}:${REV}:plot:0`, value: { chunkSummary: '第0块摘要：有摘要。', chapters: [] } },
          { key: `${PKG}:${REV}:plot:1`, value: { chapters: [] } },
          { key: `${PKG}:${REV}:plot:2`, value: null }
        ]
      })
      const input = await wi.inputText(rt)
      check('inputText：无 chunkSummary 的条目跳过（仅 1 块）', input.includes('【Chunk 0 · 摘要】') && !input.includes('【Chunk 1'))
      check('inputText：跳过条目记 rt.warnings', rt.warnings.length === 2 && rt.warnings.every((w) => w.includes('chunkSummary')), JSON.stringify(rt.warnings))
    }

    // ---- B2. buildMessages ----
    {
      const renderLog = []
      const rt = makeRt('worldImpression', pl, renderLog, {
        title: 'T6-B 验证书',
        readUpstream: async () => plotUpstream
      })
      const input = await wi.inputText(rt)
      const msgs = await wi.buildMessages(input, rt)
      check('buildMessages：恰好 2 条消息（输入内嵌于指令，不重复）', msgs.length === 2, `实际 ${msgs.length}`)
      check('buildMessages：角色顺序 = system / user', msgs[0].role === 'system' && msgs[1].role === 'user')
      check('buildMessages：system 来自 common_system_prompt（含共同任务边界）', msgs[0].content.includes('【共同任务边界】'))
      check('buildMessages：第二条含书名与两份摘要', msgs[1].content.includes('T6-B 验证书') && msgs[1].content.includes('第0块摘要') && msgs[1].content.includes('第1块摘要'))
      check('buildMessages：两条消息均无 `{{` 残留（模板渲染完整）', msgs.every((m) => !m.content.includes('{{')))

      const sysEntry = renderLog.find((r) => r.name === 'common_system_prompt')
      const taskEntry = renderLog.find((r) => r.name === 'world_impression_user_prompt')
      check('buildMessages：渲染了 common_system_prompt（vars={}）', !!sysEntry && Object.keys(sysEntry.vars).length === 0)
      check('buildMessages：渲染了 world_impression_user_prompt', !!taskEntry)
    }

    // ---- B3. parse 正样本（含 ```json 包裹变体）----
    {
      const parsedPlain = wi.parse(JSON.stringify(WORLD_POSITIVE))
      const parsedFenced = wi.parse('```json\n' + JSON.stringify(WORLD_POSITIVE) + '\n```')
      const shapeOk = (d) =>
        typeof d.worldImpression === 'string' && d.worldImpression.length > 0 &&
        typeof d.novelGenre === 'string' && d.novelGenre.length > 0 &&
        typeof d.locationIconArtStyle === 'string' && d.locationIconArtStyle.length > 0
      check('parse 正样本：三键非空返回', shapeOk(parsedPlain), JSON.stringify(parsedPlain).slice(0, 120))
      check('parse 正样本：与目标形状逐字一致', JSON.stringify(parsedPlain) === JSON.stringify(WORLD_POSITIVE))
      check('parse 正样本（```json 包裹变体）结果一致', JSON.stringify(parsedFenced) === JSON.stringify(WORLD_POSITIVE))
    }

    // ---- B4. parse 脏样本 ----
    {
      let noThrow = true
      let probeOk = true
      for (const dirty of ['not a json at all', '{}', '{"worldImpression":"只有一键"}', '', '{"worldImpression":"","novelGenre":"x","locationIconArtStyle":"y"}']) {
        try {
          const d = wi.parse(dirty)
          if (!(d.worldImpression === null && d.novelGenre === null && d.locationIconArtStyle === null && typeof d.raw === 'string')) {
            probeOk = false
            console.log(`     兜底形状异常：${JSON.stringify(dirty).slice(0, 40)} → ${JSON.stringify(d).slice(0, 120)}`)
          }
        } catch (e) {
          noThrow = false
          console.log(`     抛崩：${JSON.stringify(dirty).slice(0, 40)} → ${e.message}`)
        }
      }
      check('parse 脏样本（非 JSON / {} / 缺键 / 空串 / 空值键）不抛崩', noThrow)
      check('parse 脏样本返回三 null + raw 截断兜底（cacheWarming 同风格）', probeOk)
    }

    // ---- B5. 注册完整性 ----
    check('注册完整性：LLM_ADAPTERS 含 worldImpression 且 id 一致', typeof tasks.LLM_ADAPTERS.worldImpression === 'object' && tasks.LLM_ADAPTERS.worldImpression.id === 'worldImpression')
    check('worldImpression 声明 concat-dedup-order 且不提供 keyOf', wi.mergeStrategy === 'concat-dedup-order' && wi.keyOf === undefined)

    // ---- B6. 模板变量一致性 ----
    {
      const tplVars = extractTemplateVars(await readFile(join(FEATHER, 'resources', 'prompts', 'world_impression_user_prompt.txt'), 'utf8'))
      const renderLog = []
      const rt = makeRt('worldImpression', pl, renderLog, { title: 'T6-B 验证书', readUpstream: async () => plotUpstream })
      const input = await wi.inputText(rt)
      await wi.buildMessages(input, rt)
      const taskEntry = renderLog.find((r) => r.name === 'world_impression_user_prompt')
      const missing = tplVars.filter((v) => !(v in taskEntry.vars) || taskEntry.vars[v] === undefined)
      check(`模板占位符全覆盖（${tplVars.join(',')}）`, missing.length === 0, `缺失: ${missing.join(',')}`)
      check('传入 vars 无多余键（与模板占位符一致）', Object.keys(taskEntry.vars).sort().join(',') === tplVars.sort().join(','), `实际: ${Object.keys(taskEntry.vars).join(',')}`)
    }

    // =====================================================================
    // C · plot:next 末 chunk 修复（depSatisfied 已导出）
    // =====================================================================
    console.log('\nC · plot:next 末 chunk 修复（depSatisfied）')
    check('depSatisfied 已从 orchestrator 导出', typeof orch.depSatisfied === 'function')

    const plotDef = taskDef('plot')
    const allTasks = [plotDef]
    const ik = (t, c) => `${PKG}:${REV}:${t}:${c}`
    const emptyStates = {}

    check(
      '非末 chunk（idx=1, len=3）：plot:2 未就绪 → 阻塞（false）',
      orch.depSatisfied('plot:next', emptyStates, allTasks, PKG, REV, 3, 1) === false
    )
    check(
      '末 chunk（idx=2, len=3）：plot:next 越界 → 不阻塞（true）',
      orch.depSatisfied('plot:next', emptyStates, allTasks, PKG, REV, 3, 2) === true
    )
    check(
      '对照：plot:i（idx=0，plot:0 未就绪）→ 阻塞（false）',
      orch.depSatisfied('plot:i', emptyStates, allTasks, PKG, REV, 3, 0) === false
    )
    {
      // 正向对照：全部就绪时原语义不被破坏
      const ready = {
        [ik('plot', 0)]: { status: 'succeeded', fingerprint: null, updatedAt: '', error: null },
        [ik('plot', 1)]: { status: 'succeeded', fingerprint: null, updatedAt: '', error: null },
        [ik('plot', 2)]: { status: 'succeeded', fingerprint: null, updatedAt: '', error: null }
      }
      check('正向对照：plot:i 全部就绪 → true', orch.depSatisfied('plot:i', ready, allTasks, PKG, REV, 3, 0) === true)
      check('正向对照：plot:next（idx=1）且 plot:2 就绪 → true', orch.depSatisfied('plot:next', ready, allTasks, PKG, REV, 3, 1) === true)
      check('正向对照：plot:next（idx=1）仅 plot:0/1 就绪 → false（next 语义仍在）', orch.depSatisfied('plot:next', { [ik('plot', 0)]: ready[ik('plot', 0)], [ik('plot', 1)]: ready[ik('plot', 1)] }, allTasks, PKG, REV, 3, 1) === false)
    }
  } finally {
    await rm(TEST_PARENT, { recursive: true, force: true })
  }

  console.log(`\n==== T6-B 基础设施验证：${passed} 通过 / ${failed} 失败 ====`)
  if (failed === 0) {
    console.log('T6-B INFRA VERIFY PASS')
  } else {
    console.log('T6-B INFRA VERIFY FAIL')
  }
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('ERROR:', e?.stack ?? e?.message ?? e)
  process.exitCode = 2
})

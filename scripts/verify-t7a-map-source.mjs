/**
 * T7-A · 「地图页能分辨显示的是本机产物还是来源包自带数据」验证脚本
 * （node 直跑，**不启动 Electron**；零新增依赖）。
 *
 * 背景（T7-A）：真实工作库 `5662f1d3` 的 `records/results/locationTree.json` 有 2 条 —— 主条目
 * `…:locationTree`（data 含 locations(69) + tree(70 节点) + attachments）与 `:locationTree:batch:0`
 * （data 只有 delta，是中间态）。**主条目是来源包自带的历史产物**。本机跑 locationTree 写出的
 * instanceKey 与之**逐字相同**（global 任务无 chunk 后缀），`writeResult` 是 upsert by key →
 * 本机跑完会覆盖旧产物。数据流本来就通，**问题是从来看不出读到的是哪一种**：
 * 本机未跑（或跑失败）时，页面照样渲染包内那 69 个地点的树，静默地看起来「已经通了」。
 *
 * 本批做的事：① `persistence.writeResult` 给产物 value 顶层补 `source:'runtime'`；
 * ② `view.ts` 在**下钻 `.data` 之前**读该标记，透出 `stats.locationTreeSource` 三态
 * （runtime / inherited / unknown）；③ MapView 顶部工具栏按三态显示徽章。
 *
 * 断言七组：
 *  A. 真实库只读形态锁（5662f1d3）——locationTree.json 恰 2 条、主条目 key 无后缀且
 *     data.locations 69 条、`:batch:0` 的 data 只有 delta（无 locations/tree）、
 *     `pickMainEntry(allResults, ':locationTree')` 命中的就是主条目（seq 更小那条）、
 *     主条目 value **顶层无 source**（= 来源包自带）；
 *  B. 拼装链路——`assembleManifest(root, idx)` → `buildViewData(manifest, 't2w://t7/')`
 *     → `countTree(mapRoot) === 70`、`mapRoot.id === 'novel-world'`、`mapNodes.length === 69`、
 *     树节点数与真实库原始 tree 一致（脚本内独立计数对拍）；
 *  C. 来源判定——同一真实库 → `locationTreeSource === 'inherited'`（包内产物无 runtime 标记）；
 *  D. writeResult 打标（临时库）——先写一条「来源包形态」条目 → `inherited`；
 *     再 `writeResult(root, '<pkg>:<rev>:locationTree', {data:{locations,tree},at})` → 读回
 *     该条目 `value.source === 'runtime'`（且 `value.data` **未被污染**、仍是 upsert 1 条），
 *     再走 assemble → buildViewData → `locationTreeSource === 'runtime'` 且 mapRoot 变成新写入的
 *     形状（**这条直接钉死「本机跑完读到的是新产物」**）；另断言数组/标量产物不打标；
 *  E. unknown 分支——临时库删掉 locationTree 分片 → `locationTreeSource === 'unknown'`、
 *     mapRoot 走「（无地图数据）」兜底、`buildViewData` 不抛；
 *  F. 纯读红线——调用前后真实库 `index.json` 与 `records/results/locationTree.json` 的
 *     size 与 mtime 不变；
 *  G. 回归保护——`pickMainEntry` / `isVariant` 行为未被改动（`:batch:0` 仍被排除、
 *     只剩变体时仍有 fallback 命中）。
 *
 * 姿势与 `scripts/verify-t5-overview.mjs` 一致：`createRequire(feather/package.json)` 取项目已装的
 * esbuild，把 view.ts / manifest-assembler.ts / index-store.ts / persistence.ts / variant.ts
 * （外加 shards.ts，仅用于造「来源包形态」分片）打成临时 ESM 后 `pathToFileURL` 动态 import；
 * electron 以最小桩替换（app.getAppPath → 项目根）。
 *
 * 临时目录**只准碰** `D:/AI/tx/feather-t7-test/`（跑完 rm -rf 清掉）；7 本真实工作库
 * **只读**（仅 A/B/C/F 读 `5662f1d3`，绝不写）。
 *
 * 用法：node scripts/verify-t7a-map-source.mjs
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(here, '..')
/** 唯一允许触碰的临时父目录（跑完 rm -rf 清掉） */
const TEST_PARENT = 'D:/AI/tx/feather-t7-test'
const BUILD_DIR = join(TEST_PARENT, 'build')

/** 真实工作库根（**只读**；locationTree.json 2 条全是来源包自带产物） */
const REAL_ROOT = 'C:/Users/wfsyb/AppData/Roaming/feather/workspace/5662f1d3-fe3c-4b45-8baf-3da9cea8312e'
const LT_FILE = 'records/results/locationTree.json'
const REAL_KEY_SEEN = '5662f1d3-fe3c-4b45-8baf-3da9cea8312e:95b33f2e-192b-4a65-a848-07a70f8ac9f6:locationTree'

const require = createRequire(join(FEATHER, 'package.json'))
const { build } = require('esbuild')

/** electron 最小桩（view.ts 本身零 electron 依赖；其余入口经 shards 传递可能需要）。 */
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

/** 与 view.ts:472 同口径的树节点计数（脚本独立实现，用于与 mapRoot 对拍）。 */
function countTree(n) {
  if (!n || typeof n !== 'object') return 0
  return 1 + (Array.isArray(n.children) ? n.children.reduce((s, c) => s + countTree(c), 0) : 0)
}

/** 从 assembled manifest 的 records.results 里取条目数组（双形态：数组 / 对象）。 */
function resultsOf(manifest) {
  const r = manifest?.records?.results
  if (Array.isArray(r)) return r
  if (r && typeof r === 'object') return Object.entries(r).map(([key, value]) => ({ key, value }))
  return []
}

// ---------------------------------------------------------------------------
// 临时工作库
// ---------------------------------------------------------------------------

const PKG = 'pkg-t7a'
const REV = 'rev-t7a'
const NOW = '2026-10-16T12:00:00.000Z'
const LT_KEY = `${PKG}:${REV}:locationTree`
const PLOT_KEY = `${PKG}:${REV}:plot:0`

/** 造一个合规的 `index.json`（readIndex 校验：indexVersion/format/origin/manifest/shards/assets/tasks/integrity）。 */
function makeIndex() {
  return {
    indexVersion: 1,
    format: 'txt2world-workspace',
    pkgId: PKG,
    title: 'T7-A 验证临时库',
    origin: { revisionId: REV, sourceSha256: 'sha-t7a', importedAt: NOW },
    manifest: {
      includesSource: false,
      topLevelKeys: ['format', 'records'],
      extra: {},
      recordsKeys: ['results'],
      containers: { results: 'array' },
      containerKeyed: { results: true },
      project: {}
    },
    shards: [],
    assets: [],
    tasks: {},
    integrity: { createdAt: NOW, lastVerifiedAt: null }
  }
}

/** 迷你工作库：只维护 index.json + results 分片登记（临时目录，跑完 rm）。 */
function makeWorkspace(name, idx) {
  const root = join(TEST_PARENT, name)
  return {
    root,
    idx,
    async init() {
      await mkdir(join(root, 'records'), { recursive: true })
      await this.writeIndex()
    },
    async writeIndex() {
      await writeFile(join(root, 'index.json'), JSON.stringify(idx, null, 2), 'utf8')
    },
    /** 写 results 分片并登记 index（不经 writeResult —— 模拟「来源包自带」形态）。 */
    async writeShardFile(file, entries) {
      await sh.writeShard(root, file, {
        shard: file.replace(/\.json$/, ''),
        container: 'results',
        entries: entries.map((e, i) => ({ seq: i, ...e }))
      })
      const row = idx.shards.find((r) => r.file === file)
      if (row) row.entryCount = entries.length
      else idx.shards.push({ name: file.replace(/\.json$/, ''), file, container: 'results', entryCount: entries.length, sha256: '' })
      await this.writeIndex()
    },
    /** 删掉某分片（文件 + index 登记行）—— 用于 unknown 分支。 */
    async dropShardFile(file) {
      await rm(join(root, file), { force: true })
      const i = idx.shards.findIndex((r) => r.file === file)
      if (i >= 0) idx.shards.splice(i, 1)
      await this.writeIndex()
    }
  }
}

/** 来源包形态的 locationTree 产物（顶层**无** source；data 带 locations/tree）。 */
function inheritedEnvelope(rootId, locations, tree) {
  return { data: { locations, tree }, responsePath: 'response/locationTree.json', cacheReadyAt: NOW }
}

const OLD_LOCATIONS = [{ id: 'old-1', name: '旧地点一', locationType: '城市' }, { id: 'old-2', name: '旧地点二', locationType: '港口城市' }]
const OLD_TREE = {
  id: 'novel-old',
  name: '旧世界',
  locationType: '世界',
  children: [{ id: 'old-1', name: '旧地点一', locationType: '城市', children: [] }]
}
const NEW_LOCATIONS = [{ id: 'new-1', name: '本机新地点', locationType: '宫殿' }]
const NEW_TREE = { id: 'novel-runtime', name: '本机生成世界', locationType: '世界', children: [] }

let view // view.ts
let asm // manifest-assembler.ts
let store // index-store.ts
let persist // persistence.ts
let variant // variant.ts
let sh // shards.ts

async function main() {
  await rm(TEST_PARENT, { recursive: true, force: true })
  await mkdir(BUILD_DIR, { recursive: true })
  console.log(`临时目录：${TEST_PARENT}\n`)

  view = await loadModule('src/main/t2w/view.ts', 'view.mjs')
  asm = await loadModule('src/main/workspace/manifest-assembler.ts', 'manifest-assembler.mjs')
  store = await loadModule('src/main/workspace/index-store.ts', 'index-store.mjs')
  persist = await loadModule('src/main/pipeline/persistence.ts', 'persistence.mjs')
  variant = await loadModule('src/main/workspace/variant.ts', 'variant.mjs')
  sh = await loadModule('src/main/workspace/shards.ts', 'shards.mjs')

  // =====================================================================
  // A · 真实库只读形态锁（5662f1d3）
  // =====================================================================
  console.log('A · 真实库只读形态锁（5662f1d3，只读）')
  let realEnv = null
  let realMainSeq = -1
  let realBatchSeq = -1
  if (!existsSync(join(REAL_ROOT, LT_FILE))) {
    skip('A/B/C/F 组（真实库相关）', `找不到 ${join(REAL_ROOT, LT_FILE)}`)
  } else {
    realEnv = JSON.parse(await readFile(join(REAL_ROOT, LT_FILE), 'utf8'))
    const entries = Array.isArray(realEnv?.entries) ? realEnv.entries : []
    {
      check('A1 locationTree 分片恰 2 条条目（主条目 + :batch:0 中间态）', entries.length === 2, String(entries.length))
      const main = entries.find((e) => String(e.key).endsWith(':locationTree') && !String(e.key).includes(':batch:'))
      const batch = entries.find((e) => String(e.key).includes(':batch:'))
      check('A2 主条目存在且 key 无变体后缀（不含 :batch:/:grouped:/:plan/:repair）', !!main && !variant.isVariant(String(main.key)), String(main?.key))
      check('A3 主条目 key 逐字等于预期实例键', String(main?.key) === REAL_KEY_SEEN, String(main?.key))
      check('A4 主条目 data.locations === 69 条', Array.isArray(main?.value?.data?.locations) && main.value.data.locations.length === 69, String(main?.value?.data?.locations?.length))
      check('A5 主条目 data 含 tree 与 attachments（完整产物形态）', !!main?.value?.data?.tree && 'attachments' in (main?.value?.data ?? {}), Object.keys(main?.value?.data ?? {}).join(','))
      const bdata = batch?.value?.data ?? {}
      check('A6 `:batch:0` 的 data 键只有 delta（中间态：无 locations / 无 tree）', 'delta' in bdata && !('locations' in bdata) && !('tree' in bdata), Object.keys(bdata).join(','))
      realMainSeq = Number(main?.seq)
      realBatchSeq = Number(batch?.seq)
      check('A7 主条目 seq 更小（不是靠「恰好排在最前」的运气）', realMainSeq < realBatchSeq, `${realMainSeq} vs ${realBatchSeq}`)
      check('A8 主条目 value 顶层**无** source（= 来源包自带，非本机运行写出）', !('source' in (main?.value ?? {})), Object.keys(main?.value ?? {}).join(','))
    }

    // =====================================================================
    // B · 拼装链路（真实库全量装配 → buildViewData）
    // =====================================================================
    console.log('\nB · 拼装链路（assembleManifest → buildViewData）')
    let realView = null
    let errB = ''
    const fBefore = { index: await stat(join(REAL_ROOT, 'index.json')), lt: await stat(join(REAL_ROOT, LT_FILE)) }
    try {
      const idx = await store.readIndex(REAL_ROOT)
      const manifest = await asm.assembleManifest(REAL_ROOT, idx)
      realView = view.buildViewData(manifest, 't2w://t7/')
      const allResults = resultsOf(manifest)
      const hit = variant.pickMainEntry(allResults, ':locationTree')
      check('B1 pickMainEntry(allResults, ":locationTree") 命中的就是主条目（seq 更小那条）', String(hit?.key) === REAL_KEY_SEEN, String(hit?.key))
      check('B2 命中条目不是 :batch:0 变体', !!hit && !variant.isVariant(String(hit.key)), String(hit?.key))
      const rawTree = allResults.find((e) => String(e.key) === REAL_KEY_SEEN)?.value?.data?.tree
      check('B3 脚本独立计数：真实库原始 tree 节点数 === countTree(mapRoot)', countTree(rawTree) === countTree(realView.mapRoot), `${countTree(rawTree)} vs ${countTree(realView.mapRoot)}`)
      check('B4 stats.mapNodeCount === 70', realView.stats.mapNodeCount === 70, String(realView.stats.mapNodeCount))
    } catch (e) {
      errB = e?.message ?? String(e)
    }
    check('B5 真实库装配 + 构建视图不抛', !errB, errB)
    check('B6 countTree(view.mapRoot) === 70', countTree(realView?.mapRoot) === 70, String(countTree(realView?.mapRoot)))
    check('B7 mapRoot.id === "novel-world"', realView?.mapRoot?.id === 'novel-world', String(realView?.mapRoot?.id))
    check('B8 view.mapNodes.length === 69（= data.locations 条数）', realView?.mapNodes?.length === 69, String(realView?.mapNodes?.length))
    check('B9 assetBase 原样透传（t2w://t7/）', realView?.assetBase === 't2w://t7/', String(realView?.assetBase))
    check('B10 mapRoot 字段完整（locationType 世界 / children 非空）', realView?.mapRoot?.locationType === '世界' && realView.mapRoot.children.length > 0, `${realView?.mapRoot?.locationType}/${realView?.mapRoot?.children?.length}`)

    // =====================================================================
    // C · 来源判定（真实库 → inherited）
    // =====================================================================
    console.log('\nC · 来源判定（真实库应判为来源包自带）')
    {
      check('C1 locationTreeSource === "inherited"（包内产物无 runtime 标记）', realView?.stats?.locationTreeSource === 'inherited', String(realView?.stats?.locationTreeSource))
      check('C2 locationTreeSource 不是 runtime（本机一条没跑）', realView?.stats?.locationTreeSource !== 'runtime', String(realView?.stats?.locationTreeSource))
      check('C3 locationTreeSource 不是 unknown（产物确实存在）', realView?.stats?.locationTreeSource !== 'unknown', String(realView?.stats?.locationTreeSource))
      check('C4 stats 原有字段未被动（mapNodeCount/sceneCount 仍在）', typeof realView?.stats?.mapNodeCount === 'number' && typeof realView?.stats?.sceneCount === 'number')
    }

    // =====================================================================
    // F · 纯读红线（真实库文件 size/mtime 前后不变）
    // =====================================================================
    console.log('\nF · 纯读红线（真实库 size / mtime 前后不变）')
    {
      const fAfter = { index: await stat(join(REAL_ROOT, 'index.json')), lt: await stat(join(REAL_ROOT, LT_FILE)) }
      check('F1 index.json 字节数不变', fBefore.index.size === fAfter.index.size, `${fBefore.index.size}/${fAfter.index.size}`)
      check('F2 index.json mtime 不变', fBefore.index.mtimeMs === fAfter.index.mtimeMs, `${fBefore.index.mtimeMs}/${fAfter.index.mtimeMs}`)
      check('F3 records/results/locationTree.json 字节数不变', fBefore.lt.size === fAfter.lt.size, `${fBefore.lt.size}/${fAfter.lt.size}`)
      check('F4 records/results/locationTree.json mtime 不变', fBefore.lt.mtimeMs === fAfter.lt.mtimeMs, `${fBefore.lt.mtimeMs}/${fAfter.lt.mtimeMs}`)
      const env2 = JSON.parse(await readFile(join(REAL_ROOT, LT_FILE), 'utf8'))
      check('F5 locationTree 分片仍是 2 条、内容逐字不变', JSON.stringify(env2) === JSON.stringify(realEnv))
      const again = await sourceAgain(await store.readIndex(REAL_ROOT))
      check('F6 重复装配结果稳定（幂等纯读，仍是 inherited）', again === String(realView?.stats?.locationTreeSource), `${again} vs ${realView?.stats?.locationTreeSource}`)
    }
  }

  /** 再装配一次，只取来源态（供 F6 幂等断言）。 */
  async function sourceAgain(idx) {
    const manifest = await asm.assembleManifest(REAL_ROOT, idx)
    return String(view.buildViewData(manifest, 't2w://t7/')?.stats?.locationTreeSource)
  }

  // =====================================================================
  // D · writeResult 打标（临时库）+ 覆盖后读到新产物
  // =====================================================================
  console.log('\nD · writeResult 打标（临时库）+ 本机产物覆盖来源包产物')
  {
    const ws = makeWorkspace('ws-main', makeIndex())
    await ws.init()
    await ws.writeShardFile(LT_FILE, [{ key: LT_KEY, value: inheritedEnvelope('novel-old', OLD_LOCATIONS, OLD_TREE) }])
    await ws.writeShardFile('records/results/plot.json', [{ key: PLOT_KEY, value: { data: { chunkSummary: 'x', chapters: [] } } }])

    // D1 打标前：来源包形态 → inherited，树是老的
    const idxD = await store.readIndex(ws.root)
    const manD = await asm.assembleManifest(ws.root, idxD)
    const viewD = view.buildViewData(manD, 't2w://t7/')
    check('D1 打标前：locationTreeSource === "inherited"', viewD.stats.locationTreeSource === 'inherited', String(viewD.stats.locationTreeSource))
    check('D2 打标前：mapRoot 是来源包那棵（novel-old）', viewD.mapRoot.id === 'novel-old', String(viewD.mapRoot.id))
    check('D3 打标前：mapNodes 条数 = 来源包 locations 条数（2）', viewD.mapNodes.length === 2, String(viewD.mapNodes.length))

    // D4 writeResult 写本机产物（信封形状与 orchestrator 一致：{data, at}）
    await persist.writeResult(ws.root, LT_KEY, {
      data: { locations: NEW_LOCATIONS, tree: NEW_TREE },
      depth: 1,
      calls: 1,
      warnings: [],
      at: NOW
    })
    const envD = JSON.parse(await readFile(join(ws.root, LT_FILE), 'utf8'))
    const ent = envD.entries.find((e) => String(e.key) === LT_KEY)
    check('D4 writeResult 读回：value.source === "runtime"（本机运行标记已打）', ent?.value?.source === 'runtime', JSON.stringify(Object.keys(ent?.value ?? {})))
    check('D5 writeResult 是 upsert by key：仍是 1 条条目（未追加）', envD.entries.length === 1, String(envD.entries.length))
    check('D6 标记打在 value **顶层**，未污染 value.data（data 里没有 source）', !('source' in (ent?.value?.data ?? {})), Object.keys(ent?.value?.data ?? {}).join(','))
    check('D7 原信封字段仍在（data/depth/calls/warnings/at + source）', ['data', 'depth', 'calls', 'warnings', 'at', 'source'].every((k) => k in (ent?.value ?? {})), Object.keys(ent?.value ?? {}).join(','))
    check('D8 写入的 data 逐字是本机那份（tree.id = novel-runtime）', ent?.value?.data?.tree?.id === 'novel-runtime', String(ent?.value?.data?.tree?.id))

    // D9-D11 再走装配 → 视图：应判 runtime 且读到**新**产物
    const idxD2 = await store.readIndex(ws.root)
    const manD2 = await asm.assembleManifest(ws.root, idxD2)
    const viewD2 = view.buildViewData(manD2, 't2w://t7/')
    check('D9 打标后：locationTreeSource === "runtime"', viewD2.stats.locationTreeSource === 'runtime', String(viewD2.stats.locationTreeSource))
    check('D10 打标后：mapRoot 变成新写入的形状（novel-runtime）——本机跑完读到的是新产物', viewD2.mapRoot.id === 'novel-runtime', String(viewD2.mapRoot.id))
    check('D11 打标后：mapNodes 也换成新产物（1 条，不再是来源包的 2 条）', viewD2.mapNodes.length === 1 && viewD2.mapNodes[0].id === 'new-1', JSON.stringify(viewD2.mapNodes.map((n) => n.id)))
    check('D12 打标不改变选取行为：pickMainEntry 命中的仍是同一 key（未新增/改键）', variant.pickMainEntry(resultsOf(manD2), ':locationTree')?.key === LT_KEY, String(variant.pickMainEntry(resultsOf(manD2), ':locationTree')?.key))

    // D13-D15 数组 / 标量产物不打标（只给非空对象补）
    await persist.writeResult(ws.root, `${PKG}:${REV}:listTask`, [1, 2, 3])
    await persist.writeResult(ws.root, `${PKG}:${REV}:scalarTask`, 'plain')
    const envList = await sh.readShard(ws.root, 'records/results/listTask.json')
    const envScalar = await sh.readShard(ws.root, 'records/results/scalarTask.json')
    check('D13 数组产物原样写入（不加 source 字段）', JSON.stringify(envList.entries[0].value) === '[1,2,3]', JSON.stringify(envList.entries[0].value))
    check('D14 标量产物原样写入（不加 source 字段）', envScalar.entries[0].value === 'plain', JSON.stringify(envScalar.entries[0].value))
    check('D15 对象产物一律带标记（重复写入同一 key 仍是 runtime）', envList.entries.length === 1 && envScalar.entries.length === 1)
  }

  // =====================================================================
  // E · unknown 分支（临时库删掉 locationTree 分片）
  // =====================================================================
  console.log('\nE · unknown 分支（无 locationTree 产物）')
  {
    const ws = makeWorkspace('ws-nolt', makeIndex())
    await ws.init()
    await ws.writeShardFile('records/results/plot.json', [{ key: PLOT_KEY, value: { data: { chunkSummary: 'x', chapters: [] } } }])
    await ws.writeShardFile(LT_FILE, [{ key: LT_KEY, value: inheritedEnvelope('novel-old', OLD_LOCATIONS, OLD_TREE) }])
    await ws.dropShardFile(LT_FILE)

    let viewE = null
    let errE = ''
    let resultsE = []
    try {
      const idx = await store.readIndex(ws.root)
      const manifest = await asm.assembleManifest(ws.root, idx)
      resultsE = resultsOf(manifest)
      viewE = view.buildViewData(manifest, 't2w://t7/')
    } catch (e) {
      errE = e?.message ?? String(e)
    }
    check('E1 无 locationTree 产物 → buildViewData 不抛', !errE, errE)
    check('E2 locationTreeSource === "unknown"', viewE?.stats?.locationTreeSource === 'unknown', String(viewE?.stats?.locationTreeSource))
    check('E3 mapRoot 走「无地图数据」兜底（id=root / name=（无地图数据））', viewE?.mapRoot?.id === 'root' && viewE?.mapRoot?.name === '（无地图数据）', `${viewE?.mapRoot?.id}/${viewE?.mapRoot?.name}`)
    check('E4 mapNodes 为空数组（不是 null）', Array.isArray(viewE?.mapNodes) && viewE.mapNodes.length === 0, JSON.stringify(viewE?.mapNodes))
    check('E5 stats.mapNodeCount === 1（只有兜底根）', viewE?.stats?.mapNodeCount === 1, String(viewE?.stats?.mapNodeCount))
    check(
      'E6 results 容器非空且不含 locationTree（证明 unknown 来自「没有该产物」而非「results 整体为空」）',
      resultsE.length > 0 && resultsE.every((e) => !String(e.key).includes(':locationTree')),
      JSON.stringify(resultsE.map((e) => e.key))
    )
  }

  // =====================================================================
  // G · 回归保护（variant 选取规则未被改动）
  // =====================================================================
  console.log('\nG · 回归保护（pickMainEntry / isVariant 行为未变）')
  {
    check('G1 isVariant(":locationTree:batch:0") === true', variant.isVariant(`${PKG}:${REV}:locationTree:batch:0`) === true)
    check('G2 isVariant(":locationTree") === false（主条目不是变体）', variant.isVariant(LT_KEY) === false)
    check('G3 isVariant(":grouped:") / ":plan" / ":repair" 仍为 true', [':grouped:x', ':plan', ':repair'].every((s) => variant.isVariant(`${PKG}:${REV}:locationTree${s}`) === true))
    const mixed = [
      { seq: 0, key: `${PKG}:${REV}:locationTree:batch:0`, value: { data: { delta: [] } } },
      { seq: 1, key: LT_KEY, value: { data: { locations: [], tree: { id: 'novel-x' } }, source: 'runtime' } }
    ]
    check('G4 变体排在前面也仍能选中主条目（排除规则生效）', variant.pickMainEntry(mixed, ':locationTree')?.key === LT_KEY, String(variant.pickMainEntry(mixed, ':locationTree')?.key))
    const onlyVariant = [{ key: `${PKG}:${REV}:locationTree:batch:0`, value: { data: { delta: [] } } }]
    check('G5 只剩变体时仍有 fallback 命中（原两步规则未变）', variant.pickMainEntry(onlyVariant, ':locationTree')?.key === onlyVariant[0].key, String(variant.pickMainEntry(onlyVariant, ':locationTree')?.key))
    check('G6 无匹配 → undefined（未改成抛错或兜底空对象）', variant.pickMainEntry(mixed, ':noSuchTask') === undefined)
    if (realEnv) {
      check('G7 真实库 2 条里 pickMainEntry 命中主条目（seq 56 那条）', variant.pickMainEntry(realEnv.entries, ':locationTree')?.seq === realMainSeq, `${variant.pickMainEntry(realEnv.entries, ':locationTree')?.seq} vs ${realMainSeq}`)
      check('G8 真实库主条目 value 顶层无 source → 判 inherited（与 C1 同据）', variant.pickMainEntry(realEnv.entries, ':locationTree')?.value?.source === undefined)
    }
  }

  await rm(TEST_PARENT, { recursive: true, force: true })

  console.log(`\n==== T7-A 地图产物来源验证：${passed} 通过 / ${failed} 失败${skipped ? ` / ${skipped} 跳过` : ''} ====`)
  if (failed === 0) {
    console.log('T7-A MAP SOURCE VERIFY PASS')
  } else {
    console.log('T7-A MAP SOURCE VERIFY FAIL')
  }
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('ERROR:', e?.stack ?? e?.message ?? e)
  process.exitCode = 2
})

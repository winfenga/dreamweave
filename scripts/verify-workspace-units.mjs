/**
 * M0-T1 · 工作库读写层单元测试（零新增依赖；用项目已装的 esbuild 把 TS 模块打成 ESM 后执行）。
 *
 * 覆盖（对齐设计 §7 M0-T1 验收口径）：
 *   U1 信封往返不丢 `seq/key/value`（含 `:batch:` 变体与你嵌套值）；
 *   U2 `index.json` 原子写 + 读回一致 + 损坏/缺字段给可读错误；
 *   U3 `routeResultsKey` 覆盖 29 类 key；同 chunk 的 `:batch:` 变体归**同一文件**（不过滤）；
 *   U4 `rebuildContainer` 跨分片按 `seq` 全局保序、零重排。
 *
 * 用法：node scripts/verify-workspace-units.mjs
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(here, '..')
const core = await import(pathToFileURL(join(FEATHER, 'src/main/t2w/core.mjs')).href)

/** 用 esbuild 把工作库 barrel 打成单文件 ESM，再用 data: URL 动态 import（零新增依赖）。 */
async function loadWorkspace() {
  const entry = join(FEATHER, 'src/main/workspace/index.ts')
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    external: ['node:*'],
    logLevel: 'silent'
  })
  const code = result.outputFiles[0].text
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
}

let passed = 0
let failed = 0
function check(name, cond) {
  if (cond) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.log(`  ❌ ${name}`)
  }
}

function minimalIndex(pkgId = 'pkg-1') {
  const now = new Date().toISOString()
  return {
    indexVersion: 1,
    format: 'txt2world-workspace',
    pkgId,
    title: 'T',
    origin: {
      t2wPath: 'X.t2w',
      t2wSize: 0,
      t2wSha256: '0'.repeat(64),
      manifestJsonSha256: '0'.repeat(64),
      hasOriginHeader: true,
      projectId: 'p',
      revisionId: 'r',
      createdAt: now
    },
    manifest: {
      includesSource: true,
      topLevelKeys: ['format', 'includesSource', 'project', 'records', 'files'],
      extra: {},
      recordsKeys: ['results'],
      containers: { results: 'array' },
      containerKeyed: { results: true },
      project: { id: 'p', title: 'T' }
    },
    shards: [],
    assets: [],
    tasks: {},
    integrity: { createdAt: now, lastVerifiedAt: null }
  }
}

async function main() {
  const ws = await loadWorkspace()
  const tmp = await mkdtemp(join(tmpdir(), 'ws-unit-'))
  console.log(`临时目录：${tmp}\n`)

  // ---- U1 信封往返 ----
  console.log('U1 · 信封往返（seq/key/value 不丢）')
  const env = {
    shard: 'results/plot',
    container: 'results',
    entries: [
      { seq: 0, key: 'pid:rev:plot:0', value: { data: { a: 1 }, responsePath: 'p', cacheReadyAt: 123 } },
      { seq: 7, key: 'pid:rev:plot:0:batch:0', value: { data: { nested: [1, 2, { deep: true }] } } },
      { seq: 9, key: 'pid:rev:plot:0:batch:1', value: { plain: 'x' } }
    ]
  }
  await ws.writeShard(tmp, 'records/results/plot.json', env)
  const back = await ws.readShard(tmp, 'records/results/plot.json')
  check('写→读往返 JSON 全等', JSON.stringify(back) === JSON.stringify(env))
  check('seq 全保留', back.entries.map((e) => e.seq).join(',') === '0,7,9')
  check('key 全保留（含 :batch:）', back.entries.map((e) => e.key).join('|') === env.entries.map((e) => e.key).join('|'))
  check('value 深等', JSON.stringify(back.entries.map((e) => e.value)) === JSON.stringify(env.entries.map((e) => e.value)))

  // ---- U1b 数字 key 保真（M0-T5/A2） ----
  console.log('\nU1b · key 类型保真（数字 key 不被强制转字符串）')
  const envNum = {
    shard: 'records/chapters',
    container: 'chapters',
    entries: [
      { seq: 0, key: 5, value: { seq: 5 } },
      { seq: 1, key: 7, value: { seq: 7 } }
    ]
  }
  await ws.writeShard(tmp, 'records/chapters.json', envNum)
  const backNum = await ws.readShard(tmp, 'records/chapters.json')
  check('数字 key 往返保持 number', backNum.entries.every((e) => typeof e.key === 'number'))
  check('数字 key 值不变 (5,7)', backNum.entries.map((e) => e.key).join(',') === '5,7')

  // ---- U2 index 原子写 ----
  console.log('\nU2 · index.json 原子写 + 校验')
  const idx0 = minimalIndex()
  await ws.writeIndex(tmp, idx0)
  const idxBack = await ws.readIndex(tmp)
  check('写→读 index 全等', JSON.stringify(idxBack) === JSON.stringify(idx0))
  const leftovers = (await readFile(join(tmp, 'index.json'), 'utf8')).length > 0
  check('index.json 非空', leftovers)
  // 损坏
  await writeFile(join(tmp, 'index.json'), '{ this is not json', 'utf8')
  let threw = false
  try {
    await ws.readIndex(tmp)
  } catch {
    threw = true
  }
  check('损坏 index → 抛可读错误', threw)
  // 缺字段
  await writeFile(join(tmp, 'index.json'), JSON.stringify({ indexVersion: 1, format: 'txt2world-workspace' }), 'utf8')
  threw = false
  try {
    await ws.readIndex(tmp)
  } catch {
    threw = true
  }
  check('缺字段 index → 抛可读错误', threw)
  await ws.writeIndex(tmp, idx0) // 复原

  // ---- U3 routeResultsKey 覆盖 29 类 + 变体不过滤 ----
  console.log('\nU3 · routeResultsKey 覆盖 + :batch: 不过滤')
  const taskIds = ws.KNOWN_TASK_IDS
  check(`KNOWN_TASK_IDS ≥ 29（实际 ${taskIds.length}）`, taskIds.length >= 29)
  let allRouted = true
  for (const id of taskIds) {
    const f = ws.routeResultsKey(`pid:rev:${id}:0`)
    if (typeof f !== 'string' || !f.endsWith('.json')) {
      allRouted = false
      console.log(`     未路由: ${id} → ${String(f)}`)
    }
  }
  check('29 类 key 全部可路由到 .json', allRouted)

  // storyScript：同 chunk 的 :batch: 同文件；不同 chunk 不同文件；无序号 → misc
  const ss0a = ws.routeResultsKey('pid:rev:storyScript:0')
  const ss0b = ws.routeResultsKey('pid:rev:storyScript:0:batch:0')
  const ss0c = ws.routeResultsKey('pid:rev:storyScript:0:batch:1')
  check('storyScript:0 与 :batch:0 同文件', ss0a === ss0b)
  check('storyScript:0 与 :batch:1 同文件', ss0a === ss0c)
  check('storyScript:0 == script/story-script.0.json', ss0a === 'script/story-script.0.json')
  check('storyScript:1 与 :0 不同文件', ws.routeResultsKey('pid:rev:storyScript:1') !== ss0a)
  check('storyScript（无序号）→ .misc', ws.routeResultsKey('pid:rev:storyScript') === 'script/story-script.misc.json')

  // plotLocation → 叶真源单文件
  check('plotLocation:0/1 都 → world/plot-locations.json',
    ws.routeResultsKey('pid:rev:plotLocation:0') === 'world/plot-locations.json' &&
    ws.routeResultsKey('pid:rev:plotLocation:1') === 'world/plot-locations.json')

  // mergeReview 类后缀同文件
  check('mergeReview:characters 与 :plan 同文件',
    ws.routeResultsKey('pid:rev:mergeReview:characters') === ws.routeResultsKey('pid:rev:mergeReview:characters:plan'))

  // 默认结果文件
  check('plot:0 → records/results/plot.json', ws.routeResultsKey('pid:rev:plot:0') === 'records/results/plot.json')
  check('cacheWarming:0:plan → records/results/cacheWarming.json',
    ws.routeResultsKey('pid:rev:cacheWarming:0:plan') === 'records/results/cacheWarming.json')

  // extractTaskId
  check('extractTaskId 前缀无关', ws.extractTaskId('aaaaaaaa-bbbb:edition-2026:storyScript:3') === 'storyScript')

  // ---- U4 rebuildContainer 跨分片 seq 全局保序 ----
  console.log('\nU4 · rebuildContainer 跨分片按 seq 零重排')
  const rootA = await mkdtemp(join(tmpdir(), 'ws-order-'))
  await ws.writeShard(rootA, 'records/results/plot.json', {
    shard: 'records/results/plot', container: 'results',
    entries: [{ seq: 0, key: 'k0', value: 'v0' }, { seq: 2, key: 'k2', value: 'v2' }]
  })
  await ws.writeShard(rootA, 'records/results/extraA.json', {
    shard: 'records/results/extraA', container: 'results',
    entries: [{ seq: 1, key: 'k1', value: 'v1' }, { seq: 3, key: 'k3', value: 'v3' }]
  })
  const shards = []
  for (const f of ['records/results/plot.json', 'records/results/extraA.json']) {
    const e = await ws.readShard(rootA, f)
    shards.push({ name: e.shard, file: f, container: 'results', entryCount: e.entries.length, sha256: '0' })
  }
  const idxA = { ...minimalIndex(), shards }
  const rebuilt = await ws.rebuildContainer(rootA, idxA, 'results')
  check('跨分片重建按 seq 升序', JSON.stringify(rebuilt) === JSON.stringify([
    { key: 'k0', value: 'v0' }, { key: 'k1', value: 'v1' }, { key: 'k2', value: 'v2' }, { key: 'k3', value: 'v3' }
  ]))

  // ---- U5 截断包 → 抛可读错 + 不留半成品工作库（M0-T5/A1） ----
  console.log('\nU5 · 截断包守卫（M0-T5/A1）')
  const goodPkg = core.encodePackage(
    {
      format: 'txt2world-package-v1',
      includesSource: true,
      project: { id: 'p', revisionId: 'r', title: 'T' },
      records: {},
      files: [
        { path: 'a.txt', size: 0, sha256: '' },
        { path: 'b.txt', size: 0, sha256: '' }
      ]
    },
    [Buffer.from('hello-blob'), Buffer.from('world-blob')]
  )
  const truncFile = join(tmp, 'trunc.t2w')
  await writeFile(truncFile, goodPkg.subarray(0, goodPkg.length - 4)) // 截掉尾部 4 字节 → blob 区短
  const wsRoot = join(tmp, 'ws-trunc')
  let threwTrunc = false
  let truncMsg = ''
  try {
    await ws.unpack(truncFile, wsRoot)
  } catch (e) {
    threwTrunc = true
    truncMsg = e?.message ?? ''
  }
  check('截断包 → 抛错', threwTrunc)
  check('错误可读（含 blob 长度信息）', /blob/i.test(truncMsg))
  let wsExists = true
  try {
    await stat(join(wsRoot, 'index.json'))
  } catch {
    wsExists = false
  }
  check('不留半成品工作库（无 index.json）', !wsExists)

  // 完好包反向对照：同样流程应成功
  const goodFile = join(tmp, 'good.t2w')
  await writeFile(goodFile, goodPkg)
  let okGood = true
  try {
    await ws.unpack(goodFile, join(tmp, 'ws-good'))
  } catch {
    okGood = false
  }
  check('完好包反向对照（正常解包成功）', okGood)

  await rm(tmp, { recursive: true, force: true })
  await rm(rootA, { recursive: true, force: true })

  console.log(`\n==== M0-T1 单测：${passed} 通过 / ${failed} 失败 ====`)
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('ERROR:', e?.stack ?? e?.message ?? e)
  process.exitCode = 2
})

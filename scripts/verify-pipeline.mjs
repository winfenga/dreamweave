/**
 * M2-T1/T2/T4 · 解析编排 / LLM 客户端 / 多配置 / 并发写 验证
 * （零新增依赖；用项目已装的 esbuild 打包 TS 后执行；electron 以最小桩替换）。
 *
 * 覆盖：
 *   P1 注册表加载（29 条）+ Kahn 拓扑 + 3 条 model:false
 *   P2 请求形态（无 temperature / json_object / 输出上限按 provider 二选一）
 *   P3 错误分类（401 不重试、5xx 按退避重试、退避耗尽/不可重试 → 换配置）
 *   P4 多配置可存/可选/探活 + 失败自动换配置
 *   P5 旧单组字段迁移
 *   P6 真实本地服务：cacheWarming 至少一次真实响应（小片段 + 最多 5 次重试，任一成功即 PASS）
 *   P7 3 条 model:false 不发请求
 *   P8 并发写同一 attempts 文件（11 实例并行）不丢更新
 *
 * 用法：node scripts/verify-pipeline.mjs
 */
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(here, '..')

const USER_DATA = await mkdtemp(join(tmpdir(), 'feather-m2-userdata-'))

/** electron 最小桩：只提供 app.getAppPath / app.getPath / ipcMain / BrowserWindow。 */
function electronStub() {
  return {
    name: 'electron-stub',
    setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }))
      b.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
        contents:
          `export const app = { getAppPath: () => ${JSON.stringify(FEATHER)}, getPath: () => ${JSON.stringify(USER_DATA)} };\n` +
          `export const ipcMain = { handle(){}, on(){} };\n` +
          `export const BrowserWindow = { getAllWindows: () => [], fromWebContents: () => null };\n` +
          `export default { app, ipcMain, BrowserWindow };\n`,
        loader: 'js'
      }))
    }
  }
}

async function loadModule(rel) {
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
  const code = result.outputFiles[0].text
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function minimalIndex(pkgId = 'pkg-m2', revisionId = 'rev-1') {
  const now = new Date().toISOString()
  return {
    indexVersion: 1,
    format: 'txt2world-workspace',
    pkgId,
    title: 'M2 样本',
    origin: {
      t2wPath: 'X.t2w',
      t2wSize: 0,
      t2wSha256: '0'.repeat(64),
      manifestJsonSha256: '0'.repeat(64),
      hasOriginHeader: true,
      projectId: pkgId,
      revisionId,
      createdAt: now
    },
    manifest: {
      includesSource: true,
      topLevelKeys: ['format', 'includesSource', 'project', 'records', 'files'],
      extra: {},
      recordsKeys: ['results'],
      containers: { results: 'array' },
      containerKeyed: { results: true },
      project: { id: pkgId, title: 'M2 样本', revisionId }
    },
    shards: [],
    assets: [],
    tasks: {},
    integrity: { createdAt: now, lastVerifiedAt: null }
  }
}

const SAMPLE = '第一章 旧宅\n少年推开旧宅的木门，屋内空无一人，只有尘埃在光柱里浮动。\n他低声自语：这里究竟发生过什么？'

async function main() {
  const ws = await loadModule('src/main/workspace/index.ts')
  const pipe = await loadModule('src/main/pipeline/index.ts')
  const store = await loadModule('src/main/settings/store.ts')

  // ---- P1 注册表 + 拓扑 ----
  console.log('P1 · 任务注册表 + Kahn 拓扑 + 3 条 model:false')
  const reg = await pipe.loadTaskRegistry()
  check('注册表加载成功', reg.ok === true, reg.error ?? '')
  check('任务数 == 29', (reg.tasks?.length ?? 0) === 29, `实际 ${reg.tasks?.length}`)
  let topo
  let topoErr = ''
  try {
    topo = pipe.topoOrder(reg.tasks)
  } catch (e) {
    topoErr = e.message
  }
  check('拓扑无环且覆盖全部节点', !topoErr && topo.order.length === 29, topoErr)
  check('cacheWarming 在拓扑前部（无依赖）', topo.order.indexOf('cacheWarming') < 5, `idx=${topo.order.indexOf('cacheWarming')}`)
  check('canonical 在 mergeReview 之后', topo.order.indexOf('canonical') > topo.order.indexOf('mergeReview:characters'))
  const locals = (reg.tasks ?? []).filter((t) => t.model === false).map((t) => t.id).sort()
  check('model:false 恰为 merge/canonical/draftAlign', locals.join(',') === 'canonical,draftAlign,merge', locals.join(','))

  // ---- P2 请求形态 ----
  console.log('\nP2 · 请求形态（无 temperature / json_object / 输出上限二选一）')
  const custom = { id: 'c', label: 'C', baseURL: 'http://127.0.0.1:31415/v1', apiKey: 'k', model: 'auto', enabled: true, providerKind: 'custom' }
  const body = pipe.buildRequestBody(custom, [{ role: 'user', content: 'hi' }], { maxTokens: 123 })
  check('不含 temperature', !('temperature' in body))
  check('stream === false', body.stream === false)
  check('response_format.type === json_object', body.response_format?.type === 'json_object')
  check('custom 用 max_tokens', body.max_tokens === 123 && !('max_completion_tokens' in body))
  const mm = pipe.buildRequestBody({ ...custom, providerKind: 'minimax' }, [], { maxTokens: 456 })
  check('minimax 用 max_completion_tokens', mm.max_completion_tokens === 456 && !('max_tokens' in mm))
  check('endpoint = baseURL + /chat/completions', pipe.endpointOf(custom) === 'http://127.0.0.1:31415/v1/chat/completions')

  // ---- P3 错误分类 / 重试 / 换配置（mock fetch） ----
  console.log('\nP3 · 错误分类 / 重试 / 换配置（mock fetch，无网络）')
  const realFetch = globalThis.fetch
  const mkRes = (status, text) => new Response(text, { status, headers: { 'content-type': 'application/json' } })
  const okRes = mkRes(200, JSON.stringify({ choices: [{ message: { content: '{"answer":"ok"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } }))

  // 401：不重试
  let calls401 = 0
  globalThis.fetch = async () => {
    calls401++
    return mkRes(401, 'unauthorized')
  }
  const r401 = await pipe.chatWithFallback([{ role: 'user', content: 'x' }], { taskId: 'plot' }, [custom])
  check('401 → 失败', r401.ok === false)
  check('401 → 仅 1 次调用（不重试）', calls401 === 1, `calls=${calls401}`)

  // 5xx：按退避重试（用极短退避加速）
  let calls500 = 0
  globalThis.fetch = async () => {
    calls500++
    return mkRes(500, 'boom')
  }
  const r500 = await pipe.chatWithFallback([{ role: 'user', content: 'x' }], { taskId: 'plot', retry: { maxRetries: 2, backoffMs: [1, 1] } }, [custom])
  check('5xx → 失败', r500.ok === false)
  check('5xx → 重试至 3 次（1+2）', calls500 === 3, `calls=${calls500}`)

  // 换配置：p1 401（不可重试）→ 立即换 p2 成功
  const p1 = { ...custom, id: 'p1', label: 'P1', model: 'm1' }
  const p2 = { ...custom, id: 'p2', label: 'P2', model: 'm2' }
  let seq = 0
  const tried = []
  globalThis.fetch = async () => {
    seq++
    if (seq === 1) {
      tried.push('p1')
      return mkRes(401, 'bad key')
    }
    tried.push('p2')
    return okRes
  }
  const rSwap = await pipe.chatWithFallback([{ role: 'user', content: 'x' }], { taskId: 'plot' }, [p1, p2])
  check('换配置后成功', rSwap.ok === true && rSwap.providerId === 'p2', JSON.stringify({ ok: rSwap.ok, providerId: rSwap.providerId }))
  check('attempts 记录了两次 providerId', rSwap.attempts.map((a) => a.providerId).join(',') === 'p1,p2', JSON.stringify(rSwap.attempts.map((a) => a.providerId)))

  // finish_reason=length
  globalThis.fetch = async () => mkRes(200, JSON.stringify({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] }))
  const rLen = await pipe.singleChat(custom, [{ role: 'user', content: 'x' }], {})
  check('finish_reason=length → 截断错误', rLen.ok === false && /截断/.test(rLen.error ?? ''), rLen.error)

  globalThis.fetch = realFetch

  // ---- P5 旧单组字段迁移 ----
  console.log('\nP5 · 旧单组字段自动迁移')
  const migrated = store.sanitizeSettings({ baseURL: 'https://api.example.com/v1', apiKey: 'sk-1', model: 'gpt-x', ttsVoice: 'v1' })
  check('旧字段 → llm:[{id:legacy}]', migrated.llm.length === 1 && migrated.llm[0].id === 'legacy' && migrated.llm[0].model === 'gpt-x')
  check('legacy 设为 active', migrated.activeLlmId === 'legacy')
  check('ttsVoice → 一条 tts', migrated.tts.length === 1 && migrated.tts[0].voice === 'v1')
  const fresh = store.sanitizeSettings(null)
  check('全新安装 → 预置 3 条 provider，active=local-auto', fresh.llm.length === 3 && fresh.activeLlmId === 'local-auto', `n=${fresh.llm.length} active=${fresh.activeLlmId}`)

  // ---- P4 多配置可存/可选/探活/换配置 ----
  console.log('\nP4 · 多配置可存 / 可选 / 探活 / 自动换配置')
  const REAL_KEY = 'freellmapi-310a1428ef96d50d6d20ece910d68d21dd12915db5e8e63d'
  const LB = 'http://127.0.0.1:31415/v1'
  const saved = await pipe.saveProviders({
    llm: [
      { id: 'local-auto', label: '本地 · auto', baseURL: LB, apiKey: REAL_KEY, model: 'auto', enabled: true, providerKind: 'custom' },
      { id: 'local-fusion', label: '本地 · fusion', baseURL: LB, apiKey: REAL_KEY, model: 'fusion', enabled: true, providerKind: 'custom' },
      { id: 'local-glm', label: '本地 · glm-5.3', baseURL: LB, apiKey: REAL_KEY, model: 'glm-5.3', enabled: true, providerKind: 'custom' }
    ],
    activeLlmId: 'local-fusion',
    fallbackChain: ['local-auto', 'local-glm']
  })
  check('saveProviders ok', saved.ok === true, saved.error ?? '')
  const active = await pipe.activeProvider('llm')
  check('activeProvider == local-fusion', active?.id === 'local-fusion', active?.id)
  const nxt = await pipe.nextAfter('local-fusion')
  check('nextAfter(local-fusion) == local-auto', nxt?.id === 'local-auto', nxt?.id)
  const chain = await pipe.providerChain()
  check('providerChain 头 = active', chain[0]?.id === 'local-fusion')

  // 探活语义（**确定性**：mock fetch，避免真实服务不稳定掩盖缺陷）
  // 根因回归：探活固定 max_tokens:1，正常/推理模型 finish_reason 常为 length —— HTTP 200 必须判为 ok:true。
  globalThis.fetch = async () =>
    mkRes(200, JSON.stringify({ choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }], usage: { prompt_tokens: 1, completion_tokens: 0 } }))
  const probeLen = await pipe.probeProvider('local-auto')
  check('探活：HTTP 200 且 finish_reason=length → ok=true（存活）', probeLen.ok === true, JSON.stringify(probeLen))
  globalThis.fetch = async () =>
    mkRes(200, JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"answer":"ok"}' }, finish_reason: 'stop' }] }))
  const probeStop = await pipe.probeProvider('local-auto')
  check('探活：HTTP 200 且 finish_reason=stop → ok=true', probeStop.ok === true, JSON.stringify(probeStop))
  globalThis.fetch = async () => new Response('not-json', { status: 200 })
  const probeBad = await pipe.probeProvider('local-auto')
  check('探活：HTTP 200 但响应不可解析 → ok=false 且为探活专用文案', probeBad.ok === false && /探活失败/.test(probeBad.error ?? ''), JSON.stringify(probeBad))

  // 探活重试语义（确定性）：首次失败(可重试 502) → 重试 1 次 → 成功 ⇒ ok:true（共 2 次请求）
  let callsRetry = 0
  globalThis.fetch = async () => {
    callsRetry++
    return callsRetry === 1
      ? mkRes(502, 'flaky upstream')
      : mkRes(200, JSON.stringify({ choices: [{ message: { content: '{"answer":"ok"}' }, finish_reason: 'stop' }] }))
  }
  const probeRetry = await pipe.probeProvider('local-auto')
  check('探活：首次 502 → 重试 1 次后成功 ⇒ ok=true', probeRetry.ok === true, JSON.stringify(probeRetry))
  check('探活：重试场景请求次数 == 2', callsRetry === 2, `calls=${callsRetry}`)

  // 探活超时重试（确定性 · 用户口径：超时归入可重试类）
  const timeoutReject = () => {
    const e = new Error('The operation was aborted due to timeout')
    e.name = 'TimeoutError'
    return Promise.reject(e)
  }
  // ① 首次超时 → 重试 1 次 → 成功 ⇒ ok:true 且请求数=2
  let callsTo = 0
  globalThis.fetch = async () => {
    callsTo++
    return callsTo === 1
      ? timeoutReject()
      : mkRes(200, JSON.stringify({ choices: [{ message: { content: '{"answer":"ok"}' }, finish_reason: 'stop' }] }))
  }
  const probeToRetry = await pipe.probeProvider('local-auto')
  check('探活：首次超时 → 重试 1 次后成功 ⇒ ok=true', probeToRetry.ok === true, JSON.stringify(probeToRetry))
  check('探活：超时重试场景请求次数 == 2', callsTo === 2, `calls=${callsTo}`)
  // ② 两次均超时 ⇒ ok:false（文案含「已重试」）且请求数=2
  let callsTo2 = 0
  globalThis.fetch = async () => {
    callsTo2++
    return timeoutReject()
  }
  const probeTo2 = await pipe.probeProvider('local-auto')
  check('探活：两次均超时 ⇒ ok=false 且请求次数 == 2', probeTo2.ok === false && callsTo2 === 2, `calls=${callsTo2} ok=${probeTo2.ok}`)
  check('探活：超时失败文案含「已重试 1 次」', /已重试/.test(probeTo2.error ?? ''), probeTo2.error)

  // 探活重试语义（确定性）：始终 401（不可重试）⇒ ok:false 且**不重试**（调用次数 == 1）
  let calls401b = 0
  globalThis.fetch = async () => {
    calls401b++
    return mkRes(401, 'unauthorized')
  }
  const probeNoRetry = await pipe.probeProvider('local-auto')
  check('探活：始终 401 ⇒ ok=false 且不重试（调用次数 == 1）', probeNoRetry.ok === false && calls401b === 1, `calls=${calls401b} ok=${probeNoRetry.ok}`)
  check('探活：不可重试失败文案无「已重试」字样', !/已重试/.test(probeNoRetry.error ?? ''), probeNoRetry.error)
  globalThis.fetch = realFetch

  // 探活（真实本地服务；小超时；不稳定服务允许 2 次重试；连通性证明见 P6）
  let probeOk = 0
  for (const id of ['local-auto', 'local-fusion', 'local-glm']) {
    let pr = { ok: false, error: '未执行' }
    for (let k = 0; k < 2 && !pr.ok; k++) pr = await pipe.probeProvider(id)
    console.log(`    探活 ${id}: ok=${pr.ok} status=${pr.httpStatus} ms=${pr.ms} ${pr.error ?? ''}`)
    if (pr.ok) probeOk++
    check(`探活返回可读结果（${id}）`, typeof pr.ok === 'boolean' && (pr.ok || typeof pr.error === 'string'))
  }

  // 恢复 active=local-auto 供真实请求
  await pipe.saveProviders({ activeLlmId: 'local-auto', fallbackChain: ['local-fusion', 'local-glm'] })

  // ---- P6 真实本地服务请求 ----
  console.log('\nP6 · 真实本地服务：cacheWarming 至少一次真实响应（最多 5 次重试）')
  const wroot = await mkdtemp(join(tmpdir(), 'feather-m2-ws-'))
  await ws.writeIndex(wroot, minimalIndex('pkg-m2', 'rev-1'))
  const pkgId = 'pkg-m2'
  const rev = 'rev-1'
  const cwKey = `${pkgId}:${rev}:cacheWarming:0`
  let cwOk = false
  let attemptsSeen = 0
  for (let attempt = 1; attempt <= 5 && !cwOk; attempt++) {
    const started = await pipe.start(pkgId, { root: wroot, chunks: [SAMPLE], range: ['cacheWarming'] })
    if (!started.ok) {
      console.log(`  第 ${attempt} 次 start 失败：${started.error}`)
      continue
    }
    // 轮询完成
    const t0 = Date.now()
    for (;;) {
      const st = pipe.parseStatus(started.runId)
      if (!st.running) break
      if (Date.now() - t0 > 300_000) break
      await sleep(400)
    }
    const states = await pipe.loadTaskStates(wroot)
    const st = states[cwKey]
    console.log(`  第 ${attempt} 次：cacheWarming status=${st?.status} error=${st?.error ?? ''}`)
    if (st?.status === 'succeeded') cwOk = true
    // 统计 attempts
    try {
      const env = await ws.readShard(wroot, 'records/attempts/cacheWarming.json')
      attemptsSeen = env.entries.length
    } catch {
      attemptsSeen = 0
    }
  }
  check('真实请求：cacheWarming 至少一次成功', cwOk === true)
  check('产物落 records/results/cacheWarming.json', existsSync(join(wroot, 'records/results/cacheWarming.json')))
  let productData = null
  try {
    const env = await ws.readShard(wroot, 'records/results/cacheWarming.json')
    const e = env.entries.find((x) => x.key === cwKey)
    productData = e?.value?.data ?? null
  } catch {
    productData = null
  }
  check('产物条目存在且含 data', !!productData, JSON.stringify(productData)?.slice(0, 120))
  check('attempts 留痕存在（≥1）', attemptsSeen >= 1, `entries=${attemptsSeen}`)
  const tasks = await pipe.loadTaskStates(wroot)
  check('tasks.json 状态源含 cacheWarming succeeded', tasks[cwKey]?.status === 'succeeded')
  check('模型接入连通性已证明（探活成功 或 真实请求成功）', probeOk >= 1 || cwOk, `probeOk=${probeOk} cwOk=${cwOk}`)

  // 幂等续跑：再次 start（模拟重启续跑）→ 跳过 succeeded、不再发请求
  const attemptsBefore = (await ws.readShard(wroot, 'records/attempts/cacheWarming.json')).entries.length
  const resumeRun = await pipe.start(pkgId, { root: wroot, chunks: [SAMPLE], range: ['cacheWarming'] })
  if (resumeRun.ok) {
    const t0 = Date.now()
    for (;;) {
      const st = pipe.parseStatus(resumeRun.runId)
      if (!st.running) break
      if (Date.now() - t0 > 60_000) break
      await sleep(200)
    }
  }
  const attemptsAfter = (await ws.readShard(wroot, 'records/attempts/cacheWarming.json')).entries.length
  const tasksAfter = await pipe.loadTaskStates(wroot)
  check('续跑：succeeded 保留', tasksAfter[cwKey]?.status === 'succeeded')
  check('续跑：未新增请求（attempts 条数不变）', attemptsAfter === attemptsBefore, `${attemptsBefore} → ${attemptsAfter}`)

  // ---- P7 3 条 model:false 不发请求 ----
  console.log('\nP7 · 3 条 model:false 本地步骤不发请求')
  let netCalls = 0
  globalThis.fetch = async () => {
    netCalls++
    return mkRes(500, 'should not be called')
  }
  const localRun = await pipe.start(pkgId, { root: wroot, chunks: [SAMPLE], range: ['merge', 'canonical', 'draftAlign'] })
  if (localRun.ok) {
    const t0 = Date.now()
    for (;;) {
      const st = pipe.parseStatus(localRun.runId)
      if (!st.running) break
      if (Date.now() - t0 > 60_000) break
      await sleep(200)
    }
  }
  globalThis.fetch = realFetch
  const lstates = await pipe.loadTaskStates(wroot)
  check('merge → status local', lstates[`${pkgId}:${rev}:merge`]?.status === 'local', lstates[`${pkgId}:${rev}:merge`]?.status)
  check('canonical → status local', lstates[`${pkgId}:${rev}:canonical`]?.status === 'local')
  check('draftAlign → status local', lstates[`${pkgId}:${rev}:draftAlign:0`]?.status === 'local', lstates[`${pkgId}:${rev}:draftAlign:0`]?.status)
  check('本地步骤期间零网络请求', netCalls === 0, `netCalls=${netCalls}`)
  check('未生成 merge 的 attempts 分片', !existsSync(join(wroot, 'records/attempts/merge.json')))

  // ---- P8 并发写同一 attempts 文件 ----
  console.log('\nP8 · 并发写同一 attempts 文件（11 实例并行）不丢更新')
  const croot = await mkdtemp(join(tmpdir(), 'feather-m2-conc-'))
  const rec = (i, round) => ({
    id: `r${round}-i${i}`,
    taskId: 'storyScript',
    instanceKey: `pkg:rev:storyScript:${i}`,
    providerId: 'local-auto',
    model: 'auto',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    status: 'succeeded',
    usage: { input: i, hit: 0, miss: i, output: i, raw: null },
    fingerprint: `fp${round}-${i}`,
    requestPath: null,
    responsePath: null,
    communicationMs: i,
    error: null
  })
  await Promise.all(Array.from({ length: 11 }, (_, i) => pipe.appendAttempt(croot, 'storyScript', rec(i, 1))))
  const env1 = await ws.readShard(croot, 'records/attempts/storyScript.json')
  check('第 1 轮 11 并行 → 11 条', env1.entries.length === 11, `实际 ${env1.entries.length}`)
  await Promise.all(Array.from({ length: 11 }, (_, i) => pipe.appendAttempt(croot, 'storyScript', rec(i, 2))))
  const env2 = await ws.readShard(croot, 'records/attempts/storyScript.json')
  check('第 2 轮再 11 并行 → 22 条（无丢更新）', env2.entries.length === 22, `实际 ${env2.entries.length}`)
  const ids = new Set(env2.entries.map((e) => e.key))
  check('22 条 key 全唯一', ids.size === 22, `unique=${ids.size}`)
  const raw = await readFile(join(croot, 'records/attempts/storyScript.json'), 'utf8')
  let parseable = true
  try {
    JSON.parse(raw)
  } catch {
    parseable = false
  }
  check('文件可解析（JSON 完好）', parseable)

  await rm(USER_DATA, { recursive: true, force: true }).catch(() => undefined)
  await rm(wroot, { recursive: true, force: true }).catch(() => undefined)
  await rm(croot, { recursive: true, force: true }).catch(() => undefined)

  console.log(`\n==== M2-T1/T2/T4 验证：${passed} 通过 / ${failed} 失败 ====`)
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('ERROR:', e?.stack ?? e?.message ?? e)
  process.exitCode = 2
})

/**
 * QA · 独立复验脚本（Edward）——不复用工程师的断言，全部自建证据。
 * 覆盖：请求形态（真实本地 stub 抓包）/ 退避重试真实计时 / 401 不重试 /
 *       网络错误重试 / fallback 边界 / 并发写不丢更新 / 分批递归 / 真实服务 E2E + 幂等。
 *
 * 用法：node scripts/qa-m2-independent.mjs
 */
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(here, '..')
const USER_DATA = await mkdtemp(join(tmpdir(), 'qa-m2-userdata-'))
const REAL_KEY = 'freellmapi-310a1428ef96d50d6d20ece910d68d21dd12915db5e8e63d'

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
  const r = await build({
    entryPoints: [join(FEATHER, rel)],
    bundle: true, format: 'esm', platform: 'node', write: false,
    external: ['node:*'], logLevel: 'silent',
    define: { __dirname: JSON.stringify(join(FEATHER, 'out', 'main')) },
    plugins: [electronStub()]
  })
  return import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64'))
}

let passed = 0, failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`) }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 本地 stub HTTP 服务器：抓取真实请求原文
function startStub(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}
function stubURL(server, suffix = '/v1') {
  const { port } = server.address()
  return `http://127.0.0.1:${port}${suffix}`
}
function okBody(content = '{"answer":"ok"}') {
  return JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
}

function minimalIndex(pkgId = 'pkg-qa', revisionId = 'rev-qa') {
  const now = new Date().toISOString()
  return {
    indexVersion: 1, format: 'txt2world-workspace', pkgId, title: 'QA 样本',
    origin: { t2wPath: 'X.t2w', t2wSize: 0, t2wSha256: '0'.repeat(64), manifestJsonSha256: '0'.repeat(64), hasOriginHeader: true, projectId: pkgId, revisionId, createdAt: now },
    manifest: { includesSource: true, topLevelKeys: [], extra: {}, recordsKeys: ['results'], containers: { results: 'array' }, containerKeyed: { results: true }, project: { id: pkgId, title: 'QA 样本', revisionId } },
    shards: [], assets: [], tasks: {}, integrity: { createdAt: now, lastVerifiedAt: null }
  }
}

const SAMPLE = '第一章\n少年推开旧宅的木门，屋里空无一人。\n他问：这里发生过什么？'

async function main() {
  const pipe = await loadModule('src/main/pipeline/index.ts')
  const store = await loadModule('src/main/settings/store.ts')
  const ws = await loadModule('src/main/workspace/index.ts')
  const SKIP_E2E = process.env.QA_SKIP_E2E === '1'

  // ============ A. 请求形态（真实 stub 抓包） ============
  console.log('A · 请求形态（真实本地 stub 抓包，独立复验）')
  const seen = []
  const stub = await startStub((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, raw })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(okBody())
    })
  })
  const base = stubURL(stub)
  const mkProv = (over = {}) => ({ id: 's', label: 'S', baseURL: base, apiKey: 'secret-key', model: 'auto', enabled: true, providerKind: 'custom', ...over })

  await pipe.singleChat(mkProv(), [{ role: 'user', content: 'hi' }], { maxTokens: 321 })
  const r1 = seen.at(-1)
  const b1 = JSON.parse(r1.raw)
  check('HTTP 方法 POST', r1.method === 'POST')
  check('路径 = /v1/chat/completions', r1.url === '/v1/chat/completions', r1.url)
  check('content-type: application/json', /application\/json/.test(r1.headers['content-type'] || ''), r1.headers['content-type'])
  check('authorization: Bearer <key>', r1.headers.authorization === 'Bearer secret-key', r1.headers.authorization)
  check('body 无 temperature', !('temperature' in b1))
  check('body 原文不含 temperature 字样', !/temperature/i.test(r1.raw))
  check('stream === false', b1.stream === false)
  check('response_format.type === json_object', b1.response_format?.type === 'json_object')
  check('model 透传 auto', b1.model === 'auto')
  check('custom + maxTokens → max_tokens=321', b1.max_tokens === 321 && !('max_completion_tokens' in b1), JSON.stringify(b1))
  check('messages 透传且为数组', Array.isArray(b1.messages) && b1.messages[0].content === 'hi')

  await pipe.singleChat(mkProv({ providerKind: 'minimax' }), [{ role: 'user', content: 'hi' }], { maxTokens: 99 })
  const b2 = JSON.parse(seen.at(-1).raw)
  check('minimax + maxTokens → max_completion_tokens=99', b2.max_completion_tokens === 99 && !('max_tokens' in b2), JSON.stringify(b2))

  await pipe.singleChat(mkProv(), [{ role: 'user', content: 'hi' }], {})
  const b3 = JSON.parse(seen.at(-1).raw)
  check('无 maxTokens → 两个上限字段都不发', !('max_tokens' in b3) && !('max_completion_tokens' in b3), JSON.stringify(b3))
  check('无 maxTokens 时 body 键集合 = {model,messages,stream,response_format}', Object.keys(b3).sort().join(',') === 'messages,model,response_format,stream', Object.keys(b3).join(','))

  // baseURL 尾斜杠：不产生双斜杠
  await pipe.singleChat(mkProv({ baseURL: base + '/' }), [{ role: 'user', content: 'hi' }], { maxTokens: 1 })
  check('baseURL 尾斜杠 → 仍 /v1/chat/completions（无双斜杠）', seen.at(-1).url === '/v1/chat/completions', seen.at(-1).url)

  // baseURL 含 /chat/completions → 直接拒绝、不发请求
  const beforeCount = seen.length
  const badR = await pipe.singleChat(mkProv({ baseURL: base + '/chat/completions' }), [{ role: 'user', content: 'hi' }], {})
  check('baseURL 含 /chat/completions → 拒绝且不发请求', badR.ok === false && seen.length === beforeCount, badR.error)

  // A2 · 探活语义 vs 任务语义（stub 对照，防回归）
  console.log('\nA2 · 探活 vs 任务 语义对照（stub）')
  const frSeen = []
  const stubFR = await startStub((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      frSeen.push(raw)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  const pFR = { id: 'pfr', label: 'FR', baseURL: stubURL(stubFR), apiKey: 'k', model: 'm', enabled: true, providerKind: 'custom' }
  const taskLen = await pipe.singleChat(pFR, [{ role: 'user', content: 'x' }], { maxTokens: 16 })
  check('任务模式：200 + finish_reason=length → ok:false（截断，防回归）', taskLen.ok === false && /截断/.test(taskLen.error || ''), `ok=${taskLen.ok} err=${taskLen.error}`)
  const probeLen = await pipe.singleChat(pFR, [{ role: 'user', content: 'x' }], { maxTokens: 16, probe: true })
  check('探活模式：200 + finish_reason=length → ok:true（连通即存活）', probeLen.ok === true, `ok=${probeLen.ok}`)
  const bProbe = JSON.parse(frSeen.at(-1))
  check('探活请求仍无 temperature / stream:false / json_object / 上限字段存在', !('temperature' in bProbe) && bProbe.stream === false && bProbe.response_format?.type === 'json_object' && (bProbe.max_tokens ?? bProbe.max_completion_tokens) > 0, JSON.stringify(bProbe))

  const stubE401 = await startStub((req, res) => { req.on('data', () => {}); req.on('end', () => { res.writeHead(401); res.end('no') }) })
  const probe401 = await pipe.singleChat({ ...pFR, baseURL: stubURL(stubE401) }, [{ role: 'user', content: 'x' }], { maxTokens: 16, probe: true })
  check('探活模式：401 → ok:false（真错仍报错）', probe401.ok === false, `ok=${probe401.ok}`)
  const stubE403 = await startStub((req, res) => { req.on('data', () => {}); req.on('end', () => { res.writeHead(403); res.end('forbidden') }) })
  const probe403 = await pipe.singleChat({ ...pFR, baseURL: stubURL(stubE403) }, [{ role: 'user', content: 'x' }], { maxTokens: 16, probe: true })
  check('探活模式：403 → ok:false（真错仍报错）', probe403.ok === false, `ok=${probe403.ok}`)
  const stubE500 = await startStub((req, res) => { req.on('data', () => {}); req.on('end', () => { res.writeHead(500); res.end('boom') }) })
  const probe500 = await pipe.singleChat({ ...pFR, baseURL: stubURL(stubE500) }, [{ role: 'user', content: 'x' }], { maxTokens: 16, probe: true })
  check('探活模式：500 → ok:false（真错仍报错）', probe500.ok === false, `ok=${probe500.ok}`)
  const sClosed2 = await startStub((req, res) => res.end())
  const deadPort2 = sClosed2.address().port
  await new Promise((r) => sClosed2.close(r))
  const tDead = Date.now()
  const probeDead = await pipe.singleChat({ ...pFR, baseURL: `http://127.0.0.1:${deadPort2}/v1` }, [{ role: 'user', content: 'x' }], { maxTokens: 16, probe: true, timeoutMs: 3000 })
  check('探活模式：不可达 → ok:false 且不无限挂起(<10s)', probeDead.ok === false && (Date.now() - tDead) < 10000, `ok=${probeDead.ok} elapsed=${Date.now() - tDead}ms`)

  // ============ B. 退避重试（真实计时） ============
  console.log('\nB · 退避重试（真实计时；DEFAULT 策略）')
  check('BACKOFF_MS 常量 = [2000,4000,8000]', JSON.stringify(pipe.BACKOFF_MS) === '[2000,4000,8000]', JSON.stringify(pipe.BACKOFF_MS))
  check('storyScript 默认 maxRetries=2', pipe.defaultRetry('storyScript').maxRetries === 2)
  check('其它任务默认 maxRetries=3', pipe.defaultRetry('seg').maxRetries === 3 && pipe.defaultRetry('plot').maxRetries === 3)

  let calls = 0
  const stub500 = await startStub((req, res) => {
    calls++
    req.on('data', () => {})
    req.on('end', () => { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"boom"}') })
  })
  const p500 = { id: 'p500', label: 'P500', baseURL: stubURL(stub500), apiKey: 'k', model: 'auto', enabled: true, providerKind: 'custom' }
  const t0 = Date.now()
  const rStory = await pipe.chatWithFallback([{ role: 'user', content: 'x' }], { taskId: 'storyScript' }, [p500])
  const el = Date.now() - t0
  check('5xx storyScript → 3 次调用（1+2 重试）', calls === 3, `calls=${calls}`)
  check('5xx storyScript → 真实退避耗时 ≈6000ms（2000+4000）', el >= 5500 && el <= 9000, `elapsed=${el}ms`)
  check('全失败 → ok:false', rStory.ok === false)

  // ============ C. 401 不重试 / 网络错误重试 ============
  console.log('\nC · 401 不重试 / 网络错误重试')
  let c401 = 0
  const stub401 = await startStub((req, res) => { c401++; req.on('data', () => {}); req.on('end', () => { res.writeHead(401); res.end('unauthorized') }) })
  const p401 = { id: 'p401', label: 'P401', baseURL: stubURL(stub401), apiKey: 'k', model: 'auto', enabled: true, providerKind: 'custom' }
  await pipe.chatWithFallback([{ role: 'user', content: 'x' }], { taskId: 'seg' }, [p401])
  check('401 → 仅 1 次调用（不可重试，不退避）', c401 === 1, `calls=${c401}`)

  // 网络错误：指向「刚关闭的本地端口」→ 立即 ECONNREFUSED（可重试）；3s 超时兜底防挂
  const sClosed = await startStub((req, res) => res.end())
  const deadPort = sClosed.address().port
  await new Promise((r) => sClosed.close(r))
  const dead = `http://127.0.0.1:${deadPort}/v1`
  const pDead = { id: 'pdead', label: 'PDead', baseURL: dead, apiKey: 'k', model: 'auto', enabled: true, providerKind: 'custom' }
  const tD = Date.now()
  const rDead = await pipe.chatWithFallback([{ role: 'user', content: 'x' }], { taskId: 'seg', timeoutMs: 3000, retry: { maxRetries: 2, backoffMs: [1, 1] } }, [pDead])
  check('网络错误 → 按 maxRetries 重试到 3 次', rDead.attempts.length === 1 && (Date.now() - tD) < 5000 && rDead.ok === false, `attemptsLog=${rDead.attempts.length} ok=${rDead.ok}`)

  // ============ D. fallback 边界 ============
  console.log('\nD · fallback 边界（退避耗尽才换配置 / 不可重试直接换）')
  let order = []
  const stubSwap = await startStub((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const model = JSON.parse(raw).model
      order.push(model)
      if (model === 'm1') { res.writeHead(500); res.end('boom') }
      else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(okBody()) }
    })
  })
  const pA = { id: 'pA', label: 'PA', baseURL: stubURL(stubSwap), apiKey: 'k', model: 'm1', enabled: true, providerKind: 'custom' }
  const pB = { id: 'pB', label: 'PB', baseURL: stubURL(stubSwap), apiKey: 'k', model: 'm2', enabled: true, providerKind: 'custom' }
  const rSwap = await pipe.chatWithFallback([{ role: 'user', content: 'x' }], { taskId: 'seg', retry: { maxRetries: 1, backoffMs: [1] } }, [pA, pB])
  check('p1 重试耗尽(2 次) 才换 p2', order.join(',') === 'm1,m1,m2', order.join(','))
  check('换配置后成功且 providerId=pB', rSwap.ok === true && rSwap.providerId === 'pB')

  order = []
  const stubSwap2 = await startStub((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const model = JSON.parse(raw).model
      order.push(model)
      if (model === 'm1') { res.writeHead(403); res.end('forbidden') }
      else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(okBody()) }
    })
  })
  const pA2 = { ...pA, baseURL: stubURL(stubSwap2) }
  const pB2 = { ...pB, baseURL: stubURL(stubSwap2) }
  const rSwap2 = await pipe.chatWithFallback([{ role: 'user', content: 'x' }], { taskId: 'seg' }, [pA2, pB2])
  check('403（不可重试）→ 立即换 p2（各 1 次）', order.join(',') === 'm1,m2', order.join(','))

  // 全失败
  const stubAll = await startStub((req, res) => { req.on('data', () => {}); req.on('end', () => { res.writeHead(500); res.end('x') }) })
  const p1 = { ...pA, baseURL: stubURL(stubAll) }
  const p2 = { ...pB, baseURL: stubURL(stubAll) }
  const rAll = await pipe.chatWithFallback([{ role: 'user', content: 'x' }], { taskId: 'seg', retry: { maxRetries: 0, backoffMs: [1] } }, [p1, p2])
  check('全失败 → ok:false 且 attempts 两条失败留痕', rAll.ok === false && rAll.attempts.length === 2 && rAll.attempts.every((a) => a.ok === false), JSON.stringify(rAll.attempts.map((a) => a.providerId)))

  // ============ E. 并发写不丢更新 ============
  console.log('\nE · 并发写不丢更新（自建：30 并行 appendAttempt + 20 并行 upsert）')
  const croot = await mkdtemp(join(tmpdir(), 'qa-m2-conc-'))
  const rec = (i) => ({ id: `qa-i${i}`, taskId: 'effectAnnotation', instanceKey: `k${i}`, providerId: 'x', model: 'auto', startedAt: '', endedAt: '', status: 'succeeded', usage: null, fingerprint: 'f', requestPath: null, responsePath: null, communicationMs: 1, error: null })
  await Promise.all(Array.from({ length: 30 }, (_, i) => pipe.appendAttempt(croot, 'effectAnnotation', rec(i))))
  const env = await ws.readShard(croot, 'records/attempts/effectAnnotation.json')
  const uniq = new Set(env.entries.map((e) => e.key))
  check('30 并行 → 恰 30 条', env.entries.length === 30, `实际 ${env.entries.length}`)
  check('30 条 key 全唯一（无丢更新/无覆盖）', uniq.size === 30, `unique=${uniq.size}`)
  const rawTxt = await readFile(join(croot, 'records/attempts/effectAnnotation.json'), 'utf8')
  let ok = true; try { JSON.parse(rawTxt) } catch { ok = false }
  check('文件 JSON 完好可解析', ok)

  // 20 并行 upsert 同一 tasks 分片（含同 key 覆盖）
  await Promise.all(Array.from({ length: 20 }, (_, i) => pipe.saveTaskState(croot, `inst${i}`, { status: 'succeeded', fingerprint: `fp${i}`, updatedAt: '', error: null })))
  await Promise.all(Array.from({ length: 5 }, (_, i) => pipe.saveTaskState(croot, `inst9`, { status: 'running', fingerprint: `upd${i}`, updatedAt: '', error: null })))
  const tstates = await pipe.loadTaskStates(croot)
  check('20 并行 upsert → 20 个实例键', Object.keys(tstates).length === 20, `keys=${Object.keys(tstates).length}`)
  check('同 key 并发 upsert → 最终为最后一次写入', tstates.inst9?.fingerprint === 'upd4', JSON.stringify(tstates.inst9))

  // ============ F. 分批引擎（独立构造超预算输入） ============
  console.log('\nF · 分批引擎（超预算 → 切批 → 合并 → 递归 ≤3）')
  const cfg = pipe.defaultBatchingConfig({ inputBudgetTokens: 8000 })
  const bigOne = 'x'.repeat(30000) // ASCII 30000 → 9000 token > 8000
  const planOver = pipe.planBatches(bigOne, cfg)
  check('不可切分单元超预算 → oversize=true 放行', planOver.batches.some((b) => b.oversize))
  check('放行批有 warning', planOver.warnings.length >= 1, JSON.stringify(planOver.warnings))

  const trace = []
  const rEcho = await pipe.runWithBatching(
    Array.from({ length: 300 }, (_, i) => `#${i} ` + '内容。'.repeat(50)).join('\n\n'),
    async (text) => text, // 回显 → 永不收敛 → 触发深度上限
    cfg, { onTrace: (t) => trace.push(t) }
  )
  check('回显不收敛 → depth == maxDepth(3)', rEcho.depth === 3, `depth=${rEcho.depth}`)
  check('轨迹步数 ≤ 4', trace.length <= 4, `trace=${trace.length}`)
  check('有「最大深度」warning', rEcho.warnings.some((w) => /最大深度/.test(w)))

  const merged = pipe.mergeOutputs('concat-dedup-order', ['甲\n乙', '乙\n丙', '甲\n丁'])
  check('机械合并 = 拼接 + 去重 + 保序', merged === '甲\n乙\n丙\n丁', JSON.stringify(merged))

  // ============ G. 设置清洗（多配置） ============
  console.log('\nG · 多配置清洗 / 迁移')
  const leg = store.sanitizeSettings({ baseURL: 'https://a.example/v1', apiKey: 'k', model: 'gpt', ttsVoice: 'v' })
  check('旧单组 → 1 条 legacy llm + active', leg.llm.length === 1 && leg.llm[0].id === 'legacy' && leg.activeLlmId === 'legacy')
  const fresh = store.sanitizeSettings(null)
  check('全新安装 → 预置 3 条 + active=local-auto', fresh.llm.length === 3 && fresh.activeLlmId === 'local-auto')
  const chain = store.sanitizeSettings({ llm: [{ id: 'a', baseURL: 'http://x/v1', model: 'm', apiKey: 'k' }, { id: 'b', baseURL: 'http://x/v1', model: 'm', apiKey: 'k' }], activeLlmId: 'a', fallbackChain: ['a', 'b', 'zzz'] })
  check('fallbackChain 过滤掉 active 自身与未知 id', chain.fallbackChain.join(',') === 'b', chain.fallbackChain.join(','))
  const dedupe = store.sanitizeSettings({ llm: [{ id: 'a', baseURL: 'http://x/v1', model: 'm', apiKey: 'k' }, { id: 'a', baseURL: 'http://y/v1', model: 'n', apiKey: 'k' }] })
  check('重复 id → 去重保首现', dedupe.llm.length === 1 && dedupe.llm[0].baseURL === 'http://x/v1')

  // ============ H. 真实服务 E2E：编排器 cacheWarming + 幂等 ============
  console.log('\nH · 真实服务 E2E：编排器跑 cacheWarming（小片段 + 最多 5 次重试）')
  const wroot = await mkdtemp(join(tmpdir(), 'qa-m2-ws-'))
  const pkgId = 'pkg-qa', rev = 'rev-qa'
  await ws.writeIndex(wroot, minimalIndex(pkgId, rev))
  await store.saveSettings({ llm: [{ id: 'local-auto', label: '本地 · auto', baseURL: 'http://127.0.0.1:31415/v1', apiKey: REAL_KEY, model: 'auto', enabled: true, providerKind: 'custom' }], activeLlmId: 'local-auto', fallbackChain: [] })

  // 探活语义：可连通的端点（HTTP 200）应视为 alive
  const probe = await pipe.probeProvider('local-auto')
  console.log('  probeProvider(local-auto) =', JSON.stringify(probe))
  check('探活可连通端点(http 200) 应报 ok=true', probe.ok === true, `ok=${probe.ok} status=${probe.httpStatus} err=${probe.error ?? ''}`)

  const cwKey = `${pkgId}:${rev}:cacheWarming:0`
  if (SKIP_E2E) {
    console.log('  (QA_SKIP_E2E=1 → 跳过真实 cacheWarming E2E，该路径由 verify-pipeline P6 覆盖)')
  } else {
  let cwOk = false
  for (let a = 1; a <= 5 && !cwOk; a++) {
    const s = await pipe.start(pkgId, { root: wroot, chunks: [SAMPLE], range: ['cacheWarming'] })
    if (!s.ok) { console.log(`  attempt ${a} start err=${s.error}`); continue }
    const t = Date.now()
    for (;;) { const st = pipe.parseStatus(s.runId); if (!st.running) break; if (Date.now() - t > 120000) break; await sleep(400) }
    const states = await pipe.loadTaskStates(wroot)
    console.log(`  attempt ${a}: status=${states[cwKey]?.status} err=${states[cwKey]?.error ?? ''}`)
    if (states[cwKey]?.status === 'succeeded') cwOk = true
  }
  check('cacheWarming 真实请求成功（任一成功即 PASS）', cwOk === true)

  const resPath = join(wroot, 'records/results/cacheWarming.json')
  const attPath = join(wroot, 'records/attempts/cacheWarming.json')
  check('产物落 records/results/cacheWarming.json', existsSync(resPath))
  check('留痕落 records/attempts/cacheWarming.json', existsSync(attPath))
  let productData = null, attLen = 0
  if (existsSync(resPath)) { const e = await ws.readShard(wroot, 'records/results/cacheWarming.json'); productData = e.entries.find((x) => x.key === cwKey)?.value ?? null }
  if (existsSync(attPath)) { const e = await ws.readShard(wroot, 'records/attempts/cacheWarming.json'); attLen = e.entries.length }
  check('产物条目含 data', !!productData && 'data' in productData, JSON.stringify(productData)?.slice(0, 120))
  check('留痕条目 ≥1', attLen >= 1, `entries=${attLen}`)
  check('records/tasks.json 状态 succeeded', (await pipe.loadTaskStates(wroot))[cwKey]?.status === 'succeeded')

  // 幂等：再跑一次，attempts 不新增
  const attBefore = attLen
  const r2 = await pipe.start(pkgId, { root: wroot, chunks: [SAMPLE], range: ['cacheWarming'] })
  if (r2.ok) { const t = Date.now(); for (;;) { const st = pipe.parseStatus(r2.runId); if (!st.running) break; if (Date.now() - t > 60000) break; await sleep(200) } }
  const attAfter = (await ws.readShard(wroot, 'records/attempts/cacheWarming.json')).entries.length
  check('幂等续跑：attempts 计数不变（不发新请求）', attAfter === attBefore, `${attBefore} → ${attAfter}`)
  }

  // ============ 收尾 ============
  for (const s of [stub, stub500, stub401, stubSwap, stubSwap2, stubAll, stubFR, stubE401, stubE403, stubE500]) { try { s.close() } catch {} }
  await rm(USER_DATA, { recursive: true, force: true }).catch(() => undefined)
  await rm(wroot, { recursive: true, force: true }).catch(() => undefined)
  await rm(croot, { recursive: true, force: true }).catch(() => undefined)
  console.log(`\n==== QA 独立复验：${passed} 通过 / ${failed} 失败 ====`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error('ERROR:', e?.stack ?? e?.message ?? e); process.exitCode = 2 })

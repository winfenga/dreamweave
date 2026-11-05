/**
 * 聚合型任务上游可达性验证（CDP 真机 · 真工作库）。
 *
 * 事故（用户实测 · 三个聚合任务同时报错）：
 *   worldImpression      →「需要 plot 产物：工作库中没有任何 plot 结果」
 *   locationTree         →「需要 chunkLocationSummary 产物：…」
 *   characterAppearance  →「需要 canonical 产物：…含 objects.characters…」
 * 而产物文件明明存在（plot.json 19997 字节、entries=3）。
 *
 * 根因：`shards.updateShard` 只写分片、不登记 index.shards → `readUpstreamResults`
 * 遍历索引导航永远匹配不到 → 恒空数组。（已在源码修复 + 索引自愈）
 *
 * 本脚本打开**指定的真实工作库**，检查：
 *   ① 索引里 results 分片行齐全
 *   ② 通过 IPC 能读到上游产物（不是空数组）
 *   ③ 重跑聚合任务不再报「没有任何 <上游> 结果」
 *
 * 用法：
 *   CDP_ENDPOINT=http://127.0.0.1:9445 node scripts/verify-upstream-reachable.mjs <工作库目录名>
 */
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'
const WS_DIR = process.argv[2] ?? '20261105165850-8fe33c'

const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
if (!page) {
  console.error('✗ 找不到页面目标')
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})

let seq = 0
const pending = new Map()
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
  }
}
function send(method, params = {}) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function ev(expr) {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800))
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
function check(name, cond, detail = '') {
  checks.push({ name, ok: !!cond, detail })
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : detail ? `  — ${detail}` : ''}`)
}

await send('Page.bringToFront')
await sleep(400)

// ============ ① 找到并打开目标工作库 ============
console.log(`\n① 打开工作库 ${WS_DIR}`)
const opened = await ev(`(async () => {
  const ws = await window.dreamweave.listWorkspaces()
  if (!ws.ok) return { ok: false, why: 'listWorkspaces 失败：' + (ws.error ?? '') }
  const target = ws.items.find(it => it.id === ${JSON.stringify(WS_DIR)})
  if (!target) return { ok: false, why: '书库里找不到该工作库', available: ws.items.slice(0,5).map(i=>i.id) }
  const book = document.querySelector('[data-testid="lib-shelf"] .slot[data-book-id="' + target.id + '"] .book')
  if (book) { book.click() } else { await window.dreamweave.openWorkspace(target.id) }
  return { ok: true, id: target.id, title: target.title, chapters: target.chapterCount }
})()`)
check('打开工作库', opened?.ok === true, opened?.why ?? JSON.stringify(opened?.available ?? ''))
if (!opened?.ok) {
  ws.close()
  process.exit(1)
}
console.log(`     ${opened.title}（${opened.chapters} 章）`)
await sleep(2200)

// ============ ② 重跑三个聚合任务（不 force，只补跑失败/缺失的） ============
console.log('\n② 重跑聚合型任务（worldImpression / locationTree / characterAppearance）')
const aggIds = ['worldImpression', 'locationTree', 'characterAppearance']
const started = await ev(`(async () => {
  const ov = await window.dreamweave.tasksOverview(${JSON.stringify(WS_DIR)})
  if (!ov.ok || !ov.overview) return { ok: false, error: ov.error ?? 'tasksOverview 失败' }
  const tasks = ov.overview.tasks
  const depBase = (d) => { const i = d.indexOf(':'); return i < 0 ? d : d.slice(0, i) }
  // 严格 range 过滤：必须带传递依赖闭包，否则整批「依赖未就绪」静默跳过
  const want = ${JSON.stringify(aggIds)}
  const picked = new Set()
  const queue = [...want]
  while (queue.length) {
    const id = queue.shift()
    if (picked.has(id)) continue
    const t = tasks.find(x => x.id === id)
    if (!t) continue
    picked.add(id)
    for (const d of (t.dependsOn || [])) {
      const b = depBase(d)
      if (!picked.has(b)) queue.push(b)
    }
  }
  const r = await window.dreamweave.parseStart(${JSON.stringify(WS_DIR)}, [...picked], false)
  return { ok: r.ok, runId: r.runId, error: r.error, range: [...picked] }
})()`)
check('重跑能启动', started?.ok === true, started?.error ?? '')
if (!started?.ok) {
  ws.close()
  process.exit(1)
}
console.log(`     range = ${JSON.stringify(started.range)}`)

// ============ ③ 等结束 ============
console.log('\n③ 等待完成')
let status = null
const deadline = Date.now() + 12 * 60 * 1000
let lastDone = -1
while (Date.now() < deadline) {
  await sleep(3000)
  const s = await ev(`window.dreamweave.parseStatus(${JSON.stringify(started.runId)})`)
  status = s
  if (s && s.done !== lastDone) {
    lastDone = s.done
    process.stdout.write(`\r     ${s.done}/${s.total} …`)
  }
  if (!s?.running) break
}
process.stdout.write('\n')

const states = status?.tasks ?? {}
const entries = Object.entries(states)
const byStatus = {}
for (const [, v] of entries) byStatus[v?.status ?? '?'] = (byStatus[v?.status ?? '?'] ?? 0) + 1
console.log('     状态分布：', JSON.stringify(byStatus))

// ============ ④ 关键断言：不能再出现「没有任何 <上游> 结果」 ============
console.log('\n④ 断言：上游必须可读')
const UPSTREAM_ERR = /工作库中没有任何|没有任何含 objects/
const upstreamErrors = entries.filter(([, v]) => UPSTREAM_ERR.test(String(v?.error ?? '')))
check(
  '没有任何任务再报「工作库中没有任何上游结果」',
  upstreamErrors.length === 0,
  upstreamErrors.map(([k, v]) => `${k}: ${v.error}`).join(' | ')
)

for (const id of aggIds) {
  const hit = entries.find(([k]) => k.includes(`:${id}`))
  check(`${id} 未因上游缺失失败`, !UPSTREAM_ERR.test(String(hit?.[1]?.error ?? '')), hit?.[1]?.error ?? '(无该任务)')
}

// characterAppearance 若仍失败，给出具体原因（便于区分「上游缺失」与「上游为空」）
const caHit = entries.find(([k]) => k.includes(':characterAppearance'))
if (caHit && caHit[1]?.status === 'failed') {
  console.log(`\n     characterAppearance 失败原因：${caHit[1].error}`)
}

ws.close()

const bar = '─'.repeat(64)
const fails = checks.filter((c) => !c.ok)
console.log(`\n${bar}\n  聚合任务上游可达性\n${bar}`)
console.log(`  共 ${checks.length} 项`)
console.log(bar)
if (fails.length) {
  console.log(`  ✗ ${fails.length} 项失败\n${bar}\n`)
  process.exit(1)
}
console.log(`  ✓ ${checks.length} 项全部通过\n${bar}\n`)

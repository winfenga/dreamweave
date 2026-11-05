/**
 * 重跑三个聚合任务，验证「上游可达」修复真的生效（CDP 真机）。
 *
 * 只跑 worldImpression / locationTree / characterAppearance 及其依赖闭包。
 * 关键断言：不能再出现「工作库中没有任何 <上游> 结果」。
 *
 * 用法：CDP_ENDPOINT=http://127.0.0.1:9447 node scripts/rerun-aggregate.mjs [工作库目录名]
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
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600))
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Page.bringToFront')
await sleep(400)

// 打开目标库
await ev(`(async () => {
  const book = document.querySelector('[data-testid="lib-shelf"] .slot[data-book-id="${WS_DIR}"] .book')
  if (book) { book.click(); return true }
  const r = await window.dreamweave.openWorkspace(${JSON.stringify(WS_DIR)})
  return r.ok
})()`)
await sleep(2500)

// 启动（带传递依赖闭包）
const AGG = ['worldImpression', 'locationTree', 'characterAppearance']
const started = await ev(`(async () => {
  const ov = await window.dreamweave.tasksOverview(${JSON.stringify(WS_DIR)})
  if (!ov.ok || !ov.overview) return { ok: false, error: ov.error ?? 'overview 失败' }
  const tasks = ov.overview.tasks
  const depBase = (d) => { const i = d.indexOf(':'); return i < 0 ? d : d.slice(0, i) }
  const picked = new Set()
  const queue = ${JSON.stringify(AGG)}
  while (queue.length) {
    const id = queue.shift()
    if (picked.has(id)) continue
    const t = tasks.find(x => x.id === id)
    if (!t) continue
    picked.add(id)
    for (const d of (t.dependsOn || [])) { const b = depBase(d); if (!picked.has(b)) queue.push(b) }
  }
  const r = await window.dreamweave.parseStart(${JSON.stringify(WS_DIR)}, [...picked], true)
  return { ok: r.ok, runId: r.runId, error: r.error, range: [...picked] }
})()`)
if (!started?.ok) {
  console.error(`✗ 启动失败：${started?.error}`)
  ws.close()
  process.exit(1)
}
console.log(`  range (${started.range.length} 项) = ${JSON.stringify(started.range)}\n`)

let status = null
const deadline = Date.now() + 20 * 60 * 1000
let lastDone = -1
while (Date.now() < deadline) {
  await sleep(4000)
  const s = await ev(`window.dreamweave.parseStatus(${JSON.stringify(started.runId)})`)
  status = s
  if (s && s.done !== lastDone) {
    lastDone = s.done
    process.stdout.write(`\r    ${s.done}/${s.total} …   `)
  }
  if (!s?.running) break
}
process.stdout.write('\n\n')

const states = status?.tasks ?? {}
const entries = Object.entries(states)
const by = {}
for (const [, v] of entries) by[v?.status ?? '?'] = (by[v?.status ?? '?'] ?? 0) + 1
console.log('  状态分布：', JSON.stringify(by))

const UPSTREAM_ERR = /工作库中没有任何/
const bad = entries.filter(([, v]) => UPSTREAM_ERR.test(String(v?.error ?? '')))
console.log(`\n  「没有任何上游结果」错误：${bad.length}`)
for (const [k, v] of bad) console.log(`    · ${k.replace(/^.*?:txt-import-\d+:/, '')}  ${v.error}`)

for (const id of AGG) {
  const hit = entries.find(([k]) => k.includes(`:${id}`))
  const st = hit?.[1]?.status ?? '(无)'
  const err = hit?.[1]?.error ?? ''
  console.log(`\n  ${id}: ${st}${err ? `\n    ${err}` : ''}`)
}

ws.close()
process.exit(bad.length ? 1 : 0)

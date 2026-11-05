/**
 * 快速检查：打包版里聚合型任务的上游是否可达（不跑长任务）。
 *
 * 事故：worldImpression / locationTree / characterAppearance 报「工作库中没有任何
 * <上游> 结果」，但产物文件存在。根因是 index.shards 未登记（已修 + 自愈）。
 *
 * 本脚本只做只读检查：索引分片行数、上游产物可读性、聚合任务当前状态。
 * 用法：CDP_ENDPOINT=http://127.0.0.1:9447 node scripts/check-upstream.mjs [工作库目录名]
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

const checks = []
function check(name, cond, detail = '') {
  checks.push({ name, ok: !!cond, detail })
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : detail ? `  — ${detail}` : ''}`)
}

await send('Page.bringToFront')
await sleep(400)

const wsList = await ev(`(async () => {
  const w = await window.dreamweave.listWorkspaces()
  return { ok: w.ok, n: (w.items || []).length, items: (w.items || []).map(i => ({ id: i.id, title: i.title })) }
})()`)
check('书库可列出', wsList?.ok === true && wsList.n > 0, JSON.stringify(wsList?.items?.slice(0, 3)))

const target = wsList.items.find((i) => i.id === WS_DIR)
check(`找到目标工作库 ${WS_DIR}`, target !== undefined, wsList.items.map((i) => i.id).join(', '))
if (!target) {
  ws.close()
  process.exit(1)
}
console.log(`     ${target.title}`)

// 打开（走 UI 路径，触发开库时的索引自愈）
await ev(`(async () => {
  const book = document.querySelector('[data-testid="lib-shelf"] .slot[data-book-id="${WS_DIR}"] .book')
  if (book) { book.click(); return true }
  const r = await window.dreamweave.openWorkspace(${JSON.stringify(WS_DIR)})
  return r.ok
})()`)
await sleep(2500)

// 任务概览
const ov = await ev(`window.dreamweave.tasksOverview(${JSON.stringify(WS_DIR)})`)
check('任务概览可取', ov?.ok === true, ov?.error ?? '')
const tasks = ov?.overview?.tasks ?? []
console.log(`     任务数：${tasks.length}`)

const agg = ['worldImpression', 'locationTree', 'characterAppearance']
for (const id of agg) {
  const t = tasks.find((x) => x.id === id)
  const state = t?.state ?? t?.status ?? '(无)'
  console.log(`     ${id}: ${state}`)
}

// 关键：不再有「工作库中没有任何上游结果」这类错误
const ALL = JSON.stringify(ov ?? {})
const hasUpstreamErr = /工作库中没有任何/.test(ALL)
check('概览里没有任何「工作库中没有任何上游结果」错误', !hasUpstreamErr, '仍存在该错误')

// 分片行数（本地读，不依赖 IPC）
const { readFileSync } = await import('node:fs')
const idxPath = `D:\\galcomic\\dreamweave\\dist\\win-unpacked\\resources\\DreamWeave-data\\workspace\\${WS_DIR}\\index.json`
let shardCount = -1
try {
  shardCount = JSON.parse(readFileSync(idxPath, 'utf8')).shards.length
} catch (e) {
  shardCount = -1
}
check('索引已含完整分片行（应为 19）', shardCount === 19, String(shardCount))

ws.close()

const bar = '─'.repeat(64)
const fails = checks.filter((c) => !c.ok)
console.log(`\n${bar}\n  上游可达性快检\n${bar}`)
console.log(`  共 ${checks.length} 项，失败 ${fails.length}`)
console.log(bar)
process.exit(fails.length ? 1 : 0)

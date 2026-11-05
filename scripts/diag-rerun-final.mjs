/**
 * 最终定位：让 rerun 一定被调用，看它卡在哪一步。
 *
 * 手段：在页面里用 Object.defineProperty 劫持 dreamweave.parseStart（更可靠），
 * 并监听所有 error。然后点击按钮。
 *
 * 用法：CDP_ENDPOINT=http://127.0.0.1:9335 node scripts/diag-rerun-final.mjs 20261105164508-bad181
 */
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'
const WS_NAME = process.argv[2] ?? null

const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
let seq = 0
const pending = new Map()
const pageErrors = []
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
    return
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push(msg.params.exceptionDetails?.exception?.description?.slice(0, 300) ?? '?')
  }
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    pageErrors.push(`[${msg.params.type}] ` + (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300))
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
  if (r.exceptionDetails) return { __exc: JSON.stringify(r.exceptionDetails).slice(0, 700) }
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Runtime.enable')
await send('Page.bringToFront')
await sleep(400)

await ev(`(async () => {
  const slot = document.querySelector('[data-testid="lib-shelf"] .slot[data-book-id="${WS_NAME}"]')
  if (slot) (slot.querySelector('.book') || slot).click()
  else await window.dreamweave.openWorkspace(${JSON.stringify(WS_NAME)})
  await new Promise(r => setTimeout(r, 1800))
  const ov = Array.from(document.querySelectorAll('aside button')).find(x => (x.textContent||'').includes('概览'))
  if (ov) ov.click()
  return true
})()`)
await sleep(2200)

// 劫持：用 defineProperty 确保拦截生效，并在 wrapper 里记录调用栈
console.log('\n① 劫持 parseStart（记录调用栈）')
const installed = await ev(`(() => {
  window.__trace = []
  const dw = window.dreamweave
  const orig = dw.parseStart
  const wrapped = function (pkgId, range, force) {
    window.__trace.push({ hit: 'parseStart', pkgId, rangeLen: Array.isArray(range) ? range.length : range, hasScript: Array.isArray(range) && range.includes('mangaScript'), stack: new Error().stack.split('\\n').slice(1,6).join(' <- ') })
    return Promise.resolve({ ok: false, runId: null, error: '__DIAG__' })
  }
  try {
    Object.defineProperty(dw, 'parseStart', { value: wrapped, writable: true, configurable: true })
  } catch (e) {
    dw.parseStart = wrapped
  }
  // 同时记录 confirm/alert 被调用
  window.__confirmCalls = 0
  const oc = window.confirm
  window.confirm = function (...a) { window.__confirmCalls++; return oc.apply(this, a) }
  return { installed: dw.parseStart === wrapped }
})()`)
console.log(`     ${JSON.stringify(installed)}`)

// 点击（滚动到可视区）
console.log('\n② 滚动到按钮并点击')
const clicked = await ev(`(() => {
  const b = document.querySelector('[data-testid="parse-rerun-mangaEffects"]')
  if (!b) return { ok: false, why: 'no btn' }
  b.scrollIntoView({ block: 'center' })
  const r = b.getBoundingClientRect()
  const top = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2)
  const covered = !(top === b || b.contains(top))
  b.click()
  return { ok: true, covered, topTag: top?.tagName, topTestid: top?.getAttribute?.('data-testid') ?? null, disabled: b.disabled }
})()`)
console.log(`     ${JSON.stringify(clicked)}`)
await sleep(1500)

const trace = await ev('window.__trace')
console.log(`\n③ parseStart 调用记录: ${JSON.stringify(trace, null, 2)}`)

// 也试试其它重跑按钮，看是不是全部都这样
console.log('\n④ 试其它重跑按钮（cacheWarming，无依赖）')
const other = await ev(`(async () => {
  window.__trace = []
  const b = document.querySelector('[data-testid="parse-rerun-cacheWarming"]')
  if (!b) return { ok: false }
  b.scrollIntoView({ block: 'center' })
  b.click()
  await new Promise(r => setTimeout(r, 1200))
  return { trace: window.__trace }
})()`)
console.log(`     ${JSON.stringify(other, null, 2)}`)

// 试顶部「开始解析（全部）」
console.log('\n⑤ 试顶部「开始解析（全部）」按钮')
const topBtn = await ev(`(async () => {
  window.__trace = []
  const b = document.querySelector('[data-testid="parse-start"]')
  if (!b) return { ok: false, why: 'no parse-start' }
  b.scrollIntoView({ block: 'center' })
  b.click()
  await new Promise(r => setTimeout(r, 1500))
  return { trace: window.__trace }
})()`)
console.log(`     ${JSON.stringify(topBtn, null, 2)}`)

if (pageErrors.length) {
  console.log(`\n⑥ 页面错误 (${pageErrors.length})`)
  for (const e of pageErrors.slice(0, 8)) console.log(`     ${e}`)
} else {
  console.log('\n⑥ 页面无错误')
}

ws.close()

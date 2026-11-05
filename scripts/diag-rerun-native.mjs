/**
 * 用原生事件监听判断「点击是否到达按钮」。
 * 不发真请求。
 *
 * 用法：CDP_ENDPOINT=http://127.0.0.1:9335 node scripts/diag-rerun-native.mjs 20261105164508-bad181
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
  if (r.exceptionDetails) return { __exc: JSON.stringify(r.exceptionDetails).slice(0, 600) }
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await send('Page.bringToFront')
await sleep(400)

// 定位到目标书 + 概览
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

// 埋点：捕获阶段 + 冒泡阶段 + IPC
console.log('\n① 安装监听')
const hook = await ev(`(() => {
  window.__evt = []
  const sel = '[data-testid="parse-rerun-mangaEffects"]'
  const btn = document.querySelector(sel)
  if (!btn) return { ok: false, why: 'no button' }
  // 捕获阶段
  btn.addEventListener('click', (e) => {
    window.__evt.push({ phase: 'target-capture', trusted: e.isTrusted, defaultPrevented: e.defaultPrevented })
  }, true)
  // 冒泡阶段
  btn.addEventListener('click', (e) => {
    window.__evt.push({ phase: 'target-bubble', trusted: e.isTrusted })
  })
  // 文档级捕获（Vue 的 @click 是绑在元素上的，这里只是确认事件确实发出）
  document.addEventListener('click', (e) => {
    const t = e.target
    window.__evt.push({
      phase: 'document',
      tag: t?.tagName,
      testid: t?.getAttribute?.('data-testid') ?? null,
      trusted: e.isTrusted
    })
  }, true)
  // 拦截 IPC
  window.__ipc = []
  const dw = window.dreamweave
  const orig = dw.parseStart
  dw.parseStart = function (pkgId, range, force) {
    window.__ipc.push({ pkgId, range, force })
    return Promise.resolve({ ok: false, runId: null, error: '__DIAG__' })
  }
  return { ok: true, btnClass: btn.className, disabled: btn.disabled }
})()`)
console.log(`     ${JSON.stringify(hook)}`)

console.log('\n② 用 CDP 真实鼠标点击（Input.dispatchMouseEvent，isTrusted=true）')
const rect = await ev(`(() => {
  const b = document.querySelector('[data-testid="parse-rerun-mangaEffects"]')
  const r = b.getBoundingClientRect()
  return { x: r.x + r.width/2, y: r.y + r.height/2 }
})()`)
console.log(`     按钮中心: ${JSON.stringify(rect)}`)

if (rect?.x) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
}
await sleep(1500)

const evt = await ev('window.__evt')
const ipc = await ev('window.__ipc')
console.log(`\n③ 事件记录: ${JSON.stringify(evt, null, 2)}`)
console.log(`\n④ IPC: ${JSON.stringify(ipc)}`)

console.log('\n⑤ 对照组：用 element.click() 再点一次')
await ev(`window.__evt = []; window.__ipc = []; document.querySelector('[data-testid="parse-rerun-mangaEffects"]').click(); true`)
await sleep(1200)
const evt2 = await ev('window.__evt')
const ipc2 = await ev('window.__ipc')
console.log(`     事件: ${JSON.stringify(evt2)}`)
console.log(`     IPC: ${JSON.stringify(ipc2)}`)

console.log('\n⑥ 检查按钮是否被其它元素遮挡')
const cover = await ev(`(() => {
  const b = document.querySelector('[data-testid="parse-rerun-mangaEffects"]')
  const r = b.getBoundingClientRect()
  const top = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2)
  return {
    topTag: top?.tagName,
    topTestid: top?.getAttribute?.('data-testid') ?? null,
    isSame: top === b || b.contains(top),
    btnRect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    viewport: { w: window.innerWidth, h: window.innerHeight }
  }
})()`)
console.log(`     ${JSON.stringify(cover, null, 2)}`)

ws.close()

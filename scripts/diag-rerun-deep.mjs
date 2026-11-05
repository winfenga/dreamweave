/**
 * 深入诊断：为什么点了「重跑」没有调 parseStart。
 *
 * 思路：拦截 console 与 parseStart，点击按钮，看 rerun() 是否执行到 start()。
 * 不发真请求。
 *
 * 用法：CDP_ENDPOINT=http://127.0.0.1:9335 node scripts/diag-rerun-deep.mjs 20261105164508-bad181
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
  if (r.exceptionDetails) return { __exc: JSON.stringify(r.exceptionDetails).slice(0, 800) }
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await send('Page.bringToFront')
await sleep(500)

// 确保在目标书的概览页
await ev(`(async () => {
  const w = await window.dreamweave.listWorkspaces()
  const t = w.items.find(i => i.id === ${JSON.stringify(WS_NAME)})
  const slot = document.querySelector('[data-testid="lib-shelf"] .slot[data-book-id="' + ${JSON.stringify(WS_NAME)} + '"]')
  if (slot) { (slot.querySelector('.book') || slot).click() }
  else if (t) { await window.dreamweave.openWorkspace(${JSON.stringify(WS_NAME)}) }
  await new Promise(r => setTimeout(r, 1800))
  const ov = Array.from(document.querySelectorAll('aside button')).find(x => (x.textContent||'').includes('概览'))
  if (ov) ov.click()
  return true
})()`)
await sleep(2000)

// ① Vue 组件的实际状态
console.log('\n① 读取 Vue 组件内部状态')
const state = await ev(`(() => {
  // 通过 Vue devtools 钩子拿组件实例树
  const root = document.querySelector('[data-testid="parse-presets"]')
  if (!root) return { ok: false, why: 'no panel' }
  let inst = root.__vueParentComponent
  // 向上找到 ParsePanel
  let depth = 0
  while (inst && depth < 12) {
    const n = inst.type?.__name || inst.type?.name || ''
    if (n.includes('ParsePanel')) break
    inst = inst.parent
    depth++
  }
  if (!inst) return { ok: false, why: 'ParsePanel instance not found' }
  const ctx = inst.ctx || inst.setupState || {}
  return {
    ok: true,
    name: inst.type?.__name || inst.type?.name,
    actionsDisabled: ctx.actionsDisabled,
    busy: ctx.busy,
    running: ctx.running,
    rowsLen: ctx.rows?.length ?? '(n/a)',
    pkgId: ctx.pkgId ?? props
  }
})()`)
console.log(`     ${JSON.stringify(state, null, 2)}`)

// ② 埋点：包一层 rerun，看是否被调用 / 是否抛错
console.log('\n② 埋点 rerun 与 start')
const hook = await ev(`(() => {
  const root = document.querySelector('[data-testid="parse-presets"]')
  let inst = root.__vueParentComponent
  let depth = 0
  while (inst && depth < 12) {
    const n = inst.type?.__name || inst.type?.name || ''
    if (n.includes('ParsePanel')) break
    inst = inst.parent
    depth++
  }
  if (!inst) return { ok: false }
  // Vue 3 setup 返回的函数在 setupState 上；用 callWithAsyncErrorHandling 包装太复杂，
  // 直接改 setupState 里的引用（模板 render 时读的是 ctx/setupState）
  const ss = inst.setupState
  window.__diag = { rerunCalled: 0, startCalled: 0, err: null }
  if (typeof ss.rerun === 'function') {
    const origRerun = ss.rerun
    ss.rerun = function (...args) {
      window.__diag.rerunCalled++
      window.__diag.rerunArgs = args
      try { return origRerun.apply(this, args) } catch (e) { window.__diag.err = String(e && e.stack || e); throw e }
    }
  }
  if (typeof ss.start === 'function') {
    const origStart = ss.start
    ss.start = function (...args) {
      window.__diag.startCalled++
      window.__diag.startArgs = args
      return Promise.resolve({ ok: false, error: '__DIAG__' })
    }
  }
  // 同时拦截 IPC
  const dw = window.dreamweave
  window.__diagIpc = []
  if (dw && !dw.__hooked) {
    dw.parseStart = (pkgId, range, force) => {
      window.__diagIpc.push({ pkgId, range, force })
      return Promise.resolve({ ok: false, runId: null, error: '__DIAG__' })
    }
    dw.__hooked = true
  }
  return { ok: true, hasRerun: typeof ss.rerun === 'function', hasStart: typeof ss.start === 'function' }
})()`)
console.log(`     ${JSON.stringify(hook)}`)

// ③ 点击
console.log('\n③ 点击重跑按钮')
const clicked = await ev(`(() => {
  const btn = document.querySelector('[data-testid="parse-rerun-mangaEffects"]')
  if (!btn) return { ok: false, why: 'no button' }
  const r = btn.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return { ok: false, why: 'button not visible (zero size)' }
  btn.click()
  return { ok: true, rect: { w: r.width, h: r.height } }
})()`)
console.log(`     ${JSON.stringify(clicked)}`)
await sleep(1200)

const diag = await ev('window.__diag')
const ipc = await ev('window.__diagIpc')
console.log(`\n④ 结果`)
console.log(`     rerun 被调用: ${diag?.rerunCalled}  参数: ${JSON.stringify(diag?.rerunArgs)}`)
console.log(`     start 被调用: ${diag?.startCalled}  参数: ${JSON.stringify(diag?.startArgs)}`)
console.log(`     IPC 调用: ${JSON.stringify(ipc)}`)
console.log(`     错误: ${diag?.err || '(无)'}`)

// ⑤ 直接手动调 rerun，看是否工作
console.log('\n⑤ 直接手动调用 rerun("mangaEffects")')
const manual = await ev(`(async () => {
  const root = document.querySelector('[data-testid="parse-presets"]')
  let inst = root.__vueParentComponent
  let depth = 0
  while (inst && depth < 12) {
    const n = inst.type?.__name || inst.type?.name || ''
    if (n.includes('ParsePanel')) break
    inst = inst.parent
    depth++
  }
  const ss = inst.setupState
  window.__diagIpc.length = 0
  try {
    await ss.rerun('mangaEffects')
    return { ok: true, ipc: window.__diagIpc }
  } catch (e) {
    return { ok: false, err: String(e && e.stack || e), ipc: window.__diagIpc }
  }
})()`)
console.log(`     ${JSON.stringify(manual, null, 2)}`)

ws.close()

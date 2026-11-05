/**
 * 判断 rerun 是否因 actionsDisabled（busy/running 卡住）而 return。
 * 不发真请求。
 *
 * 用法：CDP_ENDPOINT=http://127.0.0.1:9335 node scripts/diag-rerun-blocked.mjs 20261105164508-bad181
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
  if (r.exceptionDetails) return { __exc: JSON.stringify(r.exceptionDetails).slice(0, 700) }
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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

// Vue 3 生产构建也保留了 __vueParentComponent（在 DOM 元素上）
console.log('\n① 找 Vue 实例（多种路径）')
const probe = await ev(`(() => {
  const btn = document.querySelector('[data-testid="parse-rerun-mangaEffects"]')
  if (!btn) return { ok: false, why: 'no btn' }
  const keys = Object.keys(btn).filter(k => k.startsWith('__vue') || k.startsWith('__v'))
  let inst = btn.__vueParentComponent || btn._vnode?.component
  const out = { keys, hasInst: !!inst }
  if (inst) {
    // 向上找 ParsePanel
    let cur = inst, depth = 0
    const chain = []
    while (cur && depth < 15) {
      chain.push(cur.type?.__name || cur.type?.name || '(anon)')
      cur = cur.parent
      depth++
    }
    out.chain = chain
  }
  return out
})()`)
console.log(`     ${JSON.stringify(probe, null, 2)}`)

// 直接检查页面上的状态徽章（busy/running 会体现在 UI 上）
console.log('\n② UI 上的运行状态')
const uiState = await ev(`(() => {
  const phase = document.querySelector('.parse-progress .badge')
  const cancelBtn = document.querySelector('[data-testid="parse-cancel"]')
  const startBtn = document.querySelector('[data-testid="parse-start"]')
  return {
    phaseBadge: phase ? phase.textContent.trim() : null,
    hasCancelButton: !!cancelBtn,
    startDisabled: startBtn ? startBtn.disabled : null,
    rerunDisabled: document.querySelector('[data-testid="parse-rerun-mangaEffects"]')?.disabled ?? null
  }
})()`)
console.log(`     ${JSON.stringify(uiState, null, 2)}`)

// 检查是否有正在运行的 run（主进程状态）
console.log('\n③ 主进程是否有残留的 running run')
const lastRun = await ev(`(async () => {
  // 面板里若还记着上次 runId，会存在 DOM 或无法直接读；改为看 phase 文案
  const prog = document.querySelector('.parse-progress')
  return prog ? prog.textContent.replace(/\\s+/g, ' ').trim().slice(0, 200) : '(无进度区)'
})()`)
console.log(`     ${lastRun}`)

// 关键测试：拦截 parseStart 后直接调用，验证「按钮 → IPC」这条链路本身是否通
// （拦截后返回假失败，绝不触发真实解析，不花钱）
console.log('\n④ 拦截 IPC 后手动走一次 rerun 链路')
const direct = await ev(`(async () => {
  window.__ipc2 = []
  const dw = window.dreamweave
  dw.parseStart = (pkgId, range, force) => {
    window.__ipc2.push({ pkgId, range, force })
    return Promise.resolve({ ok: false, runId: null, error: '__DIAG__' })
  }
  // 直接点按钮
  document.querySelector('[data-testid="parse-rerun-mangaEffects"]').click()
  await new Promise(r => setTimeout(r, 1200))
  return { ipc: window.__ipc2 }
})()`)
console.log(`     ${JSON.stringify(direct, null, 2)}`)

ws.close()

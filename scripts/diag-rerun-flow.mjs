/**
 * 端到端：从书库打开书 → 进概览 → 点重跑按钮 → 拦截 IPC 看参数。
 * **不发真请求**（拦截 parseStart 并返回假失败）。
 *
 * 用法：CDP_ENDPOINT=http://127.0.0.1:9335 node scripts/diag-rerun-flow.mjs [工作库目录名]
 */
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'
const WS_NAME = process.argv[2] ?? null

const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
if (!page) {
  console.error('✗ 找不到页面')
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
  if (r.exceptionDetails) return `EXC: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await send('Page.bringToFront')
await sleep(500)

// ① 点侧栏「书库」
console.log('\n① 进入书库')
await ev(`(() => {
  const b = Array.from(document.querySelectorAll('aside button')).find(x => (x.textContent||'').includes('书库'))
  if (b) b.click()
  return true
})()`)
await sleep(1500)

const shelf = await ev(`document.querySelectorAll('[data-testid="lib-shelf"] .slot[data-book-id]').length`)
console.log(`     书架书籍数: ${shelf}`)

// ② 打开书
const books = await ev(`(async () => {
  const w = await window.dreamweave.listWorkspaces()
  return w.ok ? w.items.map(i => ({ id: i.id, title: i.title, ch: i.chapterCount })) : []
})()`)
const targetId = WS_NAME ?? books?.[0]?.id
const target = books?.find((b) => b.id === targetId)
console.log(`\n② 打开书: ${target?.title} (${target?.id})`)

const opened = await ev(`(async () => {
  const slot = document.querySelector('[data-testid="lib-shelf"] .slot[data-book-id="${targetId}"]')
  if (slot) {
    const book = slot.querySelector('.book') || slot
    book.click()
    await new Promise(r => setTimeout(r, 2000))
    return { ok: true, via: 'ui' }
  }
  const r = await window.dreamweave.openWorkspace(${JSON.stringify(targetId)})
  return { ok: r.ok, via: 'ipc', err: r.error }
})()`)
console.log(`     ${JSON.stringify(opened)}`)
await sleep(2500)

// ③ 侧栏应出现「概览」
const tabs = await ev(`Array.from(document.querySelectorAll('aside button')).map(b => (b.textContent||'').trim()).filter(Boolean)`)
console.log(`\n③ 侧栏: ${Array.isArray(tabs) ? tabs.join(' | ') : tabs}`)

const overviewTab = Array.isArray(tabs) ? tabs.find((t) => t.includes('概览')) : null
if (overviewTab) {
  await ev(`(() => {
    const b = Array.from(document.querySelectorAll('aside button')).find(x => (x.textContent||'').includes('概览'))
    if (b) b.click()
    return true
  })()`)
  await sleep(1800)
}

// ④ 解析面板
const panel = await ev(`(() => {
  const p = document.querySelector('[data-testid="parse-presets"]')
  const rows = Array.from(document.querySelectorAll('[data-testid^="parse-rerun-"]'))
  return {
    hasPresets: !!p,
    rerunCount: rows.length,
    samples: rows.slice(0, 5).map(b => ({ id: b.getAttribute('data-testid'), disabled: b.disabled === true }))
  }
})()`)
console.log(`\n④ 解析面板: ${JSON.stringify(panel)}`)

if (!panel?.hasPresets) {
  console.log('\n  ✗ 概览页没有解析面板，无法继续')
  ws.close()
  process.exit(1)
}

// ⑤ 拦截 parseStart 后点击重跑
console.log('\n⑤ 拦截 parseStart 并点击重跑')
await ev(`(() => {
  const dw = window.dreamweave
  const orig = dw.parseStart.bind(dw)
  window.__diagCalls = []
  dw.parseStart = (pkgId, range, force) => {
    window.__diagCalls.push({ pkgId, range, force })
    return Promise.resolve({ ok: false, runId: null, error: '__DIAG_BLOCKED__' })
  }
  dw.__diagOrig = orig
  return true
})()`)

const clicked = await ev(`(() => {
  const btn = document.querySelector('[data-testid="parse-rerun-mangaEffects"]')
  if (!btn) return { ok: false, why: '找不到 mangaEffects 重跑按钮', available: Array.from(document.querySelectorAll('[data-testid^="parse-rerun-"]')).map(b=>b.getAttribute('data-testid')).slice(0,8) }
  if (btn.disabled) return { ok: false, why: 'disabled' }
  btn.click()
  return { ok: true }
})()`)
console.log(`     点击: ${JSON.stringify(clicked)}`)
await sleep(1500)

const calls = await ev(`window.__diagCalls || []`)
console.log(`\n⑥ IPC 参数: ${JSON.stringify(calls, null, 2)}`)

if (Array.isArray(calls) && calls.length) {
  const c = calls[0]
  const hasScript = Array.isArray(c.range) && c.range.includes('mangaScript')
  console.log('\n  ── 判定 ──')
  console.log(`     range 项数: ${Array.isArray(c.range) ? c.range.length : c.range}`)
  console.log(`     ${hasScript ? '✅' : '❌'} 含 mangaScript（重跑修复生效）`)
  console.log(`     range: ${Array.isArray(c.range) ? c.range.join(', ') : c.range}`)
} else {
  console.log('\n  ❌ 点击后无 parseStart 调用')
  const errText = await ev(`(() => { const es = Array.from(document.querySelectorAll('.error')); return es.map(e=>e.textContent.trim()).join(' | ') })()`)
  console.log(`     页面 error: ${errText || '(空)'}`)
}

await ev(`(() => { if (window.dreamweave.__diagOrig) { window.dreamweave.parseStart = window.dreamweave.__diagOrig } return true })()`)
ws.close()

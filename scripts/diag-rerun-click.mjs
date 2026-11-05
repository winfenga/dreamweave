/**
 * 直接检查「重跑」按钮的实际行为（CDP 真机，只读，不发 LLM 请求）。
 *
 * 只做两件事：
 *   ① 找到重跑按钮，看它是否可点（disabled?）
 *   ② 拦截 parseStart 的 IPC 调用参数，看点了之后实际传了什么 range
 *
 * **不发真请求**：用 Runtime.evaluate 覆写 window.dreamweave.parseStart
 * 记录参数后立刻返回假的 ok，绝不触发真实解析、不花钱。
 *
 * 用法：CDP_ENDPOINT=http://127.0.0.1:9222 node scripts/diag-rerun-click.mjs
 */
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'

const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
if (!page) {
  console.error('✗ 找不到页面')
  process.exit(1)
}
console.log(`  URL: ${page.url}`)

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
let seq = 0
const pending = new Map()
const consoleLogs = []
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
    return
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    consoleLogs.push(
      `${msg.params.type}: ` + (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
    )
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

await send('Runtime.enable')
await send('Page.bringToFront')
await sleep(600)

console.log('\n① 侧栏状态 / 当前页面')
const tabs = await ev(`Array.from(document.querySelectorAll('aside button')).map(b => b.textContent.trim()).filter(Boolean)`)
console.log(`     侧栏: ${Array.isArray(tabs) ? tabs.join(' | ') : tabs}`)

console.log('\n② 找到解析面板与重跑按钮')
const panel = await ev(`(() => {
  const p = document.querySelector('[data-testid="parse-presets"]')
  if (!p) return { ok: false, why: '没有 parse-presets（不在概览页？）' }
  const rows = Array.from(document.querySelectorAll('[data-testid^="parse-rerun-"]'))
  return {
    ok: true,
    rerunCount: rows.length,
    samples: rows.slice(0, 6).map(b => ({
      testid: b.getAttribute('data-testid'),
      disabled: b.disabled === true,
      text: (b.textContent || '').trim()
    }))
  }
})()`)
console.log(`     ${JSON.stringify(panel, null, 2).slice(0, 800)}`)

if (!panel?.ok) {
  console.log('\n  ➜ 解析面板不在当前视图。先点侧栏「概览」并打开一本书再试。')
  ws.close()
  process.exit(0)
}

console.log('\n③ 埋点：拦截 parseStart，看点了按钮实际传什么')
const hooked = await ev(`(() => {
  const dw = window.dreamweave
  if (!dw) return { ok: false, why: 'window.dreamweave 不存在' }
  if (dw.__diagHooked) return { ok: true, already: true }
  const orig = dw.parseStart.bind(dw)
  window.__diagCalls = []
  dw.parseStart = function (pkgId, range, force) {
    window.__diagCalls.push({ pkgId, range, force, at: Date.now() })
    // 返回假成功，绝不触发真实解析（不花钱）
    return Promise.resolve({ ok: false, runId: null, error: '__DIAG_BLOCKED__' })
  }
  dw.__diagHooked = true
  dw.__diagOrig = orig
  return { ok: true }
})()`)
console.log(`     ${JSON.stringify(hooked)}`)

// 点一个「有上游」的任务的重跑按钮（mangaEffects 需要 mangaScript）
console.log('\n④ 点击 mangaEffects 的重跑按钮')
const clicked = await ev(`(() => {
  const btn = document.querySelector('[data-testid="parse-rerun-mangaEffects"]')
  if (!btn) return { ok: false, why: '找不到 parse-rerun-mangaEffects' }
  if (btn.disabled) return { ok: false, why: 'button disabled', cls: btn.className }
  btn.click()
  return { ok: true, text: (btn.textContent || '').trim() }
})()`)
console.log(`     ${JSON.stringify(clicked)}`)
await sleep(1500)

const calls = await ev(`window.__diagCalls || []`)
console.log(`\n⑤ 实际 IPC 调用参数：${JSON.stringify(calls, null, 2)}`)

if (Array.isArray(calls) && calls.length) {
  const c = calls[calls.length - 1]
  const rangeLen = Array.isArray(c.range) ? c.range.length : c.range
  console.log('\n  ── 判定 ──')
  console.log(`     pkgId = ${c.pkgId}`)
  console.log(`     range = ${Array.isArray(c.range) ? c.range.join(', ') : c.range}`)
  if (c.range === 'all') {
    console.log('     ✅ range=all（全量，不会有依赖问题）')
  } else if (Array.isArray(c.range)) {
    console.log(`     ${c.range.includes('mangaScript') ? '✅' : '❌'} range 是否包含 mangaScript（mangaEffects 的前置）：${c.range.includes('mangaScript')}`)
    console.log(`     共 ${rangeLen} 项`)
  }
} else {
  console.log('\n  ❌ 点击后没有任何 parseStart 调用 → 按钮的点击没触发启动逻辑')
  console.log('     可能原因：actionsDisabled 为 true / 事件未绑定 / Vue 未挂载该组件')
  const errText = await ev(`(() => { const e = document.querySelector('.error'); return e ? e.textContent.trim() : '' })()`)
  console.log(`     页面 error 文案: ${errText || '(空)'}`)
}

// 恢复
await ev(`(() => { if (window.dreamweave.__diagOrig) { window.dreamweave.parseStart = window.dreamweave.__diagOrig; delete window.dreamweave.__diagHooked } return true })()`)

if (consoleLogs.length) {
  console.log(`\n⑥ 控制台日志（${consoleLogs.length} 条，取最后 8 条）`)
  for (const l of consoleLogs.slice(-8)) console.log(`     ${l.slice(0, 200)}`)
}

ws.close()

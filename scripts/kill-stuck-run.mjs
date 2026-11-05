/**
 * 找到并取消当前卡住的解析 run。
 *
 * 用法：CDP_ENDPOINT=http://127.0.0.1:9335 node scripts/kill-stuck-run.mjs
 */
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'

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

console.log('① 当前进度区')
const before = await ev(`(() => {
  const p = document.querySelector('.parse-progress')
  return {
    text: p ? p.textContent.replace(/\\s+/g, ' ').trim() : '(无进度区)',
    cancelVisible: !!document.querySelector('[data-testid="parse-cancel"]'),
    anyDisabled: (() => {
      const bs = Array.from(document.querySelectorAll('[data-testid^="parse-rerun-"]'))
      return { total: bs.length, disabled: bs.filter(b => b.disabled).length }
    })()
  }
})()`)
console.log(`   ${JSON.stringify(before, null, 2)}`)

console.log('\n② 检查图片：是否有 seg 卡住（从任务状态看）')
const running = await ev(`(async () => {
  const ws = await window.dreamweave.listWorkspaces()
  // 逐个库查有没有 running 实例（只看前 20 本，避免太慢）
  const out = []
  for (const it of ws.items.slice(0, 20)) {
    const ov = await window.dreamweave.tasksOverview(it.id)
    const tasks = ov.overview?.tasks ?? []
    const run = tasks.filter(t => (t.counts?.running ?? 0) > 0)
    if (run.length) out.push({ id: it.id, title: it.title, running: run.map(t => t.id) })
  }
  return out
})()`)
console.log(`   ${JSON.stringify(running, null, 2)}`)

console.log('\n③ 点击取消按钮（如果存在）')
if (before?.cancelVisible) {
  const cancelled = await ev(`(async () => {
    const b = document.querySelector('[data-testid="parse-cancel"]')
    if (!b) return { ok: false, why: 'no cancel btn' }
    b.click()
    await new Promise(r => setTimeout(r, 1500))
    return {
      ok: true,
      after: (() => { const p = document.querySelector('.parse-progress'); return p ? p.textContent.replace(/\\s+/g,' ').trim() : null })(),
      cancelStillVisible: !!document.querySelector('[data-testid="parse-cancel"]')
    }
  })()`)
  console.log(`   ${JSON.stringify(cancelled, null, 2)}`)
} else {
  console.log('   无取消按钮（可能不在运行中）')
}

await sleep(1500)
console.log('\n④ 取消后状态')
const after = await ev(`(() => {
  const p = document.querySelector('.parse-progress')
  const bs = Array.from(document.querySelectorAll('[data-testid^="parse-rerun-"]'))
  return {
    text: p ? p.textContent.replace(/\\s+/g, ' ').trim() : '(无进度区)',
    rerunTotal: bs.length,
    rerunDisabled: bs.filter(b => b.disabled).length
  }
})()`)
console.log(`   ${JSON.stringify(after, null, 2)}`)

ws.close()

/**
 * 重跑 mangaScript（含依赖闭包），观察真实结果。
 *
 * 目的：拿到「模型返回了上万 token 但 parse 失败」的真凶证据。
 * 新代码会把响应总长度 + 开头 + 结尾写进错误消息。
 *
 * 用法：CDP_ENDPOINT=http://127.0.0.1:9336 node scripts/rerun-mangascript.mjs 20261105164508-bad181
 */
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'
const WS_NAME = process.argv[2] ?? '20261105164508-bad181'

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
  if (r.exceptionDetails) return { __exc: JSON.stringify(r.exceptionDetails).slice(0, 700) }
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await send('Page.bringToFront')
await sleep(400)

// 开书 + 概览
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

// 确认按钮可点
const ready = await ev(`(() => {
  const b = document.querySelector('[data-testid="parse-rerun-mangaScript"]')
  return { hasBtn: !!b, disabled: b?.disabled ?? null, forceUnlockVisible: !!document.querySelector('[data-testid="parse-force-unlock"]') }
})()`)
console.log(`  按钮状态: ${JSON.stringify(ready)}`)
if (ready?.disabled) {
  console.log('  ⚠️ 按钮被禁用，先强制解锁')
  await ev(`(async () => { const b = document.querySelector('[data-testid="parse-force-unlock"]'); if (b) b.click(); await new Promise(r=>setTimeout(r,1500)); return true })()`)
  await sleep(1500)
  const after = await ev(`(() => { const b = document.querySelector('[data-testid="parse-rerun-mangaScript"]'); return { disabled: b?.disabled ?? null } })()`)
  console.log(`  解锁后: ${JSON.stringify(after)}`)
}

// 用 parseStart 强制重跑（force=true），绕过「已 succeeded 且指纹一致」的幂等跳过。
//
// ⚠️ 关键：点「重跑」按钮走的是 force=false，编排器看到旧实例已 succeeded 且指纹一致
// 就直接跳过（幂等，G3），所以**产物根本不会更新** —— 这正是刚才看到
// 「mangaScript 3/3 succeeded 但 chapters 仍为空」的原因：不是新代码没生效，
// 而是根本没重跑，读到的还是旧产物。
console.log('\n  强制重跑 mangaScript + 依赖闭包（force=true）…')
const started = await ev(`(async () => {
  const ov = await window.dreamweave.tasksOverview(${JSON.stringify(WS_NAME)})
  const tasks = ov.overview?.tasks ?? []
  const byId = new Map(tasks.map(t => [t.id, t]))
  const depBase = (d) => { const i = d.indexOf(':'); return i < 0 ? d : d.slice(0, i) }
  const picked = new Set(['mangaScript'])
  let grew = true
  while (grew) {
    grew = false
    for (const id of [...picked]) {
      const t = byId.get(id)
      if (!t) continue
      for (const dep of t.dependsOn ?? []) {
        const b = depBase(dep)
        if (byId.has(b) && !picked.has(b)) { picked.add(b); grew = true }
      }
    }
  }
  const range = tasks.filter(t => picked.has(t.id)).map(t => t.id)
  const r = await window.dreamweave.parseStart(${JSON.stringify(WS_NAME)}, range, true)
  return { ok: r.ok, runId: r.runId, error: r.error, rangeCount: range.length, hasScript: range.includes('mangaScript') }
})()`)
console.log(`  ${JSON.stringify(started)}`)
if (!started?.ok) {
  console.log('  ✗ 启动失败')
  ws.close()
  process.exit(1)
}
const RUN_ID = started.runId

// 轮询进度
console.log('\n  等待完成（最多 25 分钟）…')
let last = ''
const deadline = Date.now() + 25 * 60 * 1000
let finalStatus = null
while (Date.now() < deadline) {
  await sleep(5000)
  const txt = await ev(`(() => { const p = document.querySelector('.parse-progress'); return p ? p.textContent.replace(/\\s+/g,' ').trim() : '' })()`)
  if (typeof txt === 'string' && txt !== last) {
    last = txt
    process.stdout.write(`\r  ${txt.slice(0, 110)}          `)
  }
  const st = await ev(`window.dreamweave.parseStatus(${JSON.stringify(RUN_ID)})`)
  if (st && !st.running) {
    finalStatus = st
    finalText = typeof txt === 'string' ? txt : ''
    break
  }
}
process.stdout.write('\n\n')

console.log(`  最终进度: ${finalText}`)

// 读取 mangaScript 本次运行的状态与错误（从 runId 的 tasks 里取，最准确）
console.log('\n  ── 本次运行各任务结果 ──')
if (finalStatus) {
  const byStatus = {}
  const failures = []
  for (const [k, v] of Object.entries(finalStatus.tasks ?? {})) {
    byStatus[v?.status ?? '?'] = (byStatus[v?.status ?? '?'] ?? 0) + 1
    if (v?.status === 'failed' || v?.status === 'blocked') failures.push({ key: k, status: v.status, error: v.error })
  }
  console.log(`  状态分布: ${JSON.stringify(byStatus)}`)
  console.log('\n  失败/拦截明细:')
  for (const f of failures) {
    console.log(`   · ${f.key.replace(/^.*?:txt-import-\d+:/, '')} [${f.status}]`)
    console.log(`     ${f.error}`)
    console.log('')
  }
  if (!failures.length) console.log('   (无)')
} else {
  console.log('  ⚠️ 未拿到最终状态（超时）')
}

// 查回落盘的产物内容（确认 chapters 是否真的有数据）
console.log('\n  ── 落盘产物检查 ──')
const artifact = await ev(`(async () => {
  const ov = await window.dreamweave.tasksOverview(${JSON.stringify(WS_NAME)})
  const t = (ov.overview?.tasks ?? []).find(x => x.id === 'mangaScript')
  return t ? { counts: t.counts, actual: t.actual, expected: t.expected } : null
})()`)
console.log(`  ${JSON.stringify(artifact)}`)

ws.close()

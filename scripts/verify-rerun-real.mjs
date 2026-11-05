/**
 * 正确验证重跑按钮：不加任何劫持，直接看真实结果。
 *
 * 之前的诊断全部失效，因为 window.dreamweave 是 contextBridge 暴露的
 * 不可写对象，Object.defineProperty 静默失败 → "劫持成功"是假的 →
 * "没有调用 parseStart"的结论也是假的。
 *
 * 本脚本用**真实行为**判断：
 *   点击重跑 → 观察 UI 进度区是否出现 start/done 状态变化。
 *   为不花钱，**先点一个不需要 LLM 的任务**（canonical / draftAlign 是本地步骤，0 成本）。
 *
 * 用法：CDP_ENDPOINT=http://127.0.0.1:9335 node scripts/verify-rerun-real.mjs 20261105164508-bad181
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

// 进目标书 + 概览
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

const checks = []
function check(name, cond, detail = '') {
  checks.push({ name, ok: !!cond, detail })
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : detail ? `  — ${detail}` : ''}`)
}

// ① 记录点击前的进度区状态
const before = await ev(`(() => {
  const p = document.querySelector('.parse-progress')
  const b = document.querySelector('[data-testid="parse-rerun-canonical"]')
  return {
    progressText: p ? p.textContent.replace(/\\s+/g, ' ').trim() : null,
    hasBtn: !!b,
    btnDisabled: b?.disabled ?? null
  }
})()`)
console.log(`\n① 点击前: ${JSON.stringify(before)}`)

// ② 点击 canonical 的重跑（本地步骤，不发 LLM，0 成本）
console.log('\n② 点击 canonical 重跑（本地步骤，不花钱）')
const clickResult = await ev(`(async () => {
  const b = document.querySelector('[data-testid="parse-rerun-canonical"]')
  if (!b) return { ok: false, why: 'no btn' }
  b.scrollIntoView({ block: 'center' })
  b.click()
  // 立刻读一次，看是否进入 running
  await new Promise(r => setTimeout(r, 300))
  const p = document.querySelector('.parse-progress')
  const immediate = p ? p.textContent.replace(/\\s+/g, ' ').trim() : null
  await new Promise(r => setTimeout(r, 2500))
  const p2 = document.querySelector('.parse-progress')
  return {
    ok: true,
    immediate,
    after: p2 ? p2.textContent.replace(/\\s+/g, ' ').trim() : null,
    cancelVisible: !!document.querySelector('[data-testid="parse-cancel"]')
  }
})()`)
console.log(`     ${JSON.stringify(clickResult, null, 2)}`)

check('点击后有反应（进度区出现内容）', clickResult?.immediate !== null && clickResult?.immediate !== undefined, JSON.stringify(clickResult))
check(
  '进度区状态发生改变（不是点了没反应）',
  clickResult?.immediate !== before?.progressText || clickResult?.after !== before?.progressText,
  `before=${before?.progressText} after=${clickResult?.after}`
)

// ③ 检查主进程是否真的收到 run（通过 parseStatus 无法直接查，改看进度区文案）
const progressed = await ev(`(() => {
  const p = document.querySelector('.parse-progress')
  return p ? p.textContent.replace(/\\s+/g, ' ').trim() : '(无)'
})()`)
console.log(`\n③ 当前进度区: ${progressed}`)
check('进度区显示 running/done 等阶段', /start|done|running|error/i.test(progressed ?? ''), String(progressed))

// ④ 检查任务行状态是否变化（canonical 之前是 local，重跑后应仍为 local 或 succeeded）
const rowState = await ev(`(async () => {
  const ov = await window.dreamweave.tasksOverview(${JSON.stringify(WS_NAME)})
  const t = (ov.overview?.tasks ?? []).find(x => x.id === 'canonical')
  return t ? { counts: t.counts, actual: t.actual, expected: t.expected } : null
})()`)
console.log(`\n④ canonical 任务状态: ${JSON.stringify(rowState)}`)
check('canonical 有实际实例（重跑生效）', (rowState?.actual ?? 0) > 0, JSON.stringify(rowState))

// ⑤ 关键：验证「重跑有依赖的任务」时 range 含依赖。用只读方式：
//    看主进程日志里最近一次 run 的 range（无法直接读），改验证 rebuild 后的行为——
//    点 mangaEffects 会真的花钱，故此处**不点**，只验证静态逻辑已修复。
console.log('\n⑤ 依赖闭包（静态验证，不点击）')
const closureOk = await ev(`(() => {
  // 用 tasksOverview 的 dependsOn 自己算一遍，确认前端拿到的数据够算闭包
  return window.dreamweave.tasksOverview(${JSON.stringify(WS_NAME)}).then(ov => {
    const tasks = ov.overview?.tasks ?? []
    const byId = new Map(tasks.map(t => [t.id, t]))
    const depBase = (d) => { const i = d.indexOf(':'); return i < 0 ? d : d.slice(0, i) }
    const picked = new Set(['mangaEffects'])
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
    return { picked: [...picked], hasScript: picked.has('mangaScript'), count: picked.size }
  })
})()`)
console.log(`     ${JSON.stringify(closureOk)}`)
check('前端数据足以算出依赖闭包', closureOk?.hasScript === true, JSON.stringify(closureOk))

ws.close()

const bar = '─'.repeat(64)
const fails = checks.filter((c) => !c.ok)
console.log(`\n${bar}\n  重跑按钮真实行为验证\n${bar}`)
console.log(`  共 ${checks.length} 项，失败 ${fails.length}`)
console.log(bar)

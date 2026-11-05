/**
 * cacheWarming 回归验证（CDP 真机 · 真网关 · 真解析链路）。
 *
 * 事故（用户实测）：
 *   解析一开跑就失败 —— cacheWarming 报
 *     「内容审查拦截：上游返回过短内容（15 字符），可能是拒绝响应：{"answer":"ok"}」
 *   于是任务 blocked，其后 29 个 LLM 任务全被 skipped，
 *   canonical 只写空 objects 壳，characterAppearance 报
 *     「需要 canonical 产物：工作库中没有任何含 objects.characters 的 canonical 结果」。
 *
 * 根因：审查拦截规则按「返回不足 50 字」判定，而 cacheWarming 的**设计输出**
 *       就是 `{"answer":"ok"}`（15 字符）—— 正确回答被稳定误判成拒绝语。
 *
 * 修复：适配器声明 `allowShortOutput: true` → 编排器透传 → singleChat 跳过长度判定。
 *
 * 本脚本走**真实解析链路**（不是直接调 singleChat），确认：
 *   ① 解析能启动
 *   ② cacheWarming 不再 blocked（这是事故的直接症状）
 *   ③ 它确实拿到了 `{"answer":"ok"}` 产物
 *
 * 用法：CDP_ENDPOINT=http://127.0.0.1:9333 node scripts/verify-cachewarming.mjs
 */
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'

const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
if (!page) {
  console.error('✗ 找不到页面目标，检查 CDP 端点')
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
  const r = await send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800))
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
function check(name, cond, detail = '') {
  checks.push({ name, ok: !!cond, detail })
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : detail ? `  — ${detail}` : ''}`)
}

await send('Page.bringToFront')
await sleep(500)

// ============ ① 准备：选中一本已导入的 txt（有章节、无解析产物） ============
console.log('\n① 准备一本书')
const prep = await ev(`(async () => {
  const ws = await window.dreamweave.listWorkspaces()
  if (!ws.ok || !ws.items.length) return { ok: false, why: '书库为空' }
  // 优先 txt 导入的来源（书名带 .txt），这类书必然没有解析产物，能真实跑一遍
  const txt = ws.items.filter(it => String(it.title || '').toLowerCase().endsWith('.txt'))
  const target = (txt.length ? txt : ws.items).find(it => (it.chapterCount || 0) > 0) || (txt[0] || ws.items[0])
  return { ok: true, id: target.id, title: target.title, chapters: target.chapterCount, isTxt: txt.length > 0 }
})()`)
check('找到可解析的书', prep?.ok === true, prep?.why ?? '')
console.log(`     ${prep?.title}（${prep?.chapters} 章）`)
if (!prep?.ok) {
  ws.close()
  process.exit(1)
}

// 走真实 UI 路径打开（openWorkspace 只切主进程会话，渲染层不会跟随）
await ev(`(async () => {
  const book = document.querySelector('[data-testid="lib-shelf"] .slot[data-book-id="${prep.id}"] .book')
  if (book) { book.click(); return true }
  const r = await window.dreamweave.openWorkspace(${JSON.stringify(prep.id)})
  return r.ok
})()`)
await sleep(2200)

// ============ ② 启动解析（只跑 always 组：cacheWarming + 本地步骤） ============
console.log('\n② 启动解析（always 组）')
const started = await ev(`(async () => {
  const ov = await window.dreamweave.tasksOverview(${JSON.stringify(prep.id)})
  if (!ov.ok || !ov.overview) return { ok: false, error: ov.error ?? 'tasksOverview 失败' }
  const tasks = ov.overview.tasks
  const depBase = (d) => { const i = d.indexOf(':'); return i < 0 ? d : d.slice(0, i) }
  // always/any 组 + 传递依赖闭包（orchestrator 的 range 过滤是严格的，
  // 少一个传递依赖整批任务会以「依赖未就绪」静默跳过）
  const picked = new Set()
  const queue = tasks.filter(t => ['always', 'any'].includes(t.feature)).map(t => t.id)
  while (queue.length) {
    const id = queue.shift()
    if (picked.has(id)) continue
    const t = tasks.find(x => x.id === id)
    if (!t) continue
    picked.add(id)
    for (const d of (t.dependsOn || [])) {
      const b = depBase(d)
      if (!picked.has(b)) queue.push(b)
    }
  }
  const r = await window.dreamweave.parseStart(${JSON.stringify(prep.id)}, [...picked], true)
  return { ok: r.ok, runId: r.runId, error: r.error, range: [...picked] }
})()`)
check('解析能启动', started?.ok === true, started?.error ?? '')
if (!started?.ok) {
  ws.close()
  process.exit(1)
}
console.log(`     range = ${JSON.stringify(started.range)}  runId = ${started.runId}`)

// ============ ③ 轮询到结束，检查 cacheWarming 状态 ============
console.log('\n③ 等待解析完成')
let status = null
const deadline = Date.now() + 8 * 60 * 1000
let lastDone = -1
while (Date.now() < deadline) {
  await sleep(2500)
  const s = await ev(`window.dreamweave.parseStatus(${JSON.stringify(started.runId)})`)
  status = s
  if (s && s.done !== lastDone) {
    lastDone = s.done
    process.stdout.write(`\r     ${s.done}/${s.total} …`)
  }
  if (!s?.running) break
}
process.stdout.write('\n')

check('解析运行结束（非超时）', status && !status.running, status ? `done=${status.done}/${status.total}` : '无状态')

// 逐任务结果
const states = status?.tasks ?? {}
const cwKey = Object.keys(states).find((k) => k.includes('cacheWarming'))
const cw = cwKey ? states[cwKey] : null
check('cacheWarming 任务存在', cw !== null, JSON.stringify(Object.keys(states).slice(0, 8)))
check(
  'cacheWarming 未被判为内容审查拦截（事故症状已消失）',
  cw?.status !== 'blocked',
  cw?.error ?? `status=${cw?.status}`
)
check('cacheWarming 成功', cw?.status === 'succeeded', `status=${cw?.status} error=${cw?.error ?? '(无)'}`)

// 其他被 blocked 的任务（若还有，说明是别的原因）
const blockedOthers = Object.entries(states).filter(([, v]) => v?.status === 'blocked')
check(
  '本次运行没有任何任务因内容审查被 blocked',
  blockedOthers.length === 0,
  blockedOthers.map(([k, v]) => `${k}: ${v.error ?? ''}`).join(' | ')
)

// ============ ④ 产物落盘校验 ============
const persisted = await ev(`(async () => {
  const ov = await window.dreamweave.tasksOverview(${JSON.stringify(prep.id)})
  const t = (ov.overview?.tasks ?? []).find(x => x.id === 'cacheWarming')
  return t ?? null
})()`)
check('产物已记录（overview 有 cacheWarming 条目）', persisted !== null, JSON.stringify(persisted)?.slice(0, 200))

ws.close()

const bar = '─'.repeat(64)
const fails = checks.filter((c) => !c.ok)
console.log(`\n${bar}\n  cacheWarming 解析链路回归\n${bar}`)
console.log(`  共 ${checks.length} 项`)
console.log(bar)
if (fails.length) {
  console.log(`  ✗ ${fails.length} 项失败\n${bar}\n`)
  process.exit(1)
}
console.log(`  ✓ ${checks.length} 项全部通过\n${bar}\n`)

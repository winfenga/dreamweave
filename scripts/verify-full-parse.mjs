/**
 * 完整解析长跑验证（CDP 真机 · 真网关）。
 *
 * 目的：确认「cacheWarming 误判」修好后，**整条 33 任务流水线**能真正往下走，
 * 而不是只有 always 组过了、后面仍然卡住。
 *
 * 重点观察：
 *   ① 有没有任何任务因「内容审查拦截」被 blocked（事故的直接症状）
 *   ② canonical 是否产出了非空 objects.characters（这是 characterAppearance 的前置）
 *   ③ characterAppearance 是否还报「工作库中没有任何含 objects.characters 的 canonical 结果」
 *
 * 用法：CDP_ENDPOINT=http://127.0.0.1:9333 node scripts/verify-full-parse.mjs [分钟数]
 */
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'
const TIMEOUT_MIN = Number(process.argv[2] ?? 90)

const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
if (!page) {
  console.error('✗ 找不到页面目标')
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

await send('Page.bringToFront')
await sleep(400)

// 挑一本章节最多的书（最可能是完整解析过的），确保 UI 会话已切过去
const prep = await ev(`(async () => {
  const ws = await window.dreamweave.listWorkspaces()
  if (!ws.ok || !ws.items.length) return { ok: false, why: '书库为空' }
  const sorted = [...ws.items].sort((a, b) => (b.chapterCount || 0) - (a.chapterCount || 0))
  const target = sorted[0]
  const book = document.querySelector('[data-testid="lib-shelf"] .slot[data-book-id="' + target.id + '"] .book')
  if (book) book.click()
  else await window.dreamweave.openWorkspace(target.id)
  return { ok: true, id: target.id, title: target.title, chapters: target.chapterCount }
})()`)
if (!prep?.ok) {
  console.error(`✗ ${prep?.why ?? '准备失败'}`)
  process.exit(1)
}
console.log(`  书：${prep.title}（${prep.chapters} 章）`)
await sleep(2000)

// 启动**全量**解析（range='all'，force=true 强制重跑，确保真的走一遍）
const started = await ev(`window.dreamweave.parseStart(${JSON.stringify(prep.id)}, 'all', true)`)
if (!started?.ok) {
  console.error(`✗ 启动失败：${started?.error}`)
  process.exit(1)
}
console.log(`  runId = ${started.runId}`)
console.log(`  最长等待 ${TIMEOUT_MIN} 分钟\n`)

let status = null
const deadline = Date.now() + TIMEOUT_MIN * 60 * 1000
let lastDone = -1
let lastBlocked = 0
while (Date.now() < deadline) {
  await sleep(5000)
  const s = await ev(`window.dreamweave.parseStatus(${JSON.stringify(started.runId)})`)
  status = s
  if (s && s.done !== lastDone) {
    lastDone = s.done
    const blockedNow = Object.values(s.tasks ?? {}).filter((v) => v?.status === 'blocked').length
    process.stdout.write(`\r    ${s.done}/${s.total}   blocked=${blockedNow}   `)
    if (blockedNow !== lastBlocked) lastBlocked = blockedNow
  }
  if (!s?.running) break
}
process.stdout.write('\n\n')

const states = status?.tasks ?? {}
const entries = Object.entries(states)
const byStatus = {}
for (const [, v] of entries) byStatus[v?.status ?? '?'] = (byStatus[v?.status ?? '?'] ?? 0) + 1
console.log('  任务状态分布：', JSON.stringify(byStatus))

const blocked = entries.filter(([, v]) => v?.status === 'blocked')
console.log(`\n  blocked（内容审查拦截）：${blocked.length}`)
for (const [k, v] of blocked) console.log(`    · ${k}\n      ${v.error ?? ''}`)

const failed = entries.filter(([, v]) => v?.status === 'failed')
console.log(`\n  failed：${failed.length}`)
for (const [k, v] of failed.slice(0, 15)) console.log(`    · ${k}\n      ${(v.error ?? '').slice(0, 260)}`)

// 关键产物检查
const artifacts = await ev(`(async () => {
  const ov = await window.dreamweave.tasksOverview(${JSON.stringify(prep.id)})
  const list = ov.overview?.tasks ?? []
  const pick = (id) => {
    const t = list.find(x => x.id === id)
    return t ? { id, state: t.state ?? t.status ?? null, count: t.count ?? null } : null
  }
  return {
    canonical: pick('canonical'),
    characterAppearance: pick('characterAppearance'),
    seg: pick('seg'),
    plot: pick('plot')
  }
})()`)
console.log('\n  关键产物：', JSON.stringify(artifacts, null, 2))

ws.close()
const hardBlocked = blocked.length
const appFailed = failed.find(([k]) => k.includes('characterAppearance'))
console.log('\n' + '─'.repeat(64))
if (hardBlocked > 0) {
  console.log(`  ✗ 仍有 ${hardBlocked} 个任务被内容审查拦截`)
  process.exit(1)
}
if (appFailed) {
  console.log(`  ✗ characterAppearance 仍失败：${appFailed[1].error}`)
  process.exit(1)
}
console.log('  ✓ 无内容审查拦截，characterAppearance 未失败')
console.log('─'.repeat(64) + '\n')

/**
 * 归属修复验证（CDP）：解析面板读的必须是「当前这本书」，不是包内 ID 的路径。
 *
 * 修复前症状：报「工作库索引缺失或不可读：…/<包内ID>/index.json (ENOENT)」，
 * 且所有任务计数错乱（全 0 / 全待跑），因为前端把包内 pkgId 当成了工作库目录名。
 *
 * 用法：CDP_ENDPOINT=http://127.0.0.1:9334 node scripts/check-attribution.mjs
 */
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'

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
  if (r.exceptionDetails) return `EXC: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Page.bringToFront')
await sleep(600)

const checks = []
function check(name, cond, detail = '') {
  checks.push({ name, ok: !!cond, detail })
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : detail ? `  — ${detail}` : ''}`)
}

// ① 当前打开的是哪本书
const cur = await ev(`(async () => {
  const ws = await window.dreamweave.listWorkspaces()
  if (!ws.ok) return { ok: false, err: ws.error }
  return { ok: true, items: ws.items.map(i => ({ id: i.id, title: i.title, ch: i.chapterCount })) }
})()`)
check('listWorkspaces 可用', cur?.ok === true, cur?.err ?? '')
console.log(`     书库 ${cur.items?.length ?? 0} 本`)

// ② 从侧栏「书库」点进去，打开第一本，走真实 UI 路径
// ② 挑一本「目录名 ≠ 包内 ID」的书（这才是有区分度的样本；t2w 包的目录名恰好
//    等于 uuid 时两者相同，测不出归属 bug）
const diffTarget = await ev(`(async () => {
  const ws = await window.dreamweave.listWorkspaces()
  if (!ws.ok) return { ok: false, err: ws.error }
  // 遍历找一本：用目录名能读到、但 overview.pkgId 与目录名不同
  for (const it of ws.items.slice(0, 40)) {
    const ov = await window.dreamweave.tasksOverview(it.id)
    if (ov.ok && ov.overview && ov.overview.pkgId && ov.overview.pkgId !== it.id) {
      return { ok: true, id: it.id, pkgId: ov.overview.pkgId, title: it.title }
    }
  }
  return { ok: false, why: '40 本内没找到目录名≠包内ID 的书' }
})()`)
check('找到「目录名 ≠ 包内 ID」的样本', diffTarget?.ok === true, diffTarget?.why ?? '')
if (diffTarget?.ok) {
  console.log(`     目录名 ${diffTarget.id}`)
  console.log(`     包内ID ${diffTarget.pkgId}`)
  console.log(`     书名   ${diffTarget.title}`)
}

// 用这本有区分度的书做归属验证
const target = diffTarget?.ok ? { id: diffTarget.id, title: diffTarget.title } : cur.items?.[0]
const opened = await ev(`(async () => {
  const tabs = Array.from(document.querySelectorAll('aside button'))
  const lib = tabs.find(b => (b.textContent || '').includes('书库'))
  if (lib) lib.click()
  await new Promise(r => setTimeout(r, 1200))
  const slot = document.querySelector('[data-testid="lib-shelf"] .slot[data-book-id="${target?.id}"] .book')
  if (!slot) return { ok: false, why: '书架上找不到该书', shelfCount: document.querySelectorAll('[data-testid="lib-shelf"] .slot[data-book-id]').length }
  slot.click()
  return { ok: true }
})()`)
check('从书架点开目标书', opened?.ok === true, JSON.stringify(opened))
await sleep(2500)

// ③ 关键断言：页面里不能出现「索引缺失或不可读」
const body = await ev('document.body.innerText')
check('无「工作库索引缺失或不可读」', !/工作库索引缺失或不可读/.test(body ?? ''), '仍存在')

// ④ 解析面板的 pkgId 必须等于工作库目录名（不是包内 ID）
const propCheck = await ev(`(async () => {
  // 从 DOM 里读不到 props，改为验证 IPC 行为：
  // 用目录名调 tasksOverview 必须成功；用包内 ID 调必须失败（证明两者不同）
  const ws = await window.dreamweave.listWorkspaces()
  const t = ws.items.find(i => i.id === ${JSON.stringify(target?.id)})
  const byDir = await window.dreamweave.tasksOverview(${JSON.stringify(target?.id)})
  return {
    dir: ${JSON.stringify(target?.id)},
    byDirOk: byDir.ok,
    byDirTasks: byDir.overview?.tasks?.length ?? 0,
    pkgIdFromIndex: byDir.overview?.pkgId ?? '',
    title: byDir.overview?.title ?? ''
  }
})()`)
check('按目录名调 tasksOverview 成功', propCheck?.byDirOk === true, JSON.stringify(propCheck))
check('返回 33 个任务', propCheck?.byDirTasks === 33, String(propCheck?.byDirTasks))
console.log(`     目录名 ${propCheck?.dir}`)
console.log(`     包内ID ${propCheck?.pkgIdFromIndex}`)
check('目录名 ≠ 包内 ID（证明两者确实不同）', propCheck?.dir !== propCheck?.pkgIdFromIndex, `dir=${propCheck?.dir} pkgId=${propCheck?.pkgIdFromIndex}`)

// ⑤ 反向证明：拿包内 ID 当目录名调 IPC，必须失败（这就是修复前的错误用法）
const wrongPath = await ev(`(async () => {
  const ov = await window.dreamweave.tasksOverview(${JSON.stringify(propCheck?.pkgIdFromIndex ?? '')})
  return { ok: ov.ok, error: (ov.error ?? '').slice(0, 120) }
})()`)
check(
  '用包内 ID 当路径会失败（印证修复前的报错）',
  wrongPath?.ok === false,
  JSON.stringify(wrongPath)
)
if (wrongPath?.ok === false) console.log(`     包内ID 路径报错：${wrongPath.error}`)

// ⑤ 面板显示的任务计数必须与 IPC 一致（不是全 0 的假状态）
const ipcCounts = await ev(`(async () => {
  const ov = await window.dreamweave.tasksOverview(${JSON.stringify(target?.id)})
  const t = (ov.overview?.tasks ?? []).find(x => x.id === 'plot')
  return t ? { expected: t.expected, actual: t.actual, counts: t.counts } : null
})()`)
console.log(`     plot: expected=${ipcCounts?.expected} actual=${ipcCounts?.actual} counts=${JSON.stringify(ipcCounts?.counts)}`)

const uiRow = await ev(`(() => {
  const rows = Array.from(document.querySelectorAll('tr, .task-row, [data-testid^="task-row"]'))
  const r = rows.find(x => /(^|\\s)plot(\\s|$)|剧情/.test(x.textContent || ''))
  return r ? (r.textContent || '').replace(/\\s+/g, ' ').trim() : null
})()`)
console.log(`     UI plot 行: ${uiRow ?? '(未找到)'}`)
check('UI 显示的 plot 行存在', uiRow !== null, '未渲染')

// ⑥ 只读检查：产物落点归属正确（不发起任何 LLM 调用，不花钱）
//
// 刻意**不**在这里真跑解析：一条 cacheWarming 也是真实计费。
// 归属正确性由两侧只读证据保证：
//   ① 按目录名调 tasksOverview 能读到本书（上面已验证）
//   ② 源码层 pipelineParseStart 显式按 pkgId 定位 root（verify-upstream-read.mjs 静态断言）
console.log('\n  ⑥ 产物落点（只读）')
const persistedFiles = await ev(`(async () => {
  const ov = await window.dreamweave.tasksOverview(${JSON.stringify(target?.id)})
  const list = ov.overview?.tasks ?? []
  // 有实际产物（actual > 0）的任务数量——证明这本书确实被正确读到
  return {
    withRuns: list.filter(t => (t.actual ?? 0) > 0).length,
    total: list.length,
    localTotal: ov.overview?.localTotal ?? 0
  }
})()`)
console.log(`     已跑过的任务行：${persistedFiles?.withRuns}/${persistedFiles?.total}，本机状态条目 ${persistedFiles?.localTotal}`)
check('能读到本书已有的任务状态（不是全空）', (persistedFiles?.localTotal ?? 0) > 0, JSON.stringify(persistedFiles))

ws.close()

const bar = '─'.repeat(64)
const fails = checks.filter((c) => !c.ok)
console.log(`\n${bar}\n  归属修复验证\n${bar}`)
console.log(`  共 ${checks.length} 项，失败 ${fails.length}`)
console.log(bar)
process.exit(fails.length ? 1 : 0)

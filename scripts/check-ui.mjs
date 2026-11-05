/**
 * 界面自检（CDP）：确认应用正常起来、书架渲染、无控制台错误。
 * 用法：CDP_ENDPOINT=http://127.0.0.1:9334 node scripts/check-ui.mjs
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
const consoleErrors = []
const pageErrors = []
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
    return
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '))
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push(msg.params.exceptionDetails?.exception?.description ?? JSON.stringify(msg.params.exceptionDetails).slice(0, 300))
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
  if (r.exceptionDetails) return `EXC: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Runtime.enable')
await send('Page.enable')
await send('Page.bringToFront')
await sleep(800)

const checks = []
function check(name, cond, detail = '') {
  checks.push({ name, ok: !!cond, detail })
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : detail ? `  — ${detail}` : ''}`)
}

check('文档标题', (await ev('document.title')) !== '', String(await ev('document.title')))
check('启动动画已结束', await ev('!document.getElementById("splash")'), 'splash 仍在')
const shelfCount = await ev('document.querySelectorAll(\'[data-testid="lib-shelf"] .slot[data-book-id]\').length')
check('书架已渲染', typeof shelfCount === 'number' && shelfCount > 0, String(shelfCount))
console.log(`     书架书籍数：${shelfCount}`)

const tabs = await ev(`Array.from(document.querySelectorAll('aside button, .side-tab, nav button')).map(e => e.textContent.trim()).filter(Boolean).slice(0, 14)`)
console.log(`     侧栏：${Array.isArray(tabs) ? tabs.join(' | ') : tabs}`)

// 打开第一本书，看概览页是否正常（这一步验证 workspaceDir 修复）
const opened = await ev(`(async () => {
  const slots = document.querySelectorAll('[data-testid="lib-shelf"] .slot[data-book-id]')
  if (!slots.length) return { ok: false, why: '无书籍' }
  const first = slots[0]
  const id = first.getAttribute('data-book-id')
  const book = first.querySelector('.book')
  if (book) book.click()
  else return { ok: false, why: '找不到 .book' }
  return { ok: true, id }
})()`)
check('能点击打开书', opened?.ok === true, opened?.why ?? '')
await sleep(2500)

const overviewOk = await ev(`!!document.querySelector('[data-testid="parse-presets"]')`)
check('概览页出现解析面板', overviewOk === true, '未找到 parse-presets')

// 关键：验证没有出现「工作库索引缺失或不可读」这类路径错误
const bodyText = await ev('document.body.innerText')
const badPath = /工作库索引缺失或不可读/.test(bodyText ?? '')
check('无「工作库索引缺失或不可读」错误', !badPath, '仍存在路径错误')
if (badPath) {
  const m = (bodyText ?? '').match(/工作库索引缺失或不可读[^\n]{0,200}/)
  console.log(`     ${m?.[0]}`)
}

// 解析面板的任务计数（验证 pkgId 归属修复：应当读到真实状态，而不是全 0）
const taskRows = await ev(`(() => {
  const rows = Array.from(document.querySelectorAll('[data-testid^="task-row-"], .task-row, tr')).filter(r => /canonical|characterAppearance|worldImpression/.test(r.textContent || ''))
  return rows.slice(0, 3).map(r => (r.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120))
})()`)
console.log(`     任务行样本：${JSON.stringify(taskRows).slice(0, 300)}`)

check('无 JS 运行期异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))
check('无 console.error', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))

ws.close()

const bar = '─'.repeat(64)
const fails = checks.filter((c) => !c.ok)
console.log(`\n${bar}\n  界面自检\n${bar}`)
console.log(`  共 ${checks.length} 项，失败 ${fails.length}`)
console.log(bar)
process.exit(fails.length ? 1 : 0)

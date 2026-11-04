/**
 * 打包版冒烟：确认运行期静态资源在**打包后**仍可读。
 *
 * 这是打包最容易出问题的地方 —— 主进程的 resourcesDir() 找的是
 * `app.getAppPath()/resources`，而打包后 appPath 指向 asar。
 * 少了 task-registry / effect-catalog / prompts，对应功能会在真机上直接报
 * 「目录不可用」，但开发版一切正常，很容易漏检。
 *
 * 用法：CDP_ENDPOINT=http://127.0.0.1:9444 node scripts/smoke-packaged.mjs
 */
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9444'

const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
if (!page) {
  console.error('✗ 没有可调试的页面')
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
let mid = 0
const pending = new Map()
const send = (m, pr = {}) =>
  new Promise((res, rej) => {
    const i = ++mid
    pending.set(i, { res, rej })
    ws.send(JSON.stringify({ id: i, method: m, params: pr }))
  })
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
  }
})
await new Promise((r) => ws.addEventListener('open', r))
await send('Runtime.enable')
const ev = async (x) => {
  const r = await send('Runtime.evaluate', {
    expression: x,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500))
  return r.result.value
}

const failures = []
const checks = []
function check(name, cond, detail = '') {
  checks.push({ name, ok: !!cond, detail })
  if (!cond) failures.push(`${name}${detail ? `（${detail}）` : ''}`)
}

// ① 特效目录：74 条，来自 resources/effects/effect-catalog.json
const fx = await ev(`(async () => {
  const r = await window.dreamweave.getEffectCatalog()
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, count: r.entries?.length ?? 0, first: r.entries?.[0]?.id ?? '' }
})()`)
check('特效目录可读（resources/effects）', fx?.ok === true, fx?.error ?? '')
check('特效条目 74 条', fx?.count === 74, `${fx?.count}`)

// ② 任务注册表：33 条，来自 resources/pipeline/task-registry.json
//    ⚠️ 这个接口需要先打开一本书（它要读工作库状态），所以先打开书库里的第一本。
const opened = await ev(`(async () => {
  const ws = await window.dreamweave.listWorkspaces()
  if (!ws.ok || !ws.items.length) return { ok: false, error: '书库为空，无法验证任务注册表' }
  // 优先选含 storyScript 的小说包（任务面板对漫画包也会列，但小说包更典型）
  const target = ws.items[0]
  const r = await window.dreamweave.openWorkspace(target.id)
  return { ok: r.ok, error: r.error, title: target.title }
})()`)

const tasks = await ev(`(async () => {
  const r = await window.dreamweave.tasksOverview()
  if (!r || !r.ok) return { ok: false, error: r?.error ?? 'no result' }
  // 形状：{ ok, overview: { tasks: [...], localTotal, inheritedTotal, ... } }
  // 注意字段是 tasks（不是 items）—— 早期这里写错导致误判「注册表为空」
  const list = r.overview?.tasks ?? []
  return { ok: true, count: list.length, localTotal: r.overview?.localTotal ?? 0 }
})()`)
check('能打开书库里的一本书', opened?.ok === true, opened?.error ?? '')
check('任务注册表可读（resources/pipeline）', tasks?.ok === true, tasks?.error ?? '')
check('任务条目 33 条', tasks?.count === 33, `${tasks?.count}`)

// ③ 打包标记：确认跑的是打包版而不是开发版
const env = await ev(`(async () => {
  // 打包后 location 是 file:// 且路径含 app.asar；开发版是 http://localhost
  return { href: location.href.slice(0, 80), isFile: location.protocol === 'file:' }
})()`)
check('运行的是打包版（file:// + asar）', env?.isFile === true, env?.href ?? '')

// 报告
const bar = '─'.repeat(60)
console.log(`\n${bar}\n  打包版冒烟\n${bar}`)
for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : '  ← ' + c.detail}`)
console.log(bar)
if (failures.length) {
  console.log(`  ✗ ${failures.length} 项失败 / 共 ${checks.length} 项\n`)
  ws.close()
  process.exit(1)
}
console.log(`  ✓ ${checks.length} 项全部通过\n`)
ws.close()

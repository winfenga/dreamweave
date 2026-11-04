/**
 * 通过 CDP 让运行中的应用导入指定 .t2w（供后续 UI 验证使用）。
 * 用法：node scripts/cdp-import.mjs "D:/galcomic/gmzz-10.t2w"
 */
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'
const target = process.argv[2] ?? 'D:/galcomic/gmzz-10.t2w'

const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
if (!page) {
  console.error('✗ 没有可调试页面')
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const send = (m, pr = {}) =>
  new Promise((res, rej) => {
    const i = ++id
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
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800))
  return r.result.value
}

const pathLiteral = JSON.stringify(target)
const res = await ev(`(async () => {
  const r = await window.feather.importPackage(${pathLiteral}, 't2w')
  return { ok: r.ok, canceled: r.canceled, error: r.error, title: r.summary?.project?.title, chapters: r.summary?.chapters?.length }
})()`)
console.log('导入结果：', JSON.stringify(res, null, 2))
ws.close()

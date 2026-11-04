/** CDP 调试辅助：打印当前侧栏项与 content 区结构。 */
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'
const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
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
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 900))
  return r.result.value
}

console.log('侧栏项：', JSON.stringify(await ev(`[...document.querySelectorAll('.side-item')].map(b => b.textContent.trim())`), null, 1))
console.log('content 区 child classes：', JSON.stringify(await ev(`[...document.querySelector('.content')?.children ?? []].map(e => e.className)`), null, 1))
console.log('content-flush?', await ev(`document.querySelector('.content')?.className`))
console.log('manga-root?', await ev(`!!document.querySelector('.manga-root')`))
console.log('manga-empty?', await ev(`document.querySelector('.manga-empty-desc')?.textContent`))
console.log('stage-empty?', await ev(`document.querySelector('.se-title')?.textContent`))
ws.close()

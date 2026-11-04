/** 调试：检查 actors 通道在当前句能否解析出立绘。 */
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

console.log('当前句角色:', await ev(`(() => {
  const st = document.querySelector('#app')?.__vue_app__?._instance?.setupState
  return 'no-setupState'
})()`))

console.log('舞台立绘 img 存在?', await ev(`!!document.querySelector('.stage-portrait img') || !!document.querySelector('.portrait img')`))
console.log('所有 img src 前缀:', await ev(`[...document.querySelectorAll('.stage-wrap img')].map(i=>({cls:i.className, src:(i.src||'').slice(0,60)}))`))
console.log('角色数:', await ev(`(async()=>{ const r = await window.dreamweave.getView(); return r.ok? {chars:r.data.characters.length, withImg:r.data.characters.filter(c=>c.imageUrl).length, sample:r.data.characters.slice(0,3).map(c=>({id:c.id,name:c.name,img:!!c.imageUrl}))}:r.error })()`))
ws.close()

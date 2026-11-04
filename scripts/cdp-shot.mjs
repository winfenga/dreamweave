/** 滚到指定选择器并截图（调试用）。用法：node scripts/cdp-shot.mjs "[data-testid=x]" out.png */
import { writeFileSync } from 'node:fs'
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'
const sel = process.argv[2] ?? 'body'
const out = process.argv[3] ?? 'D:/galcomic/recon/shot.png'

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
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600))
  return r.result.value
}
await send('Page.bringToFront')
const found = await ev(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)})
  if (!el) return false
  el.scrollIntoView({ block: 'center' })
  return true
})()`)
if (!found) {
  console.error(`✗ 找不到选择器：${sel}`)
  process.exit(1)
}
await new Promise((r) => setTimeout(r, 700))
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(out, Buffer.from(shot.data, 'base64'))
console.log(`saved ${out}`)
ws.close()

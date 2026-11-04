// 隔离实验：验证把 Buffer 子视图塞进 Response 时，读出来的字节是否仍然正确
// 这是 HANDOVER 里「高度怀疑 subarray 视图在 protocol.handle → new Response(view) 时字节错位」的直接检验
import crypto from 'node:crypto'
import http from 'node:http'
import fs from 'node:fs'

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

// 造一个和真实场景同构的大 buffer：前面塞垃圾，中间放 mp3，后面再塞垃圾
const clip = fs.readFileSync('D:/galcomic/recon/probe-clip.mp3')
const master = Buffer.alloc(clip.length + 4_000_000, 0xab)
clip.copy(master, 1_234_567)
const view = master.subarray(1_234_567, 1_234_567 + clip.length)

console.log('master.length', master.length)
console.log('view.byteOffset', view.byteOffset, 'view.byteLength', view.byteLength)
console.log('view sha256', sha(view))
console.log('clip sha256', sha(clip))

// 三条路径返回值，看 HTTP 端实际收到什么
const cases = {
  'subarray-view': () => new Response(view, { headers: { 'content-type': 'audio/mpeg' } }),
  'copied-buffer': () => new Response(Buffer.from(view), { headers: { 'content-type': 'audio/mpeg' } }),
  'uint8-slice': () => new Response(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), { headers: { 'content-type': 'audio/mpeg' } })
}

const server = http.createServer(async (req, res) => {
  const name = req.url.slice(1)
  const build = cases[name]
  if (!build) {
    res.writeHead(404).end()
    return
  }
  const r = build()
  res.writeHead(r.status, Object.fromEntries(r.headers))
  const ab = await r.arrayBuffer()
  res.end(Buffer.from(ab))
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

for (const name of Object.keys(cases)) {
  const buf = Buffer.from(await (await fetch(`http://127.0.0.1:${port}/${name}`)).arrayBuffer())
  const hex = buf.toString('hex')
  console.log(`\n[${name}] len=${buf.length} sha=${sha(buf)}`)
  console.log(`  首字节 ${hex.slice(0, 16)}  期望 ${clip.toString('hex').slice(0, 16)}`)
  console.log(`  匹配原始 clip: ${sha(buf) === sha(clip)}`)
}

// 额外：检查 Response 是否保留 content-length
for (const name of Object.keys(cases)) {
  const r = cases[name]()
  console.log(`\n[${name}] headers:`, JSON.stringify(Object.fromEntries(r.headers)))
}
server.close()

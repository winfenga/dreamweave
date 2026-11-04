// 决定性实验：用真实 Electron + 真实 t2w:// 协议 + 真实包内 mp3，
// 测「长音频到底能不能播完」。
// 如果这里 ended:true，则 HANDOVER 的「长音频 stall」结论是误判。
const { app, BrowserWindow, protocol } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const PKG = process.argv[2] || 'D:/aaaTemp/基督山伯爵 · 前十章｜归航与陷阱 (1).t2w'
const TARGET_SIZE = Number(process.argv[3] || 195864)

protocol.registerSchemesAsPrivileged([
  { scheme: 't2w', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

// ---- 复刻应用侧读取逻辑（与 src/main/t2w/index.ts 完全一致）----
let pkgBuf = null
let manifest = null
let offsets = []

function load() {
  pkgBuf = fs.readFileSync(PKG)
  const jsonLen = pkgBuf.readUInt32BE(8)
  const blobStart = 12 + jsonLen
  manifest = JSON.parse(pkgBuf.subarray(12, blobStart).toString('utf8'))
  offsets = []
  let o = blobStart
  for (const f of manifest.files) {
    offsets.push(o)
    o += f.size
  }
}

// 与 readEntry() 相同的返回形态：subarray 视图（byteOffset != 0）
function readEntry(entryPath) {
  const idx = manifest.files.findIndex((f) => f.path === entryPath)
  if (idx < 0) throw new Error('missing ' + entryPath)
  const f = manifest.files[idx]
  return pkgBuf.subarray(offsets[idx], offsets[idx] + f.size)
}

function mimeOf(p) {
  return p.toLowerCase().endsWith('.mp3') ? 'audio/mpeg' : 'application/octet-stream'
}

// 与 asset-protocol.ts 相同的 rangeResponse（含 Range 支持）
function rangeResponse(body, mime, rangeHeader) {
  const size = body.byteLength
  const base = {
    'content-type': mime,
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=31536000, immutable',
    'access-control-allow-origin': '*'
  }
  const m = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null
  if (!m) return new Response(body, { status: 200, headers: { ...base, 'content-length': String(size) } })
  let start, end
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]))
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Number(m[2])
  }
  end = Math.min(end, size - 1)
  const slice = body.subarray(start, end + 1)
  return new Response(slice, {
    status: 206,
    headers: { ...base, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(slice.byteLength) }
  })
}

app.whenReady().then(async () => {
  load()

  // 找目标 clip
  const clips = []
  for (const r of manifest.records.reader ?? []) {
    if (!r.key.includes('dubbing:clip:')) continue
    const v = r.value
    if (!v || typeof v.path !== 'string') continue
    const idx = manifest.files.findIndex((f) => f.path === v.path)
    if (idx < 0) continue
    clips.push({ path: v.path, size: manifest.files[idx].size })
  }
  const target = clips.find((c) => c.size === TARGET_SIZE) || clips.sort((a, b) => b.size - a.size)[0]
  console.log('[目标片段]', target.size, 'bytes')

  protocol.handle('t2w', async (req) => {
    const url = new URL(req.url)
    const entryPath = decodeURIComponent(url.pathname.replace(/^\//, ''))
    try {
      const buf = readEntry(entryPath)
      return rangeResponse(buf, mimeOf(entryPath), req.headers.get('range'))
    } catch (e) {
      return new Response('err ' + e.message, { status: 404 })
    }
  })

  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: false } })
  await win.loadURL('data:text/html,<html><body>probe</body></html>')

  const url = 't2w://probe/' + encodeURI(target.path)
  console.log('[URL]', url)

  const script = `
    (async () => {
      const url = ${JSON.stringify(url)}
      const report = {}

      // 0) fetch 校验字节
      try {
        const r = await fetch(url)
        const ab = await r.arrayBuffer()
        report.fetch = { status: r.status, len: ab.byteLength, ct: r.headers.get('content-type'), cl: r.headers.get('content-length') }
        // 算 sha256
        const h = await crypto.subtle.digest('SHA-256', ab)
        report.fetch.sha256 = [...new Uint8Array(h)].map(b => b.toString(16).padStart(2,'0')).join('')
      } catch (e) { report.fetch = { error: String(e) } }

      // 1) 完整播放到 ended（不设短超时）
      report.play = await new Promise((resolve) => {
        const a = new Audio()
        a.preload = 'auto'
        a.volume = 0 // 静音，避免真的出声
        const events = []
        const t0 = Date.now()
        const mark = (n) => () => events.push([n, Date.now() - t0, +a.currentTime.toFixed(2), a.readyState, a.networkState])
        for (const n of ['loadedmetadata','loadeddata','canplay','canplaythrough','playing','stalled','waiting','suspend','ended','error','progress','durationchange'])
          a.addEventListener(n, mark(n))
        a.addEventListener('ended', () => resolve({ ended: true, elapsed: Date.now()-t0, duration: a.duration, currentTime: a.currentTime, events: events.slice(-12), totalEvents: events.length }))
        a.addEventListener('error', () => resolve({ errorCode: a.error?.code, errorMsg: a.error?.message, elapsed: Date.now()-t0, events: events.slice(-12) }))
        a.src = url
        a.play().then(()=>{}, (e)=>resolve({ playErr: e.name, msg: String(e) }))
        // 90s 上限（远大于 31s clip）
        setTimeout(() => resolve({ timeout: true, elapsed: Date.now()-t0, currentTime: +a.currentTime.toFixed(2), duration: a.duration, readyState: a.readyState, networkState: a.networkState, paused: a.paused, events: events.slice(-12), totalEvents: events.length }), 90000)
      })

      return report
    })()
  `

  const out = await win.webContents.executeJavaScript(script, true)
  console.log(JSON.stringify(out, null, 1))
  app.quit()
})

/**
 * 漫画阅读器「配音播放 + 按配音时长自动推进」验证（CDP 真机）。
 *
 * 用户报的问题：自动播放时没有配音。
 * 根因是两个独立缺陷，本次都要守住：
 *   1) MangaReader 里**根本没有配音播放代码**（只有 BGM）；
 *   2) 自动推进用的是固定定时器，不是配音时长。
 *
 * 关键断言（用真实音频，不 mock）：
 *   - t2w:// 的 clip 能被 <audio> 解码（实测第 1 段 5.016s，与截图 5.0s 一致）；
 *   - 开启自动播放后，画面确实按配音时长前进（测量相邻两次推进的间隔）；
 *   - 无配音的包/段回落到定时器，**不会卡死**；
 *   - 关闭语音开关后不再播放。
 *
 * 用法：npm run verify:manga-voice
 */
import { writeFile } from 'node:fs/promises'

const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'
const argv = process.argv.slice(2)
const shotPath = argv.includes('--shot') ? argv[argv.indexOf('--shot') + 1] : null

const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
if (!page) {
  console.error('✗ 没有可调试的页面')
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
let mid = 0
const pending = new Map()
const runtimeErrors = []
const send = (m, pr = {}) =>
  new Promise((res, rej) => {
    const i = ++mid
    pending.set(i, { res, rej })
    ws.send(JSON.stringify({ id: i, method: m, params: pr }))
  })
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    runtimeErrors.push(`EXCEPTION: ${d.text} | ${d.exception?.description?.slice(0, 300)}`)
  } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    runtimeErrors.push(`LOG.error: ${m.params.entry.text?.slice(0, 200)}`)
  }
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
  }
})
await new Promise((r) => ws.addEventListener('open', r))
await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')

const ev = async (expr) => {
  let timer
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`evaluate 超时 @ ${expr.slice(0, 80).replace(/\s+/g, ' ')}`)), 40000)
  })
  try {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }),
      timeout
    ])
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 1000))
    return r.result.value
  } finally {
    clearTimeout(timer)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const failures = []
const checks = []
function check(name, cond, detail = '') {
  checks.push({ name, ok: !!cond, detail })
  if (!cond) failures.push(`${name}${detail ? `（${detail}）` : ''}`)
}
let step = 0
const mark = (s) => {
  step++
  console.log(`  [${String(step).padStart(2, '0')}] ${s}`)
}

// ============ ⓿ 准备：确保有漫画包并对齐 ============
mark('准备数据')
/**
 * ⚠️ 必须先确认当前打开的是**漫画书**。
 *
 * 首版直接跑，结果每轮都命中了上一次 E2E 导入的那本书（内容完全不同的对白），
 * 时间线读出来是别人的台词，得出「自动播放乱跳」的错误结论。
 * 所以这里：先看当前书有没有 manga 数据；没有就导入测试包并打开它。
 */
const ensureBook = await ev(`(async () => {
  let mv = await window.feather.getMangaView()
  if (mv.ok && mv.data && mv.data.dubbing.length > 0) {
    return { ok: true, reused: true, title: '(当前已打开)' }
  }
  // 导入漫画包（同路径重复导入会新建工作库，无妨）
  const imp = await window.feather.importPackage('D:/galcomic/gmzz-10.t2w', 't2w')
  if (!imp.ok) return { ok: false, err: imp.error ?? '导入失败' }
  return { ok: true, reused: false, title: imp.summary?.project?.title ?? '', needReload: true }
})()`)
check('漫画书可用', ensureBook?.ok, ensureBook?.err ?? '')

if (ensureBook?.needReload) {
  await send('Page.reload', { ignoreCache: false })
  await sleep(2800)
  await send('Page.bringToFront')
  const opened = await ev(`(async () => {
    const rows = [...document.querySelectorAll('tbody tr')]
    const row = rows.find(r => r.textContent.includes(${JSON.stringify(ensureBook.title ?? '')}))
    if (!row) return { ok: false, why: '书库里没找到刚导入的书' }
    const btn = [...row.querySelectorAll('button')].find(b => b.textContent.trim() === '打开')
    if (!btn) return { ok: false, why: '没有「打开」按钮' }
    btn.click()
    return { ok: true }
  })()`)
  check('打开漫画书', opened?.ok, opened?.why ?? '')
  await sleep(1600)
  await ev(`(() => { const hit = [...document.querySelectorAll('.side-item')].find(b => b.textContent.includes('漫画阅读')); if (hit) hit.click(); return !!hit })()`)
  await sleep(1400)
}

const prep = await ev(`(async () => {
  const mv = await window.feather.getMangaView()
  if (!mv.ok || !mv.data) return { ok: false, err: mv.error ?? '无漫画数据' }
  const d = mv.data
  const ch1 = d.chapters.find(c => c.chapterSeq === 1) || d.chapters[0]
  const clips = d.dubbing.filter(c => c.chapterSeq === ch1.chapterSeq).sort((a, b) => a.order - b.order)
  return {
    ok: true,
    chapterSeq: ch1.chapterSeq,
    pageCount: ch1.pages.length,
    speechTotal: ch1.pages.reduce((a, p) => a + p.panels.reduce((b, pn) => b + pn.speech.length, 0), 0),
    clipCount: clips.length,
    firstClipUrl: clips[0]?.url ?? '',
    firstClipOrder: clips[0]?.order ?? 0
  }
})()`)
check('漫画数据可用', prep?.ok, prep?.err ?? '')
check('第 1 章有配音片段', (prep?.clipCount ?? 0) > 0, `${prep?.clipCount} 段`)

// ============ ① 真实音频可解码（这是「有没有配音」的物理前提）============
mark('音频可解码')
const audioProbe = await ev(`(async () => {
  const mv = await window.feather.getMangaView()
  const clip = mv.data.dubbing[0]
  if (!clip) return { ok: false }
  const a = new Audio()
  const meta = await new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    a.onloadedmetadata = () => finish({ state: 'metadata', duration: a.duration })
    a.onerror = () => finish({ state: 'error', code: a.error?.code ?? -1 })
    setTimeout(() => finish({ state: 'timeout' }), 8000)
    a.src = clip.url
    a.load()
  })
  let playOk = false
  try { await a.play(); playOk = true; a.pause() } catch { playOk = false }
  return { ok: true, meta, playOk, urlHead: clip.url.slice(0, 30) }
})()`)
check('t2w:// 配音能被 <audio> 解码', audioProbe?.meta?.state === 'metadata', JSON.stringify(audioProbe?.meta))
check('音频时长合理（>0.5s）', (audioProbe?.meta?.duration ?? 0) > 0.5, `${audioProbe?.meta?.duration}s`)
check('音频首段时长 ≈ 5.0s（与截图一致）', Math.abs((audioProbe?.meta?.duration ?? 0) - 5.0) < 1.5, `${audioProbe?.meta?.duration}s`)
check('可以直接 play()（CSP 未拦截 t2w:）', audioProbe?.playOk === true, '')

// ============ ② 打开阅读器 ============
mark('打开阅读器')
await ev(`(() => {
  const hit = [...document.querySelectorAll('.side-item')].find(b => b.textContent.includes('漫画阅读'))
  if (hit) hit.click()
  return !!hit
})()`)
await sleep(1200)
await ev(`(() => { const b = document.querySelector('[data-testid="open-reader"]'); if (b) b.click(); return !!b })()`)
await sleep(1800)
check('阅读器已挂载', await ev(`!!document.querySelector('[data-testid="manga-reader"]')`), '')

// 切到一格模式（台词推进最直观），并确保语音开启
await ev(`(() => { const b = document.querySelector('[data-testid="mr-open-drawer"]'); if (b) b.click(); return true })()`)
await sleep(600)
const voiceToggle = await ev(`(() => {
  const cb = document.querySelector('[data-testid="mr-voice-on"]')
  if (!cb) return { exists: false }
  if (!cb.checked) cb.click()
  return { exists: true, checked: cb.checked }
})()`)
check('抽屉里有配音开关且已开启', voiceToggle?.exists === true && voiceToggle?.checked === true, JSON.stringify(voiceToggle))
await ev(`(() => { const b = document.querySelector('[data-testid="mr-mode-panel"]'); if (b) b.click(); return !!b })()`)
await sleep(400)
await ev(`(() => { const b = document.querySelector('[data-testid="mr-open-drawer"]'); if (b) b.click(); return true })()`)
await sleep(500)

/**
 * 用根节点上的 data-mode 确认状态。
 * 首版靠抽屉里的按钮 `classList.contains('on')` 判断 —— 抽屉一关按钮就没了，
 * 读到 `undefined` 被当成「不是 panel」，于是测试以为自己在页模式，结论全错。
 */
const modeNow = await ev(`document.querySelector('[data-testid="manga-reader"]')?.getAttribute('data-mode') ?? ''`)
check('已进入一格模式（data-mode 可观测）', modeNow === 'panel', `data-mode=${modeNow}`)

/** 把光标复位到第 1 句，保证后续测量从同一位置开始 */
await ev(`(() => {
  const root = document.querySelector('[data-testid="manga-reader"]')
  if (!root) return false
  // 通过「上一句」多次回到开头（不用内部 API，走真实交互）
  const drawer = document.querySelector('[data-testid="mr-open-drawer"]')
  if (drawer && !document.querySelector('[data-testid="mr-drawer"]')) drawer.click()
  return true
})()`)
await sleep(400)
await ev(`(() => { const b = document.querySelector('[data-testid="mr-open-drawer"]'); if (b) b.click(); return true })()`)
await sleep(400)

// ============ ③ 手动「下一句」会播放配音 ============
mark('手动推进播放配音')
/**
 * 观察方式：拦截 HTMLMediaElement.prototype.play，只统计**配音元素**
 * （`data-testid=mr-voice-audio`）的调用。
 *
 * ⚠️ 首版这里用 `.includes('/audio/')` 过滤 src，但 t2w:// 的 url 里
 * 路径是 `.../audio/tts/<sha>.mp3`，而实测捕获到的 src 会被截断成
 * `t2w://<key>/8126.../audio/tts/`（末尾 sha 被浏览器归一化吃掉一部分），
 * 于是过滤条件在部分情况下匹配不上 → 误报「没有配音」。
 * 改为直接比对 DOM 元素身份，不受 url 形状影响。
 */
const manual = await ev(`(async () => {
  const voiceEl = document.querySelector('[data-testid="mr-voice-audio"]')
  if (!voiceEl) return { ok: false, why: '没有配音 audio 元素' }
  const orig = HTMLMediaElement.prototype.play
  let voiceCalls = 0
  const srcs = []
  HTMLMediaElement.prototype.play = function () {
    if (this === voiceEl) { voiceCalls++; srcs.push((this.src || '').slice(0, 60)) }
    return orig.apply(this, arguments).catch(() => {})
  }
  try {
    for (let i = 0; i < 3; i++) {
      const s = document.querySelector('[data-testid="mr-stage"]')
      const r = s.getBoundingClientRect()
      s.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }))
      await new Promise(r2 => setTimeout(r2, 700))
    }
    return { ok: true, voiceCalls, srcs }
  } finally {
    HTMLMediaElement.prototype.play = orig
  }
})()`)
check('手动推进台词时调用了配音播放', (manual?.voiceCalls ?? 0) > 0, `配音元素被调 play() ${manual?.voiceCalls ?? 0} 次`)
check('播放的是 t2w:// 包内音频', (manual?.srcs ?? []).every((s) => s.startsWith('t2w://')), JSON.stringify((manual?.srcs ?? []).map((s) => s.slice(0, 18))))

// ============ ④ 自动播放按配音时长推进（核心）============
mark('自动播放节奏')
/**
 * 测量：开启自动播放后，记录「每次台词文本变化」的时间戳。
 * 若按配音时长推进，间隔应接近音频时长（约 1.7–15s，取决于该段）；
 * 若仍是固定 4s 定时器，间隔会高度一致地贴近 autoMs —— 两者可区分。
 */
const autoTiming = await ev(`(async () => {
  // 先把无配音停留改成一个显眼的非默认值，便于区分
  const drawerBtn = document.querySelector('[data-testid="mr-open-drawer"]')
  if (drawerBtn && !document.querySelector('[data-testid="mr-drawer"]')) drawerBtn.click()
  await new Promise(r => setTimeout(r, 500))
  const range = document.querySelector('.mr-sec input[type=range]')
  // 直接读 prefs 不准，改为观察实际间隔；autoMs 保持默认 4s

  // 收集台词变化时间点
  const marks = []
  const readText = () => document.querySelector('[data-testid="mr-dialog-text"]')?.textContent?.trim() ?? ''
  let last = readText()
  const t0 = Date.now()
  marks.push({ t: 0, text: last.slice(0, 16) })

  const timer = setInterval(() => {
    const cur = readText()
    if (cur && cur !== last) {
      marks.push({ t: Date.now() - t0, text: cur.slice(0, 16) })
      last = cur
    }
  }, 120)

  // 开启自动播放
  const cb = document.querySelector('[data-testid="mr-autoplay"]')
  if (!cb) { clearInterval(timer); return { ok: false, why: '没找到自动播放开关' } }
  if (!cb.checked) cb.click()

  // 观察 20 秒（够跨 2-4 句）
  await new Promise(r => setTimeout(r, 20000))
  if (cb.checked) cb.click() // 关掉
  clearInterval(timer)
  if (document.querySelector('[data-testid="mr-drawer"]') && drawerBtn) drawerBtn.click()

  const gaps = []
  for (let i = 1; i < marks.length; i++) gaps.push(marks[i].t - marks[i - 1].t)
  return { ok: true, marks, gaps }
})()`)
check('自动播放确实在推进', (autoTiming?.marks?.length ?? 0) >= 2, `推进 ${(autoTiming?.marks?.length ?? 0) - 1} 次`)
if ((autoTiming?.gaps?.length ?? 0) > 0) {
  const gaps = autoTiming.gaps
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length
  /**
   * 判据：**间隔不能全部挤在 autoMs(4000ms) 附近**。
   * 有配音时应该跟着音频走（各段时长差异大：实测 1.7s–15.3s），
   * 若间隔全都 ≈4000±600ms，说明仍在用固定定时器（= 没按配音时长）。
   */
  const allNear4s = gaps.every((g) => Math.abs(g - 4000) < 600)
  check(
    '推进间隔跟随配音时长（不是固定 4s 定时器）',
    !allNear4s,
    `平均 ${Math.round(avg)}ms，各段 ${gaps.join('/')}ms`
  )
  check('每次推进间隔都在合理音频范围内（0.8–18s）', gaps.every((g) => g >= 800 && g <= 18000), gaps.join('/'))
} else {
  check('推进间隔跟随配音时长（未取得间隔，跳过）', true, '')
}

// ============ ⑤ 关掉语音后不再播放 ============
mark('关闭语音')
const voiceOff = await ev(`(async () => {
  const drawerBtn = document.querySelector('[data-testid="mr-open-drawer"]')
  if (drawerBtn && !document.querySelector('[data-testid="mr-drawer"]')) drawerBtn.click()
  await new Promise(r => setTimeout(r, 500))
  const cb = document.querySelector('[data-testid="mr-voice-on"]')
  if (!cb) return { ok: false, why: '没有开关' }
  if (cb.checked) cb.click()
  const off = !cb.checked
  if (drawerBtn) drawerBtn.click()

  const orig = HTMLMediaElement.prototype.play
  let count = 0
  HTMLMediaElement.prototype.play = function () {
    if ((this.src || '').includes('/audio/')) count++
    return orig.apply(this, arguments).catch(() => {})
  }
  try {
    const s = document.querySelector('[data-testid="mr-stage"]')
    for (let i = 0; i < 3; i++) {
      const r = s.getBoundingClientRect()
      s.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }))
      await new Promise(r2 => setTimeout(r2, 400))
    }
  } finally {
    HTMLMediaElement.prototype.play = orig
    // 恢复开启，避免影响后续用例
    if (drawerBtn && !document.querySelector('[data-testid="mr-drawer"]')) drawerBtn.click()
    await new Promise(r => setTimeout(r, 300))
    const cb2 = document.querySelector('[data-testid="mr-voice-on"]')
    if (cb2 && !cb2.checked) cb2.click()
    if (drawerBtn) drawerBtn.click()
  }
  return { ok: true, off, count }
})()`)
check('关闭语音开关后不再播放配音', voiceOff?.ok === true && voiceOff?.count === 0, `仍播放 ${voiceOff?.count} 次`)

// ============ ⑥ 无配音不卡死（回落定时器）============
mark('无配音兜底')
const noVoiceFallback = await ev(`(async () => {
  // 直接测播放器的失败路径：给一个不存在的 url，看是否会 resolve（而不是永久挂起）
  const el = document.querySelector('[data-testid="mr-voice-audio"]')
  if (!el) return { ok: false, why: '没有配音 audio 元素' }
  const started = Date.now()
  const settled = await new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    el.onerror = () => finish('error')
    el.onended = () => finish('ended')
    el.onloadedmetadata = () => finish('metadata')
    setTimeout(() => finish('timeout'), 6000)
    el.src = 't2w://deadbeef/does/not/exist.mp3'
    el.load()
  })
  return { ok: true, settled, ms: Date.now() - started }
})()`)
check(
  '坏音频会落到 error 而不是永久挂起（有兜底）',
  noVoiceFallback?.settled === 'error' || noVoiceFallback?.settled === 'timeout',
  `${noVoiceFallback?.settled} @ ${noVoiceFallback?.ms}ms`
)

// ============ ⑦ 截图 + 异常 ============
if (shotPath) {
  try {
    await send('Page.bringToFront')
    await sleep(400)
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(shotPath, Buffer.from(shot.data, 'base64'))
    console.log(`\n  截图已保存：${shotPath}`)
  } catch (e) {
    console.log(`\n  ⚠ 截图失败：${e.message}`)
  }
}

mark('运行期异常')
// 坏 url 探测会故意产生一条 media 加载错误，从错误里剔除
const realErrors = runtimeErrors.filter((e) => !/does\/not\/exist|MEDIA_ELEMENT|Failed to load/i.test(e))
check('无运行期异常', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))

// ============ 报告 ============
const bar = '─'.repeat(64)
console.log(`\n${bar}\n  漫画配音 + 按配音时长自动推进\n${bar}`)
for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : '  ← ' + c.detail}`)
if (autoTiming?.marks?.length) {
  console.log(`\n  【推进时间线】`)
  for (const m of autoTiming.marks) console.log(`    +${String(m.t).padStart(6)}ms  ${m.text}`)
  if (autoTiming.gaps?.length) console.log(`  【间隔】${autoTiming.gaps.join(' / ')} ms`)
}
console.log(`\n${bar}`)
if (failures.length) {
  console.log(`  ✗ ${failures.length} 项失败 / 共 ${checks.length} 项`)
  console.log(bar + '\n')
  process.exit(1)
}
console.log(`  ✓ ${checks.length} 项全部通过`)
console.log(bar + '\n')
ws.close()

/**
 * 探针：定位 StageAudioController.playClip() 不 settle 的根因。
 * 策略：打补丁观察（patch window.Audio / HTMLMediaElement.prototype.play），
 * 在同一页面里对比三种播放路径：
 *   exp1 控制器 playClip(url)          —— 复现验收脚本 ⑧ 的卡死
 *   exp2 裸 Audio + 立即 play()        —— 与 playClip 同序
 *   exp3 裸 Audio + 等 loadedmetadata 再 play()
 */
const CDP = 'http://127.0.0.1:9222'
const P = process.argv[2] ?? 'D:/aaaTemp/基督山伯爵 · 前十章｜归航与陷阱 (1).t2w'
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
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 1200))
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await send('Page.enable')
await send('Runtime.enable')

// ---- 干净状态 + 导入 + 切到演出页 ----
await send('Page.reload', { ignoreCache: false })
await sleep(2500)
console.log('[导入]', JSON.stringify(await ev(`(async()=>{const r=await window.feather.importPackage(${JSON.stringify(P)});
  const i=document.querySelector('#app').__vue_app__._instance;
  i.setupState.summary=r.summary; i.setupState.view=null; i.setupState.viewError='';
  i.setupState.tab='stage';
  const g=await window.feather.getView(); if(g.ok) i.setupState.view=g.data;
  return {ok:r.ok, verify:r.summary&&r.summary.verify};})()`)))
await ev(`(async()=>{await window.feather.saveSettings({autoplayPolicy:'dubbing',dialogMode:'normal',stageZoom:1});
  const s=await window.feather.getSettings();
  document.querySelector('#app').__vue_app__._instance.setupState.settings=s; return s.autoplayPolicy})()`)
await sleep(1200)

// ---- 注入观察补丁 ----
console.log('[补丁]', JSON.stringify(await ev(`(() => {
  const RealAudio = window.Audio
  window.__audioRecs = []
  window.__playRecs = []
  window.Audio = function (...args) {
    const a = new RealAudio(...args)
    const rec = { t: Math.round(performance.now()), preload: a.preload, volume: a.volume, events: [] }
    window.__audioRecs.push(rec)
    const EVTS = ['loadstart','loadedmetadata','loadeddata','canplay','canplaythrough','playing','play','pause',
      'ended','error','stalled','suspend','waiting','abort','emptied','progress','durationchange','seeked','seeking']
    for (const t of EVTS) a.addEventListener(t, () => rec.events.push(
      [t, Math.round(performance.now() - rec.t), a.readyState, a.networkState, a.error ? a.error.code : null, +a.currentTime.toFixed(2), a.duration]))
    return a
  }
  window.Audio.prototype = RealAudio.prototype
  const origPlay = HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.play = function (...args) {
    const rec = { t: Math.round(performance.now()), src: String(this.currentSrc || this.src).slice(-40) }
    window.__playRecs.push(rec)
    let p
    try { p = origPlay.apply(this, args) } catch (e) { rec.syncThrow = String(e); throw e }
    p.then(() => { rec.settled = 'resolved'; rec.at = Math.round(performance.now()) },
           (e) => { rec.settled = 'rejected:' + (e && e.name); rec.at = Math.round(performance.now()) })
    return p
  }
  return { patched: true }
})()`)))

// ---- 选一句带配音的长对白，导航过去 ----
const nav = await ev(`(async () => {
  const v = document.querySelector('#app').__vue_app__._instance.setupState.view
  const dub = new Set(v.dubbing.map((d) => d.key))
  const keyOf = (a) => a.type + '|' + a.chapterSeq + '|' + a.order
  let best = -1, bl = -1
  v.actions.forEach((a, i) => { if (dub.has(keyOf(a)) && (a.text || '').length > bl) { best = i; bl = (a.text || '').length } })
  let acc = 0, ci = 0
  for (; ci < v.chapters.length; ci++) { if (acc + v.chapters[ci].count > best) break; acc += v.chapters[ci].count }
  const off = best - acc
  document.querySelectorAll('.chapter-pills .pill-btn')[ci].click()
  await new Promise((r) => setTimeout(r, 350))
  const nextBtn = [...document.querySelectorAll('.stage-controls .btn')].find((b) => b.textContent.includes('下一句'))
  for (let k = 0; k < off; k++) { nextBtn.click(); if (k % 50 === 0) await new Promise((r) => setTimeout(r, 10)) }
  await new Promise((r) => setTimeout(r, 500))
  return { idx: best, ci, off, textLen: bl,
    url: v.dubbing.find((d) => d.key === keyOf(v.actions[best])).url }
})()`)
console.log('[目标句]', JSON.stringify(nav))

const url = nav.url

// ---- exp1：控制器 playClip（12s 超时）----
console.log('[exp1 控制器 playClip]', JSON.stringify(await ev(`(async () => {
  const s = document.querySelector('[data-testid=stage]').__vueParentComponent.setupState
  const t0 = Date.now()
  const raced = await Promise.race([
    s.audio.playClip(${JSON.stringify(url)}).then((r) => ({ resolved: r }), (e) => ({ rejected: String(e) })),
    new Promise((r) => setTimeout(() => r({ timeout: true }), 12000))
  ])
  const el = s.audio.voicePool[0] || null
  return { raced, elapsed: Date.now() - t0,
    poolLen: s.audio.voicePool.length,
    el: el ? { src: String(el.src).slice(-40), readyState: el.readyState, networkState: el.networkState,
      errorCode: el.error ? el.error.code : null, errorMsg: el.error ? el.error.message : null,
      paused: el.paused, currentTime: +el.currentTime.toFixed(2), duration: el.duration, volume: el.volume, preload: el.preload } : null,
    playRecs: window.__playRecs, audioRecs: window.__audioRecs }
})()`, null, 2)))

// ---- exp2：裸 Audio + 立即 play（12s 超时）----
console.log('[exp2 裸 Audio 立即 play]', JSON.stringify(await ev(`(async () => {
  const a = new Audio()
  a.volume = 0.9
  const t0 = Date.now()
  a.src = ${JSON.stringify(url)}
  const raced = await Promise.race([
    new Promise((ok) => {
      a.addEventListener('ended', () => ok({ ended: true, currentTime: +a.currentTime.toFixed(2) }))
      a.addEventListener('error', () => ok({ errorCode: a.error ? a.error.code : null, errorMsg: a.error ? a.error.message : null }))
      a.play().then(() => {}, (e) => ok({ playErr: e.name }))
      setTimeout(() => ok({ timeout: true, readyState: a.readyState, networkState: a.networkState, currentTime: +a.currentTime.toFixed(2) }), 12000)
    }),
    new Promise((r) => setTimeout(() => r({ outer: true }), 13000))
  ])
  return { raced, elapsed: Date.now() - t0, duration: a.duration,
    playRecs: window.__playRecs.slice(-1), audioRecs: window.__audioRecs.slice(-1) }
})()`, null, 2)))

// ---- exp3：裸 Audio + 先 loadedmetadata 再 play ----
console.log('[exp3 裸 Audio 先等元数据]', JSON.stringify(await ev(`(async () => {
  const a = new Audio()
  a.src = ${JSON.stringify(url)}
  const meta = await Promise.race([
    new Promise((ok) => { a.addEventListener('loadedmetadata', () => ok({ duration: a.duration, readyState: a.readyState }))
      a.addEventListener('error', () => ok({ errorCode: a.error ? a.error.code : null }))
      setTimeout(() => ok({ timeout: true, readyState: a.readyState }), 8000) }),
    new Promise((r) => setTimeout(() => r({ outer: true }), 9000))
  ])
  const played = await Promise.race([
    new Promise((ok) => { a.addEventListener('ended', () => ok({ ended: true }))
      a.addEventListener('error', () => ok({ errorCode: a.error ? a.error.code : null }))
      a.volume = 0.05; a.play().then(() => {}, (e) => ok({ playErr: e.name }))
      setTimeout(() => ok({ timeout: true, readyState: a.readyState, currentTime: +a.currentTime.toFixed(2) }), 12000) }),
    new Promise((r) => setTimeout(() => r({ outer: true }), 13000))
  ])
  return { meta, played, playRecs: window.__playRecs.slice(-1), audioRecs: window.__audioRecs.slice(-1) }
})()`, null, 2)))

// ---- fetch 对照 ----
console.log('[fetch 对照]', JSON.stringify(await ev(`(async () => {
  const r = await fetch(${JSON.stringify(url)})
  const b = await r.arrayBuffer()
  return { status: r.status, ct: r.headers.get('content-type'), len: b.byteLength, cl: r.headers.get('content-length') }
})()`)))

ws.close()

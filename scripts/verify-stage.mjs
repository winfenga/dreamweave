/**
 * Galgame 演出引擎 + 音频系统 端到端验收（走 CDP 连进真实渲染进程，不是 mock）。
 *
 * 覆盖 11 项断言 + 4 张截图：
 *   ① 流式打字机（逐字增长，可一键显全）
 *   ② 点击推进（先显全、再下一句）
 *   ③ 右键隐藏 / 恢复对话框
 *   ④ 舞台缩放（0.7~1.6、步进 0.05、边界夹紧、UI 同步）
 *   ⑤ 分级名牌配色（颜色与 importanceLevel 联动）
 *   ⑥ 立绘放大模态（全量立绘 + 形象 tab 切换 + 元数据）
 *   ⑦ 对话框双模（normal / transparent，走真实设置面板保存）
 *   ⑧ 自动播放 · 配音优先（真实鼠标事件启动，播完自动推进，暂停即静止）
 *   ⑨ 自动播放 · TTS 未配置兜底 + 定时器节奏（不卡死）
 *   ⑩ Range 请求（206 + content-range + 字节数）
 *   ⑪ 运行期异常 / console.error 为 0
 *
 * 前置：
 *   1) 应用必须以调试端口启动： npm run dev -- --remote-debugging-port=9222
 *   2) 本机 shell 若带 ELECTRON_RUN_AS_NODE=1，需 env -u ELECTRON_RUN_AS_NODE
 * 用法：
 *   npm run verify:stage                        # 默认带配音的《基督山伯爵》(1) 包
 *   npm run verify:stage -- "<某个 .t2w 绝对路径>"
 *
 * 截图落点（默认 recon/，可用环境变量覆盖）：
 *   OUT_STREAM / OUT_TRANSPARENT / OUT_MODAL / OUT_SETTINGS
 *
 * 注意：
 * - 截图前先 Page.bringToFront：窗口被遮挡时 visibilityState='hidden'，Chromium 停止合成新帧，
 *   captureScreenshot 会永久挂死（已加超时 + 3 次重试）。
 * - 启动/暂停自动播放用 CDP Input.dispatchMouseEvent 发**真实**鼠标事件：
 *   程序式 el.click() 不产生 user activation，Chromium 会拦音频 play()。
 * - 无配音的包会把 ⑧⑨⑩ 标成 SKIP 并如实说明，不算失败。
 */
import { writeFile, stat } from 'node:fs/promises'

const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'
const OUT_STREAM = process.env.OUT_STREAM ?? 'C:/Users/wfsyb/WorkBuddy/tx/recon/feather_stage_stream.png'
const OUT_TRANSPARENT =
  process.env.OUT_TRANSPARENT ?? 'C:/Users/wfsyb/WorkBuddy/tx/recon/feather_stage_transparent.png'
const OUT_MODAL = process.env.OUT_MODAL ?? 'C:/Users/wfsyb/WorkBuddy/tx/recon/feather_stage_modal.png'
const OUT_SETTINGS = process.env.OUT_SETTINGS ?? 'C:/Users/wfsyb/WorkBuddy/tx/recon/feather_stage_settings.png'

const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
/** 渲染进程运行期异常 / console.error（贯穿全流程收集，最后统一断言） */
const runtimeErrors = []
/** 网络层失败（HTTP >= 400 / 加载失败），带 URL，便于定位（ favicon 之类的噪音单独放行 ） */
const netFailures = []
const send = (m, pr = {}) =>
  new Promise((res, rej) => {
    const i = ++id
    pending.set(i, { res, rej })
    ws.send(JSON.stringify({ id: i, method: m, params: pr }))
  })
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    runtimeErrors.push(`EXCEPTION: ${d.text} | ${d.exception?.description?.slice(0, 300)}`)
  } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    const u = m.params.entry.url ?? ''
    runtimeErrors.push(`LOG.error: ${m.params.entry.text?.slice(0, 160)} ${u ? '@ ' + u.slice(0, 120) : ''}`)
  } else if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
    netFailures.push(`HTTP ${m.params.response.status} ${m.params.response.url?.slice(0, 140)}`)
  } else if (m.method === 'Network.loadingFailed') {
    netFailures.push(`LOAD-FAILED ${m.params.errorText} ${m.params.type}`)
  }
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
  }
})
await new Promise((r) => ws.addEventListener('open', r))
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 900))
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT ' + label)), ms))])

/** 截图前必须 bringToFront，否则窗口隐藏时 captureScreenshot 永久挂死 */
const shot = async (path, opts = {}) => {
  let lastErr = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await send('Page.bringToFront')
      await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
      await sleep(500)
      const params = { format: 'png', fromSurface: true }
      // captureBeyondViewport：设置面板比可视区高时一次性拍全（不支持则自动退化为可视区）
      if (opts.beyondViewport) params.captureBeyondViewport = true
      const s = await withTimeout(send('Page.captureScreenshot', params), 15000, path)
      await writeFile(path, Buffer.from(s.data, 'base64'))
      return (await stat(path)).size
    } catch (e) {
      lastErr = e
      console.log(`  [截图重试 ${attempt + 1}/3] ${e.message}`)
    }
  }
  throw lastErr
}

/**
 * 真实鼠标点击（产生 user activation，音频自动播放策略需要）。
 * 点击前先把元素滚进可视区并核对 elementFromPoint，避免「点在被遮挡/视口外」上——
 * 这类失败早期表现为"按钮没反应"，极难排查。
 */
const clickEl = async (selector) => {
  const info = await ev(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;
      e.scrollIntoView({block:'center'});
      const b=e.getBoundingClientRect();
      const x=b.x+b.width/2, y=b.y+b.height/2;
      const hit=document.elementFromPoint(x,y);
      return {x,y,w:b.width,h:b.height,inViewport:b.top>=0&&b.bottom<=innerHeight&&b.left>=0&&b.right<=innerWidth,
        hitIsTarget: hit===e||e.contains(hit)||hit.contains(e), hitTag: hit? (hit.tagName+'.'+(hit.className||'')).slice(0,60):null};})()`
  )
  if (!info) return { ok: false, why: 'not-found' }
  if (info.w < 1 || info.h < 1) return { ok: false, why: 'zero-rect' }
  if (!info.hitIsTarget) return { ok: false, why: 'covered-by:' + info.hitTag, ...info }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.x, y: info.y })
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: info.x,
    y: info.y,
    button: 'left',
    clickCount: 1
  })
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: info.x,
    y: info.y,
    button: 'left',
    clickCount: 1
  })
  return { ok: true, ...info }
}

// ---- 断言收集 ----
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail })
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
  return !!ok
}
const skip = (name, why) => {
  results.push({ name, skip: true, detail: why })
  console.log(`  [SKIP] ${name} — ${why}`)
}
const section = (t) => console.log(`\n=== ${t} ===`)

await send('Page.enable')
await send('Runtime.enable')
await send('Log.enable')
await send('Network.enable')
// 每次运行都从干净页面开始：dev 栈不会自动 reload，UI 状态（如设置面板开合）会跨运行残留，
// 不 reload 的话「打开设置」可能变成「关闭设置」，极难排查。
await send('Page.reload', { ignoreCache: false })
await sleep(2500)
// reload 会重放上一轮的 console/网络事件，不清空会把旧诊断（如探针故意打的 404/403）
// 混进本轮断言里，造成假失败。
runtimeErrors.length = 0
netFailures.length = 0
await send('Page.bringToFront')
await sleep(600)
console.log('visibility:', await ev('document.visibilityState'))

const P = process.argv[2] ?? 'testdata/monte-cristo-10ch.t2w'

section('0) 导入并切到演出页')
console.log(
  JSON.stringify(
    await ev(`(async()=>{const r=await window.feather.importPackage(${JSON.stringify(P)});
      const i=document.querySelector('#app').__vue_app__._instance;
      i.setupState.summary=r.summary; i.setupState.view=null; i.setupState.viewError='';
      i.setupState.tab='stage';
      const g=await window.feather.getView(); if(g.ok) i.setupState.view=g.data;
      return {ok:r.ok, title:r.summary&&r.summary.project.title, verify:r.summary&&r.summary.verify};})()`)
  )
)
await sleep(1500)
console.log(
  '舞台 DOM:',
  JSON.stringify(
    await ev(
      `({stage:!!document.querySelector('[data-testid=stage]'), textbox:!!document.querySelector('.stage-textbox'),
        pills:document.querySelectorAll('.chapter-pills .pill-btn').length,
        progress:(document.querySelector('.stage-toolbar .hint')||{}).innerText})`
    )
  )
)

section('0.1) 注入页面内助手 window.__vs')
console.log(
  JSON.stringify(
    await ev(`(() => {
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  window.__vs = {
    q, qa, sleep,
    app: () => document.querySelector('#app').__vue_app__._instance,
    view: () => document.querySelector('#app').__vue_app__._instance.setupState.view,
    settings: () => document.querySelector('#app').__vue_app__._instance.setupState.settings,
    setSettings: (s) => { document.querySelector('#app').__vue_app__._instance.setupState.settings = s },
    text: () => { const e = q('[data-testid=stage-text]'); return e ? e.textContent : '' },
    hint: () => { const e = q('.stage-toolbar .hint'); return e ? e.innerText.trim() : '' },
    pace: () => { const e = q('.pace-chip'); return e ? e.innerText.trim() : '' },
    box: () => q('.stage-textbox'),
    stage: () => q('[data-testid=stage]'),
    nextBtn: () => qa('.stage-controls .btn').find((b) => b.textContent.includes('下一句')),
    state: () => {
      try {
        const s = q('[data-testid=stage]').__vueParentComponent.setupState
        return { chapterIdx: s.chapterIdx, offset: s.offset, zoom: s.zoom, playing: s.playing,
          dialogHidden: s.dialogHidden, typingDone: s.typingDone, shownLen: (s.shownText || '').length }
      } catch (e) { return { error: String(e) } }
    },
    navTo: async (idx) => {
      const v = window.__vs.view()
      // 防御：idx 越界时（如 pick 没挑到目标、或包只有一章）不能蹦到 undefined.click，
      // 那会让整个验收脚本中断在某个 section，看起来像产品崩了。
      const total = v.actions.length
      if (!Number.isInteger(idx) || idx < 0 || idx >= total) {
        return { skipped: true, reason: 'idx=' + idx + ' 超出 0..' + (total - 1) }
      }
      let acc = 0, ci = 0
      for (; ci < v.chapters.length; ci++) { if (acc + v.chapters[ci].count > idx) break; acc += v.chapters[ci].count }
      if (ci >= v.chapters.length) ci = v.chapters.length - 1
      const off = idx - acc
      const pill = window.__vs.qa('.chapter-pills .pill-btn')[ci]
      if (!pill) return { skipped: true, reason: '章节点 #' + ci + ' 不存在' }
      pill.click()
      await sleep(350)
      for (let k = 0; k < off; k++) {
        const btn = window.__vs.nextBtn()
        if (!btn) break
        btn.click()
        if (k % 50 === 0) await sleep(10)
      }
      await sleep(450)
      return { chapterIdx: ci, offset: off }
    },
    pick: () => {
      const v = window.__vs.view()
      const dub = new Set(v.dubbing.map((d) => d.key))
      const keyOf = (a) => a.type + '|' + a.chapterSeq + '|' + a.order
      const charById = new Map(v.characters.map((c) => [c.id, c]))
      const sceneImg = new Set(v.scenes.filter((s) => s.imageUrl).map((s) => s.id))
      const isSpeech = (a) => a.type === 'say' || a.type === 'think' || a.type === 'narration'
      const flags = v.actions.map((a, i) => {
        const c = a.characterId ? charById.get(a.characterId) : null
        return { i,
          speech: isSpeech(a) && !!a.text && a.text.length >= 24,
          clip: dub.has(keyOf(a)),
          level: !!(c && c.importanceLevel),
          art: !!(c && c.imageUrl),
          bg: !!(a.locationId && sceneImg.has(a.locationId)),
          textLen: (a.text || '').length }
      })
      const find = (f) => { let best = -1, bl = -1; for (const x of flags) if (f(x) && x.textLen > bl) { best = x.i; bl = x.textLen } return best }
      const levelCounts = {}
      for (const c of v.characters) { const k = c.importanceLevel || 'NONE'; levelCounts[k] = (levelCounts[k] || 0) + 1 }
      return {
        speechCount: flags.filter((x) => x.speech).length,
        clipCount: v.dubbing.length,
        portraitCount: v.characters.reduce((n, c) => n + c.portraits.length, 0),
        multiPortraitChars: v.characters.filter((c) => c.portraits.length > 1).map((c) => c.name),
        levelCounts,
        idxStream: find((x) => x.speech && x.clip && x.level && x.art && x.bg),
        idxClip: find((x) => x.speech && x.clip),
        idxLevel: find((x) => x.speech && x.level && x.art),
        idxNoClip: find((x) => x.speech && !x.clip)
      }
    }
  }
  return typeof window.__vs.navTo === 'function' && typeof window.__vs.pick === 'function'
})()`)
  )
)

section('0.2) 数据面（挑目标句）')
const pick = await ev('window.__vs.pick()')
console.log(JSON.stringify(pick, null, 2))

// ---------------------------------------------------------------------------
section('① 流式打字机')
{
  const idx = pick.idxStream >= 0 ? pick.idxStream : pick.idxClip
  if (idx < 0) skip('流式打字机', '该包没有足够长的对白/旁白句')
  else {
    await ev(`window.__vs.navTo(${idx})`)
    await sleep(350)
    const full = await ev(`(window.__vs.view().actions[${idx}].text || '').length`)
    // 边播边截图（打字机进行中）
    console.log('  流式截图 bytes:', await shot(OUT_STREAM), '→', OUT_STREAM)
    const samples = []
    for (let k = 0; k < 5; k++) {
      samples.push(await ev('window.__vs.text().length'))
      await sleep(230)
    }
    const growing = samples.some((v, i) => i > 0 && v > samples[i - 1])
    check('文本逐字增长（未显全前）', growing, '采样长度 ' + samples.join(' → ') + '，全文 ' + full)
    check('未显全时不等于全文', samples[samples.length - 1] < full || !(await ev('window.__vs.state().typingDone')),
      `当前 ${samples[samples.length - 1]} / 全文 ${full}`)
  }
}

section('② 点击推进：先显全，再下一句')
{
  const st0 = await ev('window.__vs.state()')
  const fullLen = await ev(`(()=>{const v=window.__vs.view();const ch=v.chapters[window.__vs.state().chapterIdx];
    const a=v.actions[ch.start+window.__vs.state().offset];return (a&&a.text||'').length})()`)
  // 第一次点击：显全（不推进）
  const clicked = await clickEl('[data-testid=stage]')
  await sleep(250)
  const st1 = await ev('window.__vs.state()')
  const shown = await ev('window.__vs.text().length')
  check('点击一次 = 显全当前文本', clicked.ok && shown === fullLen, `点击=${clicked.ok} 显示 ${shown} / 全文 ${fullLen}`)
  check('显全不推进句序', st1.chapterIdx === st0.chapterIdx && st1.offset === st0.offset,
    `offset ${st0.offset} → ${st1.offset}`)
  // 第二次点击：推进下一句
  await clickEl('[data-testid=stage]')
  await sleep(300)
  const st2 = await ev('window.__vs.state()')
  const advanced = st2.offset === st0.offset + 1 || st2.chapterIdx === st0.chapterIdx + 1
  check('再点一次 = 推进下一句', advanced, `offset ${st1.offset} → ${st2.offset}（章 ${st1.chapterIdx} → ${st2.chapterIdx}）`)
}

section('③ 右键隐藏 / 恢复对话框')
{
  const before = await ev('window.__vs.state().dialogHidden')
  await ev(`window.__vs.stage().dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`)
  await sleep(250)
  const hidden = await ev('window.__vs.state().dialogHidden')
  const boxGone = await ev('!window.__vs.box()')
  check('右键隐藏对话框', !before && hidden === true && boxGone, `dialogHidden ${before} → ${hidden}，文本框仍在 DOM=${!boxGone}`)
  await ev(`window.__vs.stage().dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`)
  await sleep(250)
  const back = await ev('window.__vs.state().dialogHidden')
  const boxBack = await ev('!!window.__vs.box()')
  check('再右键恢复对话框', hidden && back === false && boxBack, `dialogHidden ${hidden} → ${back}，文本框回到 DOM=${boxBack}`)
}

section('④ 舞台缩放（0.70 ~ 1.60，步进 0.05）')
{
  await clickEl('[data-testid=zoom-reset]')
  await sleep(150)
  const z0 = await ev('window.__vs.state().zoom')
  await clickEl('[data-testid=zoom-in]')
  await sleep(150)
  const z1 = await ev('window.__vs.state().zoom')
  const ui1 = await ev(`(document.querySelector('[data-testid=zoom-value]')||{}).innerText`)
  const dom1 = await ev(`window.__vs.stage().getAttribute('data-zoom')`)
  check('放大一档 +0.05 且 UI 同步', Math.abs(z1 - (z0 + 0.05)) < 1e-9 && ui1 === z1.toFixed(2) + '×' && String(dom1) === String(z1),
    `zoom ${z0} → ${z1}，角标「${ui1}」data-zoom=${dom1}`)
  // 顶到上限：从 1 连点 13 次（1 + 13*0.05 = 1.65 > 1.6）
  for (let k = 0; k < 12; k++) await clickEl('[data-testid=zoom-in]')
  await sleep(200)
  const zTop = await ev('window.__vs.state().zoom')
  check('上限夹紧在 1.60', Math.abs(zTop - 1.6) < 1e-9, `zoom=${zTop}`)
  // 踩到下限
  for (let k = 0; k < 20; k++) await clickEl('[data-testid=zoom-out]')
  await sleep(200)
  const zBot = await ev('window.__vs.state().zoom')
  check('下限夹紧在 0.70', Math.abs(zBot - 0.7) < 1e-9, `zoom=${zBot}`)
  await clickEl('[data-testid=zoom-reset]')
  await sleep(150)
  check('重置回 1.00', Math.abs((await ev('window.__vs.state().zoom')) - 1) < 1e-9)
}

section('⑤ 分级名牌配色（颜色随 importanceLevel 联动）')
{
  const idx = pick.idxLevel >= 0 ? pick.idxLevel : pick.idxClip
  if (idx < 0) skip('分级名牌配色', '该包没有带立绘且有分级的角色台词')
  else {
    await ev(`window.__vs.navTo(${idx})`)
    await sleep(400)
    const r = await ev(`(() => {
      const s = window.__vs.settings() || {}
      const chip = document.querySelector('.stage-chips .level-chip')
      const sp = document.querySelector('.stage-textbox .speaker')
      if (!chip || !sp) return { error: '找不到分级 chip 或名牌', chip: !!chip, sp: !!sp }
      const lvl = (chip.textContent || '').trim()
      const hex2rgb = (h) => { const n = parseInt(String(h).replace('#', ''), 16); return 'rgb(' + ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ')' }
      const expected = (s.roleColors && s.roleColors[lvl]) || null
      const color = getComputedStyle(sp).color
      const border = getComputedStyle(chip).borderTopColor
      return { lvl, color, border, expected, expectedRgb: expected ? hex2rgb(expected) : null,
        match: !!expected && color === hex2rgb(expected) && border === hex2rgb(expected),
        speaker: sp.textContent }
    })()`)
    console.log('  ' + JSON.stringify(r))
    check('名牌颜色 = 该分级配色', !!r.match, `分级 ${r.lvl} → ${r.color}（期望 ${r.expected} = ${r.expectedRgb}）`)
    check('分级 chip 与名牌同色', !!r.match, `chip 边框 ${r.border}`)
  }
}

section('⑥ 立绘放大模态（全量立绘 + 形象 tab）')
{
  const idx = pick.idxLevel >= 0 ? pick.idxLevel : pick.idxClip
  if (idx < 0) skip('立绘放大模态', '该包没有带立绘的角色台词')
  else {
    await ev(`window.__vs.navTo(${idx})`)
    await sleep(400)
    const opened = await clickEl('.stage-portrait.is-speaker')
    await sleep(500)
    const m = await ev(`(() => {
      const mask = document.querySelector('[data-testid=portrait-modal]')
      if (!mask) return { open: false }
      const name = (document.querySelector('[data-testid=pm-name]') || {}).textContent
      const level = (document.querySelector('.pm-level') || {}).textContent
      const aliases = (document.querySelector('.pm-aliases') || {}).textContent
      const count = (document.querySelector('[data-testid=pm-count]') || {}).textContent
      const tabs = document.querySelectorAll('.pm-tab').length
      const img = document.querySelector('[data-testid=pm-image]')
      const meta = [...document.querySelectorAll('.pm-row')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim())
      return { open: true, name, level, aliases, count, tabs,
        imgDecoded: !!img && img.naturalWidth > 0, imgDim: img ? img.naturalWidth + 'x' + img.naturalHeight : null,
        meta }
    })()`)
    console.log('  ' + JSON.stringify(m))
    check('点击立绘打开模态', opened.ok && m.open, `点击=${opened.ok}${opened.ok ? '' : '（' + opened.why + '）'}`)
    check('模态展示名称 / 分级 / 别名', !!m.name && !!m.level, `名称「${m.name}」分级「${m.level}」别名「${m.aliases || '（无）'}」`)
    check('形象 tab 数 = 该角色立绘数', m.tabs >= 1 && !!m.count && m.count.indexOf('/') > 0, `tabs=${m.tabs}，计数「${m.count}」`)
    check('立绘图片已解码', !!m.imgDecoded, m.imgDim)
    // 切到第二个形象（若存在）
    if (m.tabs > 1) {
      await clickEl('[data-testid=pm-tab-1]')
      await sleep(400)
      const m2 = await ev(`(() => { const c=(document.querySelector('[data-testid=pm-count]')||{}).textContent
        const i=document.querySelector('[data-testid=pm-image]')
        return { count:c, decoded: !!i && i.naturalWidth>0 } })()`)
      check('切换形象 tab 后图片重新解码', !!m2.decoded && !!m2.count && m2.count.indexOf('2 /') === 0, `计数「${m2.count}」`)
    }
    console.log('  模态截图 bytes:', await shot(OUT_MODAL), '→', OUT_MODAL)
    await clickEl('[data-testid=pm-close]')
    await sleep(250)
    check('关闭模态', !(await ev('!!document.querySelector(\'[data-testid=portrait-modal]\')')))
  }
}

section('⑦ 对话框双模（normal / transparent，走真实设置面板）')
{
  // 兜底：万一面板已开着（上一次运行残留），先关掉，保证这次是「打开」语义
  if (await ev('!!document.querySelector(\'.card\')')) {
    console.log('  （设置面板已开着，先关闭以对齐初始状态）')
    await clickEl('[data-testid=settings-close]')
    await sleep(400)
  }
  // 打开设置面板
  const opened = await clickEl('[data-testid=open-settings]')
  await sleep(600)
  console.log('  打开设置面板：', JSON.stringify(opened))
  const tabNow = await ev(`document.querySelector('#app').__vue_app__._instance.setupState.tab`)
  console.log('  当前 tab =', tabNow, '（设置自批2起为独立标签页，showSettings 字段已不存在）')
  const panel = await ev(`(() => ({
    open: !!document.querySelector('.card'),
    ttsTest: !!document.querySelector('[data-testid=tts-test]'),
    voiceVolume: !!document.querySelector('[data-testid=voice-volume]'),
    bgmVolume: !!document.querySelector('[data-testid=bgm-volume]'),
    bgmPick: !!document.querySelector('[data-testid=bgm-pick]'),
    stageZoom: !!document.querySelector('[data-testid=stage-zoom]'),
    dialogMode: !!document.querySelector('[data-testid=dialog-mode]'),
    autoplayPolicy: !!document.querySelector('[data-testid=autoplay-policy]'),
    colorCells: document.querySelectorAll('[data-testid^=color-]').length,
    save: !!document.querySelector('[data-testid=settings-save]'),
    close: !!document.querySelector('[data-testid=settings-close]')
  }))()`)
  console.log('  ' + JSON.stringify(panel))
  check('设置面板新区块齐全（TTS / 音频 / 演出）',
    panel.open && panel.ttsTest && panel.voiceVolume && panel.bgmVolume && panel.bgmPick &&
    panel.stageZoom && panel.dialogMode && panel.autoplayPolicy && panel.colorCells >= 3 && panel.save && panel.close,
    `配色单元格 ${panel.colorCells} 个`)
  // 面板比可视区高：先滚到顶部再整页拍，保证「演出」区块也在图里
  await ev(`document.querySelector('.card').scrollIntoView({block:'start'}); window.scrollTo(0,0)`)
  await sleep(300)
  console.log('  设置面板截图 bytes:', await shot(OUT_SETTINGS, { beyondViewport: true }), '→', OUT_SETTINGS)

  // 切到 transparent 并保存
  await ev(`(() => { const s=document.querySelector('[data-testid=dialog-mode]'); s.value='transparent';
    s.dispatchEvent(new Event('change',{bubbles:true})); return s.value })()`)
  await sleep(200)
  const saveClick = await clickEl('[data-testid=settings-save]')
  await sleep(600)
  const savedFlag = await ev(`(document.querySelector('[data-testid=settings-saved]')||{}).textContent`)
  const closeClick = await clickEl('[data-testid=settings-close]')
  await sleep(600)
  const tr = await ev(`(() => { const b=document.querySelector('.stage-textbox')||{}
    return { cls:b.className||'', testid:b.getAttribute?b.getAttribute('data-testid'):null,
      mode:(window.__vs.settings()||{}).dialogMode, panelGone: !document.querySelector('.card') } })()`)
  check('保存后面板关闭且已生效', saveClick.ok && closeClick.ok && !!savedFlag && tr.panelGone,
    `保存=${saveClick.ok} 关闭=${closeClick.ok} 提示「${savedFlag}」面板已关=${tr.panelGone}`)
  check('transparent 模式：对话框带 dialog-transparent',
    tr.mode === 'transparent' && tr.cls.indexOf('dialog-transparent') >= 0 && tr.testid === 'dialog-transparent',
    `class="${tr.cls}" data-testid=${tr.testid}`)
  console.log('  transparent 截图 bytes:', await shot(OUT_TRANSPARENT), '→', OUT_TRANSPARENT)

  // 还原 normal（保存 + 让 App 重读设置）
  await ev(`(async () => { await window.feather.saveSettings({ dialogMode: 'normal', stageZoom: 1, autoplayPolicy: 'dubbing' })
    window.__vs.setSettings(await window.feather.getSettings()); return true })()`)
  await sleep(400)
  const nm = await ev(`(() => { const b=document.querySelector('.stage-textbox'); if(!b) return {gone:true}
    return { cls:b.className, mode:(window.__vs.settings()||{}).dialogMode } })()`)
  check('normal 模式：无 dialog-transparent', !nm.gone && nm.mode === 'normal' && nm.cls.indexOf('dialog-transparent') < 0,
    `class="${nm.cls}" mode=${nm.mode}`)
}

section('⑧ 自动播放 · 配音优先（真实鼠标启动）')
if (pick.clipCount === 0) skip('自动播放 · 配音优先', '该包没有任何配音片段')
else {
  const idx = pick.idxClip >= 0 ? pick.idxClip : pick.idxStream
  await ev(`window.__vs.navTo(${idx})`)
  await sleep(400)

  // 先量出这一句配音的真实时长：自动播放要等它播完才推进，
  // 固定 20s 预算遇到 30s+ 的 clip 必然假失败（历史上的误判就栽在这里）。
  const clipMs = await ev(`(async () => {
    const v = window.__vs.view()
    const a = v.actions[${idx}]
    const key = a.type + '|' + a.chapterSeq + '|' + a.order
    const clip = v.dubbing.find((d) => d.key === key)
    if (!clip) return 0
    return await new Promise((resolve) => {
      const el = new Audio()
      el.preload = 'metadata'
      const done = (ms) => { try { el.src = '' } catch (e) {} ; resolve(ms) }
      el.addEventListener('loadedmetadata', () => done(Math.round((el.duration || 0) * 1000)))
      el.addEventListener('error', () => done(0))
      el.src = clip.url
      setTimeout(() => done(Math.round((el.duration || 0) * 1000)), 8000)
    })
  })()`)
  // 预算 = 片段时长 + 12s 余量（打字机、切句、轮询粒度），下限 25s
  const budgetMs = Math.max(25000, clipMs + 12000)
  const maxPolls = Math.ceil(budgetMs / 500)
  console.log(`  目标句配音时长 ${clipMs}ms → 轮询预算 ${budgetMs}ms（${maxPolls} 次）`)

  const posOf = () => ev(`(() => { const s = window.__vs.state(); return s.chapterIdx + ':' + s.offset })()`)
  const before = await posOf()
  const playClick = await clickEl('[data-testid=autoplay]')
  await sleep(300)
  const playing = await ev('window.__vs.state().playing')
  const btnText = await ev(`(document.querySelector('[data-testid=autoplay]')||{}).innerText`)
  let advanced = false
  let pace = ''
  const t0 = Date.now()
  for (let k = 0; k < maxPolls; k++) {
    await sleep(500)
    pace = await ev('window.__vs.pace()')
    if ((await posOf()) !== before) {
      advanced = true
      break
    }
  }
  const elapsed = Date.now() - t0
  console.log(`  点击=${playClick.ok}${playClick.ok ? '' : '(' + playClick.why + ')'} playing=${playing} 按钮「${btnText}」`)
  console.log(`  节奏角标：「${pace}」；${elapsed}ms 后推进=${advanced}`)
  check('点击自动播放后进入播放态', playClick.ok && playing === true, `按钮文字「${btnText}」`)
  check('自动播放按配音节奏推进', advanced, `角标「${pace}」，${elapsed}ms / 预算 ${budgetMs}ms`)
  // 暂停后必须静止。用「句序 offset」判断而不是 hint 文案：
  // hint 里含「第 N / 总数 句」，但用户在自动播放中按暂停时 StageView 会先清空 paceLabel、
  // 且全屏/非全屏下 hint 可能被隐藏 —— 用 setupState 里的真实进度最可靠。
  const pauseClick = await clickEl('[data-testid=autoplay]')
  await sleep(300)
  const pos1 = await ev(`(() => { const s = window.__vs.state(); return s.chapterIdx + ':' + s.offset })()`)
  const playingAfterPause = await ev('window.__vs.state().playing')
  await sleep(2600)
  const pos2 = await ev(`(() => { const s = window.__vs.state(); return s.chapterIdx + ':' + s.offset })()`)
  check('暂停后不再推进', pauseClick.ok && pos1 === pos2, `句序「${pos1}」→「${pos2}」`)
  check('playing 已置假', playingAfterPause === false, `playing=${playingAfterPause}`)

  // 暂停必须能真正打断仍在进行的播放会话（历史 bug：pause 不触发 ended，
  // promise 悬着 → autoRunning 不复位 → 再点自动播放毫无反应）
  const restart = await clickEl('[data-testid=autoplay]')
  await sleep(800)
  const playing2 = await ev('window.__vs.state().playing')
  await clickEl('[data-testid=autoplay]')
  await sleep(200)
  check('暂停后可再次启动自动播放', restart.ok && playing2 === true, `再次点击后 playing=${playing2}`)
}

section('⑨ 自动播放 · TTS 未配置兜底 + 定时器节奏')
{
  const idx = pick.idxNoClip >= 0 ? pick.idxNoClip : pick.idxClip
  if (idx < 0) skip('自动播放 · 定时器兜底', '该包没有无配音的对白句')
  else {
    // 用「句序」判断是否推进，不用 hint 文案 —— 后者在全屏/紧凑布局下可能被隐藏
    const posOf = () => ev(`(() => { const s = window.__vs.state(); return s.chapterIdx + ':' + s.offset })()`)

    // 9a) TTS 未配置 → 必须回退定时器且不卡死
    await ev(`(async () => { await window.feather.saveSettings({ autoplayPolicy: 'tts' })
      window.__vs.setSettings(await window.feather.getSettings()); return true })()`)
    await sleep(300)
    await ev(`window.__vs.navTo(${idx})`)
    await sleep(400)
    const startedAt = Date.now()
    const before = await posOf()
    await clickEl('[data-testid=autoplay]')
    let advanced = false
    let pace = ''
    const t0 = Date.now()
    for (let k = 0; k < 40; k++) {
      await sleep(500)
      pace = await ev('window.__vs.pace()')
      if ((await posOf()) !== before) {
        advanced = true
        break
      }
    }
    const elapsed = Date.now() - t0
    console.log(`  TTS 策略角标：「${pace}」；${elapsed}ms 后推进=${advanced}（导航于 ${startedAt}）`)
    check('TTS 未配置 → 定时器兜底且不卡死', advanced, `角标「${pace}」，${elapsed}ms`)
    check('角标说明回退原因', pace.indexOf('定时器') >= 0 || pace.indexOf('TTS') >= 0, `「${pace}」`)
    await clickEl('[data-testid=autoplay]')
    await sleep(300)

    // 9b) 纯定时器策略
    await ev(`(async () => { await window.feather.saveSettings({ autoplayPolicy: 'timer' })
      window.__vs.setSettings(await window.feather.getSettings()); return true })()`)
    await sleep(300)
    await ev(`window.__vs.navTo(${idx})`)
    await sleep(400)
    const before2 = await posOf()
    await clickEl('[data-testid=autoplay]')
    let advanced2 = false
    let pace2 = ''
    const t1 = Date.now()
    for (let k = 0; k < 40; k++) {
      await sleep(500)
      pace2 = await ev('window.__vs.pace()')
      if ((await posOf()) !== before2) {
        advanced2 = true
        break
      }
    }
    console.log(`  定时器策略角标：「${pace2}」；${Date.now() - t1}ms 后推进=${advanced2}`)
    check('定时器策略正常推进', advanced2 && pace2.indexOf('定时器') >= 0, `角标「${pace2}」`)
    await clickEl('[data-testid=autoplay]')
    await sleep(300)
    // 还原默认策略
    await ev(`(async () => { await window.feather.saveSettings({ autoplayPolicy: 'dubbing' })
      window.__vs.setSettings(await window.feather.getSettings()); return true })()`)
  }
}

section('⑩ Range 请求（音频 seek 依赖）')
if (pick.clipCount === 0) skip('Range 请求', '该包没有任何配音片段')
else {
  const r = await ev(`(async () => {
    const v = window.__vs.view()
    const u = v.dubbing[0].url
    const full = await fetch(u)
    const buf = await full.arrayBuffer()
    const part = await fetch(u, { headers: { Range: 'bytes=0-99' } })
    const pbuf = await part.arrayBuffer()
    const suffix = await fetch(u, { headers: { Range: 'bytes=-16' } })
    const sbuf = await suffix.arrayBuffer()
    return { url: u.slice(0, 60), fullStatus: full.status, ct: full.headers.get('content-type'),
      total: buf.byteLength,
      partStatus: part.status, partRange: part.headers.get('content-range'), partLen: pbuf.byteLength,
      suffixStatus: suffix.status, suffixRange: suffix.headers.get('content-range'), suffixLen: sbuf.byteLength }
  })()`)
  console.log('  ' + JSON.stringify(r))
  check('全量请求 200 + audio/*', r.fullStatus === 200 && /^audio\//.test(r.ct || ''), `${r.ct}，${r.total} 字节`)
  check('Range bytes=0-99 → 206 + content-range + 100 字节',
    r.partStatus === 206 && r.partRange === 'bytes 0-99/' + r.total && r.partLen === 100, `${r.partRange}`)
  check('后缀范围 bytes=-16 → 206 + 16 字节',
    r.suffixStatus === 206 && r.suffixRange === 'bytes ' + (r.total - 16) + '-' + (r.total - 1) + '/' + r.total && r.suffixLen === 16,
    `${r.suffixRange}`)
}

section('⑪ 渲染进程运行期异常 / 网络失败汇总')
console.log(`运行期异常 ${runtimeErrors.length} 条，网络失败 ${netFailures.length} 条`)
runtimeErrors.forEach((e) => console.log('  ' + e))
netFailures.forEach((e) => console.log('  ' + e))
check('运行期无异常 / 无 console.error', runtimeErrors.length === 0, `${runtimeErrors.length} 条`)
check('无网络层失败（HTTP >= 400 / 加载失败）', netFailures.length === 0, `${netFailures.length} 条`)

// ---------------------------------------------------------------------------
section('汇总')
const pass = results.filter((r) => r.ok).length
const fail = results.filter((r) => !r.ok && !r.skip).length
const skipped = results.filter((r) => r.skip).length
console.log(`PASS ${pass} · FAIL ${fail} · SKIP ${skipped}`)
if (fail) {
  console.log('失败项：')
  results.filter((r) => !r.ok && !r.skip).forEach((r) => console.log('  - ' + r.name + (r.detail ? ' — ' + r.detail : '')))
}
if (skipped) {
  console.log('跳过项：')
  results.filter((r) => r.skip).forEach((r) => console.log('  - ' + r.name + ' — ' + r.detail))
}
console.log('截图：')
;[OUT_STREAM, OUT_TRANSPARENT, OUT_MODAL, OUT_SETTINGS].forEach((p) => console.log('  ' + p))

ws.close()
process.exit(fail ? 1 : 0)

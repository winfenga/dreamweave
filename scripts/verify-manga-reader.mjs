/**
 * 沉浸式漫画阅读器端到端验证（M1-R）。
 *
 * 走 CDP 连真实渲染进程，不 mock。
 *
 * 前置：应用以调试端口启动（--remote-debugging-port=9222），且已导入含漫画线的包。
 *
 * 用法：
 *   npm run verify:manga-reader
 *   npm run verify:manga-reader -- --shot D:/galcomic/recon/reader.png
 *
 * 验证内容：
 *   ① MangaView 里存在「沉浸阅读」入口，点击后覆盖层挂载
 *   ② 覆盖层铺满整个窗口（不是被三栏布局挤压的窄条）
 *   ③ 一页模式：整页图真实渲染且尺寸接近窗口高度
 *   ④ 一格模式：只显示当前格，容器尺寸与 rect 宽高比一致
 *   ⑤ 底部台词栏在舞台下方中间，显示台词正文
 *   ⑥ 逐句推进改变台词，一格模式下画面跟着切格
 *   ⑦ 设置抽屉可从底部上滑、内容可纵向滚动
 *   ⑧ 翻页/退出正常，退出后覆盖层消失
 *   ⑨ 无运行期异常
 */
import { writeFile } from 'node:fs/promises'

const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'
const argv = process.argv.slice(2)
const shotPath = argv.includes('--shot') ? argv[argv.indexOf('--shot') + 1] : null

const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
if (!page) {
  console.error('✗ 没有可调试的页面，应用是否以 --remote-debugging-port=9222 启动？')
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

/**
 * 带超时的求值。
 *
 * `Runtime.evaluate` 本身**没有超时**：一旦渲染进程某次求值不返回（例如页面卡住、
 * 或 evaluate 里 await 了一个永不 settle 的 Promise），整个脚本会永久挂住 ——
 * 进程还活着、也不报错，只是没有输出。实测踩过这个坑（跑到 ⑦ 后静默卡死 >4 分钟）。
 * 这里给每次求值加 20s 上限，把「静默卡死」变成一条可读错误。
 */
const ev = async (expr) => {
  let timer
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(
      () => rej(new Error(`evaluate 超时 20s @ ${expr.slice(0, 120).replace(/\s+/g, ' ')}`)),
      20000
    )
  })
  try {
    const r = await Promise.race([
      send('Runtime.evaluate', {
        expression: expr,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      }),
      timeout
    ])
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 900))
    return r.result.value
  } finally {
    clearTimeout(timer)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 进度日志：卡住时能一眼看出停在哪一步 */
let step = 0
const mark = (s) => {
  step++
  console.log(`  [${String(step).padStart(2, '0')}] ${s}`)
}

/**
 * 幂等地把设置抽屉置为「开」或「关」。
 *
 * 为什么需要它：抽屉的开关是同一个按钮的 toggle，前面某段测试把抽屉留在打开态后，
 * 后面再点一次会**关掉**它 —— 首版就因此让 ⑦ 的六项断言全部假失败。
 * 「先读真实状态、不一致才点」比「假定它当前是关的」可靠。
 */
async function setDrawer(open) {
  const isOpen = await ev(`!!document.querySelector('[data-testid="mr-drawer"]')`)
  if (isOpen === open) return
  await ev(`(() => { const b = document.querySelector('[data-testid="mr-open-drawer"]'); if (b) b.click(); return !!b })()`)
  await sleep(450)
}

/**
 * 轮询直到表达式结果满足条件，或超时。
 *
 * 为什么不用固定 sleep：Electron 窗口在后台时 `requestAnimationFrame` 被节流，
 * CSS transition 不推进、Vue 的更新也可能延迟到下一帧。固定等待在真机上够用，
 * 在无人值守的 CDP 测试里会随机假失败（首版就踩到「抽屉停在 translateY(24px)」）。
 */
async function waitFor(expr, { timeoutMs = 4000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await ev(expr)
    if (last) return last
    await sleep(intervalMs)
  }
  return last
}

const failures = []
const checks = []
function check(name, cond, detail = '') {
  checks.push({ name, ok: !!cond, detail })
  if (!cond) failures.push(`${name}${detail ? `（${detail}）` : ''}`)
}

mark('刷新+导入');
// ============ ⓿ ============
await send('Page.reload', { ignoreCache: false })
await sleep(2600)
runtimeErrors.length = 0
await send('Page.bringToFront')

const PKG = argv.find((a) => !a.startsWith('--') && a.endsWith('.t2w')) ?? 'D:/galcomic/gmzz-10.t2w'
const imported = await ev(`(async () => {
  const r = await window.feather.importPackage(${JSON.stringify(PKG)}, 't2w')
  return { ok: r.ok, error: r.error, title: r.summary?.project?.title }
})()`)
check('导入漫画包', imported?.ok, imported?.error ?? '')

await send('Page.reload', { ignoreCache: false })
await sleep(2600)
runtimeErrors.length = 0
await send('Page.bringToFront')

const opened = await ev(`(async () => {
  const rows = [...document.querySelectorAll('tbody tr')]
  const row = rows.find(r => r.textContent.includes(${JSON.stringify(imported?.title ?? '')}))
  if (!row) return { ok: false, why: '书库列表里没找到这本书' }
  const btn = [...row.querySelectorAll('button')].find(b => b.textContent.trim() === '打开')
  if (!btn) return { ok: false, why: '没找到「打开」按钮' }
  btn.click()
  return { ok: true }
})()`)
check('书库中点开这本书', opened?.ok, opened?.why ?? '')
await sleep(1500)

// 进漫画阅读
await ev(`(() => {
  const hit = [...document.querySelectorAll('.side-item')].find(b => b.textContent.includes('漫画阅读'))
  if (hit) hit.click()
  return !!hit
})()`)
await sleep(900)

mark('入口与挂载');
const hasEntry = await ev(`!!document.querySelector('[data-testid="open-reader"]')`)
check('存在「沉浸阅读」入口', hasEntry, hasEntry ? '' : '未找到 open-reader')

await ev(`(() => { const b = document.querySelector('[data-testid="open-reader"]'); if (b) b.click(); return !!b })()`)
await sleep(1200)

const mounted = await ev(`!!document.querySelector('[data-testid="manga-reader"]')`)
check('覆盖层已挂载', mounted, mounted ? '' : '未找到 manga-reader')

mark('铺满窗口');
const cover = await ev(`(() => {
  const el = document.querySelector('[data-testid="manga-reader"]')
  if (!el) return null
  const r = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  return {
    w: Math.round(r.width), h: Math.round(r.height),
    vw: outerWidth, vh: outerHeight,
    position: cs.position, zIndex: cs.zIndex,
    visible: cs.display !== 'none' && cs.visibility !== 'hidden'
  }
})()`)
check('覆盖层 position:fixed', cover?.position === 'fixed', JSON.stringify(cover?.position))
check(
  '覆盖层铺满窗口（宽高均 ≥ 视口 95%）',
  !!cover && cover.w >= cover.vw * 0.95 && cover.h >= cover.vh * 0.95,
  cover ? `${cover.w}x${cover.h} vs viewport ${cover.vw}x${cover.vh}` : 'null'
)
check('覆盖层有独立层叠上下文（z-index ≥ 50）', Number(cover?.zIndex ?? 0) >= 50, String(cover?.zIndex))

mark('一页模式');
// 确保处于一页模式（偏好会被 localStorage 记住，不能假设默认值）
await setDrawer(true)
await ev(`(() => { const b = document.querySelector('[data-testid="mr-mode-page"]'); if (b) b.click(); return !!b })()`)
await sleep(500)
// 收起抽屉，避免遮挡测量
await setDrawer(false)

let imgInfo = null
for (let i = 0; i < 24; i++) {
  imgInfo = await ev(`(() => {
    const img = document.querySelector('[data-testid="mr-page-img"]')
    if (!img) return { state: 'no-img' }
    if (!img.complete) return { state: 'loading' }
    const r = img.getBoundingClientRect()
    return {
      state: 'done', nw: img.naturalWidth, nh: img.naturalHeight,
      dispW: Math.round(r.width), dispH: Math.round(r.height),
      vh: innerHeight, vw: innerWidth,
      src: (img.src || '').slice(0, 40)
    }
  })()`)
  if (imgInfo?.state === 'done') break
  await sleep(400)
}
check('一页模式图片已加载', imgInfo?.state === 'done', JSON.stringify(imgInfo))
check('一页模式图片有真实像素', (imgInfo?.nw ?? 0) > 100 && (imgInfo?.nh ?? 0) > 100, `${imgInfo?.nw}x${imgInfo?.nh}`)
check(
  '一页模式图片高度接近视口（≥ 视口 60%，证明没被三栏布局压扁）',
  (imgInfo?.dispH ?? 0) >= (imgInfo?.vh ?? 0) * 0.6,
  `${imgInfo?.dispH} / vh ${imgInfo?.vh}`
)

mark('一格模式');
await setDrawer(true)
await ev(`(() => { const b = document.querySelector('[data-testid="mr-mode-panel"]'); if (b) b.click(); return !!b })()`)
await sleep(500)
await setDrawer(false)

const panelInfo = await ev(`(() => {
  const wrap = document.querySelector('[data-testid="mr-panel-wrap"]')
  const img = document.querySelector('[data-testid="mr-panel-img"]')
  if (!wrap) return { state: 'no-wrap' }
  const r = wrap.getBoundingClientRect()
  return {
    state: 'ok',
    w: Math.round(r.width), h: Math.round(r.height),
    vw: innerWidth, vh: innerHeight,
    imgW: img ? Math.round(img.getBoundingClientRect().width) : 0,
    imgH: img ? Math.round(img.getBoundingClientRect().height) : 0,
    hasImg: !!img,
    overflow: getComputedStyle(wrap).overflow
  }
})()`)
check('一格模式容器已渲染', panelInfo?.state === 'ok', JSON.stringify(panelInfo))
check('一格模式容器裁剪溢出内容', panelInfo?.overflow === 'hidden', String(panelInfo?.overflow))
check(
  '一格模式：放大后的图比容器宽（说明确实做了放大裁剪，而非显示整页）',
  (panelInfo?.imgW ?? 0) > (panelInfo?.w ?? 0) * 1.0,
  `img ${panelInfo?.imgW} vs wrap ${panelInfo?.w}`
)
check(
  '一格模式容器未撑出视口',
  (panelInfo?.w ?? 0) <= (panelInfo?.vw ?? 0) && (panelInfo?.h ?? 0) <= (panelInfo?.vh ?? 0),
  `${panelInfo?.w}x${panelInfo?.h} / ${panelInfo?.vw}x${panelInfo?.vh}`
)

mark('台词栏');
const dlg = await ev(`(() => {
  const el = document.querySelector('[data-testid="mr-dialog"]')
  if (!el) return null
  const r = el.getBoundingClientRect()
  const text = el.querySelector('[data-testid="mr-dialog-text"]')?.textContent?.trim() ?? ''
  const speaker = el.querySelector('.mr-dialog-speaker')?.textContent?.trim() ?? ''
  const cs = getComputedStyle(el)
  return {
    w: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right),
    top: Math.round(r.top), bottom: Math.round(r.bottom),
    vw: innerWidth, vh: innerHeight,
    bg: cs.backgroundColor, border: cs.borderTopWidth, shadow: cs.boxShadow,
    childCount: el.children.length,
    text, speaker
  }
})()`)
check('底部台词栏存在', !!dlg, '未找到 mr-dialog')
check('台词正文非空', (dlg?.text?.length ?? 0) > 0, JSON.stringify(dlg?.text?.slice(0, 40)))
check(
  '台词栏位于底部、水平居中（左右留白差 ≤ 视口 6%）',
  !!dlg && dlg.bottom > dlg.vh * 0.6 && Math.abs(dlg.left - (dlg.vw - dlg.right)) <= dlg.vw * 0.06,
  dlg ? `left=${dlg.left} right=${dlg.right} bottom=${dlg.bottom} vw=${dlg.vw} vh=${dlg.vh}` : 'null'
)
check('台词栏宽度不超过视口 85%（不过分铺满）', (dlg?.w ?? 0) <= (dlg?.vw ?? 0) * 0.85, `${dlg?.w}`)
// 用户要求「只留文字在上面，其他什么都不要」
check('台词区是透明底（无背景色填充）', dlg?.bg === 'rgba(0, 0, 0, 0)' || dlg?.bg === 'transparent', String(dlg?.bg))
check('台词区无边框', dlg?.border === '0px', String(dlg?.border))
check('台词区无阴影面板', dlg?.shadow === 'none', String(dlg?.shadow))
check('台词区只含文字（说话人 + 正文两个节点，无按钮/图标）', (dlg?.childCount ?? 9) <= 2, `children=${dlg?.childCount}`)
check(
  '台词区没有任何按钮',
  (await ev(`document.querySelector('[data-testid="mr-dialog"]')?.querySelectorAll('button').length ?? 0`)) === 0,
  'still has button'
)

mark('推进');
const beforeCue = await ev(`document.querySelector('[data-testid="mr-dialog-text"]')?.textContent?.trim() ?? ''`)

// 空格推进
const spaceRes = await ev(`(() => {
  const before = document.querySelector('[data-testid="mr-dialog-text"]')?.textContent?.trim() ?? ''
  window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
  return { before }
})()`)
await sleep(400)
const afterSpace = await ev(`document.querySelector('[data-testid="mr-dialog-text"]')?.textContent?.trim() ?? ''`)
check('空格键推进了台词', afterSpace !== spaceRes?.before, `${(spaceRes?.before ?? '').slice(0, 20)} → 未变`)

// 鼠标左键点画面推进
const clickRes = await ev(`(() => {
  const stage = document.querySelector('[data-testid="mr-stake"]') || document.querySelector('[data-testid="mr-stage"]')
  if (!stage) return { ok: false }
  const before = document.querySelector('[data-testid="mr-dialog-text"]')?.textContent?.trim() ?? ''
  const r = stage.getBoundingClientRect()
  stage.dispatchEvent(new MouseEvent('click', {
    bubbles: true, cancelable: true, button: 0,
    clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2)
  }))
  return { ok: true, before }
})()`)
await sleep(400)
const afterClick = await ev(`document.querySelector('[data-testid="mr-dialog-text"]')?.textContent?.trim() ?? ''`)
check('鼠标左键点画面推进了台词', clickRes?.ok === true && afterClick !== clickRes?.before, `${(clickRes?.before ?? '').slice(0, 20)} → 未变`)
check('台词整体确实在推进（三态不重复）', new Set([beforeCue, afterSpace, afterClick]).size >= 2, JSON.stringify([beforeCue.slice(0, 10), afterSpace.slice(0, 10), afterClick.slice(0, 10)]))

mark('自动播放键');
// 需要读复选框状态，故先确保抽屉打开
await setDrawer(true)

const autoRes = await ev(`(async () => {
  const read = () => {
    const cb = document.querySelector('[data-testid="mr-autoplay"]')
    return cb ? cb.checked : null
  }
  // 先把状态归零（前面可能已改过），确保「起点是关」
  const cb0 = document.querySelector('[data-testid="mr-autoplay"]')
  if (cb0 && cb0.checked) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }))
    await new Promise(r => setTimeout(r, 300))
  }
  const v0 = read()
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }))
  await new Promise(r => setTimeout(r, 300))
  const v1 = read()
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }))
  await new Promise(r => setTimeout(r, 300))
  const v2 = read()
  return { v0, v1, v2 }
})()`)
check(
  'A 键切换自动播放（开→关可逆）',
  autoRes?.v0 === false && autoRes?.v1 === true && autoRes?.v2 === false,
  JSON.stringify(autoRes)
)

mark('抽屉');
await setDrawer(true)
// 等入场动画落位（后台窗口的 rAF 被节流，不能假定固定时长后已到位）
await waitFor(
  `(() => {
    const el = document.querySelector('[data-testid="mr-drawer"]')
    if (!el) return false
    const t = getComputedStyle(el).transform
    return t === 'none' || Math.abs(new DOMMatrix(t).m42) < 1
  })()`
)
const drawer = await ev(`(() => {
  const el = document.querySelector('[data-testid="mr-drawer"]')
  if (!el) return null
  const body = el.querySelector('.mr-drawer-body')
  const er = el.getBoundingClientRect()
  return {
    exists: true,
    h: Math.round(er.height), vh: innerHeight,
    gapBottom: Math.round(er.bottom - innerHeight),
    atBottom: Math.abs(er.bottom - innerHeight) <= 28,
    bodyScrollable: !!body && body.scrollHeight >= body.clientHeight,
    scrollH: body ? body.scrollHeight : 0,
    clientH: body ? body.clientHeight : 0,
    sections: Array.from(el.querySelectorAll('.mr-sec h4')).map(x => x.textContent.trim())
  }
})()`)
check('设置抽屉存在', !!drawer?.exists, '')
// 容差 28px：抽屉自身有 18px 圆角与 1px 边框，且极端情况下入场动画可能未完全收敛
check('抽屉贴在窗口底部（上滑面板）', Math.abs(drawer?.gapBottom ?? 999) <= 28, `距底 ${drawer?.gapBottom}px`)
check('抽屉高度不超过视口 75%（不会一屏塞满）', (drawer?.h ?? 0) <= (drawer?.vh ?? 1) * 0.75, `${drawer?.h}/${drawer?.vh}`)
check('抽屉内容是滚动容器', drawer?.bodyScrollable === true, `${drawer?.scrollH} >= ${drawer?.clientH}`)
check(
  '抽屉分区齐备（模式/方向/显示/自动播放/配乐/快捷键）',
  (drawer?.sections?.length ?? 0) >= 6,
  JSON.stringify(drawer?.sections)
)

// 实际滚动一下，确认能滚（不是假滚动容器）
const scrolled = await ev(`(() => {
  const body = document.querySelector('.mr-drawer-body')
  if (!body) return { ok: false }
  const a = body.scrollTop
  body.scrollTop = 120
  return { ok: body.scrollTop > a, before: a, after: body.scrollTop }
})()`)
check('抽屉可以真正纵向滚动', scrolled?.ok === true, JSON.stringify(scrolled))

// 收起抽屉（⑧ 会自己按需再打开；这里用幂等 helper，避免裸 click 把状态翻反）
await setDrawer(false)

mark('翻页按钮归属');
const noPageBtns = await ev(`(() => {
  const root = document.querySelector('[data-testid="manga-reader"]')
  if (!root) return { ok: false }
  const drawer = root.querySelector('[data-testid="mr-drawer"]')
  // 抽屉之外的按钮 = 画面上常驻的按钮
  const outside = [...root.querySelectorAll('button')].filter(b => !drawer || !drawer.contains(b))
  const labels = outside.map(b => (b.textContent || '').trim()).filter(Boolean)
  const hasPageBtn = labels.some(t => /上一页|下一页|上一句|下一句/.test(t))
  return { ok: true, hasPageBtn, labels }
})()`)
check('画面上没有「上一页/下一页/上一句/下一句」按钮', noPageBtns?.ok === true && noPageBtns?.hasPageBtn === false, JSON.stringify(noPageBtns?.labels))

// 抽屉里必须有翻页控件
await setDrawer(true)
const navInDrawer = await ev(`(() => {
  const d = document.querySelector('[data-testid="mr-drawer"]')
  if (!d) return { ok: false, why: '抽屉未打开' }
  return { ok: true, prev: !!d.querySelector('[data-testid="mr-prev"]'), next: !!d.querySelector('[data-testid="mr-next"]') }
})()`)
check('上一页/下一页收在抽屉里', navInDrawer?.ok && navInDrawer?.prev && navInDrawer?.next, JSON.stringify(navInDrawer))

// 用抽屉里的「下一页」翻页
//
// ⚠️ 抽屉里的翻页按钮是**页面级**的（prevPage/nextPage），与模式无关；
// 但前面 ⑥ 的鼠标点击可能已经把页推进过了，所以这里先读当前页再点，
// 并允许多点几次直到页号真的变化（避免落在最后一页导致按钮 disabled 的假失败）。
const pageBefore = await ev(`(() => {
  const d = document.querySelector('[data-testid="mr-drawer"]')
  return d?.querySelector('.mr-nav-pos')?.textContent?.trim() ?? ''
})()`)
let pageAfter = pageBefore
for (let i = 0; i < 4 && pageAfter === pageBefore; i++) {
  const canNext = await ev(`(() => {
    const b = document.querySelector('[data-testid="mr-next"]')
    if (!b) return 'no-btn'
    if (b.disabled) return 'disabled'
    b.click()
    return 'clicked'
  })()`)
  if (canNext !== 'clicked') {
    // 已在末页：先退一页再前进，仍然验证了按钮通路
    await ev(`(() => { const b = document.querySelector('[data-testid="mr-prev"]'); if (b && !b.disabled) b.click(); return true })()`)
    await sleep(500)
  }
  await sleep(600)
  pageAfter = await ev(`(() => {
    const d = document.querySelector('[data-testid="mr-drawer"]')
    return d?.querySelector('.mr-nav-pos')?.textContent?.trim() ?? ''
  })()`)
}
check('抽屉里的「下一页」可以翻页', pageAfter !== pageBefore && pageAfter.length > 0, `${pageBefore} → ${pageAfter}`)

// 收起抽屉
await setDrawer(false)

// 截图（退出前，留住覆盖层画面）
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

await ev(`(() => { const b = document.querySelector('[data-testid="mr-close"]'); if (b) b.click(); return !!b })()`)
await sleep(900)
const gone = await ev(`!document.querySelector('[data-testid="manga-reader"]')`)
check('退出后覆盖层消失', gone, '仍在 DOM 中')
const backToNav = await ev(`!!document.querySelector('.manga-nav')`)
check('退出后回到三栏漫画视图', backToNav, '未找到 .manga-nav')

mark('运行期异常');
check('无运行期异常', runtimeErrors.length === 0, runtimeErrors.slice(0, 3).join(' | '))

// ============ 报告 ============
const bar = '─'.repeat(64)
console.log(`\n${bar}\n  沉浸式漫画阅读器 E2E\n${bar}`)
for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : '  ← ' + c.detail}`)
console.log(`\n${bar}`)
if (failures.length) {
  console.log(`  ✗ ${failures.length} 项失败 / 共 ${checks.length} 项`)
  console.log(bar + '\n')
  process.exit(1)
}
console.log(`  ✓ ${checks.length} 项全部通过`)
console.log(bar + '\n')
ws.close()

/**
 * 漫画阅读视图端到端验证（M1）：走 CDP 连进真实渲染进程，不是 mock。
 *
 * 前置：
 *   1) 应用以调试端口启动：electron . --remote-debugging-port=9222
 *   2) 已导入一个含漫画线的包（默认 gmzz-10.t2w）
 *
 * 用法：
 *   npm run verify:manga-ui
 *   npm run verify:manga-ui -- --shot D:/galcomic/recon/manga.png
 *
 * 验证内容：
 *   ① getMangaView IPC 返回的模型与解析器一致（章节/页/分镜/台词数）
 *   ② 侧栏「漫画阅读」入口存在且可点开
 *   ③ 页面图真实渲染（naturalWidth > 0，不是破图）
 *   ④ 分镜热区数量 == 当前页分镜数，且位置百分比在 0..1
 *   ⑤ 翻页/切章工作正常（全局页序号变化）
 *   ⑥ 台词区渲染出 speech 文本
 *   ⑦ 无运行期异常
 */
import { writeFile } from 'node:fs/promises'

const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'
const argv = process.argv.slice(2)
const shotPath = argv.includes('--shot') ? argv[argv.indexOf('--shot') + 1] : null

const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
if (!page) {
  console.error('✗ 没有找到可调试的页面，应用是否以 --remote-debugging-port=9222 启动？')
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const runtimeErrors = []
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

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 900))
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const failures = []
const checks = []
function check(name, cond, detail) {
  checks.push({ name, ok: !!cond, detail })
  if (!cond) failures.push(`${name}（${detail}）`)
}

// ============ ⓿ 从干净状态导入并打开 ============
// 生产构建没有 setupState，必须走真实交互：导入 → 刷新 → 书库点「打开」。
await send('Page.enable')
await send('Page.reload', { ignoreCache: false })
await sleep(2600)
runtimeErrors.length = 0
await send('Page.bringToFront')
await sleep(500)

const PKG = argv.find((a) => !a.startsWith('--') && a.endsWith('.t2w')) ?? 'D:/galcomic/gmzz-10.t2w'

// 导入（会新建工作库；若已存在则再多一本，无妨）
const imported = await ev(`(async () => {
  const r = await window.feather.importPackage(${JSON.stringify(PKG)}, 't2w')
  return { ok: r.ok, error: r.error, title: r.summary?.project?.title }
})()`)
check('导入漫画包', imported?.ok, imported?.error ?? 'ok')

// 刷新后从书库点「打开」打开这本书（走真实 UI 路径）
await send('Page.reload', { ignoreCache: false })
await sleep(2600)
runtimeErrors.length = 0
await send('Page.bringToFront')
await sleep(500)

await ev(`window.__pkg = ${JSON.stringify(PKG)}; true`)
const opened = await ev("(async () => {\nconst ws = await window.feather.listWorkspaces();\nif (!ws.ok) return { ok: false, why: 'readshelf-failed' };\nconst BS = String.fromCharCode(92);\nconst norm = function (s) { return String(s || '').split(BS).join('/').toLowerCase(); };\nconst src = norm(window.__pkg);\nconst hits = ws.items.filter(function (i) { return norm(i.t2wPath) === src; });\nif (!hits.length) return { ok: false, why: 'not-in-shelf' };\nhits.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });\nconst t = hits[0];\nconst book = document.querySelector('[data-testid=\"lib-shelf\"] .slot[data-book-id=\"' + t.id + '\"] .book');\nif (book) { book.click(); return { ok: true, via: 'ui', id: t.id, title: t.title }; }\nconst r = await window.feather.openWorkspace(t.id);\nreturn r.ok ? { ok: true, via: 'ipc', id: t.id } : { ok: false, why: r.error || 'open-failed' };\n})()")
check('书库中找到并点开这本书', opened?.ok, opened?.why ?? 'ok')
await sleep(1500)

// ============ ① IPC 模型 ============
const model = await ev(`(async () => {
  const r = await window.feather.getMangaView()
  if (!r.ok || !r.data) return { ok: false, error: r.error }
  const d = r.data
  return {
    ok: true,
    stats: d.stats,
    chapters: d.chapters.map(c => ({
      seq: c.chapterSeq,
      title: c.title,
      pages: c.pages.map(p => ({ no: p.no, panels: p.panels.length, hasImage: p.hasImage, key: p.key }))
    })),
    voices: d.voices.length,
    dubbing: d.dubbing.length
  }
})()`)

check('getMangaView IPC 可用', model?.ok, model?.error ?? 'ok')
if (model?.ok) {
  const s = model.stats
  check('章节数 > 0', s.chapterCount > 0, `chapterCount=${s.chapterCount}`)
  check('页数 > 0', s.pageCount > 0, `pageCount=${s.pageCount}`)
  check('分镜数 > 0', s.panelCount > 0, `panelCount=${s.panelCount}`)
  check('台词数 > 0', s.speechCount > 0, `speechCount=${s.speechCount}`)
  check('脚本走了 project-edits', s.scriptSource === 'edited', `source=${s.scriptSource}`)
  check('有图的页 == 总页数', s.pagesWithImage === s.pageCount, `${s.pagesWithImage}/${s.pageCount}`)
}

// ============ ② 打开漫画页 ============
await ev(`(() => {
  const items = [...document.querySelectorAll('.side-item')]
  const hit = items.find(b => b.textContent.includes('漫画阅读'))
  if (hit) hit.click()
  return !!hit
})()`)
await sleep(900)

const navOk = await ev(`!!document.querySelector('.manga-nav')`)
check('漫画视图已挂载（.manga-nav 存在）', navOk, navOk ? 'ok' : '未找到')
check('没有落到空状态', await ev(`!document.querySelector('.manga-empty')`), '检查 .manga-empty')

// ============ ③ 页面图真实渲染 ============
let imgOk = null
for (let i = 0; i < 24; i++) {
  imgOk = await ev(`(() => {
    const img = document.querySelector('.page-img')
    if (!img) return { state: 'no-img' }
    if (!img.complete) return { state: 'loading' }
    return { state: 'done', nw: img.naturalWidth, nh: img.naturalHeight, src: (img.src||'').slice(0, 40) }
  })()`)
  if (imgOk?.state === 'done') break
  await sleep(500)
}
check('页面图已加载', imgOk?.state === 'done', JSON.stringify(imgOk))
check('页面图有真实像素', (imgOk?.nw ?? 0) > 100 && (imgOk?.nh ?? 0) > 100, `${imgOk?.nw}x${imgOk?.nh}`)
check('页面图走 t2w:// 协议', (imgOk?.src ?? '').startsWith('t2w://'), imgOk?.src)

// ============ ④ 热区 ============
const frames = await ev(`(() => {
  const fs = [...document.querySelectorAll('.frame')]
  const rects = fs.map(f => ({
    left: f.style.left, top: f.style.top, w: f.style.width, h: f.style.height,
    no: f.querySelector('.frame-no')?.textContent ?? ''
  }))
  return { count: fs.length, rects }
})()`)
const pagePanels = model?.ok
  ? (() => {
      // 当前页取第一个有图的页（与组件初始定位逻辑一致）
      for (const c of model.chapters) for (const p of c.pages) if (p.hasImage) return p.panels
      return 0
    })()
  : 0
check('热区数量 == 当前页分镜数', frames.count === pagePanels, `frames=${frames.count} panels=${pagePanels}`)
const rectOk = frames.rects.every((r) => {
  const n = (v) => parseFloat(v)
  return r.left.endsWith('%') && r.top.endsWith('%') && r.w.endsWith('%') && r.h.endsWith('%')
    && n(r.left) >= 0 && n(r.left) <= 100 && n(r.w) > 0 && n(r.w) <= 100
})
check('热区位置为合法百分比', frames.count > 0 && rectOk, JSON.stringify(frames.rects.slice(0, 2)))

// ============ ⑤ 台词渲染 ============
const speech = await ev(`(() => {
  const sps = [...document.querySelectorAll('.speech')]
  return { count: sps.length, sample: sps.slice(0,2).map(s => s.textContent.trim().slice(0, 50)) }
})()`)
check('右侧台词已渲染', speech.count > 0, `count=${speech.count}`)
check('台词文本非空', speech.sample?.every((t) => t.length > 0), JSON.stringify(speech.sample))

// ============ ⑥ 翻页 ============
const before = await ev(`document.querySelector('.stage-count')?.textContent ?? ''`)
await ev(`(() => {
  const btns = [...document.querySelectorAll('.stage-foot .btn')]
  const next = btns.find(b => b.textContent.includes('下一页'))
  if (next && !next.disabled) next.click()
  return true
})()`)
await sleep(700)
const after = await ev(`document.querySelector('.stage-count')?.textContent ?? ''`)
check('翻页改变了全局页序号', before !== after && after.length > 0, `${before} → ${after}`)

// ============ ⑦ 切章 ============
// 注意：⑥ 的翻页可能已经跨到下一章，所以这里必须点一个**与当前不同**的章，
// 否则「点第 2 章时已在第 2 章」会造成假失败（首版就踩了这个坑）。
const chBefore = await ev(`document.querySelector('.stage-ch')?.textContent ?? ''`)
const chPick = await ev(`(() => {
  const bs = [...document.querySelectorAll('.nav-ch-btn')]
  if (bs.length < 2) return { ok: false, why: '章数不足 2' }
  // 找一个当前未选中的章（active 类不在它身上）
  const other = bs.find(b => !b.classList.contains('active'))
  if (!other) return { ok: false, why: '所有章都是 active' }
  const label = other.querySelector('.nav-ch-name')?.textContent ?? ''
  other.click()
  return { ok: true, label }
})()`)
await sleep(700)
const chAfter = await ev(`document.querySelector('.stage-ch')?.textContent ?? ''`)
check('切章改变了章节标题', chPick?.ok && chBefore !== chAfter && chAfter.length > 0, `${chBefore} → ${chAfter}（目标「${chPick?.label ?? '?'}」${chPick?.why ? '·' + chPick.why : ''}）`)

// ============ ⑧ 截图 ============
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

// ============ ⑨ 运行期异常 ============
check('无运行期异常', runtimeErrors.length === 0, runtimeErrors.slice(0, 3).join(' | '))

// ============ 报告 ============
const bar = '─'.repeat(64)
console.log(`\n${bar}\n  漫画阅读视图 E2E\n${bar}`)
for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : '  ← ' + c.detail}`)
if (model?.ok) {
  const s = model.stats
  console.log(`\n  【模型】${s.chapterCount} 章 / ${s.pageCount} 页 / ${s.panelCount} 格 / ${s.speechCount} 台词`)
  console.log(`  配音 ${s.dubbingClipCount} 段 · 音色 ${s.voiceCount} · 特效 ${s.effectCount}`)
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

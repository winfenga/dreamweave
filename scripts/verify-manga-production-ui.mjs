/**
 * 漫画编排面板 E2E（CDP 真机）。
 *
 * 验证「讲述与配音 / 背景配乐 / 本页音色」三块对照截图的落地情况，
 * 重点是**数据对不对**（段数、时长、音色、配乐）以及**写回是否真的生效**。
 *
 * 前置：应用以 --remote-debugging-port=9222 启动，且已导入含漫画线的包。
 * 用法：
 *   npm run verify:manga-production-ui
 *   npm run verify:manga-production-ui -- --shot D:/galcomic/recon/production.png
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
    timer = setTimeout(() => rej(new Error(`evaluate 超时 @ ${expr.slice(0, 90).replace(/\s+/g, ' ')}`)), 30000)
  })
  try {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }),
      timeout
    ])
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 900))
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

// ============ ⓿ 导入 + 打开漫画 ============
mark('刷新 + 导入')
await send('Page.reload', { ignoreCache: false })
await sleep(2600)
runtimeErrors.length = 0
await send('Page.bringToFront')

const PKG = argv.find((a) => !a.startsWith('--') && a.endsWith('.t2w')) ?? 'D:/galcomic/gmzz-10.t2w'
const imported = await ev(`(async () => {
  const r = await window.dreamweave.importPackage(${JSON.stringify(PKG)}, 't2w')
  return { ok: r.ok, error: r.error, title: r.summary?.project?.title }
})()`)
check('导入漫画包', imported?.ok, imported?.error ?? '')

await send('Page.reload', { ignoreCache: false })
await sleep(2600)
runtimeErrors.length = 0
await send('Page.bringToFront')

await ev(`window.__pkg = ${JSON.stringify(PKG)}; true`)
await ev("(async () => {\nconst ws = await window.dreamweave.listWorkspaces();\nif (!ws.ok) return { ok: false, why: 'readshelf-failed' };\nconst BS = String.fromCharCode(92);\nconst norm = function (s) { return String(s || '').split(BS).join('/').toLowerCase(); };\nconst src = norm(window.__pkg);\nconst hits = ws.items.filter(function (i) { return norm(i.t2wPath) === src; });\nif (!hits.length) return { ok: false, why: 'not-in-shelf' };\nhits.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });\nconst t = hits[0];\nconst book = document.querySelector('[data-testid=\"lib-shelf\"] .slot[data-book-id=\"' + t.id + '\"] .book');\nif (book) { book.click(); return { ok: true, via: 'ui', id: t.id, title: t.title }; }\nconst r = await window.dreamweave.openWorkspace(t.id);\nreturn r.ok ? { ok: true, via: 'ipc', id: t.id } : { ok: false, why: r.error || 'open-failed' };\n})()")
await sleep(1500)

await ev(`(() => {
  const hit = [...document.querySelectorAll('.side-item')].find(b => b.textContent.includes('漫画阅读'))
  if (hit) hit.click()
  return !!hit
})()`)
await sleep(1200)

// ============ ① 入口 + 面板挂载 ============
mark('编排入口')
const hasEntry = await ev(`!!document.querySelector('[data-testid="open-production"]')`)
check('漫画页有「编排」入口', hasEntry, '')

await ev(`(() => { const b = document.querySelector('[data-testid="open-production"]'); if (b) b.click(); return !!b })()`)
await sleep(2200)

const mounted = await ev(`!!document.querySelector('[data-testid="manga-production"]')`)
check('编排面板已挂载', mounted, '')
check('没有落到错误态', await ev(`!document.querySelector('.mp-err-big')`), '')

// ============ ② 讲述与配音 ============
mark('讲述与配音')
const dub = await ev(`(async () => {
  const root = document.querySelector('[data-testid="mp-dubbing"]')
  if (!root) return null
  const segs = [...root.querySelectorAll('.mp-seg')]
  const meta = root.querySelector('.mp-meta')?.textContent?.trim() ?? ''
  const durs = [...root.querySelectorAll('.mp-dur')].map(e => e.textContent.trim())
  const plays = root.querySelectorAll('.mp-btn-play').length
  const redubBtn = root.querySelector('[data-testid="mp-redub"]')
  return {
    segCount: segs.length,
    meta,
    durs: durs.slice(0, 6),
    durCount: durs.length,
    plays,
    redubExists: !!redubBtn,
    redubDisabled: redubBtn ? redubBtn.disabled : null
  }
})()`)
check('讲述与配音区块存在', !!dub, '')
check('渲染出讲述段', (dub?.segCount ?? 0) > 0, `${dub?.segCount} 段`)
check('元信息含「条讲述」「段配音」', /条讲述/.test(dub?.meta ?? '') && /段配音/.test(dub?.meta ?? ''), dub?.meta ?? '')
check('每段有试听按钮', (dub?.plays ?? 0) === (dub?.segCount ?? 0), `${dub?.plays}/${dub?.segCount}`)

// 通过 IPC 对照真实数据
const ipcPage = await ev(`(async () => {
  const r = await window.dreamweave.mangaProductionPage(1, 1)
  if (!r.ok) return { ok: false, error: r.error }
  const p = r.page
  return {
    ok: true,
    segCount: p.segments.length,
    withClip: p.segments.filter(s => s.hasClip).length,
    alignExact: p.alignExact,
    alignReason: p.alignReason ?? '',
    firstText: p.segments[0]?.text ?? '',
    firstLen: (p.segments[0]?.text ?? '').length,
    durations: p.segments.slice(0, 4).map(s => s.durationSec),
    chapterSeq: p.chapterSeq,
    pageNo: p.pageNo
  }
})()`)
check('mangaProductionPage IPC 可用', ipcPage?.ok, ipcPage?.error ?? '')
check('UI 段数 == IPC 段数', dub?.segCount === ipcPage?.segCount, `${dub?.segCount} vs ${ipcPage?.segCount}`)
check('第 1 章第 1 页有 30 段（= clip 数，实测对齐）', ipcPage?.segCount === 30, String(ipcPage?.segCount))
check('对齐判定为可信', ipcPage?.alignExact === true, String(ipcPage?.alignReason))
check('段 0 与截图一致', ipcPage?.firstText === '周明瑞是被一阵剧烈的头痛疼醒的。', ipcPage?.firstText ?? '')
check('段 0 是 16 字', ipcPage?.firstLen === 16, String(ipcPage?.firstLen))
check('时长已读出（非全 0）', (ipcPage?.durations ?? []).some((d) => d > 0), JSON.stringify(ipcPage?.durations))
check(
  '段 0 时长接近截图的 5.0s（±2s）',
  Math.abs((ipcPage?.durations?.[0] ?? 0) - 5.0) < 2.0,
  `实际 ${ipcPage?.durations?.[0]}s`
)
check(
  '段 1 时长接近截图的 11.5s（±3s）',
  Math.abs((ipcPage?.durations?.[1] ?? 0) - 11.5) < 3.0,
  `实际 ${ipcPage?.durations?.[1]}s`
)
check('重新配音按钮可用（对齐可信时）', dub?.redubExists === true && dub?.redubDisabled === false, `disabled=${dub?.redubDisabled}`)
check('已有配音段数 == clip 数', ipcPage?.withClip === 30, String(ipcPage?.withClip))

// ============ ③ 背景配乐 ============
mark('背景配乐')
const music = await ev(`(async () => {
  const root = document.querySelector('[data-testid="mp-music"]')
  if (!root) return null
  const cur = root.querySelector('[data-testid="mp-music-current"]')
  return {
    exists: !!root,
    curExists: !!cur,
    title: cur?.querySelector('.mp-music-title')?.textContent?.trim() ?? '',
    author: cur?.querySelector('.mp-music-author')?.textContent?.trim() ?? '',
    hasAudio: !!cur?.querySelector('[data-testid="mp-music-audio"]'),
    attribution: (cur?.querySelector('.mp-attribution')?.textContent ?? '').slice(0, 40),
    tags: [...(cur?.querySelectorAll('.mp-tag') ?? [])].map(e => e.textContent.trim())
  }
})()`)
check('背景配乐区块存在', !!music?.exists, '')
check('显示当前曲目名', (music?.title?.length ?? 0) > 0, music?.title ?? '')
check('显示曲目作者', (music?.author?.length ?? 0) > 0, music?.author ?? '')
check('有音频播放器', music?.hasAudio === true, '')
check('显示授权署名（CC 协议要求）', (music?.attribution?.length ?? 0) > 5, music?.attribution ?? '')
check('曲目与实测一致（Static Motion / Kevin MacLeod）', /Static Motion/i.test(music?.title ?? '') || /Kevin MacLeod/i.test(music?.author ?? ''), `${music?.title} / ${music?.author}`)

/**
 * ⚠️ 「卡片是否真的把内容显示出来了」必须单独断言。
 *
 * 曾经出现：DOM 里 `.mp-music-current` 查得到、内容也对，但它的高度被父级
 * `flex` 收缩 + `overflow:hidden` 裁掉了，界面上**只看得见卡头**。
 * 纯查 textContent 的断言全部通过，是截图才发现 —— 所以这里量真实高度。
 */
const musicVisible = await ev(`(() => {
  const card = document.querySelector('[data-testid="mp-music"]')
  const cur = card?.querySelector('[data-testid="mp-music-current"]')
  if (!card || !cur) return { ok: false }
  const cr = card.getBoundingClientRect()
  const ur = cur.getBoundingClientRect()
  return {
    ok: true,
    cardH: Math.round(cr.height),
    curH: Math.round(ur.height),
    // 内容的底边必须在卡片底边之内（否则就是被裁）
    notClipped: ur.bottom <= cr.bottom + 2,
    hasTitle: (cur.querySelector('.mp-music-title')?.textContent ?? '').length > 0
  }
})()`)
check(
  '配乐卡片把内容完整显示出来（未被 flex 压扁/裁切）',
  musicVisible?.ok === true && musicVisible?.notClipped === true && (musicVisible?.curH ?? 0) > 80,
  JSON.stringify(musicVisible)
)

const voiceVisible = await ev(`(() => {
  const card = document.querySelector('[data-testid="mp-voices"]')
  const cards = [...(card?.querySelectorAll('.mp-voice') ?? [])]
  if (!card || !cards.length) return { ok: false }
  const cr = card.getBoundingClientRect()
  return {
    ok: true,
    cardH: Math.round(cr.height),
    count: cards.length,
    // 每张音色卡都要有足够高度（含描述输入框），且不被裁
    heights: cards.map(c => Math.round(c.getBoundingClientRect().height)),
    notClipped: cards.every(c => c.getBoundingClientRect().bottom <= cr.bottom + 2)
  }
})()`)
check(
  '音色卡片完整显示（含描述输入框，未被裁切）',
  voiceVisible?.ok === true && voiceVisible?.notClipped === true && (voiceVisible?.heights ?? []).every((h) => h > 200),
  JSON.stringify(voiceVisible)
)

// 候选池
const pool = await ev(`(async () => {
  const btn = document.querySelector('[data-testid="mp-music-pick"]')
  if (!btn) return { ok: false }
  btn.click()
  await new Promise(r => setTimeout(r, 600))
  const el = document.querySelector('[data-testid="mp-music-pool"]')
  if (!el) return { ok: false, why: '候选池未出现' }
  const items = [...el.querySelectorAll('.mp-pool-item')]
  return { ok: true, count: items.length, first: items[0]?.querySelector('.mp-pool-title')?.textContent?.trim() ?? '' }
})()`)
check('可展开候选曲目池', pool?.ok === true, pool?.why ?? '')
check('候选池有曲目', (pool?.count ?? 0) > 0, `${pool?.count} 首`)
// 收起
await ev(`(() => { const b = document.querySelector('[data-testid="mp-music-pick"]'); if (b) b.click(); return true })()`)
await sleep(300)

// ============ ④ 本页音色 ============
mark('本页音色')
const voices = await ev(`(async () => {
  const root = document.querySelector('[data-testid="mp-voices"]')
  if (!root) return null
  const cards = [...root.querySelectorAll('.mp-voice')]
  return {
    exists: !!root,
    count: cards.length,
    names: cards.map(c => c.querySelector('.mp-voice-head b')?.textContent?.trim() ?? ''),
    hasNarrator: cards.some(c => c.classList.contains('narrator')),
    hasDescInput: !!root.querySelector('.mp-textarea'),
    hasTypeSelect: !!root.querySelector('select'),
    hasSave: !!root.querySelector('.mp-link')
  }
})()`)
check('本页音色区块存在', !!voices?.exists, '')
check('列出本页声音', (voices?.count ?? 0) > 0, `${voices?.count} 个`)
check('旁白在列表里且有标识', voices?.hasNarrator === true, JSON.stringify(voices?.names))
check('有声音描述输入框', voices?.hasDescInput === true, '')
check('有声音类型下拉', voices?.hasTypeSelect === true, '')
check('有保存按钮', voices?.hasSave === true, '')

// 读 IPC 音色真值
const ipcVoices = await ev(`(async () => {
  const r = await window.dreamweave.mangaProductionPage(1, 1)
  if (!r.ok) return { ok: false }
  return { ok: true, count: r.voices.length, narr: r.voices.filter(v => v.isNarrator).length, ids: r.voices.map(v => v.characterId) }
})()`)
check('UI 音色数 == IPC 音色数', voices?.count === ipcVoices?.count, `${voices?.count} vs ${ipcVoices?.count}`)
check('恰好 1 个旁白', ipcVoices?.narr === 1, String(ipcVoices?.narr))
check('音色含 $narrator', (ipcVoices?.ids ?? []).includes('$narrator'), JSON.stringify(ipcVoices?.ids))

// ============ ⑤ 音色写回（真写 + 回读 + 快照还原）============
mark('音色写回')
const voiceWrite = await ev(`(async () => {
  const r0 = await window.dreamweave.mangaProductionPage(1, 1)
  const before = r0.voices.find(v => v.isNarrator)
  if (!before) return { skipped: '本页没有旁白，无法测试音色写回' }
  // 快照：无条件还原的依据（不依赖读端正确性）
  const snapshot = { vt: before.vt || 'androgynous', vi: before.vi || '' }
  const marker = '测试音色描述-' + Date.now()
  const w = await window.dreamweave.mangaProductionSaveVoice({
    characterId: '$narrator', vt: 'androgynous', vi: marker, isNarrator: true
  })
  if (!w.ok) return { ok: false, error: w.error, snapshot }
  const r1 = await window.dreamweave.mangaProductionPage(1, 1)
  const afterVi = r1.voices.find(v => v.isNarrator)?.vi ?? ''
  // 用快照还原
  const w2 = await window.dreamweave.mangaProductionSaveVoice({
    characterId: '$narrator', vt: snapshot.vt, vi: snapshot.vi, isNarrator: true
  })
  const r2 = await window.dreamweave.mangaProductionPage(1, 1)
  return {
    ok: w2.ok,
    marker,
    afterVi,
    restoredVi: r2.voices.find(v => v.isNarrator)?.vi ?? '',
    originVi: snapshot.vi
  }
})()`)
if (voiceWrite?.skipped) {
  check('音色写回（跳过：无旁白）', true, voiceWrite.skipped)
} else {
  check('音色写回成功', voiceWrite?.ok === true, voiceWrite?.error ?? '')
  check('写回后读到的就是新值', voiceWrite?.afterVi === voiceWrite?.marker, `${voiceWrite?.afterVi?.slice(0, 30)} vs ${voiceWrite?.marker?.slice(0, 30)}`)
  check('可用快照还原原值（数据未被污染）', voiceWrite?.restoredVi === voiceWrite?.originVi, `还原后「${voiceWrite?.restoredVi?.slice(0, 20)}」vs 原「${voiceWrite?.originVi?.slice(0, 20)}」`)
}

// ============ ⑥ 配乐换曲（真写 + 回读 + 还原）============
mark('配乐换曲')
/**
 * ⚠️ 这里\"还原\"必须用**写回前抓到的快照**，不能靠\"再读一次再写回\"。
 *
 * 首版就是这么写的，踩了坑：读取端当时有 bug（候选池覆盖了 current），
 * 于是\"读回来的是错的 → 还原时把错的写回去\"，把工作库数据**永久改坏**了
 * （chapter:1 的 track 从 Static Motion 变成候选曲目 Oppressive Gloom）。
 * 教训：测试的清理路径不能依赖被测代码的正确性。
 */
const musicWrite = await ev(`(async () => {
  const r0 = await window.dreamweave.mangaProductionPage(1, 1)
  const cur = r0.music.current
  if (!cur) return { skipped: '本章没有配乐，无法测试换曲' }
  // 快照：完整拷贝一份原始 track（含所有字段），用于无条件还原
  const snapshot = {
    id: cur.id, title: cur.title, author: cur.author, url: cur.url,
    durationSec: cur.durationSec, licenseId: cur.licenseId, attribution: cur.attribution
  }
  // 换成一个明显不同的曲目（用快照构造，保证字段齐全，不依赖候选池）
  const fake = {
    id: 'verify:probe:' + Date.now(),
    title: '验证用曲目',
    author: 'verify',
    url: cur.url,
    durationSec: null,
    licenseId: 'CC0-1.0',
    attribution: 'visual verification only'
  }
  const w = await window.dreamweave.mangaProductionSaveMusic({ chapterSeq: 1, track: fake })
  if (!w.ok) return { ok: false, error: w.error, snapshot }
  const r1 = await window.dreamweave.mangaProductionPage(1, 1)
  const afterTitle = r1.music.current?.title ?? ''
  const afterAttr = r1.music.current?.attribution ?? ''
  // 无条件还原（用快照，不看当前读到的值）
  const w2 = await window.dreamweave.mangaProductionSaveMusic({ chapterSeq: 1, track: snapshot })
  const r2 = await window.dreamweave.mangaProductionPage(1, 1)
  return {
    ok: w2.ok,
    afterTitle,
    afterAttr,
    restoredTitle: r2.music.current?.title ?? '',
    originTitle: snapshot.title,
    originAttr: snapshot.attribution
  }
})()`)
if (musicWrite?.skipped) {
  check('配乐换曲（跳过：本章无配乐）', true, musicWrite.skipped)
} else {
  check('配乐换曲写回成功', musicWrite?.ok === true, musicWrite?.error ?? '')
  check('换曲后读到的就是新曲目', musicWrite?.afterTitle === '验证用曲目', musicWrite?.afterTitle ?? '')
  check('换曲后授权署名随之更新', musicWrite?.afterAttr === 'visual verification only', musicWrite?.afterAttr ?? '')
  check('可用快照还原原曲目（清理不依赖读端）', musicWrite?.restoredTitle === musicWrite?.originTitle, `${musicWrite?.restoredTitle} vs ${musicWrite?.originTitle}`)
}

// ============ ⑦ 截图 + 异常 ============
mark('截图')
// 重新加载面板拿到还原后的状态
await ev(`(() => { const b = document.querySelector('[data-testid="mp-close"]'); if (b) b.click(); return true })()`)
await sleep(600)
await ev(`(() => { const b = document.querySelector('[data-testid="open-production"]'); if (b) b.click(); return true })()`)
await sleep(1800)

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
check('无运行期异常', runtimeErrors.length === 0, runtimeErrors.slice(0, 3).join(' | '))

// ============ 报告 ============
const bar = '─'.repeat(64)
console.log(`\n${bar}\n  漫画编排面板 E2E\n${bar}`)
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

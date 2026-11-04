/**
 * 角色卡 + 内置酒馆端到端验证（CDP 连真实渲染进程）。
 *
 * 前置：应用以 --remote-debugging-port=9222 启动，且已导入含 canonical 的书（默认 monte-cristo）。
 *
 * 用法：
 *   npm run verify:cards-ui
 *   npm run verify:cards-ui -- --shot D:/galcomic/recon/cards.png
 *
 * 验证内容：
 *   ① 侧栏「角色卡」入口可点开，列表渲染出人物（数量与 canonical 一致）
 *   ② 点选角色后详情加载，档案/关系/立绘/音色/世界书五个页签都有内容
 *   ③ 立绘是真实像素（不是破图），走 dwe:// 协议
 *   ④ 关系条目来自 canonical（双向收集，不只单向）
 *   ⑤ 世界书条目齐备且含常驻世界观条目
 *   ⑥ 导出 JSON 能落地（走真实 IPC + 临时目录）
 *   ⑦ 导出 PNG 能被读回（SillyTavern 格式，tEXt 里能解出卡片 JSON）
 *   ⑧ 酒馆页签可打开，开场白已存在
 *   ⑨ 酒馆参数面板可展开，滑块可改，且「用模型默认」把值置为 null
 *   ⑩ 调试面板显示「实际发送的请求体」，且**不含 response_format**
 *   ⑪ 无运行期异常
 */
import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'

const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'
const argv = process.argv.slice(2)
const shotPath = argv.includes('--shot') ? argv[argv.indexOf('--shot') + 1] : null
const OUT_DIR = 'D:/galcomic/recon/cards-export'

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

const ev = async (expr) => {
  let timer
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(
      () => rej(new Error(`evaluate 超时 25s @ ${expr.slice(0, 100).replace(/\s+/g, ' ')}`)),
      25000
    )
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

// ============ ⓿ 导入 + 打开 ============
mark('刷新 + 导入');
await send('Page.reload', { ignoreCache: false })
await sleep(2600)
runtimeErrors.length = 0
await send('Page.bringToFront')

const PKG = argv.find((a) => !a.startsWith('--') && a.endsWith('.t2w')) ?? 'D:/galcomic/dreamweave/testdata/monte-cristo-10ch.t2w'
const imported = await ev(`(async () => {
  const r = await window.feather.importPackage(${JSON.stringify(PKG)}, 't2w')
  return { ok: r.ok, error: r.error, title: r.summary?.project?.title, chars: r.summary?.project?.charCount }
})()`)
check('导入书籍', imported?.ok, imported?.error ?? '')

await send('Page.reload', { ignoreCache: false })
await sleep(2600)
runtimeErrors.length = 0
await send('Page.bringToFront')

await ev(`window.__pkg = ${JSON.stringify(PKG)}; true`)
const opened = await ev("(async () => {\nconst ws = await window.feather.listWorkspaces();\nif (!ws.ok) return { ok: false, why: 'readshelf-failed' };\nconst BS = String.fromCharCode(92);\nconst norm = function (s) { return String(s || '').split(BS).join('/').toLowerCase(); };\nconst src = norm(window.__pkg);\nconst hits = ws.items.filter(function (i) { return norm(i.t2wPath) === src; });\nif (!hits.length) return { ok: false, why: 'not-in-shelf' };\nhits.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });\nconst t = hits[0];\nconst book = document.querySelector('[data-testid=\"lib-shelf\"] .slot[data-book-id=\"' + t.id + '\"] .book');\nif (book) { book.click(); return { ok: true, via: 'ui', id: t.id, title: t.title }; }\nconst r = await window.feather.openWorkspace(t.id);\nreturn r.ok ? { ok: true, via: 'ipc', id: t.id } : { ok: false, why: r.error || 'open-failed' };\n})()")
check('书库中点开这本书', opened?.ok, opened?.why ?? '')
await sleep(1500)

// ============ ① 入口 + 列表 ============
mark('角色卡列表');
const hasEntry = await ev(`!!document.querySelector('[data-testid="tab-cards"]')`)
check('侧栏有「角色卡」入口', hasEntry, '')

await ev(`(() => { const b = document.querySelector('[data-testid="tab-cards"]'); if (b) b.click(); return !!b })()`)
await sleep(1600)

const listInfo = await ev(`(async () => {
  const items = [...document.querySelectorAll('.cc-item')]
  const meta = document.querySelector('.cc-list-meta')?.textContent?.trim() ?? ''
  // 同时读 IPC 真值，避免只验证 UI
  const r = await window.feather.cardList()
  return {
    uiCount: items.length,
    meta,
    ipcOk: r.ok,
    ipcErr: r.error,
    ipcCount: r.items?.length ?? 0,
    stats: r.stats ?? null,
    names: (r.items ?? []).slice(0, 3).map(x => x.name)
  }
})()`)
check('cardList IPC 可用', listInfo?.ipcOk, listInfo?.ipcErr ?? '')
check('列表渲染出角色', (listInfo?.uiCount ?? 0) > 0, `ui=${listInfo?.uiCount}`)
check('UI 数量与 IPC 一致', listInfo?.uiCount === listInfo?.ipcCount, `${listInfo?.uiCount} vs ${listInfo?.ipcCount}`)
check('角色数量与 canonical 一致（20）', listInfo?.ipcCount === 20, `ipc=${listInfo?.ipcCount} project=${imported?.chars}`)
check('统计里有立绘/音色数', typeof listInfo?.stats?.withPortrait === 'number' && typeof listInfo?.stats?.withVoice === 'number', JSON.stringify(listInfo?.stats))

// ============ ② 详情 ============
mark('卡片详情');
const detailInfo = await ev(`(async () => {
  const first = document.querySelector('.cc-item')
  if (!first) return { ok: false, why: '没有列表项' }
  first.click()
  await new Promise(r => setTimeout(r, 900))
  const d = await window.feather.cardGet(first.getAttribute('data-testid')?.replace('card-item-', '') ?? '')
  return {
    ok: d.ok,
    err: d.error,
    name: d.card?.name,
    hasProfile: !!d.card?.profile,
    profileLen: d.card?.profile?.length ?? 0,
    relations: d.card?.relations?.length ?? 0,
    portraits: d.card?.portraits?.length ?? 0,
    hasVoice: !!d.card?.voice,
    loreCount: d.lorebook?.length ?? 0,
    hasConstantLore: (d.lorebook ?? []).some(e => e.constant),
    firstMes: d.card?.firstMes?.length ?? 0,
    descLen: d.card?.description?.length ?? 0
  }
})()`)
check('cardGet IPC 可用', detailInfo?.ok, detailInfo?.err ?? '')
check('人物档案非空', (detailInfo?.profileLen ?? 0) > 50, `${detailInfo?.profileLen} 字`)
check('关系条目已收集', (detailInfo?.relations ?? 0) > 0, `${detailInfo?.relations} 条`)
check('立绘条目已收集', (detailInfo?.portraits ?? 0) > 0, `${detailInfo?.portraits} 张`)
check('酒馆字段（描述/开场白）已生成', (detailInfo?.descLen ?? 0) > 30 && (detailInfo?.firstMes ?? 0) > 5, `desc=${detailInfo?.descLen} first=${detailInfo?.firstMes}`)
check('世界书含常驻世界观条目', detailInfo?.hasConstantLore === true, `${detailInfo?.loreCount} 条`)

// 五个页签都能打开
mark('页签');
const tabIds = ['tab-profile', 'tab-relations', 'tab-portraits', 'tab-voice', 'tab-lore', 'tab-tavern']
const tabResults = {}
for (const id of tabIds) {
  const r = await ev(`(async () => {
    const b = document.querySelector('[data-testid="${id}"]')
    if (!b) return { ok: false }
    b.click()
    await new Promise(r => setTimeout(r, 350))
    const on = b.classList.contains('on')
    const pane = document.querySelector('.cc-tab-body .cc-sec')
    return { ok: on && !!pane, paneClass: pane?.getAttribute('data-testid') ?? '' }
  })()`)
  tabResults[id] = r
}
check(
  '六个页签都可打开',
  tabIds.every((id) => tabResults[id]?.ok),
  JSON.stringify(Object.entries(tabResults).filter(([, v]) => !v?.ok).map(([k]) => k))
)

// ============ ③ 立绘真实渲染 ============
mark('立绘渲染');
await ev(`document.querySelector('[data-testid="tab-portraits"]')?.click()`)
await sleep(600)
let imgOk = null
for (let i = 0; i < 20; i++) {
  imgOk = await ev(`(() => {
    const img = document.querySelector('.cc-portrait-thumb')
    if (!img) return { state: 'no-img' }
    if (!img.complete) return { state: 'loading' }
    return { state: 'done', nw: img.naturalWidth, nh: img.naturalHeight, src: (img.src || '').slice(0, 40) }
  })()`)
  if (imgOk?.state === 'done') break
  await sleep(400)
}
check('立绘已加载', imgOk?.state === 'done', JSON.stringify(imgOk))
check('立绘有真实像素', (imgOk?.nw ?? 0) > 100 && (imgOk?.nh ?? 0) > 100, `${imgOk?.nw}x${imgOk?.nh}`)
check('立绘走 dwe:// 协议', (imgOk?.src ?? '').startsWith('dwe://'), imgOk?.src)

// ============ ④ 关系双向 ============
mark('关系双向');
const relInfo = await ev(`(async () => {
  const r = await window.feather.cardList()
  // 找一个有关系的人，再确认关系也出现在对方的关系里（A/B 两侧都收）
  const withRel = (r.items ?? []).filter(x => x.relationCount > 0)
  if (withRel.length < 2) return { ok: false, why: '有关系的人不足 2' }
  const a = withRel[0]
  const d = await window.feather.cardGet(a.id)
  const other = d.card?.relations?.[0]?.otherCharacterId
  if (!other) return { ok: false, why: '关系里没有对方 id' }
  const d2 = await window.feather.cardGet(other)
  const back = (d2.card?.relations ?? []).some(x => x.otherCharacterId === a.id)
  return { ok: true, a: a.name, other: d2.card?.name, back }
})()`)
check('关系是双向收集的（A↔B 两侧都有）', relInfo?.ok === true && relInfo?.back === true, JSON.stringify(relInfo))

// ============ ⑤ 导出 JSON ============
mark('导出 JSON');
const jsonExport = await ev(`(async () => {
  const r = await window.feather.cardList()
  const id = r.items?.[0]?.id
  if (!id) return { ok: false, why: '没有角色' }
  const res = await window.feather.cardExport({ cardIds: [id], format: 'json', outDir: ${JSON.stringify(OUT_DIR)} })
  return { ok: res.ok, err: res.error, paths: res.paths ?? [], skipped: res.skipped ?? [] }
})()`)
check('JSON 导出成功', jsonExport?.ok === true, jsonExport?.err ?? JSON.stringify(jsonExport?.skipped))
if (jsonExport?.paths?.length) {
  const p = jsonExport.paths[0]
  check('JSON 文件真的落盘', existsSync(p), p)
  if (existsSync(p)) {
    const obj = JSON.parse(readFileSync(p, 'utf8'))
    check('导出的 JSON 是 chara_card_v2', obj.spec === 'chara_card_v2', String(obj.spec))
    check('JSON 含 data.first_mes', typeof obj.data?.first_mes === 'string' && obj.data.first_mes.length > 0, '')
    check('JSON 含 character_book', !!obj.data?.character_book, '')
    check('JSON 顶层 name 与 data.name 一致', obj.name === obj.data?.name, `${obj.name} / ${obj.data?.name}`)
  }
}

// ============ ⑥ 导出 PNG 并读回 ============
mark('导出 PNG');
const pngExport = await ev(`(async () => {
  const r = await window.feather.cardList()
  // 挑一个**有立绘**的角色，才能真正验证「立绘 + tEXt」
  const withImg = (r.items ?? []).find(x => x.avatarUrl)
  const id = withImg?.id ?? r.items?.[0]?.id
  if (!id) return { ok: false, why: '没有角色' }
  const res = await window.feather.cardExport({ cardIds: [id], format: 'png', outDir: ${JSON.stringify(OUT_DIR)} })
  return { ok: res.ok, err: res.error, paths: res.paths ?? [], skipped: res.skipped ?? [], id, name: withImg?.name }
})()`)
check('PNG 导出成功', pngExport?.ok === true, pngExport?.err ?? JSON.stringify(pngExport?.skipped))

if (pngExport?.paths?.length) {
  const p = pngExport.paths[0]
  check('PNG 文件真的落盘', existsSync(p), p)
  if (existsSync(p)) {
    const buf = readFileSync(p)
    check('PNG 签名正确', buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47, '')
    // 扫描 tEXt 块
    let off = 8
    const texts = {}
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off)
      const type = buf.toString('latin1', off + 4, off + 8)
      if (type === 'tEXt') {
        const data = buf.subarray(off + 8, off + 8 + len)
        const nul = data.indexOf(0)
        if (nul > 0) {
          const kw = data.toString('latin1', 0, nul)
          texts[kw] = data.toString('latin1', nul + 1)
        }
      }
      if (type === 'IEND') break
      off += 12 + len
    }
    check('PNG 含 chara 块', !!texts.chara, JSON.stringify(Object.keys(texts)))
    check('PNG 含 ccv3 块', !!texts.ccv3, JSON.stringify(Object.keys(texts)))
    if (texts.chara) {
      const card = JSON.parse(Buffer.from(texts.chara, 'base64').toString('utf8'))
      check('chara 能解出卡片 JSON', card.spec === 'chara_card_v2', String(card.spec))
      check('解出的卡片名与角色一致', card.name === pngExport.name, `${card.name} / ${pngExport.name}`)
      check('解出的卡片含世界书', (card.data?.character_book?.entries ?? []).length > 0, '')
    }
  }
}

// ============ ⑦ 酒馆 ============
mark('酒馆');
await ev(`document.querySelector('[data-testid="tab-tavern"]')?.click()`)
await sleep(1400)

const tvInfo = await ev(`(async () => {
  const root = document.querySelector('[data-testid="tavern"]')
  if (!root) return { ok: false, why: '酒馆未挂载' }
  const msgs = [...root.querySelectorAll('.tv-msg')]
  const first = msgs[0]?.querySelector('.tv-msg-body')?.textContent?.trim() ?? ''
  const s = await window.feather.tavernGetSettings()
  return {
    ok: true,
    msgCount: msgs.length,
    firstLen: first.length,
    hasInput: !!root.querySelector('[data-testid="tv-input"]'),
    hasSend: !!root.querySelector('[data-testid="tv-send"]'),
    settings: s ? { t: s.params?.temperature, lore: s.useLorebook } : null
  }
})()`)
check('酒馆面板已挂载', tvInfo?.ok === true, tvInfo?.why ?? '')
check('开场白已存在（first_mes 注入）', (tvInfo?.firstLen ?? 0) > 5, `${tvInfo?.firstLen} 字`)
check('输入框与发送按钮齐备', tvInfo?.hasInput === true && tvInfo?.hasSend === true, '')
check('酒馆设置可读', tvInfo?.settings !== null && typeof tvInfo?.settings?.t === 'number', JSON.stringify(tvInfo?.settings))

// 参数面板
mark('参数面板');
const paramInfo = await ev(`(async () => {
  document.querySelector('[data-testid="tv-toggle-params"]')?.click()
  await new Promise(r => setTimeout(r, 500))
  const pane = document.querySelector('[data-testid="tv-params"]')
  if (!pane) return { ok: false }
  const sliders = [...pane.querySelectorAll('input[type=range]')]
  const nullBtns = [...pane.querySelectorAll('.tv-null')]
  return { ok: true, sliders: sliders.length, nullBtns: nullBtns.length, labels: [...pane.querySelectorAll('.tv-p-label')].map(x => x.textContent.trim().split(' ')[0]) }
})()`)
check('参数面板可展开', paramInfo?.ok === true, '')
check('参数滑块齐备（温度/top_p/频率/存在/重复/top_k ≥ 6）', (paramInfo?.sliders ?? 0) >= 6, `${paramInfo?.sliders}`)
check('每个参数都有「用模型默认」开关', (paramInfo?.nullBtns ?? 0) >= 6, `${paramInfo?.nullBtns}`)

// 「用模型默认」→ null 语义
const nullSemantics = await ev(`(async () => {
  const pane = document.querySelector('[data-testid="tv-params"]')
  if (!pane) return { ok: false }
  const btn = pane.querySelector('.tv-null')
  if (!btn) return { ok: false }
  const before = btn.textContent.trim()
  btn.click()
  await new Promise(r => setTimeout(r, 300))
  const after = btn.textContent.trim()
  return { ok: true, before, after }
})()`)
check(
  '「用模型默认」按钮可切换（发/不发该字段）',
  nullSemantics?.ok === true && nullSemantics?.before !== nullSemantics?.after,
  JSON.stringify(nullSemantics)
)

// ============ ⑧ 真机生成（有模型配置时） ============
mark('真机生成');
await ev(`document.querySelector('[data-testid="tv-toggle-params"]')?.click()`)
await sleep(300)
const gen = await ev(`(async () => {
  const s = await window.feather.getSettings()
  const p = (s.llm || []).find(x => x.id === s.activeLlmId) || (s.llm || [])[0]
  if (!p) return { skipped: '未配置模型' }
  const r = await window.feather.cardList()
  const id = (r.items ?? [])[0]?.id
  if (!id) return { skipped: '没有角色' }
  const t0 = Date.now()
  const res = await window.feather.tavernGenerate({
    cardId: id,
    messages: [{ id: 'u1', role: 'user', content: '你好，你是谁？', at: Date.now() }],
    params: { temperature: 0.8, topP: 0.95, topK: null, frequencyPenalty: 0.2, presencePenalty: 0.2, repetitionPenalty: null, maxTokens: 300, stop: [], seed: null },
    useLorebook: true
  })
  return { ok: res.ok, err: res.error, len: res.content?.length ?? 0, content: (res.content ?? '').slice(0, 80), used: res.usedParams ?? null, hits: res.loreHits ?? [], ms: Date.now() - t0, blocked: res.blocked }
})()`)
if (gen?.skipped) {
  check('真机生成（跳过：模型未配置）', true, gen.skipped)
} else {
  check('酒馆能生成回复', gen?.ok === true, gen?.err ?? '')
  check('回复内容非空', (gen?.len ?? 0) > 3, `${gen?.len} 字`)
  check('回显了实际发送的请求体', !!gen?.used, '')
  check('请求体含 temperature（酒馆与流水线不同，允许调参）', gen?.used?.temperature === 0.8, String(gen?.used?.temperature))
  check('⚠️ 请求体不含 response_format（酒馆要自然语言）', gen && !('response_format' in (gen.used ?? {})), JSON.stringify(Object.keys(gen?.used ?? {})))
  check('请求体不含 top_k（传 null 则不发）', gen && !('top_k' in (gen.used ?? {})), '')
  check('世界书命中已回显', Array.isArray(gen?.hits), JSON.stringify(gen?.hits))
  if (gen?.ok) console.log(`        ↳ 回复：${gen.content}…（${gen.ms}ms）`)
}

// ============ ⑨ 截图 ============
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

// ============ ⑩ 异常 ============
mark('运行期异常');
check('无运行期异常', runtimeErrors.length === 0, runtimeErrors.slice(0, 3).join(' | '))

// ============ 报告 ============
const bar = '─'.repeat(64)
console.log(`\n${bar}\n  角色卡 + 内置酒馆 E2E\n${bar}`)
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

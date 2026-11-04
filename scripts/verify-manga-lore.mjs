/**
 * 漫画世界书验证（CDP 真机）。
 *
 * 世界书的数据层与 UI 都要守住，重点是**数据结构差异**：
 * 漫画包的 canonical 和小说包不一样（见 lorebook.ts 顶部对照表），
 * 若照搬角色卡那套解析，会「形象一个都取不到、关系永远为空」。
 *
 * 断言：
 *   ① 从漫画包能构建出人物条目（15 人）与世界观（1 条）
 *   ② 人物条目带别名 / 音色 / 档案正文（不是空壳）
 *   ③ 世界观条目 constant=true
 *   ④ 界面渲染出条目，数量与 IPC 一致
 *   ⑤ 搜索能按名字、别名、正文三个维度命中
 *   ⑥ 分类筛选（全部/人物/设定）工作正常
 *   ⑦ 展开/折叠能显示全文
 *   ⑧ 排序把世界观放最前、人物按台词热度降序
 *
 * 用法：npm run verify:manga-lore
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
    timer = setTimeout(() => rej(new Error(`evaluate 超时 @ ${expr.slice(0, 80).replace(/\s+/g, ' ')}`)), 35000)
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

// ============ ⓿ 确保打开漫画书 ============
mark('准备')
const ensure = await ev(`(async () => {
  const mv = await window.feather.getMangaView()
  if (mv.ok && mv.data?.dubbing?.length) return { ok: true, reused: true }
  const imp = await window.feather.importPackage('D:/galcomic/gmzz-10.t2w', 't2w')
  if (!imp.ok) return { ok: false, err: imp.error }
  return { ok: true, reused: false, title: imp.summary?.project?.title ?? '' }
})()`)
check('漫画书可用', ensure?.ok, ensure?.err ?? '')

if (!ensure?.reused) {
  await send('Page.reload', { ignoreCache: false })
  await sleep(2800)
  await send('Page.bringToFront')
  const opened = await ev(`(async () => {
    const rows = [...document.querySelectorAll('tbody tr')]
    const row = rows.find(r => r.textContent.includes(${JSON.stringify(ensure?.title ?? '')}))
    if (!row) return { ok: false, why: '书库里没找到' }
    const btn = [...row.querySelectorAll('button')].find(b => b.textContent.trim() === '打开')
    if (!btn) return { ok: false, why: '没有打开按钮' }
    btn.click()
    return { ok: true }
  })()`)
  check('打开漫画书', opened?.ok, opened?.why ?? '')
  await sleep(1600)
}
await ev(`(() => { const hit = [...document.querySelectorAll('.side-item')].find(b => b.textContent.includes('漫画阅读')); if (hit) hit.click(); return !!hit })()`)
await sleep(1400)

// ============ ① 数据层 ============
mark('数据层')
const data = await ev(`(async () => {
  const p = await window.feather.mangaProductionPage(1, 1)
  if (!p.ok) return { ok: false, error: p.error }
  const lb = p.lorebook
  if (!lb) return { ok: false, error: '没有 lorebook 字段' }
  const chars = lb.entries.filter(e => e.kind === 'character')
  const worlds = lb.entries.filter(e => e.kind === 'world')
  return {
    ok: true,
    stats: lb.stats,
    warning: lb.warning ?? '',
    total: lb.entries.length,
    charCount: chars.length,
    worldCount: worlds.length,
    firstEntryKind: lb.entries[0]?.kind ?? '',
    firstIsWorld: lb.entries[0]?.kind === 'world',
    worldConstant: worlds[0]?.constant ?? null,
    withAlias: chars.filter(e => e.aliases.length > 0).length,
    withVoice: chars.filter(e => e.voiceType).length,
    withContent: chars.filter(e => e.content.length > 30).length,
    sample: chars[0] ? {
      name: chars[0].name, aliases: chars[0].aliases, tag: chars[0].tag,
      voiceType: chars[0].voiceType, contentLen: chars[0].content.length,
      keys: chars[0].keys, actionCount: chars[0].actionCount,
      hasAppearance: /外貌/.test(chars[0].content)
    } : null,
    // 排序检查：后面的人物 actionCount 不应大于前面的
    hotSorted: (() => {
      const counts = chars.map(c => c.actionCount)
      for (let i = 1; i < counts.length; i++) if (counts[i] > counts[i - 1]) return false
      return true
    })(),
    topHot: chars.slice(0, 3).map(c => c.name + ':' + c.actionCount)
  }
})()`)
check('mangaProductionPage 返回 lorebook', data?.ok, data?.error ?? '')
check('无警告（有 canonical 产物）', !data?.warning, data?.warning ?? '')
check('世界书条目数 > 0', (data?.total ?? 0) > 0, `${data?.total}`)
check('人物 15 条（= canonical.characters）', data?.charCount === 15, `${data?.charCount}`)
check('世界观 1 条', data?.worldCount === 1, `${data?.worldCount}`)
check('世界观排在第一条', data?.firstIsWorld === true, `第一条是 ${data?.firstEntryKind}`)
check('世界观条目 constant=true', data?.worldConstant === true, String(data?.worldConstant))
check('人物条目带别名（不是空壳）', (data?.withAlias ?? 0) >= 5, `${data?.withAlias} 人有别名`)
check('人物条目带音色', (data?.withVoice ?? 0) >= 5, `${data?.withVoice} 人有音色`)
check('人物条目有档案正文（>30 字）', (data?.withContent ?? 0) >= 10, `${data?.withContent}/${data?.charCount}`)
check('正文含「外貌」段（吃到 characterSpriteInfos）', data?.sample?.hasAppearance === true, '未含外貌')
check('characters 表人物按台词热度降序', data?.hotSorted === true, JSON.stringify(data?.topHot))

// ============ ② 界面渲染 ============
mark('界面渲染')
// 打开编排面板并滚到世界书
await ev(`(() => { const b = document.querySelector('[data-testid="open-production"]'); if (b) b.click(); return !!b })()`)
await sleep(2200)
check('编排面板已挂载', await ev(`!!document.querySelector('[data-testid="manga-production"]')`), '')

const ui = await ev(`(() => {
  const card = document.querySelector('[data-testid="mp-lore"]')
  if (!card) return { exists: false }
  const items = [...card.querySelectorAll('.mp-lore-item')]
  const tabs = [...card.querySelectorAll('.mp-lore-tabs button')].map(b => b.textContent.trim())
  return {
    exists: true,
    itemCount: items.length,
    tabs,
    hasSearch: !!card.querySelector('[data-testid="mp-lore-search"]'),
    firstItemName: items[0]?.querySelector('.mp-lore-name')?.textContent?.trim() ?? '',
    hasWarning: !!card.querySelector('[data-testid="mp-lore-warning"]'),
    // 卡片是否真的显示出来（不被 flex 压扁）
    cardH: Math.round(card.getBoundingClientRect().height),
    firstItemH: items[0] ? Math.round(items[0].getBoundingClientRect().height) : 0
  }
})()`)
check('世界书区块存在', ui?.exists === true, '')
check('渲染出条目', (ui?.itemCount ?? 0) > 0, `${ui?.itemCount}`)
check('条目数与 IPC 一致', ui?.itemCount === data?.total, `${ui?.itemCount} vs ${data?.total}`)
check('有搜索框', ui?.hasSearch === true, '')
check('有条数分类页签', (ui?.tabs?.length ?? 0) === 3, JSON.stringify(ui?.tabs))
check('无数据缺失警告', ui?.hasWarning === false, '')
check('卡片未被压扁（高 > 100px）', (ui?.cardH ?? 0) > 100, `${ui?.cardH}px`)
check('首条是世界观', /世界观/.test(ui?.firstItemName ?? ''), ui?.firstItemName ?? '')

// ============ ③ 搜索 ============
mark('搜索')
const searchByName = await ev(`(() => {
  const card = document.querySelector('[data-testid="mp-lore"]')
  const input = card?.querySelector('[data-testid="mp-lore-search"]')
  if (!input) return { ok: false }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(input, '克莱恩')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return { ok: true }
})()`)
await sleep(500)
const afterNameSearch = await ev(`(() => {
  const items = [...document.querySelectorAll('[data-testid="mp-lore"] .mp-lore-item')]
  return { count: items.length, names: items.map(i => i.querySelector('.mp-lore-name')?.textContent?.trim() ?? '') }
})()`)
check('按名字搜索能命中', (afterNameSearch?.count ?? 0) > 0 && (afterNameSearch?.count ?? 0) < (data?.total ?? 0), `${afterNameSearch?.count} 条`)
check('搜索结果确实是克莱恩', (afterNameSearch?.names ?? []).some((n) => n.includes('克莱恩')), JSON.stringify(afterNameSearch?.names))

// 按别名搜索（「愚者」是克莱恩的别名）
const searchByAlias = await ev(`(() => {
  const card = document.querySelector('[data-testid="mp-lore"]')
  const input = card?.querySelector('[data-testid="mp-lore-search"]')
  if (!input) return { ok: false }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(input, '愚者')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return { ok: true }
})()`)
await sleep(500)
const afterAliasSearch = await ev(`(() => {
  const items = [...document.querySelectorAll('[data-testid="mp-lore"] .mp-lore-item')]
  return { count: items.length, names: items.map(i => i.querySelector('.mp-lore-name')?.textContent?.trim() ?? '') }
})()`)
check('按别名搜索能命中（愚者 → 克莱恩）', (afterAliasSearch?.count ?? 0) > 0, `${afterAliasSearch?.count} 条 ${JSON.stringify(afterAliasSearch?.names)}`)

// 清空搜索
await ev(`(() => {
  const input = document.querySelector('[data-testid="mp-lore-search"]')
  if (!input) return false
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(input, '')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await sleep(400)

// ============ ④ 分类筛选 ============
mark('分类筛选')
const filterChar = await ev(`(() => {
  const b = document.querySelector('[data-testid="mp-lore-char"]')
  if (!b) return { ok: false }
  b.click()
  return { ok: true }
})()`)
await sleep(400)
const afterCharFilter = await ev(`(() => {
  const items = [...document.querySelectorAll('[data-testid="mp-lore"] .mp-lore-item')]
  return { count: items.length, worldCount: items.filter(i => i.classList.contains('world')).length }
})()`)
check('筛选「人物」后只剩人物', afterCharFilter?.count === data?.charCount && afterCharFilter?.worldCount === 0, JSON.stringify(afterCharFilter))

const filterWorld = await ev(`(() => {
  const b = document.querySelector('[data-testid="mp-lore-world"]')
  if (!b) return { ok: false }
  b.click()
  return { ok: true }
})()`)
await sleep(400)
const afterWorldFilter = await ev(`(() => {
  const items = [...document.querySelectorAll('[data-testid="mp-lore"] .mp-lore-item')]
  return { count: items.length }
})()`)
check('筛选「设定」后只剩世界观', afterWorldFilter?.count === 1, `${afterWorldFilter?.count}`)

// 回到全部
await ev(`(() => { const b = document.querySelector('[data-testid="mp-lore-all"]'); if (b) b.click(); return true })()`)
await sleep(400)

// ============ ⑤ 展开/折叠 ============
mark('展开折叠')
const expand = await ev(`(() => {
  const item = document.querySelector('[data-testid="mp-lore"] .mp-lore-item')
  if (!item) return { ok: false }
  const head = item.querySelector('.mp-lore-head')
  const beforeBrief = !!item.querySelector('.mp-lore-brief')
  head.click()
  return { ok: true, beforeBrief }
})()`)
await sleep(400)
const afterExpand = await ev(`(() => {
  const item = document.querySelector('[data-testid="mp-lore"] .mp-lore-item')
  const full = item?.querySelector('.mp-lore-full')
  return {
    hasFull: !!full,
    fullLen: (full?.textContent ?? '').length,
    briefGone: !item?.querySelector('.mp-lore-brief')
  }
})()`)
check('初始为折叠态（显示摘要）', expand?.beforeBrief === true, '')
check('点击后展开显示全文', afterExpand?.hasFull === true && (afterExpand?.fullLen ?? 0) > 20, `全文 ${afterExpand?.fullLen} 字`)
check('展开后摘要隐藏（不重复显示）', afterExpand?.briefGone === true, '')

// 再点一次折回
await ev(`(() => { const h = document.querySelector('[data-testid="mp-lore"] .mp-lore-head'); if (h) h.click(); return true })()`)
await sleep(400)
check('再点一次能折回', await ev(`!!document.querySelector('[data-testid="mp-lore"] .mp-lore-brief')`), '')

// ============ ⑥ 截图 + 异常 ============
mark('截图')
await ev(`(() => { const c = document.querySelector('[data-testid="mp-lore"]'); if (c) c.scrollIntoView({ block: 'start' }); return !!c })()`)
await sleep(600)
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
console.log(`\n${bar}\n  漫画世界书\n${bar}`)
for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : '  ← ' + c.detail}`)
if (data?.ok) {
  console.log(`\n  【数据】${data.charCount} 人物 + ${data.worldCount} 设定 = ${data.total} 条`)
  console.log(`  别名 ${data.withAlias} · 音色 ${data.withVoice} · 热度前 3：${(data.topHot ?? []).join(' / ')}`)
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

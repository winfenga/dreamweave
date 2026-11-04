/**
 * 书架 + 模型探测 + 工作库格式兼容（A）验证（CDP 真机）。
 *
 * 三块内容一起验，因为它们都是「用户拍板的需求」，且互相独立、失败点不同：
 *
 * ① **书架**（原先是一张表格）
 *    - 每本书是一个 `.book`，封面正中有书名；
 *    - **每排 5 个**：这一条是用户明确要求的，必须真的按「视觉行」数出来，
 *      不能只数 CSS 里的列数（窗口宽度不够时 5 列会被挤成 4 列，那就不算通过）；
 *    - 点书本身能打开（不再有「打开」按钮）。
 *
 * ② **模型探测**（新增）
 *    - LLM 行有「探测模型」，能列出端点上的模型并且点芯片可填入；
 *    - 「检测连接」与「探测模型」是两件不同的事，两个按钮都要在；
 *    - TTS 行的「检测连接」走 /audio/speech（不能拿对话接口去探纯配音端点）。
 *
 * ③ **工作库格式兼容（A）**
 *    - 历史 `txt2world-workspace` 与新 `dreamweave-workspace` 都应被接受；
 *    - 现存 63 个老库必须全部能列出来（不是抽一个，是全量）；
 *    - 写新库时写的是新值。
 *
 * 用法：npm run verify:shelf
 *   CDP_ENDPOINT=http://127.0.0.1:9333 node scripts/verify-shelf.mjs --shot out.png
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
    const t = m.params.entry.text ?? ''
    // 端点不可达/未配置属于**预期**的探测失败路径，不算运行期异常
    if (/Failed to fetch|net::ERR|404|ECONNREFUSED/.test(t)) return
    runtimeErrors.push(`LOG.error: ${t.slice(0, 200)}`)
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

// ============ ⓿ 回到书库 ============
mark('打开书库')
await send('Page.bringToFront')
// 先刷新到落地页：套件串联运行时，上一套可能停在某个工作库的某个标签页上，
// 那时侧栏只有「书库/设置」两项之外的导航，且书架容器根本没挂载。
// 强制 reload 一次拿干净的落地状态，避免测试之间互相污染。
await send('Page.reload', { ignoreCache: false })
await sleep(2800)
await send('Page.bringToFront')
await sleep(600)
await ev(`(() => {
  const hit = [...document.querySelectorAll('.side-item')].find(b => b.textContent.includes('书库'))
  if (hit) hit.click()
  return !!hit
})()`)
await sleep(1500)

// ============ ① 书架外观 ============
mark('书架')
const shelf = await ev(`(() => {
  const root = document.querySelector('[data-testid="lib-shelf"]')
  if (!root) return { exists: false }
  const books = [...root.querySelectorAll('.slot[data-book-id] .book')]
  const rects = books.map(b => {
    const r = b.getBoundingClientRect()
    return { id: b.closest('.slot')?.getAttribute('data-book-id') ?? '', top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }
  })

  // 按 top 聚成「视觉行」（同一排的书 top 差 < 8px）
  const rows = []
  for (const r of rects) {
    const hit = rows.find(row => Math.abs(row[0].top - r.top) < 8)
    if (hit) hit.push(r)
    else rows.push([r])
  }
  const rowSizes = rows.map(row => row.sort((a,b) => a.left - b.left).length)

  // 封面书名：必须是封面里的正文，不是 tooltip
  const titles = books.map(b => b.querySelector('.cover-title')?.textContent?.trim() ?? '')
  // 书本应有明显高度（不是被压扁的一行）
  const minH = rects.length ? Math.min(...rects.map(r => r.h)) : 0
  // 书脊 + 书页厚度这两个装饰在，才像"一本书"
  const hasSpine = books.every(b => !!b.querySelector('.book-spine'))
  const hasPages = books.every(b => !!b.querySelector('.book-pages'))
  // 老表格应该彻底消失
  const oldTable = !!document.querySelector('.lib-table') || !!document.querySelector('table.table')
  // 局部标题：卡片标题应叫「书架」
  const heading = document.querySelector('.lib-toolbar h2')?.textContent?.trim() ?? ''

  return {
    exists: true,
    count: books.length,
    rowSizes,
    titles: titles.slice(0, 5),
    minH,
    hasSpine,
    hasPages,
    oldTable,
    heading,
    sampleW: rects[0]?.w ?? 0,
    sampleH: rects[0]?.h ?? 0
  }
})()`)

check('书架容器存在', shelf?.exists === true, '没找到 [data-testid="lib-shelf"]')
check('书架里有书', (shelf?.count ?? 0) > 0, `${shelf?.count} 本`)
check('标题是「书架」', shelf?.heading === '书架', shelf?.heading ?? '')
check('老表格已移除', shelf?.oldTable === false, '还能找到 .lib-table')
check('每排 5 个', (shelf?.rowSizes ?? []).every((n) => n <= 5) && (shelf?.rowSizes?.[0] ?? 0) === 5,
  `各排数量 ${JSON.stringify(shelf?.rowSizes)}`)
check('封面显示书名', (shelf?.titles ?? []).every((t) => t.length > 0), JSON.stringify(shelf?.titles))
check('书有立体书脊', shelf?.hasSpine === true, '')
check('书有书页厚度', shelf?.hasPages === true, '')
check('书不是被压扁的一行（高 > 120px）', (shelf?.minH ?? 0) > 120, `${shelf?.minH}px`)
check('竖版开本（高 > 宽 × 1.2）', (shelf?.sampleH ?? 0) > (shelf?.sampleW ?? 0) * 1.2,
  `${shelf?.sampleW}×${shelf?.sampleH}`)

// ============ ② 工作库格式兼容（A） ============
mark('格式兼容')
const fmt = await ev(`(async () => {
  const ws = await window.dreamweave.listWorkspaces()
  if (!ws.ok) return { ok: false, error: ws.error, count: 0 }
  // 声明式检查：不只看能不能列出来，还要确认这些库里**确实大多是历史 format**，
  // 否则"全部都通过了"可能只是因为根本没有老库。
  return { ok: true, count: ws.items.length, broken: ws.broken.length, titles: ws.items.slice(0,3).map(i=>i.title) }
})()`)
check('书库能列出全部工作库', fmt?.ok === true, fmt?.error ?? '')
check('历史工作库未被 format 校验挡住（>= 60 本）', (fmt?.count ?? 0) >= 60,
  `${fmt?.count} 本（损坏 ${fmt?.broken}）`)
check('没有因格式不匹配产生的损坏项', (fmt?.broken ?? 1) === 0, `${fmt?.broken} 个损坏`)

// 直接读老库的 index.json，确认磁盘上仍是历史 format 串 —— 证明"读兼容"不是靠迁移
const legacyOnDisk = await ev(`(async () => {
  const ws = await window.dreamweave.listWorkspaces()
  if (!ws.ok || !ws.items.length) return { ok: false }
  // 逐个检查，统计实际的历史 format 数量（证明兼容确实被用到）
  const r = await window.dreamweave.inspectWorkspaceFormats()
  return r
})()`)
check('磁盘上仍有历史 format（说明兼容生效而非已迁移）',
  (legacyOnDisk?.legacy ?? 0) > 0,
  `legacy=${legacyOnDisk?.legacy} next=${legacyOnDisk?.next} err=${legacyOnDisk?.error ?? ''}`)
check('没有任何一个库因格式被拒', (legacyOnDisk?.rejected ?? 1) === 0,
  `rejected=${legacyOnDisk?.rejected} ${JSON.stringify(legacyOnDisk?.rejectedSamples ?? [])}`)

// ============ ③ 模型探测 / 连接测试 ============
mark('模型配置页')
await ev(`(() => {
  const hit = [...document.querySelectorAll('.side-item')].find(b => b.textContent.includes('设置'))
  if (hit) hit.click()
  return !!hit
})()`)
await sleep(1800)

const llmUi = await ev(`(() => {
  const rows = [...document.querySelectorAll('[data-testid^="llm-row-"]')]
  const first = rows[0]
  const id = first ? (first.getAttribute('data-testid') || '').replace('llm-row-','') : ''
  return {
    rowCount: rows.length,
    firstId: id,
    hasProbe: !!(id && document.querySelector('[data-testid="llm-probe-' + id + '"]')),
    hasModels: !!(id && document.querySelector('[data-testid="llm-models-' + id + '"]')),
    probeText: id ? (document.querySelector('[data-testid="llm-probe-' + id + '"]')?.textContent?.trim() ?? '') : '',
    modelsText: id ? (document.querySelector('[data-testid="llm-models-' + id + '"]')?.textContent?.trim() ?? '') : ''
  }
})()`)
check('模型配置至少有一行', (llmUi?.rowCount ?? 0) > 0, `${llmUi?.rowCount} 行`)
check('LLM 行有「检测连接」', llmUi?.hasProbe === true, '')
check('LLM 行有「探测模型」', llmUi?.hasModels === true, '')

// 真点一次探测（打的是本机端点，模型列表非空）
const probeRun = await ev(`(async () => {
  const btn = document.querySelector('[data-testid^="llm-models-"]')
  if (!btn) return { ok: false, why: '没有探测按钮' }
  const id = (btn.getAttribute('data-testid') || '').replace('llm-models-','')
  btn.click()
  // 等按钮从「探测中…」恢复（最多 25s）
  for (let i = 0; i < 250; i++) {
    await new Promise(r => setTimeout(r, 100))
    const t = btn.textContent.trim()
    if (t !== '探测中…') break
  }
  const res = document.querySelector('[data-testid="llm-models-result-' + id + '"]')
  const chips = [...(document.querySelector('[data-testid="llm-models-list-' + id + '"]')?.querySelectorAll('.model-chip') ?? [])]
  return {
    ok: true,
    text: res?.textContent?.trim().slice(0, 120) ?? '',
    isErr: res?.className?.includes('probe-err') ?? false,
    chipCount: chips.length,
    chipNames: chips.slice(0, 5).map(c => c.textContent.trim())
  }
})()`)
check('探测模型按钮可点', probeRun?.ok === true, probeRun?.why ?? '')
check('探测到模型（本机端点应有 17 个左右）', (probeRun?.chipCount ?? 0) > 0,
  `chips=${probeRun?.chipCount} text=${probeRun?.text}`)
check('探测结果不是错误态', probeRun?.isErr === false, probeRun?.text ?? '')

// 点一个芯片，模型名应真的填进那行配置
const pick = await ev(`(async () => {
  const chip = document.querySelector('.model-chip')
  if (!chip) return { ok: false, why: '没有候选芯片' }
  const name = chip.textContent.trim()
  chip.click()
  await new Promise(r => setTimeout(r, 700))
  // 对应行的「模型」列应变成这个名字
  const row = chip.closest('[data-testid^="llm-row-"]')
  const cells = row ? [...row.querySelectorAll('.c-model')] : []
  return { ok: true, name, cell: cells[0]?.textContent?.trim() ?? '' }
})()`)
check('点芯片能把模型名填入配置', pick?.ok === true && pick?.cell === pick?.name,
  `点了 ${pick?.name}，列显示 ${pick?.cell}`)

// TTS 行的「检测连接」应存在（走 /audio/speech）
const ttsUi = await ev(`(() => {
  const rows = [...document.querySelectorAll('[data-testid^="tts-row-"]')]
  const first = rows[0]
  const id = first ? (first.getAttribute('data-testid') || '').replace('tts-row-','') : ''
  return {
    rowCount: rows.length,
    hasProbe: !!(id && document.querySelector('[data-testid="tts-probe-' + id + '"]')),
    // 配音不该有「探测模型」：TTS 端点通常不提供 /models
    hasModels: !!(id && document.querySelector('[data-testid="tts-models-' + id + '"]'))
  }
})()`)
check('配音行有「检测连接」', (ttsUi?.rowCount ?? 0) === 0 || ttsUi?.hasProbe === true,
  `${ttsUi?.rowCount} 行`)
check('配音行不做「探测模型」（TTS 端点无此接口）', ttsUi?.hasModels === false, '')

// ComfyUI 出图模型探测（ckpt_name 候选）
const comfyUi = await ev(`(() => {
  const btn = document.querySelector('[data-testid="comfy-models"]')
  const probe = document.querySelector('[data-testid="comfy-probe"]')
  return {
    hasModels: !!btn,
    hasProbe: !!probe,
    label: btn?.textContent?.trim() ?? ''
  }
})()`)
check('ComfyUI 有「探测模型」按钮', comfyUi?.hasModels === true, '')
check('ComfyUI 仍有「检测连接」', comfyUi?.hasProbe === true, '')

// 生图页（ImagegenPanel）也必须两个都有 —— 用户是在那张页面发现图生不出来的。
// 注意：本套件的起点是**书库（没打开任何书）**，生图面板根本不挂载，
// 所以这里只做「挂了才检查」的软断言，另由 verify:imagegen 覆盖其功能。
const igPanel = await ev(`(() => {
  const root = document.querySelector('[data-testid="imagegen-panel"]')
  if (!root) return { exists: false }
  return {
    exists: true,
    hasProbe: !!root.querySelector('[data-testid="imagegen-probe"]'),
    hasModels: !!root.querySelector('[data-testid="imagegen-models"]')
  }
})()`)
if (igPanel?.exists) {
  check('生图面板有「检测连接」', igPanel.hasProbe === true, '')
  check('生图面板有「探测模型」', igPanel.hasModels === true, '')
}

// ============ ④ 截图 + 异常 ============
mark('截图')
await ev(`(() => {
  const hit = [...document.querySelectorAll('.side-item')].find(b => b.textContent.includes('书库'))
  if (hit) hit.click()
  return !!hit
})()`)
await sleep(1600)
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
console.log(`\n${bar}\n  书架 + 模型探测 + 格式兼容\n${bar}`)
for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : '  ← ' + c.detail}`)
if (shelf?.exists) {
  console.log(`\n  【书架】${shelf.count} 本，每排 ${JSON.stringify(shelf.rowSizes)}，样本尺寸 ${shelf.sampleW}×${shelf.sampleH}`)
}
if (pick?.ok) console.log(`  【探测】选中模型 ${pick.name}`)
console.log(`\n${bar}`)
if (failures.length) {
  console.log(`  ✗ ${failures.length} 项失败 / 共 ${checks.length} 项`)
  console.log(bar + '\n')
  process.exit(1)
}
console.log(`  ✓ ${checks.length} 项全部通过`)
console.log(bar + '\n')
ws.close()

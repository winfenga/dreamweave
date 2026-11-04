/**
 * P4 特效系统 端到端验收（CDP 连真实渲染进程，非 mock）。
 *
 * 覆盖：
 *   ① 导入测试包副本（scratch，绝不动用户原始包）
 *   ② 切「📝 脚本修订」tab，选目标句；确认出现 data-testid="se-fx-block"
 *   ③ 手动挂载：拣选器搜 letterbox / tone-cold → 多选确定 → chips 出现 → 自动写回
 *   ④ 独立校验（不依赖应用自报）：备份存在；files[] path/size/sha256 逐一一致（二进制零改动）；
 *      仅目标动作新增 effects（其余 records 深相等）
 *   ⑤ 范围挂载：建「句区间」条目并写回；校对 effectRanges 在所有 storyScript 副本逐字相等
 *   ⑤b 漏斗顺序回归守卫：已有范围特效时再走一次纯单句挂载写回，
 *      effectRanges 必须原样保留（守卫 effects-edit.ts ranges 缺省值缺陷的复发）
 *   ⑥ AI 推荐：未配模型 → 按钮禁用 + 可读提示（不发请求）；已配 → 自动挂载 + 撤销
 *   ⑦ 演出页：目标句单句 letterbox + tone-cold 叠加可见（effect-layer 非空 / --fx-* 已写）；截图
 *   ⑧ 无特效句子回归：effect-layer 为空、.stage-bg 无 inline style（无 --fx-*）
 *   ⑨ 运行期异常 / console.error / 网络失败为 0
 *
 * 前置：npm run dev -- --remote-debugging-port=9222
 * 用法：node scripts/verify-p4.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import { computeOffsets, decodeHeader, sha256Hex } from '../src/main/t2w/core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(HERE, '..')

const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'
const PKG = process.env.P4_PKG ?? 'D:/AI/tx/2026-10-15-22-35-44/scratch/p3/test.t2w'
const DIR = PKG.slice(0, Math.max(PKG.lastIndexOf('/'), PKG.lastIndexOf('\\')))
const OUT_SHOT_STAGE = process.env.OUT_SHOT_STAGE ?? join(DIR, 'shot-p4-stage.png')
const OUT_SHOT_SCRIPT = process.env.OUT_SHOT_SCRIPT ?? join(DIR, 'shot-p4-script.png')
/** P4_PHASE=persist：真正杀掉 dev 进程重启后，只跑「挂载是否还在」的重开验收 */
const PHASE = process.env.P4_PHASE ?? 'main'

/** 稳定存在的目录 id（overlay / tone），不硬编码任何业务 id 前缀 */
const FX_OVERLAY = 'letterbox'
const FX_TONE = 'tone-cold'

// ------------------------------------------- 工作库取数（M1-T4：写回目标是分片，不是 .t2w）
/**
 * M1-T3 起写回目标已从「整包 .t2w」迁移为「工作库 storyScript 分片」，
 * 导入后 .t2w **不再被改写** —— 凡是基于 .t2w 比对的断言全部失真：
 * 要么恒真（写回什么都不做也会过），要么恒失败。
 * 本验收的取数源随之切换为「工作库装配出的 manifest」（设计 §7 M1-T4 验收口径 ③）。
 */
async function loadModule(entry) {
  const result = await build({
    entryPoints: [join(FEATHER, entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    external: ['node:*', 'electron'],
    logLevel: 'silent'
  })
  const code = result.outputFiles[0].text
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
}
const wsMod = await loadModule('src/main/workspace/index.ts')

const normPath = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '')

/**
 * 定位本次导入的工作库目录 —— **显式取应用当前会话打开的那一个**，不再做磁盘反查。
 *
 * 为什么不能按 `origin.t2wPath` 扫描反查：T1 之后同一来源包可并存多份副本
 * （同一个 .t2w 反复导入），而扫描是「匹配到第一个就返回」——一旦命中旧副本，
 * 就会出现「在 A 副本写回、却在 B 副本断言」的假阳性 / 超时。
 *
 * 唯一事实源是应用会话本身：`workspace:list` 已按**工作库目录**给出 `current` 标记。
 * 歧义（0 个或多个 current）一律**抛错**，绝不静默取第一个。
 */
async function resolveWorkspaceRoot() {
  const raw = await ev(`(async()=>{
    var r = await window.dreamweave.listWorkspaces()
    return JSON.stringify((r.items || []).filter(function (i) { return i.current }).map(function (i) { return i.root }))
  })()`)
  let roots = []
  try {
    roots = JSON.parse(raw)
  } catch {
    throw new Error(`listWorkspaces 返回不可解析：${String(raw).slice(0, 200)}`)
  }
  if (roots.length === 0) throw new Error('应用当前没有打开任何工作库，无法定位本次导入的目录')
  if (roots.length > 1) {
    throw new Error(`当前打开的工作库不唯一（${roots.length} 个），无法确定目标目录：${roots.join(', ')}`)
  }
  const root = roots[0]
  // 二次校验：确认真的是本次导入的那一本（防止会话正指向别的书）
  let idx
  try {
    idx = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8'))
  } catch (e) {
    throw new Error(`读取会话工作库索引失败（${root}）：${e.message}`)
  }
  if (normPath(idx.origin?.t2wPath) !== normPath(PKG)) {
    throw new Error(`会话指向的工作库来源包与测试包不一致\n  会话: ${idx.origin?.t2wPath}\n  测试包: ${PKG}`)
  }
  return root
}

/** 工作库根（① 导入成功后才能确定） */
let WS_ROOT = ''

/** 从工作库分片装配出与 readPkgMeta() **同形**的 {files, manifest} */
async function readWsMeta() {
  const index = await wsMod.readIndex(WS_ROOT)
  const manifest = await wsMod.assembleManifest(WS_ROOT, index)
  return {
    files: (manifest.files ?? []).map((f) => ({ path: f.path, size: f.size, sha: f.sha256 })),
    manifest
  }
}
/** 工作库所有分片文件的 sha256（P0-24「不写盘」的等价判据） */
async function shardHashes() {
  const index = await wsMod.readIndex(WS_ROOT)
  const out = {}
  for (const s of index.shards) {
    out[s.file] = createHash('sha256').update(readFileSync(join(WS_ROOT, s.file))).digest('hex')
  }
  return out
}

// ---------------------------------------------------------------- 结果统计
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}
function section(t) {
  console.log('\n=== ' + t + ' ===')
}

// ---------------------------------------------------------------- CDP 连接
const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
if (!page) {
  console.error('找不到 page 目标，/json/list =', JSON.stringify(list).slice(0, 400))
  process.exit(2)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const runtimeErrors = []
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
  if (r.exceptionDetails) {
    throw new Error('EV: ' + JSON.stringify(r.exceptionDetails).slice(0, 900) + ' || expr=' + expr.slice(0, 200))
  }
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function poll(fn, done, timeout, label) {
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < timeout) {
    last = await fn()
    if (done(last)) return last
    await sleep(350)
  }
  throw new Error(`TIMEOUT ${label} last=${JSON.stringify(last)?.slice(0, 240)}`)
}
/** 非抛出轮询：超时返回 false（用于「可能不发生」的等待，例如模型随机返回空特效，不适合直接 FATAL）。 */
async function waitFor(expr, timeout) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await ev(expr)) return true
    await sleep(400)
  }
  return false
}
const shot = async (path) => {
  await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  await sleep(400)
  const s = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(path, Buffer.from(s.data, 'base64'))
  return statSync(path).size
}
/** 等待特效区块退出 busy（写回中禁用态）：避免乐观更新后按钮仍 disabled 时点击落空 */
async function waitIdle() {
  await sleep(400)
  await poll(
    () => ev(`(() => { const b = document.querySelector('[data-testid=se-fx-add]'); return b ? b.disabled : true })()`),
    (d) => d === false,
    300000,
    'fx-idle'
  )
}

// ---------------------------------------------------------------- 独立二进制/清单校验
function readPkgMeta(p) {
  const buf = readFileSync(p)
  const h = decodeHeader(buf)
  const offsets = computeOffsets(h.manifest.files, h.blobStart)
  const files = h.manifest.files.map((f, i) => ({
    path: f.path,
    size: f.size,
    sha: sha256Hex(buf.subarray(offsets[i], offsets[i] + f.size))
  }))
  return { size: buf.length, files, manifest: h.manifest }
}
function asEntries(node) {
  if (Array.isArray(node)) return node.filter((e) => e && typeof e === 'object' && typeof e.key === 'string')
  if (node && typeof node === 'object') return Object.entries(node).map(([key, value]) => ({ key, value }))
  return []
}
/** 所有 storyScript 副本的 [{key, data}]（不过滤 :batch:） */
function storyDataList(manifest) {
  const out = []
  for (const { key: k, value: v } of asEntries((manifest.records || {}).results)) {
    if (!k.includes(':storyScript')) continue
    const d = v && typeof v === 'object' && v.data && typeof v.data === 'object' ? v.data : v
    out.push({ key: k, data: d })
  }
  return out
}
/** 两份成员清单逐一比对（path/size/sha256） */
function sameFileList(a, b) {
  if (a.length !== b.length) return false
  return a.every((f, i) => f.path === b[i].path && f.size === b[i].size && f.sha === b[i].sha)
}
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const countBackups = () => readdirSync(DIR).filter((f) => /^test\.backup-\d{8}-\d{6}\.t2w$/.test(f)).length

// ---------------------------------------------------------------- 启动
await send('Page.enable')
await send('Runtime.enable')
await send('Log.enable')
await send('Network.enable')
await send('Page.reload', { ignoreCache: false })
await sleep(2500)
await send('Page.bringToFront')
await sleep(600)

const originalSize = statSync(PKG).size
console.log('测试包:', PKG, (originalSize / 1048576).toFixed(1) + 'MB')

// ---------------------------------------------------------------- ① 导入
section('① 导入测试包副本')
const imp = await ev(`(async()=>{
  const r = await window.dreamweave.importPackage(${JSON.stringify(PKG)})
  if (!r.ok) return r
  const i = document.querySelector('#app').__vue_app__._instance
  i.setupState.summary = r.summary
  i.setupState.view = null
  i.setupState.viewError = ''
  i.setupState.tab = 'overview'
  return { ok: r.ok, title: r.summary && r.summary.project.title, verify: r.summary && r.summary.verify }
})()`)
check('importPackage 成功', !!imp && imp.ok, imp ? `${imp.title ?? ''} verify=${JSON.stringify(imp.verify)}` : 'null')
if (!imp || !imp.ok) {
  console.error('导入失败，终止')
  process.exit(1)
}
WS_ROOT = await resolveWorkspaceRoot()
console.log('  工作库根:', WS_ROOT)
// 原始包 pristine 参照：M1-T4 起导入后 .t2w 永不被改写，可作「工作库保真」的黄金基准
const pkgMeta = readPkgMeta(PKG)
console.log('  原始包成员数:', pkgMeta.files.length)

// ------------------------------------------------ ①b 重开应用后挂载仍在（P4_PHASE=persist）
// 用法：主跑结束后**真正杀掉 dev 进程再重启**（Page.reload 不算重开），然后
//   P4_PHASE=persist node scripts/verify-p4.mjs
// 由外部负责杀/起进程，本脚本只做重启后的挂载存在性断言，避免脚本自己管进程。
if (PHASE === 'persist') {
  section('①b 重开应用后：特效挂载仍在')
  const persisted = await readWsMeta()
  await ev(`(() => { const b = [...document.querySelectorAll('.tabs button')].find(x => x.textContent.includes('脚本修订')); if (!b) throw new Error('找不到脚本修订 tab'); b.click(); return true })()`)
  await poll(() => ev(`document.querySelectorAll('[data-testid=se-list] .se-item').length`), (n) => n > 0, 60000, 'se-items')
  const pTarget = await ev(`(() => {
    const v = document.querySelector('#app').__vue_app__._instance.setupState.view
    if (!v) return null
    const ch0 = v.chapters[0].chapterSeq
    for (let i = 0; i < v.actions.length; i++) {
      const a = v.actions[i]
      if (a.chapterSeq !== ch0) continue
      if (a.type !== 'say' && a.type !== 'think' && a.type !== 'narration') continue
      if ((a.text || '').length < 4) continue
      return { idx: i, chapterSeq: a.chapterSeq, order: a.order, type: a.type, text: a.text }
    }
    return null
  })()`)
  check('重开后仍能定位到同一句', !!pTarget, pTarget ? `#${pTarget.idx + 1} ${pTarget.type} order=${pTarget.order}` : '未找到')
  if (!pTarget) process.exit(1)
  await ev(`document.querySelector('[data-testid=se-item-${pTarget.idx}]').click()`)
  await poll(() => ev(`!!document.querySelector('[data-testid=se-fx-block]')`), (v) => v, 20000, 'se-fx-block')
  const pChips = Number(await ev(`document.querySelector('[data-testid=se-fx-count]').textContent`))
  check('重开应用后：单句特效 chips 仍在（≥2）', pChips >= 2, `chips=${pChips}`)
  const pRanges = Number(await ev(`(() => { const v=document.querySelector('#app').__vue_app__._instance.setupState.view; return v&&Array.isArray(v.effectRanges)?v.effectRanges.length:-1 })()`))
  check('重开应用后：范围特效仍在（≥1）', pRanges >= 1, `ranges=${pRanges}`)
  // 独立取数（不依赖 UI / 不依赖应用自报）：工作库分片里确实还有 effects
  const wsActs = []
  for (const { key, data } of storyDataList(persisted.manifest)) {
    for (let i = 0; i < (data.actions?.length ?? 0); i++) wsActs.push({ key, i, a: data.actions[i] })
  }
  const wsTarget = wsActs.find(
    (x) => x.a.chapterSeq === pTarget.chapterSeq && x.a.order === pTarget.order && x.a.type === pTarget.type
  )
  check(
    '重开应用后：工作库分片内目标句 effects 仍持有（≥2）',
    !!wsTarget && Array.isArray(wsTarget.a.effects) && wsTarget.a.effects.length >= 2,
    wsTarget ? `effects=${wsTarget.a.effects?.length ?? 0}` : '未定位到目标动作'
  )
  const wsRanges = storyDataList(persisted.manifest).map((s) => s.data?.effectRanges)
  const wsRangesHit = wsRanges.filter(Array.isArray)
  check('重开应用后：工作库分片内 effectRanges 仍持有（≥1 副本）', wsRangesHit.length >= 1 && wsRangesHit[0].length >= 1, `副本=${wsRangesHit.length} 条数=${wsRangesHit[0]?.length ?? 0}`)
  check('重开应用后：运行期异常为 0', runtimeErrors.filter((s) => !/favicon/i.test(s)).length === 0, runtimeErrors.slice(0, 2).join(' | '))
  const pFailed = results.filter((r) => !r.ok)
  console.log(`\n${pFailed.length === 0 ? '🎉 P4 ①b「重开应用仍在」全部通过' : '💥 P4 ①b 有 ' + pFailed.length + ' 项未过'}（共 ${results.length} 项）`)
  process.exit(pFailed.length === 0 ? 0 : 1)
}

// ---------------------------------------------------------------- ② 脚本修订 tab
section('② 切到「📝 脚本修订」tab')
await ev(`(() => { const b = [...document.querySelectorAll('.tabs button')].find(x => x.textContent.includes('脚本修订')); if (!b) throw new Error('找不到脚本修订 tab'); b.click(); return true })()`)
await poll(() => ev(`document.querySelectorAll('[data-testid=se-list] .se-item').length`), (n) => n > 0, 60000, 'se-items')

// 目标句：第 1 章第一条 say/think/narration
const target = await ev(`(() => {
  const v = document.querySelector('#app').__vue_app__._instance.setupState.view
  if (!v) return null
  const ch0 = v.chapters[0].chapterSeq
  for (let i = 0; i < v.actions.length; i++) {
    const a = v.actions[i]
    if (a.chapterSeq !== ch0) continue
    if (a.type !== 'say' && a.type !== 'think' && a.type !== 'narration') continue
    if ((a.text || '').length < 4) continue
    return { idx: i, chapterSeq: a.chapterSeq, order: a.order, type: a.type, text: a.text, locationId: a.locationId }
  }
  return null
})()`)
check('找到目标句', !!target, target ? `#${target.idx + 1} ${target.type} order=${target.order}` : '未找到')
if (!target) {
  console.error('没有可用目标句，终止')
  process.exit(1)
}
await ev(`document.querySelector('[data-testid=se-item-${target.idx}]').click()`)
await poll(() => ev(`!!document.querySelector('[data-testid=se-fx-block]')`), (v) => v, 20000, 'se-fx-block')
check('编辑面板出现 data-testid="se-fx-block"', true)

// 清掉该句已有特效，保证确定性（重复运行可复现）
const curCount = await ev(`Number(document.querySelector('[data-testid=se-fx-count]').textContent)`)
if (curCount > 0) {
  await ev(`document.querySelector('[data-testid=se-fx-clear]').click()`)
  await poll(() => ev(`Number(document.querySelector('[data-testid=se-fx-count]').textContent)`), (n) => n === 0, 300000, 'clear-effects')
  await waitIdle()
}
await waitIdle()

// 挂载前快照工作库（等价原「备份 = 写回前状态」的基线）
const before = await readWsMeta()
console.log(`  工作库快照 before：成员 ${before.files.length} / storyScript 副本 ${storyDataList(before.manifest).length}`)

// ---------------------------------------------------------------- ③ 手动挂载
section('③ 手动挂载 letterbox + tone-cold')
const tMountStart = Date.now()
await ev(`document.querySelector('[data-testid=se-fx-add]').click()`)
await poll(() => ev(`!!document.querySelector('[data-testid=fx-picker]')`), (v) => v, 10000, 'picker-open')
const setInput = (sel, val) => ev(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)})
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, ${JSON.stringify(val)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return el.value
})()`)
await setInput('[data-testid=fx-picker-search]', FX_OVERLAY)
await sleep(200)
const hasOverlay = await ev(`!!document.querySelector('[data-testid=fx-picker-item-${FX_OVERLAY}]')`)
check(`选择器可搜到 ${FX_OVERLAY}`, hasOverlay)
await ev(`document.querySelector('[data-testid=fx-picker-item-${FX_OVERLAY}]').click()`)
await setInput('[data-testid=fx-picker-search]', FX_TONE)
await sleep(200)
const hasTone = await ev(`!!document.querySelector('[data-testid=fx-picker-item-${FX_TONE}]')`)
check(`选择器可搜到 ${FX_TONE}`, hasTone)
await ev(`document.querySelector('[data-testid=fx-picker-item-${FX_TONE}]').click()`)
await ev(`document.querySelector('[data-testid=fx-picker-confirm]').click()`)
const elapsedMountMs = Date.now() - tMountStart
console.log(`  ⏱ 单句端到端耗时（点「+特效」→ 拣选/确定 → 落盘+复检+chips 刷新）: ${elapsedMountMs} ms (${(elapsedMountMs / 1000).toFixed(2)} s)`)
const chipCount = await poll(
  () => ev(`Number(document.querySelector('[data-testid=se-fx-count]').textContent)`),
  (n) => n >= 2,
  300000,
  'chips'
)
check('chips 数 ≥ 2（手动挂载成功）', chipCount >= 2, `${chipCount}`)
const srcTags = await ev(`[...document.querySelectorAll('[data-testid=se-fx-source]')].map(e => e.textContent.trim())`)
check('chip 带来源角标（含「手动」）', srcTags.includes('手动'), srcTags.join(','))

// 写回后 renderer view 必须原地刷新（App.reloadView）：否则演出页会拿到陈旧 mounts
const vfx = await poll(
  () =>
    ev(`(() => { const v=document.querySelector('#app').__vue_app__._instance.setupState.view; const a=v&&v.actions[${target.idx}]; return a&&Array.isArray(a.effects)?a.effects.length:-1 })()`),
  (n) => n >= 2,
  180000,
  'view-refresh-fx'
)
check('写回后 renderer view 刷新（actions[idx].effects ≥ 2）', vfx >= 2, String(vfx))

// ---------------------------------------------------------------- ④ 写回反馈 + 独立校验
section('④ 写回反馈 + 独立二进制/清单校验')
const fmsg = await poll(
  () => ev(`(() => { const e = document.querySelector('[data-testid=se-message]'); return e ? e.textContent : '' })()`),
  (t) => !!t && (t.includes('已写回特效') || t.includes('失败') || t.includes('没有定位到')),
  300000,
  'fx-se-message'
)
console.log('  se-message:', fmsg)
check('写回反馈文案区分「已写回特效」', fmsg.includes('已写回特效'), fmsg.slice(0, 140))
const mPass = fmsg.match(/复检\s*(\d+)\/(\d+)/)
check('成员级复检全过', !!mPass && mPass[1] === mPass[2] && !fmsg.includes('校验失败'), mPass ? `${mPass[1]}/${mPass[2]}` : '未匹配')
check('反馈含备份路径', fmsg.includes('.backup-') && fmsg.includes('.t2w'))

const backups = readdirSync(DIR).filter((f) => /^test\.backup-\d{8}-\d{6}\.t2w$/.test(f)).sort()
check('同目录生成备份文件', backups.length >= 1, backups.slice(-2).join(', '))
const backupPath = join(DIR, backups[backups.length - 1])
const backupSize = statSync(backupPath).size
check('备份与原包同大小', backupSize === originalSize, `${(backupSize / 1048576).toFixed(1)}MB vs 原 ${(originalSize / 1048576).toFixed(1)}MB`)

// ---- 取数源：工作库装配出的 manifest（after = 挂载写回后）----
const after = await readWsMeta()
const fileDiffs = []
if (after.files.length !== before.files.length || after.files.length !== pkgMeta.files.length) {
  fileDiffs.push(`成员数 前=${before.files.length} 后=${after.files.length} 原包=${pkgMeta.files.length}`)
}
for (let i = 0; i < Math.max(before.files.length, after.files.length, pkgMeta.files.length); i++) {
  const o = before.files[i]
  const n = after.files[i]
  const p = pkgMeta.files[i]
  if (!o || !n || o.path !== n.path || o.size !== n.size || o.sha !== n.sha) {
    fileDiffs.push(`写回改动了成员 ${i}: ${o?.path}/${o?.size} -> ${n?.path}/${n?.size} sha${o?.sha === n?.sha ? '=' : '≠'}`)
    continue
  }
  if (!p || p.path !== n.path || p.size !== n.size || p.sha !== n.sha) {
    fileDiffs.push(`工作库与原包不符 ${i}: ${p?.path}/${p?.size} -> ${n?.path}/${n?.size} sha${p?.sha === n.sha ? '=' : '≠'}`)
  }
}
check('所有二进制成员 path/size/sha256 逐一一致（写回零改动 + 工作库与原包保真）', fileDiffs.length === 0, fileDiffs.slice(0, 3).join(' | '))

// 仅目标动作新增 effects（其余 records 深相等）—— 取数源：工作库 before / after
const oldActs = []
const newActs = []
for (const { key, data } of storyDataList(before.manifest)) {
  for (let i = 0; i < (data.actions?.length ?? 0); i++) oldActs.push({ key, i, a: data.actions[i] })
}
for (const { key, data } of storyDataList(after.manifest)) {
  for (let i = 0; i < (data.actions?.length ?? 0); i++) newActs.push({ key, i, a: data.actions[i] })
}
let changed = 0
let wrong = 0
for (let i = 0; i < newActs.length; i++) {
  const o = oldActs[i]
  const n = newActs[i]
  if (o && sameJson(o.a, n.a)) continue
  const isTarget =
    o &&
    o.key === n.key &&
    o.i === n.i &&
    n.a.chapterSeq === target.chapterSeq &&
    n.a.order === target.order &&
    n.a.type === target.type &&
    Array.isArray(n.a.effects) &&
    n.a.effects.length >= 2 &&
    !(o.a.effects && o.a.effects.length)
  if (isTarget) changed++
  else wrong++
}
check('仅目标句新增 effects，其余动作深相等', changed >= 1 && wrong === 0, `changed=${changed} wrong=${wrong}`)

const oldRes = asEntries((before.manifest.records || {}).results)
const newResMap = new Map(asEntries((after.manifest.records || {}).results).map((e) => [e.key, e.value]))
const recDiff = []
for (const o of oldRes) {
  if (o.key.includes(':storyScript')) continue
  if (!newResMap.has(o.key)) recDiff.push('missing ' + o.key)
  else if (!sameJson(o.value, newResMap.get(o.key))) recDiff.push(o.key)
}
check('非 storyScript 记录深相等（未被触碰）', recDiff.length === 0, recDiff.slice(0, 3).join(','))

// §④b 定位不中：不备份、不写盘、返回可读错误（P0-24）
// M1-T4：写回目标已迁到分片，「不写盘」的判据相应改为**工作库分片字节不变**
// （来源包 .t2w 现在本就永不被改写，拿它比对已无判别力）
const shardHashBefore = await shardHashes()
const pkgHashBefore = sha256File(PKG)
const backupsBefore = countBackups()
const miss = await ev(`(async () => {
  const r = await window.dreamweave.saveEffects({ sentence: { chapterSeq: 999999, order: 999999, type: 'no-such-type', effects: [{ effectId: '${FX_OVERLAY}', source: 'manual' }] } })
  return { ok: r.ok, error: r.error || '' }
})()`)
check('三元键未命中：返回可读错误', miss.ok === false && /没有定位到/.test(miss.error), miss.error.slice(0, 80))
check('三元键未命中：不生成备份', countBackups() === backupsBefore, `before=${backupsBefore}`)
const shardHashAfter = await shardHashes()
const changedShards = Object.keys(shardHashAfter).filter((f) => shardHashBefore[f] !== shardHashAfter[f])
check('三元键未命中：工作库分片字节完全不变（不写盘）', changedShards.length === 0, changedShards.slice(0, 3).join(', '))
check(
  '来源包 .t2w 未被改写（M1-T4 迁移契约：导入后永不再写整包）',
  sha256File(PKG) === pkgHashBefore
)

// §④c 写回后整包可读 + 成员级 sha256 全过（独立复算，不依赖应用自报）
const idxNow = await wsMod.readIndex(WS_ROOT)
const assetFail = []
let assetPass = 0
for (const a of idxNow.assets) {
  try {
    const bytes = readFileSync(join(WS_ROOT, a.store))
    if (createHash('sha256').update(bytes).digest('hex') === a.sha256) assetPass++
    else assetFail.push(a.path)
  } catch {
    assetFail.push(`${a.path}（读取失败）`)
  }
}
const shardFail = []
let shardPass = 0
for (const s of idxNow.shards) {
  try {
    const bytes = readFileSync(join(WS_ROOT, s.file))
    JSON.parse(bytes.toString('utf8'))
    createHash('sha256').update(bytes).digest('hex') === s.sha256 ? shardPass++ : shardFail.push(s.file)
  } catch {
    shardFail.push(`${s.file}（JSON 损坏）`)
  }
}
check(
  '写回后整包可读：所有分片 JSON 可解析且 sha256 与 index 一致',
  shardFail.length === 0 && shardPass === idxNow.shards.length,
  `${shardPass}/${idxNow.shards.length}${shardFail.length ? ' ' + shardFail.slice(0, 2).join(',') : ''}`
)
check(
  '写回后成员级 sha256 全过：全部资产可读且哈希一致',
  assetFail.length === 0 && assetPass === idxNow.assets.length,
  `${assetPass}/${idxNow.assets.length}${assetFail.length ? ' ' + assetFail.slice(0, 2).join(',') : ''}`
)
check('写回后来源包 .t2w 仍可解析（导入契约未破）', decodeHeader(readFileSync(PKG)).manifest.files.length === pkgMeta.files.length)

try {
  console.log('  脚本修订页截图 bytes:', await shot(OUT_SHOT_SCRIPT), '→', OUT_SHOT_SCRIPT)
} catch (e) {
  console.log('  （脚本页截图失败：' + e.message + '）')
}

// ---------------------------------------------------------------- ⑤ 范围挂载
section('⑤ 范围挂载（句区间）并校验多副本一致')
// 先清掉既有范围条目，保证探针可重复运行
for (let guard = 0; guard < 8; guard++) {
  const n = await ev(`document.querySelectorAll('[data-testid=se-fx-range-item]').length`)
  if (!n) break
  await ev(`document.querySelector('[data-testid=se-fx-range-item] .fx-chip-x').click()`)
  await poll(
    () => ev(`document.querySelectorAll('[data-testid=se-fx-range-item]').length`),
    (m) => m === n - 1,
    300000,
    'range-clear'
  )
  await waitIdle()
}
// 选「句区间」模式，区间取目标句 order .. order+2
await ev(`(() => { const b = [...document.querySelectorAll('.fx-range-builder .chip-btn')].find(x => x.textContent.includes('句区间')); if (b) b.click(); return true })()`)
const setNum = (sel, val) => ev(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)})
  if (!el) return false
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, String(${JSON.stringify(val)}))
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await setNum('[data-testid=se-fx-range-start]', target.order)
await setNum('[data-testid=se-fx-range-end]', target.order + 2)
await ev(`document.querySelector('[data-testid=se-fx-add-range]').click()`)
await poll(() => ev(`!!document.querySelector('[data-testid=fx-picker]')`), (v) => v, 10000, 'range-picker')
await setInput('[data-testid=fx-picker-search]', 'grayscale')
await sleep(200)
const rangeFxId = (await ev(`(() => { const b = document.querySelector('[data-testid^=fx-picker-item-]'); return b ? b.getAttribute('data-testid').replace('fx-picker-item-','') : '' })()`)) || 'tone-grayscale'
await ev(`document.querySelector('[data-testid=fx-picker-item-${rangeFxId}]').click()`)
await ev(`document.querySelector('[data-testid=fx-picker-confirm]').click()`)
await poll(
  () => ev(`document.querySelectorAll('[data-testid=se-fx-range-item]').length`),
  (n) => n >= 1,
  300000,
  'range-item'
)
check('范围条目出现', true, `effectId=${rangeFxId}`)

const rmsg = await poll(
  () => ev(`(() => { const e = document.querySelector('[data-testid=se-message]'); return e ? e.textContent : '' })()`),
  (t) => !!t && (t.includes('已写回范围特效') || t.includes('失败')),
  300000,
  'range-se-message'
)
console.log('  se-message(range):', rmsg)
check('范围写回成功', rmsg.includes('已写回范围特效'), rmsg.slice(0, 140))

// 写回后 renderer view 必须原地刷新（范围列表）
const vrg = await poll(
  () =>
    ev(`(() => { const v=document.querySelector('#app').__vue_app__._instance.setupState.view; return v&&Array.isArray(v.effectRanges)?v.effectRanges.length:-1 })()`),
  (n) => n >= 1,
  180000,
  'view-refresh-range'
)
check('写回后 renderer view 刷新（effectRanges 非空）', vrg >= 1, String(vrg))

// 独立校验：所有 storyScript 副本 data.effectRanges 逐字相等（取数源：工作库）
const rangeWs = await readWsMeta()
const ssData = storyDataList(rangeWs.manifest)
const rangesPerCopy = ssData.map((s) => s.data?.effectRanges)
const copiesWithField = rangesPerCopy.filter((r) => Array.isArray(r))
const firstJson = copiesWithField.length ? JSON.stringify(copiesWithField[0]) : 'null'
const allEqual = copiesWithField.every((r) => JSON.stringify(r) === firstJson)
check(
  'effectRanges 在所有 storyScript 副本逐字相等',
  copiesWithField.length >= 1 && allEqual,
  `副本=${ssData.length} 含字段=${copiesWithField.length} 条数=${copiesWithField[0]?.length ?? 0}`
)

// -------------------------------------------------- ⑤b 漏斗顺序回归守卫
/**
 * 守卫的回归（2026-10-16 修复，见 commit 00cf277）：
 * `effects-edit.ts` 曾把 `payload.ranges` 的缺省值写成 `[]` 而非 `null`，于是
 * **只传 sentence、不传 ranges** 的写回（= `EffectBlock.writeSentence` 的真实形态）
 * 会把 `data.effectRanges` 覆写成 `[]`，**静默清空用户已挂载的全部范围特效**。
 *
 * 既有流程是「③ 单句挂载 → ⑤ 范围挂载」，永远碰不到这条路径（⑤ 之后不再触发单句写），
 * 所以在⑤末尾补这一段：**先有范围特效 → 再走一次纯单句写回 → effectRanges 必须原样保留**。
 * 放在此处而非改 ③/⑤ 的顺序，是为了不破坏既有 36 项的任何语义。
 */
section('⑤b 漏斗顺序回归：已有范围特效时再挂单句，effectRanges 不得被清空')
const rangesBefore = copiesWithField[0] ?? []
// 刻意写成 3 个特效：使这次纯单句写回的**落盘结果可被观测**（原为 2 个）
const fxTriplet = [
  { effectId: FX_OVERLAY, source: 'manual' },
  { effectId: FX_TONE, source: 'manual' },
  { effectId: rangeFxId, source: 'manual' }
]
await ev(`(async () => {
  await window.dreamweave.saveEffects({
    sentence: { chapterSeq: ${target.chapterSeq}, order: ${target.order}, type: ${JSON.stringify(target.type)}, effects: ${JSON.stringify(fxTriplet)} }
  })
  return true
})()`)

/** 直读工作库：目标句当前 effects 条数（-1 = 未找到该动作） */
async function targetEffectsOf(t) {
  const m = await readWsMeta()
  let n = -1
  for (const { data } of storyDataList(m.manifest)) {
    for (const a of data.actions ?? []) {
      if (a.chapterSeq === t.chapterSeq && a.order === t.order && t.type === a.type) {
        n = Array.isArray(a.effects) ? a.effects.length : 0
      }
    }
  }
  return n
}
const effectsAfterFunnel = await poll(
  () => targetEffectsOf(target),
  (n) => n === fxTriplet.length,
  300000,
  'sentence-effects-after-funnel'
)

const funnelWs = await readWsMeta()
const funnelRanges = storyDataList(funnelWs.manifest).map((s) => s.data?.effectRanges).filter(Array.isArray)
check(
  '⑤b 纯单句挂载（不传 ranges）后 effectRanges 未被清空',
  rangesBefore.length >= 1 &&
    funnelRanges.length >= 1 &&
    JSON.stringify(funnelRanges[0]) === JSON.stringify(rangesBefore),
  `before=${rangesBefore.length} 条 -> after=${funnelRanges[0]?.length ?? '无'} 条`
)
check(
  '⑤b 该次纯单句挂载确实落盘（目标句 effects 由 2 变 3，证明受守卫路径已被走到）',
  effectsAfterFunnel === fxTriplet.length,
  `effects=${effectsAfterFunnel}（期望 ${fxTriplet.length}）`
)

// ---------------------------------------------------------------- ⑥ AI 推荐
section('⑥ AI 推荐（未配模型 → 禁用+提示；已配 → 自动挂载 + 撤销）')
// Step1 收敛后：模型配置唯一真源 = llm[] + activeLlmId（经 getProviders）。
// 原探针读旧单组字段 s.baseURL/apiKey/model，已与新真源错位（verify-pipeline/qa 断言「全新安装预置 3 条」
// ⇒ 默认即有可用配置，探针恒走「已配」分支）。为**不丢覆盖**，下面先用夹具把「未配模型 → 禁用+报错」
// 分支真实走一遍，再还原真源走「已配 → 挂载+撤销」分支；两条分支都被测到。
// 只动「相对真源的判据」这一处，§⑥ 原有分支体内的业务断言（挂载/撤销/提示）一字不动。
/** 强制 EffectBlock 重挂载：ScriptEditor 上 EffectBlock :key=selectedGlobal，换句即换 key → onMounted 重读 getProviders。 */
async function remountFxBlock() {
  await ev(`(() => {
    const items = [...document.querySelectorAll('[data-testid=se-list] .se-item')]
    const other = items.find((x) => !x.classList.contains('active'))
    if (!other) throw new Error('无其它句可切换以触发 EffectBlock 重挂载')
    other.click()
    return true
  })()`)
  await poll(() => ev(`!!document.querySelector('[data-testid=se-fx-block]')`), (v) => v, 20000, 'fx-remount-alt')
  await ev(`document.querySelector('[data-testid=se-item-${target.idx}]').click()`)
  await poll(() => ev(`!!document.querySelector('[data-testid=se-fx-block]')`), (v) => v, 20000, 'fx-remount-back')
  await sleep(200)
}
// (a) 夹具：临时构造「无可用 provider」→ 未配分支（禁用 + 可读提示 + suggestEffects 不发请求即报错）。
const providerSnapshot = await ev(`(async () => {
  const ps = await window.dreamweave.getProviders()
  return { llm: ps.llm || [], tts: ps.tts || [], activeLlmId: ps.activeLlmId, activeTtsId: ps.activeTtsId, fallbackChain: ps.fallbackChain || [] }
})()`)
await ev(`(async () => { await window.dreamweave.saveProviders({ llm: [], tts: [], activeLlmId: '', activeTtsId: '', fallbackChain: [] }); return true })()`)
await remountFxBlock()
const fxAiDisabled = await ev(`!!document.querySelector('[data-testid=se-fx-ai]').disabled`)
const fxAiTitle = await ev(`document.querySelector('[data-testid=se-fx-ai]').getAttribute('title') || ''`)
check('未配模型（夹具）：AI 按钮禁用', fxAiDisabled)
check('未配模型（夹具）：给出可读提示', /未配置模型接入/.test(fxAiTitle), fxAiTitle.slice(0, 80))
const fxAiSug = await ev(`(async () => { const r = await window.dreamweave.suggestEffects({ text: '测试' }); return { ok: r.ok, error: r.error } })()`)
check('未配模型（夹具）：suggestEffects 立即返回可读错误（不发请求）', !!fxAiSug && fxAiSug.ok === false && /未配置模型接入/.test(fxAiSug.error ?? ''), (fxAiSug && fxAiSug.error) || '')
// 无论上面结果如何都还原真实 provider，避免污染后续章节
await ev(`(async () => { await window.dreamweave.saveProviders(${JSON.stringify(providerSnapshot)}); return true })()`)
await remountFxBlock()
// (b) 真源判定 → 「已配 → 挂载+撤销」分支。
const settings = await ev(`(async () => {
  const ps = await window.dreamweave.getProviders()
  const l = ps.llm || []
  const a = l.find(p => p.id === ps.activeLlmId) || l.find(p => p.enabled) || l[0]
  return { ready: !!(a && a.enabled && a.baseURL && a.apiKey && a.model) }
})()`)
if (!settings.ready) {
  const aiDisabled = await ev(`!!document.querySelector('[data-testid=se-fx-ai]').disabled`)
  const title = await ev(`document.querySelector('[data-testid=se-fx-ai]').getAttribute('title') || ''`)
  check('未配模型：AI 按钮禁用', aiDisabled)
  check('未配模型：给出可读提示', /未配置模型接入/.test(title), title.slice(0, 80))
  const sug = await ev(`(async () => { const r = await window.dreamweave.suggestEffects({ text: '测试' }); return { ok: r.ok, error: r.error } })()`)
  check('未配模型：suggestEffects 立即返回可读错误（不发请求）', !!sug && sug.ok === false && /未配置模型接入/.test(sug.error ?? ''), (sug && sug.error) || '')
} else {
  const before = await ev(`Number(document.querySelector('[data-testid=se-fx-count]').textContent)`)
  // 可用分支依赖聚合服务 + 模型输出：模型对本句偶发返回 {"effects":[]}（前端提示「模型未推荐任何特效」）——
  // 这是**模型随机性**而非代码缺陷（实测同一句 3 次调用得 0/2/2 条）。故此处**有界重试**（最多 5 次），
  // 任一次得到撤销条即进入原有业务断言；**通过标准不降低**：5 次均无撤销条则如实判失败（不静默跳过）。
  let gotUndo = false
  let attempts = 0
  for (; attempts < 5 && !gotUndo; attempts++) {
    await ev(`document.querySelector('[data-testid=se-fx-ai]').click()`)
    gotUndo = await waitFor(`!!document.querySelector('[data-testid=se-fx-undo]')`, 120000)
    if (!gotUndo) await sleep(600)
  }
  check(
    'AI 推荐（可用分支）：真机调用后出现撤销条',
    gotUndo,
    gotUndo ? `尝试 ${attempts} 次` : '5 次尝试均未出现撤销条（模型连续返回空特效/服务波动）'
  )
  if (gotUndo) {
    const afterAi = await ev(`Number(document.querySelector('[data-testid=se-fx-count]').textContent)`)
    check('AI 自动挂载后 chips 出现且可撤销', afterAi >= before, `${before} -> ${afterAi}`)
    await ev(`document.querySelector('[data-testid=se-fx-undo]').click()`)
    await poll(
      () => ev(`Number(document.querySelector('[data-testid=se-fx-count]').textContent)`),
      (n) => n === before,
      300000,
      'ai-undo-count'
    )
    check('撤销恢复挂载前状态', true)
  }
}

// ---------------------------------------------------------------- ⑦ 演出页单句叠加
section('⑦ 演出页：单句 letterbox + tone-cold 叠加')
await ev(`(() => { const b = [...document.querySelectorAll('.tabs button')].find(x => x.textContent.includes('视觉演出')); if (!b) throw new Error('找不到视觉演出 tab'); b.click(); return true })()`)
await poll(() => ev(`!!document.querySelector('[data-testid=stage]')`), (v) => v, 30000, 'stage-mount')
await ev(`(async () => {
  const qa = (s) => [...document.querySelectorAll(s)]
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const v = document.querySelector('#app').__vue_app__._instance.setupState.view
  let acc = 0, ci = 0
  for (; ci < v.chapters.length; ci++) { if (acc + v.chapters[ci].count > ${target.idx}) break; acc += v.chapters[ci].count }
  const off = ${target.idx} - acc
  qa('.chapter-pills .pill-btn')[ci].click()
  await sleep(350)
  const next = qa('.stage-controls .btn').find(b => b.textContent.includes('下一句'))
  const prev = qa('.stage-controls .btn').find(b => b.textContent.includes('上一句'))
  for (let k = 0; k < off; k++) { next.click(); if (k % 50 === 0) await sleep(10) }
  await sleep(300)
  // 强制一次换句再回来：保证目标句特效从 t=0 重新起播（规避「挂载时刻已起播并过期」的时间窗）
  next.click(); await sleep(150); prev.click(); await sleep(150)
  return true
})()`)
const fxInfo = await poll(
  () =>
    ev(`(async () => {
      const layer = document.querySelector('[data-testid=effect-layer]')
      const bg = document.querySelector('[data-testid=stage-bg]')
      return {
        layerChildren: layer ? layer.children.length : -1,
        hasVars: bg ? /--fx-/.test(bg.getAttribute('style') || '') : false,
        style: bg ? (bg.getAttribute('style') || '') : ''
      }
    })()`),
  (r) => r && r.layerChildren > 0,
  20000,
  'fx-single'
)
check('单句特效：effect-layer 出现自有节点', fxInfo.layerChildren > 0, `children=${fxInfo.layerChildren}`)
check('单句特效：.stage-bg 写入 --fx-*（tone 合成）', fxInfo.hasVars, fxInfo.style.slice(0, 120))
try {
  console.log('  演出页截图 bytes:', await shot(OUT_SHOT_STAGE), '→', OUT_SHOT_STAGE)
} catch (e) {
  console.log('  （演出页截图失败：' + e.message + '）')
}

// ---------------------------------------------------------------- ⑧ 无特效句子回归
section('⑧ 无特效句子回归（effect-layer 空 + .stage-bg 无 inline style）')
const cleanIdx = await ev(`(() => {
  const v = document.querySelector('#app').__vue_app__._instance.setupState.view
  const last = v.chapters[v.chapters.length - 1]
  const chLast = last ? last.chapterSeq : (v.chapters[0] ? v.chapters[0].chapterSeq : 0)
  for (let i = 0; i < v.actions.length; i++) {
    const a = v.actions[i]
    if (a.chapterSeq !== chLast) continue
    if ((a.effects || []).length) continue
    return i
  }
  return -1
})()`)
if (cleanIdx < 0) {
  check('存在无特效句子可供回归', false, '未找到')
} else {
  await ev(`(async () => {
    const qa = (s) => [...document.querySelectorAll(s)]
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const v = document.querySelector('#app').__vue_app__._instance.setupState.view
    let acc = 0, ci = 0
    for (; ci < v.chapters.length; ci++) { if (acc + v.chapters[ci].count > ${cleanIdx}) break; acc += v.chapters[ci].count }
    const off = ${cleanIdx} - acc
    qa('.chapter-pills .pill-btn')[ci].click()
    await sleep(350)
    const next = qa('.stage-controls .btn').find(b => b.textContent.includes('下一句'))
    for (let k = 0; k < off; k++) { next.click(); if (k % 50 === 0) await sleep(10) }
    await sleep(600)
    return true
  })()`)
  const clean = await ev(`(() => {
    const layer = document.querySelector('[data-testid=effect-layer]')
    const bg = document.querySelector('[data-testid=stage-bg]')
    return {
      layerChildren: layer ? layer.children.length : -1,
      style: bg ? (bg.getAttribute('style') || '') : 'x',
      hasVars: bg ? /--fx-/.test(bg.getAttribute('style') || '') : true
    }
  })()`)
  check('无特效句子：effect-layer 为空', clean.layerChildren === 0, `children=${clean.layerChildren}`)
  check('无特效句子：.stage-bg 无 inline style / 无 --fx-*', !clean.hasVars && clean.style === '', `style=${JSON.stringify(clean.style)}`)
}

// ---------------------------------------------------------------- ⑨ 运行期异常
section('⑨ 运行期异常')
const noise = (s) => /favicon|net::ERR_FILE_NOT_FOUND.*favicon/i.test(s)
check('运行期异常 / console.error 为 0', runtimeErrors.filter((s) => !noise(s)).length === 0, runtimeErrors.filter((s) => !noise(s)).slice(0, 3).join(' | '))
check('网络层失败为 0', netFailures.length === 0, netFailures.slice(0, 3).join(' | '))

// ---------------------------------------------------------------- 汇总
section('汇总')
const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}`)
console.log(`\n${failed.length === 0 ? '🎉 P4 全部通过' : '💥 P4 有 ' + failed.length + ' 项未过'}（共 ${results.length} 项）`)
console.log(`⏱ 单句端到端耗时（挂载写回：点击→拣选确定→落盘+复检+chips 刷新）: ${elapsedMountMs} ms (${(elapsedMountMs / 1000).toFixed(2)} s)`)
console.log(`📦  M1-T4 取数源：工作库分片 ${WS_ROOT}（M1-T3 起导入后 .t2w 不再被改写）`)
console.log('ℹ️  ①b「重开应用仍在」需另有一步：杀掉 dev 进程后重启，再跑 P4_PHASE=persist node scripts/verify-p4.mjs')
process.exit(failed.length === 0 ? 0 : 1)

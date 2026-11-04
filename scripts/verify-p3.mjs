/**
 * P3 脚本修订 端到端验收（CDP 连真实渲染进程，非 mock）。
 *
 * 覆盖：
 *   ① 导入测试包（scratch 副本，绝不动用户原始包）
 *   ② 切「📝 脚本修订」tab，选中一句，改文本，点「写回原包」
 *   ③ 断言 se-message：已写回 + 备份路径 + 复检 X/X 通过（failed=0）
 *   ④ 独立校验（不依赖应用自报）：备份文件存在且与原包同大小；
 *      files[] 每个成员 path/size/sha256 逐一比对（二进制零改动）；
 *      storyScript 记录里只有目标句文本变为新值，其余记录深平等
 *   ⑤ renderer 侧：写回后 getView 刷新，actions[idx].text === 新文本
 *   ⑥ 演出页：跳到该句，舞台文本出现新文本（用户视角最终生效）
 *   ⑦ 还原：把文本改回原值再写回一次，终态与原包内容一致（剩两份备份）
 *   ⑧ 运行期异常 / console.error 为 0
 *
 * 前置：npm run dev -- --remote-debugging-port=9222
 * 用法：node scripts/verify-p3.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { computeOffsets, decodeHeader, sha256Hex } from '../src/main/t2w/core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(HERE, '..')

const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'
const PKG = process.env.P3_PKG ?? 'D:/AI/tx/2026-10-15-22-35-44/scratch/p3/test.t2w'
const DIR = PKG.slice(0, Math.max(PKG.lastIndexOf('/'), PKG.lastIndexOf('\\')))
const OUT_SHOT_SCRIPT = process.env.OUT_SHOT_SCRIPT ?? join(DIR, 'shot-script-editor.png')
const OUT_SHOT_STAGE = process.env.OUT_SHOT_STAGE ?? join(DIR, 'shot-stage-after-edit.png')
const MARKER = '【P3实测】'

// ------------------------------------------- 工作库取数（M1-T4：写回目标是分片，不是 .t2w）
/**
 * M1-T3 起写回目标已从「整包 .t2w」迁移为「工作库 storyScript 分片」，
 * 导入后 .t2w **不再被改写** —— 凡是基于 .t2w 比对的断言全部失真（恒真）。
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
    var r = await window.feather.listWorkspaces()
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

/** 从工作库分片装配出与 readPkgMeta() **同形**的 {files, manifest}（三个 helper 一行不改） */
async function readWsMeta() {
  const index = await wsMod.readIndex(WS_ROOT)
  const manifest = await wsMod.assembleManifest(WS_ROOT, index)
  return {
    files: (manifest.files ?? []).map((f) => ({ path: f.path, size: f.size, sha: f.sha256 })),
    manifest
  }
}

/** 两份成员清单逐一比对（path/size/sha256） */
function sameFileList(a, b) {
  if (a.length !== b.length) return false
  return a.every((f, i) => f.path === b[i].path && f.size === b[i].size && f.sha === b[i].sha)
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
  if (r.exceptionDetails) throw new Error('EV: ' + JSON.stringify(r.exceptionDetails).slice(0, 900) + ' || expr=' + expr.slice(0, 200))
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function poll(fn, done, timeout, label) {
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < timeout) {
    last = await fn()
    if (done(last)) return last
    await sleep(400)
  }
  throw new Error(`TIMEOUT ${label} last=${JSON.stringify(last)?.slice(0, 200)}`)
}
const shot = async (path) => {
  await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  await sleep(500)
  const s = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(path, Buffer.from(s.data, 'base64'))
  return statSync(path).size
}

// ---------------------------------------------------------------- 独立二进制校验
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
/** records.results 容器统一成 [{key,value}]（数组直接用；对象则 Object.entries 映射） */
function asEntries(node) {
  if (Array.isArray(node)) return node.filter((e) => e && typeof e === 'object' && typeof e.key === 'string')
  if (node && typeof node === 'object') return Object.entries(node).map(([key, value]) => ({ key, value }))
  return []
}
function storyActions(manifest) {
  const out = []
  // 导航与产品侧/view.ts 一致：storyScript 记录在 manifest.records.results 内；
  // 不过滤 ':batch:'（写回要保持包内所有副本一致）
  for (const { key: k, value: v } of asEntries((manifest.records || {}).results)) {
    if (!k.includes(':storyScript')) continue
    const d = v && typeof v === 'object' && v.data && typeof v.data === 'object' ? v.data : v
    if (Array.isArray(d.actions)) d.actions.forEach((a, i) => out.push({ key: k, i, a }))
  }
  return out
}
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---------------------------------------------------------------- 启动
await send('Page.enable')
await send('Runtime.enable')
await send('Log.enable')
await send('Network.enable')
await send('Page.reload', { ignoreCache: false })
await sleep(2500)
await send('Page.bringToFront')
await sleep(600)
console.log('visibility:', await ev('document.visibilityState'))

const originalSize = statSync(PKG).size
console.log('测试包:', PKG, (originalSize / 1048576).toFixed(1) + 'MB')

// ---------------------------------------------------------------- ① 导入
section('① 导入测试包副本')
const imp = await ev(`(async()=>{
  const r = await window.feather.importPackage(${JSON.stringify(PKG)})
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
// 导入后才存在/可复用的工作库 → 解析一次，全程复用
WS_ROOT = await resolveWorkspaceRoot()
console.log('  工作库根:', WS_ROOT)
// 原始包 pristine 参照：M1-T4 起导入后 .t2w 永不被改写，可作「工作库保真」的黄金基准
const pkgMeta = readPkgMeta(PKG)
console.log('  原始包成员数:', pkgMeta.files.length)

// ---------------------------------------------------------------- ② 切脚本修订 tab
section('② 切到「📝 脚本修订」tab')
await ev(`(() => { const b = [...document.querySelectorAll('.tabs button')].find(x => x.textContent.includes('脚本修订')); if (!b) throw new Error('找不到脚本修订 tab'); b.click(); return true })()`)
await poll(
  () => ev(`document.querySelectorAll('[data-testid=se-list] .se-item').length`),
  (n) => n > 0,
  60000,
  'se-items'
)
const itemCount = await ev(`document.querySelectorAll('[data-testid=se-list] .se-item').length`)
check('脚本修订页加载，句子列表非空', itemCount > 0, `${itemCount} 句`)

// ---------------------------------------------------------------- ③ 选目标句
section('③ 选中目标句并修改')
const target = await ev(`(() => {
  const v = document.querySelector('#app').__vue_app__._instance.setupState.view
  if (!v) return null
  const ch0 = v.chapters[0].chapterSeq
  const pass = (min, max) => {
    for (let i = 0; i < v.actions.length; i++) {
      const a = v.actions[i]
      if (a.chapterSeq !== ch0) continue
      if (a.type !== 'say' && a.type !== 'think' && a.type !== 'narration') continue
      const t = a.text || ''
      if (t.length < min || t.length > max) continue
      return { idx: i, chapterSeq: a.chapterSeq, order: a.order, type: a.type, text: t }
    }
    return null
  }
  return pass(8, 60) || pass(6, 400)
})()`)
check('找到目标句（第 1 章对白/心声/旁白）', !!target, target ? `#${target.idx + 1} ${target.type} order=${target.order} ${target.text.length}字` : '未找到')
if (!target) {
  console.error('没有可用目标句，终止')
  process.exit(1)
}
const NEW_TEXT = target.text + MARKER

await ev(`document.querySelector('[data-testid=se-item-${target.idx}]').click()`)
await sleep(300)
const taBefore = await ev(`document.querySelector('[data-testid=se-textarea]').value`)
check('点击列表项后文本框载入原文本', taBefore === target.text, `${taBefore.slice(0, 30)}…`)

const setTa = (text) => ev(`(() => {
  const ta = document.querySelector('[data-testid=se-textarea]')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, ${JSON.stringify(text)})
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  return ta.value.length
})()`)
await setTa(NEW_TEXT)
await sleep(200)
const dirtyEnabled = await ev(`!document.querySelector('[data-testid=se-save]').disabled`)
check('文本改动后「写回原包」按钮可用', dirtyEnabled)

// ---------------------------------------------------------------- ④ 写回
// 写回前先快照工作库（等价原「备份 = 写回前状态」的基线；top-hash 不依赖备份文件）
const before = await readWsMeta()
console.log(`  工作库快照 before：成员 ${before.files.length} / storyScript 动作 ${storyActions(before.manifest).length} 条`)

section('④ 点击「写回原包」')
const tWriteStart = Date.now()
await ev(`document.querySelector('[data-testid=se-save]').click()`)
const msg = await poll(
  () => ev(`(() => { const e = document.querySelector('[data-testid=se-message]'); return e ? e.textContent : '' })()`),
  (t) => !!t && (t.includes('已写回') || t.includes('失败') || t.includes('没有定位到')),
  300000,
  'se-message'
)
const elapsedWriteMs = Date.now() - tWriteStart
console.log(`  ⏱ 单句端到端耗时（点击「写回原包」→ 落地 + 复检 + 反馈）: ${elapsedWriteMs} ms (${(elapsedWriteMs / 1000).toFixed(2)} s)`)
console.log('  se-message:', msg)
check('写回成功（消息含「已写回」）', msg.includes('已写回'), msg.slice(0, 160))
const mPass = msg.match(/复检\s*(\d+)\/(\d+)/)
check('成员级复检全过', !!mPass && mPass[1] === mPass[2] && !msg.includes('校验失败'), mPass ? `${mPass[1]}/${mPass[2]}` : '未匹配到复检信息')
check('消息含备份路径', msg.includes('.backup-') && msg.includes('.t2w'))

// ---------------------------------------------------------------- ⑤ 独立校验
section('⑤ 独立校验：工作库分片 + 二进制成员（不依赖应用自报）')
const backups = readdirSync(DIR).filter((f) => /^test\.backup-\d{8}-\d{6}\.t2w$/.test(f)).sort()
check('同目录生成备份文件', backups.length >= 1, backups.join(', '))
const backupPath = join(DIR, backups[backups.length - 1])
const backupSize = statSync(backupPath).size
check('备份与原包同大小', backupSize === originalSize, `${(backupSize / 1048576).toFixed(1)}MB vs 原 ${(originalSize / 1048576).toFixed(1)}MB`)

// ---- 取数源：工作库装配出的 manifest（after = 写回后）----
const after = await readWsMeta()
const fileDiffs = []
if (after.files.length !== before.files.length || after.files.length !== pkgMeta.files.length) {
  fileDiffs.push(`成员数 前=${before.files.length} 后=${after.files.length} 原包=${pkgMeta.files.length}`)
}
for (let i = 0; i < Math.max(before.files.length, after.files.length, pkgMeta.files.length); i++) {
  const b = before.files[i]
  const n = after.files[i]
  const p = pkgMeta.files[i]
  // ① 写回不得改动任何成员（工作库视角）
  if (!b || !n || b.path !== n.path || b.size !== n.size || b.sha !== n.sha) {
    fileDiffs.push(`写回改动了成员 ${i}: ${b?.path}/${b?.size} -> ${n?.path}/${n?.size} sha${b?.sha === n?.sha ? '=' : '≠'}`)
    continue
  }
  // ② 工作库资产必须与原包逐条保真（内容寻址 ⇄ files[] 一一对应）
  if (!p || p.path !== n.path || p.size !== n.size || p.sha !== n.sha) {
    fileDiffs.push(`工作库与原包不符 ${i}: ${p?.path}/${p?.size} -> ${n?.path}/${n?.size} sha${p?.sha === n?.sha ? '=' : '≠'}`)
  }
}
check('所有二进制成员 path/size/sha256 逐一一致（写回零改动 + 工作库与原包保真）', fileDiffs.length === 0, fileDiffs.slice(0, 3).join(' | '))
check(
  'files[] 成员数量一致（工作库 vs 原包）',
  before.files.length === pkgMeta.files.length && after.files.length === pkgMeta.files.length,
  `${after.files.length} 个`
)

const oldActs = storyActions(before.manifest)
const newActs = storyActions(after.manifest)
check('storyScript 动作条数一致', oldActs.length === newActs.length, `${newActs.length} 条`)
const changed = []
const wrongChange = []
for (let i = 0; i < newActs.length; i++) {
  const o = oldActs[i]
  const n = newActs[i]
  if (sameJson(o, n)) continue
  const isTarget =
    o.key === n.key &&
    o.i === n.i &&
    n.a.chapterSeq === target.chapterSeq &&
    n.a.order === target.order &&
    n.a.type === target.type &&
    n.a.text === NEW_TEXT &&
    o.a.text === target.text
  if (isTarget) changed.push(`${n.key}[${n.i}]`)
  else wrongChange.push(`${n.key}[${n.i}]: ${JSON.stringify(o.a.text).slice(0, 40)} -> ${JSON.stringify(n.a.text).slice(0, 40)}`)
}
check('恰好只有目标句文本变为新值', changed.length >= 1 && wrongChange.length === 0, `changed=${changed.length} wrong=${wrongChange.length}`)

const oldRec = before.manifest.records || {}
const newRec = after.manifest?.records || {}
const otherDiff = []
// ① records 顶层除 'results' 外的键：集合一致且逐一深相等
const oldTopKeys = Object.keys(oldRec).filter((k) => k !== 'results').sort()
const newTopKeys = Object.keys(newRec).filter((k) => k !== 'results').sort()
if (JSON.stringify(oldTopKeys) !== JSON.stringify(newTopKeys)) {
  otherDiff.push(`顶层 records 键集合变化: ${JSON.stringify(oldTopKeys)} -> ${JSON.stringify(newTopKeys)}`)
}
for (const k of oldTopKeys) {
  if (!sameJson(oldRec[k], newRec[k])) otherDiff.push(k)
}
// ② 'results' 容器：长度相等 + key 不含 ':storyScript' 的条目逐一深相等
//    （key 含 ':storyScript' 的条目交给上面的动作级比对，此处不重复）
const oldRes = asEntries(oldRec.results)
const newRes = asEntries(newRec.results)
const newResMap = new Map(newRes.map((e) => [e.key, e.value]))
if (oldRes.length !== newRes.length) {
  otherDiff.push(`results 长度 ${oldRes.length} -> ${newRes.length}`)
}
for (const o of oldRes) {
  if (!newResMap.has(o.key)) {
    otherDiff.push(`results 缺条目 ${o.key}`)
    continue
  }
  if (o.key.includes(':storyScript')) continue
  if (!sameJson(o.value, newResMap.get(o.key))) otherDiff.push(`results ${o.key}`)
}
check('其余 records 深平等（未被触碰）', otherDiff.length === 0, `diff=${otherDiff.slice(0, 3).join(',')}`)

// 截图：脚本修订页（含成功消息与新文本）
try {
  console.log('  脚本修订页截图 bytes:', await shot(OUT_SHOT_SCRIPT), '→', OUT_SHOT_SCRIPT)
} catch (e) {
  console.log('  （脚本页截图失败：' + e.message + '）')
}

// ---------------------------------------------------------------- ⑥ renderer 刷新
section('⑥ 写回后渲染模型刷新')
const refreshed = await poll(
  () => ev(`(() => { const v = document.querySelector('#app').__vue_app__._instance.setupState.view; return v && v.actions[${target.idx}] ? v.actions[${target.idx}].text : null })()`),
  (t) => t === NEW_TEXT,
  120000,
  'view-refresh'
)
check('getView 刷新后 actions[idx].text === 新文本', refreshed === NEW_TEXT, refreshed ? refreshed.slice(-24) : 'null')

// ---------------------------------------------------------------- ⑦ 演出页生效
section('⑦ 演出页显示新文本')
await ev(`(() => { const b = [...document.querySelectorAll('.tabs button')].find(x => x.textContent.includes('视觉演出')); if (!b) throw new Error('找不到视觉演出 tab'); b.click(); return true })()`)
await poll(() => ev(`!!document.querySelector('[data-testid=stage]')`), (v) => v, 30000, 'stage-mount')
const nav = await ev(`(async () => {
  const qa = (s) => [...document.querySelectorAll(s)]
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const v = document.querySelector('#app').__vue_app__._instance.setupState.view
  let acc = 0, ci = 0
  for (; ci < v.chapters.length; ci++) { if (acc + v.chapters[ci].count > ${target.idx}) break; acc += v.chapters[ci].count }
  const off = ${target.idx} - acc
  qa('.chapter-pills .pill-btn')[ci].click()
  await sleep(350)
  const next = qa('.stage-controls .btn').find(b => b.textContent.includes('下一句'))
  for (let k = 0; k < off; k++) { next.click(); if (k % 50 === 0) await sleep(10) }
  await sleep(450)
  return { chapterIdx: ci, offset: off }
})()`)
console.log('  navTo:', JSON.stringify(nav))
let stageText = ''
try {
  stageText = await poll(
    () => ev(`(() => { const e = document.querySelector('[data-testid=stage-text]'); return e ? e.textContent : '' })()`),
    (t) => t.includes(MARKER),
    25000,
    'stage-text'
  )
} catch {
  // 打字机还没播完：点一下对话框直接显全
  await ev(`document.querySelector('.stage-textbox').click()`)
  stageText = await poll(
    () => ev(`(() => { const e = document.querySelector('[data-testid=stage-text]'); return e ? e.textContent : '' })()`),
    (t) => t.includes(MARKER),
    15000,
    'stage-text-after-click'
  )
}
check('演出页舞台文本包含新文本', stageText.includes(MARKER), stageText.includes(MARKER) ? `…${stageText.slice(-26)}` : stageText.slice(0, 60))
try {
  console.log('  演出页截图 bytes:', await shot(OUT_SHOT_STAGE), '→', OUT_SHOT_STAGE)
} catch (e) {
  console.log('  （演出页截图失败：' + e.message + '）')
}

// ---------------------------------------------------------------- ⑧ 还原
section('⑧ 还原文本（再写回一次，终态与原包一致）')
await ev(`(() => { const b = [...document.querySelectorAll('.tabs button')].find(x => x.textContent.includes('脚本修订')); b.click(); return true })()`)
await sleep(600)
await ev(`document.querySelector('[data-testid=se-item-${target.idx}]').click()`)
await sleep(300)
await setTa(target.text)
await sleep(200)
await ev(`document.querySelector('[data-testid=se-save]').click()`)
const msg2 = await poll(
  () => ev(`(() => { const e = document.querySelector('[data-testid=se-message]'); return e ? e.textContent : '' })()`),
  (t) => !!t && (t.includes('已写回') || t.includes('失败')),
  300000,
  'se-message-restore'
)
console.log('  se-message(还原):', msg2)
check('还原写回成功', msg2.includes('已写回'), msg2.slice(0, 120))

const restoredView = await poll(
  () => ev(`(() => { const v = document.querySelector('#app').__vue_app__._instance.setupState.view; return v && v.actions[${target.idx}] ? v.actions[${target.idx}].text : null })()`),
  (t) => t === target.text,
  120000,
  'view-restore'
)
check('还原后 actions[idx].text === 原文本', restoredView === target.text)

// 终态工作库 vs 写回前快照：必须逐字节回到原状（还原精确性）
// 同时校验「工作库 ⇄ 原始包」保真：M1-T4 下 .t2w 恒不变，终态应仍等于原始包
const finalWs = await readWsMeta()
// 注意：这里**不**拿终态 storyScript 去比原始包 —— P4 会把特效挂载合法地留在工作库里
// （这正是 M1-T4 迁移的意义：工作库本来就该与来源包在可编辑内容上发散）。
// 二进制资产是内容寻址的、任何编辑都不触碰，所以上面的 files[] 保真比对依然成立。
const finalFilesOk = sameFileList(finalWs.files, before.files) && sameFileList(finalWs.files, pkgMeta.files)
check('终态二进制成员与写回前 / 原始包完全一致', finalFilesOk)
const finalActs = storyActions(finalWs.manifest)
const finalActsOk =
  finalActs.length === oldActs.length && finalActs.every((n, i) => sameJson(n, oldActs[i]))
check('终态 storyScript 与写回前深相等（还原精确）', finalActsOk)

// ---------------------------------------------------------------- ⑨ 运行期异常
section('⑨ 运行期异常')
const noise = (s) => /favicon|net::ERR_FILE_NOT_FOUND.*favicon/i.test(s)
check('运行期异常 / console.error 为 0', runtimeErrors.filter((s) => !noise(s)).length === 0, runtimeErrors.filter((s) => !noise(s)).slice(0, 3).join(' | '))
check('网络层失败为 0', netFailures.length === 0, netFailures.slice(0, 3).join(' | '))

// ---------------------------------------------------------------- 汇总
section('汇总')
const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}`)
console.log(`\n${failed.length === 0 ? '🎉 P3 全部通过' : '💥 P3 有 ' + failed.length + ' 项未过'}（共 ${results.length} 项）`)
console.log(`⏱ 单句端到端耗时（写回→落地+复检+反馈）: ${elapsedWriteMs} ms (${(elapsedWriteMs / 1000).toFixed(2)} s)`)
console.log(`📦  M1-T4 取数源：工作库分片 ${WS_ROOT}（M1-T3 起导入后 .t2w 不再被改写）`)
process.exit(failed.length === 0 ? 0 : 1)

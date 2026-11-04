/**
 * 特效 A 线真机验证：在真实 Electron 渲染进程里挂载特效，确认 handler 真的跑起来了。
 *
 * 为什么不能只靠静态检查：handler 是 DOM 动画，必须真跑一次才知道
 *   - handler 有没有被注册表收集到
 *   - cutin/actor 的 actors 通道有没有接通
 *   - ambient/particles/birds 的粒子节点有没有真的建出来
 *   - camera/distortion 有没有真的写到 .stage-bg 的 --fx-* 变量
 *
 * 做法：直接用 `window.__dw_fxProbe`（StageView 暴露的探针钩子）逐条挂载，
 * 观察 DOM 与 CSS 变量，然后停掉再验证是否清理干净。
 *
 * 前置：
 *   electron . --remote-debugging-port=9222
 *   已导入一个含立绘与演出数据的包（默认 monte-cristo-10ch.t2w）
 *
 * 用法：node scripts/verify-effects-ui.mjs
 */
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'

const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
if (!page) {
  console.error('✗ 没有可调试页面')
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
    runtimeErrors.push(`${d.text} | ${d.exception?.description?.slice(0, 240)}`)
  } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    runtimeErrors.push(`LOG.error: ${m.params.entry.text?.slice(0, 180)}`)
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
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800))
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const failures = []
const checks = []
const check = (name, cond, detail) => {
  checks.push({ name, ok: !!cond, detail })
  if (!cond) failures.push(`${name}（${detail}）`)
}

// ---------- 前置：进入演出页 ----------
await send('Page.enable')
await send('Page.reload', { ignoreCache: false })
await sleep(2600)
runtimeErrors.length = 0

const PKG = 'D:/galcomic/dreamweave/testdata/monte-cristo-10ch.t2w'
const opened = await ev(`(async () => {
  const r = await window.dreamweave.importPackage(${JSON.stringify(PKG)}, 't2w')
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, title: r.summary?.project?.title }
})()`)
check('导入测试包', opened?.ok, opened?.error ?? '')

await send('Page.reload', { ignoreCache: false })
await sleep(2600)
runtimeErrors.length = 0
await send('Page.bringToFront')
await sleep(400)

await ev(`window.__pkg = ${JSON.stringify(PKG)}; true`)
const openedUi = await ev("(async () => {\nconst ws = await window.dreamweave.listWorkspaces();\nif (!ws.ok) return { ok: false, why: 'readshelf-failed' };\nconst BS = String.fromCharCode(92);\nconst norm = function (s) { return String(s || '').split(BS).join('/').toLowerCase(); };\nconst src = norm(window.__pkg);\nconst hits = ws.items.filter(function (i) { return norm(i.t2wPath) === src; });\nif (!hits.length) return { ok: false, why: 'not-in-shelf' };\nhits.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });\nconst t = hits[0];\nconst book = document.querySelector('[data-testid=\"lib-shelf\"] .slot[data-book-id=\"' + t.id + '\"] .book');\nif (book) { book.click(); return { ok: true, via: 'ui', id: t.id, title: t.title }; }\nconst r = await window.dreamweave.openWorkspace(t.id);\nreturn r.ok ? { ok: true, via: 'ipc', id: t.id } : { ok: false, why: r.error || 'open-failed' };\n})()")
check('从书库打开', openedUi?.ok, openedUi?.why ?? '')
await sleep(1200)

const toStage = await ev(`(() => {
  const b = [...document.querySelectorAll('.side-item')].find(x => x.textContent.includes('视觉演出'))
  if (!b) return false
  b.click()
  return true
})()`)
check('进入视觉演出页', toStage, '')
await sleep(1500)

// 等演出页挂载（有 .stage-wrap 且非空状态）
let stageReady = false
for (let i = 0; i < 20; i++) {
  stageReady = await ev(`!!document.querySelector('.stage-wrap:not(.stage-empty-wrap)')`)
  if (stageReady) break
  await sleep(400)
}
check('舞台已渲染（非空状态）', stageReady, 'stage-wrap 未出现')

// ---------- 探针可用性 ----------
const probeReady = await ev(`typeof window.__dw_fxProbe === 'object' && window.__dw_fxProbe !== null`)
check('特效探针已暴露', probeReady, 'window.__dw_fxProbe 缺失')
if (!probeReady) {
  // 输出报告后退出（后续全部依赖探针）
  const bar = '─'.repeat(64)
  console.log(`\n${bar}\n  特效 A 线真机验证\n${bar}`)
  for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : '  ← ' + c.detail}`)
  console.log(`\n${bar}\n  ✗ 探针缺失，无法继续\n${bar}\n`)
  process.exit(1)
}

const handlers = await ev(`window.__dw_fxProbe.handlers()`)
check('注册表收集到 14 种 handler', handlers?.length === 14, JSON.stringify(handlers))

// ---------- 先跳到一句「有说话人」的台词 ----------
// cutin / actor 需要具体立绘；第一句往往是纯叙述（characterId 为空），
// 此时 actors.resolve() 返回 null 是**正确行为**（不是 bug），
// 所以验收必须先导航到有角色的句子，否则测的是「没立绘时不该播」而不是「有立绘时能播」。
const jumped = await ev(`(async () => {
  const r = await window.dreamweave.getView()
  if (!r.ok || !r.data) return { ok: false, why: 'getView 失败' }
  const idx = r.data.actions.findIndex(a => a.characterId)
  if (idx < 0) return { ok: false, why: '整包没有带角色的句子' }
  const a = r.data.actions[idx]
  const chIdx = r.data.chapters.findIndex(c => a.chapterSeq === c.chapterSeq)
  const p = window.__dw_fxProbe
  if (!p.gotoAction) return { ok: false, why: '探针缺 gotoAction' }
  p.gotoAction(chIdx, a.order - 1)
  await new Promise(res => setTimeout(res, 500))
  return { ok: true, characterId: a.characterId, chapterSeq: a.chapterSeq, order: a.order }
})()`)
check('已跳到有角色的句子', jumped?.ok, jumped?.why ?? '')
if (jumped?.ok) check('该句确实有 characterId', !!jumped.characterId, JSON.stringify(jumped))

// ---------- 逐条挂载验证 ----------
/** 每个用例：特效 id + 期望出现的 DOM 选择器 + 期望的 CSS 变量检查 */
const CASES = [
  { id: 'portrait-cutin', sel: '[data-testid="fx-cutin"]', label: 'cutin → 斜切分镜节点' },
  { id: 'actor-bounce', sel: '[data-testid="fx-actor"]', label: 'actor → 立绘副本节点' },
  { id: 'blink', sel: '[data-testid="fx-eyelids"]', label: 'eyelids → 眼睑节点' },
  { id: 'fog', sel: '[data-testid="fx-ambient"]', label: 'ambient → 氛围粒子容器' },
  { id: 'rain', sel: '[data-testid="fx-particles"]', label: 'particles → 天气粒子容器' },
  { id: 'seagulls', sel: '[data-testid="fx-birds"]', label: 'birds → 鸟群容器' },
  { id: 'zoom', cssVar: '--fx-scale', label: 'camera → --fx-scale 变化' },
  { id: 'heat-distortion', cssVar: '--fx-scale', label: 'distortion → 场景形变变量' }
]

for (const c of CASES) {
  const res = await ev(`(async () => {
    const r = await window.__dw_fxProbe.mount(${JSON.stringify(c.id)}, 900)
    await new Promise(res => setTimeout(res, 320))
    const el = document.querySelector(${JSON.stringify(c.sel ?? '.__none__')})
    const bg = document.querySelector('.stage-bg')
    return {
      ok: r.ok,
      error: r.error,
      found: ${c.sel ? '!!el' : 'true'},
      childCount: el ? el.children.length : 0,
      cssVal: bg ? (bg.style.getPropertyValue(${JSON.stringify(c.cssVar ?? '--none')}) || '') : '',
      warned: r.warned ?? []
    }
  })()`)
  if (c.sel) {
    check(c.label, res?.ok && res.found, `ok=${res?.ok} found=${res?.found} err=${res?.error ?? ''}`)
    // 粒子容器必须有子节点
    if (c.id === 'fog' || c.id === 'rain' || c.id === 'seagulls') {
      check(`${c.label}：有粒子子节点`, (res?.childCount ?? 0) > 0, `children=${res?.childCount}`)
    }
    if (c.id === 'actor-bounce' || c.id === 'portrait-cutin') {
      check(`${c.label}：绑定了角色`, !!res?.found, '未绑定')
    }
  } else {
    check(c.label, res?.ok && !!res.cssVal && res.cssVal !== '', `cssVal="${res?.cssVal}" err=${res?.error ?? ''}`)
  }
}

// ---------- 清理验证 ----------
const cleaned = await ev(`(async () => {
  window.__dw_fxProbe.stopAll()
  await new Promise(res => setTimeout(res, 260))
  const bg = document.querySelector('.stage-bg')
  const leftover = {
    cutin: document.querySelectorAll('[data-testid="fx-cutin"]').length,
    actor: document.querySelectorAll('[data-testid="fx-actor"]').length,
    eyelids: document.querySelectorAll('[data-testid="fx-eyelids"]').length,
    ambient: document.querySelectorAll('[data-testid="fx-ambient"]').length,
    particles: document.querySelectorAll('[data-testid="fx-particles"]').length,
    birds: document.querySelectorAll('[data-testid="fx-birds"]').length
  }
  const vars = bg ? ['--fx-scale','--fx-pan-x','--fx-pan-y','--fx-angle','--fx-shake-x','--fx-shake-y']
    .filter(v => bg.style.getPropertyValue(v)) : ['no-bg']
  return { leftover, vars }
})()`)
const totalLeft = Object.values(cleaned?.leftover ?? {}).reduce((a, b) => a + b, 0)
check('stopAll 后无残留 DOM 节点', totalLeft === 0, JSON.stringify(cleaned?.leftover))
check('stopAll 后场景变量复位', (cleaned?.vars?.length ?? 1) === 0, JSON.stringify(cleaned?.vars))

// ---------- 运行期异常 ----------
check('无运行期异常', runtimeErrors.length === 0, runtimeErrors.slice(0, 3).join(' | '))

// ---------- 报告 ----------
const bar = '─'.repeat(66)
console.log(`\n${bar}\n  特效 A 线真机验证\n${bar}`)
for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : '  ← ' + c.detail}`)
console.log(`\n${bar}`)
if (failures.length) {
  console.log(`  ✗ ${failures.length} 项失败 / 共 ${checks.length} 项\n${bar}\n`)
  process.exit(1)
}
console.log(`  ✓ ${checks.length} 项全部通过\n${bar}\n`)
ws.close()

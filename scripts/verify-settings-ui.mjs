/**
 * 设置页新增控件验证（B/C/D 线）：真机确认 UI 存在、可读写、能保存。
 *
 * 验证点：
 *   ① 场景负面词输入框存在且有默认值（压制"透明背景"）
 *   ② 人物画风预设 / 场景画风预设下拉存在
 *   ③ 选 custom 时自定义文本框出现，选回去时消失
 *   ④ LLM 改写开关 + 目标模型下拉存在
 *   ⑤ 保存后重新读取设置，值确实持久化
 *
 * 前置：electron . --remote-debugging-port=9222
 * 用法：node scripts/verify-settings-ui.mjs
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
    runtimeErrors.push(`${d.text} | ${d.exception?.description?.slice(0, 200)}`)
  }
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
  }
})
await new Promise((r) => ws.addEventListener('open', r))
await send('Runtime.enable')
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

// ---------- 打开设置页 ----------
await send('Page.enable')
await send('Page.reload', { ignoreCache: false })
await sleep(2600)
runtimeErrors.length = 0
await send('Page.bringToFront')
await sleep(400)

const opened = await ev(`(() => {
  const b = document.querySelector('[data-testid="open-settings"]') ||
            [...document.querySelectorAll('.side-item')].find(x => x.textContent.includes('设置'))
  if (!b) return false
  b.click()
  return true
})()`)
check('进入设置页', opened, '找不到设置入口')
await sleep(1200)

// ---------- ① 场景负面词 ----------
const sceneNeg = await ev(`(() => {
  const el = document.querySelector('[data-testid="comfy-scene-negative"]')
  return el ? { exists: true, value: el.value } : { exists: false }
})()`)
check('场景负面词输入框存在', sceneNeg?.exists, '')
check('场景负面词有默认值', (sceneNeg?.value ?? '').length > 20, `len=${(sceneNeg?.value ?? '').length}`)
check('场景负面词压制「透明背景」', /透明背景/.test(sceneNeg?.value ?? ''), (sceneNeg?.value ?? '').slice(0, 60))
check('场景负面词压制「空白背景」', /空白背景/.test(sceneNeg?.value ?? ''), '')
check('场景负面词要求无人物', /人物/.test(sceneNeg?.value ?? ''), '')

const charNeg = await ev(`(() => {
  const el = document.querySelector('[data-testid="comfy-negative"]')
  return el ? el.value : null
})()`)
check('人物负面词压制「白色背景」', /白色背景/.test(charNeg ?? ''), (charNeg ?? '').slice(0, 60))
check('两份负面词内容不同', charNeg !== sceneNeg?.value, '')

// ---------- ② 画风预设 ----------
const charPreset = await ev(`(() => {
  const el = document.querySelector('[data-testid="comfy-char-art-preset"]')
  return el ? { exists: true, value: el.value, options: [...el.options].map(o => o.value) } : { exists: false }
})()`)
check('人物画风预设下拉存在', charPreset?.exists, '')
check('人物画风含 anime/realistic/custom', ['anime', 'realistic', 'custom'].every((v) => charPreset?.options?.includes(v)), JSON.stringify(charPreset?.options))

const scenePreset = await ev(`(() => {
  const el = document.querySelector('[data-testid="comfy-scene-art-preset"]')
  return el ? { exists: true, options: [...el.options].map(o => o.value) } : { exists: false }
})()`)
check('场景画风预设下拉存在', scenePreset?.exists, '')

// ---------- ③ custom 联动 ----------
await ev(`(() => {
  const el = document.querySelector('[data-testid="comfy-char-art-preset"]')
  el.value = 'custom'
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return true
})()`)
await sleep(400)
const customShown = await ev(`!!document.querySelector('[data-testid="comfy-char-art-custom"]')`)
check('选 custom 时自定义文本框出现', customShown, '')

await ev(`(() => {
  const el = document.querySelector('[data-testid="comfy-char-art-preset"]')
  el.value = 'anime'
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return true
})()`)
await sleep(400)
const customHidden = await ev(`!document.querySelector('[data-testid="comfy-char-art-custom"]')`)
check('选回 anime 时自定义文本框消失', customHidden, '')

// ---------- ④ 改写开关 ----------
const rewrite = await ev(`(() => {
  const cb = document.querySelector('[data-testid="comfy-rewrite-enabled"]')
  const sel = document.querySelector('[data-testid="comfy-rewrite-target"]')
  return {
    cbExists: !!cb, cbChecked: cb?.checked,
    selExists: !!sel, targets: sel ? [...sel.options].map(o => o.value) : []
  }
})()`)
check('LLM 改写开关存在', rewrite?.cbExists, '')
check('改写开关默认关闭', rewrite?.cbChecked === false, `checked=${rewrite?.cbChecked}`)
check('目标模型下拉存在', rewrite?.selExists, '')
check(
  '目标模型含三种（qwen/moss/generic）',
  ['qwen-image-2.1', 'moss-image', 'generic'].every((v) => rewrite?.targets?.includes(v)),
  JSON.stringify(rewrite?.targets)
)

// ---------- ⑤ 保存并回读 ----------
const saved = await ev(`(async () => {
  const s = await window.feather.getSettings()
  s.comfyui.sceneNegativePrompt = '验证用场景负面词-TESTING-1234567890'
  s.comfyui.promptRewriteEnabled = true
  s.comfyui.promptRewriteTarget = 'moss-image'
  s.comfyui.charArtStylePreset = 'realistic'
  const r = await window.feather.saveSettings({ comfyui: s.comfyui })
  return { ok: r.ok, error: r.error }
})()`)
check('保存设置成功', saved?.ok, saved?.error ?? '')

const reread = await ev(`(async () => {
  const s = await window.feather.getSettings()
  return {
    sceneNeg: s.comfyui.sceneNegativePrompt,
    rewrite: s.comfyui.promptRewriteEnabled,
    target: s.comfyui.promptRewriteTarget,
    charPreset: s.comfyui.charArtStylePreset
  }
})()`)
check('场景负面词已持久化', /TESTING-1234567890/.test(reread?.sceneNeg ?? ''), (reread?.sceneNeg ?? '').slice(0, 40))
check('改写开关已持久化', reread?.rewrite === true, `got=${reread?.rewrite}`)
check('目标模型已持久化', reread?.target === 'moss-image', `got=${reread?.target}`)
check('画风预设已持久化', reread?.charPreset === 'realistic', `got=${reread?.charPreset}`)

// 清理：恢复默认，避免污染后续测试
await ev(`(async () => {
  const s = await window.feather.getSettings()
  s.comfyui.sceneNegativePrompt = ''
  s.comfyui.promptRewriteEnabled = false
  s.comfyui.promptRewriteTarget = 'qwen-image-2.1'
  s.comfyui.charArtStylePreset = 'anime'
  await window.feather.saveSettings({ comfyui: s.comfyui })
  return true
})()`)

check('无运行期异常', runtimeErrors.length === 0, runtimeErrors.slice(0, 3).join(' | '))

// ---------- 报告 ----------
const bar = '─'.repeat(68)
console.log(`\n${bar}\n  设置页新增控件验证（B/C/D）\n${bar}`)
for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : '  ← ' + c.detail}`)
console.log(`\n${bar}`)
if (failures.length) {
  console.log(`  ✗ ${failures.length} 项失败 / 共 ${checks.length} 项\n${bar}\n`)
  process.exit(1)
}
console.log(`  ✓ ${checks.length} 项全部通过\n${bar}\n`)
ws.close()

/**
 * 按用途解析（一键子集）验证（CDP 真机）。
 *
 * 为什么必须验：这些按钮点了会真的发 LLM 请求。
 * 如果依赖闭包算错（漏了前置任务），编排器会把整批标成「依赖未就绪」跳过，
 * 表现是「点了没反应」—— 用户会以为是面板坏了。
 * 所以断言的重点是**算出来的任务集合是否覆盖全部前置**，而不是按钮存不存在。
 *
 * 断言：
 *   ① 三个预设按钮都在，且各自带任务数
 *   ② 每组的任务集合**闭合**：组内每个任务的 dependsOn 都在组内（或是不存在的虚拟步骤）
 *   ③ 漫画组不含演出专有任务（seg/event/storyScript），演出组不含漫画任务
 *   ④ 三组并集覆盖了全部 33 个任务（说明没有任务被漏掉没人管）
 *   ⑤ 界面显示的任务数 = 算出来的数量（UI 与逻辑一致）
 *   ⑥ 无运行期异常
 *
 * 用法：CDP_ENDPOINT=http://127.0.0.1:9333 node scripts/verify-parse-presets.mjs
 */
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'

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
    runtimeErrors.push(`EXCEPTION: ${m.params.exceptionDetails.text}`)
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
function check(name, cond, detail = '') {
  checks.push({ name, ok: !!cond, detail })
  if (!cond) failures.push(`${name}${detail ? `（${detail}）` : ''}`)
}
let step = 0
const mark = (s) => {
  step++
  console.log(`  [${String(step).padStart(2, '0')}] ${s}`)
}

// ============ ⓿ 打开一本已解析的书 ============
mark('准备')
await send('Page.reload', { ignoreCache: false })
await sleep(2800)
await send('Page.bringToFront')
await sleep(600)

const opened = await ev(`(async () => {
  const ws = await window.dreamweave.listWorkspaces()
  if (!ws.ok || !ws.items.length) return { ok: false, why: '书库为空' }
  // 选一本章节最多的（更可能是完整解析过的包）
  const sorted = [...ws.items].sort((a, b) => (b.chapterCount || 0) - (a.chapterCount || 0))
  const target = sorted[0]
  // ⚠️ 必须走**真实 UI 路径**：在书架里点这本书。
  // 只调 openWorkspace() 是不够的 —— 它只切换**主进程会话**，
  // 渲染层并不知道，页面会继续停在书库，侧栏仍然只有「书库 / 设置」两项。
  // 这时去找任务面板必然找不到（实测踩过）。
  const book = document.querySelector('[data-testid="lib-shelf"] .slot[data-book-id="' + target.id + '"] .book')
  if (!book) {
    // 不在当前可见区（书多时有虚拟滚动/分页）→ 退回 IPC，但后面要重新点页签
    const r = await window.dreamweave.openWorkspace(target.id)
    return r.ok ? { ok: true, title: target.title, id: target.id, via: 'ipc' } : { ok: false, why: r.error }
  }
  book.click()
  return { ok: true, title: target.title, id: target.id, via: 'ui' }
})()`)
check('能打开一本书', opened?.ok === true, opened?.why ?? '')
await sleep(2200)

// ============ ① 数据层：从注册表算三组 ============
mark('数据层')
const data = await ev(`(async () => {
  const ov = await window.dreamweave.tasksOverview()
  if (!ov.ok || !ov.overview) return { ok: false, error: ov.error ?? 'tasksOverview 失败' }
  const tasks = ov.overview.tasks
  const byId = new Map(tasks.map(t => [t.id, t]))
  const depBase = (d) => { const i = d.indexOf(':'); return i < 0 ? d : d.slice(0, i) }
  const ALWAYS = ['always', 'any']

  function build(features) {
    const picked = new Set()
    for (const t of tasks) {
      if (features.includes(t.feature) || ALWAYS.includes(t.feature)) picked.add(t.id)
    }
    let grew = true
    while (grew) {
      grew = false
      for (const id of [...picked]) {
        const t = byId.get(id)
        if (!t) continue
        for (const dep of t.dependsOn ?? []) {
          const b = depBase(dep)
          if (byId.has(b) && !picked.has(b)) { picked.add(b); grew = true }
        }
      }
    }
    return tasks.filter(t => picked.has(t.id)).map(t => t.id)
  }

  const SHOW = build(['visualNovel', 'events'])
  const MANGA = build(['manga'])
  const PEOPLE = build(['entities', 'characters', 'relations', 'factions', 'items', 'creatures'])
  const allIds = tasks.map(t => t.id)

  // 闭合性检查：组内每个任务的依赖是否也在组内
  function notClosed(group) {
    const set = new Set(group)
    const missing = []
    for (const id of group) {
      const t = byId.get(id)
      for (const dep of t.dependsOn ?? []) {
        const b = depBase(dep)
        if (byId.has(b) && !set.has(b)) missing.push(id + '->' + b)
      }
    }
    return missing
  }

  return {
    ok: true,
    total: tasks.length,
    show: SHOW, manga: MANGA, people: PEOPLE,
    showMissing: notClosed(SHOW),
    mangaMissing: notClosed(MANGA),
    peopleMissing: notClosed(PEOPLE),
    unionSize: new Set([...SHOW, ...MANGA, ...PEOPLE]).size,
    allIds,
    // 漫画组不应含演出专有
    mangaHasShowOnly: MANGA.filter(id => ['seg', 'event', 'storyScript', 'effectAnnotation', 'performanceReview'].includes(id)),
    // 演出组不应含漫画专有
    showHasMangaOnly: SHOW.filter(id => id.startsWith('manga'))
  }
})()`)
check('读到任务清单', data?.ok === true, data?.error ?? '')
check('任务总数 33', data?.total === 33, `${data?.total}`)

check('「只做演出」依赖闭合（不缺前置）', (data?.showMissing ?? ['x']).length === 0, JSON.stringify(data?.showMissing))
check('「只做漫画」依赖闭合（不缺前置）', (data?.mangaMissing ?? ['x']).length === 0, JSON.stringify(data?.mangaMissing))
check('「只做人物」依赖闭合（不缺前置）', (data?.peopleMissing ?? ['x']).length === 0, JSON.stringify(data?.peopleMissing))

check('漫画组不含演出专有任务', (data?.mangaHasShowOnly ?? ['x']).length === 0, JSON.stringify(data?.mangaHasShowOnly))
check('演出组不含漫画专有任务', (data?.showHasMangaOnly ?? ['x']).length === 0, JSON.stringify(data?.showHasMangaOnly))

check('三组并集覆盖全部 33 个任务', data?.unionSize === 33, `并集 ${data?.unionSize} / 全部 ${data?.total}`)

// 各组应包含关键产物任务
check('演出组含 storyScript（剧本）', (data?.show ?? []).includes('storyScript'), '')
check('漫画组含 mangaScript（分镜）', (data?.manga ?? []).includes('mangaScript'), '')
check('人物组含 characterRelation（关系）', (data?.people ?? []).includes('characterRelation'), '')

// ============ ② 界面：按钮存在且数字一致 ============
mark('界面')
/**
 * 切到「概览」页签 —— ParsePanel 只挂在那里。
 *
 * 注意：**不要用 `openWorkspace` 之后再找按钮**。开书只切换主进程会话，
 * 渲染层的页签未必跟着走到概览页（上一套测试可能把它留在别的页）。
 * 所以先显式点侧栏「概览」，并确认 ParsePanel 真的挂上了再断言按钮。
 */
await ev(`(() => {
  const b = [...document.querySelectorAll('.side-item')].find(x => x.textContent.includes('概览'))
  if (b) b.click()
  return !!b
})()`)
await sleep(1800)

// 等 ParsePanel 挂载（它要等 tasksOverview 回来才渲染出预设按钮）
let panelReady = false
for (let i = 0; i < 30; i++) {
  panelReady = await ev(`!!document.querySelector('[data-testid="parse-presets"]')`)
  if (panelReady) break
  await sleep(400)
}
check('任务面板已挂载（ParsePanel 在概览页）', panelReady === true, '未找到 parse-presets')

await ev(`(() => { const p = document.querySelector('[data-testid="parse-presets"]'); if (p) p.scrollIntoView({ block: 'center' }); return !!p })()`)
await sleep(600)

const ui = await ev(`(() => {
  const root = document.querySelector('[data-testid="parse-presets"]')
  if (!root) return { exists: false }
  const btns = [...root.querySelectorAll('button')]
  return {
    exists: true,
    count: btns.length,
    items: btns.map(b => ({
      key: (b.getAttribute('data-testid') || '').replace('parse-preset-', ''),
      text: b.textContent.trim().replace(/\\s+/g, ' '),
      disabled: b.disabled
    }))
  }
})()`)
check('预设按钮区存在', ui?.exists === true, '')
check('有三个预设按钮', ui?.count === 3, `${ui?.count}`)
check('按钮都可用（未禁用）', (ui?.items ?? []).every((i) => !i.disabled), JSON.stringify(ui?.items?.map((i) => i.disabled)))

// 按钮上的任务数应与逻辑算出的数量一致
for (const key of ['show', 'manga', 'people']) {
  const item = (ui?.items ?? []).find((i) => i.key === key)
  const expected = data?.[key]?.length ?? -1
  const m = /(\d+)\s*个任务/.exec(item?.text ?? '')
  check(`「${key}」按钮显示的任务数 = 逻辑算出的 ${expected}`, m && Number(m[1]) === expected,
    `显示「${item?.text ?? ''}」`)
}

// ============ ③ 异常 ============
mark('运行期异常')
check('无运行期异常', runtimeErrors.length === 0, runtimeErrors.slice(0, 3).join(' | '))

// ============ 报告 ============
const bar = '─'.repeat(64)
console.log(`\n${bar}\n  按用途解析（一键子集）\n${bar}`)
for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : '  ← ' + c.detail}`)
if (data?.ok) {
  console.log(`\n  演出 ${data.show.length} · 漫画 ${data.manga.length} · 人物 ${data.people.length}（并集 ${data.unionSize}/33）`)
  console.log(`  演出组：${data.show.join(', ')}`)
  console.log(`  漫画组：${data.manga.join(', ')}`)
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

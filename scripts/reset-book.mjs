/**
 * 一次性清理：删除某本书的**全部**工作库副本，然后重新导入最新文件。
 *
 * 用户要求原话：「先删掉所有这本书的内容，然后重新导入 txt」
 *
 * 这里刻意不自动推断"哪本算这本书"——因为出现过同名不同内容的副本，
 * 自动判断反而危险。改为：打印出所有候选（书名命中），逐个删除，全部删完再导入。
 *
 * 删除走的是与界面「删除」按钮同一条 IPC（workspace:delete），
 * 内部有越界防护 + 符号链接防护，不是裸 rm。
 *
 * 用法：node scripts/reset-book.mjs "<关键词>" "<txt路径>"
 *   node scripts/reset-book.mjs "明明完美冒险" "C:/Users/wfsyb/Desktop/明明完美冒险！ 作者_MMT.txt"
 */
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9333'
const KEYWORD = process.argv[2] ?? '明明完美冒险'
const TXT = process.argv[3] ?? ''

const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let mid = 0
const pending = new Map()
const send = (m, pr = {}) =>
  new Promise((res, rej) => {
    const i = ++mid
    pending.set(i, { res, rej })
    ws.send(JSON.stringify({ id: i, method: m, params: pr }))
  })
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
  }
})
await new Promise((r) => ws.addEventListener('open', r))
await send('Runtime.enable')
const ev = async (x) => {
  const r = await send('Runtime.evaluate', {
    expression: x,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600))
  return r.result.value
}

// ---- 1) 列出候选 ----
const candidates = await ev(`(async () => {
  const r = await window.dreamweave.listWorkspaces()
  const items = r.items ?? []
  const kw = ${JSON.stringify(KEYWORD)}
  // 按「显示标题」或「来源路径」命中
  return items
    .filter(i => (i.title || '').includes(kw) || (i.t2wPath || '').includes(kw))
    .map(i => ({ id: i.id, title: i.title, path: i.t2wPath, createdAt: i.createdAt, current: i.current }))
})()`)

console.log(`命中「${KEYWORD}」的副本：${candidates.length} 个`)
for (const c of candidates) {
  console.log(`  ${c.id}  ${c.title}  ${c.createdAt}${c.current ? '  [当前打开]' : ''}`)
}

if (!candidates.length) {
  console.log('\n没有需要删除的副本。')
} else {
  // ---- 2) 逐个删除 ----
  console.log('\n开始删除…')
  let deleted = 0
  let failed = 0
  for (const c of candidates) {
    const r = await ev(`(async () => {
      const r = await window.dreamweave.deleteWorkspace(${JSON.stringify(c.id)})
      return { ok: r.ok, error: r.error }
    })()`)
    if (r?.ok) {
      deleted++
      console.log(`  ✓ 已删除 ${c.id}`)
    } else {
      failed++
      console.log(`  ✗ 删除失败 ${c.id}：${r?.error ?? '未知'}`)
    }
  }
  console.log(`\n删除结果：成功 ${deleted}，失败 ${failed}`)
}

// ---- 3) 确认清空 ----
const remain = await ev(`(async () => {
  const r = await window.dreamweave.listWorkspaces()
  const items = r.items ?? []
  const kw = ${JSON.stringify(KEYWORD)}
  return {
    total: items.length,
    still: items.filter(i => (i.title || '').includes(kw) || (i.t2wPath || '').includes(kw)).map(i => i.id)
  }
})()`)
console.log(`\n清理后：书库共 ${remain.total} 本，残留命中 ${remain.still.length} 个`)

// ---- 4) 重新导入 ----
if (TXT) {
  console.log(`\n重新导入：${TXT}`)
  const imp = await ev(`(async () => {
    const r = await window.dreamweave.importPackage(${JSON.stringify(TXT)}, 'txt')
    if (!r.ok) return { ok: false, error: r.error }
    return {
      ok: true,
      title: r.summary?.project?.title ?? '',
      chapters: r.summary?.project?.chapterCount ?? 0,
      chars: r.summary?.project?.charCount ?? 0,
      firstChapter: r.summary?.chapters?.[0]?.title ?? ''
    }
  })()`)
  console.log('  导入结果：', JSON.stringify(imp, null, 2))

  // ---- 5) 最终确认：只有一本，且是新导入的 ----
  const final = await ev(`(async () => {
    const r = await window.dreamweave.listWorkspaces()
    const items = r.items ?? []
    const kw = ${JSON.stringify(KEYWORD)}
    const hit = items.filter(i => (i.title || '').includes(kw) || (i.t2wPath || '').includes(kw))
    return { total: items.length, hit: hit.map(i => ({ id: i.id, title: i.title, createdAt: i.createdAt })) }
  })()`)
  console.log(`\n最终：书库共 ${final.total} 本，「${KEYWORD}」有 ${final.hit.length} 本`)
  for (const h of final.hit) console.log(`  ${h.id}  ${h.title}  ${h.createdAt}`)
}

ws.close()

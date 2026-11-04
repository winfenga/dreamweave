/**
 * T6-D · 记忆组装模块 + draft/draftCharacter/draftOther 三适配器验证脚本
 * （node 直跑，**不启动 Electron**；零新增依赖）。
 *
 * 覆盖五组（对应 T6-D spec 验收项）：
 *  A. buildReadingMemory：合成 plot entries（3 条非空摘要 + 1 条缺 summary + 1 条 key 无
 *     chunkIndex）→ self=2 只收 chunk 0/1 且 text/start/end 正确、按 chunkIndex 升序；
 *     self=0 三层全空；value 两种形态（{data:{chunkSummary}} 老格式 / 裸 {chunkSummary}）
 *     都正确读出；key 无 chunkIndex 按出现序（数组位置）编号；null/非对象 value 跳过；
 *     midMemory/longTermMemory 恒 []（compact 未实现）；
 *  B. renderMemory：合法 JSON、三层键在、recentMemory 是 text 字符串数组；
 *  C. nextChunkSummaryOf：self=0 有下一条 → 返回；下一条缺摘要 → ''；超范围 → ''；
 *  D. 三适配器：inputText 行号包装（同 seg 口径 + 单章回退）；buildMessages 恰 3 条消息、
 *     无 `{{` 残留、模板占位符全覆盖（读三个模板文件提取——防模板漂移）；无 readUpstream →
 *     可读错误；parse 正样本（含 ```json 包裹变体）结构正确、实体级规范化（name 硬性要求 /
 *     aliases 剔非字符串 / summary 缺省 ''）、不分配 id；脏样本（缺顶层必填键/非 JSON）→
 *     raw 兜底不抛崩；注册完整性 ×3；keyOf 语义；
 *  E. memory 端到端：buildReadingMemory → renderMemory → 作为 draft 的 memory vars 经
 *     buildMessages 渲染进指令 → 指令里出现对应摘要文本（renderMemory 输出逐字出现）。
 *
 * 姿势与 `scripts/verify-t6c-locationtree.mjs` 一致：`createRequire(feather/package.json)`
 * 取项目已装的 esbuild，把入口打成单文件 ESM 写入临时目录后 `pathToFileURL` 动态 import；
 * electron 以最小桩替换（app.getAppPath → 项目根，使 prompt-loader 的 resourcesDir()
 * 定位到 `resources/prompts`）。
 *
 * 临时目录**只准碰** `D:/AI/tx/feather-t6d-test/`（跑完 rm -rf 清掉）；
 * 绝不读写真实工作库目录（7 本真实库只读）。
 *
 * 用法：node scripts/verify-t6d-drafts.mjs
 */
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(here, '..')
/** 唯一允许触碰的临时父目录（跑完 rm -rf 清掉） */
const TEST_PARENT = 'D:/AI/tx/feather-t6d-test'
const BUILD_DIR = join(TEST_PARENT, 'build')

const require = createRequire(join(FEATHER, 'package.json'))
const { build } = require('esbuild')

/** electron 最小桩：只提供 app.getAppPath / app.getPath（prompt-loader → effects/catalog 用）。 */
function electronStub() {
  return {
    name: 'electron-stub',
    setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }))
      b.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
        contents:
          `export const app = { getAppPath: () => ${JSON.stringify(FEATHER)}, getPath: () => ${JSON.stringify(TEST_PARENT)} };\n` +
          `export const ipcMain = { handle(){}, on(){} };\n` +
          `export const BrowserWindow = { getAllWindows: () => [], fromWebContents: () => null };\n` +
          `export default { app, ipcMain, BrowserWindow };\n`,
        loader: 'js'
      }))
    }
  }
}

/** 打包单条目为临时 ESM 文件并动态 import（pathToFileURL）。 */
async function loadModule(rel, outName) {
  const result = await build({
    entryPoints: [join(FEATHER, rel)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    external: ['node:*'],
    logLevel: 'silent',
    define: { __dirname: JSON.stringify(join(FEATHER, 'out', 'main')) },
    plugins: [electronStub()]
  })
  const outPath = join(BUILD_DIR, outName)
  await writeFile(outPath, result.outputFiles[0].text, 'utf8')
  return import(pathToFileURL(outPath).href)
}

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 提取模板中全部 mustache 变量名（`{{{v}}}` / `{{v}}`）。 */
function extractTemplateVars(tpl) {
  const names = new Set()
  const re = /\{\{\{?\s*([#^/]?)\s*([A-Za-z0-9_.]+)\s*\}?\}\}/g
  let m
  while ((m = re.exec(tpl))) names.add(m[2])
  return [...names]
}

/** 合成 TaskDef（只填适配器/渲染链路会碰的字段）。 */
function taskDef(id) {
  return {
    id,
    kind: id,
    code: id,
    label: id,
    feature: 'always',
    execution: '',
    input: '',
    output: '',
    model: true,
    thinking: 'disabled',
    effort: 1,
    maxTokens: 60000,
    global: false,
    setting: '',
    dependsOn: []
  }
}

/** 合成 rt：render 走真 prompt-loader 并留痕（vars 供模板一致性断言）。 */
function makeRt(renderLog, extra = {}) {
  return {
    task: taskDef('draft'),
    pkgId: 'pkg-t6d',
    revisionId: 'rev-t6d',
    chunkIndex: 2,
    instanceKey: 'pkg-t6d:rev-t6d:draft:2',
    chunkText: '',
    warnings: [],
    log: () => {},
    render: async (name, vars) => {
      renderLog.push({ name, vars: vars ?? {} })
      return pl.renderPrompt(name, vars ?? {})
    },
    llm: async () => {
      throw new Error('验证脚本不应触发真实 LLM 调用')
    },
    ...extra
  }
}

let pl
let memMod
let tasks

async function main() {
  await rm(TEST_PARENT, { recursive: true, force: true })
  await mkdir(BUILD_DIR, { recursive: true })
  console.log(`临时目录：${TEST_PARENT}\n`)

  memMod = await loadModule('src/main/pipeline/memory.ts', 'memory.mjs')
  tasks = await loadModule('src/main/pipeline/tasks/index.ts', 'tasks-index.mjs')
  pl = await loadModule('src/main/pipeline/prompt-loader.ts', 'prompt-loader.mjs')

  // 合成 plot 产物条目：两种 value 形态混用 + 缺 summary + key 无 chunkIndex
  const plotEntries = [
    { key: 'pkg-t6d:rev-t6d:plot:0', value: { data: { chunkSummary: '第0块摘要：开篇。', chapters: [] } } },
    { key: 'pkg-t6d:rev-t6d:plot:1', value: { chunkSummary: '第1块摘要：发展。', chapters: [] } },
    { key: 'pkg-t6d:rev-t6d:plot:2', value: { data: { chunkSummary: '第2块摘要：当前块自身，不应进入记忆。' } } },
    { key: 'pkg-t6d:rev-t6d:plot:3', value: { data: { chunkSummary: '第3块摘要：下一块摘要，仅辅助消歧。' } } },
    { key: 'pkg-t6d:rev-t6d:plot:4', value: { data: { chapters: [] } } },
    { key: 'pkg-t6d:rev-t6d:plot:bad', value: { data: { chunkSummary: '无序号条目摘要。' } } }
  ]

  try {
    // =====================================================================
    // A · buildReadingMemory
    // =====================================================================
    console.log('A · buildReadingMemory')

    // ---- A1. self=2：只收 chunk 0/1；两种 value 形态；text/start/end；升序 ----
    {
      const m = memMod.buildReadingMemory(plotEntries, 2)
      check('A1 self=2 只收 2 条（chunk 0/1）', m.recentMemory.length === 2, JSON.stringify(m.recentMemory.map((x) => x.start)))
      check('A1 text 逐字等于 plot chunkSummary', m.recentMemory[0]?.text === '第0块摘要：开篇。' && m.recentMemory[1]?.text === '第1块摘要：发展。', JSON.stringify(m.recentMemory.map((x) => x.text)))
      check('A1 start=end=chunk 序号', m.recentMemory.every((x) => x.start === x.end) && m.recentMemory[0].start === 0 && m.recentMemory[1].start === 1, JSON.stringify(m.recentMemory))
      check('A1 按 chunkIndex 升序', m.recentMemory[0].start < m.recentMemory[1].start)
      check('A1 老格式 {data:{chunkSummary}} 与裸 {chunkSummary} 都读出', m.recentMemory[0].text.includes('开篇') && m.recentMemory[1].text.includes('发展'))
      check('A1 自身 chunk（2）与更晚 chunk（3/4）被排除', m.recentMemory.every((x) => !x.text.includes('自身') && !x.text.includes('下一块摘要')))
      check('A1 缺 summary 的 chunk4 与无序号 key 的 bad 条目被排除', m.recentMemory.every((x) => !x.text.includes('无序号')) && m.recentMemory.length === 2)
      check('A1 midMemory/longTermMemory 恒 []（compact 未实现）', Array.isArray(m.midMemory) && m.midMemory.length === 0 && Array.isArray(m.longTermMemory) && m.longTermMemory.length === 0)
    }

    // ---- A1b. key 无 chunkIndex → 按出现序（数组位置）编号 ----
    {
      const entries = [
        { key: 'pkg-t6d:rev-t6d:plot:oops', value: { chunkSummary: '位置0条目摘要。' } },
        { key: 'pkg-t6d:rev-t6d:plot:1', value: { chunkSummary: '第1块摘要：发展。' } },
        { key: 'pkg-t6d:rev-t6d:plot:2', value: { chunkSummary: '第2块摘要。' } }
      ]
      const m = memMod.buildReadingMemory(entries, 2)
      check('A1b 无 chunkIndex 的 key 按数组位置编号（pos=0 → start=0）', m.recentMemory.length === 2 && m.recentMemory[0].text === '位置0条目摘要。' && m.recentMemory[0].start === 0 && m.recentMemory[0].end === 0, JSON.stringify(m.recentMemory))
      check('A1b 第二条仍按 key 解析（start=1）', m.recentMemory[1].start === 1 && m.recentMemory[1].text === '第1块摘要：发展。')
    }

    // ---- A2. self=0：三层全空（真实库 memoryBefore:0 实证形状）----
    {
      const m = memMod.buildReadingMemory(plotEntries, 0)
      check('A2 self=0 三层全空', m.recentMemory.length === 0 && m.midMemory.length === 0 && m.longTermMemory.length === 0)
    }

    // ---- A3. 防御：null / 非对象 value / 空数组 / null 入参不抛崩 ----
    {
      const entries = [
        { key: 'pkg-t6d:rev-t6d:plot:0', value: null },
        { key: 'pkg-t6d:rev-t6d:plot:1', value: 'not-an-object' },
        { key: 'pkg-t6d:rev-t6d:plot:2', value: 42 },
        { key: 'pkg-t6d:rev-t6d:plot:3', value: { data: null } },
        { key: 'pkg-t6d:rev-t6d:plot:4', value: { data: { chunkSummary: '   ' } } }
      ]
      let m = null
      let threw = false
      try {
        m = memMod.buildReadingMemory(entries, 9)
      } catch {
        threw = true
      }
      check('A3 null/非对象/空白 summary 条目跳过且不抛崩', !threw && m && m.recentMemory.length === 0, threw ? '抛崩' : JSON.stringify(m?.recentMemory))
      const m2 = memMod.buildReadingMemory(null, 3)
      check('A3 null 入参 → 空记忆（防御）', m2.recentMemory.length === 0 && m2.midMemory.length === 0)
      const m3 = memMod.buildReadingMemory([], 3)
      check('A3 空数组入参 → 空记忆', m3.recentMemory.length === 0)
    }

    // ---- A4. 防御性排序：乱序读入也按 chunkIndex 升序出 ----
    {
      const entries = [
        { key: 'p:r:plot:2', value: { chunkSummary: '二。' } },
        { key: 'p:r:plot:0', value: { chunkSummary: '零。' } },
        { key: 'p:r:plot:1', value: { chunkSummary: '一。' } }
      ]
      const m = memMod.buildReadingMemory(entries, 3)
      check('A4 乱序读入 → 按 chunkIndex 升序', m.recentMemory.map((x) => x.text).join(',') === '零。,一。,二。', JSON.stringify(m.recentMemory.map((x) => x.text)))
    }

    // =====================================================================
    // B · renderMemory
    // =====================================================================
    console.log('\nB · renderMemory')
    {
      const m = memMod.buildReadingMemory(plotEntries, 2)
      const rendered = memMod.renderMemory(m)
      let parsed = null
      let threw = false
      try {
        parsed = JSON.parse(rendered)
      } catch {
        threw = true
      }
      check('B1 输出是合法 JSON', !threw && !!parsed, rendered)
      check('B2 三层键齐全（recentMemory/midMemory/longTermMemory）', parsed && 'recentMemory' in parsed && 'midMemory' in parsed && 'longTermMemory' in parsed, rendered)
      check('B3 recentMemory 是 text 字符串数组', Array.isArray(parsed.recentMemory) && parsed.recentMemory.length === 2 && parsed.recentMemory.every((x) => typeof x === 'string') && parsed.recentMemory[0] === '第0块摘要：开篇。', rendered)
      check('B4 mid/long 为空数组', Array.isArray(parsed.midMemory) && parsed.midMemory.length === 0 && Array.isArray(parsed.longTermMemory) && parsed.longTermMemory.length === 0)
      check('B5 空记忆 → recentMemory:[]', JSON.parse(memMod.renderMemory(memMod.buildReadingMemory([], 0))).recentMemory.length === 0)
    }

    // =====================================================================
    // C · nextChunkSummaryOf
    // =====================================================================
    console.log('\nC · nextChunkSummaryOf')
    {
      check('C1 self=0 有下一条 → 返回 chunk1 摘要', memMod.nextChunkSummaryOf(plotEntries, 0) === '第1块摘要：发展。')
      check('C2 self=1 → 返回 chunk2 摘要', memMod.nextChunkSummaryOf(plotEntries, 1) === '第2块摘要：当前块自身，不应进入记忆。')
      check('C3 self=2 → 返回 chunk3 摘要', memMod.nextChunkSummaryOf(plotEntries, 2) === '第3块摘要：下一块摘要，仅辅助消歧。', JSON.stringify(memMod.nextChunkSummaryOf(plotEntries, 2)))
      check('C3b 下一条存在但缺 summary → ""', memMod.nextChunkSummaryOf(plotEntries, 3) === '', JSON.stringify(memMod.nextChunkSummaryOf(plotEntries, 3)))
      check('C4 超出范围（末 chunk 之后）→ ""', memMod.nextChunkSummaryOf(plotEntries, 9) === '')
      check('C5 空产物 → ""', memMod.nextChunkSummaryOf([], 0) === '')
    }

    // =====================================================================
    // D · 三适配器
    // =====================================================================
    console.log('\nD · 三适配器（draft / draftCharacter / draftOther）')

    const ADAPTERS = [
      { key: 'draft', tpl: 'chunk_wiki_draft_user_prompt', expectVars: ['chapterRange', 'chunkIndex', 'enabledSections', 'memory', 'nextChunkSummary'] },
      { key: 'draftCharacter', tpl: 'chunk_wiki_draft_character_user_prompt', expectVars: ['chapterRange', 'chunkIndex', 'memory', 'nextChunkSummary'] },
      { key: 'draftOther', tpl: 'chunk_wiki_draft_other_user_prompt', expectVars: ['chapterRange', 'chunkIndex', 'enabledSections', 'memory', 'nextChunkSummary'] }
    ]
    const twoChapters = [
      { seq: 5, title: '第五章', text: '第一行\n第二行' },
      { seq: 6, title: '第六章', text: '另一行' }
    ]

    for (const { key, tpl, expectVars } of ADAPTERS) {
      const adapter = tasks[`${key}Adapter`]
      console.log(`\n-- ${key} --`)

      // ---- D1 inputText：行号包装（同 seg 口径）+ 单章回退 ----
      {
        const rt = makeRt([], { chunkChapters: twoChapters })
        const input = await adapter.inputText(rt)
        check(`D1 ${key} inputText 含章节包装【原文行：1-2】/【原文行：1-1】`, input.includes('【原文行：1-2】') && input.includes('【原文行：1-1】'), input.slice(0, 120))
        check(`D1 ${key} inputText 各行首「行号+空格」且各章从 1 重新编号`, input.includes('1 第一行') && input.includes('2 第二行') && input.includes('1 另一行'), input.slice(0, 200))
        const rt2 = makeRt([], { chunkChapters: undefined, chunkText: '单章正文' })
        const input2 = await adapter.inputText(rt2)
        check(`D1 ${key} 缺 chunkChapters → 视作单章（seq=1）`, input2 === '【原文行：1-1】\n1 单章正文', JSON.stringify(input2))
      }

      // ---- D2 buildMessages：3 条消息 / 无 {{ 残留 / 占位符全覆盖 / memory 端到端 ----
      {
        const renderLog = []
        const rt = makeRt(renderLog, { chunkChapters: twoChapters, readUpstream: async () => plotEntries })
        const input = await adapter.inputText(rt)
        const msgs = await adapter.buildMessages(input, rt)
        check(`D2 ${key} buildMessages 恰 3 条消息（原文单独喂，模板「见前面的 user 消息」）`, msgs.length === 3, `实际 ${msgs.length}`)
        check(`D2 ${key} 角色顺序 = system / user / user`, msgs[0].role === 'system' && msgs[1].role === 'user' && msgs[2].role === 'user')
        check(`D2 ${key} system 来自 common_system_prompt`, msgs[0].content.includes('【共同任务边界】'))
        check(`D2 ${key} user[0] 是带行号原文（与 inputText 一致）`, msgs[1].content === input && msgs[1].content.includes('【原文行：1-2】'))
        check(`D2 ${key} 三条消息均无 \`{{\` 残留（模板渲染完整）`, msgs.every((m) => !m.content.includes('{{')))

        // memory 端到端：buildReadingMemory → renderMemory → 指令逐字出现
        const mem = memMod.buildReadingMemory(plotEntries, 2)
        const rendered = memMod.renderMemory(mem)
        check(`D2 ${key} memory 端到端：renderMemory 输出逐字进指令`, msgs[2].content.includes(rendered), rendered.slice(0, 80))
        check(`D2 ${key} memory 端到端：chunk 0/1 摘要文本进指令`, msgs[2].content.includes('第0块摘要：开篇。') && msgs[2].content.includes('第1块摘要：发展。'))
        check(`D2 ${key} memory 不含自身 chunk（2）摘要`, !msgs[2].content.includes('第2块摘要：当前块自身'))
        check(`D2 ${key} nextChunkSummary（chunk3）进指令`, msgs[2].content.includes('第3块摘要：下一块摘要，仅辅助消歧。'))
        check(`D2 ${key} chunkIndex=2 与 chapterRange=5-6 进指令`, msgs[2].content.includes('2') && msgs[2].content.includes('5-6'))
        if (expectVars.includes('enabledSections')) {
          const want = key === 'draft' ? '["characters","factions","items"]' : '["factions","items","creatures"]'
          check(`D2 ${key} enabledSections 渲染为 JSON 数组字符串 ${want}`, msgs[2].content.includes(want))
        } else {
          check(`D2 ${key} 指令不含 enabledSections 段落（模板无该占位符）`, !msgs[2].content.includes('enabledSections'))
        }

        // 模板占位符全覆盖（读模板文件提取——防模板漂移）
        const tplVars = extractTemplateVars(await readFile(join(FEATHER, 'resources', 'prompts', `${tpl}.txt`), 'utf8'))
        check(`D2 ${key} 模板占位符集合 = ${expectVars.slice().sort().join(',')}`, tplVars.slice().sort().join(',') === expectVars.slice().sort().join(','), `实际: ${tplVars.join(',')}`)
        const taskEntry = renderLog.find((r) => r.name === tpl)
        check(`D2 ${key} 渲染了 ${tpl}`, !!taskEntry)
        const missing = tplVars.filter((v) => !(v in taskEntry.vars) || taskEntry.vars[v] === undefined)
        check(`D2 ${key} 模板占位符全覆盖（无缺失）`, missing.length === 0, `缺失: ${missing.join(',')}`)
        check(`D2 ${key} 传入 vars 无多余键（与模板占位符一致）`, Object.keys(taskEntry.vars).sort().join(',') === tplVars.sort().join(','), `实际: ${Object.keys(taskEntry.vars).join(',')}`)
        check(`D2 ${key} chunkIndex 传数字 2、chapterRange 传 "5-6"`, taskEntry.vars.chunkIndex === 2 && taskEntry.vars.chapterRange === '5-6')
        check(`D2 ${key} memory vars 是合法 JSON 字符串`, typeof taskEntry.vars.memory === 'string' && JSON.parse(taskEntry.vars.memory).recentMemory.length === 2)
      }

      // ---- D2b. plot 空产物 → 空记忆（chunk 0 合法）；未挂 readUpstream → 可读错误 ----
      {
        const renderLog = []
        const rt0 = makeRt(renderLog, { chunkIndex: 0, chunkChapters: twoChapters, readUpstream: async () => plotEntries })
        const msgs0 = await adapter.buildMessages('原文', rt0)
        check(`D2b ${key} chunk 0 → 空记忆（recentMemory:[]）`, msgs0[2].content.includes('"recentMemory":[]'))
        const rtEmpty = makeRt([], { chunkChapters: twoChapters, readUpstream: async () => [] })
        const msgsE = await adapter.buildMessages('原文', rtEmpty)
        check(`D2b ${key} plot 空产物 → 空记忆不抛错`, msgsE[2].content.includes('"recentMemory":[]'))
        const rtNo = makeRt([], { chunkChapters: twoChapters })
        let msg = ''
        try {
          await adapter.buildMessages('原文', rtNo)
        } catch (e) {
          msg = e?.message ?? ''
        }
        check(`D2b ${key} 未挂 readUpstream → 可读错误`, msg.includes('readUpstream') && msg.includes(key), msg)
      }

      // ---- D3 parse 正样本 ----
      if (key === 'draft') {
        const ok = {
          characters: [
            { name: '蓝蓝', wikiSectionType: '人物', importanceLevel: 'CORE', summary: '本块新经历。', identInfos: ['旧日虚空银狐'], aliases: ['虚空银狐', 42, null], lifeStatus: '活着', appearanceChapterSeqs: [5], characterSpriteInfos: [{ appearanceSummary: '紫毛狐耳少女', visualKeywords: ['紫毛'], sex: '女' }], vt: 'young_female', vi: '清亮' },
            { importanceLevel: 'LOW', summary: '缺 name 的坏条目' },
            'not-an-object'
          ],
          factions: [{ name: '魔王堡', wikiSectionType: '势力', importanceLevel: 'HIGH', summary: '本块新状态。', identInfos: ['血族领地'], aliases: [] }],
          items: [{ name: '键盘', wikiSectionType: '物品', importanceLevel: 'MEDIUM', identInfos: [], aliases: ['器灵键盘'] }],
          identityMatchStopNames: ['队长', '', '  ']
        }
        const d = adapter.parse(JSON.stringify(ok))
        check('D3 draft 正样本顶层键恰为 characters/factions/items/identityMatchStopNames', Object.keys(d).sort().join(',') === 'characters,factions,identityMatchStopNames,items', JSON.stringify(Object.keys(d)))
        check('D3 draft 实体计数正确（坏条目跳过：1+1+1）', d.characters.length === 1 && d.factions.length === 1 && d.items.length === 1)
        check('D3 draft 实体字段透传（characterSpriteInfos/vt/vi/lifeStatus）', d.characters[0].characterSpriteInfos[0].sex === '女' && d.characters[0].vt === 'young_female' && d.characters[0].vi === '清亮' && d.characters[0].lifeStatus === '活着')
        check('D3 draft aliases 剔非字符串元素', JSON.stringify(d.characters[0].aliases) === '["虚空银狐"]', JSON.stringify(d.characters[0].aliases))
        check('D3 draft items 实体缺 summary → 缺省 ""', d.items[0].summary === '')
        check('D3 draft identityMatchStopNames 剔空白词', JSON.stringify(d.identityMatchStopNames) === '["队长"]')
        check('D3 draft 实体不分配 id/draftIds/chunkSummaryList（T6-E 职责）', d.characters.every((c) => !('id' in c) && !('draftIds' in c) && !('chunkSummaryList' in c)) && d.items.every((i) => !('id' in i)))
        check('D3 draft 不产 creatures 键（新模板 creatures 归 draftOther）', !('creatures' in d))
        // ```json 包裹变体
        const fenced = '```json\n' + JSON.stringify(ok) + '\n```'
        const d2 = adapter.parse(fenced)
        check('D3 draft ```json 包裹变体同样解析', d2.characters.length === 1 && d2.factions.length === 1 && d2.items.length === 1)
        // items / stopNames 缺省 []
        const d3 = adapter.parse('{"characters":[],"factions":[]}')
        check('D3 draft 缺 items/identityMatchStopNames → 缺省 []', Array.isArray(d3.items) && d3.items.length === 0 && Array.isArray(d3.identityMatchStopNames) && d3.identityMatchStopNames.length === 0)
        // 脏样本
        const dirties = ['not a json at all', '', '{}', '{"factions":[]}', '{"characters":[],"factions":"x"}', '[]', 'null']
        let noThrow = true
        let shapeOk = true
        for (const dirty of dirties) {
          try {
            const dd = adapter.parse(dirty)
            const okShape = dd.characters === null && dd.factions === null && Array.isArray(dd.items) && dd.items.length === 0 && Array.isArray(dd.identityMatchStopNames) && typeof dd.raw === 'string'
            if (!okShape) {
              shapeOk = false
              console.log(`     兜底形状异常：${JSON.stringify(dirty).slice(0, 40)} → ${JSON.stringify(dd).slice(0, 140)}`)
            }
          } catch (e) {
            noThrow = false
            console.log(`     抛崩：${JSON.stringify(dirty).slice(0, 40)} → ${e.message}`)
          }
        }
        check('D3 draft 脏样本（非 JSON/缺必填键/数组/null）不抛崩', noThrow)
        check('D3 draft 脏样本兜底形状 = characters/factions null + items/stopNames [] + raw 截断', shapeOk)
      }
      if (key === 'draftCharacter') {
        const ok = {
          characters: [
            { name: '关羽', importanceLevel: 'CORE', summary: '温酒斩华雄。', identInfos: ['字云长'], aliases: ['关云长'], lifeStatus: '活着', characterSpriteInfos: [] },
            { name: '   ', summary: '空白 name 坏条目' }
          ],
          identityMatchStopNames: ['主公']
        }
        const d = adapter.parse(JSON.stringify(ok))
        check('D3 draftCharacter 正样本顶层键恰为 characters/identityMatchStopNames', Object.keys(d).sort().join(',') === 'characters,identityMatchStopNames', JSON.stringify(Object.keys(d)))
        check('D3 draftCharacter 实体计数正确（空白 name 跳过）', d.characters.length === 1 && d.characters[0].name === '关羽')
        check('D3 draftCharacter stopNames 收取', JSON.stringify(d.identityMatchStopNames) === '["主公"]')
        check('D3 draftCharacter 实体不分配 id（T6-E 职责）', !('id' in d.characters[0]))
        const d2 = adapter.parse('{"characters":[]}')
        check('D3 draftCharacter 缺 identityMatchStopNames → 缺省 []', Array.isArray(d2.identityMatchStopNames) && d2.identityMatchStopNames.length === 0)
        const fenced = '```json\n' + JSON.stringify(ok) + '\n```'
        check('D3 draftCharacter ```json 包裹变体同样解析', adapter.parse(fenced).characters.length === 1)
        const dirties = ['not a json at all', '', '{}', '{"identityMatchStopNames":[]}', '[]', '{"characters":"x"}']
        let noThrow = true
        let shapeOk = true
        for (const dirty of dirties) {
          try {
            const dd = adapter.parse(dirty)
            if (!(dd.characters === null && Array.isArray(dd.identityMatchStopNames) && typeof dd.raw === 'string')) {
              shapeOk = false
              console.log(`     兜底形状异常：${JSON.stringify(dirty).slice(0, 40)}`)
            }
          } catch (e) {
            noThrow = false
            console.log(`     抛崩：${JSON.stringify(dirty).slice(0, 40)} → ${e.message}`)
          }
        }
        check('D3 draftCharacter 脏样本不抛崩', noThrow)
        check('D3 draftCharacter 脏样本兜底形状 = characters null + stopNames [] + raw', shapeOk)
      }
      if (key === 'draftOther') {
        const ok = {
          factions: [{ name: '桃园结义', importanceLevel: 'HIGH', summary: '本块新关系。', identInfos: ['刘关张'], aliases: ['结义兄弟'] }],
          items: [{ name: '青龙偃月刀', importanceLevel: 'HIGH', summary: '本块新战绩。', identInfos: ['刀'], aliases: [] }],
          creatures: [{ name: '银月狼', importanceLevel: 'MEDIUM', summary: '物种本块新描述。', identInfos: ['月华'], aliases: [] }]
        }
        const d = adapter.parse(JSON.stringify(ok))
        check('D3 draftOther 正样本顶层键恰为 factions/items/creatures', Object.keys(d).sort().join(',') === 'creatures,factions,items', JSON.stringify(Object.keys(d)))
        check('D3 draftOther 三数组各 1 条', d.factions.length === 1 && d.items.length === 1 && d.creatures.length === 1)
        check('D3 draftOther 实体不分配 id（T6-E 职责）', d.creatures.every((c) => !('id' in c) && !('draftIds' in c)))
        check('D3 draftOther 不产 characters 键（人物归 draftCharacter）', !('characters' in d))
        const fenced = '```json\n' + JSON.stringify(ok) + '\n```'
        check('D3 draftOther ```json 包裹变体同样解析', adapter.parse(fenced).creatures.length === 1)
        const dirties = ['not a json at all', '', '{}', '{"factions":[],"items":[]}', '{"factions":[],"items":[],"creatures":"x"}', '[]']
        let noThrow = true
        let shapeOk = true
        for (const dirty of dirties) {
          try {
            const dd = adapter.parse(dirty)
            if (!(dd.factions === null && dd.items === null && dd.creatures === null && typeof dd.raw === 'string')) {
              shapeOk = false
              console.log(`     兜底形状异常：${JSON.stringify(dirty).slice(0, 40)}`)
            }
          } catch (e) {
            noThrow = false
            console.log(`     抛崩：${JSON.stringify(dirty).slice(0, 40)} → ${e.message}`)
          }
        }
        check('D3 draftOther 脏样本不抛崩', noThrow)
        check('D3 draftOther 脏样本兜底形状 = 三层 null + raw', shapeOk)
      }

      // ---- D4 注册完整性 + keyOf ----
      check(`D4 ${key} 注册进 LLM_ADAPTERS 且 id 一致`, typeof tasks.LLM_ADAPTERS[key] === 'object' && tasks.LLM_ADAPTERS[key].id === key)
      check(`D4 ${key} mergeStrategy = concat-dedup-order`, adapter.mergeStrategy === 'concat-dedup-order')
      check(`D4 ${key} keyOf 是函数`, typeof adapter.keyOf === 'function')
    }

    // ---- D5 keyOf 语义（三适配器共用 draftKeyOf）----
    console.log('\nD5 · keyOf 语义')
    const kof = tasks.draftAdapter.keyOf
    check('D5 三适配器 keyOf 同一函数（draftCharacter/draftOther 复用 draftKeyOf）', tasks.draftCharacterAdapter.keyOf === kof && tasks.draftOtherAdapter.keyOf === kof && tasks.draftKeyOf === kof)
    check('D5 {name:"X"} → "name:X"', kof({ name: 'X' }) === 'name:X')
    check('D5 name 首尾空白被 trim（" X " → "name:X"）', kof({ name: ' X ' }) === 'name:X')
    check('D5 字符串元素 → "warn:" 前缀键', kof('某警告') === 'warn:某警告')
    check('D5 无 name 对象 → JSON 串兜底', kof({ foo: 'bar' }) === '{"foo":"bar"}')
    check('D5 标量 → String 兜底', kof(42) === '42' && kof(null) === 'null')

    // =====================================================================
    // E · memory 端到端（buildReadingMemory → renderMemory → draft buildMessages）
    // =====================================================================
    console.log('\nE · memory 端到端')
    {
      const entries = [
        { key: 'pkg-t6d:rev-t6d:plot:0', value: { data: { chunkSummary: '第0块摘要：开篇。' } } },
        { key: 'pkg-t6d:rev-t6d:plot:1', value: { chunkSummary: '第1块摘要：发展。' } },
        { key: 'pkg-t6d:rev-t6d:plot:2', value: { chunkSummary: '第2块摘要：当前块。' } },
        { key: 'pkg-t6d:rev-t6d:plot:3', value: { chunkSummary: '第3块摘要：下一块。' } }
      ]
      // 1) buildReadingMemory → 2) renderMemory
      const mem = memMod.buildReadingMemory(entries, 2)
      const rendered = memMod.renderMemory(mem)
      const parsed = JSON.parse(rendered)
      check('E1 链路前两步：memory = chunks 0..1 的 text 数组', parsed.recentMemory.length === 2 && parsed.recentMemory[0] === '第0块摘要：开篇。' && parsed.recentMemory[1] === '第1块摘要：发展。')
      // 3) 作为 draft 的 memory vars 传入 buildMessages（mock rt 串起来）
      const rt = makeRt([], { chunkChapters: twoChapters, readUpstream: async () => entries })
      const msgs = await tasks.draftAdapter.buildMessages('原文', rt)
      check('E2 指令里出现 renderMemory 输出（逐字）', msgs[2].content.includes(rendered))
      check('E2 指令里出现 chunk 0/1 摘要文本', msgs[2].content.includes('第0块摘要：开篇。') && msgs[2].content.includes('第1块摘要：发展。'))
      check('E2 指令里出现 nextChunkSummary（chunk 3）', msgs[2].content.includes('第3块摘要：下一块。'))
    }
  } finally {
    await rm(TEST_PARENT, { recursive: true, force: true })
  }

  console.log(`\n==== T6-D draft 验证：${passed} 通过 / ${failed} 失败 ====`)
  if (failed === 0) {
    console.log('T6-D DRAFT VERIFY PASS')
  } else {
    console.log('T6-D DRAFT VERIFY FAIL')
  }
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('ERROR:', e?.stack ?? e?.message ?? e)
  process.exitCode = 2
})

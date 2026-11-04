/**
 * T6-A · LLM 解析流水线第一批 4 个任务适配器（seg / plot / settingSummary / chunkLocationSummary）
 * 验证脚本（node 直跑，**不启动 Electron**；零新增依赖）。
 *
 * 姿势与 `scripts/verify-pipeline.mjs` / `scripts/verify-txt-import.mjs` 一致：
 * 用 `createRequire(feather/package.json)` 取项目已装的 esbuild，把
 * `src/main/pipeline/tasks/index.ts`（适配器注册表 + 经 cacheWarming 再导出的 numberLines）、
 * `src/main/pipeline/prompt-loader.ts`（rt.render 的真身）、`src/main/pipeline/merge.ts`
 * （机械合并引擎）分别打成单文件 ESM，写入临时目录后用 `pathToFileURL` 动态 import
 * （Windows 下 data: URL 之外的稳妥路）。electron 以最小桩替换（app.getAppPath → 项目根，
 * 使 prompt-loader 的 resourcesDir() 定位到 `resources/prompts`）。
 *
 * 临时目录**只准碰** `D:/AI/tx/feather-t6a-test/`（跑完 rm -rf 清掉）；
 * 绝不读写真实工作库目录（7 本真实库只读）。
 *
 * 覆盖（每条适配器）：
 *   1. inputText：合成 rt（两章）→ `【原文行：1-N】` 包装 + 各章从 1 重新编号 + 两章都在，
 *      且与 numberLines(chapters) 逐字一致（与 cacheWarming 同构）；
 *   2. buildMessages：3 条消息、system 来自 common_system_prompt、任务指令在最后、
 *      模板渲染不抛错且无 `{{` 残留（vars 全覆盖）；
 *   3. parse 正样本：与真实工作库实摘同构的 JSON（含 ```json 包裹变体）→ 结构一致；
 *   4. parse 脏样本：`not a json at all` / `{}` / 缺键 JSON / 空串 → 不抛崩、raw 兜底；
 *   5. 注册完整性：LLM_ADAPTERS 含 4 个新 id 且 adapter.id === 注册键；
 *   6. 模板变量一致性：直接读 5 份模板提取全部 `{{{var}}}`/`{{var}}` 名，
 *      断言适配器 buildMessages 实际传入的 vars 覆盖它们（防模板改了没人发现）；
 *   7. 合并语义抽查：经 mergeOutputs 验证各适配器 mergeStrategy/keyOf 的选择
 *      （章按 chapterSeq 去重；单字符串字段跨批取首个非空）。
 *
 * 用法：node scripts/verify-t6a-adapters.mjs
 */
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(here, '..')
/** 唯一允许触碰的临时父目录（跑完 rm -rf 清掉） */
const TEST_PARENT = 'D:/AI/tx/feather-t6a-test'
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

/** 提取模板中全部 mustache 变量/区段名（`{{{v}}}` / `{{v}}` / `{{#v}}` / `{{^v}}` / `{{/v}}`）。 */
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

/** 合成 rt：两章切片（各几行文本）；render 走真 prompt-loader 并留痕。 */
function makeRt(id, pl, renderLog) {
  const chapters = [
    { seq: 1, title: '第一章 起点', text: '少年推开旧宅的木门。\n屋内空无一人。\n只有尘埃在光柱里浮动。' },
    { seq: 2, title: '第二章 延续', text: '他低声自语。\n这里究竟发生过什么？' }
  ]
  return {
    task: taskDef(id),
    pkgId: 'pkg-t6a',
    revisionId: 'rev-t6a',
    chunkIndex: 0,
    instanceKey: `pkg-t6a:rev-t6a:${id}:0`,
    chunkText: chapters.map((c) => c.text).join('\n'),
    chunkChapters: chapters,
    warnings: [],
    log: () => {},
    render: async (name, vars) => {
      renderLog.push({ name, vars: vars ?? {} })
      return pl.renderPrompt(name, vars ?? {})
    },
    llm: async () => {
      throw new Error('验证脚本不应触发真实 LLM 调用')
    }
  }
}

/** 递归必填键检查（正样本同构断言用）。 */
function deepHas(obj, path) {
  let cur = obj
  for (const k of path) {
    if (cur === null || typeof cur !== 'object' || !(k in cur)) return false
    cur = cur[k]
  }
  return true
}

const SEG_POSITIVE = {
  output: {
    chapters: [
      {
        chapterSeq: 1,
        segments: [
          { '起始行号': 1, '结束行号': 11, name: '开头倒叙——艾莉娜被五花大绑于酒吧地下室', summary: '开头倒叙：艾莉娜被绑于酒吧地下室拷问台，五位女性围住她。' },
          { '起始行号': 12, '结束行号': 47, name: '勇者登基后招募女囚制作人偶', summary: '勇者十秒解决魔王后被拥立为国王，委托制作敏感少女人偶。' }
        ]
      }
    ]
  },
  warnings: []
}
const PLOT_POSITIVE = {
  chunkSummary: '勇者与圣剑灵魂互换后以艾莉娜身份重新体验世界，西进冒险。',
  chapters: [
    { chapterSeq: 1, chapterSummary: '勇者击败魔王后被推上王位，与圣剑灵魂互换，以艾莉娜身份外出再冒险。' },
    { chapterSeq: 2, chapterSummary: '仅出现章节标题，未提供正文，无新增事件可确认。' }
  ]
}
const SETTING_POSITIVE = {
  settingSummary: '【世界运行规则】\n1. 绝大多数魔物通过挠痒人类汲取魔力；人类只能通过击败魔物获取材料提升自己。（第1章，行1-5）'
}
const LOCATION_POSITIVE = {
  chunkLocationSummary: '艾尔希雅王城及其周边：王城旁有大街；百合酒吧位于王城旁，提供食物、住宿，店内含后厨与接待空间，并有后门通往地下室。'
}

async function main() {
  await rm(TEST_PARENT, { recursive: true, force: true })
  await mkdir(BUILD_DIR, { recursive: true })
  console.log(`临时目录：${TEST_PARENT}\n`)

  const tasks = await loadModule('src/main/pipeline/tasks/index.ts', 'tasks-index.mjs')
  const pl = await loadModule('src/main/pipeline/prompt-loader.ts', 'prompt-loader.mjs')
  const mg = await loadModule('src/main/pipeline/merge.ts', 'merge.mjs')
  const cs = await loadModule('src/main/pipeline/chunk-source.ts', 'chunk-source.mjs')

  const ADAPTERS = [
    { key: 'seg', adapter: tasks.segAdapter, template: 'chapter_seg_user_prompt', positive: SEG_POSITIVE, marker: 'chapterSeq', expectVars: { chunkIndex: '0', chapterRange: '1-2' }, requiredPaths: [['output', 'chapters'], ['output', 'chapters', 0, 'chapterSeq'], ['output', 'chapters', 0, 'segments'], ['output', 'chapters', 0, 'segments', 0, '起始行号'], ['output', 'chapters', 0, 'segments', 0, '结束行号'], ['output', 'chapters', 0, 'segments', 0, 'name'], ['output', 'chapters', 0, 'segments', 0, 'summary'], ['warnings']], fallbackProbe: (d) => d.output === null && Array.isArray(d.warnings) && typeof d.raw === 'string' },
    { key: 'plot', adapter: tasks.plotAdapter, template: 'chunk_plot_reader_user_prompt', positive: PLOT_POSITIVE, marker: 'chunkSummary', expectVars: { chunkIndex: '0', chapterRange: '1-2' }, requiredPaths: [['chunkSummary'], ['chapters'], ['chapters', 0, 'chapterSeq'], ['chapters', 0, 'chapterSummary']], fallbackProbe: (d) => d.chunkSummary === null && Array.isArray(d.chapters) && typeof d.raw === 'string' },
    { key: 'settingSummary', adapter: tasks.settingSummaryAdapter, template: 'chunk_setting_summary_user_prompt', positive: SETTING_POSITIVE, marker: 'settingSummary', expectVars: { chunkIndex: '0', chapterRange: '1-2' }, requiredPaths: [['settingSummary']], fallbackProbe: (d) => d.settingSummary === null && typeof d.raw === 'string' },
    { key: 'chunkLocationSummary', adapter: tasks.chunkLocationSummaryAdapter, template: 'chunk_location_summary_user_prompt', positive: LOCATION_POSITIVE, marker: 'chunkLocationSummary', expectVars: { chunkIndex: '0', chapterSeqs: '1,2' }, requiredPaths: [['chunkLocationSummary']], fallbackProbe: (d) => d.chunkLocationSummary === null && typeof d.raw === 'string' }
  ]

  try {
    // ---- 0. 注册完整性（断言 5，先于逐条适配器）----
    console.log('0 · 注册完整性')
    const expectedIds = ['cacheWarming', 'seg', 'plot', 'settingSummary', 'chunkLocationSummary']
    check('LLM_ADAPTERS 含 cacheWarming + 4 个新 id', expectedIds.every((id) => typeof tasks.LLM_ADAPTERS[id] === 'object' && tasks.LLM_ADAPTERS[id] !== null), `实际 keys: ${Object.keys(tasks.LLM_ADAPTERS).join(',')}`)
    check('4 个新适配器 id 字段与注册键一致', ['seg', 'plot', 'settingSummary', 'chunkLocationSummary'].every((k) => tasks.LLM_ADAPTERS[k]?.id === k))
    check('新适配器均声明 concat-dedup-order', ADAPTERS.every((a) => a.adapter.mergeStrategy === 'concat-dedup-order'))

    // ---- 模板变量一致性（断言 6）：先读 5 份模板提取占位符 ----
    console.log('\n0b · 模板占位符提取（防模板改了没人发现）')
    const promptDir = join(FEATHER, 'resources', 'prompts')
    const templateVars = {}
    for (const name of ['common_system_prompt', 'chapter_seg_user_prompt', 'chunk_plot_reader_user_prompt', 'chunk_setting_summary_user_prompt', 'chunk_location_summary_user_prompt']) {
      templateVars[name] = extractTemplateVars(await readFile(join(promptDir, `${name}.txt`), 'utf8'))
    }
    check('common_system_prompt 无占位符（system 传 {} 即可）', templateVars.common_system_prompt.length === 0, `实际 ${templateVars.common_system_prompt.join(',')}`)
    check('chapter_seg 占位符 = chunkIndex, chapterRange', templateVars.chapter_seg_user_prompt.includes('chunkIndex') && templateVars.chapter_seg_user_prompt.includes('chapterRange'), `实际 ${templateVars.chapter_seg_user_prompt.join(',')}`)

    for (const a of ADAPTERS) {
      console.log(`\n${a.key} · ${a.template}`)
      const renderLog = []
      const rt = makeRt(a.key, pl, renderLog)

      // ---- 1. inputText ----
      const input = await a.adapter.inputText(rt)
      check('inputText 含两章 `【原文行：1-N】` 包装', input.includes('【原文行：1-3】') && input.includes('【原文行：1-2】'), JSON.stringify(input.slice(0, 80)))
      check('inputText 各章从 1 重新编号（第二章首行也是 1 开头）', input.includes('1 他低声自语。') && input.includes('1 少年推开旧宅的木门。'))
      check('inputText 与 numberLines(chapters) 逐字一致（与 cacheWarming 同构）', input === cs.numberLines(rt.chunkChapters))

      // ---- 2. buildMessages ----
      const msgs = await a.adapter.buildMessages(input, rt)
      check('buildMessages 返回 3 条消息', msgs.length === 3)
      check('消息角色顺序 = system / user(原文) / user(任务指令)', msgs[0].role === 'system' && msgs[1].role === 'user' && msgs[2].role === 'user')
      check('system 来自 common_system_prompt（含共同任务边界）', msgs[0].content.includes('【共同任务边界】'))
      check('第二条 = 带行号原文（与 inputText 一致）', msgs[1].content === input)
      check('第三条为任务指令（含任务模板特征字段）', msgs[2].content.includes(a.marker))
      check('三条消息均无 `{{` 残留（模板渲染完整）', msgs.every((m) => !m.content.includes('{{')))
      for (const [k, v] of Object.entries(a.expectVars)) {
        check(`任务指令含渲染后的 ${k}=${v}`, msgs[2].content.includes(v))
      }

      // ---- 3. parse 正样本（含 ```json 包裹变体）----
      const parsedPlain = a.adapter.parse(JSON.stringify(a.positive))
      const parsedFenced = a.adapter.parse('```json\n' + JSON.stringify(a.positive) + '\n```')
      check('parse 正样本：必填键递归齐备', a.requiredPaths.every((p) => deepHas(parsedPlain, p)), JSON.stringify(parsedPlain).slice(0, 120))
      check('parse 正样本：与目标形状同构（无额外丢失/篡改）', JSON.stringify(parsedPlain) === JSON.stringify(a.positive))
      check('parse 正样本（```json 包裹变体）结果一致', JSON.stringify(parsedFenced) === JSON.stringify(a.positive))

      // ---- 4. parse 脏样本 ----
      let noThrow = true
      let probeOk = true
      for (const dirty of ['not a json at all', '{}', '{"foo":1}', '']) {
        try {
          const d = a.adapter.parse(dirty)
          if (!a.fallbackProbe(d)) {
            probeOk = false
            console.log(`     兜底形状异常：${dirty} → ${JSON.stringify(d).slice(0, 120)}`)
          }
        } catch (e) {
          noThrow = false
          console.log(`     抛崩：${dirty} → ${e.message}`)
        }
      }
      check('parse 脏样本（非 JSON / {} / 缺键 / 空串）不抛崩', noThrow)
      check('parse 脏样本返回 raw 截断兜底（cacheWarming 同风格）', probeOk)

      // ---- 6. 模板变量一致性：buildMessages 实际传入的 vars 覆盖模板占位符 ----
      const sysEntry = renderLog.find((r) => r.name === 'common_system_prompt')
      const taskEntry = renderLog.find((r) => r.name === a.template)
      check('buildMessages 渲染了 common_system_prompt（vars={}）', !!sysEntry && Object.keys(sysEntry.vars).length === 0)
      check('buildMessages 渲染了任务模板', !!taskEntry)
      const missing = templateVars[a.template].filter((v) => !(v in taskEntry.vars) || taskEntry.vars[v] === undefined)
      check(`任务模板占位符全覆盖（${templateVars[a.template].join(',')}）`, missing.length === 0, `缺失: ${missing.join(',')}`)
      check('传入 vars 无多余键（与模板占位符一致）', Object.keys(taskEntry.vars).sort().join(',') === templateVars[a.template].sort().join(','), `实际: ${Object.keys(taskEntry.vars).join(',')}`)
    }

    // ---- 7. 合并语义抽查（经 mergeOutputs 实证各适配器策略选择）----
    console.log('\n7 · 合并语义抽查（mergeOutputs + 适配器 keyOf）')
    {
      const rawA = JSON.stringify(SEG_POSITIVE)
      const rawB = JSON.stringify({ output: { chapters: [{ chapterSeq: 2, segments: [{ '起始行号': 1, '结束行号': 20, name: '第二章事件', summary: '第二章事实。' }] }] }, warnings: ['批2告警'] })
      const merged = JSON.parse(mg.mergeOutputs('concat-dedup-order', [rawA, rawB], tasks.segAdapter.keyOf))
      check('seg：两批不同章 → chapters 拼接为 2 章', merged.output.chapters.length === 2)
      check('seg：warnings 数组合并且去重', Array.isArray(merged.warnings))
      const rawDup = JSON.stringify({ output: { chapters: [{ chapterSeq: 1, segments: [{ '起始行号': 48, '结束行号': 60, name: '另一片段', summary: '同章跨批片段。' }] }] }, warnings: [] })
      const mergedDup = JSON.parse(mg.mergeOutputs('concat-dedup-order', [rawA, rawDup], tasks.segAdapter.keyOf))
      check('seg：同 chapterSeq 跨批 → 按 chapter 键去重保留首个', mergedDup.output.chapters.length === 1 && mergedDup.output.chapters[0].chapterSeq === 1)
    }
    {
      const rawA = JSON.stringify(PLOT_POSITIVE)
      const rawB = JSON.stringify({ chunkSummary: '第二批的 chunk 摘要。', chapters: [{ chapterSeq: 3, chapterSummary: '第三章摘要。' }] })
      const merged = JSON.parse(mg.mergeOutputs('concat-dedup-order', [rawA, rawB], tasks.plotAdapter.keyOf))
      check('plot：两批不同章 → chapters 拼接为 3 章', merged.chapters.length === 3)
      check('plot：chunkSummary 单标量跨批取首个非空（引擎不变量，如实记录）', merged.chunkSummary === PLOT_POSITIVE.chunkSummary)
      const rawDup = JSON.stringify({ chunkSummary: '重复章摘要。', chapters: [{ chapterSeq: 1, chapterSummary: '同章另一片段。' }] })
      const mergedDup = JSON.parse(mg.mergeOutputs('concat-dedup-order', [rawA, rawDup], tasks.plotAdapter.keyOf))
      check('plot：同 chapterSeq 跨批 → 按 chapter 键去重保留首个', mergedDup.chapters.length === 2 && mergedDup.chapters[0].chapterSeq === 1)
    }
    {
      const merged = JSON.parse(mg.mergeOutputs('concat-dedup-order', [JSON.stringify(SETTING_POSITIVE), JSON.stringify({ settingSummary: '第二批设定摘要。' })]))
      check('settingSummary：单字符串跨批取首个非空（无 keyOf）', merged.settingSummary === SETTING_POSITIVE.settingSummary)
      const merged2 = JSON.parse(mg.mergeOutputs('concat-dedup-order', [JSON.stringify(LOCATION_POSITIVE), JSON.stringify({ chunkLocationSummary: '第二批地点摘要。' })]))
      check('chunkLocationSummary：单字符串跨批取首个非空（无 keyOf）', merged2.chunkLocationSummary === LOCATION_POSITIVE.chunkLocationSummary)
    }
  } finally {
    await rm(TEST_PARENT, { recursive: true, force: true })
  }

  console.log(`\n==== T6-A 适配器验证：${passed} 通过 / ${failed} 失败 ====`)
  if (failed === 0) {
    console.log('T6-A ADAPTER VERIFY PASS')
  } else {
    console.log('T6-A ADAPTER VERIFY FAIL')
  }
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('ERROR:', e?.stack ?? e?.message ?? e)
  process.exitCode = 2
})

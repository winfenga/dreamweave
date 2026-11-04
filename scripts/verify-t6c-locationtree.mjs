/**
 * T6-C · locationTree 聚合型任务适配器验证脚本（node 直跑，**不启动 Electron**；零新增依赖）。
 *
 * 覆盖四组：
 *  A. parse 组装最终态（合成「L2 合并后文本」经 mergeOutputs + locationTreeKeyOf 喂给 parse，
 *     与 orchestrator `runWithBatching → adapter.parse(result.output)` 同链）：
 *     3 upsert 基础树（8 字段严格集 / 合成根 novel-world / 父子挂接 / 根不进 locations）、
 *     merge 重映射与删除、链式 merge 传递闭包（a→b, b→c ⇒ a→c）、悬空父按根处理 + warning、
 *     环截断挂根不无限递归、无效条目跳过 + warning（坏 id / 缺 name / 非字符串数组成员）、
 *     upserts 空数组、脏样本 raw 兜底不抛崩、中文/unicode 字段不损坏、
 *     keepId 不存在跳过 merge、模型 warnings 收取、数字 ID 跨批碰撞首现获胜；
 *  B. inputText / buildMessages：3 条 chunkLocationSummary 上游 → 输入含 3 份摘要与
 *     【Chunk i · 空间摘要】标注；缺字段条目跳过记 rt.warnings；空产物/未挂 readUpstream →
 *     可读错误（含 chunkLocationSummary 字样）；buildMessages 恰 2 条、无 `{{` 残留、
 *     三个模板占位符（读模板文件提取）全覆盖且无多余键；
 *  C. keyOf：id → '7'；keepId → 'merge:3'；无 id 对象 → JSON 串；
 *  D. 注册完整性：LLM_ADAPTERS 含 locationTree。
 *
 * 姿势与 `scripts/verify-t6b-infra.mjs` 一致：`createRequire(feather/package.json)`
 * 取项目已装的 esbuild，把入口打成单文件 ESM 写入临时目录后 `pathToFileURL` 动态 import；
 * electron 以最小桩替换（app.getAppPath → 项目根，使 prompt-loader 的 resourcesDir()
 * 定位到 `resources/prompts`）。
 *
 * 临时目录**只准碰** `D:/AI/tx/feather-t6c-test/`（跑完 rm -rf 清掉）；
 * 绝不读写真实工作库目录（7 本真实库只读）。
 *
 * 用法：node scripts/verify-t6c-locationtree.mjs
 */
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(here, '..')
/** 唯一允许触碰的临时父目录（跑完 rm -rf 清掉） */
const TEST_PARENT = 'D:/AI/tx/feather-t6c-test'
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
    global: true,
    setting: '',
    dependsOn: []
  }
}

/** 合成 rt：render 走真 prompt-loader 并留痕（vars 供模板一致性断言）。 */
function makeRt(renderLog, extra = {}) {
  return {
    task: taskDef('locationTree'),
    pkgId: 'pkg-t6c',
    revisionId: 'rev-t6c',
    chunkIndex: null,
    instanceKey: 'pkg-t6c:rev-t6c:locationTree',
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

/** 合成「L2 合并后文本」：多批模型输出 → mergeOutputs（与 orchestrator 同链同参）。 */
function mergedText(batches) {
  return mg.mergeOutputs('concat-dedup-order', batches.map((b) => JSON.stringify(b)), adapter.keyOf)
}

/** 8 字段严格集（顺序无关，按排序键名比较）。 */
const LOCATION_KEYS = ['aliases', 'ancestorLocationId', 'id', 'identInfos', 'locationType', 'name', 'parentLocationId', 'showOnImpressionMap']

let pl
let adapter
let mg

async function main() {
  await rm(TEST_PARENT, { recursive: true, force: true })
  await mkdir(BUILD_DIR, { recursive: true })
  console.log(`临时目录：${TEST_PARENT}\n`)

  const tasks = await loadModule('src/main/pipeline/tasks/index.ts', 'tasks-index.mjs')
  const mgMod = await loadModule('src/main/pipeline/merge.ts', 'merge.mjs')
  pl = await loadModule('src/main/pipeline/prompt-loader.ts', 'prompt-loader.mjs')
  mg = mgMod
  adapter = tasks.locationTreeAdapter

  try {
    // =====================================================================
    // A · parse 组装最终态（合成合并后文本）
    // =====================================================================
    console.log('A · parse 组装最终态')

    // ---- A1. 基础树：1 根 + 2 子 ----
    {
      const merged = mergedText([
        {
          upserts: [
            { id: '1', name: '艾尔希雅王城', aliases: ['王城'], locationType: '城市', identInfos: ['毗邻魔法草原'], showOnImpressionMap: true, parentLocationId: null, ancestorLocationId: null },
            { id: '2', name: '王城大街', aliases: [], locationType: '街道', identInfos: [], showOnImpressionMap: false, parentLocationId: '1', ancestorLocationId: null },
            { id: '3', name: '百合酒吧', aliases: ['酒吧'], locationType: '建筑', identInfos: ['提供食物与住宿'], showOnImpressionMap: false, parentLocationId: '1', ancestorLocationId: null }
          ],
          merges: []
        }
      ])
      const d = adapter.parse(merged)
      check('A1 locations 恰 3 个', Array.isArray(d.locations) && d.locations.length === 3, JSON.stringify(d.locations?.length))
      check('A1 每个 location 字段集严格等于 8 键', d.locations.every((l) => Object.keys(l).sort().join(',') === LOCATION_KEYS.join(',')), JSON.stringify(Object.keys(d.locations[0] ?? {})))
      check('A1 不含 indexes 等模板外字段', d.locations.every((l) => !('indexes' in l) && !('effectiveParentId' in l) && !('attachmentBasis' in l)))
      check('A1 tree 为合成根 novel-world / 小说世界 / 世界', d.tree.id === 'novel-world' && d.tree.name === '小说世界' && d.tree.locationType === '世界')
      check('A1 合成根 children 含根节点（id=1）', d.tree.children.length === 1 && d.tree.children[0].id === '1')
      check('A1 孙子挂对（1 下挂 2、3）', d.tree.children[0].children.length === 2 && d.tree.children[0].children.map((c) => c.id).join(',') === '2,3')
      check('A1 树子节点同构（8 字段 + children）', Object.keys(d.tree.children[0]).sort().join(',') === [...LOCATION_KEYS, 'children'].sort().join(','))
      check('A1 合成根不进 locations', d.locations.every((l) => l.id !== 'novel-world'))
      check('A1 正样本 warnings 为空数组', Array.isArray(d.warnings) && d.warnings.length === 0, JSON.stringify(d.warnings))
      check('A1 顶层键恰为 locations/tree/warnings', Object.keys(d).sort().join(',') === 'locations,tree,warnings', JSON.stringify(Object.keys(d)))
    }

    // ---- A2. merge：keepId='1' removeIds=['2']，某 upsert parentLocationId='2' → 重映射为 '1' ----
    {
      const merged = mergedText([
        {
          upserts: [
            { id: '1', name: '王城', aliases: [], locationType: '城市', identInfos: [], showOnImpressionMap: true, parentLocationId: null, ancestorLocationId: null },
            { id: '2', name: '王城（旧称）', aliases: [], locationType: '城市', identInfos: [], showOnImpressionMap: true, parentLocationId: null, ancestorLocationId: null }
          ],
          merges: []
        },
        {
          upserts: [
            { id: '3', name: '百合酒吧', aliases: [], locationType: '建筑', identInfos: [], showOnImpressionMap: false, parentLocationId: '2', ancestorLocationId: null }
          ],
          merges: [{ keepId: '1', removeIds: ['2'] }]
        }
      ])
      const d = adapter.parse(merged)
      check('A2 id2 被删、locations 数正确（1、3）', d.locations.length === 2 && d.locations.map((l) => l.id).join(',') === '1,3', JSON.stringify(d.locations.map((l) => l.id)))
      check('A2 parentLocationId 重映射 2→1', d.locations.find((l) => l.id === '3').parentLocationId === '1')
      check('A2 树：3 挂在 1 下', d.tree.children.length === 1 && d.tree.children[0].id === '1' && d.tree.children[0].children.map((c) => c.id).join(',') === '3')
      check('A2 merge 应用无 warning', d.warnings.length === 0, JSON.stringify(d.warnings))
    }

    // ---- A3. 链式 merge 传递闭包：a→b, b→c ⇒ a→c ----
    {
      const merged = mergedText([
        {
          upserts: [
            { id: '1', name: '甲地', aliases: [], locationType: '城市', identInfos: [], showOnImpressionMap: true, parentLocationId: null, ancestorLocationId: null },
            { id: '2', name: '乙地', aliases: [], locationType: '城市', identInfos: [], showOnImpressionMap: true, parentLocationId: null, ancestorLocationId: null },
            { id: '3', name: '丙地', aliases: [], locationType: '城市', identInfos: [], showOnImpressionMap: true, parentLocationId: null, ancestorLocationId: null },
            { id: '4', name: '丁巷', aliases: [], locationType: '街道', identInfos: [], showOnImpressionMap: false, parentLocationId: '1', ancestorLocationId: null }
          ],
          merges: [
            { keepId: '2', removeIds: ['1'] },
            { keepId: '3', removeIds: ['2'] }
          ]
        }
      ])
      const d = adapter.parse(merged)
      check('A3 传递闭包后 4 的父 1→3（keepId 自身除外：2 保留、1 删）', d.locations.map((l) => l.id).join(',') === '2,3,4', JSON.stringify(d.locations.map((l) => l.id)))
      check('A3 4.parentLocationId === "3"', d.locations.find((l) => l.id === '4').parentLocationId === '3')
      check('A3 树：顶级为 2、3；4 挂 3 下', d.tree.children.map((c) => c.id).join(',') === '2,3' && d.tree.children[1].children.map((c) => c.id).join(',') === '4')
    }

    // ---- A4. 悬空父：parentLocationId='99' → 按根处理 + warning ----
    {
      const d = adapter.parse(JSON.stringify({
        upserts: [{ id: '1', name: '浮空地点', aliases: [], locationType: '建筑', identInfos: [], showOnImpressionMap: false, parentLocationId: '99', ancestorLocationId: null }],
        merges: []
      }))
      check('A4 悬空父按根处理（挂在合成根下）', d.tree.children.length === 1 && d.tree.children[0].id === '1')
      check('A4 悬空父有 warning', d.warnings.some((w) => w.includes('99') && w.includes('不存在')), JSON.stringify(d.warnings))
      check('A4 悬空引用不在 locations 里被篡改（原值保留供排查）', d.locations[0].parentLocationId === '99')
    }

    // ---- A5. 环：1 的父是 2、2 的父是 1 → 截断挂根不无限递归 ----
    {
      const d = adapter.parse(JSON.stringify({
        upserts: [
          { id: '1', name: '环甲', aliases: [], locationType: '城市', identInfos: [], showOnImpressionMap: true, parentLocationId: '2', ancestorLocationId: null },
          { id: '2', name: '环乙', aliases: [], locationType: '城区', identInfos: [], showOnImpressionMap: true, parentLocationId: '1', ancestorLocationId: null }
        ],
        merges: []
      }))
      check('A5 环不丢节点（locations 仍 2 个）', d.locations.length === 2)
      check('A5 环入口截断挂根（1 为顶级，2 挂 1 下）', d.tree.children.length === 1 && d.tree.children[0].id === '1' && d.tree.children[0].children.map((c) => c.id).join(',') === '2', JSON.stringify(d.tree))
      check('A5 环有 warning', d.warnings.some((w) => w.includes('环')), JSON.stringify(d.warnings))
    }

    // ---- A5b. 自环：1 的父是自己 ----
    {
      const d = adapter.parse(JSON.stringify({
        upserts: [{ id: '1', name: '自环', aliases: [], locationType: '城市', identInfos: [], showOnImpressionMap: true, parentLocationId: '1', ancestorLocationId: null }],
        merges: []
      }))
      check('A5b 自环截断挂根且无孙子', d.tree.children.length === 1 && d.tree.children[0].id === '1' && d.tree.children[0].children.length === 0)
      check('A5b 自环有 warning', d.warnings.some((w) => w.includes('环')))
    }

    // ---- A6. 无效条目：id 非纯数字 / 缺 name / 非字符串数组成员 ----
    {
      const d = adapter.parse(JSON.stringify({
        upserts: [
          { id: '1', name: '有效根', aliases: [], locationType: '城市', identInfos: [], showOnImpressionMap: true, parentLocationId: null, ancestorLocationId: null },
          { id: 'M-1', name: '坏 id', aliases: [], locationType: '城市', identInfos: [], showOnImpressionMap: true, parentLocationId: null, ancestorLocationId: null },
          { id: '2', name: '', aliases: [], locationType: '城市', identInfos: [], showOnImpressionMap: true, parentLocationId: null, ancestorLocationId: null },
          { id: '01', name: '前导零', aliases: [], locationType: '城市', identInfos: [], showOnImpressionMap: true, parentLocationId: null, ancestorLocationId: null },
          { id: '3', name: '有效子', aliases: ['别名', 42, null, '别名二'], locationType: '街道', identInfos: [7, '线索'], showOnImpressionMap: false, parentLocationId: '1', ancestorLocationId: null },
          'not-an-object'
        ],
        merges: []
      }))
      check('A6 无效条目被跳过，仅剩 1、3', d.locations.map((l) => l.id).join(',') === '1,3', JSON.stringify(d.locations.map((l) => l.id)))
      check('A6 跳过记 warning（≥4 条）', d.warnings.length >= 4, JSON.stringify(d.warnings))
      check('A6 aliases/identInfos 非字符串元素被剔除', d.locations.find((l) => l.id === '3').aliases.join(',') === '别名,别名二' && d.locations.find((l) => l.id === '3').identInfos.join(',') === '线索')
      check('A6 有效子仍挂接正确', d.tree.children[0].children.map((c) => c.id).join(',') === '3')
    }

    // ---- A7. upserts 空数组 ----
    {
      const d = adapter.parse(JSON.stringify({ upserts: [], merges: [] }))
      check('A7 空 upserts → locations=[] + 合成根空 children', Array.isArray(d.locations) && d.locations.length === 0 && d.tree.id === 'novel-world' && d.tree.children.length === 0)
      check('A7 空 upserts 有「模型未产出任何地点」warning', d.warnings.some((w) => w.includes('模型未产出任何地点')), JSON.stringify(d.warnings))
    }

    // ---- A8. 脏样本 raw 兜底不抛崩 ----
    {
      const dirties = ['not a json at all', '{}', '{"upserts":"not-array"}', '', '{"upserts":[{}]}', '{"merges":[]}']
      let noThrow = true
      let shapeOk = true
      for (const dirty of dirties) {
        try {
          const d = adapter.parse(dirty)
          const okShape = Array.isArray(d.locations) && d.tree && d.tree.id === 'novel-world' && Array.isArray(d.tree.children) && Array.isArray(d.warnings)
          if (!okShape) {
            shapeOk = false
            console.log(`     兜底形状异常：${JSON.stringify(dirty).slice(0, 40)} → ${JSON.stringify(d).slice(0, 140)}`)
          }
          if (dirty === 'not a json at all' && typeof d.raw !== 'string') {
            shapeOk = false
            console.log(`     非 JSON 样本缺 raw 兜底字段`)
          }
        } catch (e) {
          noThrow = false
          console.log(`     抛崩：${JSON.stringify(dirty).slice(0, 40)} → ${e.message}`)
        }
      }
      check('A8 脏样本（非 JSON / {} / upserts 非数组 / 空串 / 空对象条目 / 只有 merges）不抛崩', noThrow)
      check('A8 脏样本兜底形状 = locations[] + 合成根 + warnings（非 JSON 另带 raw 截断）', shapeOk)
    }

    // ---- A9. 中文 / unicode 字段不损坏 ----
    {
      const name = '「魔王城」— 地下①②层 🏰'
      const d = adapter.parse(JSON.stringify({
        upserts: [{ id: '1', name, aliases: ['魔王の城', '“魔殿”'], locationType: '城堡', identInfos: ['触手洞穴附近', '含有"禁忌实验室"'], showOnImpressionMap: true, parentLocationId: null, ancestorLocationId: null }],
        merges: [],
        warnings: ['模型自报警告：某地点层级不确定']
      }))
      check('A9 unicode 地点名/别名/线索逐字保留', d.locations[0].name === name && d.locations[0].aliases[0] === '魔王の城' && d.locations[0].aliases[1] === '“魔殿”' && d.locations[0].identInfos[1] === '含有"禁忌实验室"')
      check('A9 树节点同名不损坏', d.tree.children[0].name === name)
      check('A9 模型 warnings 被收取', d.warnings.includes('模型自报警告：某地点层级不确定'), JSON.stringify(d.warnings))
      const d2 = adapter.parse(JSON.stringify({ upserts: [{ id: '1', name: 'x', parentLocationId: null, ancestorLocationId: null }], merges: [], warnings: 'not-array' }))
      check('A9 模型 warnings 非数组 → 忽略不抛崩', Array.isArray(d2.warnings) && d2.warnings.length === 0)
    }

    // ---- A10. merge 边界：keepId 不存在 / removeIds 含 keepId / 环链 ----
    {
      const d = adapter.parse(JSON.stringify({
        upserts: [
          { id: '1', name: '甲', aliases: [], locationType: '城市', identInfos: [], showOnImpressionMap: true, parentLocationId: null, ancestorLocationId: null },
          { id: '2', name: '乙', aliases: [], locationType: '城市', identInfos: [], showOnImpressionMap: true, parentLocationId: null, ancestorLocationId: null }
        ],
        merges: [{ keepId: '9', removeIds: ['1'] }]
      }))
      check('A10 keepId 不存在 → 跳过该 merge + warning，条目不丢', d.locations.length === 2 && d.warnings.some((w) => w.includes('keepId=9')), JSON.stringify(d.warnings))

      const d2 = adapter.parse(JSON.stringify({
        upserts: [
          { id: '1', name: '甲', aliases: [], locationType: '城市', identInfos: [], showOnImpressionMap: true, parentLocationId: null, ancestorLocationId: null },
          { id: '2', name: '乙', aliases: [], locationType: '城市', identInfos: [], showOnImpressionMap: true, parentLocationId: null, ancestorLocationId: null }
        ],
        merges: [{ keepId: '1', removeIds: ['1', '2'] }]
      }))
      check('A10 removeIds 含 keepId 自身 → 忽略该 removeId，keepId 不删', d2.locations.map((l) => l.id).join(',') === '1' && d2.warnings.some((w) => w.includes('含 keepId 自身')), JSON.stringify(d2.warnings))

      const d3 = adapter.parse(JSON.stringify({
        upserts: [
          { id: '1', name: '甲', aliases: [], locationType: '城市', identInfos: [], showOnImpressionMap: true, parentLocationId: null, ancestorLocationId: null },
          { id: '2', name: '乙', aliases: [], locationType: '城市', identInfos: [], showOnImpressionMap: true, parentLocationId: null, ancestorLocationId: null }
        ],
        merges: [
          { keepId: '1', removeIds: ['2'] },
          { keepId: '2', removeIds: ['1'] }
        ]
      }))
      check('A10 merge 环链整体不应用（条目不丢 + warning）', d3.locations.length === 2 && d3.warnings.some((w) => w.includes('merge 链存在环')), JSON.stringify(d3.warnings))
    }

    // ---- A11. 跨批数字 ID 碰撞：dedupe 首现获胜（文件头已知限制的实证） ----
    {
      const merged = mergedText([
        { upserts: [{ id: '1', name: '首批王城', aliases: [], locationType: '城市', identInfos: [], showOnImpressionMap: true, parentLocationId: null, ancestorLocationId: null }], merges: [] },
        { upserts: [{ id: '1', name: '次批王城', aliases: [], locationType: '城市', identInfos: [], showOnImpressionMap: true, parentLocationId: null, ancestorLocationId: null }], merges: [] }
      ])
      const d = adapter.parse(merged)
      check('A11 跨批同 id 碰撞 → 合并后仅 1 条且首现获胜', d.locations.length === 1 && d.locations[0].name === '首批王城', JSON.stringify(d.locations))
    }

    // =====================================================================
    // B · inputText / buildMessages
    // =====================================================================
    console.log('\nB · inputText / buildMessages')
    const upstream = [
      { key: 'pkg-t6c:rev-t6c:chunkLocationSummary:0', value: { chunkLocationSummary: '第0块空间摘要：王城旁有大街，百合酒吧位于王城旁。' } },
      { key: 'pkg-t6c:rev-t6c:chunkLocationSummary:1', value: { chunkLocationSummary: '第1块空间摘要：酒吧后门通往地下室，魔王城在遥远北方。' } },
      { key: 'pkg-t6c:rev-t6c:chunkLocationSummary:2', value: { chunkLocationSummary: '第2块空间摘要：魔法草原毗邻王城。' } }
    ]
    {
      const rt = makeRt([], { readUpstream: async () => upstream })
      const input = await adapter.inputText(rt)
      check('B1 inputText 含 3 份摘要', ['第0块空间摘要', '第1块空间摘要', '第2块空间摘要'].every((s) => input.includes(s)))
      check('B1 inputText 含【Chunk 0/1/2 · 空间摘要】标注', ['【Chunk 0 · 空间摘要】', '【Chunk 1 · 空间摘要】', '【Chunk 2 · 空间摘要】'].every((s) => input.includes(s)))
    }
    {
      const rt = makeRt([], {
        readUpstream: async () => [
          { key: 'pkg-t6c:rev-t6c:chunkLocationSummary:0', value: { chunkLocationSummary: '第0块空间摘要：有摘要。' } },
          { key: 'pkg-t6c:rev-t6c:chunkLocationSummary:1', value: { chapters: [] } },
          { key: 'pkg-t6c:rev-t6c:chunkLocationSummary:2', value: null }
        ]
      })
      const input = await adapter.inputText(rt)
      check('B2 缺 chunkLocationSummary 字段条目跳过（仅 1 块）', input.includes('【Chunk 0 · 空间摘要】') && !input.includes('【Chunk 1'))
      check('B2 跳过条目记 rt.warnings', rt.warnings.length === 2 && rt.warnings.every((w) => w.includes('chunkLocationSummary')), JSON.stringify(rt.warnings))
    }
    {
      const rt = makeRt([], { readUpstream: async () => [] })
      let msg = ''
      try {
        await adapter.inputText(rt)
      } catch (e) {
        msg = e?.message ?? ''
      }
      check('B3 空产物 → 可读错误（含「chunkLocationSummary」字样）', msg.includes('chunkLocationSummary') && msg.includes('请先运行 chunkLocationSummary 任务'), msg)
    }
    {
      const rt = makeRt([])
      let msg = ''
      try {
        await adapter.inputText(rt)
      } catch (e) {
        msg = e?.message ?? ''
      }
      check('B3 未挂 readUpstream → 可读错误', msg.includes('readUpstream'), msg)
    }
    {
      const rt = makeRt([], { readUpstream: async () => [{ key: 'x:y:chunkLocationSummary:0', value: { chunkLocationSummary: null } }] })
      let msg = ''
      try {
        await adapter.inputText(rt)
      } catch (e) {
        msg = e?.message ?? ''
      }
      check('B3 全部条目无摘要正文 → 可读错误', msg.includes('chunkLocationSummary') && msg.includes('均无摘要正文'), msg)
    }
    {
      const renderLog = []
      const rt = makeRt(renderLog, { readUpstream: async () => upstream })
      const input = await adapter.inputText(rt)
      const msgs = await adapter.buildMessages(input, rt)
      check('B4 buildMessages 恰 2 条消息（输入内嵌于指令，不重复）', msgs.length === 2, `实际 ${msgs.length}`)
      check('B4 角色顺序 = system / user', msgs[0].role === 'system' && msgs[1].role === 'user')
      check('B4 system 来自 common_system_prompt（含共同任务边界）', msgs[0].content.includes('【共同任务边界】'))
      check('B4 user 含全部 3 份摘要', ['第0块空间摘要', '第1块空间摘要', '第2块空间摘要'].every((s) => msgs[1].content.includes(s)))
      check('B4 user 含 batchIndex：0 与 latestMapLocations：[]（单轮全文模式常量）', msgs[1].content.includes('batchIndex：0') && msgs[1].content.includes('latestMapLocations：[]'))
      check('B4 两条消息均无 `{{` 残留（模板渲染完整）', msgs.every((m) => !m.content.includes('{{')))

      const sysEntry = renderLog.find((r) => r.name === 'common_system_prompt')
      const taskEntry = renderLog.find((r) => r.name === 'location_tree_user_prompt')
      check('B4 渲染了 common_system_prompt（vars={}）', !!sysEntry && Object.keys(sysEntry.vars).length === 0)
      check('B4 渲染了 location_tree_user_prompt', !!taskEntry)

      // 模板占位符全覆盖（读模板文件提取）
      const tplVars = extractTemplateVars(await readFile(join(FEATHER, 'resources', 'prompts', 'location_tree_user_prompt.txt'), 'utf8'))
      check(`B4 模板占位符恰为 batchIndex/latestMapLocations/chunkLocationSummaries`, tplVars.sort().join(',') === 'batchIndex,chunkLocationSummaries,latestMapLocations', tplVars.join(','))
      const missing = tplVars.filter((v) => !(v in taskEntry.vars) || taskEntry.vars[v] === undefined)
      check('B4 三个模板占位符全覆盖', missing.length === 0, `缺失: ${missing.join(',')}`)
      check('B4 传入 vars 无多余键（与模板占位符一致）', Object.keys(taskEntry.vars).sort().join(',') === tplVars.sort().join(','), `实际: ${Object.keys(taskEntry.vars).join(',')}`)
      check('B4 latestMapLocations 传 JSON 空数组字符串、batchIndex 传 0', taskEntry.vars.latestMapLocations === '[]' && taskEntry.vars.batchIndex === 0)
    }

    // =====================================================================
    // C · keyOf
    // =====================================================================
    console.log('\nC · keyOf')
    const kof = adapter.keyOf
    check('C keyOf 是函数（适配器显式提供）', typeof kof === 'function')
    check('C {id:"7"} → "7"', kof({ id: '7' }) === '7')
    check('C {keepId:"3",removeIds:[]} → "merge:3"', kof({ keepId: '3', removeIds: [] }) === 'merge:3')
    check('C 无 id 对象 → JSON 串兜底', kof({ foo: 'bar' }) === '{"foo":"bar"}')
    check('C 标量 → String 兜底', kof(42) === '42' && kof(null) === 'null')
    check('C 与导出的 locationTreeKeyOf 同一函数', tasks.locationTreeKeyOf === kof)

    // =====================================================================
    // D · 注册完整性
    // =====================================================================
    console.log('\nD · 注册完整性')
    check('D LLM_ADAPTERS 含 locationTree 且 id 一致', typeof tasks.LLM_ADAPTERS.locationTree === 'object' && tasks.LLM_ADAPTERS.locationTree.id === 'locationTree')
    check('D mergeStrategy = concat-dedup-order', adapter.mergeStrategy === 'concat-dedup-order')
  } finally {
    await rm(TEST_PARENT, { recursive: true, force: true })
  }

  console.log(`\n==== T6-C locationTree 验证：${passed} 通过 / ${failed} 失败 ====`)
  if (failed === 0) {
    console.log('T6-C LOCATIONTREE VERIFY PASS')
  } else {
    console.log('T6-C LOCATIONTREE VERIFY FAIL')
  }
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('ERROR:', e?.stack ?? e?.message ?? e)
  process.exitCode = 2
})

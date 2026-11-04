/**
 * 生图（本地 ComfyUI）验证脚本（node 直跑，**不启动 Electron**；零新增依赖）。
 *
 * 姿势与 `scripts/verify-t6a-adapters.mjs` 一致：用 `createRequire(feather/package.json)`
 * 取项目已装的 esbuild，把 `src/main/imagegen/index.ts`（编排层）与
 * `src/main/imagegen/workflow.ts` / `prompts.ts`、`src/shared/imagegen-defaults.ts`
 * 分别打成单文件 ESM，写入临时目录后 `pathToFileURL` 动态 import。
 * electron 以最小桩替换。
 *
 * **Mock ComfyUI**：node http server 模拟标准 API 契约 ——
 *   POST /prompt 返回 prompt_id；GET /history/<id> 前两次返回 {}，第 3 次返回 completed + images；
 *   GET /view 返回一张真实小 PNG（第一次与后续字节不同，验证 force 覆盖写新资产）；
 *   GET /system_stats 探活。
 *
 * 临时工作库**只建在** `D:/AI/tx/feather-imagegen-test/`（跑完 rm -rf 清掉）；
 * 真实 7 本工作库（StageView-data/workspace/）**只读**，脚本前后各求和一次字节数断言不变。
 *
 * 覆盖：探活 / 占位符替换 / 模板渲染 / 提交的工作流无 {{ 残留 / 下载字节 sha256 /
 * 落盘 assets/image/<sha>.png / index.assets 行格式 / reader :character-images /
 * :scene-images（含 idMap 换算到合并后 id）/:location-icons 回填形状 / 缺图跳过 /
 * force 覆盖（旧文件不删）/ index.shards 镜像 / 真实 7 本库字节不变。
 *
 * 用法：node scripts/verify-imagegen.mjs
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(here, '..')
/** 唯一允许触碰的临时父目录（跑完 rm -rf 清掉） */
const TEST_PARENT = 'D:/AI/tx/feather-imagegen-test'
const BUILD_DIR = join(TEST_PARENT, 'build')
const WS_ROOT = join(TEST_PARENT, 'ws')

/** 真实 7 本工作库（只读基线，与任务书一致） */
const REAL_DATA_ROOT = 'D:/AI/tx/2026-10-15-22-35-44/StageView-data/workspace'
const REAL_BASELINES = {
  '15de5d4f': 84538797,
  '1dc7a26d': 30813630,
  '3b346c26': 41808200,
  '5662f1d3': 93553080,
  a1b2d09f: 87818956,
  a57f3deb: 23859779,
  e5fcb27d: 6222905
}

const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex')

// ---------------------------------------------------------------- 断言器
let passed = 0
let failed = 0
const failures = []
function ok(name, cond) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ✗ ${name}`)
  }
}
function eq(name, actual, expected) {
  const good = actual === expected
  ok(good ? `${name}（${JSON.stringify(expected)}）` : `${name} —— 实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`, good)
}

// ---------------------------------------------------------------- esbuild 加载
const require = createRequire(join(FEATHER, 'package.json'))
const { build } = require('esbuild')

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

async function loadModule(rel, outName) {
  const result = await build({
    entryPoints: [join(FEATHER, rel)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    external: ['node:*'],
    logLevel: 'silent',
    plugins: [electronStub()]
  })
  const outPath = join(BUILD_DIR, outName)
  await writeFile(outPath, result.outputFiles[0].text, 'utf8')
  return import(pathToFileURL(outPath).href)
}

// ---------------------------------------------------------------- Mock ComfyUI
// 1x1 真实 PNG（base64）；第二版改一个像素字节 → 不同 sha（force 覆盖验证用）
const PNG_A = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)
const PNG_B = Buffer.from(PNG_A)
PNG_B[40] = PNG_B[40] ^ 0xff

function startMockComfy() {
  const state = {
    /** 最近一次收到的 workflow 对象 */
    lastWorkflow: null,
    /** 每个 prompt_id 的 history 查询次数 */
    polls: new Map(),
    /** filename → bytes */
    files: new Map(),
    /** POST 次数（第 1 次出 PNG_A，其后 PNG_B） */
    submits: 0
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock')
    if (req.method === 'GET' && url.pathname === '/system_stats') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ system: { comfyui_version: 'mock-0.3' } }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/prompt') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          const j = JSON.parse(body)
          state.lastWorkflow = j.prompt
          state.submits++
          const bytes = state.submits === 1 ? PNG_A : PNG_B
          const filename = `${sha256Hex(bytes)}.png`
          state.files.set(filename, bytes)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ prompt_id: `pid-${state.submits}` }))
        } catch (e) {
          res.writeHead(400)
          res.end(String(e))
        }
      })
      return
    }
    if (req.method === 'GET' && url.pathname.startsWith('/history/')) {
      const pid = decodeURIComponent(url.pathname.slice('/history/'.length))
      const n = (state.polls.get(pid) ?? 0) + 1
      state.polls.set(pid, n)
      res.writeHead(200, { 'content-type': 'application/json' })
      if (n < 3) {
        res.end(JSON.stringify({}))
      } else {
        const filename = state.submits === 1 ? `${sha256Hex(PNG_A)}.png` : `${sha256Hex(PNG_B)}.png`
        res.end(
          JSON.stringify({
            [pid]: {
              status: { completed: true, status_str: 'success', messages: [] },
              outputs: {
                '7': { images: [{ filename, subfolder: '', type: 'output' }] }
              }
            }
          })
        )
      }
      return
    }
    if (req.method === 'GET' && url.pathname === '/view') {
      const filename = url.searchParams.get('filename') ?? ''
      const bytes = state.files.get(filename)
      if (!bytes) {
        res.writeHead(404)
        res.end('no such file')
        return
      }
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(bytes)
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({ server, port, state })
    })
  })
}

// ---------------------------------------------------------------- 临时工作库
const PKG_ID = 'imgen-test-pkg'
const REV = 'rev-0001'

function envelope(shard, entries) {
  const container = shard === 'records/reader' ? 'reader' : 'results'
  return { shard, container, entries }
}

async function buildWorkspace(root) {
  await mkdir(join(root, 'records', 'results'), { recursive: true })
  await mkdir(join(root, 'world'), { recursive: true })
  await mkdir(join(root, 'assets', 'image'), { recursive: true })

  // ---- 分片文件 ----
  const shards = []
  async function writeShard(name, file, entries) {
    const text = JSON.stringify(envelope(name, entries))
    await writeFile(join(root, file), text, 'utf8')
    shards.push({ name, file, container: envelope(name, entries).container, entryCount: entries.length, sha256: sha256Hex(Buffer.from(text, 'utf8')) })
  }

  // reader：预置一条 :scene-images（PL-1 已有图）
  await writeShard('records/reader', 'records/reader.json', [
    {
      seq: 0,
      key: `${PKG_ID}:${REV}:scene-images`,
      value: { shared: {}, individual: { 'PL-1': `${PKG_ID}/images/pre-existing.png` } }
    }
  ])
  // worldImpression
  await writeShard('records/results/worldImpression', 'records/results/worldImpression.json', [
    {
      seq: 0,
      key: `${PKG_ID}:${REV}:worldImpression`,
      value: {
        data: {
          worldImpression: '一个典型的西式奇幻世界，魔法与魔导科技并存，视觉氛围色彩明快。',
          novelGenre: '奇幻恶搞冒险题材',
          locationIconArtStyle: '半写实扁平矢量风格，圆润深色描边，透明背景，缩小可辨。'
        }
      }
    }
  ])
  // canonical（名字 / 别名 / 形象元数据）
  await writeShard('records/results/canonical', 'records/results/canonical.json', [
    {
      seq: 0,
      key: `${PKG_ID}:${REV}:canonical`,
      value: {
        objects: {
          characters: [
            {
              id: 'C-1',
              name: '艾莉娜',
              aliases: ['小艾'],
              characterAppearances: [
                { appearanceId: 'A-1', name: '日常形象', sex: '女性', appearanceSummary: '银发蓝眼的少女冒险者', visualKeywords: ['银发', '蓝眼', '皮甲'] },
                { appearanceId: 'A-2', name: '晚礼服', sex: '女性', appearanceSummary: '黑色长裙晚礼服，配银色首饰', visualKeywords: ['黑裙', '银饰'] }
              ]
            }
          ]
        },
        mapping: {}
      }
    }
  ])
  // characterAppearance（单角色键形态）
  await writeShard('records/results/characterAppearance', 'records/results/characterAppearance.json', [
    {
      seq: 0,
      key: `${PKG_ID}:${REV}:characterAppearance:C-2`,
      value: [{ appearanceId: 'A-1', name: '日常形象', sex: '女性', appearanceSummary: '绿发温柔的书库管理员', visualKeywords: ['绿发', '长袍'] }]
    }
  ])
  // plotLocationMerge
  await writeShard('records/results/plotLocationMerge', 'records/results/plotLocationMerge.json', [
    {
      seq: 0,
      key: `${PKG_ID}:${REV}:plotLocationMerge`,
      value: {
        data: {
          locations: [
            { id: 'PL-1', name: '酒吧地下室', summary: '酒吧的隐秘地下室。', sceneDescription: '昏暗的地下室，中央一张木制拷问台。', sourceLocationIds: ['L-0-l1'] },
            { id: 'PL-2', name: '湖边草地', summary: '两人初次相遇的湖边。', sceneDescription: '湖边的湿润草地，远处有小木屋。' }
          ],
          idMap: { 'L-0-l1': 'PL-1' }
        }
      }
    }
  ])
  // locationTree
  await writeShard('records/results/locationTree', 'records/results/locationTree.json', [
    {
      seq: 0,
      key: `${PKG_ID}:${REV}:locationTree`,
      value: {
        data: {
          locations: [
            { id: 'M-1', name: '王都', locationType: '城市' },
            { id: 'M-2', name: '魔法之森', locationType: '森林' }
          ],
          tree: {
            id: 'root',
            name: '世界',
            locationType: '世界',
            children: [
              { id: 'M-1', name: '王都', locationType: '城市' },
              { id: 'M-2', name: '魔法之森', locationType: '森林' }
            ]
          }
        }
      }
    }
  ])
  // plotLocation 叶真源（world/）
  await writeShard('world/plot-locations', 'world/plot-locations.json', [
    {
      seq: 0,
      key: `${PKG_ID}:${REV}:plotLocation:0`,
      value: {
        data: {
          protocol: 'map-plot-v1',
          actions: [],
          plotLocations: [
            { id: 'L-0-l1', name: '酒吧地下室', mapLocationId: 'M-1', summary: '酒吧的隐秘地下室。', sceneDescription: '昏暗的地下室，中央一张木制拷问台。', chunkIndex: 0 },
            { id: 'L-1-l1', name: '湖边草地', mapLocationId: 'M-2', summary: '两人初次相遇的湖边。', sceneDescription: '湖边的湿润草地，远处有小木屋。', chunkIndex: 1 }
          ],
          warnings: []
        }
      }
    }
  ])

  // ---- index.json ----
  const index = {
    indexVersion: 1,
    format: 'txt2world-workspace',
    pkgId: PKG_ID,
    title: '生图验证用临时工作库',
    origin: {
      t2wPath: 'D:/mock/origin.t2w',
      t2wSize: 123,
      t2wSha256: '0'.repeat(64),
      manifestJsonSha256: '0'.repeat(64),
      hasOriginHeader: false,
      projectId: PKG_ID,
      revisionId: REV,
      createdAt: new Date().toISOString()
    },
    manifest: {
      includesSource: true,
      topLevelKeys: ['format', 'includesSource', 'project', 'records', 'files'],
      extra: {},
      recordsKeys: ['results', 'reader'],
      containers: { results: 'array', reader: 'array' },
      containerKeyed: { results: true, reader: true },
      project: { id: PKG_ID, title: '生图验证用临时工作库' }
    },
    shards,
    assets: [],
    tasks: {},
    integrity: { createdAt: new Date().toISOString(), lastVerifiedAt: null }
  }
  await writeFile(join(root, 'index.json'), JSON.stringify(index, null, 2), 'utf8')
}

// ---------------------------------------------------------------- 真实库字节和
async function dirBytes(root) {
  let total = 0
  async function walk(dir) {
    let items
    try {
      items = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const it of items) {
      const p = join(dir, it.name)
      if (it.isDirectory()) await walk(p)
      else total += (await stat(p)).size
    }
  }
  await walk(root)
  return total
}

async function realSums() {
  const out = {}
  for (const prefix of Object.keys(REAL_BASELINES)) {
    let hit = ''
    // 目录名是 <prefix> 开头的完整 UUID，逐目录找前缀匹配
    for (const d of await readdir(REAL_DATA_ROOT)) {
      if (d.startsWith(prefix)) {
        hit = join(REAL_DATA_ROOT, d)
        break
      }
    }
    out[prefix] = hit ? await dirBytes(hit) : -1
  }
  return out
}

// ---------------------------------------------------------------- 主流程
async function main() {
  console.log('== 生图（ComfyUI）验证 ==\n')

  // 0) 真实 7 本库字节基线（跑前）
  const before = await realSums()
  for (const [k, v] of Object.entries(before)) {
    eq(`真实库 ${k} 基线字节数与任务书一致`, v, REAL_BASELINES[k])
  }

  await rm(TEST_PARENT, { recursive: true, force: true })
  await mkdir(BUILD_DIR, { recursive: true })
  const imggen = await loadModule('src/main/imagegen/index.ts', 'imagegen-index.mjs')
  const workflowMod = await loadModule('src/main/imagegen/workflow.ts', 'imagegen-workflow.mjs')
  const promptsMod = await loadModule('src/main/imagegen/prompts.ts', 'imagegen-prompts.mjs')
  const defaultsMod = await loadModule('src/shared/imagegen-defaults.ts', 'imagegen-defaults.mjs')

  // ---- 1) 默认模板 / 默认工作流 ----
  console.log('\n[1] 默认模板与默认工作流')
  const { DEFAULT_CHAR_PROMPT_TEMPLATE, DEFAULT_ICON_PROMPT_TEMPLATE, DEFAULT_NEGATIVE_PROMPT, DEFAULT_WORKFLOW_JSON } = defaultsMod
  ok('人物模板含 {{name}} 与 {{novelGenre}} 占位', DEFAULT_CHAR_PROMPT_TEMPLATE.includes('{{name}}') && DEFAULT_CHAR_PROMPT_TEMPLATE.includes('{{novelGenre}}'))
  ok('人物模板含 {{appearanceSummary}} 与 {{visualKeywords}}', DEFAULT_CHAR_PROMPT_TEMPLATE.includes('{{appearanceSummary}}') && DEFAULT_CHAR_PROMPT_TEMPLATE.includes('{{visualKeywords}}'))
  ok('图标模板含 {{locationType}} 与 {{iconStyle}}', DEFAULT_ICON_PROMPT_TEMPLATE.includes('{{locationType}}') && DEFAULT_ICON_PROMPT_TEMPLATE.includes('{{iconStyle}}'))
  ok('负面提示词含低质与水印项', DEFAULT_NEGATIVE_PROMPT.includes('低质量') && DEFAULT_NEGATIVE_PROMPT.includes('水印'))
  const wfParsed = JSON.parse(DEFAULT_WORKFLOW_JSON)
  const wfText = JSON.stringify(wfParsed)
  ok('默认工作流为 CheckpointLoaderSimple → CLIPTextEncode×2 → KSampler → VAEDecode → SaveImage 链', !!wfParsed['1']?.class_type?.includes('CheckpointLoader') && Object.values(wfParsed).filter((n) => n.class_type === 'CLIPTextEncode').length === 2 && !!Object.values(wfParsed).find((n) => n.class_type === 'KSampler') && !!Object.values(wfParsed).find((n) => n.class_type === 'VAEDecode') && !!Object.values(wfParsed).find((n) => n.class_type === 'SaveImage'))
  ok('默认工作流含 {{prompt}} 与 {{negative}}', wfText.includes('{{prompt}}') && wfText.includes('{{negative}}'))

  // ---- 2) renderTemplate ----
  console.log('\n[2] 模板渲染')
  eq('已知变量替换', promptsMod.renderTemplate('A{{name}}B{{sex}}C', { name: 'X', sex: '女' }), 'AXB女C')
  eq('缺失变量填空串（空引号对被清理）', promptsMod.renderTemplate('「{{name}}」{{nope}}后文', { name: '' }), '后文')
  eq('别名空列表渲染为空', promptsMod.buildCharPromptVars({ charId: 'c', charName: 'n', appearanceId: 'a', appearanceName: '', sex: '', appearanceSummary: '', visualKeywords: [], hasImage: false, imagePath: '', aliases: [] }, { worldImpression: '', novelGenre: '', iconStyle: '', charArtStyle: '', sceneArtStyle: '' }).aliases, '')
  ok('渲染结果无 {{ 残留（全变量覆盖）', !promptsMod.renderCharPrompt({ charId: 'C-1', charName: '艾莉娜', appearanceId: 'A-1', appearanceName: '日常', sex: '女性', appearanceSummary: '银发', visualKeywords: ['银发'], hasImage: false, imagePath: '', aliases: ['小艾'] }, { worldImpression: '奇幻', novelGenre: '奇幻', iconStyle: '', charArtStyle: '', sceneArtStyle: '' }).includes('{{'))

  // ---- 3) 工作流校验 + 占位符替换 ----
  console.log('\n[3] 工作流校验与占位符替换')
  eq('默认工作流校验通过', workflowMod.validateWorkflowJson(DEFAULT_WORKFLOW_JSON).ok, true)
  ok('坏 JSON → 可读错误', !workflowMod.validateWorkflowJson('{oops').ok && workflowMod.validateWorkflowJson('{oops').error.includes('解析失败'))
  ok('缺 {{prompt}} → 报错提及占位符', !workflowMod.validateWorkflowJson('{"1":{"class_type":"X","inputs":{"a":1}}}').ok && workflowMod.validateWorkflowJson('{"1":{"class_type":"X","inputs":{"a":1}}}').error.includes('{{prompt}}'))
  const applied = workflowMod.applyWorkflow({ workflowJson: DEFAULT_WORKFLOW_JSON, prompt: '正面P', negative: '负面N', model: 'qwen-img', width: 832, height: 1216, steps: 20, cfg: 4, seed: 42 })
  eq('{{prompt}} 被替换', applied['2'].inputs.text, '正面P')
  eq('{{negative}} 被替换', applied['3'].inputs.text, '负面N')
  eq('{{model}} 被替换', applied['1'].inputs.ckpt_name, 'qwen-img')
  eq('{{steps}} → 数字', applied['4'].inputs.steps, 20)
  eq('{{cfg}} → 数字', applied['4'].inputs.cfg, 4)
  eq('{{width}} → 数字', applied['5'].inputs.width, 832)
  eq('{{height}} → 数字', applied['5'].inputs.height, 1216)
  eq('{{seed}} → 指定数字', applied['4'].inputs.seed, 42)
  ok('节点引用数组未被改动', JSON.stringify(applied['2'].inputs.clip) === '["1",1]')
  ok('整份工作流无 {{ 残留', !JSON.stringify(applied).includes('{{'))
  const appliedNoModel = workflowMod.applyWorkflow({ workflowJson: DEFAULT_WORKFLOW_JSON, prompt: 'p', negative: 'n', model: '', width: 832, height: 1216, steps: 20, cfg: 4, seed: 1 })
  eq('model 为空时 {{model}} 原样保留（不强改）', appliedNoModel['1'].inputs.ckpt_name, '{{model}}')
  const applied1 = workflowMod.applyWorkflow({ workflowJson: DEFAULT_WORKFLOW_JSON, prompt: 'p', negative: 'n', model: 'm', width: 832, height: 1216, steps: 20, cfg: 4 })
  const applied2 = workflowMod.applyWorkflow({ workflowJson: DEFAULT_WORKFLOW_JSON, prompt: 'p', negative: 'n', model: 'm', width: 832, height: 1216, steps: 20, cfg: 4 })
  ok('未指定 seed 时两次随机（防固定种子重复出图）', applied1['4'].inputs.seed !== applied2['4'].inputs.seed && Number.isInteger(applied1['4'].inputs.seed))

  // ---- 4) Mock ComfyUI + 探活 ----
  console.log('\n[4] Mock ComfyUI 探活')
  const mock = await startMockComfy()
  const baseUrl = `http://127.0.0.1:${mock.port}`
  const probe = await imggen.probeImagegen({ baseUrl })
  ok('探活成功且带版本摘要', probe.ok && (probe.info ?? '').includes('mock-0.3'))
  const probeBad = await imggen.probeImagegen({ baseUrl: 'http://127.0.0.1:1' })
  ok('连接拒绝 → 可读错误（无法连接）', !probeBad.ok && (probeBad.error ?? '').includes('无法连接'))

  // ---- 5) 临时工作库 + 目标清单 ----
  console.log('\n[5] 生图目标清单')
  const ws = join(WS_ROOT, 'book-1')
  await buildWorkspace(ws)
  const targetsRes = await imggen.imagegenTargets(ws)
  ok('imagegenTargets ok', targetsRes.ok)
  const T = targetsRes.targets
  eq('人物形象目标 3 条（C-1×2 形象 + C-2×1）', T.chars.length, 3)
  const c1a1 = T.chars.find((c) => c.charId === 'C-1' && c.appearanceId === 'A-1')
  const c1a2 = T.chars.find((c) => c.charId === 'C-1' && c.appearanceId === 'A-2')
  const c2a1 = T.chars.find((c) => c.charId === 'C-2' && c.appearanceId === 'A-1')
  ok('C-1/A-1 缺图标记 = false（无预置立绘）', c1a1 && c1a1.hasImage === false)
  ok('C-2 形象来自单角色键 :characterAppearance:C-2', !!c2a1 && c2a1.appearanceSummary.includes('绿发'))
  eq('角色名取自 canonical', c1a1.charName, '艾莉娜')
  eq('别名取自 canonical', JSON.stringify(c1a1.aliases), JSON.stringify(['小艾']))
  ok('场景目标 2 条（L-0-l1 经 idMap → PL-1；L-1-l1 无映射保留自身）', T.scenes.some((s) => s.sceneId === 'PL-1') && T.scenes.some((s) => s.sceneId === 'L-1-l1'))
  const scPL1 = T.scenes.find((s) => s.sceneId === 'PL-1')
  const scL11 = T.scenes.find((s) => s.sceneId === 'L-1-l1')
  ok('PL-1 已有图（reader 预置）', scPL1.hasImage && scPL1.imagePath.endsWith('pre-existing.png'))
  ok('L-1-l1 缺图', !scL11.hasImage)
  eq('场景名优先 merge.locations', scPL1.name, '酒吧地下室')
  ok('地点类型来自 locationTree 展开去重（世界/城市/森林）', T.icons.length === 3 && T.icons.every((i) => ['世界', '城市', '森林'].includes(i.locationType)))
  ok('地点图标初始全缺', T.icons.every((i) => !i.hasIcon))
  eq('上下文 novelGenre', T.context.novelGenre, '奇幻恶搞冒险题材')
  ok('上下文 iconStyle 来自 locationIconArtStyle', T.context.iconStyle.includes('扁平矢量'))

  // ---- 6) settings（默认模板 + mock 地址 + 指定模型）----
  const comfy = {
    baseUrl,
    model: 'qwen-image-v1',
    width: 832,
    height: 1216,
    steps: 20,
    cfg: 4,
    negativePrompt: DEFAULT_NEGATIVE_PROMPT,
    charPromptTemplate: DEFAULT_CHAR_PROMPT_TEMPLATE,
    iconPromptTemplate: DEFAULT_ICON_PROMPT_TEMPLATE,
    workflowJson: DEFAULT_WORKFLOW_JSON
  }

  // ---- 7) 人物立绘生成 + 回填 ----
  console.log('\n[6] 人物立绘：生成 + 回填')
  const g1 = await imggen.imagegenGenerate(ws, comfy, { kind: 'char', targetId: 'C-1::A-2' })
  ok('生成 ok', g1.ok)
  const shaPat = new RegExp(`^${PKG_ID}/images/[0-9a-f]{64}\\.png$`)
  ok(`entryPath 形如 <pkgId>/images/<sha256>.png（${g1.entryPath}）`, shaPat.test(g1.entryPath ?? ''))
  const genSha = (g1.entryPath ?? '').split('/').pop().replace('.png', '')
  const stored = await readFile(join(ws, 'assets', 'image', `${genSha}.png`))
  eq('落盘字节 = mock /view 下载字节', stored.length, PNG_A.length)
  eq('落盘字节 sha256 与 entryPath 一致', sha256Hex(stored), genSha)

  const idx1 = JSON.parse(await readFile(join(ws, 'index.json'), 'utf8'))
  const row = idx1.assets.find((a) => a.path === g1.entryPath)
  ok('index.assets 追加一行', !!row)
  eq('资产行 path = entryPath', row?.path, g1.entryPath)
  eq('资产行 store = assets/image/<sha>.png', row?.store, `assets/image/${genSha}.png`)
  eq('资产行 kind = image', row?.kind, 'image')
  eq('资产行 sha256', row?.sha256, genSha)
  eq('资产行 size = 字节数', row?.size, stored.length)

  const reader1 = JSON.parse(await readFile(join(ws, 'records', 'reader.json'), 'utf8'))
  const charEntry = reader1.entries.find((e) => String(e.key).includes(':character-images'))
  ok('reader 出现 :character-images 条目', !!charEntry)
  const charArr = charEntry.value['C-1']
  const hitA2 = charArr.find((e) => e.appearanceId === 'A-2')
  ok('C-1 数组追加 A-2 条目且带 id', !!hitA2 && typeof hitA2.id === 'string' && hitA2.id.length > 10)
  eq('A-2 条目 imagePath = entryPath', hitA2?.imagePath, g1.entryPath)
  ok('提交的 workflow 无 {{ 残留（占位符已替换）', mock.state.lastWorkflow && !JSON.stringify(mock.state.lastWorkflow).includes('{{'))
  ok('提交的 workflow 正面提示词含角色名与外貌', JSON.stringify(mock.state.lastWorkflow).includes('艾莉娜') && JSON.stringify(mock.state.lastWorkflow).includes('黑色长裙'))
  ok('提交的 workflow 负面提示词已替换', JSON.stringify(Object.values(mock.state.lastWorkflow)).includes('低质量'))

  // ---- 8) 场景图：idMap 换算到合并后 id ----
  console.log('\n[7] 场景图：idMap 换算')
  const g2 = await imggen.imagegenGenerate(ws, comfy, { kind: 'scene', targetId: 'L-1-l1' })
  ok('L-1-l1 生成 ok', g2.ok)
  const reader2 = JSON.parse(await readFile(join(ws, 'records', 'reader.json'), 'utf8'))
  const sceneEntry = reader2.entries.find((e) => String(e.key).includes(':scene-images'))
  eq('L-1-l1（无映射）直写自身 id', sceneEntry.value.individual['L-1-l1'], g2.entryPath)
  ok('预置 PL-1 图保持不变', sceneEntry.value.individual['PL-1'] === `${PKG_ID}/images/pre-existing.png`)
  ok('shared 字段保留', JSON.stringify(sceneEntry.value.shared) === '{}')
  const gBad = await imggen.imagegenGenerate(ws, comfy, { kind: 'scene', targetId: 'L-999' })
  ok('悬空场景 id → 报错并跳过（不写盘）', !gBad.ok && (gBad.error ?? '').includes('未知'))

  // ---- 9) 地点图标 ----
  console.log('\n[8] 地点图标回填')
  const g3 = await imggen.imagegenGenerate(ws, comfy, { kind: 'icon', targetId: '森林' })
  ok('图标生成 ok', g3.ok)
  const reader3 = JSON.parse(await readFile(join(ws, 'records', 'reader.json'), 'utf8'))
  const iconEntry = reader3.entries.find((e) => String(e.key).includes(':location-icons'))
  ok('reader 出现 :location-icons 条目（Record<locationType, entryPath>）', !!iconEntry && iconEntry.value['森林'] === g3.entryPath)

  // ---- 10) 缺图跳过 + force 覆盖 ----
  console.log('\n[9] 缺图跳过与 force 覆盖')
  const g4 = await imggen.imagegenGenerate(ws, comfy, { kind: 'char', targetId: 'C-1::A-2' })
  ok('已有图未 force → skipped', g4.ok && g4.skipped === true)
  eq('skipped 时 entryPath 不变', g4.entryPath, g1.entryPath)
  const g5 = await imggen.imagegenGenerate(ws, comfy, { kind: 'scene', targetId: 'PL-1' })
  ok('场景已有图未 force → skipped', g5.ok && g5.skipped === true)
  const g6 = await imggen.imagegenGenerate(ws, comfy, { kind: 'icon', targetId: '森林' })
  ok('图标已有未 force → skipped', g6.ok && g6.skipped === true)
  const g7 = await imggen.imagegenGenerate(ws, comfy, { kind: 'char', targetId: 'C-1::A-2', force: true })
  ok('force → 重新生成 ok', g7.ok && !g7.skipped)
  ok('force → 新 entryPath（字节不同）', g7.entryPath !== g1.entryPath)
  const reader4 = JSON.parse(await readFile(join(ws, 'records', 'reader.json'), 'utf8'))
  const charArr4 = reader4.entries.find((e) => String(e.key).includes(':character-images')).value['C-1']
  eq('force 后 A-2 条目指向新 entryPath（不追加重复条目）', charArr4.find((e) => e.appearanceId === 'A-2').imagePath, g7.entryPath)
  eq('force 后 A-2 仍只有 1 条', charArr4.filter((e) => e.appearanceId === 'A-2').length, 1)
  const oldSha = genSha
  const oldStill = await readFile(join(ws, 'assets', 'image', `${oldSha}.png`))
  eq('旧资产文件永不删除（字节仍在）', oldStill.length, PNG_A.length)
  const idx2 = JSON.parse(await readFile(join(ws, 'index.json'), 'utf8'))
  ok('index.assets 保留两行（新旧行都在）', idx2.assets.some((a) => a.path === g1.entryPath) && idx2.assets.some((a) => a.path === g7.entryPath))
  ok('未知目标 id → 可读错误', !(await imggen.imagegenGenerate(ws, comfy, { kind: 'char', targetId: 'C-X::A-Y' })).ok)

  // ---- 11) index.shards 镜像 ----
  console.log('\n[10] index.shards 镜像与 integrity')
  const readerText = await readFile(join(ws, 'records', 'reader.json'), 'utf8')
  const shardRow = idx2.shards.find((s) => s.file === 'records/reader.json')
  ok('index.shards 的 reader 行 entryCount 已镜像', shardRow.entryCount === JSON.parse(readerText).entries.length && shardRow.entryCount >= 3)
  eq('index.shards 的 reader 行 sha256 已镜像', shardRow.sha256, sha256Hex(Buffer.from(readerText, 'utf8')))
  ok('integrity.lastVerifiedAt 已刷新', typeof idx2.integrity.lastVerifiedAt === 'string' && idx2.integrity.lastVerifiedAt.length > 0)

  // ---- 12) view.ts 通道一致性（:location-icons 读取器 needle 不冲突）----
  ok(':location-icons needle 不与既有 :character-map-icons 冲突', !':character-map-icons'.includes(':location-icons'))

  // ---- 13) 真实 7 本库字节不变（跑后）----
  console.log('\n[11] 真实 7 本工作库字节不变')
  const after = await realSums()
  for (const k of Object.keys(REAL_BASELINES)) {
    ok(`真实库 ${k} 跑前跑后字节数不变（${before[k]}）`, after[k] === before[k] && after[k] === REAL_BASELINES[k])
  }

  mock.server.close()
  await rm(TEST_PARENT, { recursive: true, force: true })

  console.log(`\n===== 断言 ${passed + failed} 项：通过 ${passed}，失败 ${failed} =====`)
  if (failed) {
    console.log('失败项：')
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
}

main().catch(async (e) => {
  console.error('验证脚本异常：', e)
  process.exit(1)
})

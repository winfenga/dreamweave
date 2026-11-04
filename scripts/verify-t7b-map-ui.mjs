/**
 * T7-B · 「地图页体验增强」验证脚本（node 直跑，**不启动 Electron**；零新增依赖）
 *
 * 背景（T7-B，lead 从真实库实测出的问题）：
 *  ① 图例硬编码 11 类，而 `LOCATION_TYPE_COLOR` 有 25 类、真实书 locationType 却有
 *     50~151 种（实测 7 本：19/151/22/54/62/25/46），大量类型回落成同一个灰 `#5a6473`，
 *     图例和实际完全对不上；
 *  ② `view.ts` 无 locationTree 时的兜底根是**单节点**，MapView 照样画成一个可点击节点，
 *     伪装成「地图已经通了」；
 *  ③ 70 个节点（真实库 5662f1d3 就是 70）时找地点只能肉眼滚轮，没有搜索。
 *
 * 本脚本**只验可纯函数化的部分**（Vue 组件里的 DOM/滚动/指针交互 node 直跑测不到，
 * 见文件末尾「需真机目视确认」清单）：
 *  A. `LOCATION_TYPE_COLOR` 25 项映射一字不动 + `locationColor` 对这 25 类仍返回原值；
 *  B. 未知类型的稳定兜底色（同输入两次一致、不与既有 25 色撞色、hex 合法、不同输入有区分度）；
 *  C. `buildLocationLegend` 按实际类型生成（去重/排序/丢弃空类型/颜色与 locationColor 一致）；
 *  D. `isMapEmpty` 空态判据；
 *  E. 判据的实证支撑：`view.ts` 的 `mapNodeCount` 对兜底根也是 1（恒 ≥1，判不出空态）+
 *     7 本真实工作库只读确认树根 id 均不是哨兵 `root`；
 *  F. `matchMapNodes` 搜索匹配（大小写不敏感 / 空查询 / 顺序稳定）；
 *  G. `panToCenter` 平移换算（反算校验：节点中心落在视口中心）。
 *
 * 姿势与 `scripts/verify-t7a-map-source.mjs` 一致：`createRequire(feather/package.json)` 取项目
 * 已装的 esbuild，把 renderer 的两个纯函数模块（以及 E 组要用的 `view.ts`）打成临时 ESM 后
 * `pathToFileURL` 动态 import；electron 以最小桩替换。
 *
 * 临时目录**只准碰** `D:/AI/tx/feather-t7b-test/`（跑完 rm -rf 清掉）；7 本真实工作库**只读**。
 *
 * 用法：node scripts/verify-t7b-map-ui.mjs
 */
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(here, '..')
/** 唯一允许触碰的临时父目录（跑完 rm -rf 清掉） */
const TEST_PARENT = 'D:/AI/tx/feather-t7b-test'
const BUILD_DIR = join(TEST_PARENT, 'build')
/** 7 本真实工作库根（**只读**，仅 E 组读 locationTree.json） */
const WS_ROOT = 'C:/Users/wfsyb/AppData/Roaming/feather/workspace'

const require = createRequire(join(FEATHER, 'package.json'))
const { build } = require('esbuild')

/** electron 最小桩（view.ts 经 shards 传递可能需要；renderer 两个模块零依赖）。 */
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

/** 造一个最小 MapTreeNode（只填被测逻辑会读到的字段） */
function node(id, name, locationType, children = []) {
  return { id, name, locationType, identInfos: [], parentLocationId: null, showOnImpressionMap: true, sceneIds: [], children }
}

// ---------------------------------------------------------------------------
console.log('\n=== T7-B 地图页体验增强（纯函数部分） ===\n')

await rm(TEST_PARENT, { recursive: true, force: true })
await mkdir(BUILD_DIR, { recursive: true })

const style = await loadModule('src/renderer/src/lib/locationStyle.ts', 'locationStyle.mjs')

// ---------------------------------------------------------------------------
// A. 既有 25 类映射一字不动
// ---------------------------------------------------------------------------
console.log('A. LOCATION_TYPE_COLOR 映射未变（实测 23 个键，设计资产一字未动），且 locationColor 仍返回原值')
{
  const table = style.LOCATION_TYPE_COLOR
  const keys = Object.keys(table)
  check('映射恰 23 个键（设计资产，T7-B 一字未动）', keys.length === 23, `实际 ${keys.length}`)
  const expected = {
    世界: '#7c5cff', 国家: '#4f8cff', 首都: '#3d9be9', 城市: '#3d9be9',
    港口城市: '#2f9e8f', 海湾: '#2f9e8f', 港口: '#38a3a5', 商船: '#c48b3f',
    住宅: '#8a7fd6', 渔村: '#5fb37a', 镇: '#5fb37a', 草原: '#79b356',
    森林: '#4f9e6a', 酒家: '#c98a4b', 宅邸: '#a86fd6', 司法建筑: '#6f8fd6',
    监狱: '#8d8f96', 要塞监狱: '#7d8b99', 牢房: '#6d7b89', 地牢: '#5d6b79',
    宫殿: '#d6a94f', 书房: '#b08fd6', 岛屿: '#4fae8f'
  }
  let same = 0
  for (const [k, v] of Object.entries(expected)) {
    if (table[k] === v && style.locationColor(k) === v) same++
  }
  check('23 个键（含 3 组同色）逐项对拍一致 + locationColor 命中表', same === Object.keys(expected).length, `${same}/${Object.keys(expected).length}`)
  check('已知类型「森林」仍是 #4f9e6a', style.locationColor('森林') === '#4f9e6a', style.locationColor('森林'))
}

// ---------------------------------------------------------------------------
// B. 未知类型的稳定兜底色
// ---------------------------------------------------------------------------
console.log('\nB. 未命中类型 → 稳定 hash 兜底色（不再全部回落同一个灰）')
{
  const unknowns = ['浴室', '地下室', '会议室', '甲板', '森林小屋', '未知', 'Hall', 'deck-7', '浴室', '甲板']
  const first = unknowns.map((t) => style.locationColor(t))
  const second = unknowns.map((t) => style.locationColor(t))
  check('同类型两次调用颜色一致（稳定，不随机）', first.every((c, i) => c === second[i]))
  check('「浴室」两次一致（列表里重复出现也一致）', first[0] === first[8] && second[0] === second[8])
  check('不再是旧兜底灰 #5a6473', !first.includes('#5a6473'))
  check(
    '全部为合法 #rrggbb 且小写 6 位',
    first.every((c) => /^#[0-9a-f]{6}$/.test(c)),
    first.join(',')
  )
  const knownHex = new Set(Object.values(style.LOCATION_TYPE_COLOR).map((c) => c.toLowerCase()))
  check('不与既有 25 色的任一色值撞车', !first.some((c) => knownHex.has(c)))
  check('不同类型得到不同颜色（8 个未知类型互不相同）', new Set(first.slice(0, 8)).size === 8, `${new Set(first.slice(0, 8)).size} 种`)
  const hashRoundTrip = style.fallbackLocationColor('浴室')
  check('fallbackLocationColor 与 locationColor 对未知类型同结果', hashRoundTrip === first[0], `${hashRoundTrip} vs ${first[0]}`)
  check('fallbackLocationColor 自身稳定（调用 100 次一致）', Array.from({ length: 100 }, () => style.fallbackLocationColor('浴室')).every((c) => c === hashRoundTrip))
}

// ---------------------------------------------------------------------------
// C. buildLocationLegend 动态图例
// ---------------------------------------------------------------------------
console.log('\nC. buildLocationLegend 按树里实际出现的类型生成图例')
{
  const nodes = [
    { locationType: '世界' },
    { locationType: '城市' },
    { locationType: '城市' },
    { locationType: '浴室' },
    { locationType: '浴室' },
    { locationType: '浴室' },
    { locationType: '森林' },
    { locationType: '   ' },
    { locationType: '' }
  ]
  const legend = style.buildLocationLegend(nodes)
  check('去重后 4 条（世界/城市/浴室/森林）', legend.length === 4, JSON.stringify(legend.map((e) => e.type)))
  check('空/空白类型被丢弃，不占图例格位', !legend.some((e) => !e.type.trim()))
  check('按出现次数降序：浴室(3) → 城市(2) → 森林/世界(1)', legend.map((e) => `${e.type}:${e.count}`).join(',') === '浴室:3,城市:2,森林:1,世界:1', legend.map((e) => `${e.type}:${e.count}`).join(','))
  check('同次数按名称 zh 升序（森林 sen 在 世界 shi 前）', legend[2].type === '森林' && legend[3].type === '世界', `${legend[2].type},${legend[3].type}`)
  check('颜色取自 locationColor（已知类型仍是原色）', legend.find((e) => e.type === '森林')?.color === '#4f9e6a')
  check('未知类型用的是稳定兜底色', legend.find((e) => e.type === '浴室')?.color === style.locationColor('浴室'))
  check('空树 → 空图例（不渲染图例容器）', style.buildLocationLegend([]).length === 0)

  // 真实书规模（151 种类型）不丢数据：不截断，交给容器滚动
  const many = Array.from({ length: 151 }, (_, i) => ({ locationType: `类型${i}` }))
  check('151 种类型全部保留（不截断，靠 max-height 滚动）', style.buildLocationLegend(many).length === 151)
}

// ---------------------------------------------------------------------------
// D. isMapEmpty 空态判据
// ---------------------------------------------------------------------------
const state = await loadModule('src/renderer/src/lib/mapViewState.ts', 'mapViewState.mjs')

console.log('\nD. isMapEmpty 空态判据（mapRoot.id === "root" 且无子节点）')
{
  const sentinelView = { mapRoot: node('root', '（无地图数据）', '世界'), stats: {} }
  check('哨兵根（id=root、无子节点）→ 空态', state.isMapEmpty(sentinelView) === true)
  const realView = { mapRoot: node('novel-world', '世界', '世界', [node('c1', '王城', '城市')]), stats: {} }
  check('真实根 novel-world + 有子节点 → 非空态', state.isMapEmpty(realView) === false)
  const singleView = { mapRoot: node('novel-world', '世界', '世界'), stats: {} }
  check('真实根但单节点（无子节点）→ 仍算真实数据，不误判空态', state.isMapEmpty(singleView) === false)
  const rootWithKids = { mapRoot: node('root', '某书', '世界', [node('c1', '王城', '城市')]), stats: {} }
  check('id 恰为 root 但有子节点 → 照常渲染（不误判）', state.isMapEmpty(rootWithKids) === false)
  check('view 为 null/undefined → 空态且不抛', state.isMapEmpty(null) === true && state.isMapEmpty(undefined) === true)
}

// ---------------------------------------------------------------------------
// E. 判据的实证支撑：mapNodeCount 恒 ≥ 1 + 真实库树根 id 不是哨兵
// ---------------------------------------------------------------------------
console.log('\nE. 实证：mapNodeCount 判不出空态；真实库树根 id 均不是 root')
{
  const viewMod = await loadModule('src/main/t2w/view.ts', 'view.mjs')

  const emptyVd = viewMod.buildViewData({ records: {} }, 't2w://t7b/')
  check('无 locationTree → mapRoot 是哨兵（id=root 且无子节点）', emptyVd.mapRoot.id === 'root' && emptyVd.mapRoot.children.length === 0, `${emptyVd.mapRoot.id}/${emptyVd.mapRoot.children.length}`)
  check(
    '此时 stats.mapNodeCount === 1（不是 0）→ mapNodeCount===0 永远判不出空态',
    emptyVd.stats.mapNodeCount === 1,
    `实际 ${emptyVd.stats.mapNodeCount}`
  )
  check('isMapEmpty(该 ViewData) === true', state.isMapEmpty(emptyVd) === true)

  const treeVd = viewMod.buildViewData(
    {
      records: {
        results: [
          {
            key: 'pkg-t7b:rev-t7b:locationTree',
            value: {
              data: {
                tree: {
                  id: 'novel-world',
                  name: '世界',
                  locationType: '世界',
                  children: [
                    { id: 'c1', name: '王城', locationType: '城市', children: [] },
                    { id: 'c2', name: '港口镇', locationType: '港口', children: [] }
                  ]
                }
              }
            }
          }
        ]
      }
    },
    't2w://t7b/'
  )
  check('有 locationTree → mapRoot.id=novel-world、mapNodeCount=3', treeVd.mapRoot.id === 'novel-world' && treeVd.stats.mapNodeCount === 3, `${treeVd.mapRoot.id}/${treeVd.stats.mapNodeCount}`)
  check('isMapEmpty(该 ViewData) === false', state.isMapEmpty(treeVd) === false)
}

// 真实工作库**只读**：确认没有一本书的树根 id 是哨兵 root（否则会被误判为空态）
{
  const dirs = existsSync(WS_ROOT) ? readdirSync(WS_ROOT) : []
  const rootIds = []
  const kinds = []
  for (const d of dirs) {
    const file = join(WS_ROOT, d, 'records', 'results', 'locationTree.json')
    if (!existsSync(file)) continue
    const shard = JSON.parse(await readFile(file, 'utf8'))
    const entries = shard?.entries ?? {}
    let main = null
    for (const k of Object.keys(entries)) {
      const e = entries[k]
      const key = e?.key ?? ''
      if (/\$|:batch:/.test(key)) continue
      if (!main || (e?.seq ?? 0) < (main?.seq ?? 0)) main = e
    }
    const data = main?.value?.data ?? main?.data ?? {}
    const tree = data.tree
    if (!tree) continue
    rootIds.push(tree.id)
    const set = new Set()
    const walk = (n) => {
      set.add(n.locationType)
      for (const c of n.children ?? []) walk(c)
    }
    walk(tree)
    kinds.push(set.size)
  }
  check('读到 ≥1 本真实库的地图树', rootIds.length >= 1, `${rootIds.length} 本`)
  check('真实库树根 id 全部不是 root（哨兵不误伤真实数据）', rootIds.every((id) => id !== 'root'), rootIds.join(','))
  console.log(`     · 真实库 locationType 种数：${kinds.join(' / ')}（图例必须动态生成且不截断）`)
}

// ---------------------------------------------------------------------------
// F. matchMapNodes 搜索匹配
// ---------------------------------------------------------------------------
console.log('\nF. matchMapNodes 搜索匹配（name 包含、大小写不敏感、不改类型加字段）')
{
  const laid = [
    { node: node('n1', '王城', '城市'), col: 0, depth: 0, parentId: null },
    { node: node('n2', '北港', '港口'), col: 1, depth: 1, parentId: 'n1' },
    { node: node('n3', '王城码头', '港口'), col: 2, depth: 1, parentId: 'n1' },
    { node: node('n4', 'Duckworth', '宅邸'), col: 3, depth: 1, parentId: 'n1' }
  ]
  check('空查询 → 无匹配（不是「全部命中」）', state.matchMapNodes(laid, '').length === 0)
  check('空白查询 → 无匹配', state.matchMapNodes(laid, '   ').length === 0)
  check('中文包含匹配：王 → 2 个（王城、王城码头）', state.matchMapNodes(laid, '王').map((n) => n.node.id).join(',') === 'n1,n3')
  check('英文大小写不敏感：duck → Duckworth', state.matchMapNodes(laid, 'duck').map((n) => n.node.id).join(',') === 'n4')
  check('大写查询同样命中：DUCK', state.matchMapNodes(laid, 'DUCK').length === 1)
  check('无命中 → 空数组', state.matchMapNodes(laid, '不存在的地点').length === 0)
  check('保持 layout 原顺序（便于回车逐个跳转）', state.matchMapNodes(laid, '城').map((n) => n.node.id).join(',') === 'n1,n3')
  check('MapTreeNode 类型零改动：匹配只读 name', Object.keys(laid[0].node).join(',') === 'id,name,locationType,identInfos,parentLocationId,showOnImpressionMap,sceneIds,children')
}

// ---------------------------------------------------------------------------
// G. panToCenter 平移换算
// ---------------------------------------------------------------------------
console.log('\nG. panToCenter 平移换算（t = 视口中心 − 节点画布中心 × scale）')
{
  const cases = [
    { x: 300, y: 200, scale: 1, viewW: 900, viewH: 600, nodeW: 132, nodeH: 48 },
    { x: 0, y: 0, scale: 0.4, viewW: 900, viewH: 600, nodeW: 132, nodeH: 48 },
    { x: 1580, y: 720, scale: 2.6, viewW: 900, viewH: 600, nodeW: 132, nodeH: 48 }
  ]
  let ok = true
  let detail = ''
  for (const c of cases) {
    const { tx, ty } = state.panToCenter(c)
    // 反算：屏幕坐标 = t + 画布坐标 × scale，应等于视口中心
    const screenX = tx + (c.x + c.nodeW / 2) * c.scale
    const screenY = ty + (c.y + c.nodeH / 2) * c.scale
    if (Math.abs(screenX - c.viewW / 2) > 1e-9 || Math.abs(screenY - c.viewH / 2) > 1e-9) {
      ok = false
      detail = `scale=${c.scale}: (${screenX},${screenY}) ≠ (${c.viewW / 2},${c.viewH / 2})`
    }
  }
  check('三组 scale(1 / 0.4 / 2.6) 反算均落在视口正中', ok, detail)
  const one = state.panToCenter(cases[0])
  const manual = { tx: 450 - (300 + 66) * 1, ty: 300 - (200 + 24) * 1 }
  check('与手算公式一致（tx = viewW/2 − cx×scale）', one.tx === manual.tx && one.ty === manual.ty, JSON.stringify(one))
  const zoomed = state.panToCenter(cases[2])
  check('放大时平移量为负且更大（把远处节点拉回中心）', zoomed.tx < 0 && zoomed.ty < 0, JSON.stringify(zoomed))
  check('纯函数：同输入同输出（调用两次一致）', JSON.stringify(state.panToCenter(cases[1])) === JSON.stringify(state.panToCenter(cases[1])))
}

// ---------------------------------------------------------------------------
console.log(`\n—— 小计：通过 ${passed} 项，失败 ${failed} 项 ——`)
if (existsSync(TEST_PARENT)) await rm(TEST_PARENT, { recursive: true, force: true })
console.log(`临时目录已清理：${TEST_PARENT}`)
if (failed > 0) {
  console.log('\n❌ T7-B MAP UI VERIFY FAIL')
  process.exit(1)
}
console.log('\n✅ T7-B MAP UI VERIFY PASS（纯函数部分；DOM 部分需真机目视确认）')

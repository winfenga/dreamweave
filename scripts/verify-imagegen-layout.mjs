/**
 * 场景分组 + Sprite Sheet 布局验证（§5 剩余两项）。
 *
 * 这两块都是**纯计算**，最容易出错的是边界条件：
 *   - 分组：冲突场景被误合并 → 两个不同房间用同一张图（视觉上非常明显）
 *   - 布局：行列算错 → 切格错位，整张图废掉
 *
 * 用法：node scripts/verify-imagegen-layout.mjs
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

async function loadTs(entryRel) {
  const out = await build({
    entryPoints: [join(root, entryRel)],
    absWorkingDir: root,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    write: false,
    logLevel: 'silent',
    external: ['electron']
  })
  const code = out.outputFiles[0].text
  const mod = { exports: {} }
  const { createRequire } = await import('node:module')
  new Function('module', 'exports', 'require', code)(mod, mod.exports, createRequire(import.meta.url))
  return mod.exports
}

const G = await loadTs('src/main/imagegen/scene-grouping.ts')
const S = await loadTs('src/main/imagegen/sprite-sheet.ts')

const failures = []
const checks = []
const check = (name, cond, detail) => {
  checks.push({ name, ok: !!cond, detail })
  if (!cond) failures.push(`${name}（${detail}）`)
}

const mkScene = (sceneId, name, summary, desc, mapLocationId = null) => ({
  sceneId,
  name,
  summary,
  sceneDescription: desc,
  mapLocationId
})

// ---------- ① 场景分组：同节点相似场景应合并 ----------
const A = mkScene('PL-1', '维尔福家书房', '书房室内，书架与书桌', '深色木质书架，写字桌，壁炉', 'M-3')
const B = mkScene('PL-2', '维尔福家书房', '书房室内，书架与书桌', '深色木质书架，写字桌，壁炉边', 'M-3')
const C = mkScene('PL-3', '马赛港口', '室外码头，海风与船只', '码头，帆船，海鸥，蓝天', 'M-7')
const res1 = G.groupScenes([A, B, C])
check('相似场景合并（3 场景 → 2 组）', res1.length === 2, `got=${res1.length}`)
check('合并组含 2 个 sceneId', res1.some((g) => g.sceneIds.length === 2), JSON.stringify(res1.map((g) => g.sceneIds)))
check('独立场景各自成组', res1.some((g) => g.sceneIds.length === 1), '')

// ---------- ② 冲突信号必须分组 ----------
const day = mkScene('PL-10', '庄园庭院', '白天，阳光，庭院', '草坪与喷泉', 'M-1')
const night = mkScene('PL-11', '庄园庭院', '夜晚，月光，庭院', '草坪与喷泉', 'M-1')
const res2 = G.groupScenes([day, night])
check('昼夜冲突强制分组（2 场景 → 2 组）', res2.length === 2, `got=${res2.length}`)

const indoor = mkScene('PL-20', '城门内侧', '室内，门厅', '石墙与火把', 'M-2')
const outdoor = mkScene('PL-21', '城门内侧', '室外，城门外', '石墙与火把', 'M-2')
const res3 = G.groupScenes([indoor, outdoor])
check('室内外冲突强制分组', res3.length === 2, `got=${res3.length}`)

const intact = mkScene('PL-30', '伊夫堡牢房', '完好，整洁', '石墙铁窗', 'M-5')
const ruined = mkScene('PL-31', '伊夫堡牢房', '废墟，坍塌', '石墙铁窗', 'M-5')
const res4 = G.groupScenes([intact, ruined])
check('完好/损毁冲突强制分组', res4.length === 2, `got=${res4.length}`)

// ---------- ③ 不同地图节点不合并 ----------
const n1 = mkScene('PL-40', '书房', '室内书房', '书架书桌', 'M-A')
const n2 = mkScene('PL-41', '书房', '室内书房', '书架书桌', 'M-B')
const res5 = G.groupScenes([n1, n2])
check('不同地图节点不合并', res5.length === 2, `got=${res5.length}`)

// ---------- ④ 边界情况 ----------
check('空列表返回空组', G.groupScenes([]).length === 0, '')
const single = G.groupScenes([A])
check('单场景返回 1 组', single.length === 1 && single[0].sceneIds.length === 1, '')
check('组 id 为 sg1/sg2 形式', res1.every((g) => /^sg\d+$/.test(g.groupId)), JSON.stringify(res1.map((g) => g.groupId)))
check('每组有 reason', res1.every((g) => typeof g.reason === 'string' && g.reason.length > 0), '')
check('每组有 representative', res1.every((g) => !!g.representative), '')

const savings = G.groupSavings([A, B, C])
check('groupSavings 统计正确', savings.sceneCount === 3 && savings.groupCount === 2 && savings.saved === 1, JSON.stringify({ ...savings, groups: undefined }))

// ---------- ⑤ Sprite Sheet 布局 ----------
const l1 = S.planSpriteSheet(4, ['甲', '乙', '丙', '丁'])
check('4 项 → 2×2', l1.columns === 2 && l1.rows === 2, `${l1.columns}x${l1.rows}`)
check('整图尺寸 = 列×格 / 行×格', l1.width === 2 * 512 && l1.height === 2 * 512, `${l1.width}x${l1.height}`)
check('格子数 = 列×行', l1.cells.length === 4, `got=${l1.cells.length}`)
check('无空格（4 项刚好填满）', l1.empty === 0, `got=${l1.empty}`)

const l2 = S.planSpriteSheet(5, ['a', 'b', 'c', 'd', 'e'])
check('5 项 → 3×2', l2.columns === 3 && l2.rows === 2, `${l2.columns}x${l2.rows}`)
check('5 项有 1 个空格', l2.empty === 1, `got=${l2.empty}`)
check('格子数 6', l2.cells.length === 6, `got=${l2.cells.length}`)

const l3 = S.planSpriteSheet(15, Array.from({ length: 15 }, (_, i) => `t${i}`))
check('15 项 → 4×4', l3.columns === 4 && l3.rows === 4, `${l3.columns}x${l3.rows}`)
check('15 项有 1 个空格', l3.empty === 1, `got=${l3.empty}`)

// 行列坐标正确性（行优先）
check('第 0 格在 (0,0)', l2.cells[0].x === 0 && l2.cells[0].y === 0, '')
check('第 1 格在 (512,0)', l2.cells[1].x === 512 && l2.cells[1].y === 0, `${l2.cells[1].x},${l2.cells[1].y}`)
check('第 3 格在 (0,512)（换行）', l2.cells[3].x === 0 && l2.cells[3].y === 512, `${l2.cells[3].x},${l2.cells[3].y}`)
check('第 4 格在 (512,512)', l2.cells[4].x === 512 && l2.cells[4].y === 512, `${l2.cells[4].x},${l2.cells[4].y}`)
check('每格 512×512', l2.cells.every((c) => c.width === 512 && c.height === 512), '')

// 空格 label 为空
check('空格 label 为空串', l2.cells[5].label === '', JSON.stringify(l2.cells[5]))

// 边界
const l0 = S.planSpriteSheet(0, [])
check('0 项返回空布局', l0.columns === 0 && l0.cells.length === 0 && l0.width === 0, '')
const lMax = S.planSpriteSheet(100, Array.from({ length: 100 }, (_, i) => `t${i}`))
check('100 项列数被限制在 maxColumns', lMax.columns === 6, `got=${lMax.columns}`)
check('100 项行数正确', lMax.rows === 17, `got=${lMax.rows}`)

// ---------- ⑥ {{types}} 变量格式 ----------
const types = S.formatSpriteTypes(l2)
check('types 含行列表述', /第 \d+ 格（第 \d+ 行第 \d+ 列）/.test(types), types.split('\n')[0])
check('types 跳过空格', !/第 6 格/.test(types), types)
check('types 行数 = 实填数', types.split('\n').length === 5, `got=${types.split('\n').length}`)

// ---------- ⑦ 模板变量闭环 ----------
const fs = await import('node:fs')
for (const [tpl, needVars] of [
  ['location_type_sprite_sheet.txt', ['columns', 'rows', 'types', 'novelGenre', 'worldImpression', 'locationIconArtStyle']],
  ['character_map_sprite_sheet.txt', ['columns', 'rows', 'types', 'novelGenre', 'worldImpression']],
  ['scene_group_image_user_prompt.txt', ['artStyle', 'worldImpression', 'locations']]
]) {
  const t = fs.readFileSync(join(root, 'resources/prompts', tpl), 'utf8')
  const vars = new Set([...t.matchAll(/\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g)].map((m) => m[1]))
  for (const v of needVars) {
    check(`${tpl} 含变量 {{${v}}}`, vars.has(v), `实际变量：${[...vars].join(',')}`)
  }
}
check('布局能提供 columns/rows/types', typeof l2.columns === 'number' && typeof S.formatSpriteTypes === 'function', '')
check('分组能提供 scene_ids 与 representative', typeof G.groupScenes === 'function', '')

// ---------- 报告 ----------
const bar = '─'.repeat(70)
console.log(`\n${bar}\n  §5 剩余两项验证 · 场景分组 + Sprite Sheet\n${bar}`)
for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : '  ← ' + c.detail}`)
console.log(`\n${bar}`)
if (failures.length) {
  console.log(`  ✗ ${failures.length} 项失败 / 共 ${checks.length} 项\n${bar}\n`)
  process.exit(1)
}
console.log(`  ✓ ${checks.length} 项全部通过\n${bar}\n`)

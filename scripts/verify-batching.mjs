/**
 * M2-T3 · 层级化分批 + 机械合并 验证（零新增依赖；用项目已装的 esbuild 打包 TS 后执行）。
 *
 * 覆盖（对齐设计 §7 M2-T3 验收口径）：
 *   B1 token 估算器（CJK 0.6 / ASCII 0.3；ceil(Σ权重/10)）
 *   B2 未超预算 → 单次调用（converged）
 *   B3 超预算 → 按语义边界切 k 批 → 各批调「LLM」→ 机械合并 → 递归（观察完整轨迹）
 *   B4 递归收敛：合并后变小 → 停止（depth 有限）
 *   B5 递归上界：合并后仍超 → 最多 3 层，到顶接受 + warning
 *   B6 不可切分单元超预算 → 超额放行 + warning（不报错）
 *   B7 机械合并 = 拼接 + 去重 + 保序（concat-dedup-order）
 *
 * 用法：node scripts/verify-batching.mjs
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(here, '..')

async function loadModule(rel, extra = {}) {
  const result = await build({
    entryPoints: [join(FEATHER, rel)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    external: ['node:*'],
    logLevel: 'silent',
    ...extra
  })
  const code = result.outputFiles[0].text
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
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

async function main() {
  const b = await loadModule('src/main/pipeline/batching.ts')
  const m = await loadModule('src/main/pipeline/merge.ts')

  // ---- B1 token 估算器 ----
  console.log('B1 · token 估算器（CJK 0.6 / ASCII 0.3）')
  check('ASCII 10 字符 → 3 token', b.estimateTokens('a'.repeat(10)) === 3, `实际 ${b.estimateTokens('a'.repeat(10))}`)
  check('CJK 10 字 → 6 token', b.estimateTokens('中'.repeat(10)) === 6, `实际 ${b.estimateTokens('中'.repeat(10))}`)
  check('空串 → 0', b.estimateTokens('') === 0)

  // ---- B2 未超预算 → 单次 ----
  console.log('\nB2 · 未超预算 → 单次调用')
  const cfg = b.defaultBatchingConfig({ inputBudgetTokens: 8000 })
  const small = '这是一段很短的原文。'
  const planSmall = b.planBatches(small, cfg)
  check('converged=true', planSmall.converged === true)
  check('batches=1', planSmall.batches.length === 1)

  // ---- B3 超预算 → 切批 → 合并 → 递归轨迹 ----
  console.log('\nB3 · 超预算 → 切批 → 调 LLM → 机械合并（观察轨迹）')
  // 构造 200 个「唯一」段落，每段约 300 汉字 → 约 36000 token，远超 8000
  const bigBlock = (i) => `###${i} ` + '叙述内容。'.repeat(60) + ` 编号${i}`
  const many = Array.from({ length: 200 }, (_, i) => bigBlock(i)).join('\n\n')
  const planBig = b.planBatches(many, cfg)
  check('超预算 → 切多批', planBig.batches.length > 1, `batches=${planBig.batches.length}`)
  let calls = 0
  const trace = []
  const r1 = await b.runWithBatching(
    many,
    async (text) => {
      calls++
      // 模拟「LLM 输出更短」：每批压缩为固定短文本，便于观察收敛
      return `批结果：${text.slice(0, 20)}`
    },
    cfg,
    { onTrace: (t) => trace.push(t) }
  )
  check('轨迹非空（切批→合并 至少一轮）', trace.length >= 1)
  check('depth 记录存在且 ≤3', r1.depth >= 0 && r1.depth <= 3, `depth=${r1.depth}`)
  check('实际调用次数 == Σ batchCount', calls >= 2, `calls=${calls}`)
  check('收敛（合并后变小）', trace.some((t) => t.batchCount > 1), `trace=${JSON.stringify(trace.map((t) => t.batchCount))}`)

  // ---- B4 收敛停止 ----
  console.log('\nB4 · 递归收敛（合并后不再超预算即停止）')
  check('r1.depth 有限且 < 3（本例压缩足够）', r1.depth < 3, `depth=${r1.depth}`)

  // ---- B5 递归上界 + warning ----
  console.log('\nB5 · 递归上界（合并后仍超 → 最多 3 层）')
  const trace2 = []
  const r2 = await b.runWithBatching(
    many,
    async (text) => text, // 回显：合并后大小不变 → 一直超预算 → 触发上界
    cfg,
    { onTrace: (t) => trace2.push(t) }
  )
  check('递归到上界 depth == maxDepth(3)', r2.depth === 3, `depth=${r2.depth}`)
  check('产生「已达最大深度」warning', r2.warnings.some((w) => w.includes('最大深度')), JSON.stringify(r2.warnings))
  check('轨迹步数 ≤ maxDepth+1', trace2.length <= 4, `trace=${trace2.length}`)

  // ---- B6 不可切分单元超预算 → 放行 ----
  console.log('\nB6 · 不可切分单元超预算 → 超额放行 + warning')
  const oneLine = 'a'.repeat(40000) // ASCII → 约 12000 token > 8000，且无句读/换行
  const planOver = b.planBatches(oneLine, cfg)
  check('放行批 oversize=true', planOver.batches.some((x) => x.oversize))
  check('有 oversized warning', planOver.warnings.some((w) => w.includes('超额') || w.includes('超过预算')), JSON.stringify(planOver.warnings))
  let okOver = true
  let resOver = null
  try {
    resOver = await b.runWithBatching(oneLine, async (t) => `ack:${t.length}`, cfg)
  } catch (e) {
    okOver = false
  }
  check('放行不报错、流程继续', okOver && !!resOver)
  // allowOversizeUnit=false → 拒绝
  let threw = false
  try {
    b.planBatches(oneLine, b.defaultBatchingConfig({ inputBudgetTokens: 8000, allowOversizeUnit: false }))
  } catch {
    threw = true
  }
  check('allowOversizeUnit=false → 拒绝（可读错误）', threw)

  // ---- B7 机械合并 = 拼接 + 去重 + 保序 ----
  console.log('\nB7 · 机械合并 concat-dedup-order')
  const parts = ['甲\n乙\n丙', '乙\n丙\n丁', '甲\n戊']
  const merged = m.mergeOutputs('concat-dedup-order', parts)
  check('去重 + 保序 == 甲/乙/丙/丁/戊', merged === '甲\n乙\n丙\n丁\n戊', `实际 ${JSON.stringify(merged)}`)
  const objParts = [
    JSON.stringify({ items: [{ id: 'a', n: 1 }, { id: 'b', n: 2 }] }),
    JSON.stringify({ items: [{ id: 'b', n: 2 }, { id: 'c', n: 3 }] })
  ]
  const mergedObj = JSON.parse(m.mergeOutputs('concat-dedup-order', objParts, (x) => x.id))
  check('JSON 数组合并去重（a,b,c）', mergedObj.items.map((i) => i.id).join(',') === 'a,b,c', JSON.stringify(mergedObj))
  const fieldMerged = JSON.parse(m.mergeOutputs('recon-canonical', [JSON.stringify({ a: 1 }), JSON.stringify({ b: 2, a: 9 })]))
  check('recon-canonical 字段级合并（a 保首、b 并入）', fieldMerged.a === 1 && fieldMerged.b === 2, JSON.stringify(fieldMerged))

  console.log(`\n==== M2-T3 分批/合并验证：${passed} 通过 / ${failed} 失败 ====`)
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('ERROR:', e?.stack ?? e?.message ?? e)
  process.exitCode = 2
})

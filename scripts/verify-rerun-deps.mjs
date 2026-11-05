/**
 * 解析面板「重跑」必须带依赖闭包（静态 + 逻辑回归）。
 *
 * 事故（用户实测「重跑按钮没反应」）：
 *   `rerun(taskId)` 原先实现是 `start([taskId])`，只传目标任务。
 *   而编排器对 `range` 是**严格过滤**（不在 range 里的任务不调度），
 *   于是重跑 mangaEffects 时它的上游 mangaScript 被滤掉 →
 *   每个实例判「依赖未就绪」→ 全部 skipped → 秒结束 → 界面毫无变化。
 *
 * 用法：node scripts/verify-rerun-deps.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')

const checks = []
function check(name, cond, detail = '') {
  checks.push({ name, ok: !!cond, detail })
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : detail ? `  — ${detail}` : ''}`)
}

const src = readFileSync(join(ROOT, 'src/renderer/src/components/ParsePanel.vue'), 'utf8')

// ===========================================================================
// ① 静态：rerun 不再是裸 start([taskId])
// ===========================================================================
console.log('\n① 静态检查')
check('不再直接 start([taskId])', !/void\s+start\(\[taskId\]\)/.test(src), '仍是裸传单任务')
check('rerun 内做了依赖闭包展开', /function rerun[\s\S]{0,2200}while\s*\(grew\)/.test(src), '未找到闭包循环')
check('rerun 使用 dependsOn', /function rerun[\s\S]{0,2200}dependsOn/.test(src), '未读 dependsOn')
check('rerun 用 depBaseOf 剥后缀', /function rerun[\s\S]{0,2200}depBaseOf\(dep\)/.test(src), '未剥依赖后缀')
check('rerun 按拓扑序输出（rows 过滤）', /function rerun[\s\S]{0,2200}rows\.value\.filter/.test(src), '未按 rows 过滤')
check('有「全部被跳过」的兜底提示', /全部被跳过/.test(src), '缺提示')

// ===========================================================================
// ② 用真实注册表验证闭包逻辑（复刻 rerun 的算法）
// ===========================================================================
console.log('\n② 闭包算法（用真实注册表）')
const registry = JSON.parse(readFileSync(join(ROOT, 'resources/pipeline/task-registry.json'), 'utf8'))
const tasks = registry.tasks ?? registry
const byId = new Map(tasks.map((t) => [t.id, t]))
const depBaseOf = (d) => {
  const i = d.indexOf(':')
  return i < 0 ? d : d.slice(0, i)
}

function closureOf(seedIds) {
  const picked = new Set(seedIds)
  let grew = true
  while (grew) {
    grew = false
    for (const id of [...picked]) {
      const t = byId.get(id)
      if (!t) continue
      for (const dep of t.dependsOn ?? []) {
        const base = depBaseOf(dep)
        if (byId.has(base) && !picked.has(base)) {
          picked.add(base)
          grew = true
        }
      }
    }
  }
  return [...picked]
}

/** 闭包是否依赖自洽：每个节点的依赖都在集合内（或不是注册表任务）。 */
function isDepClosed(ids) {
  const set = new Set(ids)
  for (const id of ids) {
    const t = byId.get(id)
    if (!t) continue
    for (const dep of t.dependsOn ?? []) {
      const base = depBaseOf(dep)
      if (byId.has(base) && !set.has(base)) return { ok: false, missing: `${id} 需要 ${base}` }
    }
  }
  return { ok: true }
}

// 逐任务验证：每个任务的闭包都必须是依赖自洽的
let bad = []
for (const t of tasks) {
  const c = closureOf([t.id])
  const r = isDepClosed(c)
  if (!r.ok) bad.push(`${t.id}: ${r.missing}`)
}
check('每个任务的闭包都依赖自洽（33/33）', bad.length === 0, bad.slice(0, 3).join(' | '))

// 具体几个「有上游」的任务必须捞到依赖
const cases = [
  { id: 'mangaEffects', must: ['mangaScript'] },
  { id: 'mangaMusic', must: ['mangaScript'] },
  { id: 'characterAppearance', must: ['canonical'] },
  { id: 'worldImpression', must: ['plot'] },
  { id: 'locationTree', must: ['chunkLocationSummary'] }
]
for (const c of cases) {
  const got = closureOf([c.id])
  const missing = c.must.filter((m) => !got.includes(m))
  check(
    `${c.id} 的闭包含 ${c.must.join(',')}`,
    missing.length === 0,
    `缺 ${missing.join(',')}；实际 ${got.length} 项`
  )
}

// 闭包必须严格大于单任务（证明确实补了东西）
const soloCount = cases.filter((c) => closureOf([c.id]).length > 1).length
check('有上游的任务闭包都 > 1 项', soloCount === cases.length, `${soloCount}/${cases.length}`)

// 无依赖的任务闭包就是自己
const cacheOnly = closureOf(['cacheWarming'])
check('cacheWarming 闭包只有自己（无依赖）', cacheOnly.length === 1 && cacheOnly[0] === 'cacheWarming', cacheOnly.join(','))

// ===========================================================================
// ③ 与「按用途分档」按钮口径一致
// ===========================================================================
console.log('\n③ 与子集按钮口径一致')
check('子集按钮也用同一套闭包循环', /function buildSubset[\s\S]{0,2600}while\s*\(grew\)/.test(src), '未找到')
check('子集与 rerun 都用 depBaseOf', (src.match(/depBaseOf\(dep\)/g) ?? []).length >= 2, '调用点不足')

// ===========================================================================
// ④ 主进程侧：range 严格过滤的语义未被改坏（确认修的是调用方而不是过滤）
// ===========================================================================
console.log('\n④ 编排器 range 语义')
const orch = readFileSync(join(ROOT, 'src/main/pipeline/orchestrator.ts'), 'utf8')
check('编排器仍严格过滤 range', /rangeSet\s*&&\s*!rangeSet\.has/.test(orch) || /rangeSet\.has\(t\.id\)/.test(orch), '过滤逻辑变了')
check('range 语义文档仍说明严格过滤', /严格/.test(orch) || /rangeSet/.test(orch), '')

const bar = '─'.repeat(64)
const fails = checks.filter((c) => !c.ok)
console.log(`\n${bar}\n  重跑依赖闭包回归\n${bar}`)
console.log(`  共 ${checks.length} 项`)
console.log(bar)
if (fails.length) {
  console.log(`  ✗ ${fails.length} 项失败\n${bar}\n`)
  process.exit(1)
}
console.log(`  ✓ ${checks.length} 项全部通过\n${bar}\n`)

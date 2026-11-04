/**
 * 特效可播覆盖率审计（A 线）。
 *
 * 回答一个问题：`effect-catalog.json` 的 N 条特效里，有多少条**所有** track
 * 都有对应的 handler（= 能完整播出来），多少条会被运行时「跳过并告警」。
 *
 * 这是 A 线每批改造的验收依据：
 *   批次 1（cutin + actor）    预期 30/74 → 38/74
 *   批次 5（剩余 6 个 handler）预期 → 74/74
 *
 * 用法：
 *   node scripts/verify-effect-coverage.mjs           # 人类可读
 *   node scripts/verify-effect-coverage.mjs --json    # 机器可读
 *   node scripts/verify-effect-coverage.mjs --expect 38   # 断言通过数（CI 用）
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const argv = process.argv.slice(2)
const jsonOnly = argv.includes('--json')
const expectIdx = argv.indexOf('--expect')
const expect = expectIdx >= 0 ? Number(argv[expectIdx + 1]) : null

const catalog = JSON.parse(readFileSync(join(root, 'resources', 'effects', 'effect-catalog.json'), 'utf8'))
const entries = Array.isArray(catalog) ? catalog : (catalog.effects ?? catalog.items ?? [])

/**
 * 已实现的 handler kind：从 handlers 目录的文件名推断**不可靠**（文件名≠kind），
 * 所以直接读每个 handler 源的 `kind:` 字面量。这样也能顺手抓出「文件存在但没导出 kind」的情况。
 */
const HANLDER_DIR = join(root, 'src', 'renderer', 'src', 'lib', 'stageEffects', 'handlers')
const handlerKinds = new Set()
const malformed = []
for (const f of readdirSync(HANLDER_DIR)) {
  if (!f.endsWith('.ts') || f === 'index.ts') continue
  const src = readFileSync(join(HANLDER_DIR, f), 'utf8')
  const m = /\bkind:\s*'([a-zA-Z0-9_-]+)'/.exec(src)
  if (m) handlerKinds.add(m[1])
  else malformed.push(f)
}

/** 每条特效的 track kind 列表 */
const rows = entries.map((e) => {
  const kinds = (e.tracks ?? []).map((t) => t.kind)
  const missing = [...new Set(kinds.filter((k) => !handlerKinds.has(k)))]
  return { id: e.id, name: e.name, kinds: [...new Set(kinds)], missing, playable: missing.length === 0 }
})

const playable = rows.filter((r) => r.playable)
const broken = rows.filter((r) => !r.playable)

/** kind 维度统计 */
const kindStats = new Map()
for (const r of rows) {
  for (const k of r.kinds) {
    const s = kindStats.get(k) ?? { entries: 0, implemented: handlerKinds.has(k) }
    s.entries++
    kindStats.set(k, s)
  }
}

const sortedKinds = [...kindStats.entries()].sort((a, b) => b[1].entries - a[1].entries)

if (jsonOnly) {
  console.log(
    JSON.stringify(
      {
        total: entries.length,
        playable: playable.length,
        broken: broken.length,
        coverage: Number(((playable.length / entries.length) * 100).toFixed(1)),
        handlerKinds: [...handlerKinds].sort(),
        malformedHandlers: malformed,
        kinds: sortedKinds.map(([kind, s]) => ({ kind, entries: s.entries, implemented: s.implemented })),
        excluded: broken.map((r) => ({ id: r.id, name: r.name, missing: r.missing }))
      },
      null,
      2
    )
  )
  if (expect !== null && playable.length !== expect) {
    console.error(`✗ 期望可播 ${expect} 条，实际 ${playable.length} 条`)
    process.exit(1)
  }
  process.exit(0)
}

const bar = '─'.repeat(72)
const pct = ((playable.length / entries.length) * 100).toFixed(1)
console.log(`\n${bar}\n  特效可播覆盖率审计\n${bar}`)
console.log(`  目录总数 ${entries.length} · 可完整播放 ${playable.length} · 会被跳过 ${broken.length}（覆盖率 ${pct}%）`)
console.log(`  已实现 handler ${handlerKinds.size} 种：${[...handlerKinds].sort().join(', ')}`)
if (malformed.length) console.log(`  ⚠ ${malformed.length} 个 handler 文件未导出 kind：${malformed.join(', ')}`)

console.log(`\n【kind 维度】`)
for (const [kind, s] of sortedKinds) {
  const mark = s.implemented ? '✓' : '✗'
  console.log(`  ${mark} ${kind.padEnd(14)} ${String(s.entries).padStart(3)} 条${s.implemented ? '' : '  ← 缺 handler'}`)
}

if (broken.length) {
  console.log(`\n【会被跳过的 ${broken.length} 条】`)
  for (const r of broken) {
    console.log(`  ${r.id.padEnd(22)} ${r.name.padEnd(16)} 缺 kind: ${r.missing.join(', ')}`)
  }
}

console.log(`\n${bar}`)
if (expect !== null) {
  if (playable.length === expect) {
    console.log(`  ✓ 可播条数符合预期（${expect}）`)
    console.log(bar + '\n')
  } else {
    console.log(`  ✗ 期望 ${expect} 条，实际 ${playable.length} 条`)
    console.log(bar + '\n')
    process.exit(1)
  }
} else {
  console.log(bar + '\n')
}

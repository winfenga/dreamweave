/**
 * 提示词模板版本比对：新版线上快照（prompts_20261104）vs 我们仓库现有（resources/prompts）。
 *
 * 用途：增量设计文档 §1 声称「8 个可以直接覆盖、15 个只差换行符」，
 * 这里用逐字节比对给出可复现的证据，避免凭文档拍脑袋。
 *
 * 用法：node scripts/compare-prompts.mjs [--json]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const OUR = join(root, 'resources', 'prompts')
const NEW = 'D:/AI/tx/2026-10-15-22-35-44/recon/prompts_20261104'
const OLD_SNAP = 'D:/AI/tx/2026-10-15-22-35-44/recon/prompts'

const jsonOnly = process.argv.includes('--json')

/** 归一化换行（CRLF/CR → LF），用于区分「实质改动」与「仅换行符差异」 */
const norm = (s) => s.replace(/\r\n?/g, '\n')
/** 提取模板里出现的变量名（{{var}} / {{{var}}} / 区段标记） */
const varsOf = (s) => {
  const out = new Set()
  for (const m of s.matchAll(/\{\{\{?\s*([#^/]?)\s*([\w.]+)\s*\}?\}\}/g)) {
    if (m[1] === '/' ) continue
    out.add((m[1] === '#' || m[1] === '^' ? '' : '') + m[2])
  }
  return out
}

const ls = (d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.txt')).sort() : [])
const ours = ls(OUR)
const news = ls(NEW)
const oldSnap = ls(OLD_SNAP)
const oursSet = new Set(ours)
const newSet = new Set(news)
/** 新版存在、我们没有 */
const added = news.filter((f) => !oursSet.has(f))
/** 我们存在、新版不存在（多半是官方已弃用 → 404） */
const removed = ours.filter((f) => !newSet.has(f))
/** 双方同名 */
const common = news.filter((f) => oursSet.has(f))

const rows = common.map((f) => {
  const a = readFileSync(join(OUR, f), 'utf8')
  const b = readFileSync(join(NEW, f), 'utf8')
  const identicalRaw = a === b
  const identicalNorm = norm(a) === norm(b)
  // 变量集合是否变化（变量变了对我们是破坏性的：我们可能没填新变量）
  const va = varsOf(a)
  const vb = varsOf(b)
  const addedVars = [...vb].filter((v) => !va.has(v))
  const removedVars = [...va].filter((v) => !vb.has(v))
  return {
    file: f,
    ourBytes: Buffer.byteLength(a, 'utf8'),
    newBytes: Buffer.byteLength(b, 'utf8'),
    delta: Buffer.byteLength(b, 'utf8') - Buffer.byteLength(a, 'utf8'),
    identicalRaw,
    identicalNorm,
    addedVars,
    removedVars
  }
})

/** 「只差换行符」= 归一化后完全相同但原始不同 */
const newlineOnly = rows.filter((r) => !r.identicalRaw && r.identicalNorm)
/** 实质改动 */
const realChanges = rows.filter((r) => !r.identicalNorm)
/** 完全一致 */
const identical = rows.filter((r) => r.identicalRaw)

/** 是否有变量变化（最危险的一类） */
const varChanged = realChanges.filter((r) => r.addedVars.length || r.removedVars.length)

/** 我们本地快照 vs 新版（复核旧快照是否真是 CRLF） */
const oldSnapEol = oldSnap.length
  ? (() => {
      const f = oldSnap[0]
      const s = readFileSync(join(OLD_SNAP, f), 'utf8')
      return { sample: f, hasCRLF: s.includes('\r\n'), bytes: Buffer.byteLength(s, 'utf8') }
    })()
  : null

if (jsonOnly) {
  console.log(
    JSON.stringify(
      {
        ourCount: ours.length,
        newCount: news.length,
        common: common.length,
        added,
        removed,
        identical: identical.map((r) => r.file),
        newlineOnly: newlineOnly.map((r) => r.file),
        realChanges: realChanges.map((r) => ({
          file: r.file,
          delta: r.delta,
          addedVars: r.addedVars,
          removedVars: r.removedVars
        })),
        varChanged: varChanged.map((r) => ({ file: r.file, addedVars: r.addedVars, removedVars: r.removedVars })),
        oldSnapEol
      },
      null,
      2
    )
  )
  process.exit(0)
}

const bar = '─'.repeat(72)
console.log(`\n${bar}\n  提示词模板比对 · 新版 ${news.length} vs 我们 ${ours.length}\n${bar}`)
console.log(`  同名 ${common.length} · 新版新增 ${added.length} · 我们独有（疑似弃用） ${removed.length}`)
console.log(`  完全一致 ${identical.length} · 仅换行符差异 ${newlineOnly.length} · 实质改动 ${realChanges.length}`)
if (oldSnapEol) {
  console.log(`  旧快照样本 ${oldSnapEol.sample}：CRLF=${oldSnapEol.hasCRLF}（验证「只差换行符」说法）`)
}

if (realChanges.length) {
  console.log(`\n【实质改动（需要覆盖）】`)
  for (const r of realChanges.slice().sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))) {
    const sign = r.delta >= 0 ? '+' : ''
    const warn = r.addedVars.length ? ` ⚠ 新增变量 ${r.addedVars.join(',')}` : ''
    const warn2 = r.removedVars.length ? ` ⚠ 删除变量 ${r.removedVars.join(',')}` : ''
    console.log(`  ${r.file.padEnd(46)} ${r.ourBytes} → ${r.newBytes} (${sign}${r.delta})${warn}${warn2}`)
  }
}

if (added.length) {
  console.log(`\n【新版有、我们没有（${added.length}）】`)
  for (const f of added) console.log(`  + ${f}`)
}

if (removed.length) {
  console.log(`\n【我们有、新版没有（${removed.length}，疑似官方弃用）】`)
  for (const f of removed) console.log(`  - ${f}`)
}

console.log(`\n${bar}`)
if (varChanged.length) {
  console.log(`  ⚠ ${varChanged.length} 个模板的变量集合变了，直接覆盖可能静默填空串：`)
  for (const r of varChanged) console.log(`     ${r.file}`)
} else {
  console.log('  ✓ 所有实质改动均未变更变量集合，可直接覆盖')
}
console.log(bar + '\n')

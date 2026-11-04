/**
 * QA-M0 · 样本包只读性基线（记录 / 复核）
 *
 * 目的：证明 8 个样本包在验证过程中**从未被写回**——记录 mtime + size + sha256，
 *       验证跑完后复核必须完全一致（尤其 4 号用户原始包）。
 *
 * 用法：
 *   node scripts/qa-m0-baseline.mjs record   # 写基线 JSON
 *   node scripts/qa-m0-baseline.mjs check    # 与基线比对（任一不符 → 退出码 1）
 */
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const SAMPLE_DIR = 'D:/aaaTemp'
const BASELINE = join(here, 'qa-m0-baseline.json')

async function scan() {
  const names = (await readdir(SAMPLE_DIR)).filter((n) => n.toLowerCase().endsWith('.t2w')).sort()
  const rows = []
  for (const n of names) {
    const p = join(SAMPLE_DIR, n)
    const st = await stat(p)
    const buf = await readFile(p)
    rows.push({
      name: n,
      size: st.size,
      mtimeMs: st.mtimeMs,
      sha256: createHash('sha256').update(buf).digest('hex')
    })
  }
  return rows
}

const mode = process.argv[2] ?? 'record'
const rows = await scan()

if (mode === 'record') {
  await writeFile(BASELINE, JSON.stringify(rows, null, 2), 'utf8')
  console.log(`已记录 ${rows.length} 个样本包基线 → ${BASELINE}`)
  for (const r of rows) console.log(`  ${r.sha256.slice(0, 16)}…  ${r.size}  ${r.name}`)
  process.exitCode = 0
} else {
  const base = JSON.parse(await readFile(BASELINE, 'utf8'))
  const byName = new Map(base.map((r) => [r.name, r]))
  let bad = 0
  for (const r of rows) {
    const b = byName.get(r.name)
    if (!b) { console.log(`❌ 基线缺失: ${r.name}`); bad++; continue }
    const same = b.size === r.size && b.mtimeMs === r.mtimeMs && b.sha256 === r.sha256
    if (!same) { console.log(`❌ 样本包被改动: ${r.name}  size ${b.size}->${r.size}  mtime ${b.mtimeMs}->${r.mtimeMs}  sha ${b.sha256.slice(0,16)}->${r.sha256.slice(0,16)}`); bad++ }
  }
  if (rows.length !== base.length) { console.log(`❌ 样本数量变化: ${base.length} -> ${rows.length}`); bad++ }
  console.log(bad === 0 ? `\n✅ 8 包 mtime/size/sha256 与基线完全一致（只读性成立）` : `\n❌ ${bad} 处不一致`)
  process.exitCode = bad === 0 ? 0 : 1
}

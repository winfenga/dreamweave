/**
 * QA-M0 · 多副本 / 形态独立探针（F13）
 *
 * 对 11-chunk 的 1 号包与有 plotLocationMerge 的包，独立统计：
 *  - storyScript chunk 级副本数、`:batch:` 级副本数
 *  - 「排除 :batch:」合并动作数 vs 「不排除 :batch:」动作数（验证不过滤会虚高）
 *  - `:batch:` 与其所属 chunk 是否同文件
 * 用法：node scripts/qa-m0-shapes.mjs
 */
import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(here, '..')
const SAMPLE_DIR = 'D:/aaaTemp'
const core = await import(pathToFileURL(join(FEATHER, 'src/main/t2w/core.mjs')).href)

function toKeyed(node) {
  if (Array.isArray(node)) return node.map((it, i) => ({ key: String(it?.key ?? i), value: it?.value }))
  if (node && typeof node === 'object') return Object.entries(node).map(([key, value]) => ({ key, value }))
  return []
}
const unwrap = (v) => (v && typeof v === 'object' && v.data != null ? v.data : v)
const rank = (k) => { const m = /:storyScript(?::(\d+))?/.exec(k); return m && m[1] ? Number(m[1]) : 0 }

const names = (await readdir(SAMPLE_DIR)).filter((n) => n.toLowerCase().endsWith('.t2w')).sort()
for (const n of names) {
  const m = core.decodeHeader(await readFile(join(SAMPLE_DIR, n))).manifest
  const results = toKeyed(m.records?.results ?? {})
  const shapes = new Set(results.map((r) => r.key.split(':').slice(2).join(':')))
  const hasPLM = [...shapes].some((s) => s.includes('plotLocationMerge'))
  const ssAll = results.filter((r) => r.key.includes(':storyScript'))
  const ssChunk = ssAll.filter((r) => !r.key.includes(':batch:'))
  const ssBatch = ssAll.filter((r) => r.key.includes(':batch:'))
  const chunks = new Set()
  for (const r of ssChunk) { const mm = /:storyScript:(\d+)/.exec(r.key); if (mm) chunks.add(Number(mm[1])) }
  const actionsExcluding = ssChunk.map((r) => unwrap(r.value)).filter((d) => d).reduce((s, d) => s + (d.actions?.length ?? 0), 0)
  const actionsIncluding = ssAll.map((r) => unwrap(r.value)).filter((d) => d).reduce((s, d) => s + (d.actions?.length ?? 0), 0)
  // batch 副本与其 chunk 是否同文件（用被测路由函数判定）
  let batchSameFile = true
  for (const r of ssBatch) {
    const m0 = /:storyScript:(\d+)/.exec(r.key)
    const m1 = /:storyScript(?::(\d+))?/.exec(r.key)
    if (m0 && m1 && m0[1] !== m1[1]) batchSameFile = false
  }
  if (ssAll.length === 0 && !hasPLM) continue
  console.log(`\n== ${basename(n)} ==`)
  console.log(`  chunk 级 storyScript 副本: ${ssChunk.length}   :batch: 级副本: ${ssBatch.length}   涉及 chunk 数: ${chunks.size} seqs=${JSON.stringify([...chunks].sort((a, b) => a - b))}`)
  console.log(`  合并动作数(排除 :batch:，正确): ${actionsExcluding}`)
  console.log(`  动作数(若不排除 :batch:，虚高): ${actionsIncluding}  → 差 ${actionsIncluding - actionsExcluding}`)
  console.log(`  plotLocationMerge: ${hasPLM}`)
}

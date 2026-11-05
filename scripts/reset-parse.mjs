/**
 * 重置一本工作库的**解析产物**（保留原文与章节）。
 *
 * 用途：解析跑到一半被打断 / 状态错乱（有 running 残留、有失败的半成品）时，
 * 清干净重来比修修补补更可靠。
 *
 * **保留**：index.json（书名/origin）、assets/source（原文）、records/chapters、records/chunks
 * **清空**：records/results、records/attempts、records/tasks（任务状态）
 *          以及 script/ 与 world/ 下的产物目录
 *
 * 用法：
 *   node scripts/reset-parse.mjs <工作库目录名>            # 预览（不删）
 *   node scripts/reset-parse.mjs <工作库目录名> --apply     # 真删
 *   node scripts/reset-parse.mjs <目录名> --apply --dir "D:\path\to\workspace"
 *
 * 默认数据目录自动探测（打包版 → dev）。
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const dirArgIdx = process.argv.indexOf('--dir')
const EXPLICIT_DIR = dirArgIdx >= 0 ? process.argv[dirArgIdx + 1] : null
const APPLY = process.argv.includes('--apply')
const WS_NAME = process.argv.find((a, i) => i > 1 && !a.startsWith('--') && process.argv[i - 1] !== '--dir')

if (!WS_NAME) {
  console.error('用法: node scripts/reset-parse.mjs <工作库目录名> [--apply] [--dir <workspaceRoot>]')
  process.exit(1)
}

const CANDIDATES = [
  EXPLICIT_DIR,
  'D:\\galcomic\\dreamweave\\dist\\win-unpacked\\resources\\DreamWeave-data\\workspace',
  'D:\\galcomic\\dreamweave\\DreamWeave-data\\workspace',
  join(process.env.APPDATA ?? '', 'DreamWeave', 'workspace'),
  join(process.env.APPDATA ?? '', 'feather', 'workspace')
].filter(Boolean)

let wsDir = null
for (const c of CANDIDATES) {
  const p = join(c, WS_NAME)
  if (existsSync(join(p, 'index.json'))) {
    wsDir = p
    break
  }
}
if (!wsDir) {
  console.error(`✗ 找不到工作库 ${WS_NAME}（尝试过 ${CANDIDATES.length} 个根目录）`)
  process.exit(1)
}

console.log(`  工作库: ${wsDir}`)
console.log(`  模式: ${APPLY ? '真删' : '预览（不删，加 --apply 执行）'}\n`)

/** 统计目录体积与文件数（文件也支持：当作单文件计）。 */
function statDir(p) {
  if (!existsSync(p)) return { files: 0, bytes: 0 }
  if (statSync(p).isFile()) return { files: 1, bytes: statSync(p).size }
  let files = 0
  let bytes = 0
  for (const ent of readdirSync(p, { withFileTypes: true })) {
    const abs = join(p, ent.name)
    if (ent.isDirectory()) {
      const sub = statDir(abs)
      files += sub.files
      bytes += sub.bytes
    } else {
      files += 1
      bytes += statSync(abs).size
    }
  }
  return { files, bytes }
}

// 要清空的（解析产物 + 任务状态）
const PURGE = [
  'records/results',
  'records/attempts',
  'records/tasks.json',
  'script',
  'world'
]

console.log('  将清空：')
let totalFiles = 0
let totalBytes = 0
for (const rel of PURGE) {
  const abs = join(wsDir, rel)
  const st = statDir(abs)
  const isFile = existsSync(abs) && statSync(abs).isFile()
  const n = isFile ? 1 : st.files
  const b = isFile ? statSync(abs).size : st.bytes
  totalFiles += n
  totalBytes += b
  if (n > 0) console.log(`    · ${rel.padEnd(22)} ${String(n).padStart(4)} 个文件  ${(b / 1024).toFixed(1)} KB`)
}
console.log(`    合计 ${totalFiles} 个文件 / ${(totalBytes / 1024).toFixed(1)} KB\n`)

console.log('  将保留：')
for (const rel of ['index.json', 'assets/source', 'records/chapters.json', 'records/chunks.json']) {
  const abs = join(wsDir, rel)
  if (existsSync(abs)) {
    const isFile = statSync(abs).isFile()
    const st = isFile ? { files: 1, bytes: statSync(abs).size } : statDir(abs)
    console.log(`    · ${rel.padEnd(22)} ${String(st.files).padStart(4)} 个文件`)
  }
}

if (!APPLY) {
  console.log('\n  预览完成。确认无误后加 --apply 执行。')
  process.exit(0)
}

// 执行
for (const rel of PURGE) {
  const abs = join(wsDir, rel)
  if (existsSync(abs)) rmSync(abs, { recursive: true, force: true })
  console.log(`  ✓ 已清空 ${rel}`)
}

// index 里的 shards 也要清掉指向已删文件的登记（否则自检报「分片缺失」）
const indexPath = join(wsDir, 'index.json')
const idx = JSON.parse(await readFile(indexPath, 'utf8'))
const KEEP_CONTAINERS = new Set(['chapters', 'chunks'])
const before = idx.shards.length
idx.shards = idx.shards.filter((s) => KEEP_CONTAINERS.has(s.container))
// 任务状态表也清空（权威源 records/tasks.json 已删）
idx.tasks = {}
idx.integrity = { ...(idx.integrity ?? {}), lastVerifiedAt: new Date().toISOString() }
await writeFile(indexPath, JSON.stringify(idx, null, 2), 'utf8')
console.log(`  ✓ index.shards 已清理（${before} → ${idx.shards.length} 行，仅留 chapters/chunks）`)
console.log(`  ✓ index.tasks 已清空`)

console.log('\n  完成。这本书现在是「只有原文和章节」的干净状态，可以重新解析。\n')

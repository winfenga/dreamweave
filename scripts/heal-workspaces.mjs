/**
 * 对**真实工作库**批量执行索引自愈（补登记 index.shards 缺行）。
 *
 * 用途：修复本次 bug 影响到的存量工作库。
 * 修复前 `updateShard` 不登记索引，所以凡是跑过解析的库，产物文件都在、
 * 但 `index.shards` 里没有对应行 → 所有聚合型任务报「读不到上游产物」。
 *
 * 用法：
 *   node scripts/heal-workspaces.mjs              # 只体检，不写盘
 *   node scripts/heal-workspaces.mjs --apply      # 真的补登记
 *   node scripts/heal-workspaces.mjs --apply --dir "D:\path\to\workspace"
 *
 * 默认数据目录自动探测（dev → 打包版）。
 */
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = join(here, '..')
const BUILD_DIR = join(ROOT_DIR, 'out', '.heal-workspaces')

const APPLY = process.argv.includes('--apply')
const dirArgIdx = process.argv.indexOf('--dir')
const EXPLICIT_DIR = dirArgIdx >= 0 ? process.argv[dirArgIdx + 1] : null

const require = createRequire(join(ROOT_DIR, 'package.json'))
const { build } = require('esbuild')

function electronStub() {
  return {
    name: 'electron-stub',
    setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }))
      b.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
        contents:
          `export const app = { getAppPath: () => ${JSON.stringify(ROOT_DIR)}, getPath: () => ${JSON.stringify(join(ROOT_DIR, 'out', '.tmp'))} };\n` +
          `export const ipcMain = { handle(){}, on(){} };\n` +
          `export const BrowserWindow = { getAllWindows: () => [], fromWebContents: () => null };\n` +
          `export default { app, ipcMain, BrowserWindow };\n`,
        loader: 'js'
      }))
    }
  }
}

await rm(BUILD_DIR, { recursive: true, force: true })
await mkdir(BUILD_DIR, { recursive: true })
const entry = join(BUILD_DIR, 'entry.ts')
await writeFile(
  entry,
  [
    "export { repairShardIndex } from '../../src/main/workspace/verify'",
    "export { readIndex } from '../../src/main/workspace/index-store'",
    ''
  ].join('\n'),
  'utf8'
)
const built = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  external: ['node:*'],
  logLevel: 'silent',
  plugins: [electronStub()]
})
const outPath = join(BUILD_DIR, 'bundle.mjs')
await writeFile(outPath, built.outputFiles[0].text, 'utf8')
const { repairShardIndex, readIndex } = await import(pathToFileURL(outPath).href)

/** 自动探测 workspace 根。 */
function findWsRoots() {
  if (EXPLICIT_DIR) return [EXPLICIT_DIR]
  const candidates = [
    join(ROOT_DIR, 'DreamWeave-data', 'workspace'),
    join(ROOT_DIR, 'dist', 'win-unpacked', 'resources', 'DreamWeave-data', 'workspace'),
    join(process.env.APPDATA ?? '', 'DreamWeave', 'workspace'),
    join(process.env.APPDATA ?? '', 'feather', 'workspace')
  ]
  return candidates.filter((p) => existsSync(p))
}

const roots = findWsRoots()
if (!roots.length) {
  console.error('✗ 找不到 workspace 目录；用 --dir 指定')
  process.exit(1)
}

console.log(`  模式: ${APPLY ? '补登记（会写盘）' : '只体检（不写盘）'}`)
let totalWs = 0
let needHeal = 0
let healed = 0
let skippedFiles = 0
const details = []

for (const wsRoot of roots) {
  const dirs = readdirSync(wsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(wsRoot, d.name))
    .filter((d) => existsSync(join(d, 'index.json')))
  console.log(`\n  ${wsRoot}  （${dirs.length} 个工作库）`)
  for (const dir of dirs) {
    totalWs++
    let before = 0
    try {
      before = (await readIndex(dir)).shards.length
    } catch {
      details.push({ dir, error: '索引不可读' })
      continue
    }
    if (APPLY) {
      const r = await repairShardIndex(dir)
      if (r.added > 0) {
        healed++
        skippedFiles += r.skipped.length
        const after = (await readIndex(dir)).shards.length
        details.push({ dir, before, after, added: r.added, skipped: r.skipped })
        console.log(`    ✓ ${dir.split(/[\\/]/).pop()}  ${before} → ${after} 行（补 ${r.added}）`)
      }
    } else {
      // 只体检：对比磁盘文件数与索引行数
      const { readdirSync: rd } = await import('node:fs')
      let onDisk = 0
      const walk = (d) => {
        const abs = join(dir, d)
        if (!existsSync(abs)) return
        for (const e of rd(abs, { withFileTypes: true })) {
          if (e.isDirectory()) walk(`${d}/${e.name}`)
          else if (e.name.endsWith('.json') && !e.name.includes('.tmp-')) onDisk++
        }
      }
      for (const d of ['records', 'script', 'world']) walk(d)
      if (onDisk > before) {
        needHeal++
        console.log(`    ! ${dir.split(/[\\/]/).pop()}  索引 ${before} 行 < 磁盘 ${onDisk} 个分片`)
      }
    }
  }
}

await rm(BUILD_DIR, { recursive: true, force: true })

console.log('\n' + '─'.repeat(64))
if (APPLY) {
  console.log(`  扫描 ${totalWs} 个工作库，修复 ${healed} 个${skippedFiles ? `（跳过 ${skippedFiles} 个坏文件）` : ''}`)
} else {
  console.log(`  扫描 ${totalWs} 个工作库，${needHeal} 个需要自愈`)
  if (needHeal) console.log('  加 --apply 执行补登记')
}
console.log('─'.repeat(64) + '\n')

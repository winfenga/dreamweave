/**
 * M1-T3 · 写并发断言（设计 §7 M1-T3 验收口径）。
 *
 * 断言：同一 `script/story-script.<n>` 分片被「用户写回（saveScriptAction）」
 * 与「模拟解析写入（withShard 直改同一分片）」并发提交 →
 *   ① 两路改动**都落盘**（无静默丢更新）；
 *   ② 文件可解析（JSON 完整）；
 *   ③ 全部经 `shards.ts` 唯一入口（本测试两路均通过该入口提交）。
 *
 * 零新增依赖：用 esbuild 把主进程模块打成单文件 ESM 后在 node 执行
 * （与 scripts/verify-workspace-units.mjs 同款加载方式）。
 *
 * 用法：node scripts/verify-m1-t3-concurrency.mjs
 *   （需要先导入过 1 号测试包建立工作库；不依赖 dev 栈，直接读工作库根。）
 */
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(here, '..')
const SRC_PKG = process.env.T3_PKG ?? 'D:/AI/tx/2026-10-15-22-35-44/scratch/p3/test.t2w'

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`)
  } else {
    failed++
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`)
  }
}

/** 用 esbuild 打包指定入口为单文件 ESM 并动态 import。 */
async function loadModule(entry) {
  const result = await build({
    entryPoints: [join(FEATHER, entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    external: ['node:*', 'electron'],
    logLevel: 'silent'
  })
  const code = result.outputFiles[0].text
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
}

const ws = await loadModule('src/main/workspace/index.ts')
const shardWrite = await loadModule('src/main/workspace/shard-write.ts')
const { decodeHeader, computeOffsets } = await import(
  pathToFileURL(join(FEATHER, 'src/main/t2w/core.mjs')).href
)

// ---------------------------------------------------------------- 准备独立工作库
console.log('\n=== 准备：从测试包解包独立工作库 ===')
const root = join(await mkdtemp(join(tmpdir(), 'feather-t3-')), 'workspace')
await mkdir(root, { recursive: true })
const tmpPkg = join(root, 'src.t2w')
await copyFile(SRC_PKG, tmpPkg)
const { index } = await ws.unpack(tmpPkg, root)
check('工作库解包成功', !!index && Array.isArray(index.shards), `${index.shards.length} 分片`)

// 找一个 storyScript 分片与一个目标句（第 1 章第一条 say）
const manifest = await ws.assembleManifest(root, index)
const results = (manifest.records ?? {}).results
const ssEntries = Array.isArray(results)
  ? results.filter((e) => e && typeof e.key === 'string' && e.key.includes(':storyScript'))
  : []
check('工作库含 storyScript 条目', ssEntries.length > 0, `${ssEntries.length} 条`)

let target = null
for (const entry of ssEntries) {
  const data = entry.value && entry.value.data ? entry.value.data : entry.value
  if (!Array.isArray(data?.actions)) continue
  // 首章 chapterSeq 从 actions 自身推导（manifest 无 chapters 字段，原写法恒为 undefined）
  const seqs = data.actions.map((a) => a?.chapterSeq).filter((n) => typeof n === 'number')
  const firstChapterSeq = seqs.length ? Math.min(...seqs) : undefined
  for (const a of data.actions) {
    if (a && a.chapterSeq === firstChapterSeq && (a.type === 'say' || a.type === 'narration' || a.type === 'think') && typeof a.text === 'string' && a.text.length > 4) {
      target = { chapterSeq: a.chapterSeq, order: a.order, type: a.type, text: a.text }
      break
    }
  }
  if (target) break
}
check('找到目标句', !!target, target ? `ch${target.chapterSeq} order=${target.order} ${target.type}` : '')
if (!target) process.exit(1)

// ---------------------------------------------------------------- 并发提交
console.log('\n=== 并发提交：用户写回 × 模拟解析写入（同一分片，同时发起） ===')

// 路 A（用户写回）：saveScriptAction 改目标句文本（经 withShard 唯一入口）
const NEW_TEXT = target.text + '【并发A】'
const pathA = (async () => {
  // saveScriptAction 依赖 workspace session —— 直接用 shard-write 的写回骨架等价提交：
  // buildMutator 四重匹配改 text（与 script-edit.makeTextMutator 同规则）
  return shardWrite.writeStoryScriptShards(root, tmpPkg, () => (entries) => {
    const touched = []
    for (const entry of entries) {
      const data = entry.value && entry.value.data ? entry.value.data : entry.value
      if (!Array.isArray(data?.actions)) continue
      for (let i = 0; i < data.actions.length; i++) {
        const a = data.actions[i]
        if (
          a && a.chapterSeq === target.chapterSeq && a.order === target.order &&
          a.type === target.type && a.text === target.text
        ) {
          a.text = NEW_TEXT
          touched.push({ recordKey: String(entry.key), actionIndex: i })
        }
      }
    }
    return { touchedEntries: touched, rangesUpdated: 0 }
  })
})()

// 路 B（模拟解析写入）：同分片 storyScript 条目挂解析标记字段（经 withShard 唯一入口）
const MARK = { pipeline: 'mock-parse', at: new Date().toISOString() }
const pathB = (async () => {
  const idx = await ws.readIndex(root)
  const file = ws.routeResultsKey(ssEntries[0].key)
  return ws.withShard(root, file, (env) => {
    for (const e of env.entries) {
      const data = e.value && e.value.data ? e.value.data : e.value
      if (data && typeof data === 'object') data.__mockParse = MARK
    }
    return env
  })
})()

const [ra, rb] = await Promise.all([pathA, pathB])
check('路 A（用户写回）成功', ra && ra.ok === true, ra && ra.error ? ra.error : `${ra?.outcome?.touchedFiles?.length ?? 0} 分片`)
check('路 B（模拟解析写入）成功', rb && rb.sha256 && rb.sha256.length === 64, rb?.sha256?.slice(0, 12))

// ---------------------------------------------------------------- 断言
console.log('\n=== 断言：两路改动都落盘、可解析、无静默覆盖 ===')
const idx2 = await ws.readIndex(root)
const m2 = await ws.assembleManifest(root, idx2)
const results2 = (m2.records ?? {}).results
const ss2 = Array.isArray(results2)
  ? results2.filter((e) => e && typeof e.key === 'string' && e.key.includes(':storyScript'))
  : []

// ① 路 A 的文本改动在
let textOk = 0
for (const entry of ss2) {
  const data = entry.value && entry.value.data ? entry.value.data : entry.value
  if (!Array.isArray(data?.actions)) continue
  for (const a of data.actions) {
    if (a && a.chapterSeq === target.chapterSeq && a.order === target.order && a.type === target.type && a.text === NEW_TEXT) textOk++
  }
}
check('① 用户写回的文本改动落盘（无丢更新）', textOk >= 1, `${textOk} 处`)

// ② 路 B 的解析标记在
let markOk = 0
for (const entry of ss2) {
  const data = entry.value && entry.value.data ? entry.value.data : entry.value
  if (data && data.__mockParse && data.__mockParse.pipeline === 'mock-parse') markOk++
}
check('② 模拟解析写入的标记落盘（无静默覆盖）', markOk >= 1, `${markOk} 处`)

// ③ 分片 JSON 可解析 + index 记录的 sha256 一致
let parseOk = true
let shaOk = true
for (const s of idx2.shards) {
  try {
    const bytes = await readFile(join(root, s.file), 'utf8')
    const env = JSON.parse(bytes)
    if (!env || !Array.isArray(env.entries)) parseOk = false
    const { createHash } = await import('node:crypto')
    if (createHash('sha256').update(Buffer.from(bytes, 'utf8')).digest('hex') !== s.sha256) shaOk = false
  } catch {
    parseOk = false
    shaOk = false
  }
}
check('③ 所有分片可解析', parseOk)
check('④ index.shards[].sha256 与磁盘一致', shaOk)

// 清理
await rm(dirname(root), { recursive: true, force: true })

console.log(`\n${failed === 0 ? '🎉 M1-T3 并发断言全部通过' : '💥 M1-T3 并发断言有 ' + failed + ' 项未过'}（共 ${passed + failed} 项）`)
process.exit(failed === 0 ? 0 : 1)

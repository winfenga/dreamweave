/**
 * M0-T0 · origin-header 必要性验证（先于一切存储重构任务执行）
 *
 * 目的：判定「未编辑档导出」能否仅靠 `encodePackage` 达成**整包逐字节相等**，
 *       还是必须保留来源包原始头部字节（`meta/origin-header.bin`）才能达成。
 *
 * 方法（对齐设计 §5.2 / §11 / §7 M0-T0）：
 *   对每个样本包：
 *     1. 读入整包 → decodeHeader 得原始 `12 + jsonLen` 头部字节 + 解析后的 manifest + blobs
 *     2. `encodePackage(manifest, blobs)` 重新编码（内部走 `JSON.stringify(JSON.parse(...))`）
 *     3. 比对：
 *        - headerEqual：`encode` 产出的头部（`12 + reJsonLen`）与原始头部（`12 + jsonLen`）**逐字节相等**
 *        - fullEqual  ：`encode` 整包与原整包**逐字节相等**（更强，头部相等且 blobs 相等即可推出）
 *
 * 结论口径：
 *   全部 headerEqual && fullEqual → **相等** → `meta/origin-header.bin` **可以不留**（导出改走 encodePackage）
 *   否则                          → **不相等** → `meta/origin-header.bin` **必须留**（未编辑档逐字节相等只能靠它）
 *
 * 原因：`JSON.stringify(JSON.parse(x))` 不保证字节相同（如 `60000.0 → 60000`、转义、键序）。
 *
 * 用法：
 *   node scripts/verify-origin-header.mjs                       # 扫描 D:/aaaTemp 下全部 .t2w
 *   node scripts/verify-origin-header.mjs "<绝对路径>" ...       # 只验证指定包
 *
 * 附：同时 dump 每包的形态（容器形态、results/reader key、chunk 数、是否有 plotLocationMerge），
 *     供后续 M0-T1 路由与 M0-T3 golden 选样使用。
 *
 * 红线：只读样本包，绝不写回；实现复用 src/main/t2w/core.mjs（格式生命线）。
 */
import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { computeOffsets, decodeHeader, encodePackage } from '../src/main/t2w/core.mjs'

const SAMPLE_DIR = 'D:/aaaTemp'

/** 定位样本包：命令行给了就用给的，否则扫 SAMPLE_DIR 下全部 .t2w。 */
async function targets() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  if (args.length) return args
  const names = (await readdir(SAMPLE_DIR)).filter((n) => n.toLowerCase().endsWith('.t2w'))
  return names.sort().map((n) => join(SAMPLE_DIR, n))
}

/** 从整包 buffer 里按 files[] 顺序切出全部成员字节（显式拷贝，规避 subarray 视图）。 */
function extractBlobs(buf, manifest, blobStart) {
  const offsets = computeOffsets(manifest.files, blobStart)
  return manifest.files.map((f, i) => Buffer.from(buf.subarray(offsets[i], offsets[i] + f.size)))
}

/** 容器 → 形态（'array' | 'object' | 'absent'）。 */
function containerKind(node) {
  if (Array.isArray(node)) return 'array'
  if (node && typeof node === 'object') return 'object'
  return 'absent'
}

/** records.results / reader → [{key, value}]（数组或对象映射两种形态统一）。 */
function toKeyed(node) {
  if (Array.isArray(node)) return node.map((it, i) => ({ key: String(it?.key ?? i), value: it?.value }))
  if (node && typeof node === 'object') return Object.entries(node).map(([key, value]) => ({ key, value }))
  return []
}

/** 抽样式提取 key 形态（去掉 pkgId:revision 前缀，只留 `taskId...` 中段，便于观察 29 类）。 */
function keyShape(key) {
  const segs = key.split(':')
  // 前缀通常是 <pkgId>:<revision>；中段才是 taskId 链。取从第 3 段起的尾部形态。
  return segs.length > 2 ? segs.slice(2).join(':') : key
}

/** 汇总单包形态（供 M0-T1 路由 / M0-T3 选样）。 */
function shapeOf(manifest) {
  const records = manifest?.records ?? {}
  const results = toKeyed(records.results)
  const reader = toKeyed(records.reader)
  const containers = {}
  for (const name of ['chapters', 'chunks', 'tasks', 'results', 'attempts', 'reader']) {
    containers[name] = containerKind(records[name])
  }
  const shapes = [...new Set(results.map((r) => keyShape(r.key)))]
  const storyScriptShapes = shapes.filter((s) => s.includes('storyScript'))
  const ssChunkSeqs = new Set()
  for (const r of results) {
    const m = /:storyScript:(\d+)/.exec(r.key)
    if (m) ssChunkSeqs.add(Number(m[1]))
  }
  return {
    includesSource: manifest?.includesSource ?? null,
    project: {
      id: manifest?.project?.id ?? null,
      revisionId: manifest?.project?.revisionId ?? null,
      title: manifest?.project?.title ?? null,
      chapterCount: manifest?.project?.chapterCount ?? null,
      chunkCount: manifest?.project?.chunkCount ?? null,
      charCount: manifest?.project?.charCount ?? null
    },
    topLevelKeys: Object.keys(manifest ?? {}),
    recordsKeys: Object.keys(records),
    containers,
    filesCount: Array.isArray(manifest?.files) ? manifest.files.length : 0,
    resultsCount: results.length,
    readerCount: reader.length,
    resultKeyShapes: shapes,
    storyScriptKeyShapes: storyScriptShapes,
    storyScriptChunkSeqs: [...ssChunkSeqs].sort((a, b) => a - b),
    hasPlotLocationMerge: shapes.some((s) => s.includes('plotLocationMerge')),
    hasStoryScriptBatch: shapes.some((s) => s.includes('storyScript') && s.includes(':batch:'))
  }
}

async function main() {
  const list = await targets()
  console.log(`M0-T0 · origin-header 必要性验证（共 ${list.length} 个样本包）`)
  console.log(`实现来源：src/main/t2w/core.mjs（与应用共用，只读样本包）\n`)

  const rows = []
  for (const p of list) {
    const buf = await readFile(p)
    const { jsonLen, blobStart, manifest } = decodeHeader(buf)
    const blobs = extractBlobs(buf, manifest, blobStart)

    // encodePackage(parse(原始 JSON 字节)) —— 内部 JSON.stringify 重序列化
    const re = encodePackage(manifest, blobs)
    const reJsonLen = re.readUInt32BE(8)
    const origHeader = buf.subarray(0, blobStart) // 12 + jsonLen
    const reHeader = re.subarray(0, 12 + reJsonLen) // 12 + reJsonLen
    const headerEqual = origHeader.length === reHeader.length && origHeader.equals(reHeader)
    const fullEqual = buf.length === re.length && buf.equals(re)

    const shape = shapeOf(manifest)
    rows.push({ file: basename(p), path: p, jsonLen, reJsonLen, headerEqual, fullEqual, ...shape })

    console.log('='.repeat(80))
    console.log(`包: ${basename(p)}`)
    console.log(`  jsonLen(原始)=${jsonLen}  jsonLen(重编码)=${reJsonLen}  ${jsonLen === reJsonLen ? '（等长）' : '（长度已变）'}`)
    console.log(`  头部逐字节相等(12+jsonLen): ${headerEqual ? 'OK' : 'DIFF'}`)
    console.log(`  整包逐字节相等:            ${fullEqual ? 'OK' : 'DIFF'}`)
    console.log(`  形态: results=${shape.resultsCount} reader=${shape.readerCount} files=${shape.filesCount} ` +
      `chunkSeqs=${JSON.stringify(shape.storyScriptChunkSeqs)} plotLocationMerge=${shape.hasPlotLocationMerge} ` +
      `ssBatch=${shape.hasStoryScriptBatch}`)
  }

  const allHeader = rows.every((r) => r.headerEqual)
  const allFull = rows.every((r) => r.fullEqual)

  console.log('\n' + '='.repeat(80))
  console.log('汇总(JSON):')
  console.log(JSON.stringify({ packages: rows, allHeaderEqual: allHeader, allFullEqual: allFull }, null, 2))

  console.log('\n' + '='.repeat(80))
  console.log(`结论: 头部全部逐字节相等 = ${allHeader}；整包全部逐字节相等 = ${allFull}`)
  if (allHeader && allFull) {
    console.log('>>> 【相等】meta/origin-header.bin 可以不留（未编辑档导出改走 encodePackage 即可逐字节相等）')
  } else {
    console.log('>>> 【不相等】meta/origin-header.bin 必须留（未编辑档逐字节相等只能靠原始头部字节达成）')
  }
  process.exitCode = 0
}

main().catch((e) => {
  console.error('ERROR:', e?.stack ?? e?.message ?? e)
  process.exitCode = 2
})

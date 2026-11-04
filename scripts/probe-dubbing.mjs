/**
 * 探查 (1) 包里的配音/立绘元数据/角色分级结构，为 P1+P2 数据层定形。
 * 只读 manifest + 少量成员，不落盘任何东西。
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const { decodeHeader, computeOffsets } = await import(pathToFileURL(join(here, '../src/main/t2w/core.mjs')).href)

const target = process.argv[2]
if (!target) {
  console.error('usage: node scripts/probe-dubbing.mjs <t2w path>')
  process.exit(2)
}

const buf = await readFile(target)
const hdr = decodeHeader(buf)
const { blobStart, manifest } = hdr
const files = manifest.files ?? []
const offsets = computeOffsets(files, blobStart)

const readEntry = (p) => {
  const i = files.findIndex((f) => f.path === p)
  if (i < 0) throw new Error('missing ' + p)
  const o = offsets[i]
  return buf.subarray(o, o + files[i].size)
}
const parse = (p) => JSON.parse(readEntry(p).toString('utf8'))

const toEntries = (node) => {
  if (Array.isArray(node)) return node.map((v, i) => [String(v?.key ?? i), v])
  if (node && typeof node === 'object') return Object.entries(node)
  return []
}
const readerEntries = toEntries(manifest.records?.reader ?? {})
const resultEntries = toEntries(manifest.records?.results ?? {})

// ---- 1. dubbing 全量统计 ----
const dub = readerEntries.filter(([k]) => k.includes(':dubbing:'))
console.log('== dubbing reader entries ==', dub.length)
const byCh = {}
const byType = {}
const byChar = {}
const byKind = {}
const byStatus = {}
const clipLike = []
for (const [k, v] of dub) {
  const val = v?.value ?? v
  const ch = val?.chapterSeq ?? '?'
  byCh[ch] = (byCh[ch] ?? 0) + 1
  byType[val?.actionType ?? '?'] = (byType[val?.actionType ?? '?'] ?? 0) + 1
  byChar[val?.characterId ?? '?'] = (byChar[val?.characterId ?? '?'] ?? 0) + 1
  byKind[val?.kind ?? '?'] = (byKind[val?.kind ?? '?'] ?? 0) + 1
  byStatus[val?.status ?? '?'] = (byStatus[val?.status ?? '?'] ?? 0) + 1
  clipLike.push(val)
}
console.log('  by chapterSeq:', JSON.stringify(byCh))
console.log('  by actionType:', JSON.stringify(byType))
console.log('  by characterId:', JSON.stringify(byChar))
console.log('  by kind:', JSON.stringify(byKind))
console.log('  by status:', JSON.stringify(byStatus))
console.log('  entry[0] keys:', Object.keys(clipLike[0] ?? {}))
console.log('  entry[0]:', JSON.stringify(clipLike[0]).slice(0, 700))

// key 里是否带 :clip:
console.log('  keys with :clip:', dub.filter(([k]) => k.includes(':clip:')).length)
console.log('  key samples:', dub.slice(0, 3).map(([k]) => k))
console.log('  key tail samples:', dub.slice(-3).map(([k]) => k))

// ---- 2. responsePath 指向的产物 ----
const rp = clipLike.find((v) => v?.responsePath)?.responsePath
if (rp) {
  console.log('\n== responsePath artifact ==', rp)
  const art = parse(rp)
  console.log('  keys:', Object.keys(art))
  console.log('  (truncated):', JSON.stringify(art).slice(0, 1200))
}

// ---- 3. character-images 结构 ----
const ci = readerEntries.find(([k]) => k.includes(':character-images'))
if (ci) {
  const val = ci[1]?.value?.data ?? ci[1]?.value
  console.log('\n== character-images value keys ==', Object.keys(val ?? {}))
  console.log('  (truncated):', JSON.stringify(val).slice(0, 1500))
}

// ---- 4. canonical characters ----
const canonE = resultEntries.find(([k]) => k.includes(':canonical'))
if (canonE) {
  const canon = canonE[1]?.value?.data ?? canonE[1]?.value
  const chars = canon?.objects?.characters ?? []
  console.log('\n== canonical.objects.characters ==', chars.length)
  if (chars.length) {
    console.log('  char[0]:', JSON.stringify(chars[0]).slice(0, 800))
    console.log('  field union:', [...new Set(chars.flatMap((c) => Object.keys(c)))])
    const lv = {}
    for (const c of chars) lv[c.importanceLevel ?? '?'] = (lv[c.importanceLevel ?? '?'] ?? 0) + 1
    console.log('  by importanceLevel:', JSON.stringify(lv))
  }
}

// ---- 5. :characterAppearance ----
const ca = resultEntries.filter(([k]) => k.includes(':characterAppearance'))
console.log('\n== :characterAppearance entries ==', ca.length, ca.slice(0, 4).map(([k]) => k))
if (ca.length) {
  const val = ca[0][1]?.value?.data ?? ca[0][1]?.value
  console.log('  value keys:', Object.keys(val ?? {}))
  console.log('  (truncated):', JSON.stringify(val).slice(0, 1800))
}

// ---- 6. audio 成员与 dubbing 的对应关系 ----
const audioFiles = files.filter((f) => /\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(f.path))
console.log('\n== audio members ==', audioFiles.length)
const byDir = {}
for (const f of audioFiles) {
  const dir = f.path.replace(/\/[^/]*$/, '')
  byDir[dir] = (byDir[dir] ?? 0) + 1
}
console.log('  by dir:', JSON.stringify(byDir, null, 1))
// 看看 dubbing 的 usage 里有没有 duration 之类
console.log('\n== 音频时长线索 ==')
const withDur = clipLike.filter((v) => v?.durationMs != null || v?.duration != null)
console.log('  entries with durationMs/duration:', withDur.length)

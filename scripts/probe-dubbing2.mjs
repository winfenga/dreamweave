/**
 * 探查 (1) 包 :dubbing:clip:* / :dubbing:settings / :dubbing:voice:* 的具体结构
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const { decodeHeader, computeOffsets } = await import(pathToFileURL(join(here, '../src/main/t2w/core.mjs')).href)

const target = process.argv[2]
if (!target) process.exit(2)
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

const toEntries = (node) => {
  if (Array.isArray(node)) return node.map((v, i) => [String(v?.key ?? i), v])
  if (node && typeof node === 'object') return Object.entries(node)
  return []
}
const readerEntries = toEntries(manifest.records?.reader ?? {})

const clips = readerEntries.filter(([k]) => k.includes(':dubbing:clip:'))
console.log('== :dubbing:clip: ==', clips.length)
for (const [k, v] of clips.slice(0, 3)) {
  const val = v?.value ?? v
  console.log('KEY', k)
  console.log('  keys:', Object.keys(val ?? {}))
  console.log('  json:', JSON.stringify(val).slice(0, 1000))
}

// clip key 的编号规律
console.log('\nclip key samples:', clips.slice(0, 5).map(([k]) => k.split(':dubbing:clip:')[1]))
console.log('clip key tail:', clips.slice(-3).map(([k]) => k.split(':dubbing:clip:')[1]))

// clip 里是否带音频路径 / durationMs
const vals = clips.map(([, v]) => v?.value ?? v)
console.log('\nclip value field union:', [...new Set(vals.flatMap((v) => Object.keys(v ?? {})))])
const withAudio = vals.filter((v) => v?.audioPath || v?.audioFile || v?.path)
console.log('clips with audioPath/audioFile/path:', withAudio.length)
if (withAudio.length) console.log('  sample:', JSON.stringify(withAudio[0]).slice(0, 800))
const withDur = vals.filter((v) => v?.durationMs != null)
console.log('clips with durationMs:', withDur.length)
if (withDur.length) console.log('  sample:', JSON.stringify(withDur[0]).slice(0, 800))

// 与 attempt 的关联：attempt.responsePath → artifacts → payload.audioFile.path
const attempts = readerEntries.filter(([k]) => k.includes(':dubbing:attempt:'))
const avals = attempts.map(([, v]) => v?.value ?? v)
console.log('\n== attempts ==', avals.length)
console.log('attempt field union:', [...new Set(avals.flatMap((v) => Object.keys(v ?? {})))])

// 手工关联：clip(chapterSeq,order) ↔ attempt(chapterSeq,order)
const clipByKey = new Map()
for (const v of vals) {
  if (v?.chapterSeq != null && v?.order != null) clipByKey.set(`${v.chapterSeq}|${v.order}`, v)
}
const aByKey = new Map()
for (const v of avals) {
  if (v?.chapterSeq != null && v?.order != null) aByKey.set(`${v.chapterSeq}|${v.order}`, v)
}
console.log('clipByKey:', clipByKey.size, 'aByKey:', aByKey.size)
let linked = 0
for (const [k, v] of clipByKey) {
  const a = aByKey.get(k)
  if (a?.responsePath) linked++
}
console.log('clips linked to an attempt with responsePath:', linked)

// 展开一个完整的 clip→audio
const firstKey = [...clipByKey.keys()][0]
const firstClip = clipByKey.get(firstKey)
const firstAtt = aByKey.get(firstKey)
console.log('\nfirst clip:', JSON.stringify(firstClip))
console.log('first attempt:', JSON.stringify(firstAtt))
if (firstAtt?.responsePath) {
  const art = JSON.parse(readEntry(firstAtt.responsePath).toString('utf8'))
  console.log('artifact keys:', Object.keys(art))
  console.log('payload keys:', Object.keys(art.payload ?? {}))
  console.log('audioFile:', JSON.stringify(art.payload?.audioFile))
}

// settings / voice
for (const [k, v] of readerEntries) {
  if (k.includes(':dubbing:settings') || k.includes(':dubbing:voice')) {
    const val = v?.value ?? v
    console.log('\n== ' + k.split(':dubbing:')[1] + ' ==')
    console.log(JSON.stringify(val).slice(0, 1200))
  }
}

// audio 成员总数 vs attempt 数
const audioFiles = files.filter((f) => /\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(f.path))
console.log('\naudio members:', audioFiles.length, ' attempts with responsePath:', avals.filter((v) => v?.responsePath).length)

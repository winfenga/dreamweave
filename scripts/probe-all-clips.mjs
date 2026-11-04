// 批量校验包内全部音频片段：MP3 帧完整性 + Xing 头一致性
// 目的：确认「长 clip 播到 ~11.9s stall」是数据问题还是管线问题
//
// 用法：node scripts/probe-all-clips.mjs [包路径] [目标字节数]
// 结论见 docs/audio-stall-investigation.md §3。
import fs from 'node:fs'

const P = process.argv[2] ?? 'testdata/monte-cristo-10ch.t2w'

const fd = fs.openSync(P, 'r')
const head = Buffer.alloc(12)
fs.readSync(fd, head, 0, 12, 0)
const jsonLen = head.readUInt32BE(8)
const man = Buffer.alloc(jsonLen)
fs.readSync(fd, man, 0, jsonLen, 12)
const m = JSON.parse(man.toString('utf8'))
const blobStart = 12 + jsonLen
const offs = []
let o = blobStart
for (const f of m.files) {
  offs.push(o)
  o += f.size
}

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }

function frameInfo(b, pos) {
  if (pos + 4 > b.length) return null
  if (b[pos] !== 0xff || (b[pos + 1] & 0xe0) !== 0xe0) return null
  const verBits = (b[pos + 1] >> 3) & 0x3
  const layer = (b[pos + 1] >> 1) & 0x3
  const brIdx = (b[pos + 2] >> 4) & 0xf
  const srIdx = (b[pos + 2] >> 2) & 0x3
  const pad = (b[pos + 2] >> 1) & 0x1
  const table = verBits === 3 ? BITRATES_V1_L3 : BITRATES_V2_L3
  const bitrate = table[brIdx] * 1000
  const sampleRate = (SAMPLE_RATES[verBits] ?? SAMPLE_RATES[3])[srIdx]
  if (!bitrate || !sampleRate || layer !== 1) return null
  const spf = verBits === 3 ? 1152 : 576
  const frameLen = Math.floor(((verBits === 3 ? 144 : 72) * bitrate) / sampleRate) + pad
  if (frameLen <= 4) return null
  return { bitrate, sampleRate, spf, frameLen, verBits }
}

function analyse(buf) {
  let i = 0
  let id3 = 0
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'ID3') {
    id3 = 10 + (((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f))
    i = id3
  }
  let pos = i
  let frames = 0
  let t = 0
  let firstFrame = null
  let badAt = -1
  while (pos + 4 <= buf.length) {
    const fi = frameInfo(buf, pos)
    if (!fi || pos + fi.frameLen > buf.length) {
      badAt = pos
      break
    }
    if (!firstFrame) firstFrame = fi
    frames++
    t += fi.spf / fi.sampleRate
    pos += fi.frameLen
  }
  // Xing
  const tagIdx = Math.max(buf.subarray(0, 4096).indexOf(Buffer.from('Xing', 'ascii')), buf.subarray(0, 4096).indexOf(Buffer.from('Info', 'ascii')))
  let declaredFrames = null
  let declaredBytes = null
  if (tagIdx >= 0) {
    const flags = buf.readUInt32BE(tagIdx + 4)
    let p = tagIdx + 8
    if (flags & 1) {
      declaredFrames = buf.readUInt32BE(p)
      p += 4
    }
    if (flags & 2) {
      declaredBytes = buf.readUInt32BE(p)
      p += 4
    }
  }
  return {
    size: buf.length,
    id3,
    frames,
    duration: t,
    firstFrame,
    consumed: pos,
    badAt,
    trailing: buf.length - pos,
    declaredFrames,
    declaredBytes,
    hasXing: tagIdx >= 0
  }
}

const clips = []
for (const r of m.records.reader ?? []) {
  if (!r.key.includes('clip:')) continue
  const v = r.value
  if (!v || typeof v.path !== 'string' || !v.path) continue
  const idx = m.files.findIndex((f) => f.path === v.path)
  if (idx < 0) continue
  clips.push({ key: r.key.split(':').slice(-2).join(':'), path: v.path, idx, size: m.files[idx].size })
}

console.log('片段总数', clips.length)
const rows = []
for (const c of clips) {
  const buf = Buffer.alloc(c.size)
  fs.readSync(fd, buf, 0, c.size, offs[c.idx])
  const a = analyse(buf)
  rows.push({ ...c, ...a })
}
fs.closeSync(fd)

const bad = rows.filter((r) => r.badAt >= 0 || r.trailing > 1 || r.frames === 0)
console.log('\n有问题的片段数', bad.length)
for (const b of bad) {
  console.log('  ', b.key, 'size', b.size, 'frames', b.frames, 'badAt', b.badAt, 'trailing', b.trailing, 'dur', b.duration.toFixed(2))
}

const framesMismatch = rows.filter((r) => r.declaredFrames !== null && Math.abs(r.declaredFrames - r.frames) > 1)
console.log('\nXing 帧数不符的片段数', framesMismatch.length)
for (const b of framesMismatch.slice(0, 10)) {
  console.log('  ', b.key, 'size', b.size, 'declared', b.declaredFrames, 'actual', b.frames, 'dur', b.duration.toFixed(2))
}
const bytesMismatch = rows.filter((r) => r.declaredBytes !== null && r.declaredBytes !== r.size)
console.log('Xing 字节数不符的片段数', bytesMismatch.length)
for (const b of bytesMismatch.slice(0, 10)) {
  console.log('  ', b.key, 'size', b.size, 'declared', b.declaredBytes)
}

console.log('\n=== 时长最长的 10 个')
for (const r of [...rows].sort((a, b) => b.duration - a.duration).slice(0, 10)) {
  console.log(
    `  ${r.key}  size=${r.size}  frames=${r.frames}  dur=${r.duration.toFixed(3)}s  声明帧=${r.declaredFrames}  xing=${r.hasXing}`
  )
}

// 找 HANDOVER 提到的 195864 字节那个（HANDOVER.md §2.1 用过的样本）
const target = rows.find((r) => r.size === 195864)
console.log('\n=== HANDOVER 提到的 195864 字节片段')
if (target) {
  console.log(JSON.stringify({ ...target, firstFrame: target.firstFrame }, null, 1))
  const buf = Buffer.alloc(target.size)
  const fd2 = fs.openSync(P, 'r')
  fs.readSync(fd2, buf, 0, target.size, offs[target.idx])
  fs.closeSync(fd2)
  fs.writeFileSync('probe-clip-195864.mp3', buf)
  console.log('已写出 probe-clip-195864.mp3')
} else {
  console.log('没有该尺寸片段')
}

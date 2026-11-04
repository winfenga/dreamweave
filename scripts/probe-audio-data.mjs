// 数据面验证：确认 t2w:// 长音频 stall 到底是「数据错」还是「管线错」
// 1) 从包里取一个长配音 mp3，按 manifest sha256 校验
// 2) 用纯 JS 解析 MP3 帧结构，看原始数据本身是否完整/可解
// 3) 模拟 subarray 视图路径，看字节是否错位
//
// 用法：node scripts/probe-audio-data.mjs [包路径]
// 结论见 docs/audio-stall-investigation.md §2。
import fs from 'node:fs'
import crypto from 'node:crypto'

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
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

// 找配音片段：reader 里 :dubbing:clip:
const clips = []
for (const r of m.records.reader ?? []) {
  if (!r.key.includes(':dubbing:clip:')) continue
  const v = r.value
  if (!v || typeof v.path !== 'string') continue
  const idx = m.files.findIndex((f) => f.path === v.path)
  if (idx < 0) continue
  clips.push({ path: v.path, size: m.files[idx].size, idx, key: r.key.split(':').slice(-2).join(':') })
}
clips.sort((a, b) => a.size - b.size)
console.log('配音片段数', clips.length)
console.log('尺寸分布（前5小/后5大）:')
for (const c of clips.slice(0, 5)) console.log('  ', c.size, c.key)
for (const c of clips.slice(-5)) console.log('  ', c.size, c.key)

const pick = clips[clips.length - 1]
console.log('\n=== 目标片段', pick.key, 'size', pick.size)

// 完整包读入（模拟 readPackage 的 cache）
const whole = fs.readFileSync(P)

// 路径 A：完整 buffer 上的 subarray（应用实际走的路径）
const viewA = whole.subarray(offs[pick.idx], offs[pick.idx] + pick.size)
// 路径 B：拷贝成独立连续 buffer
const copyB = Buffer.from(viewA)

console.log('viewA byteOffset', viewA.byteOffset, 'byteLength', viewA.byteLength)
console.log('viewA sha256', sha(viewA))
console.log('copyB sha256', sha(copyB))
console.log('manifest sha256', m.files[pick.idx].sha256)
console.log('视图与拷贝一致:', sha(viewA) === sha(copyB))
console.log('与清单一致:', sha(viewA) === m.files[pick.idx].sha256)

// 直接按偏移读，不经过整包 buffer（排除整包读取的问题）
const direct = Buffer.alloc(pick.size)
fs.readSync(fd, direct, 0, pick.size, offs[pick.idx])
console.log('直读 sha256', sha(direct), '一致:', sha(direct) === sha(viewA))

fs.closeSync(fd)
const outMp3 = 'probe-clip.mp3'
fs.writeFileSync(outMp3, copyB)

// ---- MP3 帧解析 ----
const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }

const buf = copyB
let i = 0
// 跳过 ID3v2
if (buf.toString('ascii', 0, 3) === 'ID3') {
  const size =
    ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f)
  console.log('\nID3v2 存在，长度', size + 10)
  i = 10 + size
}

const frames = []
let badAt = -1
let pos = i
while (pos + 4 <= buf.length) {
  const b1 = buf[pos]
  const b2 = buf[pos + 1]
  if (b1 !== 0xff || (b2 & 0xe0) !== 0xe0) {
    badAt = pos
    break
  }
  const verBits = (b2 >> 3) & 0x3
  const layer = (b2 >> 1) & 0x3
  const brIdx = (buf[pos + 2] >> 4) & 0xf
  const srIdx = (buf[pos + 2] >> 2) & 0x3
  const pad = (buf[pos + 2] >> 1) & 0x1
  const brTable = verBits === 3 ? BITRATES_V1_L3 : BITRATES_V2_L3
  const bitrate = brTable[brIdx] * 1000
  const srTable = SAMPLE_RATES[verBits] ?? SAMPLE_RATES[3]
  const sampleRate = srTable[srIdx]
  if (!bitrate || !sampleRate || layer !== 1) {
    badAt = pos
    break
  }
  const frameLen = Math.floor(((verBits === 3 ? 144 : 72) * bitrate) / sampleRate) + pad
  if (frameLen <= 0 || pos + frameLen > buf.length) {
    badAt = pos
    break
  }
  frames.push({ pos, frameLen, bitrate, sampleRate, verBits })
  pos += frameLen
}

const totalSamples =
  frames.length * (frames[0]?.verBits === 3 ? 1152 : 576)
const dur = frames[0] ? totalSamples / frames[0].sampleRate : 0

console.log('\n=== MP3 帧解析')
console.log('解析到帧数', frames.length)
console.log('首个帧 offset', frames[0]?.pos, '版本位', frames[0]?.verBits, '采样率', frames[0]?.sampleRate, '码率', frames[0]?.bitrate)
const brs = [...new Set(frames.map((f) => f.bitrate))]
const srs = [...new Set(frames.map((f) => f.sampleRate))]
console.log('码率集合', brs, '采样率集合', srs)
console.log('解析长度', pos, '/ 文件长度', buf.length)
console.log('坏帧位置', badAt, badAt >= 0 ? `剩余 ${buf.length - badAt} 字节` : '')
console.log('推算时长', dur.toFixed(3), 's')

// 帧时长分布：找出前面多少秒是正常的
if (frames[0]) {
  let t = 0
  const marks = []
  for (const f of frames) {
    t += (f.verBits === 3 ? 1152 : 576) / f.sampleRate
    if (t >= 11 && marks.length === 0) marks.push({ t: +t.toFixed(2), idx: frames.indexOf(f), pos: f.pos })
    if (t >= 12 && marks.length === 1) marks.push({ t: +t.toFixed(2), idx: frames.indexOf(f), pos: f.pos })
  }
  console.log('11s/12s 处帧索引/偏移', JSON.stringify(marks))
}

// 检查是否有多帧重复（数据被截断后填充）
if (badAt >= 0) {
  console.log('坏帧处字节预览:', buf.subarray(badAt, badAt + 16).toString('hex'))
}
console.log('\n已写出 ' + outMp3 + '（可用 node scripts/probe-mp3-header.mjs ' + outMp3 + ' 继续分析容器头）')

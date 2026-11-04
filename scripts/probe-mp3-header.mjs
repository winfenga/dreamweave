// 深挖 MP3 容器头：Xing/Info/LAME 标签与帧数的关系
// 若 VBR 头声明的帧数/字节数与实际不符，Chromium 会算出错误时长并在中途 stall。
//
// 用法：node scripts/probe-mp3-header.mjs <clip.mp3 路径>
//   先用 probe-audio-data.mjs 从包里导出 mp3，再喂给本脚本。
// 背景与结论见 docs/audio-stall-investigation.md §4。
import fs from 'node:fs'

const clipPath = process.argv[2] ?? 'probe-clip.mp3'
const buf = fs.readFileSync(clipPath)
console.log('[输入]', clipPath, buf.length, 'bytes')

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }

function frameInfo(b, pos) {
  const b1 = b[pos]
  const b2 = b[pos + 1]
  if (b1 !== 0xff || (b2 & 0xe0) !== 0xe0) return null
  const verBits = (b2 >> 3) & 0x3
  const layer = (b2 >> 1) & 0x3
  const brIdx = (b[pos + 2] >> 4) & 0xf
  const srIdx = (b[pos + 2] >> 2) & 0x3
  const pad = (b[pos + 2] >> 1) & 0x1
  const table = verBits === 3 ? BITRATES_V1_L3 : BITRATES_V2_L3
  const bitrate = table[brIdx] * 1000
  const sampleRate = (SAMPLE_RATES[verBits] ?? SAMPLE_RATES[3])[srIdx]
  if (!bitrate || !sampleRate || layer !== 1) return null
  const spf = verBits === 3 ? 1152 : 576
  const frameLen = Math.floor(((verBits === 3 ? 144 : 72) * bitrate) / sampleRate) + pad
  return { pos, verBits, layer, bitrate, sampleRate, pad, frameLen, spf, brIdx, srIdx }
}

const first = frameInfo(buf, 0)
console.log('首帧', JSON.stringify(first))

// 首帧内找 Xing / Info / LAME
const headArea = buf.subarray(0, Math.min(2000, buf.length))
for (const tag of ['Xing', 'Info', 'LAME', 'Lavc', 'Lavf']) {
  const i = headArea.indexOf(Buffer.from(tag, 'ascii'))
  if (i >= 0) {
    console.log(`\n找到 "${tag}" @ ${i}`)
    console.log('  周围字节', buf.subarray(Math.max(0, i - 8), i + 48).toString('hex'))
    console.log('  周围文本', JSON.stringify(buf.subarray(Math.max(0, i - 8), i + 48).toString('latin1')))
  }
}

// Xing 结构：'Xing'/'Info' + flags(4B) [+frames(4B)] [+bytes(4B)] [+toc(100B)] [+quality(4B)]
const xIdx = buf.subarray(0, 2000).indexOf(Buffer.from('Xing', 'ascii'))
const iIdx = buf.subarray(0, 2000).indexOf(Buffer.from('Info', 'ascii'))
const tagIdx = xIdx >= 0 ? xIdx : iIdx
if (tagIdx >= 0) {
  const flags = buf.readUInt32BE(tagIdx + 4)
  let p = tagIdx + 8
  let declaredFrames = null
  let declaredBytes = null
  if (flags & 1) {
    declaredFrames = buf.readUInt32BE(p)
    p += 4
  }
  if (flags & 2) {
    declaredBytes = buf.readUInt32BE(p)
    p += 4
  }
  let toc = null
  if (flags & 4) {
    toc = buf.subarray(p, p + 100)
    p += 100
  }
  console.log('\n=== Xing/Info 头')
  console.log('flags', flags.toString(2).padStart(8, '0'), '声明帧数', declaredFrames, '声明字节数', declaredBytes)
  console.log('文件实际字节数', buf.length)
  if (declaredBytes !== null) console.log('字节数一致:', declaredBytes === buf.length)

  // 实际帧数
  let pos = first ? first.frameLen : 0
  let real = 1
  let ticks = []
  let t = 0
  let stoppedAt = -1
  while (pos + 4 <= buf.length) {
    const fi = frameInfo(buf, pos)
    if (!fi || pos + fi.frameLen > buf.length) {
      stoppedAt = pos
      break
    }
    real++
    t += fi.spf / fi.sampleRate
    ticks.push({ pos, t })
    pos += fi.frameLen
  }
  console.log('实际可解帧数', real, '解析长度', pos, '停在哪', stoppedAt)
  console.log('实际时长', t.toFixed(3), 's')
  if (declaredFrames !== null) {
    console.log('声明帧数 vs 实际帧数 差', declaredFrames - real)
    const spf = first.spf
    console.log('按声明帧数推算时长', ((declaredFrames * spf) / first.sampleRate).toFixed(3), 's')
  }

  // TOC 表：把时间映射到字节偏移，Chromium 用它 seek
  if (toc) {
    console.log('\n=== TOC（100 项，每项 1/256 的时间点对应字节比例）')
    const vals = [...toc]
    console.log(' 前 10', vals.slice(0, 10), '后 10', vals.slice(-10))
    const nonZero = vals.filter((v) => v > 0).length
    console.log(' 非零项数', nonZero, '/ 100')
    // 单调性检查
    let mono = true
    for (let k = 1; k < 100; k++) if (vals[k] < vals[k - 1]) mono = false
    console.log(' 单调递增:', mono)
    // 反推每个 TOC 百分点对应的实际字节偏移
    const mapped = vals.map((v) => Math.round((v / 256) * buf.length))
    console.log(' 映射字节偏移 前5', mapped.slice(0, 5), '末5', mapped.slice(-5))
    // 用解析出的真实帧表校验这些偏移是否落在帧边界上
    const framePos = new Set(ticks.map((x) => x.pos))
    framePos.add(0)
    const onBoundary = mapped.filter((m) => framePos.has(m)).length
    console.log(` TOC 映射落在真实帧边界: ${onBoundary}/100`)
  }
} else {
  console.log('\n未找到 Xing/Info 头（CBR 或裸流）')
}

// 检查 ID3v1 尾部
const tail = buf.subarray(Math.max(0, buf.length - 128))
console.log('\n末尾 3 字节', buf.subarray(buf.length - 3).toString('hex'), '尾部是否 TAG:', tail.toString('ascii', 0, 3) === 'TAG')

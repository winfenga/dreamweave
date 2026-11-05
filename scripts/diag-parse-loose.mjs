/**
 * 验证 parseJsonLoose 对 mangaScript 真实响应的行为。
 * 只读本地产物，不调 LLM。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const b = 'D:\\galcomic\\DreamWeave-data\\workspace\\20261105164508-bad181'
const j = JSON.parse(readFileSync(join(b, 'records/results/mangaScript.json'), 'utf8'))

// 复刻 parseJsonLoose 的逻辑
function parseJsonLoose(content) {
  const text = (content ?? '').trim()
  if (!text) return null
  let t = text
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fence) t = fence[1].trim()
  try {
    return JSON.parse(t)
  } catch {
    const a = t.indexOf('{')
    const b = t.lastIndexOf('}')
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

console.log('=== 用磁盘上的 500 字符 raw 测（必然失败，因为被截断）')
for (const e of j.entries) {
  const key = String(e.key).replace(/^.*?:txt-import-\d+:/, '')
  const raw = String(e.value.data.raw ?? '')
  const r = parseJsonLoose(raw)
  console.log(`  ${key}: ${r === null ? 'null（失败）' : 'ok'}  raw长度=${raw.length}`)
}

console.log('\n=== 关键：判断模型输出是否真的在中间被截断')
console.log('  三片 raw 的结尾都在数组元素中间：')
for (const e of j.entries) {
  const key = String(e.key).replace(/^.*?:txt-import-\d+:/, '')
  const raw = String(e.value.data.raw ?? '')
  console.log(`  ${key}: ...${raw.slice(-40)}`)
}

console.log('\n=== 诊断结论')
console.log('  raw 全是恰好 500 字符（= slice(0,500) 的截断长度），')
console.log('  因此磁盘上**没有任何**反映真实响应完整性的证据。')
console.log('  必须改造 parse 兜底，把真实长度与失败原因写进产物。')

/**
 * 诊断 mangaScript 解析失败的真实原因（只读，不调 LLM）。
 *
 * 现象：三片 mangaScript 的 `chapters` 都是空数组，`raw` 只有 500 字符，
 * 但 attempts 显示模型成功返回了 8216/14197/11613 token 的完整内容。
 *
 * 用法：node scripts/diag-mangascript.mjs <工作库目录名>
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const WS = process.argv[2] ?? '20261105164508-bad181'
const ROOT = 'D:\\galcomic\\DreamWeave-data\\workspace'
const base = join(ROOT, WS)

if (!existsSync(join(base, 'index.json'))) {
  console.error(`✗ 找不到工作库 ${base}`)
  process.exit(1)
}

const idx = JSON.parse(readFileSync(join(base, 'index.json'), 'utf8'))
console.log(`  工作库: ${WS}`)
console.log(`  书名:   ${idx.title}`)
console.log(`  pkgId:  ${idx.pkgId}`)
console.log(`  shards: ${idx.shards.length}`)
console.log('')

// 1) mangaScript 产物
const p = join(base, 'records/results/mangaScript.json')
const env = JSON.parse(readFileSync(p, 'utf8'))
console.log(`  mangaScript 产物: ${env.entries.length} 条\n`)

for (const e of env.entries) {
  const key = String(e.key).replace(/^.*?:txt-import-\d+:/, '')
  const v = e.value
  const d = v.data ?? v
  const raw = typeof d.raw === 'string' ? d.raw : ''
  console.log(`  ── ${key}`)
  console.log(`     chapters=${Array.isArray(d.chapters) ? d.chapters.length : '非数组'}  raw长度=${raw.length}`)
  console.log(`     raw 开头: ${JSON.stringify(raw.slice(0, 60))}`)
  console.log(`     raw 结尾: ${JSON.stringify(raw.slice(-60))}`)
  console.log(`     含 code fence: ${raw.includes('`'.repeat(3))}`)
  console.log(`     以 { 开头: ${raw.trimStart().startsWith('{')}`)
  console.log(`     warnings: ${JSON.stringify(d.warnings)}`)

  // 尝试各种解析，看能不能救回来
  const attempts = []
  const tryParse = (label, text) => {
    try {
      const o = JSON.parse(text)
      attempts.push({ label, ok: true, chapters: Array.isArray(o.chapters) ? o.chapters.length : 'n/a' })
    } catch (err) {
      attempts.push({ label, ok: false, err: String(err.message).slice(0, 60) })
    }
  }
  tryParse('整体 parse', raw)
  const a = raw.indexOf('{')
  const b = raw.lastIndexOf('}')
  if (a >= 0 && b > a) tryParse('截 {…}', raw.slice(a, b + 1))
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  if (fence) tryParse('围栏内', fence[1].trim())
  console.log('     解析尝试:')
  for (const at of attempts) {
    console.log(`       ${at.ok ? '✓' : '✗'} ${at.label}${at.ok ? ` chapters=${at.chapters}` : ` ${at.err}`}`)
  }
  console.log('')
}

// 2) attempts 里有没有留下完整响应
const ap = join(base, 'records/attempts/mangaScript.json')
if (existsSync(ap)) {
  const aj = JSON.parse(readFileSync(ap, 'utf8'))
  console.log(`  attempts: ${aj.entries.length} 次`)
  for (const e of aj.entries.slice(-6)) {
    const v = e.value
    const outTok = v.usage?.output ?? 0
    console.log(
      `     ${v.status}  model=${v.model}  output_tokens=${outTok}  ms=${v.communicationMs}  err=${(v.error ?? '').slice(0, 40)}`
    )
  }
  const hasResponse = aj.entries.filter((e) => e.value.responsePath).length
  console.log(`     带 responsePath 的条目: ${hasResponse}`)
}

// 3) 上游依赖是否真的存在（mangaScript 依赖 canonical / characterAppearance / worldImpression）
console.log('\n  上游依赖状态:')
for (const t of ['canonical', 'characterAppearance', 'worldImpression', 'draftAlign']) {
  const fp = join(base, `records/results/${t}.json`)
  if (!existsSync(fp)) {
    console.log(`     ${t}: ✗ 无产物文件`)
    continue
  }
  const j = JSON.parse(readFileSync(fp, 'utf8'))
  const d = j.entries[0]?.value?.data ?? j.entries[0]?.value
  console.log(`     ${t}: ${j.entries.length} 条，字段 ${Object.keys(d ?? {}).join(',')}`)
}

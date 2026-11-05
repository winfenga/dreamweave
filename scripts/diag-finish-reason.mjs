/**
 * 单次诊断：调用网关时观察 finish_reason 与输出长度。
 *
 * 目的：确认 mangaScript 的 parse 失败到底是「模型输出被截断」还是「解析策略问题」。
 * 只发**一次**短请求（max_tokens 很小），成本极低。
 *
 * 用法：node scripts/diag-finish-reason.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const CANDIDATES = [
  'D:\\galcomic\\dreamweave\\DreamWeave-data\\settings.json',
  'D:\\galcomic\\dreamweave\\dist\\win-unpacked\\resources\\DreamWeave-data\\settings.json'
]

let provider = null
for (const p of CANDIDATES) {
  if (!existsSync(p)) continue
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    const list = (j.llm ?? []).filter((x) => x.enabled && x.baseURL && x.apiKey)
    if (!list.length) continue
    const active = list.find((x) => x.id === j.activeLlmId) ?? list[0]
    provider = active
    break
  } catch {
    /* ignore */
  }
}
if (!provider) {
  console.error('✗ 找不到可用配置')
  process.exit(1)
}
console.log(`  端点: ${provider.baseURL}`)
console.log(`  模型: ${provider.model}\n`)

// 让它输出一个**接近真实 mangaScript 规模**的长 JSON（真实事故里输出 8000-14000 token）
const prompt = `请输出一个 JSON 对象，形如 {"chapters":[{"chapterSeq":1,"pages":[{"context":"…","characters":[],"panels":[{"no":1,"lines":[[1,5]],"scene":"…","content":"…","speech":[{"type":"narration","text":"…"}]}]}]}]}。
要求 chapters 里放 3 章（chapterSeq 分别为 1、5、10），每章 8 页，每页 4 格，
每格 content 写 120 个汉字，speech 里写 2 条、每条 60 个汉字。只输出 JSON，不要其他文字。`

const body = {
  model: provider.model,
  messages: [
    { role: 'system', content: '你是 JSON 生成器，只输出合法 JSON。' },
    { role: 'user', content: prompt }
  ],
  stream: false,
  max_tokens: 120000
}

const started = Date.now()
const res = await fetch(`${provider.baseURL.replace(/\/+$/, '')}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` },
  body: JSON.stringify(body)
})
const ms = Date.now() - started
const text = await res.text()

console.log(`  HTTP ${res.status}  ${ms}ms  content-type=${res.headers.get('content-type')}`)

// 聚合 SSE 或解析 JSON
let parsed = null
const isSse = /^data:\s/m.test(text.slice(0, 200)) || (res.headers.get('content-type') ?? '').includes('event-stream')
if (isSse) {
  let content = ''
  let finishReason = null
  let usage = null
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    const payload = t.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const c = JSON.parse(payload)
      const ch = c.choices?.[0]
      if (ch?.delta?.content) content += ch.delta.content
      if (ch?.finish_reason) finishReason = ch.finish_reason
      if (c.usage) usage = c.usage
    } catch {
      /* skip */
    }
  }
  parsed = { content, finishReason, usage }
  console.log(`  SSE 聚合：内容 ${content.length} 字符`)
} else {
  try {
    const j = JSON.parse(text)
    const ch = j.choices?.[0]
    parsed = {
      content: ch?.message?.content ?? '',
      finishReason: ch?.finish_reason ?? null,
      usage: j.usage ?? null
    }
    console.log(`  非 SSE：内容 ${parsed.content.length} 字符`)
  } catch {
    console.log(`  ✗ 无法解析响应: ${text.slice(0, 300)}`)
    process.exit(1)
  }
}

console.log(`  finish_reason: ${parsed.finishReason}`)
console.log(`  usage: output=${parsed.usage?.completion_tokens ?? '?'} input=${parsed.usage?.prompt_tokens ?? '?'}`)
console.log(`  内容结尾: ${JSON.stringify(parsed.content.slice(-100))}`)

// JSON 是否完整
let jsonOk = false
let chapters = 0
try {
  const o = JSON.parse(parsed.content)
  jsonOk = true
  chapters = Array.isArray(o.chapters) ? o.chapters.length : 0
} catch (e) {
  console.log(`  ✗ JSON 解析失败: ${String(e.message).slice(0, 120)}`)
}
console.log(`  JSON 完整: ${jsonOk}${jsonOk ? `，chapters=${chapters}` : ''}`)

console.log('')
if (parsed.finishReason === 'length') {
  console.log('  ➜ 结论：**输出被 max_tokens 截断**（finish_reason=length）。')
  console.log('     mangaScript 的 maxTokens=120000 但模型实际上限远低于此，')
  console.log('     长输出会在半途截断 → JSON 不闭合 → parse 失败 → chapters=[]。')
} else if (!jsonOk) {
  console.log('  ➜ 结论：finish_reason 正常但 JSON 不完整，可能是模型输出质量问题。')
} else {
  console.log('  ➜ 结论：本次输出完整且可解析（说明截断取决于任务体量/模型状态）。')
}

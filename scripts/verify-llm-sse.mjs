/**
 * LLM 客户端 SSE 兼容性验证（node 直跑，不启动 Electron）。
 *
 * 背景（实测）：本地 workbuddy 网关**无视 `stream:false`**，一律返回
 * `Content-Type: text/event-stream` + `data: {...}` 分帧。
 * 若按普通 JSON 解析会得到 null，导致两个都很致命的连锁症状：
 *   1) 探活 → 「端点可达但响应不可解析（非 JSON）」，看起来像配置错了；
 *   2) 正式任务 → 「响应缺少 choices[0].message.content」，整条流水线在该端点不可用。
 *
 * 本脚本验证 `parseSseCompletion` 能把 SSE 聚合成与非流式等价的结构，
 * 且对正常 JSON / 垃圾输入不误判；顺带守住审查拦截阈值与请求体形态不回归。
 *
 * 姿势与 `verify-t4-task-state.mjs` 一致：esbuild 打单文件 ESM + electron 最小桩。
 *
 * 用法：node scripts/verify-llm-sse.mjs
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(here, '..')
const BUILD_DIR = join(FEATHER, 'out', '.verify-llm-sse')

const require = createRequire(join(FEATHER, 'package.json'))
const { build } = require('esbuild')

/** electron 最小桩：被测链路只用 app.getPath，不碰窗口。 */
function electronStub() {
  return {
    name: 'electron-stub',
    setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }))
      b.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
        contents:
          `export const app = { getAppPath: () => ${JSON.stringify(FEATHER)}, getPath: () => ${JSON.stringify(join(FEATHER, 'out', '.tmp'))} };\n` +
          `export const ipcMain = { handle(){}, on(){} };\n` +
          `export const BrowserWindow = { getAllWindows: () => [], fromWebContents: () => null };\n` +
          `export default { app, ipcMain, BrowserWindow };\n`,
        loader: 'js'
      }))
    }
  }
}

await rm(BUILD_DIR, { recursive: true, force: true })
await mkdir(BUILD_DIR, { recursive: true })

const result = await build({
  entryPoints: [join(FEATHER, 'src/main/pipeline/llm-client.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  external: ['node:*'],
  logLevel: 'silent',
  plugins: [electronStub()]
})
const outPath = join(BUILD_DIR, 'llm-client.mjs')
await writeFile(outPath, result.outputFiles[0].text, 'utf8')
const mod = await import(pathToFileURL(outPath).href)

const {
  parseSseCompletion,
  readChatCompletion,
  isLikelyContentBlocked,
  CONTENT_BLOCKED_MIN_CHARS,
  buildRequestBody,
  endpointOf,
  usesMaxCompletionTokens
} = mod

const checks = []
function check(name, cond, detail = '') {
  checks.push({ name, ok: !!cond, detail })
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : detail ? `  — ${detail}` : ''}`)
}

// ---------------------------------------------------------------------------
// ① 真实 SSE 帧（抓包原样：空 delta、reasoning_content、usage、[DONE]）
// ---------------------------------------------------------------------------
const SSE = [
  'data: {"id":"abc","model":"deepseek-v4.1-flash","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning_content":""},"finish_reason":""}]}',
  '',
  'data: {"id":"abc","model":"deepseek-v4.1-flash","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"{\\"a\\":"},"finish_reason":""}]}',
  '',
  'data: {"id":"abc","model":"deepseek-v4.1-flash","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"1}"},"finish_reason":""}]}',
  '',
  'data: {"id":"abc","model":"deepseek-v4.1-flash","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":4}}',
  '',
  'data: [DONE]',
  ''
].join('\n')

const one = parseSseCompletion(SSE, 'text/event-stream')
check('SSE 被识别并聚合', one !== null, String(one))
check('SSE 内容正确拼接', one?.choices?.[0]?.message?.content === '{"a":1}', JSON.stringify(one?.choices?.[0]?.message?.content))
check('SSE 保留 finish_reason', one?.choices?.[0]?.finish_reason === 'stop', String(one?.choices?.[0]?.finish_reason))
check('SSE 保留 usage', one?.usage?.completion_tokens === 4, JSON.stringify(one?.usage))
check('SSE 保留 id/model', one?.id === 'abc' && one?.model === 'deepseek-v4.1-flash', `${one?.id}/${one?.model}`)
check('SSE 结构与非流式同形（choices[0].message.content）', typeof one?.choices?.[0]?.message?.content === 'string', '')

// ---------------------------------------------------------------------------
// ② 内容形状识别（Content-Type 谎报为 json 也要认）
// ---------------------------------------------------------------------------
check('Content-Type 谎报时仍按内容识别 SSE', parseSseCompletion(SSE, 'application/json') !== null, '')

// ---------------------------------------------------------------------------
// ③ 正常 JSON / 垃圾输入不误判
// ---------------------------------------------------------------------------
const plain = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })
check('普通 JSON 不被当作 SSE', parseSseCompletion(plain, 'application/json') === null, 'json 被误判')
check('空串返回 null', parseSseCompletion('', 'text/event-stream') === null, 'empty')
check('非 SSE 纯文本返回 null', parseSseCompletion('Internal Server Error', 'text/plain') === null, 'plain')

// ---------------------------------------------------------------------------
// ④ 坏帧容错：中间一帧坏了，其余仍聚合
// ---------------------------------------------------------------------------
const withBad = [
  'data: {"choices":[{"delta":{"content":"A"}}]}',
  '',
  'data: {broken json',
  '',
  'data: {"choices":[{"delta":{"content":"B"}}]}',
  '',
  'data: [DONE]'
].join('\n')
check('坏帧被跳过、其余正常聚合', parseSseCompletion(withBad, 'text/event-stream')?.choices?.[0]?.message?.content === 'AB', '')

// 全坏帧 → null（交回普通路径产出原始错误，不伪造空结果）
check('全坏帧返回 null 而非伪造空结果', parseSseCompletion('data: not-json\ndata: also-bad\n', 'text/event-stream') === null, '')

// ---------------------------------------------------------------------------
// ⑤ CRLF 分帧（Windows 网关常见）
// ---------------------------------------------------------------------------
check('CRLF 分帧同样可解析', parseSseCompletion(SSE.replace(/\n/g, '\r\n'), 'text/event-stream')?.choices?.[0]?.message?.content === '{"a":1}', '')

// ---------------------------------------------------------------------------
// ⑥ 审查拦截阈值不回归
// ---------------------------------------------------------------------------
check('拦截阈值仍为 50', CONTENT_BLOCKED_MIN_CHARS === 50, String(CONTENT_BLOCKED_MIN_CHARS))
check('短拒绝语判为拦截', isLikelyContentBlocked('对不起，我不能生成这张图片。') === true, '')
check('长正常输出不判拦截', isLikelyContentBlocked('{"chapters":['.padEnd(120, 'x')) === false, '')

// ---------------------------------------------------------------------------
// ⑦ 请求体形态不回归（不写 temperature / 保留 stream:false / 字段按 provider 选）
// ---------------------------------------------------------------------------
const provider = {
  id: 'x',
  label: 'x',
  baseURL: 'http://127.0.0.1:12345/v1',
  apiKey: 'k',
  model: 'm',
  enabled: true,
  providerKind: 'custom'
}
const body = buildRequestBody(provider, [{ role: 'user', content: 'ping' }], { maxTokens: 16 })
check('请求体不含 temperature', !('temperature' in body), JSON.stringify(Object.keys(body)))
check('请求体仍声明 stream:false', body.stream === false, String(body.stream))
check('custom 类型用 max_tokens', body.max_tokens === 16 && !('max_completion_tokens' in body), JSON.stringify(body))
check('minimax/mimo 用 max_completion_tokens', usesMaxCompletionTokens({ ...provider, providerKind: 'minimax' }) === true, '')
check(
  'endpoint 去掉尾部 / 再拼 /chat/completions',
  endpointOf({ baseURL: 'http://127.0.0.1:12345/v1/' }) === 'http://127.0.0.1:12345/v1/chat/completions',
  endpointOf({ baseURL: 'http://x/v1/' })
)

// ---------------------------------------------------------------------------
// ⑧ `readChatCompletion` —— 四个调用方的统一入口
//    （effects-suggest / imagegen 提示词改写 / chapter-recognition 都走它）
// ---------------------------------------------------------------------------
const mk = (body, init = {}) => new Response(body, init)

const r1 = await readChatCompletion(mk(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
check('入口：SSE 响应能取到正文', r1.ok === true && r1.content === '{"a":1}', JSON.stringify(r1))

const r2 = await readChatCompletion(mk(plain, { status: 200, headers: { 'content-type': 'application/json' } }))
check('入口：普通 JSON 响应能取到正文', r2.ok === true && r2.content === 'ok', JSON.stringify(r2))

const r3 = await readChatCompletion(mk('boom', { status: 500, headers: { 'content-type': 'text/plain' } }))
check('入口：非 2xx 返回可读错误并带状态码', r3.ok === false && r3.error.includes('500'), JSON.stringify(r3))

const r4 = await readChatCompletion(mk('<html>gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } }))
check('入口：非 JSON 非 SSE 报不可解析', r4.ok === false && r4.error.includes('不可解析'), JSON.stringify(r4))

const r5 = await readChatCompletion(
  mk(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '' } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
)
check('入口：空正文判失败（不把空串当成功）', r5.ok === false, JSON.stringify(r5))

const r6 = await readChatCompletion(mk('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
check('入口：缺 choices 数组时报错', r6.ok === false && r6.error.includes('choices'), JSON.stringify(r6))

await rm(BUILD_DIR, { recursive: true, force: true })

const bar = '─'.repeat(64)
const fails = checks.filter((c) => !c.ok)
console.log(`\n${bar}\n  LLM SSE 兼容性验证\n${bar}`)
console.log(`  共 ${checks.length} 项`)
console.log(bar)
if (fails.length) {
  console.log(`  ✗ ${fails.length} 项失败\n${bar}\n`)
  process.exit(1)
}
console.log(`  ✓ ${checks.length} 项全部通过\n${bar}\n`)

/**
 * 内置酒馆核心逻辑验证（node 直跑，不启动 Electron、不发网络请求）。
 *
 * 重点守住三件容易错、且错了很难察觉的事：
 *   1) **参数语义**：`null` 必须**不发送**该字段，而不是发 0
 *      —— `temperature: 0` 是贪心解码，与「用模型默认」完全不是一回事；
 *   2) **世界书匹配**：constant 条目永远注入，关键词命中去重，
 *      并且**不能被条数上限挤掉**（世界观丢了角色就会答得离谱）；
 *   3) **system 组装顺序**：人设在前、世界书在后（越靠后影响越大）。
 *
 * 另外守住：酒馆请求体**不发 response_format:json_object**
 * （流水线版会发；酒馆要的是自然语言，发了会把对话变成 JSON 拼装）。
 *
 * 用法：node scripts/verify-tavern-core.mjs
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(here, '..')
const BUILD_DIR = join(FEATHER, 'out', '.verify-tavern-core')

const require = createRequire(join(FEATHER, 'package.json'))
const { build } = require('esbuild')

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
  entryPoints: [join(FEATHER, 'src/main/character-card/tavern.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  external: ['node:*'],
  logLevel: 'silent',
  plugins: [electronStub()]
})
const outPath = join(BUILD_DIR, 'tavern.mjs')
await writeFile(outPath, result.outputFiles[0].text, 'utf8')
const mod = await import(pathToFileURL(outPath).href)

const {
  defaultTavernParams,
  defaultTavernSettings,
  buildTavernBody,
  matchLorebook,
  buildSystemPrompt,
  trimHistory,
  isLikelyRefusal
} = mod

const checks = []
function check(name, cond, detail = '') {
  checks.push({ name, ok: !!cond, detail })
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : detail ? `  — ${detail}` : ''}`)
}

const PROVIDER = {
  id: 'p1',
  label: 'test',
  baseURL: 'http://127.0.0.1:12345/v1',
  apiKey: 'k',
  model: 'm',
  enabled: true,
  providerKind: 'custom'
}
const PROVIDER_MINIMAX = { ...PROVIDER, providerKind: 'minimax' }

// ---------------------------------------------------------------------------
// ① 参数语义：null 不发、数值照发
// ---------------------------------------------------------------------------
const params = defaultTavernParams()
check('默认温度是 0.85（对话取常用值）', params.temperature === 0.85, String(params.temperature))

const body = buildTavernBody(PROVIDER, [{ role: 'user', content: 'hi' }], params)
check('发 temperature', body.temperature === 0.85, String(body.temperature))
check('发 top_p', body.top_p === 0.95, String(body.top_p))
check('发 frequency_penalty', body.frequency_penalty === 0.2, String(body.frequency_penalty))
check('发 presence_penalty', body.presence_penalty === 0.2, String(body.presence_penalty))
check('默认不发 top_k（null）', !('top_k' in body), JSON.stringify(Object.keys(body)))
check('默认不发 repetition_penalty（null）', !('repetition_penalty' in body), '')
check('默认不发 seed（null）', !('seed' in body), '')
check('maxTokens → max_tokens（custom）', body.max_tokens === 800, String(body.max_tokens))
check('minimax 用 max_completion_tokens', buildTavernBody(PROVIDER_MINIMAX, [], params).max_completion_tokens === 800, '')
check('⚠️ 酒馆不发 response_format（要自然语言）', !('response_format' in body), JSON.stringify(Object.keys(body)))
check('声明 stream:false', body.stream === false, String(body.stream))

// null 与 0 必须区分：显式 0 要发，显式 null 不发
const zero = buildTavernBody(PROVIDER, [], { ...params, temperature: 0, topP: 0, frequencyPenalty: 0 })
check('temperature:0 **要发**（贪心解码是显式取值）', zero.temperature === 0, String(zero.temperature))
check('top_p:0 要发', zero.top_p === 0, String(zero.top_p))
check('frequency_penalty:0 要发', zero.frequency_penalty === 0, String(zero.frequency_penalty))
const nulled = buildTavernBody(PROVIDER, [], { ...params, temperature: null, topP: null, frequencyPenalty: null })
check('temperature:null **不发**', !('temperature' in nulled), '')
check('top_p:null 不发', !('top_p' in nulled), '')
check('frequency_penalty:null 不发', !('frequency_penalty' in nulled), '')
check('maxTokens=0 时不发 max_tokens', !('max_tokens' in buildTavernBody(PROVIDER, [], { ...params, maxTokens: 0 })), '')

// stop / seed
check('stop 非空时发送', JSON.stringify(buildTavernBody(PROVIDER, [], { ...params, stop: ['\n用户'] }).stop) === JSON.stringify(['\n用户']), '')
check('⚠️ stop 保留前导换行（不 trim，否则会正文中间误停）', JSON.stringify(buildTavernBody(PROVIDER, [], { ...params, stop: ['\n用户：'] }).stop) === JSON.stringify(['\n用户：']), '')
check('stop 全空白时不发送', !('stop' in buildTavernBody(PROVIDER, [], { ...params, stop: ['  ', ''] })), '')
check('seed 有值时发送', buildTavernBody(PROVIDER, [], { ...params, seed: 42 }).seed === 42, '')

// ---------------------------------------------------------------------------
// ② 世界书匹配
// ---------------------------------------------------------------------------
const LORE = [
  { id: 'world:main', name: '世界观', keys: [], content: '1815年法国', constant: true, insertionOrder: 1, source: 'world' },
  { id: 'char:dantes', name: '唐太斯', keys: ['爱德蒙·唐太斯', '唐太斯', '爱德蒙'], content: '法老号大副', constant: false, insertionOrder: 100, source: 'character' },
  { id: 'char:mercedes', name: '美塞苔丝', keys: ['美塞苔丝'], content: '加泰罗尼亚渔女', constant: false, insertionOrder: 101, source: 'character' },
  { id: 'char:villefort', name: '维尔福', keys: ['维尔福'], content: '代理检察官', constant: false, insertionOrder: 102, source: 'character' },
  { id: 'rel:1', name: '唐太斯 × 美塞苔丝', keys: ['唐太斯', '美塞苔丝'], content: '相爱并订婚', constant: false, insertionOrder: 103, source: 'relation' }
]
const msgs = (text) => [{ id: '1', role: 'user', content: text, at: 0 }]

const hit1 = matchLorebook(LORE, msgs('唐太斯最近怎么样？'), 10)
check('提到唐太斯时命中他的条目', hit1.hitIds.includes('char:dantes'), JSON.stringify(hit1.hitIds))
check('提到唐太斯时也命中关系条目（key 共享）', hit1.hitIds.includes('rel:1'), JSON.stringify(hit1.hitIds))
check('constant 条目永远注入', hit1.hitIds.includes('world:main'), JSON.stringify(hit1.hitIds))
check('没提到的角色不注入', !hit1.hitIds.includes('char:villefort'), JSON.stringify(hit1.hitIds))

const hit2 = matchLorebook(LORE, msgs('今天天气不错'), 10)
check('无关消息只注入 constant', JSON.stringify(hit2.hitIds) === JSON.stringify(['world:main']), JSON.stringify(hit2.hitIds))

const hit3 = matchLorebook(LORE, msgs('美塞苔丝和唐太斯'), 3)
check('条数上限生效', hit3.hits.length <= 4, `${hit3.hits.length}（上限 3 + constant 补回）`)
check('上限挤掉时 constant 仍保留', hit3.hitIds.includes('world:main'), JSON.stringify(hit3.hitIds))

// 别名匹配
const hitAlias = matchLorebook(LORE, msgs('爱德蒙在哪'), 10)
check('按别名（爱德蒙）命中', hitAlias.hitIds.includes('char:dantes'), JSON.stringify(hitAlias.hitIds))

// 大小写不敏感（英文名）
const LORE_EN = [{ id: 'c', name: 'Dantes', keys: ['Dantès', 'Edmond'], content: 'x', constant: false, insertionOrder: 5, source: 'character' }]
check('英文名大小写不敏感', matchLorebook(LORE_EN, msgs('where is edmond'), 10).hitIds.includes('c'), '')
check('空世界书返回空', matchLorebook([], msgs('任意'), 10).hitIds.length === 0, '')

// 只看最近消息：很久以前提到的不再注入
const longMsgs = [
  { id: '1', role: 'user', content: '维尔福是谁', at: 0 },
  { id: '2', role: 'assistant', content: '他是检察官', at: 1 },
  { id: '3', role: 'user', content: '嗯', at: 2 },
  { id: '4', role: 'assistant', content: '还有别的事吗', at: 3 },
  { id: '5', role: 'user', content: '说说海', at: 4 },
  { id: '6', role: 'assistant', content: '海很平静', at: 5 },
  { id: '7', role: 'user', content: '继续', at: 6 },
  { id: '8', role: 'assistant', content: '好的', at: 7 }
]
const hitFar = matchLorebook(LORE, longMsgs, 10)
check('只看最近 6 条（早期提到的维尔福已滑出窗口）', !hitFar.hitIds.includes('char:villefort'), JSON.stringify(hitFar.hitIds))

// ---------------------------------------------------------------------------
// ③ system prompt 组装
// ---------------------------------------------------------------------------
const CARD = {
  id: 'dantes', name: '爱德蒙·唐太斯', aliases: ['唐太斯'],
  description: '身份：法老号大副。', personality: '沉稳', scenario: '从第 1 章开始',
  systemPrompt: '', identInfos: [], profile: '', lifeStatus: '',
  appearanceChapters: [], portraits: [], voice: null, relations: [], actionCount: 0,
  firstMes: '', mesExample: '', creatorNotes: '', creator: '', cardVersion: '1.0',
  createdAt: '', sourceTitle: '', novelGenre: '', importanceLevel: 'CORE'
}
const sp = buildSystemPrompt(CARD, [LORE[0], LORE[1]])
check('system 含角色名', sp.includes('爱德蒙·唐太斯'), '')
check('system 含角色设定', sp.includes('法老号大副'), '')
check('system 含别名', sp.includes('别名'), '')
check('system 含世界书内容', sp.includes('1815年法国'), '')
check('system 要求不跳角色', sp.includes('不要跳出角色'), '')
check('system 要求不要背诵设定', sp.includes('不要直接背诵'), '')
check('人设段在世界书段之前', sp.indexOf('角色设定') < sp.indexOf('相关背景'), `${sp.indexOf('角色设定')} vs ${sp.indexOf('相关背景')}`)
const spNoLore = buildSystemPrompt(CARD, [])
check('无世界书时不出现「相关背景」段', !spNoLore.includes('相关背景'), '')

// ---------------------------------------------------------------------------
// ④ 历史裁剪
// ---------------------------------------------------------------------------
const many = Array.from({ length: 30 }, (_, i) => ({
  id: String(i),
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: `m${i}`,
  at: i
}))
check('historyLimit=12 时只取最近 12 条', trimHistory(many, 12).length === 12, String(trimHistory(many, 12).length))
check('取的是**最近**的（末条保留）', trimHistory(many, 12)[11].content === 'm29', trimHistory(many, 12)[11].content)
check('historyLimit=0 时全保留', trimHistory(many, 0).length === 30, String(trimHistory(many, 0).length))
const withSystem = [
  { id: 's', role: 'system', content: 'sys', at: 0 },
  { id: 'u', role: 'user', content: 'hi', at: 1 }
]
check('裁剪时剔除 system 角色消息', trimHistory(withSystem, 0).every((m) => m.role !== 'system'), '')

// ---------------------------------------------------------------------------
// ⑤ 拒绝判定：**不能**套用流水线的 50 字阈值
// ---------------------------------------------------------------------------
// 实测踩过的假拦截：这句 39 字的合格对白被 50 字规则判成审查拒绝
const SHORT_VALID = '我是爱德蒙·唐太斯，法老号上的大副。刚刚随船回到马赛，正打算先回去看看我父亲。'
check('39 字合格对白**不**判为拒绝', SHORT_VALID.length < 50 && isLikelyRefusal(SHORT_VALID) === false, `${SHORT_VALID.length} 字`)
check('空串判为拒绝', isLikelyRefusal('') === true, '')
check('纯空白判为拒绝', isLikelyRefusal('   \n ') === true, '')
check('极短回复（<12 字）判为拒绝', isLikelyRefusal('好的。') === true, '')
check('中文拒绝对话判为拒绝', isLikelyRefusal('对不起，我不能继续这个话题。') === true, '')
check('中文拒绝（抱歉式）判为拒绝', isLikelyRefusal('抱歉，我无法回答这个问题。') === true, '')
check('能力拒绝式判为拒绝', isLikelyRefusal('我不能生成这样的内容。') === true, '')
check('AI 自称式判为拒绝', isLikelyRefusal('作为一个AI语言模型，我没有个人情感。') === true, '')
check('英文拒绝判为拒绝', isLikelyRefusal("I'm sorry, but I can't help with that.") === true, '')
check('英文 As an AI 判为拒绝', isLikelyRefusal('As an AI, I do not have feelings.') === true, '')
check('正常英文对白不判拒绝', isLikelyRefusal('Good evening. What brings you here at this hour?') === false, '')
check('较长的中文对白不判拒绝', isLikelyRefusal('我在伊夫堡待了十四年，那地方教会我等待和计算。') === false, '')

// ---------------------------------------------------------------------------
// ⑥ 默认设置自洽
// ---------------------------------------------------------------------------
const s = defaultTavernSettings()
check('默认注入世界书', s.useLorebook === true, '')
check('默认世界书上限 6', s.lorebookLimit === 6, String(s.lorebookLimit))
check('默认历史 12 条', s.historyLimit === 12, String(s.historyLimit))
check('默认回复条数 1', s.replyCount === 1, String(s.replyCount))
check('默认参数与 defaultTavernParams 一致', JSON.stringify(s.params) === JSON.stringify(defaultTavernParams()), '')

await rm(BUILD_DIR, { recursive: true, force: true })

const bar = '─'.repeat(64)
const fails = checks.filter((c) => !c.ok)
console.log(`\n${bar}\n  内置酒馆核心逻辑验证\n${bar}`)
console.log(`  共 ${checks.length} 项`)
console.log(bar)
if (fails.length) {
  console.log(`  ✗ ${fails.length} 项失败\n${bar}\n`)
  process.exit(1)
}
console.log(`  ✓ ${checks.length} 项全部通过\n${bar}\n`)

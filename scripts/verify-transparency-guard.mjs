/**
 * D 线验证：透明图规范 + 审查拦截机制 + 负面词分流。
 *
 * 验证点：
 *   ① 人物/图标模板严格含 Qwen 官方 RGBA 固定首尾句
 *   ② 透明声明位于**首尾**而不是中段（扩散模型首尾权重最高）
 *   ③ 人物负面词压制 background/scene，场景负面词相反
 *   ④ isLikelyContentBlocked：<50 字判定
 *   ⑤ chatWithFallback 遇 blocked 立即终止（不重试、不换配置）
 *   ⑥ 任务状态能落 blocked，下游跳过原因可读
 *
 * 用法：node scripts/verify-transparency-guard.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

async function loadTs(entryRel) {
  const out = await build({
    entryPoints: [join(root, entryRel)],
    absWorkingDir: root,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    write: false,
    logLevel: 'silent',
    external: ['electron']
  })
  const code = out.outputFiles[0].text
  const mod = { exports: {} }
  const { createRequire } = await import('node:module')
  new Function('module', 'exports', 'require', code)(mod, mod.exports, createRequire(import.meta.url))
  return mod.exports
}

const failures = []
const checks = []
const check = (name, cond, detail) => {
  checks.push({ name, ok: !!cond, detail })
  if (!cond) failures.push(`${name}（${detail}）`)
}

const D = await loadTs('src/shared/imagegen-defaults.ts')
const P = await loadTs('src/main/imagegen/prompts.ts')

// ---------- ① 官方 RGBA 固定句式 ----------
const OFFICIAL_HEAD = 'This is an RGBA image with transparency.'
const OFFICIAL_TAIL = 'The image has alpha channel and the background is transparent.'

check('导出了官方 HEAD 常量', D.RGBA_PROMPT_HEAD === OFFICIAL_HEAD, JSON.stringify(D.RGBA_PROMPT_HEAD))
check('导出了官方 TAIL 常量', D.RGBA_PROMPT_TAIL === OFFICIAL_TAIL, JSON.stringify(D.RGBA_PROMPT_TAIL))
check('常量与 Qwen 官方 README 逐字一致（HEAD）', D.RGBA_PROMPT_HEAD === OFFICIAL_HEAD, '')
check('常量与 Qwen 官方 README 逐字一致（TAIL）', D.RGBA_PROMPT_TAIL === OFFICIAL_TAIL, '')

// ---------- ② 人物/图标模板首尾位置 ----------
const charTpl = D.DEFAULT_CHAR_PROMPT_TEMPLATE
const iconTpl = D.DEFAULT_ICON_PROMPT_TEMPLATE
const charLines = charTpl.split('\n')
const iconLines = iconTpl.split('\n')

check('人物模板首行是 RGBA HEAD', charLines[0] === OFFICIAL_HEAD, JSON.stringify(charLines[0]))
check('人物模板末行是 RGBA TAIL', charLines[charLines.length - 1] === OFFICIAL_TAIL, JSON.stringify(charLines[charLines.length - 1]))
check('图标模板首行是 RGBA HEAD', iconLines[0] === OFFICIAL_HEAD, JSON.stringify(iconLines[0]))
check('图标模板末行是 RGBA TAIL', iconLines[iconLines.length - 1] === OFFICIAL_TAIL, JSON.stringify(iconLines[iconLines.length - 1]))

// 透明声明不应只出现在中段：除首尾外，中段最多出现一次「背景完全透明」类表述
const midTransparent = charLines
  .slice(1, -1)
  .filter((l) => /完全透明|透明背景/.test(l)).length
check('人物模板中段的透明声明不超过 1 处（避免重复稀释）', midTransparent <= 1, `got=${midTransparent}`)

// ---------- ③ 负面词分流 ----------
const neg = D.DEFAULT_NEGATIVE_PROMPT
const sceneNeg = D.DEFAULT_SCENE_NEGATIVE_PROMPT
check('人物负面词压制 background', /背景/.test(neg), neg)
check('人物负面词含「白色背景」', /白色背景/.test(neg), neg)
check('人物负面词压制白边', /白边|白色描边/.test(neg), neg)
check('场景负面词压制透明背景', /透明背景/.test(sceneNeg), sceneNeg)
check('场景负面词压制空白背景', /空白背景/.test(sceneNeg), sceneNeg)
check('场景负面词要求无人物', /人物/.test(sceneNeg), sceneNeg)
check('两份负面词不同（分流生效）', neg !== sceneNeg, '')
check(
  '默认设置同时含两份负面词',
  typeof D.defaultComfyuiSettings().negativePrompt === 'string' &&
    typeof D.defaultComfyuiSettings().sceneNegativePrompt === 'string',
  ''
)

// ---------- ④ 渲染结果验证 ----------
const charTarget = {
  charId: 'x',
  charName: '测试角色',
  appearanceId: 'a1',
  appearanceName: '日常',
  sex: '男',
  appearanceSummary: '黑发黑眼',
  visualKeywords: ['黑发'],
  hasImage: false,
  imagePath: '',
  aliases: []
}
const ctx = {
  worldImpression: '19世纪法国',
  novelGenre: '历史小说',
  iconStyle: '',
  charArtStyle: '',
  sceneArtStyle: ''
}
const rendered = P.renderCharPrompt(charTarget, ctx, undefined, 'anime')
check('渲染结果以官方 HEAD 开头', rendered.startsWith(OFFICIAL_HEAD), rendered.slice(0, 60))
check('渲染结果以官方 TAIL 结尾', rendered.trimEnd().endsWith(OFFICIAL_TAIL), rendered.slice(-80))
check('渲染结果无残留占位符', !/\{\{/.test(rendered), rendered.match(/\{\{[^}]*\}\}/g)?.join(',') ?? '')
check('渲染结果不含旧的「浅色纯色渐变背景」', !/浅色纯色渐变/.test(rendered), '旧描述残留')

// ---------- ⑤ 审查拦截判定 ----------
const L = await loadTs('src/main/pipeline/llm-client.ts')
check('导出了阈值常量', L.CONTENT_BLOCKED_MIN_CHARS === 50, `got=${L.CONTENT_BLOCKED_MIN_CHARS}`)
check('导出了判定函数', typeof L.isLikelyContentBlocked === 'function', '')

const blockedSamples = [
  '对不起，我不能生成这个内容。',
  "I'm sorry, but I can't help with that.",
  '无法完成该请求。',
  '    ',
  '',
  '抱歉。'
]
for (const s of blockedSamples) {
  check(`判定为拦截：${JSON.stringify(s.slice(0, 20))}`, L.isLikelyContentBlocked(s) === true, `len=${s.trim().length}`)
}

const okSamples = [
  'x'.repeat(50),
  JSON.stringify({ output: { chapters: [{ chapterSeq: 1, segments: [] }] } }),
  '{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8,"i":9,"j":10,"k":11,"l":12}',
  '这是一段正常的模型输出内容，包含足够多的字符用于通过长度检查，不会被误判为审查拦截。再加上一些内容确保稳定超过五十个字符的阈值。'
]
for (const s of okSamples) {
  check(`不判为拦截（${s.trim().length} 字）`, L.isLikelyContentBlocked(s) === false, `len=${s.trim().length}`)
}

// 边界：恰好 50 字不拦截，49 字拦截（阈值语义必须精确）
const exactly50 = 'x'.repeat(49)
check('恰好 49 字判为拦截（阈值下界）', L.isLikelyContentBlocked(exactly50) === true, `len=${exactly50.length}`)
const exactly50ok = 'x'.repeat(50)
check('恰好 50 字不拦截（阈值上界）', L.isLikelyContentBlocked(exactly50ok) === false, `len=${exactly50ok.length}`)

// ---------- ⑥ 源码契约：blocked 立即终止 ----------
const llmSrc = readFileSync(join(root, 'src/main/pipeline/llm-client.ts'), 'utf8')
check('singleChat 返回 blocked 字段', /blocked:\s*true/.test(llmSrc), '')
check('chatWithFallback 遇 blocked 立即 return', /if \(r\.blocked\)[\s\S]{0,700}?blocked: true/.test(llmSrc), '')
const orchSrc = readFileSync(join(root, 'src/main/pipeline/orchestrator.ts'), 'utf8')
check('orchestrator 把 blocked 转成可识别错误', /e\.blocked = true/.test(orchSrc), '')
check('orchestrator 落 blocked 状态', /status: 'blocked'/.test(orchSrc), '')
check('下游跳过原因区分 blocked', /被内容审查拦截/.test(orchSrc), '')
check('抽出 depKeysFor 供两处共用', /function depKeysFor/.test(orchSrc), '')
const wsTypes = readFileSync(join(root, 'src/shared/workspace-types.ts'), 'utf8')
check('TaskState 含 blocked 状态', /'blocked'/.test(wsTypes), '')

// ---------- 报告 ----------
const bar = '─'.repeat(70)
console.log(`\n${bar}\n  D 线验证 · 透明图规范 + 审查拦截\n${bar}`)
for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : '  ← ' + c.detail}`)
console.log(`\n${bar}`)
if (failures.length) {
  console.log(`  ✗ ${failures.length} 项失败 / 共 ${checks.length} 项\n${bar}\n`)
  process.exit(1)
}
console.log(`  ✓ ${checks.length} 项全部通过\n${bar}\n`)

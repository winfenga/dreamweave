/**
 * 场景提示词模板验证（B3）。
 *
 * 验证点：
 *   ① 默认模板存在且变量集合完整
 *   ② 六类变量全部能渲染（不残留 {{...}}）
 *   ③ 缺变量时句子仍通顺（不出现空括号、连续标点）
 *   ④ 用户自定义模板能覆盖
 *   ⑤ 设置页默认值与 store 补默认一致（旧 settings.json 无该字段时不炸）
 *
 * 用法：node scripts/verify-scene-prompt.mjs
 */
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
  new Function('module', 'exports', 'require', code)(mod, mod.exports, (id) => import(id))
  return mod.exports
}

const defaults = await loadTs('src/shared/imagegen-defaults.ts')
const prompts = await loadTs('src/main/imagegen/prompts.ts')

const failures = []
const checks = []
const check = (name, cond, detail) => {
  checks.push({ name, ok: !!cond, detail })
  if (!cond) failures.push(`${name}（${detail}）`)
}

const TPL = defaults.DEFAULT_SCENE_PROMPT_TEMPLATE
check('默认场景模板存在', typeof TPL === 'string' && TPL.length > 200, `len=${TPL?.length}`)

// ① 变量集合
const declared = prompts.SCENE_TEMPLATE_VARS
check('导出了 6 个合法占位符', declared?.length === 6, `got=${declared?.length}`)
const inTpl = new Set([...TPL.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)].map((m) => m[1]))
for (const v of inTpl) {
  check(`模板内变量 ${v} 已声明`, declared.includes(v), `模板用了但 SCENE_TEMPLATE_VARS 没有`)
}
for (const v of declared) {
  check(`声明变量 ${v} 在模板里出现`, inTpl.has(v), `声明了但模板没用到`)
}

// ② 全量渲染
const target = {
  sceneId: 'PL-73',
  name: '廷根市霍伊大学图书馆',
  summary: '陈旧木质书架与高窗，午后光柱斜射入室内',
  sceneDescription: '三层楼高书架、旋转铁梯、阅览长桌、积灰的烛台',
  hasImage: false,
  imagePath: ''
}
const ctx = {
  worldImpression: '维多利亚时代蒸汽与神秘学交织的世界',
  novelGenre: '悬疑奇幻',
  iconStyle: '',
  charArtStyle: '',
  sceneArtStyle: '日式手绘动画背景，不透明水彩质感'
}
const full = prompts.renderScenePrompt(target, ctx, TPL)
check('全量渲染无残留占位符', !/\{\{/.test(full), full.match(/\{\{[^}]*\}\}/g)?.join(',') ?? '')
for (const kw of ['廷根市霍伊大学图书馆', '悬疑奇幻', '蒸汽与神秘学', '日式手绘动画背景', '阅览长桌']) {
  check(`渲染结果含「${kw}」`, full.includes(kw), '缺失')
}
check('渲染结果长度合理', full.length > 400, `len=${full.length}`)
check('渲染结果含 16:9 构图约束', full.includes('16:9'), '缺')
check('渲染结果含"不绘制任何人物"', full.includes('不绘制任何人物'), '缺')

// ③ 缺变量降级
const emptyCtx = { worldImpression: '', novelGenre: '', iconStyle: '', charArtStyle: '', sceneArtStyle: '' }
const bare = prompts.renderScenePrompt({ ...target, summary: '', sceneDescription: '' }, emptyCtx, TPL)
check('缺变量渲染无残留占位符', !/\{\{/.test(bare), '有残留')
check('缺变量渲染不出现空引号对', !/「\s*」/.test(bare), '出现「」')
check('缺变量渲染不出现空括号', !/（\s*）/.test(bare), '出现（）')
check('缺变量渲染无连续标点', !/[，。]{2,}/.test(bare), '有连续标点')
check('缺变量渲染仍保留核心要求', bare.includes('不绘制任何人物') && bare.includes('16:9'), '核心约束丢了')

// ④ 自定义模板覆盖
const custom = 'CUSTOM:{{sceneName}}|{{novelGenre}}'
const overridden = prompts.renderScenePrompt(target, ctx, custom)
check('自定义模板可覆盖默认', overridden === 'CUSTOM:廷根市霍伊大学图书馆|悬疑奇幻', overridden)

// ⑤ 设置默认
const dflt = defaults.defaultComfyuiSettings()
check('defaultComfyuiSettings 含 scenePromptTemplate', typeof dflt.scenePromptTemplate === 'string', typeof dflt.scenePromptTemplate)
check('默认场景模板与常量一致', dflt.scenePromptTemplate === TPL, '不一致')
check('SCENE_TEMPLATE_HINT 非空', typeof defaults.SCENE_TEMPLATE_HINT === 'string' && defaults.SCENE_TEMPLATE_HINT.length > 50, '空')

// 报告
const bar = '─'.repeat(64)
console.log(`\n${bar}\n  场景提示词模板验证（B3）\n${bar}`)
for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : '  ← ' + c.detail}`)
console.log(`\n${bar}`)
if (failures.length) {
  console.log(`  ✗ ${failures.length} 项失败 / 共 ${checks.length} 项\n${bar}\n`)
  process.exit(1)
}
console.log(`  ✓ ${checks.length} 项全部通过\n${bar}\n`)

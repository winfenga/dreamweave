/**
 * A2/A3/A4 验证：特效目录 guide + target、建议输出 cId、system 结构化。
 *
 * 验证点：
 *   ① 目录里 28 条有 guide、target 只有 portrait-cutin 一条
 *   ② guide 不截断（对比 description 的 40 字截断）
 *   ③ catalogDigest 优先用 guide，回落 description
 *   ④ system 提示词含五段结构 + target 规则
 *   ⑤ whitelist 保留 target 特效的 cId、过滤不存在的 cId、非 target 丢弃 cId
 *   ⑥ 向后兼容：无 characterIds / 无 cId 时不报错
 *
 * 用法：node scripts/verify-effect-guide.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

async function loadTs(entryRel) {
  // 允许传绝对路径（探针临时文件在 tmp 里）
  const entry = entryRel.startsWith('/') || /^[A-Za-z]:[\\/]/.test(entryRel) ? entryRel : join(root, entryRel)
  const out = await build({
    entryPoints: [entry],
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

const failures = []
const checks = []
const check = (name, cond, detail) => {
  checks.push({ name, ok: !!cond, detail })
  if (!cond) failures.push(`${name}（${detail}）`)
}

const catalog = JSON.parse(readFileSync(join(root, 'resources', 'effects', 'effect-catalog.json'), 'utf8'))
const entries = Array.isArray(catalog) ? catalog : (catalog.effects ?? catalog.items ?? [])

// ①② 目录字段
const withGuide = entries.filter((e) => typeof e.guide === 'string' && e.guide.trim())
const withTarget = entries.filter((e) => e.target === true)

check('目录总数 74', entries.length === 74, `got=${entries.length}`)
check('guide 覆盖 24 条（28 条匹配中剔除 4 条无效值）', withGuide.length === 24, `got=${withGuide.length}`)
check('target 只有 1 条', withTarget.length === 1, `got=${withTarget.length}: ${withTarget.map((e) => e.id)}`)
check('target 是 portrait-cutin', withTarget[0]?.id === 'portrait-cutin', `got=${withTarget[0]?.id}`)
check(
  '无效 guide 未被写入（dizzy/startled-awakening/sword-clash/dream）',
  ['dizzy', 'startled-awakening', 'sword-clash', 'dream'].every((id) => {
    const e = entries.find((x) => x.id === id)
    return !e || !e.guide
  }),
  '仍有残留'
)
check('所有 guide 长度 > 8（无类别名残留）', withGuide.every((e) => e.guide.trim().length > 8), JSON.stringify(withGuide.filter((e) => e.guide.trim().length <= 8).map((e) => e.id)))

const cutin = entries.find((e) => e.id === 'portrait-cutin')
check('portrait-cutin 有 guide', !!cutin?.guide, '缺')
check('portrait-cutin 的 guide 含「不用于普通说话」', /不用于普通说话/.test(cutin?.guide ?? ''), cutin?.guide)
check('portrait-cutin 的 guide 含「必须指定」', /必须指定/.test(cutin?.guide ?? ''), cutin?.guide)
check(
  'guide 比 description 前 40 字更有判断力（长度检验）',
  (cutin?.guide ?? '').length > 0 && (cutin?.guide ?? '').length <= (cutin?.description ?? '').length,
  `guide=${cutin?.guide?.length} desc=${cutin?.description?.length}`
)
check('所有 guide 均非空字符串', withGuide.every((e) => e.guide.trim().length > 5), '有空 guide')
check('guide 总字符数合理（<2000）', withGuide.reduce((s, e) => s + e.guide.length, 0) < 2000, '')

// ③ 摘要
const suggestMod = await loadTs('src/main/effects-suggest.ts')
// catalogDigest / buildMessages 未导出 → 通过行为验证（导出的是 suggestEffects）
// 这里改为直接检查源码契约：确认 catalogDigest 里出现 guide 优先逻辑
const src = readFileSync(join(root, 'src', 'main', 'effects-suggest.ts'), 'utf8')
check('catalogDigest 优先用 guide', /const\s+guide\s*=\s*\(e\.guide/.test(src) || /e\.guide\s*\?\?/.test(src), '未找到 guide 优先')
check('catalogDigest 已去掉 slice(0, 40) 对 guide 的截断', !/guide\s*\?\?\s*''\)\.slice/.test(src), '仍有截断')
check('system 含五段结构【角色】', src.includes('【角色】'), '缺')
check('system 含【输入结构】', src.includes('【输入结构】'), '缺')
check('system 含【特效清单】', src.includes('【特效清单】'), '缺')
check('system 含【选择原则】', src.includes('【选择原则】'), '缺')
check('system 含【输出约束】', src.includes('【输出约束】'), '缺')
check('system 含 target 硬规则（无法确定则不推荐）', /不要推荐这个特效/.test(src), '缺')
check('system 说明了「不用于」的处理', /判断依据里写了「不用于/.test(src), '缺')

// ⑤⑥ 白名单行为 —— 复制一份源码到临时目录，插入 export 后整体交给 esbuild 打包。
// 这比手工切函数体可靠：esbuild 处理依赖、类型擦除、模块边界，我们只管加一个 export。
const { writeFileSync, mkdtempSync, cpSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const tmp = mkdtempSync(join(tmpdir(), 'fxw-'))
const probePath = join(root, 'src', 'main', 'effects-suggest.probe.ts')
const patched = src.replace(/^function whitelist\(/m, 'export function whitelist(')
check('能插入 export（源码结构未被破坏）', patched !== src, '未匹配到 function whitelist(')
writeFileSync(probePath, patched, 'utf8')

let wl = null
try {
  wl = await loadTs('src/main/effects-suggest.probe.ts')
  check('探针模块可加载并导出 whitelist', typeof wl.whitelist === 'function', typeof wl.whitelist)
} catch (e) {
  check('探针模块可加载并导出 whitelist', false, e.message.slice(0, 160))
}

if (wl?.whitelist) {
  const fakeEntries = [
    { id: 'portrait-cutin', name: '人物斜切入场', target: true, guide: 'g' },
    { id: 'rain', name: '雨', guide: 'g' }
  ]
  const chars = ['D-0-C-0', 'D-0-C-1']

  const r1 = wl.whitelist(
    [{ id: 'portrait-cutin', cId: 'D-0-C-0', reason: 'x', confidence: 0.9 }],
    fakeEntries,
    chars
  )
  check('target 特效保留合法 cId', r1.kept[0]?.cId === 'D-0-C-0', JSON.stringify(r1.kept))

  const r2 = wl.whitelist([{ id: 'portrait-cutin', cId: 'NOT-A-CHAR' }], fakeEntries, chars)
  check('不存在的 cId 被丢弃（特效本身保留）', r2.kept.length === 1 && r2.kept[0].cId === undefined, JSON.stringify(r2.kept))

  const r3 = wl.whitelist([{ id: 'rain', cId: 'D-0-C-0' }], fakeEntries, chars)
  check('非 target 特效的 cId 被丢弃', r3.kept.length === 1 && r3.kept[0].cId === undefined, JSON.stringify(r3.kept))

  const r4 = wl.whitelist([{ id: 'portrait-cutin' }], fakeEntries, chars)
  check('target 特效无 cId 时仍保留（回落当前说话人）', r4.kept.length === 1 && r4.kept[0].cId === undefined, JSON.stringify(r4.kept))

  const r5 = wl.whitelist([{ id: 'portrait-cutin', cId: 'X' }], fakeEntries, undefined)
  check('无角色清单时 cId 原样接受（向后兼容）', r5.kept[0]?.cId === 'X', JSON.stringify(r5.kept))

  const r6 = wl.whitelist([{ id: '不存在的id' }], fakeEntries, chars)
  check('臆造 effectId 仍被丢弃', r6.kept.length === 0 && r6.dropped.includes('不存在的id'), JSON.stringify(r6))

  const r7 = wl.whitelist([{ id: 'portrait-cutin', characterId: 'D-0-C-1' }], fakeEntries, chars)
  check('兼容 characterId 别名', r7.kept[0]?.cId === 'D-0-C-1', JSON.stringify(r7.kept))
}

// 清理探针文件（不留在仓库里）
try {
  const { rmSync } = await import('node:fs')
  rmSync(probePath, { force: true })
} catch {
  // 忽略
}

// 报告
const bar = '─'.repeat(68)
console.log(`\n${bar}\n  A2/A3/A4 验证 · 特效目录 guide + target + cId\n${bar}`)
for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : '  ← ' + c.detail}`)
console.log(`\n${bar}`)
if (failures.length) {
  console.log(`  ✗ ${failures.length} 项失败 / 共 ${checks.length} 项\n${bar}\n`)
  process.exit(1)
}
console.log(`  ✓ ${checks.length} 项全部通过\n${bar}\n`)

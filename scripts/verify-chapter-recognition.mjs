/**
 * 章节识别验证（§5 `chapter_recognition`）。
 *
 * 重点验证两件容易出错的事：
 *   ① **格式家族分类正确**：不同编号写法的标题能被识别成不同家族
 *   ② **分组一致性**：`buildStructureReport` 与 `chapter-recognition-llm` 的
 *      `pickGroupLines` 必须用**同一套分组规则**——否则会出现
 *      「模型选了 g2 但还原成别的组」的静默错误（这类 bug 最难查）
 *
 * 用法：node scripts/verify-chapter-recognition.mjs
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
  const { createRequire } = await import('node:module')
  new Function('module', 'exports', 'require', code)(mod, mod.exports, createRequire(import.meta.url))
  return mod.exports
}

const CR = await loadTs('src/main/workspace/chapter-recognition.ts')

const failures = []
const checks = []
const check = (name, cond, detail) => {
  checks.push({ name, ok: !!cond, detail })
  if (!cond) failures.push(`${name}（${detail}）`)
}

// ---------- ① 中文数字解析 ----------
const cn = [
  ['一', 1],
  ['十', 10],
  ['十一', 11],
  ['二十', 20],
  ['二十三', 23],
  ['一百', 100],
  ['一百零五', 105],
  ['两百', 200],
  ['一千', 1000],
  ['1', 1],
  ['42', 42],
  ['１２', 12]
]
for (const [s, want] of cn) {
  check(`中文数字「${s}」→ ${want}`, CR.cnToNumber(s) === want, `got=${CR.cnToNumber(s)}`)
}
check('无法解析返回 null', CR.cnToNumber('abc') === null, `got=${CR.cnToNumber('abc')}`)

// ---------- ② 结构报告：多种编号写法 ----------
const novelA = [
  '书名：测试小说',
  '',
  '第一章 初见',
  '正'.repeat(300),
  '',
  '第二章 再会',
  '正'.repeat(280),
  '',
  '第三章 离别',
  '正'.repeat(320)
].join('\n')

const repA = CR.buildStructureReport(novelA)
check('报告含字符数', repA.characters === novelA.length, `got=${repA.characters}`)
check('报告识别出候选', repA.candidateCount >= 3, `got=${repA.candidateCount}`)
const chGroupA = repA.groups.find((g) => g.family === '第{n}章')
check('识别出「第N章」家族', !!chGroupA, JSON.stringify(repA.groups.map((g) => g.family)))
check('该家族 count=3', chGroupA?.count === 3, `got=${chGroupA?.count}`)
check('substantive 统计正确（3 条都有正文）', chGroupA?.substantive === 3, `got=${chGroupA?.substantive}`)
check('resets 为 0（没有编号回绕到 1）', chGroupA?.resets === 0, `got=${chGroupA?.resets}`)
check('discontinuities 为 0（1,2,3 连续）', chGroupA?.discontinuities === 0, `got=${chGroupA?.discontinuities}`)
check('样例含首尾', (chGroupA?.samples?.length ?? 0) >= 2, `got=${chGroupA?.samples?.length}`)

// ---------- ③ 两种编号混排应分成两个家族 ----------
const novelB = [
  '第一章 甲',
  '正'.repeat(250),
  '第二章 乙',
  '正'.repeat(250),
  '一、丙',
  '正'.repeat(250),
  '二、丁',
  '正'.repeat(250)
].join('\n')
const repB = CR.buildStructureReport(novelB)
check('混排识别出 2 个家族', repB.groups.length === 2, JSON.stringify(repB.groups.map((g) => g.family)))
const fams = repB.groups.map((g) => g.family).sort()
check('两个家族分别是「第{n}章」与「{n}、」', fams.includes('第{n}章') && fams.includes('{n}、'), JSON.stringify(fams))

// ---------- ④ 卷 + 章 两级结构 ----------
const novelC = [
  '卷一 起',
  '第一章 甲',
  '正'.repeat(250),
  '第二章 乙',
  '正'.repeat(250),
  '卷二 承',
  '第三章 丙',
  '正'.repeat(250)
].join('\n')
const repC = CR.buildStructureReport(novelC)
const volGroup = repC.groups.find((g) => g.family === '卷{n}')
const chapGroup = repC.groups.find((g) => g.family === '第{n}章')
check('识别出「卷N」家族', !!volGroup, JSON.stringify(repC.groups.map((g) => g.family)))
check('卷家族 kind=volume', volGroup?.kind === 'volume', `got=${volGroup?.kind}`)
check('章家族 kind=chapter', chapGroup?.kind === 'chapter', `got=${chapGroup?.kind}`)
check('章家族 count=3', chapGroup?.count === 3, `got=${chapGroup?.count}`)

// ---------- ⑤ 空章节与异常 ----------
const novelD = ['第一章 甲', '正'.repeat(250), '第二章 乙', '', '第三章 丙', '正'.repeat(250)].join('\n')
const repD = CR.buildStructureReport(novelD)
const gD = repD.groups.find((g) => g.family === '第{n}章')
check('空章节被计入 empty', (gD?.empty ?? 0) >= 1, `got=${gD?.empty}`)
check('anomalies 捕获空章节', (gD?.anomalies?.length ?? 0) >= 1, `got=${gD?.anomalies?.length}`)

// ---------- ⑥ JSON 解析 ----------
const good = JSON.stringify({
  version: 1,
  status: 'ready',
  groups: [
    { groupId: 'g1', role: 'chapter' },
    { groupId: 'g2', role: 'ignore' }
  ],
  volumeTitle: 'sameLine',
  numbering: 'continuous',
  reason: '测试'
})
const p1 = CR.parseRecognitionJson(good)
check('解析合法 JSON', p1?.status === 'ready', JSON.stringify(p1))
check('解析出 2 个组', p1?.groups.length === 2, `got=${p1?.groups.length}`)

const p2 = CR.parseRecognitionJson('```json\n' + good + '\n```')
check('兼容 ```json 包裹', p2?.status === 'ready', '')

const p3 = CR.parseRecognitionJson('前言废话\n' + good + '\n后记废话')
check('兼容前后有解释文字', p3?.status === 'ready', '')

check('version≠1 被拒', CR.parseRecognitionJson(JSON.stringify({ ...JSON.parse(good), version: 2 })) === null, '')
check('非法 status 被拒', CR.parseRecognitionJson(JSON.stringify({ ...JSON.parse(good), status: 'maybe' })) === null, '')
check('非 JSON 被拒', CR.parseRecognitionJson('not json at all') === null, '')
check('空 groups 被拒', CR.parseRecognitionJson(JSON.stringify({ ...JSON.parse(good), groups: [] })) === null, '')
check(
  '非法 role 被过滤',
  (() => {
    const r = CR.parseRecognitionJson(
      JSON.stringify({
        version: 1,
        status: 'ready',
        groups: [{ groupId: 'g1', role: '乱写' }, { groupId: 'g2', role: 'chapter' }],
        volumeTitle: 'sameLine',
        numbering: 'continuous',
        reason: ''
      })
    )
    return r?.groups.length === 1 && r.groups[0].groupId === 'g2'
  })(),
  ''
)
check(
  'uncertain 可解析（由调用方决定是否采纳）',
  (() => {
    const r = CR.parseRecognitionJson(JSON.stringify({ ...JSON.parse(good), status: 'uncertain' }))
    return r?.status === 'uncertain'
  })(),
  ''
)

// ---------- ⑦ 分组一致性（最关键） ----------
// buildStructureReport 的 g1/g2/... 编号必须与 chapter-recognition-llm 的
// pickGroupLines 还原逻辑一致。这里通过源码契约间接验证：两处的家族分类
// 必须产出相同结果（把同一个标题喂给两边）。
const srcCR = (await import('node:fs')).readFileSync(join(root, 'src/main/workspace/chapter-recognition.ts'), 'utf8')
const srcLLM = (await import('node:fs')).readFileSync(
  join(root, 'src/main/workspace/chapter-recognition-llm.ts'),
  'utf8'
)
check('两份实现都按 count 降序排家族', 
  /sort\(\(a, b\) => b\[1\]\.length - a\[1\]\.length\)/.test(srcCR) &&
  /sort\(\(a, b\) => b\[1\]\.length - a\[1\]\.length\)/.test(srcLLM),
  '排序逻辑不一致会导致 groupId 错位'
)
check('两份实现都用 g${gi+1} 编号', 
  /`g\$\{gi \+ 1\}`/.test(srcCR) && /`g\$\{gi \+ 1\}`/.test(srcLLM),
  ''
)
check('LLM 侧有分组一致性警告注释', /分组规则必须与|单点维护|严格一致/.test(srcLLM), '')

// ---------- ⑧ 兜底条件 ----------
const txtImportSrc = (await import('node:fs')).readFileSync(join(root, 'src/main/workspace/txt-import.ts'), 'utf8')
check('只在切出 ≤1 章时兜底', /charChapters\.length <= 1/.test(txtImportSrc), '')
check('兜底失败不中断导入', /兜底失败一律忽略/.test(txtImportSrc), '')
check('兜底结果需 ≥2 章才采纳', /charStarts\.length >= 2/.test(txtImportSrc), '')

// ---------- 报告 ----------
const bar = '─'.repeat(70)
console.log(`\n${bar}\n  章节识别验证（§5 chapter_recognition）\n${bar}`)
for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : '  ← ' + c.detail}`)
console.log(`\n${bar}`)
if (failures.length) {
  console.log(`  ✗ ${failures.length} 项失败 / 共 ${checks.length} 项\n${bar}\n`)
  process.exit(1)
}
console.log(`  ✓ ${checks.length} 项全部通过\n${bar}\n`)

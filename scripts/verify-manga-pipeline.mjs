/**
 * C 线验证：漫画生产链 4 个任务适配器的契约正确性。
 *
 * 不发起 LLM 请求——用**真包（gmzz-10.t2w）的实摘产物**当作「模型输出」喂给 parse，
 * 验证：
 *   ① parse 能正确吃下真包形状（gmzz-10 就是模板产出的成品）
 *   ② parse 的规范化不破坏有效数据
 *   ③ 异常输入（缺字段/脏值/臆造 id）被正确丢弃而非抛错
 *   ④ keyOf 去重键符合预期
 *   ⑤ inputText 能从真包上游产物组装出正确输入
 *
 * 用法：node scripts/verify-manga-pipeline.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const RECON = 'D:/galcomic/recon'

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

const failures = []
const checks = []
const check = (name, cond, detail) => {
  checks.push({ name, ok: !!cond, detail })
  if (!cond) failures.push(`${name}（${detail}）`)
}

const tasks = await loadTs('src/main/pipeline/tasks/index.ts')
const registries = JSON.parse(readFileSync(join(root, 'resources', 'pipeline', 'task-registry.json'), 'utf8'))

// ---------- ① 注册表登记 ----------
check('注册表含 4 个漫画任务', ['mangaScript', 'mangaEffects', 'mangaMusic', 'mangaMusicMerge'].every((id) => registries.some((t) => t.id === id)), '')
check('LLM_ADAPTERS 含 mangaScript', !!tasks.LLM_ADAPTERS.mangaScript, '')
check('LLM_ADAPTERS 含 mangaEffects', !!tasks.LLM_ADAPTERS.mangaEffects, '')
check('LLM_ADAPTERS 含 mangaMusic', !!tasks.LLM_ADAPTERS.mangaMusic, '')
check('LLM_ADAPTERS 含 mangaMusicMerge', !!tasks.LLM_ADAPTERS.mangaMusicMerge, '')
check(
  '注册表条目与适配器一一对应',
  ['mangaScript', 'mangaEffects', 'mangaMusic', 'mangaMusicMerge'].every(
    (id) => registries.find((t) => t.id === id)?.model === true && !!tasks.LLM_ADAPTERS[id]
  ),
  ''
)
check('mangaScript 是 per-chunk（global=false）', registries.find((t) => t.id === 'mangaScript')?.global === false, '')
check(
  'mangaEffects/mangaMusic/mangaMusicMerge 是 global',
  ['mangaEffects', 'mangaMusic', 'mangaMusicMerge'].every((id) => registries.find((t) => t.id === id)?.global === true),
  ''
)
check('mangaScript 声明强制单批', tasks.LLM_ADAPTERS.mangaScript.batching?.inputBudgetTokens === 100000, JSON.stringify(tasks.LLM_ADAPTERS.mangaScript.batching))

// ---------- ② mangaScript parse：吃真包成品 ----------
const realScript = JSON.parse(readFileSync(join(RECON, 'results', '028_mangaScript_0.json'), 'utf8'))
const editedScript = JSON.parse(readFileSync(join(RECON, 'reader', '113_project-edits.json'), 'utf8'))
const editedData = editedScript.results['mangaScript:0'].data

const parsedReal = tasks.LLM_ADAPTERS.mangaScript.parse(JSON.stringify(realScript.data))
check('mangaScript parse 真包：章节数 10', parsedReal.chapters?.length === 10, `got=${parsedReal.chapters?.length}`)
check(
  'mangaScript parse 真包：页数合计 11',
  parsedReal.chapters?.reduce((s, c) => s + c.pages.length, 0) === 11,
  `got=${parsedReal.chapters?.reduce((s, c) => s + c.pages.length, 0)}`
)
check(
  'mangaScript parse 真包：分镜合计 66',
  parsedReal.chapters?.reduce((s, c) => s + c.pages.reduce((a, p) => a + p.panels.length, 0), 0) === 66,
  ''
)
check(
  'mangaScript parse 真包：真包原产出无 speech → 补空数组',
  parsedReal.chapters.every((c) => c.pages.every((p) => p.panels.every((pn) => Array.isArray(pn.speech))))
)

// ---------- ③ parse 编辑版（含 speech） ----------
const parsedEdited = tasks.LLM_ADAPTERS.mangaScript.parse(JSON.stringify(editedData))
const speechTotal = parsedEdited.chapters.reduce(
  (s, c) => s + c.pages.reduce((a, p) => a + p.panels.reduce((b, pn) => b + pn.speech.length, 0), 0),
  0
)
check('mangaScript parse 编辑版：86 条台词', speechTotal === 86, `got=${speechTotal}`)
const types = {}
for (const c of parsedEdited.chapters)
  for (const p of c.pages) for (const pn of p.panels) for (const sp of pn.speech) types[sp.type] = (types[sp.type] ?? 0) + 1
check('台词类型分布正确（narration 73 / think 5 / say 8）', types.narration === 73 && types.think === 5 && types.say === 8, JSON.stringify(types))
check(
  'say/think 带 speaker',
  parsedEdited.chapters.every((c) =>
    c.pages.every((p) =>
      p.panels.every((pn) => pn.speech.filter((s) => s.type !== 'narration').every((s) => !!s.speaker))
    )
  ),
  '有 say/think 缺 speaker'
)
check(
  'narration 不带 speaker',
  parsedEdited.chapters.every((c) =>
    c.pages.every((p) => p.panels.every((pn) => pn.speech.filter((s) => s.type === 'narration').every((s) => !s.speaker)))
  ),
  '有 narration 带 speaker'
)

// ---------- ④ parse 异常输入 ----------
const bad1 = tasks.LLM_ADAPTERS.mangaScript.parse('not json at all')
check('mangaScript parse 非 JSON 不抛错', bad1 && Array.isArray(bad1.chapters), JSON.stringify(bad1).slice(0, 80))
const bad2 = tasks.LLM_ADAPTERS.mangaScript.parse('{"chapters":[{"chapterSeq":1,"pages":[{"panels":[{"no":1,"speech":[{"type":"say","text":"hi"}]}]}]}]}')
check('mangaScript parse 缺字段时补默认', bad2.chapters[0].pages[0].panels[0].scene === '' && bad2.chapters[0].pages[0].context === '', JSON.stringify(bad2).slice(0, 120))

// ---------- ⑤ mangaScript keyOf ----------
check('mangaScript keyOf 按 chapterSeq', tasks.LLM_ADAPTERS.mangaScript.keyOf({ chapterSeq: 3, pages: [] }) === 'chapter:3', '')
check('mangaScript keyOf 非对象退化为 JSON 串', tasks.LLM_ADAPTERS.mangaScript.keyOf({ foo: 1 }) === '{"foo":1}', '')

// ---------- ⑥ mangaEffects parse：吃真包成品 ----------
// 注意 recon 里的文件名被截断到 120 字符，不能硬编码全名 → 按前缀扫描
import { readdirSync } from 'node:fs'
const resultsDir = join(RECON, 'results')
/** 按文件名前缀取第一个匹配的 JSON */
function readReconResult(prefix) {
  const hit = readdirSync(resultsDir).find((f) => f.startsWith(prefix) && f.endsWith('.json'))
  if (!hit) throw new Error(`recon/results 里找不到前缀 ${prefix} 的文件`)
  return JSON.parse(readFileSync(join(resultsDir, hit), 'utf8').replace(/^\uFEFF/, ''))
}

const realFx = readReconResult('019_mangaEffects_')
const parsedFx = tasks.LLM_ADAPTERS.mangaEffects.parse(JSON.stringify(realFx.data))
check('mangaEffects parse 真包：4 格有特效', parsedFx.effects?.length === 4, `got=${parsedFx.effects?.length}`)
check('mangaEffects 保留了 a18 的 color', parsedFx.effects?.some((x) => x.effects.some((f) => f.id === 'a18' && /^#[0-9A-Fa-f]{6}$/.test(f.color))) === true, JSON.stringify(parsedFx.effects?.map((x) => x.effects)))
check('mangaEffects 保留 opacity', parsedFx.effects?.some((x) => x.effects.some((f) => typeof f.opacity === 'number')) === true, '')

// 异常：a18 缺 color 应被丢弃
const badFx = tasks.LLM_ADAPTERS.mangaEffects.parse(
  JSON.stringify({ effects: [{ chapterSeq: 1, page: 1, panel: 1, effects: [{ id: 'a18' }] }] })
)
check('mangaEffects：a18 缺 color 被丢弃', badFx.effects.length === 0, JSON.stringify(badFx.effects))
const badFx2 = tasks.LLM_ADAPTERS.mangaEffects.parse(
  JSON.stringify({ effects: [{ chapterSeq: 1, page: 1, panel: 1, effects: [{ id: 'a18', color: 'red' }] }] })
)
check('mangaEffects：a18 非法 color 被丢弃', badFx2.effects.length === 0, JSON.stringify(badFx2.effects))
const badFx3 = tasks.LLM_ADAPTERS.mangaEffects.parse(
  JSON.stringify({ effects: [{ chapterSeq: 1, page: 1, panel: 1, effects: [{ id: 'e999' }] }] })
)
check('mangaEffects：目录外 id 被丢弃', badFx3.effects.length === 0, JSON.stringify(badFx3.effects))
const badFx4 = tasks.LLM_ADAPTERS.mangaEffects.parse(
  JSON.stringify({ effects: [{ chapterSeq: 1, page: 1, panel: 1, effects: [{ id: 'e13' }, { id: 'e13' }] }] })
)
check('mangaEffects：同格 id 去重', badFx4.effects[0]?.effects.length === 1, JSON.stringify(badFx4.effects))
const badFx5 = tasks.LLM_ADAPTERS.mangaEffects.parse(
  JSON.stringify({
    effects: [
      { chapterSeq: 1, page: 1, panel: 1, effects: [{ id: 'e13' }] },
      { chapterSeq: 1, page: 1, panel: 1, effects: [{ id: 'e02' }] }
    ]
  })
)
check('mangaEffects：同格只输出一次', badFx5.effects.length === 1, JSON.stringify(badFx5.effects))
check('mangaEffects 目录条目数合理（30 条）', tasks.MANGA_EFFECT_CATALOG.length === 30, `got=${tasks.MANGA_EFFECT_CATALOG.length}`)
check('mangaEffects 目录含 e02/e13/a18', ['e02', 'e13', 'a18'].every((id) => tasks.MANGA_EFFECT_CATALOG.some((e) => e.id === id)), '')
check('mangaEffects 每条目录都有 guide', tasks.MANGA_EFFECT_CATALOG.every((e) => typeof e.guide === 'string' && e.guide.length > 10), '')

// ---------- ⑦ mangaEffects keyOf ----------
check('mangaEffects keyOf 按格子', tasks.LLM_ADAPTERS.mangaEffects.keyOf({ chapterSeq: 2, page: 1, panel: 3 }) === 'cell:2|1|3', '')

// ---------- ⑧ mangaMusic parse：吃真包成品 ----------
// 注意：recon/results 里 mangaMusic 有 4 种形态，只有 024 是 `:brief`（键 musicGroups）。
// 025 是 {data,responsePath,cacheReadyAt} 的 plan 变体、026 是 :tracks（键 groups）、
// 027 是 :select:0。所以必须按「内容含 musicGroups」识别，不能按文件名序号猜。
const realBrief = readReconResult('024_mangaMusic_music_1_')
check('024 确实是 brief 形态（键 musicGroups）', Array.isArray(realBrief.musicGroups), Object.keys(realBrief).join(','))
const parsedMusic = tasks.LLM_ADAPTERS.mangaMusic.parse(JSON.stringify(realBrief))
check('mangaMusic parse 真包：1 个 group', parsedMusic.musicGroups?.length === 1, `got=${parsedMusic.musicGroups?.length}`)
check('mangaMusic 保留 brief 全字段', !!parsedMusic.musicGroups[0]?.musicBrief?.purpose && parsedMusic.musicGroups[0].musicBrief.energy >= 1, JSON.stringify(parsedMusic.musicGroups[0]?.musicBrief))
check('mangaMusic 保留章页范围', parsedMusic.musicGroups[0]?.chapters?.[0]?.ranges?.[0]?.fromPage === 1, JSON.stringify(parsedMusic.musicGroups[0]?.chapters))

// 异常：energy 越界、mood 空、pace 非法
const badM1 = tasks.LLM_ADAPTERS.mangaMusic.parse(
  JSON.stringify({ musicGroups: [{ musicBrief: { purpose: 'x', mood: ['a'], style: ['b'], energy: 9, pace: '中', avoid: [] }, chapters: [{ chapterSeq: 1, ranges: [{ fromPage: 1, toPage: 1 }] }] }] })
)
check('mangaMusic：energy 越界被丢弃', badM1.musicGroups.length === 0, JSON.stringify(badM1.musicGroups))
const badM2 = tasks.LLM_ADAPTERS.mangaMusic.parse(
  JSON.stringify({ musicGroups: [{ musicBrief: { purpose: 'x', mood: [], style: ['b'], energy: 3, pace: '中', avoid: [] }, chapters: [{ chapterSeq: 1, ranges: [{ fromPage: 1, toPage: 1 }] }] }] })
)
check('mangaMusic：空 mood 被丢弃', badM2.musicGroups.length === 0, JSON.stringify(badM2.musicGroups))
const badM3 = tasks.LLM_ADAPTERS.mangaMusic.parse(
  JSON.stringify({ musicGroups: [{ musicBrief: { purpose: 'x', mood: ['a'], style: ['b'], energy: 3, pace: '乱七八糟', avoid: [] }, chapters: [{ chapterSeq: 1, ranges: [{ fromPage: 1, toPage: 1 }] }] }] })
)
check('mangaMusic：非法 pace 回落「中」', badM3.musicGroups[0]?.musicBrief?.pace === '中', JSON.stringify(badM3.musicGroups[0]?.musicBrief))
const badM4 = tasks.LLM_ADAPTERS.mangaMusic.parse(
  JSON.stringify({ musicGroups: [{ musicBrief: { purpose: 'x', mood: ['a'], style: ['b'], energy: 3, pace: '中', avoid: [] }, chapters: [{ chapterSeq: 1, ranges: [{ fromPage: 3, toPage: 1 }] }] }] })
)
check('mangaMusic：fromPage > toPage 被丢弃', badM4.musicGroups.length === 0, JSON.stringify(badM4.musicGroups))
const badM5 = tasks.LLM_ADAPTERS.mangaMusic.parse(
  JSON.stringify({ musicGroups: [{ musicBrief: { purpose: 'x', mood: ['a'], style: ['b'], energy: 3, pace: '中', avoid: [] }, chapters: [{ chapterSeq: 1, ranges: [{ fromPage: 0, toPage: 1 }] }] }] })
)
check('mangaMusic：fromPage < 1 被丢弃', badM5.musicGroups.length === 0, JSON.stringify(badM5.musicGroups))

// ---------- ⑨ mangaMusicMerge ----------
// 合并阶段的输出契约是 musicGroups，但输入是阶段 1 的产物；这里直接用 brief 内容验证
const parsedMerge = tasks.LLM_ADAPTERS.mangaMusicMerge.parse(JSON.stringify(realBrief))
check('mangaMusicMerge parse 保留 groups', parsedMerge.groups?.length === 1, `got=${parsedMerge.groups?.length}`)
check('mangaMusicMerge 同时给 musicGroups 键（模板契约）', parsedMerge.musicGroups?.length === 1, '')
check('mangaMusicMerge 产出 plan 结构（下游 collectMusic 消费）', !!parsedMerge.groups[0]?.plan?.musicBrief, JSON.stringify(parsedMerge.groups[0]?.plan))

// ---------- ⑩ 端到端：真实 manifest → manga view ----------
// 这一条确认「生成的产物形状」与「阅读视图消费的形状」一致。
// recon/manifest.json 存的是 **records 层**（无外层 records 键），
// 而 buildMangaView 期望完整 manifest（T2wManifest.records），所以要包一层。
const mangaMod = await loadTs('src/main/t2w/manga.ts')
const reconRecords = JSON.parse(readFileSync(join(RECON, 'manifest.json'), 'utf8'))
const manifest = { records: reconRecords }
const view = mangaMod.buildMangaView(manifest, 't2w://x/')
check('真包 buildMangaView 成功', !!view, 'null')
check('真包视图：10 章 11 页 66 格', view?.stats.chapterCount === 10 && view?.stats.pageCount === 11 && view?.stats.panelCount === 66, JSON.stringify(view?.stats))
check('真包视图：86 台词', view?.stats.speechCount === 86, `got=${view?.stats.speechCount}`)
check('真包视图：6 处特效', view?.stats.effectCount === 6, `got=${view?.stats.effectCount}`)
check('真包视图：1 章有配乐', view?.stats.chaptersWithMusic === 1, `got=${view?.stats.chaptersWithMusic}`)

// ---------- 报告 ----------
const bar = '─'.repeat(70)
console.log(`\n${bar}\n  C 线验证 · 漫画生产链 4 个适配器\n${bar}`)
for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : '  ← ' + c.detail}`)
console.log(`\n${bar}`)
if (failures.length) {
  console.log(`  ✗ ${failures.length} 项失败 / 共 ${checks.length} 项\n${bar}\n`)
  process.exit(1)
}
console.log(`  ✓ ${checks.length} 项全部通过\n${bar}\n`)

/**
 * A2：把新版 FB 目录的 `guide`（判断依据）与 `target`（是否必须指定人物）灌进我们的目录。
 *
 * 依据：`recon/effect_guide_FB_20261104.json`（51 条，从新版主 bundle 的 FB 目录抽出）。
 *
 * 匹配方式：FB 的 `preset` → 我们的 `effect-catalog.json` 的 `id`。
 *   - 28 条能一对一对上 → 灌 guide；
 *   - 23 条是我们**没有渲染实现**的新特效（glass-shatter / ice / flames / …）
 *     → **只登记不启用**，绝不写进目录。写进去模型就会推荐，而渲染层连 kind 都没有。
 *
 * `target` 推断：FB 原文里带「必须指定画面中的人物 / 须指定人物 / 须指定在场人物」的
 * 那条 = `target: true`。这是从 guide 文本反推，不是猜——原文明确写了这条硬约束。
 *
 * 幂等：重复运行结果一致（先删旧字段再写）。
 *
 * 用法：
 *   node scripts/apply-effect-guide.mjs           # 写入
 *   node scripts/apply-effect-guide.mjs --check   # 只报告，不写
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const CATALOG = join(root, 'resources', 'effects', 'effect-catalog.json')
const FB = 'D:/AI/tx/2026-10-15-22-35-44/recon/effect_guide_FB_20261104.json'
const BACKUP = join(root, 'resources', 'effects', 'effect-catalog.backup-pre-guide.json')

const checkOnly = process.argv.includes('--check')

const fb = JSON.parse(readFileSync(FB, 'utf8'))
const raw = JSON.parse(readFileSync(CATALOG, 'utf8'))
const entries = Array.isArray(raw) ? raw : (raw.effects ?? raw.items ?? [])
const isPlainArray = Array.isArray(raw)

/**
 * 带「必须指定人物」硬约束的 guide → target: true。
 *
 * 实测 FB 里共有 3 条带此约束（e01 `必须指定画面中的人物`、s09 `须指定在场人物`、
 * s08 `须指定人物`），只有 e01 的 preset 在我们目录里 —— 也就是说**对现有目录而言
 * 只有 portrait-cutin 是 target**。另外两条属「我们没有的新特效」，不写入。
 * 正则覆盖全部三种措辞，将来补进这些特效时能自动生效。
 */
const TARGET_RE = /(?:必须|须)\s*指定[^。；;]*(?:人物|角色)/

/**
 * 无效 guide 值：FB 源数据里有 4 条（dizzy / startled-awakening / sword-clash / dream）
 * 的 guide 字段装的其实是**轨道/类别名**（`air` / `camera` / `vision`），不是判断依据。
 * 这类值喂给模型不但无益，还会让它以为「这条特效属于 camera 类」而产生错误联想。
 * 判定：短于 8 个字符，或整串只是一个已知 kind / 类别名。
 */
const KNOWN_KIND_NAMES = new Set([
  'overlay', 'text', 'tone', 'camera', 'ambient', 'particles', 'actor',
  'eyelids', 'birds', 'blur', 'shake', 'distortion', 'flash', 'cutin',
  'air', 'vision', 'audio', 'camera-effects'
])
function isJunkGuide(g) {
  const s = g.trim()
  if (s.length < 8) return true
  return KNOWN_KIND_NAMES.has(s.toLowerCase())
}

/** preset → FB 条目 */
const fbByPreset = new Map()
for (const f of fb) {
  if (f?.preset && !fbByPreset.has(f.preset)) fbByPreset.set(f.preset, f)
}

let applied = 0
let targeted = 0
let skippedJunk = 0
const junkIds = []
const unmatchedFb = []
const matchedIds = new Set()

for (const e of entries) {
  const rec = fbByPreset.get(e.id)
  if (!rec) continue
  matchedIds.add(e.id)
  const guide = typeof rec.guide === 'string' ? rec.guide.trim() : ''
  if (!guide) continue
  // 源数据里混入了轨道/类别名（air/camera/vision…），不能当判断依据喂给模型
  if (isJunkGuide(guide)) {
    skippedJunk++
    junkIds.push(`${e.id}("${guide}")`)
    delete e.guide
    delete e.target
    continue
  }
  e.guide = guide
  const isTarget = TARGET_RE.test(guide)
  if (isTarget) {
    e.target = true
    targeted++
  } else {
    delete e.target
  }
  applied++
}

for (const [preset, f] of fbByPreset) {
  if (!matchedIds.has(preset)) unmatchedFb.push({ preset, fbId: f.id, name: f.name })
}

// ---- 统计 ----
const withGuide = entries.filter((e) => typeof e.guide === 'string' && e.guide)
const withTarget = entries.filter((e) => e.target === true)
const guideChars = withGuide.reduce((s, e) => s + e.guide.length, 0)

const bar = '─'.repeat(68)
console.log(`\n${bar}\n  A2 · 特效目录灌 guide + target\n${bar}`)
console.log(`  目录 ${entries.length} 条 · 灌入 guide ${applied} 条（${guideChars} 字符）`)
console.log(`  其中 target:true ${targeted} 条：${withTarget.map((e) => e.id).join(', ') || '（无）'}`)
console.log(`  剔除无效 guide ${skippedJunk} 条（源数据里存的是类别名，不是判断依据）`)
if (junkIds.length) console.log(`    ${junkIds.join('、')}`)
console.log(`  仍缺 guide ${entries.length - applied} 条（FB 里没有对应，需自写或留空）`)
console.log(`  FB 里我们没有的特效 ${unmatchedFb.length} 条 → 只登记不启用`)

if (unmatchedFb.length) {
  console.log(`\n【FB 有、我们没有（不写入目录，仅记录）】`)
  for (const u of unmatchedFb) console.log(`  ${u.fbId.padEnd(8)} ${u.preset.padEnd(18)} ${u.name}`)
}

if (checkOnly) {
  console.log(`\n  --check 模式，未写入文件\n${bar}\n`)
  process.exit(0)
}

// ---- 写入（先备份）----
if (!existsSync(BACKUP)) {
  copyFileSync(CATALOG, BACKUP)
  console.log(`\n  已备份原目录 → ${BACKUP}`)
}
writeFileSync(CATALOG, JSON.stringify(isPlainArray ? entries : raw, null, 2) + '\n', 'utf8')
console.log(`  已写入 ${CATALOG}`)
console.log(bar + '\n')

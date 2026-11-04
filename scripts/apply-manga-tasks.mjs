/**
 * 把漫画生产链的 3 个任务定义加进 task-registry.json（幂等）。
 *
 * 为什么用脚本而不是手改 JSON：注册表 29 条、每条 10+ 字段，
 * 手工插入容易破坏缩进/顺序；脚本可重复运行且能断言「已存在则跳过」。
 *
 * 三个任务：
 *   mangaScript     per-chunk，漫画分镜脚本（产出 chapters/pages/panels/speech）
 *   mangaEffects    global，漫画特效标注（整份脚本一次，按 page+panel 定位）
 *   mangaMusic      global，配乐需求规划（产出 musicGroups）
 *   mangaMusicMerge global，配乐需求合并（把相邻相近的 groups 合并）
 *
 * 依赖链（对齐 gmzz-10.t2w 的 parsePlan 与任务表实测）：
 *   mangaScript   ← cacheWarming:i, draftAlign:i, memoryBefore:i, worldImpression, characterAppearance
 *   mangaEffects  ← mangaScript:*
 *   mangaMusic    ← mangaScript:*
 *   mangaMusicMerge ← mangaMusic:*
 *
 * 用法：
 *   node scripts/apply-manga-tasks.mjs           # 写入
 *   node scripts/apply-manga-tasks.mjs --check   # 只报告
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const REG = join(root, 'resources', 'pipeline', 'task-registry.json')
const BACKUP = join(root, 'resources', 'pipeline', 'task-registry.backup-pre-manga.json')

const checkOnly = process.argv.includes('--check')

const raw = readFileSync(REG, 'utf8')
const arr = JSON.parse(raw)
if (!Array.isArray(arr)) {
  console.error('✗ task-registry.json 不是数组，拒绝继续')
  process.exit(1)
}

/** 新增任务定义（字段集与既有 29 条保持一致风格） */
const MANGA_TASKS = [
  {
    id: 'mangaScript',
    kind: 'mangaScript',
    code: 'MangaScript',
    label: '漫画脚本',
    feature: 'manga',
    execution: '并行',
    input: '原文、世界印象、人物与可用形象、阅读记忆',
    output: '漫画页脚本（章/页/分镜/台词）',
    model: true,
    thinking: 'disabled',
    effort: 2,
    maxTokens: 120000,
    global: false,
    setting: 'mangaScript',
    dependsOn: [
      'cacheWarming:i',
      'draftAlign:i',
      'memoryBefore:i',
      'worldImpression',
      'characterAppearance'
    ]
  },
  {
    id: 'mangaEffects',
    kind: 'mangaEffects',
    code: 'MangaEffects',
    label: '漫画特效',
    feature: 'manga',
    execution: '全书一次',
    input: '完整漫画脚本',
    output: '逐格屏幕特效（chapterSeq/page/panel → effects[]）',
    model: true,
    thinking: 'disabled',
    effort: 2,
    maxTokens: 60000,
    global: true,
    setting: 'mangaEffects',
    dependsOn: ['mangaScript:*']
  },
  {
    id: 'mangaMusic',
    kind: 'mangaMusic',
    code: 'MangaMusic',
    label: '漫画配乐需求',
    feature: 'manga',
    execution: '全书一次',
    input: '完整漫画脚本',
    output: '配乐需求分组（musicBrief + 章页范围）',
    model: true,
    thinking: 'disabled',
    effort: 2,
    maxTokens: 40000,
    global: true,
    setting: 'mangaMusic',
    dependsOn: ['mangaScript:*']
  },
  {
    id: 'mangaMusicMerge',
    kind: 'mangaMusicMerge',
    code: 'MangaMusicMerge',
    label: '漫画配乐需求合并',
    feature: 'manga',
    execution: '全书一次',
    input: '全部配乐需求分组',
    output: '合并后的配乐需求分组',
    model: true,
    thinking: 'disabled',
    effort: 1,
    maxTokens: 30000,
    global: true,
    setting: 'mangaMusicMerge',
    dependsOn: ['mangaMusic']
  }
]

const existing = new Set(arr.map((t) => t?.id))
let added = 0
const skipped = []
for (const t of MANGA_TASKS) {
  if (existing.has(t.id)) {
    skipped.push(t.id)
    continue
  }
  arr.push(t)
  added++
}

const bar = '─'.repeat(72)
console.log(`\n${bar}\n  C 线 · 漫画任务入注册表\n${bar}`)
console.log(`  注册表原有 ${existing.size} 条 → 新增 ${added} 条 → 共 ${arr.length} 条`)
if (skipped.length) console.log(`  已存在跳过：${skipped.join(', ')}`)
console.log(`\n【新增任务】`)
for (const t of MANGA_TASKS) {
  console.log(`  ${t.id.padEnd(16)} ${t.label.padEnd(14)} ${t.global ? '全书一次' : '并行'}  依赖: ${t.dependsOn.join(', ')}`)
}

if (checkOnly) {
  console.log(`\n  --check 模式，未写入\n${bar}\n`)
  process.exit(0)
}

if (added === 0) {
  console.log(`\n  无需变更\n${bar}\n`)
  process.exit(0)
}

if (!existsSync(BACKUP)) {
  copyFileSync(REG, BACKUP)
  console.log(`\n  已备份 → ${BACKUP}`)
}
writeFileSync(REG, JSON.stringify(arr, null, 2) + '\n', 'utf8')
console.log(`  已写入 ${REG}`)
console.log(bar + '\n')

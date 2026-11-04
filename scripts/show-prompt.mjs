/**
 * 打印真实角色/场景的**最终生图提示词**（与 ComfyUI 收到的完全一致）。
 *
 * 用途：改提示词模板时先看效果，不用真的跑一次 ComfyUI。
 * 走的是真实 `readImagegenTargets` + 真实 `renderCharPrompt/renderScenePrompt`，
 * 不是复制品 —— 所以看到的就是线上会发出去的文本。
 *
 * 用法：
 *   node scripts/show-prompt.mjs                     # 默认第一个角色，anime 画风
 *   node scripts/show-prompt.mjs --char 2            # 第 2 个角色
 *   node scripts/show-prompt.mjs --scene 1           # 第 1 个场景
 *   node scripts/show-prompt.mjs --preset realistic  # 真人画风
 *   node scripts/show-prompt.mjs --custom "你的画风"  # 自定义画风
 *   node scripts/show-prompt.mjs --list              # 列出有哪些目标
 *
 * 前置：需要一个已导入的工作库。默认读 %APPDATA%/DreamWeave-data 下的第一个库；
 * 也可用 --root <工作库绝对路径> 指定。
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
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
  // 关键：require 必须指向真实的 node require，否则打包进来的
  // `node:path` / `node:fs` 等 external 模块会解析失败（bundle 里是 `require("node:path")`）
  const { createRequire } = await import('node:module')
  const nodeRequire = createRequire(import.meta.url)
  new Function('module', 'exports', 'require', code)(mod, mod.exports, nodeRequire)
  return mod.exports
}

const argv = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : dflt
}
const wantChar = Number(argOf('--char', '0'))
const wantScene = Number(argOf('--scene', '-1'))
const preset = argOf('--preset', 'anime')
const custom = argOf('--custom', '')
const listOnly = argv.includes('--list')

// ---- 定位工作库 ----
async function findWorkspace() {
  const explicit = argOf('--root', '')
  if (explicit) return explicit
  const base = join(homedir(), 'AppData', 'Roaming', 'DreamWeave-data', 'workspaces')
  if (!existsSync(base)) {
    throw new Error(`找不到工作库根目录：${base}\n请先用应用导入一个 .t2w，或用 --root 指定`)
  }
  const dirs = readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(base, d.name))
  // 选最近修改的那个（通常是刚导入的）
  const withIdx = dirs.filter((d) => existsSync(join(d, 'index.json')))
  if (!withIdx.length) throw new Error(`${base} 下没有工作库`)
  withIdx.sort((a, b) => {
    const ta = readFileSync(join(a, 'index.json'), 'utf8')
    const tb = readFileSync(join(b, 'index.json'), 'utf8')
    return tb.length - ta.length // 粗糙但够用：内容多的更新
  })
  return withIdx[0]
}

const dataMod = await loadTs('src/main/imagegen/data.ts')
const promptsMod = await loadTs('src/main/imagegen/prompts.ts')
const defaults = await loadTs('src/shared/imagegen-defaults.ts')

const wsRoot = await findWorkspace()
const targets = await dataMod.readImagegenTargets(wsRoot)

if (listOnly) {
  console.log(`\n工作库：${wsRoot}\n`)
  console.log(`人物形象（${targets.chars.length}）：`)
  targets.chars.forEach((c, i) => {
    console.log(`  [${i}] ${c.charName} / ${c.appearanceName}  已有图=${c.hasImage}`)
  })
  console.log(`\n场景（${targets.scenes.length}）：`)
  targets.scenes.forEach((s, i) => {
    console.log(`  [${i}] ${s.name}  已有图=${s.hasImage}`)
  })
  console.log(`\n上下文：novelGenre="${targets.context.novelGenre}"`)
  console.log(`  worldImpression 长度=${targets.context.worldImpression.length}`)
  console.log(`  charArtStyle 长度=${(targets.context.charArtStyle ?? '').length}`)
  console.log(`  sceneArtStyle 长度=${(targets.context.sceneArtStyle ?? '').length}`)
  process.exit(0)
}

const bar = '─'.repeat(78)

if (wantScene >= 0) {
  const t = targets.scenes[wantScene]
  if (!t) {
    console.error(`✗ 没有第 ${wantScene} 个场景（共 ${targets.scenes.length} 个）`)
    process.exit(1)
  }
  const text = promptsMod.renderScenePrompt(
    t,
    targets.context,
    undefined,
    preset === 'realistic' ? 'anime' : preset,
    custom
  )
  console.log(`\n${bar}\n  场景提示词 · ${t.name}\n${bar}`)
  console.log(text)
  console.log(`\n${bar}\n  长度 ${text.length} 字符\n${bar}\n`)
} else {
  const t = targets.chars[wantChar]
  if (!t) {
    console.error(`✗ 没有第 ${wantChar} 个角色（共 ${targets.chars.length} 个）`)
    process.exit(1)
  }
  const text = promptsMod.renderCharPrompt(t, targets.context, undefined, preset, custom)
  console.log(`\n${bar}\n  人物提示词 · ${t.charName}（${t.appearanceName}）· 画风 ${preset}\n${bar}`)
  console.log(text)
  console.log(`\n${bar}\n  长度 ${text.length} 字符\n${bar}\n`)
}

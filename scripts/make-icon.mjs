/**
 * 把 build/icon.svg 光栅化成多尺寸 PNG，并合成 Windows 用的 .ico。
 *
 * 【两份 SVG，按尺寸切换】
 *   - build/icon.svg        细节版（≥48px 用）：四经四纬一上一下的提花编织
 *   - build/icon-small.svg  简化版（<48px 用）：三条粗带 + 加粗星芒
 * 小尺寸用细节版会糊成一坨深斑（实测 32px 完全看不出编织），
 * 所以必须按尺寸换图 —— 这是做图标的标准做法，不是妥协。
 *
 * 【为什么用 @resvg/resvg-js 而不是 Electron 离屏渲染】
 * 先试过 Electron：`offscreen: true` 会卡死；改可见窗口 + `capturePage()` 也拿不到像素
 * （返回 0 字节、size 为 0x0，本机实测稳定复现）。这条路不可靠，及时换掉。
 * resvg 是**纯构建期**依赖，只在这里用，不进运行期 bundle ——
 * 不影响「运行期零依赖」这条原则。
 *
 * 【为什么自己拼 ico 而不是让 electron-builder 自动转】
 * Windows 图标需要多档尺寸：标题栏 16、任务栏 32、资源管理器大图标 256。
 * 只给一张 256 让它自动缩，小尺寸会被系统粗暴降采样。
 * ico 容器结构极简单（6 字节头 + 每张 16 字节目录项 + PNG 数据），手写即可。
 *
 * 用法：node scripts/make-icon.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

const ROOT = process.cwd()
const OUT_DIR = join(ROOT, 'build')

/** 尺寸 → 用哪份 SVG。阈值 48 是实测的：48 用细节版还能看出交错，32 已经不行 */
const SIZES = [16, 24, 32, 48, 64, 128, 256]
const DETAIL_MIN = 48

/** ICO 容器：6 字节头 + 每张 16 字节目录项 + 各图 PNG 数据（Vista+ 支持目录项直接放 PNG） */
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(entries.length, 4)

  const dirs = []
  let offset = 6 + entries.length * 16
  for (const e of entries) {
    const d = Buffer.alloc(16)
    // 256 在 ico 目录项里记作 0（字段只有 1 字节）
    d[0] = e.size >= 256 ? 0 : e.size
    d[1] = e.size >= 256 ? 0 : e.size
    d[2] = 0 // 调色板数
    d[3] = 0 // reserved
    d.writeUInt16LE(1, 4) // color planes
    d.writeUInt16LE(32, 6) // bpp
    d.writeUInt32LE(e.png.length, 8)
    d.writeUInt32LE(offset, 12)
    offset += e.png.length
    dirs.push(d)
  }
  return Buffer.concat([header, ...dirs, ...entries.map((e) => e.png)])
}

const svgDetail = await readFile(join(OUT_DIR, 'icon.svg'), 'utf8')
const svgSmall = await readFile(join(OUT_DIR, 'icon-small.svg'), 'utf8')
await mkdir(OUT_DIR, { recursive: true })

const rendered = []
for (const size of SIZES) {
  const src = size >= DETAIL_MIN ? svgDetail : svgSmall
  const resvg = new Resvg(src, {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0,0,0,0)'
  })
  const png = resvg.render().asPng()
  rendered.push({ size, png })
  await writeFile(join(OUT_DIR, `icon-${size}.png`), png)
  console.log(`  ${String(size).padStart(3)}x${String(size).padEnd(3)}  ${png.length} 字节  ${size >= DETAIL_MIN ? '细节版' : '简化版'}`)
}

// electron-builder 认 build/icon.png 作源图
const big = rendered.find((r) => r.size === 256)
if (big) await writeFile(join(OUT_DIR, 'icon.png'), big.png)

const ico = buildIco(rendered)
await writeFile(join(OUT_DIR, 'icon.ico'), ico)

console.log(`\n已生成：`)
console.log(`  build/icon.ico    ${ico.length} 字节（${rendered.length} 档尺寸）`)
console.log(`  build/icon.png    256x256`)
console.log(`  build/icon-*.png  各尺寸单图`)

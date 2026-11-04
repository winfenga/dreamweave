/**
 * birds 处理器：鸟群飞过（海鸥 / 乌鸦 / 远处鸟群，3 条 4 轨）。
 *
 * 参数：`variant`（gull | crow）、`count`、`size`（相对缩放）、`at`、`duration`。
 *
 * 形态：用 CSS 画出「会扇翅的鸟」——两个相邻的弧形翼片，通过 `scaleY` 往复形成扑翼感。
 * 不加载图片资源：包内通常没有鸟的贴图，且这类装饰性元素画得越简单越不容易出画风问题。
 *
 * 路径：从画面一侧外进入，横向掠过，从另一侧离开。`crow` 走低空慢速（乌鸦盘旋感），
 * `gull` 走高一点、快一点（海鸥掠过感）。
 */
import type { EffectTrack, TrackContext, TrackHandler, TrackInstance } from '../../../../../shared/effects-types'

const VARIANTS = new Set(['gull', 'crow'])
const MAX_COUNT = 24

function num(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

const handler: TrackHandler = {
  kind: 'birds',
  start(track: EffectTrack, ctx: TrackContext): TrackInstance | null {
    const variant = typeof track.variant === 'string' && track.variant ? track.variant : 'gull'
    if (!VARIANTS.has(variant)) return null

    const count = Math.min(MAX_COUNT, Math.max(1, Math.round(num(track.count, 2))))
    const size = Math.max(0.1, Math.min(3, num(track.size, 1)))
    const durMs = Math.max(300, (Number(track.duration) || 0) * 1000)
    // 鸟群整体从右往左飞；每只错开出发时间与高度
    const flyMs = Math.max(1500, durMs * 0.9)

    const root = document.createElement('div')
    root.className = `fx-birds fx-birds--${variant}`
    root.setAttribute('data-testid', 'fx-birds')
    root.setAttribute('data-variant', variant)
    root.style.setProperty('--fx-bird-size', String(size))

    for (let i = 0; i < count; i++) {
      const bird = document.createElement('div')
      bird.className = 'fx-bird'
      // 高度：gull 偏上（10%~45%），crow 偏低（15%~65%）
      const topRange = variant === 'gull' ? 35 : 50
      const topBase = variant === 'gull' ? 10 : 15
      bird.style.top = `${(topBase + rand(i * 4.1 + 1) * topRange).toFixed(1)}%`
      bird.style.animationDelay = `${Math.round(rand(i * 9.3 + 2) * flyMs * 0.45)}ms`
      bird.style.animationDuration = `${Math.round(flyMs * (0.75 + rand(i * 3.7 + 3) * 0.5))}ms`
      // 个体大小差异
      bird.style.setProperty('--fx-bird-scale', String(0.7 + rand(i * 6.1 + 4) * 0.7))
      // 扑翼频率
      const flap = variant === 'gull' ? 620 : 880
      bird.style.setProperty('--fx-flap-dur', `${Math.round(flap * (0.85 + rand(i * 2.3 + 5) * 0.3))}ms`)

      const wingL = document.createElement('span')
      wingL.className = 'fx-bird-wing fx-bird-wing-l'
      const wingR = document.createElement('span')
      wingR.className = 'fx-bird-wing fx-bird-wing-r'
      bird.appendChild(wingL)
      bird.appendChild(wingR)
      root.appendChild(bird)
    }

    try {
      ctx.overlay.appendChild(root)
    } catch {
      return null
    }

    let stopped = false
    return {
      stop(): void {
        if (stopped) return
        stopped = true
        try {
          root.remove()
        } catch {
          // 忽略清理失败
        }
      }
    }
  }
}

export default handler

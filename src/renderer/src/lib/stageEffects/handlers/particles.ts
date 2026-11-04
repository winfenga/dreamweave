/**
 * particles 处理器：天气粒子（雨 / 雪，7 条）。
 *
 * 参数：`variant`（rain | snow）、`count`、`wind`（水平漂移强度）、`size`、`opacity`。
 *
 * 与 ambient 的差异（为什么单独一个 handler 而不是合并）：
 *   - particles 是**全屏覆盖**的天气层，粒子从画面顶部持续落到画面外，是单向循环；
 *   - ambient 是**局部氛围**，粒子有各自的起点与缓慢漂移。
 *   两者的 CSS 动画模型不同，强行合并会让两边参数语义互相污染。
 *
 * 性能：雨最多 600 颗（暴雨）。同样走纯 CSS，每颗一个 `<i>`；
 * 600 个空元素在 Chromium 里是合成器友好的（无布局重排，只有 transform 动画）。
 */
import type { EffectTrack, TrackContext, TrackHandler, TrackInstance } from '../../../../../shared/effects-types'

const VARIANTS = new Set(['rain', 'snow'])
const MAX_COUNT = 700

function num(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

const handler: TrackHandler = {
  kind: 'particles',
  start(track: EffectTrack, ctx: TrackContext): TrackInstance | null {
    const variant = typeof track.variant === 'string' && track.variant ? track.variant : 'rain'
    if (!VARIANTS.has(variant)) return null

    const count = Math.min(MAX_COUNT, Math.max(1, Math.round(num(track.count, 120))))
    const wind = Math.max(0, Math.min(3, num(track.wind, 0.6)))
    const size = Math.max(0.3, Math.min(4, num(track.size, 1)))
    const opacity = Math.max(0, Math.min(1, num(track.opacity, 0.85)))
    const durMs = Math.max(200, (Number(track.duration) || 0) * 1000)

    const root = document.createElement('div')
    root.className = `fx-particles fx-particles--${variant}`
    root.setAttribute('data-testid', 'fx-particles')
    root.setAttribute('data-variant', variant)
    root.style.setProperty('--fx-p-opacity', String(opacity))
    root.style.setProperty('--fx-p-size', String(size))
    // 风：用 CSS 变量控制水平位移量，雨/雪各自的 keyframes 消费它
    root.style.setProperty('--fx-p-wind', String(wind * 100))

    for (let i = 0; i < count; i++) {
      const p = document.createElement('i')
      p.style.left = `${(rand(i * 3.7 + 1) * 100).toFixed(2)}%`
      // 起始点向下错开一整个屏幕高度，形成"已经在下"的初始态
      p.style.animationDelay = `-${Math.round(rand(i * 7.1 + 2) * durMs)}ms`
      // 雨快雪慢：由 CSS 里的 base duration 决定，这里只加个体差异
      p.style.animationDuration = `${Math.round(durMs * (0.55 + rand(i * 5.3 + 3) * 0.7))}ms`
      p.style.setProperty('--fx-p-scale', String(0.7 + rand(i * 2.9 + 4) * 0.6))
      root.appendChild(p)
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

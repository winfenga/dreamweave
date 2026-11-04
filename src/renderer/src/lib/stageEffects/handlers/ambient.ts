/**
 * ambient 处理器：环境氛围粒子（12 条：雾/风/花瓣/落叶/蝴蝶/萤火虫/火星/尘土/烟/气泡/光束/梦境）。
 *
 * 参数：`variant`（决定粒子形态与运动）、`count`、`size`、`opacity`、`duration`。
 *
 * 实现：**纯 CSS 粒子**——生成 N 个 `<i>`，每个用内联 style 给出随机起点、
 * 延迟、时长，形态与运动方向交给 CSS 类（`.fx-ambient--<variant> i`）。
 * 理由：粒子数量最多到 160（火星），用 JS 每帧更新 160 个 transform 会明显掉帧；
 * 交给 CSS 合成层则是 GPU 侧完成，且 handler.stop() 只需移除一个节点。
 *
 * 粒子是**装饰性**的：`count` 上限做钳制，避免恶意/错误数据把 DOM 撑爆。
 */
import type { EffectTrack, TrackContext, TrackHandler, TrackInstance } from '../../../../../shared/effects-types'

/** 已支持（有对应 CSS）的 variant */
const VARIANTS = new Set([
  'fog',
  'wind',
  'petals',
  'leaves',
  'butterflies',
  'fireflies',
  'embers',
  'dust',
  'smoke',
  'bubbles',
  'rays'
])

/** 粒子数上限：目录最大 160，留余量但不允许无限 */
const MAX_COUNT = 220

function num(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** 稳定伪随机：同一 seed 每次渲染一致，避免画面在重播时乱跳 */
function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

const handler: TrackHandler = {
  kind: 'ambient',
  start(track: EffectTrack, ctx: TrackContext): TrackInstance | null {
    const variant = typeof track.variant === 'string' && track.variant ? track.variant : 'fog'
    const cls = VARIANTS.has(variant) ? variant : null
    if (!cls) return null

    const count = Math.min(MAX_COUNT, Math.max(1, Math.round(num(track.count, 24))))
    const size = Math.max(0.2, Math.min(6, num(track.size, 1)))
    const opacity = Math.max(0, Math.min(1, num(track.opacity, 0.7)))
    const durMs = Math.max(200, (Number(track.duration) || 0) * 1000)
    // 粒子循环周期：比整体时长略长，保证动画播完前不重复得太明显
    const cycleMs = Math.max(2000, durMs)

    const root = document.createElement('div')
    root.className = `fx-ambient fx-ambient--${variant}`
    root.setAttribute('data-testid', 'fx-ambient')
    root.setAttribute('data-variant', variant)
    root.style.setProperty('--fx-ambient-opacity', String(opacity))
    root.style.setProperty('--fx-ambient-size', String(size))

    for (let i = 0; i < count; i++) {
      const p = document.createElement('i')
      // 起点分散在画面内；x 全宽，y 全高（不同 variant 由 CSS 决定是否复写）
      p.style.left = `${(rand(i * 3.1 + 1) * 100).toFixed(2)}%`
      p.style.top = `${(rand(i * 7.3 + 2) * 100).toFixed(2)}%`
      // 每颗粒子错峰启动（最多错开半个周期），避免"同时出发"的机械感
      p.style.animationDelay = `${Math.round(rand(i * 11.7 + 3) * cycleMs * 0.5)}ms`
      p.style.animationDuration = `${Math.round(cycleMs * (0.6 + rand(i * 5.9 + 4) * 0.8))}ms`
      // 个体尺寸微扰（±35%）
      p.style.setProperty('--fx-p-size', String(0.65 + rand(i * 2.3 + 5) * 0.7))
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

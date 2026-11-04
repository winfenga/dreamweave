/**
 * distortion 处理器：画面扭曲（热浪 / 眩晕）。
 *
 * 目录参数只有一个 `strength`（像素级扭曲幅度），语义是「持续期间画面在波动」。
 *
 * 实现上的取舍：真正的折射扭曲需要 SVG filter + feTurbulence（性能风险大，且与
 * `.stage-bg` 已有的 filter 链会在某些驱动上互相干扰）。这里用**高频小幅度
 * scale + skew 抖动**近似热浪的视觉——在暖色场景下效果足够，且完全走现有合成通道。
 *
 * 注意它与 `shake` 的区别：shake 是整块平移（有方向感），distortion 是形变
 * （画面本身在"融化"），所以这里用 `camera` 通道的 scale/angle 组合，
 * 幅度很小但频率更高。
 */
import type { EffectTrack, TrackContext, TrackHandler, TrackInstance } from '../../../../../shared/effects-types'

function num(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

const handler: TrackHandler = {
  kind: 'distortion',
  start(track: EffectTrack, ctx: TrackContext): TrackInstance | null {
    // strength 在目录里是 12~18 这种像素量级；换算成相对形变幅度（0.004 ~ 0.02）
    const raw = num(track.strength, 12)
    const amp = Math.min(0.03, Math.max(0.001, raw / 1000))
    const durMs = Math.max(120, (Number(track.duration) || 0) * 1000)
    const t0 = performance.now()
    let raf = 0
    let stopped = false

    const tick = (now: number): void => {
      if (stopped) return
      const elapsed = now - t0
      const t = Math.min(1, elapsed / durMs)
      // 头尾各留 15% 淡入淡出，中段满幅 —— 避免突兀起停
      const env = t < 0.15 ? t / 0.15 : t > 0.85 ? (1 - t) / 0.15 : 1
      // 多正弦叠加：避免机械感。频率取 3.1/5.7/8.3 Hz 的非整数倍关系
      const s = elapsed / 1000
      const wobble = Math.sin(s * 19.5) * 0.6 + Math.sin(s * 35.8) * 0.3 + Math.sin(s * 52.1) * 0.1
      const tilt = Math.sin(s * 11.3) * 0.4 + Math.sin(s * 23.7) * 0.2
      ctx.scene.setTransform('camera', {
        scale: 1 + amp * env * wobble,
        angle: amp * 120 * env * tilt
      })
      if (t < 1) raf = requestAnimationFrame(tick)
      else ctx.scene.setTransform('camera', null)
    }
    raf = requestAnimationFrame(tick)

    return {
      stop(): void {
        if (stopped) return
        stopped = true
        cancelAnimationFrame(raf)
        ctx.scene.setTransform('camera', null)
      }
    }
  }
}

export default handler

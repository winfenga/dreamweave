/**
 * shake 处理器：镜头震动（`strength` 为像素振幅，随时间衰减）。
 * 只经 `ctx.scene.setTransform('shake', { x, y })` 声明，由运行时合成到 `.stage-bg`
 * 的 `--fx-shake-x/y`（与 camera 的 pan 叠加，见合成契约）。
 */
import type { EffectTrack, TrackContext, TrackHandler, TrackInstance } from '../../../../../shared/effects-types'

const handler: TrackHandler = {
  kind: 'shake',
  start(track: EffectTrack, ctx: TrackContext): TrackInstance | null {
    const raw = Number(track.strength)
    const amp0 = Number.isFinite(raw) ? Math.max(0, raw) : 8
    const durMs = Math.max(120, (Number(track.duration) || 0) * 1000)
    const t0 = performance.now()
    let raf = 0
    let stopped = false

    const tick = (now: number): void => {
      if (stopped) return
      const t = Math.min(1, (now - t0) / durMs)
      const amp = amp0 * (1 - t) // 线性衰减
      const ang = t * 42
      const x = Math.sin(ang) * amp
      const y = Math.cos(ang * 0.85) * amp * 0.6
      ctx.scene.setTransform('shake', { x, y })
      if (t < 1) {
        raf = requestAnimationFrame(tick)
      } else {
        ctx.scene.setTransform('shake', { x: 0, y: 0 })
      }
    }
    raf = requestAnimationFrame(tick)

    return {
      stop(): void {
        if (stopped) return
        stopped = true
        cancelAnimationFrame(raf)
        ctx.scene.setTransform('shake', null)
      }
    }
  }
}

export default handler

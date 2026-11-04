/**
 * blur 处理器：画面模糊（`strength` 为像素级模糊半径）。
 * 只经 `ctx.scene.setFilter('blur', { blurPx })` 声明，由运行时合成到 `--fx-blur`。
 */
import type { EffectTrack, TrackContext, TrackHandler, TrackInstance } from '../../../../../shared/effects-types'

const handler: TrackHandler = {
  kind: 'blur',
  start(track: EffectTrack, ctx: TrackContext): TrackInstance | null {
    const raw = Number(track.strength)
    const blurPx = Number.isFinite(raw) ? Math.max(0, raw) : 6
    ctx.scene.setFilter('blur', { blurPx })
    let stopped = false
    return {
      stop(): void {
        if (stopped) return
        stopped = true
        ctx.scene.setFilter('blur', null)
      }
    }
  }
}

export default handler

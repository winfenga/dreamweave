/**
 * camera 处理器：镜头推进 / 摇镜 / 倾斜 / 眩晕（9 条特效）。
 *
 * 参数（来自目录）：`scale` 目标缩放、`panX`/`panY` 目标平移（px）、`angle` 目标旋转（度）。
 * 语义是「在 duration 内**平滑过渡**到该构图，然后保持在目标位」。这与 shake 不同
 * ——shake 是抖，camera 是「移过去」。
 *
 * 实现：用 RAF 在 duration 内做 ease-in-out 插值，持续 `ctx.scene.setTransform('camera', …)`。
 * 中途 stop() 必须把通道交还（置 null），否则运行时合成的 `--fx-scale` 会永远停在半路。
 */
import type { EffectTrack, TrackContext, TrackHandler, TrackInstance } from '../../../../../shared/effects-types'

function num(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** ease-in-out cubic：起步和收尾都缓，中段快 —— 镜头运动的常规曲线 */
function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

const handler: TrackHandler = {
  kind: 'camera',
  start(track: EffectTrack, ctx: TrackContext): TrackInstance | null {
    // 基线恒等：未给的参数一律不动（不是填 0，因为 panX 基线就是 0，而 scale 基线是 1）
    const toScale = Math.max(0.5, Math.min(4, num(track.scale, 1)))
    const toPanX = num(track.panX, 0)
    const toPanY = num(track.panY, 0)
    const toAngle = num(track.angle, 0)

    const durMs = Math.max(1, (Number(track.duration) || 0) * 1000)
    // 无需运动（目标 == 基线）时不做任何事，避免白占一个 RAF 循环
    if (toScale === 1 && toPanX === 0 && toPanY === 0 && toAngle === 0) return null

    const t0 = performance.now()
    let raf = 0
    let stopped = false

    const tick = (now: number): void => {
      if (stopped) return
      const raw = Math.min(1, (now - t0) / durMs)
      const e = easeInOut(raw)
      ctx.scene.setTransform('camera', {
        scale: 1 + (toScale - 1) * e,
        panX: toPanX * e,
        panY: toPanY * e,
        angle: toAngle * e
      })
      if (raw < 1) raf = requestAnimationFrame(tick)
      // 到点后**保持**当前构图（不置 null），由 stop() 负责归还
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

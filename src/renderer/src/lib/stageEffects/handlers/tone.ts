/**
 * tone 处理器：调色（night / warm / cold / sepia / grayscale / negative）。
 *
 * 只经 `ctx.scene.setFilter('tone', …)` **声明**贡献，由运行时统一合成到 `.stage-bg` 的
 * `--fx-tone-*` 变量（见 styles.css 合成契约），handler **不直接写 DOM**。
 */
import type {
  EffectTrack,
  SceneFilter,
  TrackContext,
  TrackHandler,
  TrackInstance
} from '../../../../../shared/effects-types'

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

/** variant -> 给定强度 s∈[0,1] 时的 filter 参数（未命中的 variant 回落 night） */
const TONE_MAP: Record<string, (s: number) => SceneFilter> = {
  night: (s) => ({ brightness: 1 - 0.45 * s, saturate: 1 - 0.3 * s, hue: -8 * s, contrast: 1 + 0.05 * s }),
  warm: (s) => ({ sepia: 0.35 * s, brightness: 1 + 0.06 * s, saturate: 1 + 0.1 * s }),
  cold: (s) => ({ hue: 12 * s, saturate: 1 - 0.2 * s, brightness: 0.98 }),
  sepia: (s) => ({ sepia: 1 * s }),
  grayscale: (s) => ({ grayscale: 1 * s }),
  negative: (s) => ({ invert: 1 * s })
}

const handler: TrackHandler = {
  kind: 'tone',
  start(track: EffectTrack, ctx: TrackContext): TrackInstance | null {
    const variant = typeof track.variant === 'string' && track.variant ? track.variant : 'night'
    const s = clamp01(typeof track.strength === 'number' ? track.strength : 0.8)
    const fn = TONE_MAP[variant] ?? TONE_MAP.night
    ctx.scene.setFilter('tone', fn(s))
    let stopped = false
    return {
      stop(): void {
        if (stopped) return
        stopped = true
        ctx.scene.setFilter('tone', null)
      }
    }
  }
}

export default handler

/**
 * overlay 处理器：fade / vignette / letterbox / speedlines / impact / focus / blood /
 * heartbeat / heartbeat-zoom / iris / wipe / slash / lightning 等「遮罩/光线」类。
 *
 * 策略：**只建一个自有节点 + 挂 CSS 变体类**，视觉与动画全在 styles.css 的
 * `.fx-overlay--<variant>` 里；新增 variant 只加 CSS，不改本文件。
 */
import type { EffectTrack, TrackContext, TrackHandler, TrackInstance } from '../../../../../shared/effects-types'

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

const handler: TrackHandler = {
  kind: 'overlay',
  start(track: EffectTrack, ctx: TrackContext): TrackInstance | null {
    const variant = typeof track.variant === 'string' && track.variant ? track.variant : 'fade'
    const strength = typeof track.strength === 'number' ? clamp01(track.strength) : 0.75
    const durMs = Math.max(120, (Number(track.duration) || 0) * 1000)

    const el = document.createElement('div')
    el.className = `fx-overlay fx-overlay--${variant}`
    el.setAttribute('data-testid', 'fx-overlay')
    el.setAttribute('data-variant', variant)
    el.style.setProperty('--fx-strength', String(strength))
    el.style.animationDuration = `${durMs}ms`
    if (typeof track.color === 'string' && track.color) el.style.setProperty('--fx-color', track.color)
    ctx.overlay.appendChild(el)

    let stopped = false
    return {
      stop(): void {
        if (stopped) return
        stopped = true
        el.remove()
      }
    }
  }
}

export default handler

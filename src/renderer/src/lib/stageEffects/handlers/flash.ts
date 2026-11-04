/**
 * flash 处理器：全屏亮层瞬间爆闪（`strength` 为初始不透明度）。
 * 建自有节点，CSS keyframes 做 opacity 衰减；stop() 移除节点。
 */
import type { EffectTrack, TrackContext, TrackHandler, TrackInstance } from '../../../../../shared/effects-types'

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

const handler: TrackHandler = {
  kind: 'flash',
  start(track: EffectTrack, ctx: TrackContext): TrackInstance | null {
    const strength = clamp01(typeof track.strength === 'number' ? track.strength : 0.5)
    const durMs = Math.max(120, (Number(track.duration) || 0) * 1000)

    const el = document.createElement('div')
    el.className = 'fx-flash'
    el.setAttribute('data-testid', 'fx-flash')
    el.style.setProperty('--fx-strength', String(strength))
    el.style.animationDuration = `${durMs}ms`
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

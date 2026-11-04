/**
 * actor 处理器：人物本体演出（滑入 / 退场 / 跳动 / 发抖 / 倾身 / 呼吸 / 虚化）。
 *
 * 与 `cutin` 的区别：cutin 是「另起一个斜切分镜展示人物」，actor 是
 * **对舞台上当前这张立绘本身上动画**。因此它同样需要 `ctx.actors`。
 *
 * 实现策略：在 overlay 里建一个「立绘副本」节点，把立绘 URL 作为 background 画进去，
 * 然后在副本上做 transform / opacity / filter 动画。
 * 为什么不直接动舞台上的 `<img>`：那会与 StageView 自己的立绘定位/缩放逻辑打架，
 * 且 handler.stop() 必须能完整还原——改动别人拥有的节点做不到这一点。
 *
 * 7 种 variant（来自目录）：enter / exit / bounce / tremble / lean / breath / ghost。
 */
import type { EffectTrack, TrackContext, TrackHandler, TrackInstance } from '../../../../../shared/effects-types'

function num(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** 每种 variant 的 CSS 类名 + 运动幅度系数（幅度由 track.strength 缩放） */
const VARIANTS: Record<string, string> = {
  enter: 'fx-actor--enter',
  exit: 'fx-actor--exit',
  bounce: 'fx-actor--bounce',
  tremble: 'fx-actor--tremble',
  lean: 'fx-actor--lean',
  breath: 'fx-actor--breath',
  ghost: 'fx-actor--ghost'
}

const handler: TrackHandler = {
  kind: 'actor',
  start(track: EffectTrack, ctx: TrackContext): TrackInstance | null {
    const actors = ctx.actors
    if (!actors) return null

    const wantId = ctx.targetCharacterId || ctx.action?.characterId || undefined
    const portrait = actors.resolve(wantId)
    if (!portrait || !portrait.imageUrl) return null

    const variant = typeof track.variant === 'string' && track.variant ? track.variant : 'bounce'
    const cls = VARIANTS[variant]
    // 未预见的 variant：静默跳过（目录可能新增，运行时不该崩）
    if (!cls) return null

    const strength = Math.min(3, Math.max(0.1, num(track.strength, 1)))
    const durMs = Math.max(120, (Number(track.duration) || 0) * 1000)

    const el = document.createElement('div')
    el.className = `fx-actor ${cls}`
    el.setAttribute('data-testid', 'fx-actor')
    el.setAttribute('data-variant', variant)
    el.setAttribute('data-character', portrait.characterId)
    el.style.backgroundImage = `url("${portrait.imageUrl}")`
    el.style.animationDuration = `${durMs}ms`
    el.style.setProperty('--fx-actor-strength', String(strength))

    try {
      ctx.overlay.appendChild(el)
    } catch {
      return null
    }

    let stopped = false
    return {
      stop(): void {
        if (stopped) return
        stopped = true
        try {
          el.remove()
        } catch {
          // 忽略清理失败
        }
      }
    }
  }
}

export default handler

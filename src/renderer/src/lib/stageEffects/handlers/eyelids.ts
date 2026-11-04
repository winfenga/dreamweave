/**
 * eyelids 处理器：眼睑开合（眨眼 / 睁眼 / 闭眼）。
 *
 * 目录里的 `pattern` 四种：`blink`（快速眨）、`open`（缓缓睁）、`close`（缓缓闭）、
 * `struggle`（艰难睁，带几次抖动）。
 *
 * 实现：在 overlay 里建上下两片「眼睑」——两块与画面同色的遮罩从上下边缘合拢。
 * 不用纯黑挡板，是因为深色挡板在浅色场景里像"断电"，改用带微渐变的面板更像视野收拢。
 * 用 CSS animation 而非 RAF：这些是纯时序动画，交给合成器更省电也更稳。
 */
import type { EffectTrack, TrackContext, TrackHandler, TrackInstance } from '../../../../../shared/effects-types'

const PATTERNS = new Set(['blink', 'open', 'close', 'struggle'])

/**
 * pattern → CSS 类。
 * 语义约定：`open` = 起始闭合→张开；`close` = 起始张开→闭合；
 * `blink` = 张开→闭→张开（一次完整眨眼）；
 * `struggle` = 半闭状态下反复尝试张开，最终睁开。
 */
const CLS: Record<string, string> = {
  blink: 'fx-eyelids--blink',
  open: 'fx-eyelids--open',
  close: 'fx-eyelids--close',
  struggle: 'fx-eyelids--struggle'
}

const handler: TrackHandler = {
  kind: 'eyelids',
  start(track: EffectTrack, ctx: TrackContext): TrackInstance | null {
    const pattern = typeof track.pattern === 'string' && track.pattern ? track.pattern : 'blink'
    if (!PATTERNS.has(pattern)) return null

    const durMs = Math.max(80, (Number(track.duration) || 0) * 1000)

    const root = document.createElement('div')
    root.className = `fx-eyelids ${CLS[pattern]}`
    root.setAttribute('data-testid', 'fx-eyelids')
    root.setAttribute('data-pattern', pattern)
    root.style.animationDuration = `${durMs}ms`

    const top = document.createElement('div')
    top.className = 'fx-eyelids-lid fx-eyelids-top'
    const bottom = document.createElement('div')
    bottom.className = 'fx-eyelids-lid fx-eyelids-bottom'
    root.appendChild(top)
    root.appendChild(bottom)

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

/**
 * text 处理器：人物头顶/画面中央的字符型标记（问号 / 感叹 / 愤怒 / 汗滴 / Zzz …）。
 *
 * - `text` 为标记文本来源；少量英文词形（anger/sweat/heart）映射为统一字形，
 *   其余（?、!、砰！、危、シーン…）原样显示。**不硬编码任何 id**，纯字符映射。
 * - `anchor` = head（人物上方）/ center（画面中央）；`motion` = pop / pulse / float。
 */
import type { EffectTrack, TrackContext, TrackHandler, TrackInstance } from '../../../../../shared/effects-types'

/** 少量词形 → 字形（仅字符映射，与特效 id 无关；未命中原样显示） */
const GLYPHS: Record<string, string> = {
  anger: '💢',
  sweat: '💧',
  heart: '❤'
}

const handler: TrackHandler = {
  kind: 'text',
  start(track: EffectTrack, ctx: TrackContext): TrackInstance | null {
    const raw = typeof track.text === 'string' && track.text ? track.text : '?'
    const glyph = GLYPHS[raw] ?? raw
    const anchor = track.anchor === 'center' ? 'center' : 'head'
    const motion = track.motion === 'pulse' || track.motion === 'float' ? track.motion : 'pop'
    const durMs = Math.max(120, (Number(track.duration) || 0) * 1000)

    const el = document.createElement('div')
    el.className = `fx-text fx-text--${anchor} fx-text--${motion}`
    el.setAttribute('data-testid', 'fx-text')
    el.setAttribute('data-anchor', anchor)
    el.setAttribute('data-motion', motion)
    el.style.animationDuration = `${durMs}ms`
    el.textContent = glyph
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

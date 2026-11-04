/**
 * cutin 处理器：人物斜切入场（`portrait-cutin`）。
 *
 * 这是**唯一必须知道「切谁」**的轨道 kind —— 目录里 guide 原文是
 * 「斜切人物特写；用于重要人物突然登场、亮相或想通关键内容，不用于普通说话。
 *   **必须指定画面中的人物**。」因此它天然依赖 `TrackContext.actors`。
 *
 * 视觉规格来自目录 track 参数：
 *   cropRatio    0.36  取立绘有效高度的这一段（从头顶往下）作为上半身
 *   panelHeight  0.5   斜切分镜高度（相对视口）
 *   panelWidth   0.61  斜切分镜宽度（相对视口）
 *   angle        -7    斜切角度（度）
 *
 * 降级链（任何一环缺失都静默跳过，绝不抛错、不影响同句其它特效）：
 *   actors 通道缺失 → 不播
 *   该角色无立绘     → 不播
 *   立绘加载失败     → 移除节点
 *
 * 裁切方式用 `background-image` + `background-position/size`，而不是 `<img>` +
 * `clip-path`：这样「取上半身」只需算 background-size 的比例，不依赖图片实际像素尺寸，
 * 也不需要等图片 naturalWidth。
 */
import type { EffectTrack, TrackContext, TrackHandler, TrackInstance } from '../../../../../shared/effects-types'

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

/** 从 track 里读数值参数，缺失/非法时用兜底 */
function num(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

const handler: TrackHandler = {
  kind: 'cutin',
  start(track: EffectTrack, ctx: TrackContext): TrackInstance | null {
    const actors = ctx.actors
    if (!actors) return null

    // 优先用挂载点绑定的人物，缺省回落当前句说话人
    const wantId = ctx.targetCharacterId || ctx.action?.characterId || undefined
    const portrait = actors.resolve(wantId)
    if (!portrait || !portrait.imageUrl) return null

    const cropRatio = Math.min(0.95, Math.max(0.1, num(track.cropRatio, 0.36)))
    const panelHeight = Math.min(1, Math.max(0.1, num(track.panelHeight, 0.5)))
    const panelWidth = Math.min(1, Math.max(0.1, num(track.panelWidth, 0.61)))
    const angle = num(track.angle, -7)
    const durMs = Math.max(200, (Number(track.duration) || 0) * 1000)

    // ---- 斜切分镜容器 ----
    const panel = document.createElement('div')
    panel.className = 'fx-cutin'
    panel.setAttribute('data-testid', 'fx-cutin')
    panel.setAttribute('data-character', portrait.characterId)
    panel.style.height = `${panelHeight * 100}%`
    panel.style.width = `${panelWidth * 100}%`
    panel.style.setProperty('--fx-cutin-angle', `${angle}deg`)
    panel.style.animationDuration = `${durMs}ms`

    // ---- 内层：用 background 裁出上半身 ----
    const inner = document.createElement('div')
    inner.className = 'fx-cutin-inner'
    // 有效内容区：有测量结果就按 top..bottom，否则整张图
    const top = clamp01(portrait.contentBox?.top ?? 0)
    const bottom = clamp01(portrait.contentBox?.bottom ?? 1)
    const validH = Math.max(0.05, bottom - top)
    // 从有效区顶部往下取 cropRatio 部分 → 换算成整图的 background-size 放大倍数
    const takeH = Math.max(0.02, validH * cropRatio)
    const scale = 1 / takeH
    inner.style.backgroundImage = `url("${portrait.imageUrl}")`
    inner.style.backgroundRepeat = 'no-repeat'
    // 宽度按同一倍数放大，保持比例不拉伸；水平居中
    inner.style.backgroundSize = `${scale * 100}% auto`
    inner.style.backgroundPosition = `center ${(top / Math.max(1e-6, 1 - takeH)) * 100}%`
    panel.appendChild(inner)

    // 斜切边缘装饰（纯 CSS，见 styles.css）
    const edge = document.createElement('div')
    edge.className = 'fx-cutin-edge'
    panel.appendChild(edge)

    try {
      ctx.overlay.appendChild(panel)
    } catch {
      return null
    }

    let stopped = false
    return {
      stop(): void {
        if (stopped) return
        stopped = true
        try {
          panel.remove()
        } catch {
          // 忽略清理失败
        }
      }
    }
  }
}

export default handler

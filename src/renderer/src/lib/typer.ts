/**
 * 流式打字机（Galgame 对话框逐字显示）。
 *
 * 设计要点：
 * - 用 requestAnimationFrame 按「字符/秒」推进，`finish()` 可一键显示全文
 *   （ Galgame 的标准交互：点击先显全，再点击才推进下一句 ）；
 * - 不依赖任何框架，纯类，便于在自动化里直接驱动；
 * - CJK 按 JS 字符串长度计（一个汉字 = 1 字符），与观感一致。
 */
export interface TyperHooks {
  /** 每帧回调：当前已显示的文本 */
  onTick: (shown: string) => void
  /** 全文显示完毕时回调一次 */
  onDone: () => void
}

/** 估算一段文本按给定速度需要多少毫秒 */
export function estimateTypeMs(text: string, cps: number): number {
  const len = [...(text ?? '')].length
  if (!len) return 0
  return Math.round((len / Math.max(1, cps)) * 1000)
}

export class Typer {
  private text = ''
  /** 已显示的字符数（按码点计，避免代理对被拆半） */
  private shownCount = 0
  private cps = 30
  private raf = 0
  private lastTs = 0
  private acc = 0
  private running = false
  private doneFlag = true
  private hooks: TyperHooks

  constructor(hooks: TyperHooks) {
    this.hooks = hooks
  }

  get running_(): boolean {
    return this.running
  }

  get done(): boolean {
    return this.doneFlag
  }

  /** 当前已显示文本 */
  get shown(): string {
    return this.slice(this.shownCount)
  }

  private slice(n: number): string {
    const chars = [...this.text]
    return chars.slice(0, Math.min(n, chars.length)).join('')
  }

  /**
   * 开始逐字显示。
   * @param text 全文（空文本会立即 onDone）
   * @param cps   每秒字符数
   */
  start(text: string, cps = 30): void {
    this.stop()
    this.text = text ?? ''
    this.shownCount = 0
    this.cps = Math.max(1, cps)
    this.doneFlag = this.text.length === 0
    this.hooks.onTick(this.shown)
    if (this.doneFlag) {
      this.hooks.onDone()
      return
    }
    this.running = true
    this.lastTs = 0
    this.acc = 0
    this.raf = requestAnimationFrame(this.frame)
  }

  private frame = (ts: number): void => {
    if (!this.running) return
    if (!this.lastTs) this.lastTs = ts
    const dt = Math.min(250, ts - this.lastTs)
    this.lastTs = ts
    this.acc += (dt / 1000) * this.cps
    const target = Math.min([...this.text].length, Math.floor(this.acc))
    if (target > this.shownCount) {
      this.shownCount = target
      this.hooks.onTick(this.shown)
    }
    if (this.shownCount >= [...this.text].length) {
      this.running = false
      this.doneFlag = true
      this.raf = 0
      this.hooks.onDone()
      return
    }
    this.raf = requestAnimationFrame(this.frame)
  }

  /** 立即显示全文（正在跑则触发一次 onDone） */
  finish(): void {
    if (!this.running) return
    this.running = false
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.shownCount = [...this.text].length
    this.doneFlag = true
    this.hooks.onTick(this.shown)
    this.hooks.onDone()
  }

  /** 中止（不回调 onDone） */
  stop(): void {
    this.running = false
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.doneFlag = true
  }
}

/**
 * 舞台音频控制器：包内配音 / TTS 合成 / BGM / 音量。
 *
 * 音源优先级（见设置里的「自动播放音源」）：
 *   dubbing（默认）：有配音片段 → 按片段时长；无片段 → 定时器兜底
 *   tts             ：合成（需配置模型接入）→ 失败/未配置回配音片段 → 定时器兜底
 *   timer           ：只用定时器
 * 任何情况下都不会在用户没有选择 tts 策略时擅自发起网络请求。
 *
 * 浏览器自动播放策略：Chromium 无用户手势时 play() 会抛 NotAllowedError。
 * 控制器记录 unlocked（首次点击/按键时置位），被拦截时向上返回
 * {ok:false, reason:'autoplay-blocked'}，由调用方走定时器兜底，不报错。
 *
 * ⚠️ 打断语义（2026-11 修复，见 docs/audio-stall-investigation.md）：
 * `<audio>` 被 pause() 之后**不会**触发 ended，所以「只靠 ended/error/超时结算」
 * 的 promise 会一直挂着 —— 这会让上层的节奏等待（waitForPace）永不返回，
 * 自动播放的 autoRunning 也就复不了位，表现为「暂停后再点自动播放毫无反应」。
 * 因此所有主动打断（stopVoice / 换句 / 暂停 / dispose）都必须显式结算会话。
 */
import type { ModelSettings, SpeakResult } from '../../../shared/app-types'

export type AutoplayPolicy = ModelSettings['autoplayPolicy']

export interface PlayClipResult {
  ok: boolean
  reason?: 'autoplay-blocked' | 'load-error' | 'timeout' | 'empty' | 'cancelled'
  /** 实际播放时长（毫秒），仅 ok 时有值 */
  durationMs?: number
  url?: string
}

export interface SpeakOutcome extends SpeakResult {
  reason?: 'autoplay-blocked' | 'load-error' | 'timeout' | 'cancelled'
  durationMs?: number
}

/**
 * 一次进行中的播放会话。
 *
 * 为什么需要它：`<audio>` 被 `pause()` 之后是**不会**触发 `ended` 的，
 * 于是「只靠 ended/error/超时结算」的 promise 会一直挂着 —— 这正是
 * 自动播放里 `autoRunning` 复不了位、后续点击全部失效的根因。
 * 因此任何主动打断（stopVoice / 换句 / 暂停 / dispose）都必须能把会话显式结算掉。
 */
interface PlaySession {
  audio: HTMLAudioElement
  /** 供 stopVoice 主动结算；重复调用无害 */
  settle: (r: PlayClipResult) => void
}

/** 单个片段的安全上限：防止音频元数据异常导致自动播放卡死 */
const MAX_CLIP_MS = 120_000

export class StageAudioController {
  private voicePool: HTMLAudioElement[] = []
  private voiceIdx = 0
  private bgm: HTMLAudioElement | null = null
  private bgmUrl: string | null = null
  private unlocked = false
  private voiceVolume = 0.9
  private bgmVolume = 0.35
  private disposed = false
  /** 所有仍在等待结算的播放会话（见 PlaySession 注释） */
  private sessions = new Set<PlaySession>()

  constructor(volumes?: { voice?: number; bgm?: number }) {
    if (volumes?.voice != null) this.voiceVolume = volumes.voice
    if (volumes?.bgm != null) this.bgmVolume = volumes.bgm
  }

  /** 用户手势发生时调用，解锁自动播放并（若有 BGM）开始播放 */
  unlock(): void {
    if (this.unlocked) return
    this.unlocked = true
    if (this.bgmUrl && this.bgm && this.bgm.paused) {
      void this.bgm.play().catch(() => undefined)
    }
  }

  get isUnlocked(): boolean {
    return this.unlocked
  }

  setVolumes(voice?: number, bgm?: number): void {
    if (voice != null) {
      this.voiceVolume = Math.min(1, Math.max(0, voice))
      for (const a of this.voicePool) a.volume = this.voiceVolume
    }
    if (bgm != null) {
      this.bgmVolume = Math.min(1, Math.max(0, bgm))
      if (this.bgm) this.bgm.volume = this.bgmVolume
    }
  }

  private nextVoice(): HTMLAudioElement {
    if (this.voiceIdx >= this.voicePool.length) {
      const a = new Audio()
      a.preload = 'auto'
      a.volume = this.voiceVolume
      this.voicePool.push(a)
    }
    const a = this.voicePool[this.voiceIdx % this.voicePool.length]
    this.voiceIdx = (this.voiceIdx + 1) % Math.max(1, this.voicePool.length)
    return a
  }

  /** 播放包内配音片段（t2w:// URL），播完（或出错/超时/被打断）才 resolve */
  playClip(url: string): Promise<PlayClipResult> {
    if (this.disposed || !url) return Promise.resolve({ ok: false, reason: 'empty' })
    const audio = this.nextVoice()
    audio.volume = this.voiceVolume
    // 同一元素上的旧会话先结算掉，避免旧 promise 永远悬着
    this.cancelSessions(audio, 'cancelled')
    return new Promise<PlayClipResult>((resolve) => {
      let settled = false
      let session: PlaySession
      const done = (r: PlayClipResult): void => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        audio.removeEventListener('ended', onEnded)
        audio.removeEventListener('error', onError)
        this.sessions.delete(session)
        resolve(r)
      }
      const onEnded = (): void => done({ ok: true, durationMs: Math.round((audio.duration || 0) * 1000), url })
      const onError = (): void => done({ ok: false, reason: 'load-error', url })
      const timer = window.setTimeout(() => done({ ok: false, reason: 'timeout', url }), MAX_CLIP_MS)
      session = { audio, settle: done }
      this.sessions.add(session)
      audio.addEventListener('ended', onEnded)
      audio.addEventListener('error', onError)
      audio.src = url
      audio.currentTime = 0
      void audio.play().catch((e: unknown) => {
        const name = (e as Error)?.name ?? ''
        done({ ok: false, reason: name === 'NotAllowedError' ? 'autoplay-blocked' : 'load-error', url })
      })
    })
  }

  /**
   * 结算掉（并可选按元素过滤）所有进行中的播放会话。
   * 纯 pause() 不触发 ended，所以必须走这里把 promise 收掉。
   */
  private cancelSessions(audio?: HTMLAudioElement, reason: PlayClipResult['reason'] = 'cancelled'): void {
    for (const s of [...this.sessions]) {
      if (audio && s.audio !== audio) continue
      s.settle({ ok: false, reason, url: s.audio.src })
    }
  }

  /** 合成并播放一段文本（主进程缓存优先）；未配置时 ok:false 且带可读错误 */
  async speak(text: string, voice?: string): Promise<SpeakOutcome> {
    if (this.disposed || !text.trim()) return { ok: false, error: '文本为空' }
    const res = await window.feather.speak(text, voice)
    if (!res.ok || !res.url) return res
    const played = await this.playClip(res.url)
    if (!played.ok) {
      return {
        ...res,
        ok: false,
        reason: played.reason === 'empty' ? 'load-error' : played.reason,
        error: res.error ?? `播放失败：${played.reason}`
      }
    }
    return { ...res, durationMs: played.durationMs }
  }

  /** 设置 BGM（url 为 null 表示关闭）；循环播放，音量取 bgmVolume */
  setBgm(url: string | null): void {
    if (this.disposed) return
    if (!url) {
      if (this.bgm) {
        this.bgm.pause()
        this.bgm.src = ''
      }
      this.bgmUrl = null
      return
    }
    if (!this.bgm) {
      this.bgm = new Audio()
      this.bgm.loop = true
      this.bgm.volume = this.bgmVolume
    }
    this.bgmUrl = url
    this.bgm.src = url
    if (this.unlocked) void this.bgm.play().catch(() => undefined)
  }

  get bgmPlaying(): boolean {
    return !!this.bgm && !this.bgm.paused
  }

  /** 停掉当前所有语音（切句/暂停时调用，避免两句声音重叠） */
  stopVoice(): void {
    // 先结算会话再暂停：pause() 不会触发 ended，不先结算的话
    // waitForPace 会一直挂着，自动播放循环就再也退不出来
    this.cancelSessions(undefined, 'cancelled')
    for (const a of this.voicePool) {
      try {
        a.pause()
        a.currentTime = 0
      } catch {
        /* 忽略 */
      }
    }
  }

  dispose(): void {
    this.disposed = true
    this.stopVoice()
    this.sessions.clear()
    if (this.bgm) {
      this.bgm.pause()
      this.bgm.src = ''
      this.bgm = null
    }
    this.voicePool = []
    this.bgmUrl = null
  }
}

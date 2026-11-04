/**
 * StageEffectRuntime —— 演出页特效的可扩展渲染框架运行时（唯一调度器 / 合成器）。
 *
 * 职责：
 * - 目录解析：effectId → EffectCatalogEntry（byId），kind → handler（注册表）。
 * - 统一调度：把本句每个 EffectMount 的 tracks[] 按 `at`（秒→毫秒）排 setTimeout 到点
 *   `handler.start()`，到 `at+duration` 调 `instance.stop()`；所有 timer/id 入统一登记表，
 *   任何取消都能一次清干净（P0-21 无残留、无卡死 timer）。
 * - 场景合成：camera/shake/blur/tone 经 `SceneTarget` **声明**贡献，运行时统一写
 *   `.stage-bg` 的 `--fx-*` 变量；**无任何贡献时清空 inline → 回到 CSS 恒等默认**（P0 / C5）。
 * - 单句 vs 范围：每个 kind 至多一个生效源，**单句优先于范围**（P0-7）；范围进入即持有、
 *   跨句不重播、离开即停（忽略 track at/duration）。
 *
 * 该运行时**不含任何具体特效 id 分支**：一切走数据（byId.get / handlers.get）。
 */
import type { StageAction, ViewData } from '../../../../shared/app-types'
import type {
  EffectCatalogEntry,
  EffectMount,
  EffectRange,
  EffectTrack,
  FxOverlayHost,
  SceneFilter,
  SceneFilterPart,
  SceneTarget,
  SceneTransform,
  SceneTransformPart,
  TrackContext,
  TrackHandler,
  TrackInstance
} from '../../../../shared/effects-types'
import { buildRegistry } from './handlers'

/** 来源优先级：单句覆盖范围（同 kind 时高优先级胜出） */
const PRIORITY_SINGLE = 2
const PRIORITY_RANGE = 1

/** 换句时传给运行时的位置上下文（不含任何 effectId；mounts 由 runtime 依 view 解析） */
export interface StageFxPosition {
  chapterSeq: number
  order: number
  /** action.locationId（合并前 id），scene 范围据此判进入 */
  sceneId: string
  /** view.actions 的 0 基下标 */
  globalIndex: number
}

export interface StageEffectRuntimeOptions {
  overlayEl?: HTMLElement | null
  sceneEl?: HTMLElement | null
}

interface Contribution {
  prio: number
  seq: number
  transform: Partial<Record<SceneTransformPart, SceneTransform>>
  filter: Partial<Record<SceneFilterPart, SceneFilter>>
}

/**
 * 场景合成器：以 scopeId 为单位记录各 handler 声明的通道贡献，按优先级挑出生效值。
 * 单句（prio=2）始终压过范围（prio=1），从而满足「同 kind 单句覆盖范围」。
 */
class SceneCompositor {
  private parts = new Map<string, Contribution>()
  private seq = 0

  constructor(private readonly onChange: () => void) {}

  private mutate(sid: string, prio: number, fn: (c: Contribution) => void): void {
    let c = this.parts.get(sid)
    if (!c) {
      c = { prio, seq: 0, transform: {}, filter: {} }
      this.parts.set(sid, c)
    }
    c.prio = prio
    c.seq = ++this.seq
    fn(c)
    this.onChange()
  }

  setTransform(sid: string, prio: number, part: SceneTransformPart, t: SceneTransform | null): void {
    if (part !== 'camera' && part !== 'shake') return
    this.mutate(sid, prio, (c) => {
      if (t === null) delete c.transform[part]
      else c.transform[part] = t
    })
  }

  setFilter(sid: string, prio: number, part: SceneFilterPart, f: SceneFilter | null): void {
    if (part !== 'blur' && part !== 'tone') return
    this.mutate(sid, prio, (c) => {
      if (f === null) delete c.filter[part]
      else c.filter[part] = f
    })
  }

  removeScope(sid: string): void {
    if (this.parts.delete(sid)) this.onChange()
  }

  clear(): void {
    if (this.parts.size) {
      this.parts.clear()
      this.onChange()
    }
  }

  /** 取某 transform 通道的生效值：优先级高者胜，同优先级取最近更新者 */
  transform(part: SceneTransformPart): SceneTransform | null {
    let best: Contribution | null = null
    for (const c of this.parts.values()) {
      if (!c.transform[part]) continue
      if (!best || c.prio > best.prio || (c.prio === best.prio && c.seq > best.seq)) best = c
    }
    return best ? (best.transform[part] ?? null) : null
  }

  /** 取某 filter 通道的生效值 */
  filter(part: SceneFilterPart): SceneFilter | null {
    let best: Contribution | null = null
    for (const c of this.parts.values()) {
      if (!c.filter[part]) continue
      if (!best || c.prio > best.prio || (c.prio === best.prio && c.seq > best.seq)) best = c
    }
    return best ? (best.filter[part] ?? null) : null
  }
}

/** 一段持续持有的范围运行（进入时建、离开时拆） */
interface RangeRun {
  instances: Set<TrackInstance>
  scopes: Set<string>
}

export class StageEffectRuntime {
  private overlayEl: HTMLElement | null
  private sceneEl: HTMLElement | null
  private readonly handlers: Map<string, TrackHandler> = buildRegistry()
  private byId = new Map<string, EffectCatalogEntry>()
  private view: ViewData | null = null
  private ranges: EffectRange[] = []
  private readonly compositor: SceneCompositor

  private readonly singleTimers = new Set<number>()
  private readonly singleScopes = new Set<string>()
  private readonly singleInstances = new Set<TrackInstance>()
  private readonly rangeRuns = new Map<string, RangeRun>()

  private scopeSeq = 0
  private disposed = false

  constructor(opts: StageEffectRuntimeOptions) {
    this.overlayEl = opts.overlayEl ?? null
    this.sceneEl = opts.sceneEl ?? null
    this.compositor = new SceneCompositor(() => this.recomputeScene())
  }

  // ---------------------------------------------------------------- 数据接入
  setCatalog(entries: EffectCatalogEntry[]): void {
    this.byId = new Map(entries.map((e) => [e.id, e]))
  }

  /** 场景合成目标元素可能因背景 img / 占位 div 切换而更换，需可更新 */
  setSceneEl(el: HTMLElement | null): void {
    this.sceneEl = el
    this.recomputeScene()
  }

  setOverlayEl(el: HTMLElement | null): void {
    this.overlayEl = el
  }

  /** 注入当前包视图：运行时据此解析「本句 mounts」与「范围列表」 */
  setView(view: ViewData | null): void {
    this.view = view
    this.ranges = view?.effectRanges ?? []
  }

  // ---------------------------------------------------------------- 位置变化
  /**
   * 换句钩子：清上一句单句特效 → 排本句单句特效 → 重算范围进入/离开 → 合成场景变量。
   * 范围特效跨句不重播（仅进入时 start、离开时 stop）。
   */
  onPositionChange(ctx: StageFxPosition): void {
    if (this.disposed) return
    this.cancelSentence()
    const action = this.view?.actions[ctx.globalIndex] ?? null
    this.scheduleSingle(action?.effects ?? [], action)
    this.updateRanges(ctx, action)
    this.recomputeScene()
  }

  // ---------------------------------------------------------------- 单句调度
  private scheduleSingle(mounts: EffectMount[], action: StageAction | null): void {
    const overlay = this.overlayEl
    if (!overlay) {
      if (mounts.length) console.warn('[fx] 缺少特效层容器，单句特效已跳过')
      return
    }
    for (const m of mounts) {
      const entry = this.byId.get(m.effectId)
      if (!entry) {
        console.warn(`[fx] 目录中不存在 effectId：${m.effectId}，已跳过`)
        continue
      }
      for (const track of entry.tracks ?? []) {
        const handler = this.handlers.get(track.kind)
        if (!handler) {
          console.warn(`[fx] 缺少 kind=${track.kind} 的处理器，已跳过该轨道（不影响其它特效）`)
          continue
        }
        this.scheduleTrack(handler, track, entry, action)
      }
    }
  }

  private scheduleTrack(
    handler: TrackHandler,
    track: EffectTrack,
    entry: EffectCatalogEntry,
    action: StageAction | null
  ): void {
    const atMs = Math.max(0, (Number(track.at) || 0) * 1000)
    const durMs = Math.max(0, (Number(track.duration) || 0) * 1000)
    const scopeId = `s${++this.scopeSeq}`
    this.singleScopes.add(scopeId)

    const startTimer = window.setTimeout(() => {
      this.singleTimers.delete(startTimer)
      if (this.disposed) return
      const inst = this.startTrack(handler, track, entry, action, scopeId, PRIORITY_SINGLE)
      if (!inst) {
        this.singleScopes.delete(scopeId)
        this.compositor.removeScope(scopeId)
        return
      }
      this.singleInstances.add(inst)
      const stopTimer = window.setTimeout(() => {
        this.singleTimers.delete(stopTimer)
        this.singleInstances.delete(inst)
        this.singleScopes.delete(scopeId)
        this.compositor.removeScope(scopeId)
        try {
          inst.stop()
        } catch (e) {
          console.warn('[fx] instance.stop 抛错', e)
        }
      }, durMs)
      this.singleTimers.add(stopTimer)
    }, atMs)
    this.singleTimers.add(startTimer)
  }

  /** 清掉当前句的全部单句 timer / 实例 / 场景贡献（范围特效不受影响） */
  private cancelSentence(): void {
    for (const t of this.singleTimers) window.clearTimeout(t)
    this.singleTimers.clear()
    for (const inst of this.singleInstances) {
      try {
        inst.stop()
      } catch (e) {
        console.warn('[fx] instance.stop 抛错', e)
      }
    }
    this.singleInstances.clear()
    for (const sid of this.singleScopes) this.compositor.removeScope(sid)
    this.singleScopes.clear()
  }

  // ---------------------------------------------------------------- 范围特效
  private updateRanges(ctx: StageFxPosition, action: StageAction | null): void {
    const stillActive = new Set<string>()
    for (const r of this.ranges) {
      if (!this.inScope(r, ctx)) continue
      const key = rangeKey(r)
      stillActive.add(key)
      if (this.rangeRuns.has(key)) continue // 跨句：仍在范围，不重播
      const run: RangeRun = { instances: new Set(), scopes: new Set() }
      this.rangeRuns.set(key, run)
      const entry = this.byId.get(r.effectId)
      if (!entry) {
        console.warn(`[fx] 范围特效 effectId 不存在：${r.effectId}，已跳过`)
        continue
      }
      // 范围忽略 track 的 at/duration：进入即持有
      for (const track of entry.tracks ?? []) {
        const handler = this.handlers.get(track.kind)
        if (!handler) {
          console.warn(`[fx] 缺少 kind=${track.kind} 的处理器（范围），已跳过该轨道`)
          continue
        }
        const scopeId = `r${++this.scopeSeq}`
        const inst = this.startTrack(handler, track, entry, action, scopeId, PRIORITY_RANGE)
        if (inst) {
          run.instances.add(inst)
          run.scopes.add(scopeId)
        }
      }
    }
    for (const [key, run] of [...this.rangeRuns]) {
      if (stillActive.has(key)) continue
      this.stopRun(run)
      this.rangeRuns.delete(key)
    }
  }

  private stopRun(run: RangeRun): void {
    for (const sid of run.scopes) this.compositor.removeScope(sid)
    run.scopes.clear()
    for (const inst of run.instances) {
      try {
        inst.stop()
      } catch (e) {
        console.warn('[fx] range instance.stop 抛错', e)
      }
    }
    run.instances.clear()
  }

  private inScope(r: EffectRange, ctx: StageFxPosition): boolean {
    if (r.chapterSeq !== ctx.chapterSeq) return false
    if (r.scope === 'scene') return !!r.sceneId && r.sceneId === ctx.sceneId
    if (r.scope === 'orders') {
      const s = Number(r.orderStart)
      const e = Number(r.orderEnd)
      if (!Number.isFinite(s) || !Number.isFinite(e)) return false
      return ctx.order >= Math.min(s, e) && ctx.order <= Math.max(s, e)
    }
    return false
  }

  // ---------------------------------------------------------------- handler 起停
  private startTrack(
    handler: TrackHandler,
    track: EffectTrack,
    entry: EffectCatalogEntry,
    action: StageAction | null,
    scopeId: string,
    priority: number
  ): TrackInstance | null {
    const scene: SceneTarget = {
      setTransform: (part, t) => this.compositor.setTransform(scopeId, priority, part, t),
      setFilter: (part, f) => this.compositor.setFilter(scopeId, priority, part, f)
    }
    const ctx: TrackContext = {
      overlay: this.overlayEl as unknown as FxOverlayHost,
      scene,
      action,
      entry
    }
    try {
      return handler.start(track, ctx)
    } catch (e) {
      console.warn(`[fx] handler ${handler.kind} start 抛错，已忽略该轨道`, e)
      this.compositor.removeScope(scopeId)
      return null
    }
  }

  // ---------------------------------------------------------------- 场景合成
  private recomputeScene(): void {
    const el = this.sceneEl
    if (!el) return
    const cam = this.compositor.transform('camera')
    const shk = this.compositor.transform('shake')
    const T = ['--fx-scale', '--fx-pan-x', '--fx-pan-y', '--fx-angle', '--fx-shake-x', '--fx-shake-y']
    if (cam || shk) {
      el.style.setProperty('--fx-scale', String(cam?.scale ?? 1))
      el.style.setProperty('--fx-pan-x', `${cam?.panX ?? 0}px`)
      el.style.setProperty('--fx-pan-y', `${cam?.panY ?? 0}px`)
      el.style.setProperty('--fx-angle', `${cam?.angle ?? 0}deg`)
      el.style.setProperty('--fx-shake-x', `${shk?.x ?? 0}px`)
      el.style.setProperty('--fx-shake-y', `${shk?.y ?? 0}px`)
    } else {
      for (const p of T) el.style.removeProperty(p)
    }

    const blur = this.compositor.filter('blur')
    const tone = this.compositor.filter('tone')
    const F = [
      '--fx-blur',
      '--fx-sepia',
      '--fx-grayscale',
      '--fx-hue',
      '--fx-brightness',
      '--fx-contrast',
      '--fx-saturate',
      '--fx-invert'
    ]
    if (blur || tone) {
      el.style.setProperty('--fx-blur', `${blur?.blurPx ?? 0}px`)
      el.style.setProperty('--fx-sepia', String(tone?.sepia ?? 0))
      el.style.setProperty('--fx-grayscale', String(tone?.grayscale ?? 0))
      el.style.setProperty('--fx-hue', `${tone?.hue ?? 0}deg`)
      el.style.setProperty('--fx-brightness', String(tone?.brightness ?? 1))
      el.style.setProperty('--fx-contrast', String(tone?.contrast ?? 1))
      el.style.setProperty('--fx-saturate', String(tone?.saturate ?? 1))
      el.style.setProperty('--fx-invert', String(tone?.invert ?? 0))
    } else {
      for (const p of F) el.style.removeProperty(p)
    }
  }

  // ---------------------------------------------------------------- 取消 / 释放
  /** 清全部单句特效与范围特效，并将场景变量复位为恒等 */
  cancelAll(): void {
    this.cancelSentence()
    for (const run of this.rangeRuns.values()) this.stopRun(run)
    this.rangeRuns.clear()
    this.compositor.clear()
  }

  /** 卸载：取消一切、清空特效层，避免残留节点 / 卡死 timer */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelAll()
    if (this.overlayEl) {
      try {
        this.overlayEl.replaceChildren()
      } catch {
        // 忽略清理失败
      }
    }
  }
}

/** 范围身份键（跨副本去重 / 运行期运行表键） */
function rangeKey(r: EffectRange): string {
  return [r.scope, r.chapterSeq, r.sceneId ?? '', r.orderStart ?? '', r.orderEnd ?? '', r.effectId].join('|')
}

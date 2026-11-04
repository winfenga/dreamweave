<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ModelSettings, StageAction, ViewData } from '../../../shared/app-types'
import SearchSelect, { type SearchOption } from './SearchSelect.vue'
import EffectLayer from './EffectLayer.vue'
import { buildLookups, dubbingKey, speakerName } from '../lib/viewModel'
import { Typer } from '../lib/typer'
import { roleColor } from '../lib/stageColors'
import { StageAudioController } from '../lib/stageAudio'
import { StageEffectRuntime } from '../lib/stageEffects/runtime'
import { loadCatalog } from '../lib/effectCatalog'

const props = defineProps<{ view: ViewData; settings: ModelSettings | null }>()

const lookups = computed(() => buildLookups(props.view))

const chapterIdx = ref(0)
const offset = ref(0)
const playing = ref(false)
const speed = ref(1)
const showInfo = ref(true)
const showArt = ref(false)
const showChips = ref(true)
/** 右键隐藏对话框（Galgame 常规交互：看立绘/背景时先收起来） */
const dialogHidden = ref(false)

const chapter = computed(() => props.view.chapters[chapterIdx.value] ?? null)
const action = computed(() => {
  const ch = chapter.value
  if (!ch) return null
  return props.view.actions[ch.start + offset.value] ?? null
})

const bgUrl = computed(() => {
  const a = action.value
  if (!a?.locationId) return null
  return lookups.value.sceneImageBySceneId.get(a.locationId) ?? null
})
const sceneLabel = computed(() => {
  const a = action.value
  if (!a?.locationId) return ''
  return lookups.value.sceneNameById.get(a.locationId) ?? a.locationId
})
const speaker = computed(() => speakerName(lookups.value, action.value))
const speakerChar = computed(() => {
  const a = action.value
  if (!a?.characterId) return null
  return lookups.value.characterById.get(a.characterId) ?? null
})
/** 名牌颜色：按角色分级取色（级别随包而异，未预见级别走兜底色） */
const speakerColor = computed(() => roleColor(speakerChar.value?.importanceLevel, props.settings?.roleColors))
const portrait = computed(() => {
  const a = action.value
  if (!a?.characterId) return null
  return lookups.value.characterImageById.get(a.characterId) ?? null
})
const hasCharacterNoArt = computed(() => !!action.value?.characterId && !portrait.value)

const progress = computed(() => {
  const ch = chapter.value
  if (!ch) return { index: 0, total: 0 }
  return { index: offset.value + 1, total: ch.count }
})
const globalIndex = computed(() => (chapter.value ? chapter.value.start + offset.value + 1 : 0))

/** 用于重启动画：每换一句就变，挂在「过渡/特效」这类独立元素上当 key（不牵动背景 <img>） */
const animKey = computed(() => `${chapterIdx.value}-${offset.value}`)

// ---- P4 特效：运行时（只对接框架，主干**零特效 id 分支**）----
const fxLayerRef = ref<InstanceType<typeof EffectLayer> | null>(null)
const sceneElRef = ref<HTMLElement | null>(null)
let fxRuntime: StageEffectRuntime | null = null

/** 换句上下文：仅位置四元组；runtime 内部依 view 解析「本句 mounts / 范围列表」（主干不认识 effectId） */
function fxPosition(): { chapterSeq: number; order: number; sceneId: string; globalIndex: number } {
  const ch = chapter.value
  const a = action.value
  return {
    chapterSeq: a?.chapterSeq ?? ch?.chapterSeq ?? 0,
    order: a?.order ?? 0,
    sceneId: a?.locationId ?? '',
    globalIndex: ch ? ch.start + offset.value : 0
  }
}

// ---- 流式打字机 ----
const shownText = ref('')
const typingDone = ref(true)
const typer = new Typer({
  onTick: (t) => {
    shownText.value = t
  },
  onDone: () => {
    typingDone.value = true
  }
})

const isSpeech = (a: StageAction | null): boolean =>
  !!a && (a.type === 'say' || a.type === 'think' || a.type === 'narration')

function startTyping(): void {
  const a = action.value
  // move/battle 是过渡卡，不走打字机，直接整句显示
  if (!a || !isSpeech(a) || !a.text) {
    shownText.value = a?.text ?? ''
    typingDone.value = true
    return
  }
  typingDone.value = false
  shownText.value = ''
  typer.start(a.text, Math.max(6, 26 * speed.value))
}

function finishTyping(): void {
  typer.finish()
}

// ---- move：场景迁移 ----
const moveInfo = computed(() => {
  const a = action.value
  if (!a || a.type !== 'move') return null
  const nameOf = (id: string): string => lookups.value.sceneNameById.get(id) ?? id
  const from = a.fromLocationId ? nameOf(a.fromLocationId) : null
  const to = a.toLocationId ? nameOf(a.toLocationId) : null
  // 注意：`move` 不保证有终点（实测 29 条里 3 条只有起点）—— 这四种形态都要能优雅呈现
  const kind = from && to ? 'full' : from ? 'open' : to ? 'arrive' : 'plain'
  return { from, to, kind }
})

// ---- battle：目标高亮 ----
const battleTargets = computed(() => {
  const a = action.value
  if (!a || a.type !== 'battle') return []
  return (a.targetIds ?? []).map((id) => ({
    id,
    name: lookups.value.characterById.get(id)?.name ?? id,
    imageUrl: lookups.value.characterImageById.get(id) ?? null
  }))
})

// ---- 当前句的配音片段 ----
const dubbingClip = computed(() => {
  const a = action.value
  if (!a) return null
  return lookups.value.dubbingByKey.get(dubbingKey(a)) ?? null
})

function clampOffset(): void {
  const ch = chapter.value
  if (!ch) return
  offset.value = Math.min(Math.max(0, offset.value), ch.count - 1)
}

function goChapter(i: number): void {
  if (i < 0 || i >= props.view.chapters.length) return
  chapterIdx.value = i
  offset.value = 0
}

/** 导航令牌：用户手动导航时自增，用于打断「等音频播完再自动推进」的等待 */
let navToken = 0

function next(): void {
  navToken++
  audio.stopVoice()
  const ch = chapter.value
  if (!ch) return
  if (offset.value < ch.count - 1) {
    offset.value += 1
    return
  }
  if (chapterIdx.value < props.view.chapters.length - 1) goChapter(chapterIdx.value + 1)
  else playing.value = false
}

function prev(): void {
  navToken++
  audio.stopVoice()
  if (offset.value > 0) {
    offset.value -= 1
    return
  }
  if (chapterIdx.value > 0) {
    chapterIdx.value -= 1
    offset.value = Math.max(0, (props.view.chapters[chapterIdx.value]?.count ?? 1) - 1)
  }
}

// ---- 舞台缩放（0.7 ~ 1.6，步进 0.05）：只作用于对话框与立绘，背景固定不动 ----
const ZOOM_MIN = 0.7
const ZOOM_MAX = 1.6
const ZOOM_STEP = 0.05
const zoom = ref(1)

function setZoom(v: number): void {
  const c = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v))
  const snapped = Math.round((c - ZOOM_MIN) / ZOOM_STEP) * ZOOM_STEP + ZOOM_MIN
  zoom.value = Math.round((snapped + Number.EPSILON) * 100) / 100
}

function zoomBy(delta: number): void {
  setZoom(zoom.value + delta)
}

watch(
  () => props.settings?.stageZoom,
  (v) => {
    if (typeof v === 'number') setZoom(v)
  },
  { immediate: true }
)

// ---- 窗口级全屏（Electron API，不是 CSS 覆盖层）----
/** 是否处于窗口级全屏；真值一律以主进程回传为准，不做乐观假设 */
const fullScreen = ref(false)
/** 取消订阅函数，卸载时调用，避免组件销毁后仍往里写 ref */
let stopFullScreenSync: (() => void) | null = null

async function setFullScreen(on: boolean): Promise<void> {
  try {
    const r = await window.feather.setFullScreen(on)
    fullScreen.value = r.fullScreen
  } catch {
    // IPC 不可用（例如脱离 Electron 环境预览）时退化为非全屏，不让 UI 卡在错误状态
    fullScreen.value = false
  }
}

async function toggleFullScreen(): Promise<void> {
  try {
    const r = await window.feather.toggleFullScreen()
    fullScreen.value = r.fullScreen
  } catch {
    fullScreen.value = false
  }
}

// ---- 全屏悬浮退出按钮：鼠标移动时浮现，静止后自动淡出，避免常驻遮挡画面 ----
const FS_EXIT_IDLE_MS = 2000
const fsExitIdle = ref(false)
let fsExitTimer: number | null = null

function clearFsExitTimer(): void {
  if (fsExitTimer !== null) {
    window.clearTimeout(fsExitTimer)
    fsExitTimer = null
  }
}

function showFsExit(): void {
  fsExitIdle.value = false
  clearFsExitTimer()
  fsExitTimer = window.setTimeout(() => {
    fsExitIdle.value = true
    fsExitTimer = null
  }, FS_EXIT_IDLE_MS)
}

function onPointerMove(): void {
  // 非全屏时按钮不在 DOM 里，无需计时
  if (fullScreen.value) showFsExit()
}

// 进入全屏立刻浮现一次；退出时收起并清掉计时器，避免组件卸载后回调仍触发
watch(fullScreen, (on) => {
  clearFsExitTimer()
  if (on) {
    showFsExit()
  } else {
    fsExitIdle.value = false
  }
})

// ---- 音频 ----
const audio = new StageAudioController({
  voice: props.settings?.voiceVolume ?? 0.9,
  bgm: props.settings?.bgmVolume ?? 0.35
})
/** 当前节奏来源，显示在角标里 */
const paceLabel = ref('')
const paceNote = ref('')

watch(
  () => [props.settings?.voiceVolume, props.settings?.bgmVolume],
  ([v, b]) => audio.setVolumes(v ?? undefined, b ?? undefined),
  { immediate: true }
)

watch(
  () => props.settings?.bgmPath,
  (p) => {
    if (!p) {
      audio.setBgm(null)
      return
    }
    void window.feather.resolveBgm(p).then((r) => {
      if (r.ok && r.url) audio.setBgm(r.url)
      else paceNote.value = `BGM 不可用：${r.error ?? '未知错误'}`
    })
  },
  { immediate: true }
)

const sleep = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms))

function durationMs(): number {
  const len = action.value?.text.length ?? 10
  const raw = (700 + len * 62) / speed.value
  return Math.min(9000, Math.max(450, raw))
}

/**
 * 等「这一句的节奏」：配音片段 → TTS → 定时器。
 * 自动播放策略见设置；任何失败都回退定时器，绝不让自动播放卡死。
 */
async function waitForPace(a: StageAction): Promise<void> {
  const policy = props.settings?.autoplayPolicy ?? 'dubbing'
  const clip = lookups.value.dubbingByKey.get(dubbingKey(a))

  if (policy === 'timer') {
    paceLabel.value = '⏱ 定时器'
    paceNote.value = ''
    return sleep(durationMs())
  }

  if (policy !== 'tts' && clip) {
    paceLabel.value = '🔊 配音'
    const r = await audio.playClip(clip.url)
    if (r.ok) {
      paceNote.value = `${((r.durationMs ?? 0) / 1000).toFixed(1)}s`
      return
    }
    // 被打断（暂停/换句）不是失败，也不再兜底等待 —— 由调用方看 navToken 决定是否续跑
    if (r.reason === 'cancelled') {
      paceNote.value = '已中断'
      return
    }
    paceNote.value =
      r.reason === 'autoplay-blocked' ? '自动播放被拦截，定时器兜底' : `配音失败(${r.reason})，定时器兜底`
    return sleep(durationMs())
  }

  if (policy === 'tts' && isSpeech(a) && a.text) {
    paceLabel.value = '🗣 TTS'
    const r = await audio.speak(a.text)
    if (r.ok && r.durationMs) {
      paceNote.value = `${r.cached ? '缓存 ' : ''}${(r.durationMs / 1000).toFixed(1)}s`
      return
    }
    if (r.reason === 'cancelled') {
      paceNote.value = '已中断'
      return
    }
    if (clip) {
      const c = await audio.playClip(clip.url)
      if (c.ok) {
        paceNote.value = 'TTS 不可用，已回退配音'
        return
      }
      if (c.reason === 'cancelled') {
        paceNote.value = '已中断'
        return
      }
    }
    paceNote.value = `${r.error ?? 'TTS 不可用'}（定时器兜底）`
    return sleep(durationMs())
  }

  paceLabel.value = '⏱ 定时器'
  paceNote.value = clip ? '' : '该句无配音，定时器兜底'
  return sleep(durationMs())
}

let autoRunning = false
/**
 * 自动播放循环。
 *
 * 设计约束（血泪，见 docs/audio-stall-investigation.md）：`autoRunning` 一旦漏复位，
 * 后续所有「开始播放」都会因为 `if (!autoRunning)` 为假而再也起不来 ——
 * 表现就是「暂停后再点自动播放毫无反应」。所以这里三重保险：
 *   1. waitForPace 内部的播放会话可被 stopVoice() 主动结算（见 stageAudio.ts）
 *   2. **每一句**都有自己的硬超时（不是整个循环的超时，否则长播放会被误杀）
 *   3. finally 无条件复位 autoRunning
 */
const PACE_WATCHDOG_MS = 120_000
async function autoLoop(): Promise<void> {
  try {
    while (playing.value) {
      const a = action.value
      if (!a) break
      const token = navToken
      let timedOut = false
      let timer: number | undefined
      const guard = new Promise<void>((r) => {
        timer = window.setTimeout(() => {
          timedOut = true
          r()
        }, PACE_WATCHDOG_MS)
      })
      try {
        await Promise.race([waitForPace(a), guard])
      } finally {
        if (timer !== undefined) window.clearTimeout(timer)
      }
      if (timedOut) {
        // 节奏卡住也要能脱身：停掉声音、跳过这一句，继续往下走
        audio.stopVoice()
        paceNote.value = '节奏超时，已跳过'
      }
      // 等待期间用户手动导航/点击过 → 放弃本次自动推进
      if (token !== navToken || !playing.value) return
      next()
      await sleep(80)
    }
  } finally {
    autoRunning = false
  }
}

watch(playing, (v) => {
  if (v) {
    audio.unlock()
    if (!autoRunning) {
      autoRunning = true
      void autoLoop()
    }
  } else {
    navToken++
    audio.stopVoice()
    paceLabel.value = ''
    paceNote.value = ''
  }
})

watch([chapterIdx, offset], () => {
  clampOffset()
  startTyping()
  fxRuntime?.onPositionChange(fxPosition())
})

// P4：包视图替换（如脚本修订写回后）→ 重新注入运行时并重算范围/单句
watch(
  () => props.view,
  (v) => {
    fxRuntime?.setView(v)
    fxRuntime?.onPositionChange(fxPosition())
  }
)

// P4：背景 img / 占位 div 切换时合成目标会更换，需同步给运行时
watch(sceneElRef, (el) => fxRuntime?.setSceneEl(el))

/** 预解码下一句的场景图，避免切场景时闪白 */
watch(
  () => {
    const ch = chapter.value
    if (!ch) return null
    return props.view.actions[ch.start + offset.value + 1]?.locationId ?? null
  },
  (locId) => {
    if (!locId) return
    const u = lookups.value.sceneImageBySceneId.get(locId)
    if (u) {
      const img = new Image()
      img.src = u
    }
  }
)

// ---- 立绘放大模态 ----
const portraitModal = ref<{ characterId: string; index: number } | null>(null)
const modalChar = computed(() => {
  const m = portraitModal.value
  if (!m) return null
  return lookups.value.characterById.get(m.characterId) ?? null
})
const modalPortrait = computed(() => {
  const c = modalChar.value
  const m = portraitModal.value
  if (!c || !m) return null
  return c.portraits[m.index] ?? c.portraits[0] ?? null
})

function openPortrait(characterId: string): void {
  audio.unlock()
  portraitModal.value = { characterId, index: 0 }
}
function stepPortrait(delta: number): void {
  const m = portraitModal.value
  const n = modalChar.value?.portraits.length ?? 0
  if (!m || !n) return
  portraitModal.value = { characterId: m.characterId, index: (m.index + delta + n) % n }
}
function closePortrait(): void {
  portraitModal.value = null
}

// ---- 交互 ----
function onStageClick(): void {
  audio.unlock()
  if (!typingDone.value) {
    // 第一次点击：显全当前文本
    typer.finish()
    return
  }
  // 第二次点击：推进下一句（并停下自动播放，Galgame 常规行为）
  playing.value = false
  next()
}

function onKey(e: KeyboardEvent): void {
  if (e.target instanceof HTMLInputElement) return
  if (e.key === 'Escape') {
    // 分流：有立绘模态时先关模态，没有模态才退出全屏
    if (portraitModal.value) {
      closePortrait()
      return
    }
    if (fullScreen.value) void setFullScreen(false)
    return
  }
  if (portraitModal.value) return
  if (e.key === 'ArrowRight') {
    playing.value = false
    next()
  } else if (e.key === 'ArrowLeft') {
    playing.value = false
    prev()
  } else if (e.key === ' ') {
    // 与鼠标单击对话框完全一致（复用同一函数，避免两套逻辑漂移）
    e.preventDefault()
    onStageClick()
  } else if (e.key === 'v' || e.key === 'V') {
    playing.value = !playing.value
  } else if (e.key === 'F11') {
    // 实测 renderer 能收到 F11，且 preventDefault 可拦住系统默认全屏，故统一走 IPC
    e.preventDefault()
    void toggleFullScreen()
  }
}

const chapterOptions = computed<SearchOption[]>(() =>
  props.view.chapters.map((c, i) => ({ value: i, label: `${c.chapterSeq} · ${c.title}`, hint: `${c.count} 句` }))
)

onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('mousemove', onPointerMove)
  startTyping()
  // P4 特效运行时：挂载后即接入（overlay=特效层容器，scene=.stage-bg 合成目标）
  fxRuntime = new StageEffectRuntime({
    overlayEl: fxLayerRef.value?.rootEl ?? null,
    sceneEl: sceneElRef.value
  })
  fxRuntime.setView(props.view)
  fxRuntime.onPositionChange(fxPosition())
  void loadCatalog().then((r) => {
    if (r.entries) fxRuntime?.setCatalog(r.entries)
    if (!r.ok && r.error) console.warn('[fx] 特效目录不可用：', r.error)
    // 目录异步就绪后再应用一次（覆盖「挂载时该句已带特效」的情形）
    fxRuntime?.onPositionChange(fxPosition())
  })
  // 系统侧（F11 / 系统菜单）改了全屏也要同步按钮文案，故订阅主进程推送
  stopFullScreenSync = window.feather.onFullScreenChanged((on) => {
    fullScreen.value = on
  })
  // 首帧对齐：组件挂载时窗口可能已经是全屏态
  void window.feather
    .getFullScreen()
    .then((on) => {
      fullScreen.value = on
    })
    .catch(() => {
      fullScreen.value = false
    })
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('mousemove', onPointerMove)
  clearFsExitTimer()
  stopFullScreenSync?.()
  stopFullScreenSync = null
  typer.stop()
  audio.dispose()
  // P4：取消全部特效调度、清空特效层、场景变量复位为恒等（无残留节点 / 无卡死 timer）
  fxRuntime?.dispose()
  fxRuntime = null
})

defineExpose({
  next,
  prev,
  goChapter,
  chapterIdx,
  offset,
  playing,
  speed,
  showInfo,
  showChips,
  dialogHidden,
  zoom,
  setZoom,
  zoomBy,
  fullScreen,
  setFullScreen,
  toggleFullScreen,
  typingDone,
  finishTyping,
  shownText,
  openPortrait,
  portraitModal,
  paceLabel,
  paceNote
})
</script>

<template>
  <div class="stage-wrap" :class="{ 'is-fs': fullScreen }">
    <div class="stage-toolbar">
      <div class="chapter-pills">
        <button
          v-for="(c, i) in view.chapters"
          :key="c.chapterSeq"
          class="pill-btn"
          :class="{ active: i === chapterIdx }"
          :title="c.title"
          @click="goChapter(i)"
        >
          {{ c.chapterSeq }}
        </button>
      </div>
      <span class="spacer" />
      <span class="hint">
        第 {{ globalIndex }} / {{ view.actions.length }} 句 · 本章 {{ progress.index }}/{{ progress.total }}
      </span>
      <span v-if="paceLabel" class="chip pace-chip" :data-testid="'pace-' + paceLabel.slice(0, 2)">
        {{ paceLabel }}<template v-if="paceNote"> · {{ paceNote }}</template>
      </span>
      <span class="zoom-group">
        <button class="btn tiny" data-testid="zoom-out" title="缩小舞台" @click="zoomBy(-0.05)">－</button>
        <span class="zoom-val" data-testid="zoom-value">{{ zoom.toFixed(2) }}×</span>
        <button class="btn tiny" data-testid="zoom-in" title="放大舞台" @click="zoomBy(0.05)">＋</button>
        <button class="btn tiny" data-testid="zoom-reset" title="重置缩放" @click="setZoom(1)">⟲</button>
      </span>
      <button class="btn" data-testid="toggle-chips" @click="showChips = !showChips">
        {{ showChips ? '隐藏角标' : '显示角标' }}
      </button>
      <button class="btn" @click="showInfo = !showInfo">{{ showInfo ? '隐藏详情' : '显示详情' }}</button>
      <button class="btn" @click="showArt = !showArt">🎨 美术风格</button>
      <button
        class="btn"
        data-testid="toggle-fullscreen"
        :title="fullScreen ? '退出全屏（Esc / F11）' : '全屏演出（F11）'"
        @click="toggleFullScreen"
      >
        {{ fullScreen ? '⛶ 退出全屏' : '⛶ 全屏' }}
      </button>
    </div>

    <div v-if="showArt" class="art-panel">
      <div class="art-head">
        <strong>美术风格设定</strong>
        <span class="hint">本阶段仅展示，不发起任何生成请求</span>
        <span class="spacer" />
        <button class="btn" @click="showArt = false">关闭</button>
      </div>
      <div class="art-cols">
        <div class="art-col">
          <h4>角色立绘 · character-art-style（{{ view.artStyles.character.length }} 字）</h4>
          <pre class="art-text">{{ view.artStyles.character || '（无）' }}</pre>
        </div>
        <div class="art-col">
          <h4>场景图 · scene-art-style（{{ view.artStyles.scene.length }} 字）</h4>
          <pre class="art-text">{{ view.artStyles.scene || '（无）' }}</pre>
        </div>
      </div>
    </div>

    <!-- 舞台：尺寸恒等于宿主（背景铺满）。缩放比例只以 --ui-scale 下发给对话框与立绘，
         背景本身不参与缩放，因此放大时场景图固定不动 -->
    <div class="stage-zoom-host">
      <div
        class="stage"
        :class="{ 'is-battle': action?.type === 'battle', 'is-move': action?.type === 'move' }"
        :style="{ '--ui-scale': String(zoom) }"
        :data-zoom="zoom"
        data-testid="stage"
        @click="onStageClick"
        @contextmenu.prevent="dialogHidden = !dialogHidden"
      >
        <img v-if="bgUrl" ref="sceneElRef" class="stage-bg" :src="bgUrl" :alt="sceneLabel" data-testid="stage-bg" />
        <div v-else ref="sceneElRef" class="stage-bg stage-bg-missing" data-testid="stage-bg">
          <span>该场景无配图</span>
        </div>

        <!-- move：场景迁移过渡（独立元素，重挂载不影响背景图） -->
        <div v-if="moveInfo" :key="'mv-' + animKey" class="move-layer" :class="'mv-' + moveInfo.kind">
          <div class="move-sweep" />
          <div class="move-card">
            <template v-if="moveInfo.kind === 'full'">
              <span class="move-from">{{ moveInfo.from }}</span>
              <span class="move-arrow">⟶</span>
              <span class="move-to">{{ moveInfo.to }}</span>
            </template>
            <template v-else-if="moveInfo.kind === 'open'">
              <span class="move-from">{{ moveInfo.from }}</span>
              <span class="move-arrow">⟶</span>
              <span class="move-unknown">前往未知地点</span>
            </template>
            <template v-else-if="moveInfo.kind === 'arrive'">
              <span class="move-arrow">⟶</span>
              <span class="move-to">{{ moveInfo.to }}</span>
            </template>
            <template v-else>场景移动</template>
          </div>
        </div>

        <!-- battle：目标高亮 -->
        <div v-if="action?.type === 'battle'" :key="'bt-' + animKey" class="battle-layer">
          <div class="battle-flash" />
          <div class="battle-badge">⚔ 战斗</div>
          <div v-if="battleTargets.length" class="battle-targets">
            <div v-for="t in battleTargets" :key="t.id" class="battle-target">
              <img v-if="t.imageUrl" :src="t.imageUrl" :alt="t.name" />
              <div v-else class="bt-ph">{{ t.name.slice(0, 2) }}</div>
              <span class="bt-name">{{ t.name }}</span>
            </div>
          </div>
          <div v-else class="battle-badge sub">未指明目标</div>
        </div>

        <!-- P4 特效层：唯一新增舞台节点，位于 battle-layer 之后、portrait 之前（DOM 顺序保证层级） -->
        <EffectLayer ref="fxLayerRef" />

        <img
          v-if="portrait"
          class="stage-portrait"
          :class="{ 'is-speaker': !!speakerChar }"
          :src="portrait"
          :alt="speaker"
          data-testid="stage-portrait"
          title="点击查看该角色全部立绘"
          @click.stop="speakerChar && openPortrait(speakerChar.id)"
        />
        <div v-else-if="hasCharacterNoArt" class="stage-portrait ph-portrait">
          <span>{{ speaker }}</span>
          <small>无立绘</small>
        </div>

        <!-- 场景名：舞台正上方大字标题（暗金色，无表情符号；全屏时属于保留项） -->
        <div v-if="sceneLabel" class="scene-title" data-testid="scene-title">{{ sceneLabel }}</div>

        <!-- 全屏时只保留「地点」类角标（地点迁移），其余角标收起 -->
        <div v-if="showChips" class="stage-chips">
          <span v-if="speaker && !fullScreen" class="chip" :style="{ color: speakerColor }">🎭 {{ speaker }}</span>
          <span
            v-if="speakerChar?.importanceLevel && !fullScreen"
            class="chip level-chip"
            :style="{ borderColor: speakerColor }"
          >
            {{ speakerChar.importanceLevel }}
          </span>
          <span v-if="action?.fromLocationId || action?.toLocationId" class="chip">
            🧭 {{ lookups.sceneNameById.get(action?.fromLocationId ?? '') ?? action?.fromLocationId ?? '?' }}
            →
            {{ lookups.sceneNameById.get(action?.toLocationId ?? '') ?? action?.toLocationId ?? '?' }}
          </span>
          <span v-if="action?.targetIds?.length && !fullScreen" class="chip">🎯 {{ action.targetIds.join(', ') }}</span>
          <span v-if="dubbingClip && !fullScreen" class="chip ok-chip" data-testid="chip-dubbing">🔊 有配音</span>
        </div>

        <div
          v-if="!dialogHidden"
          class="stage-textbox"
          :class="['t-' + (action?.type ?? 'narration'), { 'dialog-transparent': settings?.dialogMode === 'transparent' }]"
          :data-testid="'dialog-' + (settings?.dialogMode ?? 'normal')"
        >
          <div v-if="action?.type === 'move'" class="speaker">🧭 场景移动</div>
          <div v-else-if="action?.type === 'battle'" class="speaker">⚔ 战斗</div>
          <div v-else-if="action?.type === 'say' && speaker" class="speaker" :style="{ color: speakerColor }">
            {{ speaker }}
          </div>
          <div v-else-if="action?.type === 'think' && speaker" class="speaker" :style="{ color: speakerColor }">
            {{ speaker }}（心声）
          </div>
          <p class="stage-text" data-testid="stage-text">
            <span v-if="isSpeech(action)">{{ shownText }}</span>
            <span v-else>{{ action?.text }}</span>
            <i v-if="isSpeech(action) && !typingDone" class="typing-caret" />
          </p>
        </div>
      </div>
    </div>

    <!-- 全屏悬浮退出按钮：属于「只留背景/立绘/对话框/地点」的破例项。
         放右上角避开 🎬 地点角标（左上）与对话框（底部）；静止 2s 后淡出 -->
    <button
      v-if="fullScreen"
      class="fs-exit"
      :class="{ 'is-idle': fsExitIdle }"
      data-testid="fs-exit"
      title="退出全屏（Esc / F11）"
      @click="setFullScreen(false)"
    >
      ⛶ 退出全屏
    </button>

    <!-- 立绘放大模态：全量 characterPortraits + 形象分组切换 -->
    <div v-if="portraitModal && modalChar" class="portrait-modal-mask" data-testid="portrait-modal" @click.self="closePortrait">
      <div class="portrait-modal" :style="{ '--role-color': roleColor(modalChar.importanceLevel, settings?.roleColors) }">
        <header class="pm-head">
          <strong data-testid="pm-name">{{ modalChar.name }}</strong>
          <span class="pm-level">{{ modalChar.importanceLevel || '未分级' }}</span>
          <span v-if="modalChar.aliases.length" class="pm-aliases">别名：{{ modalChar.aliases.join('、') }}</span>
          <span class="spacer" />
          <button class="btn tiny" data-testid="pm-prev" @click="stepPortrait(-1)">‹</button>
          <span class="pm-count" data-testid="pm-count">{{ portraitModal.index + 1 }} / {{ modalChar.portraits.length }}</span>
          <button class="btn tiny" data-testid="pm-next" @click="stepPortrait(1)">›</button>
          <button class="btn tiny" data-testid="pm-close" @click="closePortrait">✕</button>
        </header>
        <div class="pm-tabs" data-testid="pm-tabs">
          <button
            v-for="(p, i) in modalChar.portraits"
            :key="p.appearanceId"
            class="pm-tab"
            :class="{ active: i === portraitModal.index }"
            :data-testid="'pm-tab-' + i"
            @click="portraitModal = { characterId: portraitModal!.characterId, index: i }"
          >
            {{ p.name || p.appearanceId }}
          </button>
        </div>
        <div class="pm-body">
          <div class="pm-stage">
            <img v-if="modalPortrait?.imageUrl" :src="modalPortrait.imageUrl" :alt="modalPortrait.name" data-testid="pm-image" />
            <div v-else class="pm-noimg">该形象无配图</div>
          </div>
          <div class="pm-meta">
            <div class="pm-row"><label>形象</label><span>{{ modalPortrait?.name || '—' }}</span></div>
            <div class="pm-row"><label>性别</label><span>{{ modalPortrait?.sex || '未注明' }}</span></div>
            <div class="pm-row"><label> appearanceId </label><span>{{ modalPortrait?.appearanceId }}</span></div>
            <div class="pm-row"><label>剧本台词</label><span>{{ modalChar.actionCount }} 句</span></div>
            <div class="pm-block">
              <label>形象描述</label>
              <p>{{ modalPortrait?.appearanceSummary || '（无）' }}</p>
            </div>
            <div v-if="modalPortrait?.visualKeywords.length" class="pm-kw">
              <span v-for="k in modalPortrait.visualKeywords" :key="k" class="chip">{{ k }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="stage-controls">
      <button class="btn" title="上一句（←）" @click="prev" :disabled="!!(chapterIdx === 0 && offset === 0)">
        ← 上一句
      </button>
      <button class="btn primary" data-testid="autoplay" title="自动播放 / 暂停（V）" @click="playing = !playing">
        {{ playing ? '⏸ 暂停' : '▶ 自动播放' }}
      </button>
      <button class="btn" data-testid="next" title="下一句（→ 或 空格）" @click="next">下一句 →</button>
      <span class="spacer" />
      <label class="hint">速度</label>
      <select v-model.number="speed" class="select">
        <option :value="0.7">0.7x</option>
        <option :value="1">1.0x</option>
        <option :value="1.5">1.5x</option>
        <option :value="2">2.0x</option>
        <option :value="3">3.0x</option>
      </select>
      <SearchSelect :options="chapterOptions" :model-value="chapterIdx" @update:model-value="(v) => goChapter(Number(v))" />
    </div>

    <div class="stage-progress"><i :style="{ width: (progress.total ? (progress.index / progress.total) * 100 : 0) + '%' }" /></div>
  </div>
</template>

<style scoped>
.stage-zoom-host {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

/* 窗口级全屏：舞台外围 UI 全部收起，只留背景、立绘、对话框与地点角标。
   退出时移除 class 即完整还原原布局，不影响 zoom 状态。 */
.stage-wrap.is-fs {
  /* 真·铺满整个窗口：固定定位脱离文档流并盖住 App 顶栏与视图标签栏，
     否则全屏后顶部仍留一条导航，舞台到不了屏幕边缘。z-index 54 低于立绘模态(60)、
     高于普通内容；内部悬浮退出键 z-index 55 仍在其上。 */
  position: fixed;
  inset: 0;
  z-index: 54;
  background: var(--bg);
  padding-bottom: 0;
  gap: 0;
}

.stage-wrap.is-fs .stage-toolbar,
.stage-wrap.is-fs .art-panel,
.stage-wrap.is-fs .stage-controls,
.stage-wrap.is-fs .stage-progress {
  display: none;
}

/* 全屏悬浮退出按钮（破例项）：固定到窗口右上角，半透明小尺寸，不压画面。
   静止 2s 后淡出并停止接收点击，避免误触；鼠标一动即重新浮现。 */
.fs-exit {
  position: fixed;
  top: 14px;
  right: 14px;
  z-index: 55;
  padding: 5px 12px;
  font-size: 12px;
  line-height: 1.4;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: rgba(251, 247, 240, 0.75);
  color: var(--text);
  backdrop-filter: blur(3px);
  cursor: pointer;
  opacity: 1;
  transition: opacity 0.35s ease;
}

.fs-exit:hover {
  background: rgba(251, 247, 240, 0.95);
  color: #3a2e22;
}

.fs-exit.is-idle {
  opacity: 0;
  pointer-events: none;
}

.stage-portrait.is-speaker {
  cursor: zoom-in;
  pointer-events: auto;
}

.zoom-group {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.zoom-val {
  font-size: 12px;
  color: var(--muted);
  min-width: 44px;
  text-align: center;
}

.btn.tiny {
  padding: 3px 8px;
  font-size: 12px;
  border-radius: 6px;
}

.pace-chip {
  border-color: var(--accent);
  color: #b26b2a;
}

.ok-chip {
  border-color: rgba(78, 154, 95, 0.55);
  color: #2f6b40;
}

.level-chip {
  font-size: 10px;
  letter-spacing: 0.5px;
}

.typing-caret {
  display: inline-block;
  width: 14px;
  height: 27px;
  margin-left: 4px;
  background: #b26b2a;
  vertical-align: -2px;
  animation: caret-blink 0.9s steps(2, start) infinite;
}

@keyframes caret-blink {
  to {
    visibility: hidden;
  }
}

/* 透明对话框：保留可读性但大幅降低遮挡 */
.stage-textbox.dialog-transparent {
  background: rgba(251, 247, 240, 0.4);
  border-color: rgba(201, 183, 158, 0.6);
  backdrop-filter: blur(1px);
}

/* ---------- 立绘放大模态 ---------- */
.portrait-modal-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(43, 33, 22, 0.78);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 28px;
}

.portrait-modal {
  width: min(880px, 94vw);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--border);
  border-top: 3px solid var(--role-color, var(--accent));
  border-radius: 14px;
  overflow: hidden;
}

.pm-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  font-size: 14px;
}

.pm-head strong {
  color: var(--role-color, var(--text));
}

.pm-level {
  font-size: 10px;
  letter-spacing: 1px;
  border: 1px solid var(--role-color, var(--border));
  color: var(--role-color, var(--muted));
  border-radius: 999px;
  padding: 1px 8px;
}

.pm-aliases {
  font-size: 11px;
  color: var(--muted);
}

.pm-count {
  font-size: 12px;
  color: var(--muted);
  min-width: 44px;
  text-align: center;
}

.pm-tabs {
  display: flex;
  gap: 6px;
  padding: 10px 16px 0;
  flex-wrap: wrap;
}

.pm-tab {
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--muted);
  border-radius: 999px;
  padding: 3px 12px;
  font-size: 12px;
}

.pm-tab.active {
  border-color: var(--role-color, var(--accent));
  color: var(--text);
  background: var(--accent-soft);
}

.pm-body {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
  gap: 16px;
  padding: 14px 16px 18px;
  min-height: 0;
  overflow: auto;
}

.pm-stage {
  background: #e9decb;
  border: 1px solid var(--border);
  border-radius: 10px;
  min-height: 300px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.pm-stage img {
  max-width: 100%;
  max-height: 52vh;
  object-fit: contain;
}

.pm-noimg {
  color: var(--muted);
  font-size: 13px;
}

.pm-meta {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.pm-row {
  display: flex;
  gap: 10px;
  font-size: 13px;
}

.pm-row label {
  color: var(--muted);
  flex: none;
  width: 76px;
}

.pm-row span {
  min-width: 0;
  word-break: break-all;
}

.pm-block label {
  display: block;
  color: var(--muted);
  font-size: 12px;
  margin-bottom: 2px;
}

.pm-block p {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  max-height: 180px;
  overflow: auto;
}

.pm-kw {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
</style>

<script setup lang="ts">
/**
 * 沉浸式漫画阅读器（M1-R）。
 *
 * 【为什么需要它】原先「漫画阅读」只有三栏布局（导航 216px + 画布 + 台词 340px），
 * 顶栏点「全屏」只是把窗口放大 —— 三栏照旧，页面图又被 `max-height: calc(100vh-230px)`
 * 压成一条竖带。2560×1440 的屏上图片实际只有约 780px 宽，这就是「全屏后只有一小部分」。
 *
 * 【设计】这是一个 `position: fixed; inset: 0` 的覆盖层（与 StageView 全屏同一套既有做法），
 * 不依赖、也不改动 App 的侧栏/顶栏布局：打开时铺满整个窗口，关闭时摘掉 DOM 即完整还原。
 *
 * 【双模式】用户拍板要两种：
 *   - 一页：整页图 contain 铺满，保留分镜热区框（可关）；
 *   - 一格：只放大当前分镜 —— 按 rect 直接裁剪，**接受相邻格边缘露出的瑕疵**
 *     （实测 gmzz-10 的分镜 rect 并不互斥：第 1、2 格 y 向重叠 0.054，第 3、4 格 x 向重叠 0.055。
 *      做中位分割会把用户要的「一格」裁掉一块，所以按用户口径直接裁）。
 *
 * 【台词】放在**底部中间**（玻璃拟态浮层），不再占一整栏。两种模式共用同一个
 * 「台词游标」：台词推进到哪，就聚焦到哪一格；一格模式下画面跟着切。
 *
 * 【选项不挤在一屏】设置做成**从底部上滑的抽屉**，内容纵向滚动 —— 选项以后还会长，
 * 一次塞进侧栏会重演「界面挤爆」的老问题。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { MangaChapter, MangaPanel, MangaPage, MangaSpeech, MangaViewData } from '../../../shared/manga-types'

const props = defineProps<{
  data: MangaViewData
  /** 进入时的章索引（chapters 下标） */
  startChapter?: number
  /** 进入时的页索引（当前章 pages 下标） */
  startPage?: number
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

/** 阅读模式：page = 一整页；panel = 单格放大 */
type Mode = 'page' | 'panel'
/** 阅读方向：ltr = 左到右翻页；rtl = 右到左（日漫） */
type Dir = 'ltr' | 'rtl'

const MODE_KEY = 'dw.mangaReader.v1'

interface Prefs {
  mode: Mode
  dir: Dir
  showFrames: boolean
  showSpeech: boolean
  autoPlay: boolean
  /** 自动播放每句停留毫秒 */
  autoMs: number
  speechScale: number
  bgmOn: boolean
  bgmVolume: number
}
const DEFAULT_PREFS: Prefs = {
  mode: 'page',
  dir: 'ltr',
  showFrames: true,
  showSpeech: true,
  autoPlay: false,
  autoMs: 4000,
  speechScale: 1,
  bgmOn: false,
  bgmVolume: 0.35
}

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(MODE_KEY)
    if (!raw) return { ...DEFAULT_PREFS }
    const o = JSON.parse(raw) as Partial<Prefs>
    // 逐字段校验，避免旧版本残留值把 UI 带进非法态
    return {
      mode: o.mode === 'panel' ? 'panel' : 'page',
      dir: o.dir === 'rtl' ? 'rtl' : 'ltr',
      showFrames: typeof o.showFrames === 'boolean' ? o.showFrames : DEFAULT_PREFS.showFrames,
      showSpeech: typeof o.showSpeech === 'boolean' ? o.showSpeech : DEFAULT_PREFS.showSpeech,
      autoPlay: typeof o.autoPlay === 'boolean' ? o.autoPlay : DEFAULT_PREFS.autoPlay,
      autoMs: typeof o.autoMs === 'number' && o.autoMs >= 1000 ? o.autoMs : DEFAULT_PREFS.autoMs,
      speechScale: typeof o.speechScale === 'number' && o.speechScale >= 0.8 && o.speechScale <= 2 ? o.speechScale : 1,
      bgmOn: typeof o.bgmOn === 'boolean' ? o.bgmOn : DEFAULT_PREFS.bgmOn,
      bgmVolume: typeof o.bgmVolume === 'number' && o.bgmVolume >= 0 && o.bgmVolume <= 1 ? o.bgmVolume : DEFAULT_PREFS.bgmVolume
    }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

const prefs = ref<Prefs>(loadPrefs())
watch(
  prefs,
  (v) => {
    try {
      localStorage.setItem(MODE_KEY, JSON.stringify(v))
    } catch {
      /* 存储不可用不影响阅读 */
    }
  },
  { deep: true }
)

// ---- 定位状态 ----
const chIdx = ref(Math.min(Math.max(props.startChapter ?? 0, 0), Math.max(props.data.chapters.length - 1, 0)))
const pageIdx = ref(props.startPage ?? 0)
/** 台词游标（当前页扁平台词列表下标） */
const cursor = ref(0)
/** 设置抽屉开合 */
const drawerOpen = ref(false)
/** 破图标记 */
const broken = ref<Set<string>>(new Set())

const chapter = computed<MangaChapter | null>(() => props.data.chapters[chIdx.value] ?? null)
const page = computed<MangaPage | null>(() => chapter.value?.pages[pageIdx.value] ?? null)

/** 当前页的扁平台词列表（带所属分镜），是两种模式共同的推进单位 */
interface Cue {
  panel: MangaPanel
  panelIdx: number
  speech: MangaSpeech
  /** 该句在本页内的全局序号（1 起） */
  no: number
}
const cues = computed<Cue[]>(() => {
  const p = page.value
  if (!p) return []
  const out: Cue[] = []
  p.panels.forEach((pn, pi) => {
    for (const sp of pn.speech) out.push({ panel: pn, panelIdx: pi, speech: sp, no: out.length + 1 })
  })
  return out
})

const cue = computed<Cue | null>(() => cues.value[cursor.value] ?? null)
/** 当前聚焦的分镜：优先台词所属格；本页无台词时退回第 1 格 */
const focusPanel = computed<MangaPanel | null>(() => cue.value?.panel ?? page.value?.panels[0] ?? null)
const focusPanelIdx = computed<number>(() => {
  if (cue.value) return cue.value.panelIdx
  return 0
})

/** 全库页数 / 当前全局页号（顶栏进度显示） */
const totalPages = computed(() => props.data.chapters.reduce((a, c) => a + c.pages.length, 0))
const globalPageNo = computed(() => {
  let n = 0
  for (let i = 0; i < chIdx.value; i++) n += props.data.chapters[i].pages.length
  return n + pageIdx.value + 1
})

/** 当前页是否为最后一页 / 最后一章（翻页按钮禁用判断） */
const atFirstPage = computed(() => globalPageNo.value <= 1)
const atLastPage = computed(() => globalPageNo.value >= totalPages.value)

// ---- 一格模式的裁剪尺寸（按容器实测像素算，不用 aspect-ratio 猜）----
const stageEl = ref<HTMLElement | null>(null)
const stageW = ref(0)
const stageH = ref(0)
/** 当前页图原始像素（由**隐藏预加载图**提供，可见图不负责这件事） */
const natural = ref<{ w: number; h: number } | null>(null)

/**
 * 页面宽高比（w/h）。
 *
 * 为什么需要兜底：一格容器的尺寸要按「rect × 页面宽高比」算，
 * 但 `natural` 是预加载图 onload 之后才有的。若让容器尺寸依赖它，
 * 首帧会是 0×0（图看不见），必须给一个合理默认值先把画面撑起来，
 * 等预加载完成再用真实比例替换。0.75 取自本仓漫画页的常见比例（1024×1536 竖版）。
 */
const PAGE_ASPECT_FALLBACK = 0.75
const pageAspect = computed(() => {
  const n = natural.value
  if (!n || !n.w || !n.h) return PAGE_ASPECT_FALLBACK
  return n.w / n.h
})

/**
 * 一格容器的像素尺寸：把「rect 区域」等比放大到舞台可用区内。
 *
 * 只需要**比例**，不需要绝对像素，所以用 `pageAspect` 归一化即可 ——
 * 这样即使预加载图还没回来也能立刻算出正确布局，不会出现 0×0。
 *
 * `PANEL_GUTTER`：四周留一点边距，不要顶到屏幕边缘。
 * 满幅铺满时单格的长边会直接贴住视口边界，看起来「比例怪、像被裁掉」；
 * 留出约 2.5% 的呼吸位后，画面更像一张独立的画框。
 */
const PANEL_GUTTER = 0.95
const panelBox = computed<{ width: number; height: number } | null>(() => {
  const r = focusPanel.value?.rect
  if (!r || !stageW.value || !stageH.value) return null
  const pw = r.width * pageAspect.value
  const ph = r.height
  if (pw <= 0 || ph <= 0) return null
  const k = Math.min(stageW.value / pw, stageH.value / ph)
  return {
    width: Math.max(1, Math.round(pw * k * PANEL_GUTTER)),
    height: Math.max(1, Math.round(ph * k * PANEL_GUTTER))
  }
})

/**
 * 图在一格容器内的摆放（宽=容器宽/rect.w，再按比例偏移，使 rect 区域正好铺满容器）。
 *
 * ⚠️ 这里**只能用 rect**，不能依赖 `natural`。
 * 曾经写成 `if (!r || !panelBox.value) return null`，而 `panelBox` 依赖 `natural`、
 * `natural` 又由这张图的 `@load` 提供 —— 图片不渲染就不会 load，永远拿不到尺寸，
 * 结果一格模式恒显示「缺少区域数据」。改为只依赖 rect，尺寸由隐藏预加载图提供。
 */
const panelImgStyle = computed<Record<string, string> | null>(() => {
  const r = focusPanel.value?.rect
  if (!r || r.width <= 0 || r.height <= 0) return null
  return {
    position: 'absolute',
    width: `${100 / r.width}%`,
    left: `${(-r.x * 100) / r.width}%`,
    top: `${(-r.y * 100) / r.height}%`
  }
})

/** 舞台尺寸跟踪：窗口缩放 / 抽屉开合 / 模式切换都要重算 */
let ro: ResizeObserver | null = null
function measure(): void {
  const el = stageEl.value
  if (!el) return
  const box = el.getBoundingClientRect()
  stageW.value = Math.max(0, Math.floor(box.width))
  stageH.value = Math.max(0, Math.floor(box.height))
}

/** 分镜热区样式：rect 0..1 → 百分比 */
function frameStyle(pn: MangaPanel): Record<string, string> {
  const r = pn.rect
  if (!r) return { display: 'none' }
  return {
    left: `${r.x * 100}%`,
    top: `${r.y * 100}%`,
    width: `${r.width * 100}%`,
    height: `${r.height * 100}%`
  }
}

// ---- 导航 ----
function gotoPage(ci: number, pi: number): void {
  const ch = props.data.chapters[ci]
  if (!ch) return
  chIdx.value = ci
  pageIdx.value = Math.min(Math.max(pi, 0), Math.max(ch.pages.length - 1, 0))
  cursor.value = 0
  natural.value = null
}

function prevPage(): void {
  if (pageIdx.value > 0) {
    gotoPage(chIdx.value, pageIdx.value - 1)
    return
  }
  if (chIdx.value > 0) {
    const ci = chIdx.value - 1
    gotoPage(ci, props.data.chapters[ci].pages.length - 1)
  }
}

function nextPage(): void {
  const ch = chapter.value
  if (!ch) return
  if (pageIdx.value < ch.pages.length - 1) {
    gotoPage(chIdx.value, pageIdx.value + 1)
    return
  }
  if (chIdx.value < props.data.chapters.length - 1) gotoPage(chIdx.value + 1, 0)
}

/** 前进到下一句台词；本页台词读完后自动翻页。一格模式与一页模式共用。 */
function nextCue(): void {
  if (cursor.value < cues.value.length - 1) {
    cursor.value++
    return
  }
  nextPage()
}

function prevCue(): void {
  if (cursor.value > 0) {
    cursor.value--
    return
  }
  // 回上一页并停在最后一句
  prevPage()
  nextTick(() => {
    cursor.value = Math.max(0, cues.value.length - 1)
  })
}

// ---- 自动播放 ----
let autoTimer: number | null = null
function clearAuto(): void {
  if (autoTimer !== null) {
    window.clearTimeout(autoTimer)
    autoTimer = null
  }
}
function scheduleAuto(): void {
  clearAuto()
  if (!prefs.value.autoPlay) return
  autoTimer = window.setTimeout(() => {
    if (atLastPage.value && cursor.value >= cues.value.length - 1) {
      prefs.value.autoPlay = false
      return
    }
    nextCue()
    scheduleAuto()
  }, prefs.value.autoMs)
}
watch(
  () => [prefs.value.autoPlay, prefs.value.autoMs, cursor.value, chIdx.value, pageIdx.value],
  () => scheduleAuto()
)

// ---- 配乐（BGM） ----
/**
 * 配乐取自章级 `chapter.music.url`。
 *
 * 包内通常**只有元数据、没有音频文件**（gmzz-10 实测：10 章只有 1 章有配乐，
 * 值里是 `music.tftgamer.com` 的 mp3 直链，CC-BY-3.0 署名随包自带）。
 * 因此这是**在线拉取**：默认不开，用户点了才发请求（保持「不静默联网」的既有原则）。
 * 播放器直接用 `<audio>` 播直链，同时兼容网易云外链（`music.163.com` 样式）。
 */
const bgmEl = ref<HTMLAudioElement | null>(null)
const bgmState = ref<'off' | 'loading' | 'playing' | 'error'>('off')
const bgmError = ref('')

const bgmTrack = computed(() => chapter.value?.music ?? null)
const bgmUrl = computed(() => (bgmTrack.value?.url ?? '').trim())

function syncBgm(): void {
  const el = bgmEl.value
  if (!el) return
  el.volume = prefs.value.bgmVolume
  const url = bgmUrl.value
  if (!prefs.value.bgmOn || !url) {
    el.pause()
    bgmState.value = 'off'
    return
  }
  if (el.src !== url) {
    el.src = url
    bgmState.value = 'loading'
  }
  void el.play().then(
    () => {
      bgmState.value = 'playing'
      bgmError.value = ''
    },
    (e: unknown) => {
      bgmState.value = 'error'
      bgmError.value = (e as Error)?.message ?? '播放被拒绝'
    }
  )
}
watch(() => [prefs.value.bgmOn, prefs.value.bgmVolume, bgmUrl.value], syncBgm)
watch(chIdx, () => nextTick(syncBgm))

// ---- 窗口级全屏 ----
/**
 * 打开阅读器即请求窗口全屏 —— 这正是用户要的「全屏应该是漫画全屏」：
 * 覆盖层负责铺满可视区，窗口全屏负责连系统标题栏一起去掉。
 * 关闭时**只在是自己开的**前提下还原，避免把用户原本的全屏态关掉。
 */
const weEnteredFullScreen = ref(false)
async function enterWindowFullScreen(): Promise<void> {
  try {
    const before = await window.feather.getFullScreen()
    if (before) return
    const r = await window.feather.setFullScreen(true)
    weEnteredFullScreen.value = r.ok && r.fullScreen
  } catch {
    /* 全屏失败不影响阅读 */
  }
}
async function restoreWindowFullScreen(): Promise<void> {
  if (!weEnteredFullScreen.value) return
  weEnteredFullScreen.value = false
  try {
    await window.feather.setFullScreen(false)
  } catch {
    /* 忽略 */
  }
}

// ---- 关闭 ----
async function close(): Promise<void> {
  clearAuto()
  if (bgmEl.value) bgmEl.value.pause()
  await restoreWindowFullScreen()
  emit('close')
}

// ---- 键盘 ----
/**
 * 交互口径（用户拍板，2026-11-04）：
 *   - **空格 / 鼠标左键点画面任意位置 = 向前**（一格模式推进台词，一页模式翻页）；
 *   - **上一页不放在画面上**，收进「阅读选项」抽屉 —— 避免按钮常驻挡画；
 *   - **A 键切换自动播放**（a = auto，单键好按，不与方向/空格冲突）；
 *   - Esc 收起抽屉 / 退出。
 * 方向键保留为可选快捷方式（日漫方向会镜像左右）。
 */
function onKey(e: KeyboardEvent): void {
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return

  if (e.key === 'Escape') {
    e.preventDefault()
    if (drawerOpen.value) drawerOpen.value = false
    else void close()
    return
  }
  // 自动播放开关：A 键。用 key.toLowerCase() 兼容 CapsLock / 中文输入法以外的大写输入
  if (e.key.toLowerCase() === 'a' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault()
    prefs.value.autoPlay = !prefs.value.autoPlay
    return
  }
  if (e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault()
    // 空格在自动播放进行中时 = 暂停；未播放时 = 前进一步（阅读漫画最高频的两个动作）
    if (prefs.value.autoPlay) prefs.value.autoPlay = false
    else advance()
    return
  }
  // 方向键：左右按阅读方向前进/回退；上下也是前进/回退
  const fwd = prefs.value.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight'
  const backKey = prefs.value.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft'
  if (e.key === fwd || e.key === 'ArrowDown') {
    e.preventDefault()
    advance()
    return
  }
  if (e.key === backKey || e.key === 'ArrowUp') {
    e.preventDefault()
    retreat()
    return
  }
}

/**
 * 统一的「向前」动作：一格模式推进台词，一页模式翻页。
 * 鼠标点击与空格都走这里，保证两条路径行为完全一致。
 */
function advance(): void {
  if (prefs.value.mode === 'panel') nextCue()
  else nextPage()
}

/**
 * 统一的「回退」动作：一格模式回退台词，一页模式回上一页。
 *
 * ⚠️ 不能取名 `back` —— 那是 `window.history.back` 的全局同名标识符，
 * 在 `<script setup>` 里声明会与之冲突（TS2349：表达式不可调用）。
 */
function retreat(): void {
  if (prefs.value.mode === 'panel') prevCue()
  else prevPage()
}

/** 舞台点击：左键=向前；右键=回退（不进抽屉也能退，但不占界面） */
function onStageClick(e: MouseEvent): void {
  if (e.button !== 0) return
  advance()
}
function onStageContextMenu(e: MouseEvent): void {
  e.preventDefault()
  retreat()
}

// ---- 生命周期 ----
function onImgLoad(e: Event): void {
  const img = e.target as HTMLImageElement
  natural.value = { w: img.naturalWidth, h: img.naturalHeight }
  void nextTick(measure)
}
function onImgError(key: string): void {
  const s = new Set(broken.value)
  s.add(key)
  broken.value = s
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  ro = new ResizeObserver(() => measure())
  if (stageEl.value) ro.observe(stageEl.value)
  void nextTick(measure)
  void enterWindowFullScreen()
  // 进入即有图，触发一次测量；无图时占位不依赖尺寸
  window.setTimeout(measure, 120)
  scheduleAuto()
})

onUnmounted(() => {
  clearAuto()
  window.removeEventListener('keydown', onKey)
  if (ro) {
    ro.disconnect()
    ro = null
  }
  if (bgmEl.value) bgmEl.value.pause()
})

/** 点分镜热区 → 把台词游标移到该格的第一句（该格无台词则不动） */
function focusOnPanel(pn: MangaPanel): void {
  const i = cues.value.findIndex((c) => c.panel.no === pn.no)
  if (i >= 0) cursor.value = i
}

/** 章节标题 */
function chapterLabel(ch: MangaChapter): string {
  return ch.title || `第 ${ch.chapterSeq} 章`
}
</script>

<template>
  <div class="mr-root" :class="['mr-dir-' + prefs.dir]" data-testid="manga-reader">
    <!-- ===== 顶部：进度 + 退出（鼠标静止淡出） ===== -->
    <div class="mr-top">
      <div class="mr-top-left">
        <span class="mr-ch">{{ chapter ? chapterLabel(chapter) : '' }}</span>
        <span class="mr-dot">·</span>
        <span class="mr-page">第 {{ page?.no ?? 0 }} 页</span>
        <span class="mr-count">（{{ globalPageNo }} / {{ totalPages }}）</span>
        <span v-if="prefs.mode === 'panel' && cue" class="mr-cue">第 {{ focusPanel?.no }} 格 · {{ cue.no }}/{{ cues.length }} 句</span>
      </div>
      <div class="mr-top-right">
        <button class="mr-btn" data-testid="mr-open-drawer" @click="drawerOpen = !drawerOpen">
          {{ drawerOpen ? '收起点选项' : '⚙ 阅读选项' }}
        </button>
        <button class="mr-btn" data-testid="mr-close" @click="close">✕ 退出</button>
      </div>
    </div>

    <!-- ===== 舞台（点画面任意位置向前翻） ===== -->
    <div
      ref="stageEl"
      class="mr-stage"
      :class="{ 'is-panel': prefs.mode === 'panel' }"
      data-testid="mr-stage"
      @click="onStageClick"
      @contextmenu="onStageContextMenu"
    >
      <template v-if="page?.imageUrl && !broken.has(page.key)">
        <!-- 一页模式：整页 contain -->
        <div v-if="prefs.mode === 'page'" class="mr-page-wrap">
          <img
            class="mr-page-img"
            data-testid="mr-page-img"
            :src="page.imageUrl"
            :alt="`第 ${page.no} 页`"
            draggable="false"
            @load="onImgLoad"
            @error="onImgError(page!.key)"
          />
          <template v-if="prefs.showFrames">
            <button
              v-for="(pn, pi) in page.panels"
              :key="pn.no"
              class="mr-frame"
              :class="{ active: pi === focusPanelIdx }"
              :style="frameStyle(pn)"
              :title="`第 ${pn.no} 格`"
              @click="focusOnPanel(pn)"
            >
              <span class="mr-frame-no">{{ pn.no }}</span>
            </button>
          </template>
        </div>

        <!-- 一格模式：按 rect 直接裁剪放大 -->
        <div v-else class="mr-panel-wrap" data-testid="mr-panel-wrap" :style="panelBox ? { width: panelBox.width + 'px', height: panelBox.height + 'px' } : {}">
          <img
            v-if="panelImgStyle"
            class="mr-panel-img"
            data-testid="mr-panel-img"
            :src="page.imageUrl"
            :alt="`第 ${focusPanel?.no} 格`"
            :style="panelImgStyle"
            draggable="false"
            @error="onImgError(page!.key)"
          />
          <div v-else class="mr-panel-hint">该分镜缺少区域数据，暂无法单格显示</div>
        </div>
      </template>

      <div v-else class="mr-empty">
        <div class="mr-empty-ico">🖼️</div>
        <div class="mr-empty-title">{{ page?.imageUrl ? '插图加载失败' : '本页无插图' }}</div>
        <div v-if="page?.context" class="mr-empty-ctx">{{ page.context }}</div>
        <div class="mr-empty-hint">台词仍可在下方阅读</div>
      </div>
    </div>

    <!-- ===== 底部台词：**只有文字** ===== -->
    <div
      v-if="prefs.showSpeech && cue"
      class="mr-dialog"
      data-testid="mr-dialog"
      :style="{ fontSize: `calc(17px * ${prefs.speechScale})` }"
    >
      <span v-if="cue.speech.speaker" class="mr-dialog-speaker">{{ cue.speech.speaker }}：</span>
      <span class="mr-dialog-text" data-testid="mr-dialog-text">{{ cue.speech.text }}</span>
    </div>

    <div v-else-if="prefs.showSpeech && !cue" class="mr-dialog mr-dialog-empty" data-testid="mr-dialog">
      <span>本页没有台词数据</span>
    </div>

    <!-- ===== 设置抽屉（底部上滑、纵向滚动） ===== -->
    <transition name="mr-sheet">
      <div v-if="drawerOpen" class="mr-drawer" data-testid="mr-drawer">
        <div class="mr-drawer-head">
          <span>阅读选项</span>
          <button class="mr-btn small" @click="drawerOpen = false">收起</button>
        </div>
        <div class="mr-drawer-body">
          <!-- 翻页：画面上不放按钮，全部收在这里 -->
          <section class="mr-sec">
            <h4>翻页</h4>
            <div class="mr-nav-row">
              <button class="mr-nav-btn" :disabled="atFirstPage" data-testid="mr-prev" @click="prevPage">
                上一页
              </button>
              <span class="mr-nav-pos">{{ globalPageNo }} / {{ totalPages }}</span>
              <button class="mr-nav-btn" :disabled="atLastPage" data-testid="mr-next" @click="nextPage">
                下一页
              </button>
            </div>
            <p class="mr-tip">
              画面上不放翻页按钮：点画面任意位置或按空格即向前，右键回退。
              一格模式下「向前」是推进到下一句台词（自动切到所属分镜）。
            </p>
          </section>

          <!-- 模式 -->
          <section class="mr-sec">
            <h4>阅读模式</h4>
            <div class="mr-seg" data-testid="mr-mode">
              <button :class="{ on: prefs.mode === 'page' }" data-testid="mr-mode-page" @click="prefs.mode = 'page'">
                一页一个
              </button>
              <button :class="{ on: prefs.mode === 'panel' }" data-testid="mr-mode-panel" @click="prefs.mode = 'panel'">
                一格一个
              </button>
            </div>
            <p class="mr-tip">
              一页一个：整页铺满，看整体排版。一格一个：只放大当前分镜，台词推进到哪就切到哪一格。
            </p>
          </section>

          <!-- 方向 -->
          <section class="mr-sec">
            <h4>阅读方向</h4>
            <div class="mr-seg">
              <button :class="{ on: prefs.dir === 'ltr' }" @click="prefs.dir = 'ltr'">左 → 右</button>
              <button :class="{ on: prefs.dir === 'rtl' }" @click="prefs.dir = 'rtl'">右 → 左（日漫）</button>
            </div>
          </section>

          <!-- 显示项 -->
          <section class="mr-sec">
            <h4>显示</h4>
            <label class="mr-row">
              <input v-model="prefs.showFrames" type="checkbox" data-testid="mr-show-frames" />
              <span>显示分镜框（仅一页模式）</span>
            </label>
            <label class="mr-row">
              <input v-model="prefs.showSpeech" type="checkbox" data-testid="mr-show-speech" />
              <span>显示底部台词</span>
            </label>
            <label class="mr-row">
              <span class="mr-row-label">台词字号</span>
              <input v-model.number="prefs.speechScale" type="range" min="0.8" max="2" step="0.1" />
              <span class="mr-row-val">{{ Math.round(prefs.speechScale * 100) }}%</span>
            </label>
          </section>

          <!-- 自动播放 -->
          <section class="mr-sec">
            <h4>自动播放</h4>
            <label class="mr-row">
              <input v-model="prefs.autoPlay" type="checkbox" data-testid="mr-autoplay" />
              <span>自动推进台词</span>
            </label>
            <label class="mr-row">
              <span class="mr-row-label">每句停留</span>
              <input v-model.number="prefs.autoMs" type="range" min="1500" max="12000" step="500" />
              <span class="mr-row-val">{{ (prefs.autoMs / 1000).toFixed(1) }}s</span>
            </label>
          </section>

          <!-- 配乐 -->
          <section class="mr-sec">
            <h4>背景配乐</h4>
            <div class="mr-bgm-info">
              <template v-if="bgmTrack">
                <b>{{ bgmTrack.title }}</b>
                <span class="mr-muted"> — {{ bgmTrack.author }}</span>
                <div class="mr-attribution">{{ bgmTrack.attribution }}</div>
              </template>
              <span v-else class="mr-muted">本章没有配乐数据</span>
            </div>
            <label class="mr-row">
              <input v-model="prefs.bgmOn" type="checkbox" :disabled="!bgmUrl" data-testid="mr-bgm" />
              <span>播放本章配乐</span>
            </label>
            <p class="mr-tip">
              包内只有曲目元数据与在线直链，没有音频文件。开启后会**向外部地址发起请求**在线拉取，
              因此默认关闭 —— 不静默联网。许可与署名随包自带，展示在下方。
            </p>
            <label class="mr-row">
              <span class="mr-row-label">音量</span>
              <input v-model.number="prefs.bgmVolume" type="range" min="0" max="1" step="0.05" />
              <span class="mr-row-val">{{ Math.round(prefs.bgmVolume * 100) }}%</span>
            </label>
            <div v-if="bgmError" class="mr-err">{{ bgmError }}</div>
          </section>

          <!-- 快捷键 -->
          <section class="mr-sec">
            <h4>操作</h4>
            <ul class="mr-keys">
              <li><kbd>鼠标左键</kbd> 点画面任意位置 → 向前</li>
              <li><kbd>鼠标右键</kbd> → 回退</li>
              <li><kbd>空格</kbd> 向前；自动播放中则暂停</li>
              <li><kbd>A</kbd> 切换自动播放</li>
              <li><kbd>←</kbd> <kbd>→</kbd> <kbd>↑</kbd> <kbd>↓</kbd> 前进 / 回退</li>
              <li><kbd>Esc</kbd> 收起选项 / 退出阅读器</li>
            </ul>
          </section>
        </div>
      </div>
    </transition>

    <!-- 隐藏预加载图：唯一职责是提供当前页的原始像素尺寸（natural）。
         一格模式的容器比例依赖它；可见图不能兼任，否则会形成
         「图要尺寸才渲染、尺寸要图渲染才有」的死锁。 -->
    <img
      v-if="page?.imageUrl && !broken.has(page.key)"
      class="mr-preload"
      data-testid="mr-preload"
      :src="page.imageUrl"
      alt=""
      aria-hidden="true"
      @load="onImgLoad"
      @error="onImgError(page!.key)"
    />

    <!-- BGM 播放器（不进入布局） -->
    <audio ref="bgmEl" class="mr-audio" data-testid="mr-bgm-audio" preload="none" loop></audio>
  </div>
</template>

<style scoped>
.mr-root {
  position: fixed;
  inset: 0;
  z-index: 58;
  display: flex;
  flex-direction: column;
  background: #14110e;
  color: #f2ece2;
  /* 覆盖层自带字体层级，不受 App 主题影响 */
  font-family: inherit;
}

/* 顶部进度条：常态半透明，不抢画面 */
.mr-top {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  font-size: 12.5px;
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0));
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 3;
}
.mr-top-left {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
}
.mr-ch {
  font-weight: 600;
}
.mr-dot,
.mr-count {
  opacity: 0.65;
}
.mr-cue {
  margin-left: 8px;
  padding: 1px 8px;
  border-radius: 999px;
  background: rgba(217, 151, 76, 0.22);
  border: 1px solid rgba(217, 151, 76, 0.5);
  font-size: 11px;
}
.mr-top-right {
  display: flex;
  gap: 8px;
  flex: none;
}

.mr-btn {
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.08);
  color: #f2ece2;
  padding: 5px 12px;
  border-radius: 999px;
  font-size: 12px;
  cursor: pointer;
  backdrop-filter: blur(6px);
  transition: background 0.15s ease;
}
.mr-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.16);
}
.mr-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.mr-btn.small {
  padding: 3px 10px;
  font-size: 11.5px;
}

/* 舞台：绝对铺满，台词/顶栏浮在上面 */
.mr-stage {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  /*
   * 上下留出顶栏与台词栏的**空间**，左右留一点边距 ——
   * 竖版页在宽屏上按高度撑满时，宽度本来就有富余，加左右 padding 只是让
   * 整页不贴屏幕边缘（用户反馈「比例有点怪，两边留一点点小边框」）。
   */
  padding: 52px 24px 110px;
  box-sizing: border-box;
  /* 整块画面都是点击区：左键向前、右键回退 */
  cursor: pointer;
}
.mr-page-wrap {
  position: relative;
  max-width: 100%;
  max-height: 100%;
  line-height: 0;
  /* 页面图也带一圈极淡的描边，与一格模式的画框观感统一 */
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.55);
}
.mr-page-img {
  display: block;
  max-width: 100%;
  /* 舞台已铺满整屏，这里按「整屏高 - 顶栏 - 台词区」算，不再受三栏布局挤压 */
  max-height: calc(100vh - 182px);
  width: auto;
  height: auto;
  user-select: none;
}
.mr-frame {
  position: absolute;
  border: 2px solid rgba(217, 151, 76, 0.55);
  border-radius: 3px;
  background: transparent;
  cursor: pointer;
  padding: 0;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.mr-frame:hover {
  border-color: rgba(217, 151, 76, 0.95);
  background: rgba(217, 151, 76, 0.12);
}
.mr-frame.active {
  border-color: #e8a552;
  border-width: 3px;
  box-shadow: 0 0 0 2px rgba(232, 165, 82, 0.35);
}
.mr-frame-no {
  position: absolute;
  top: -1px;
  left: -1px;
  min-width: 16px;
  height: 16px;
  padding: 0 3px;
  border-radius: 3px 0 3px 0;
  background: rgba(217, 151, 76, 0.9);
  color: #2a2119;
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
}

.mr-panel-wrap {
  position: relative;
  overflow: hidden;
  /* 细边框 + 圆角：单格放大后自带画框感，不会像一块被硬裁的图贴满屏 */
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 6px;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.65);
  background: #000;
}
.mr-panel-img {
  display: block;
  user-select: none;
  /* 图片按「容器宽 / rect.width」放大后，再用负偏移把目标格对齐到容器左上角 */
  max-width: none;
}
.mr-panel-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 13px;
  color: rgba(242, 236, 226, 0.6);
  padding: 24px;
  box-sizing: border-box;
  text-align: center;
}

.mr-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  max-width: 520px;
  padding: 32px;
  text-align: center;
}
.mr-empty-ico {
  font-size: 40px;
  opacity: 0.6;
}
.mr-empty-title {
  font-size: 16px;
  font-weight: 600;
}
.mr-empty-ctx {
  font-size: 12.5px;
  line-height: 1.75;
  color: rgba(242, 236, 226, 0.72);
}
.mr-empty-hint {
  font-size: 11.5px;
  color: rgba(242, 236, 226, 0.45);
}

/* 底部台词 —— 透明底，只留文字 */

.mr-dialog {
  position: absolute;
  left: 50%;
  bottom: 54px;
  transform: translateX(-50%);
  width: min(900px, 78vw);
  z-index: 4;
  /* 透明底：没有面板、没有模糊背景、没有按钮，画面完整透出来。
     可读性只靠「深色描边 + 外发光」—— 对漫画这种高反差线稿足够；
     遇到亮背景时描边会兜住。 */
  padding: 0;
  border: 0;
  background: transparent;
  line-height: 1.75;
  text-align: center;
  text-shadow:
    0 0 2px rgba(0, 0, 0, 1),
    0 0 4px rgba(0, 0, 0, 0.95),
    0 1px 3px rgba(0, 0, 0, 0.95),
    0 2px 10px rgba(0, 0, 0, 0.85),
    0 0 22px rgba(0, 0, 0, 0.7);
}
.mr-dialog-empty {
  color: rgba(255, 255, 255, 0.5);
  font-size: 13px;
  min-height: 24px;
}
.mr-dialog-speaker {
  font-weight: 700;
  color: #ffc06e;
  letter-spacing: 0.04em;
}
.mr-dialog-text {
  font-size: 1em;
  color: #ffffff;
  font-weight: 500;
  word-break: break-word;
}

/* 抽屉内的翻页行 */
.mr-nav-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.mr-nav-btn {
  flex: 1;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.07);
  color: #f2ece2;
  padding: 9px 14px;
  border-radius: 10px;
  font-size: 12.5px;
  cursor: pointer;
}
.mr-nav-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.15);
}
.mr-nav-btn:disabled {
  opacity: 0.32;
  cursor: not-allowed;
}
.mr-nav-pos {
  flex: none;
  font-size: 12px;
  color: rgba(242, 236, 226, 0.6);
  min-width: 62px;
  text-align: center;
}

/* 设置抽屉：底部上滑，内容纵向滚动 */
.mr-drawer {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 6;
  max-height: 72vh;
  display: flex;
  flex-direction: column;
  background: rgba(20, 17, 14, 0.97);
  border-top: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 18px 18px 0 0;
  box-shadow: 0 -12px 48px rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(18px);
}
.mr-drawer-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  font-size: 13.5px;
  font-weight: 600;
}
.mr-drawer-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 18px 22px;
  /* 选项会越加越多，这里必须是滚动容器而不是撑开高度 */
  overscroll-behavior: contain;
}
.mr-sec {
  padding: 12px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
}
.mr-sec:last-child {
  border-bottom: 0;
}
.mr-sec h4 {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: rgba(232, 165, 82, 0.9);
  text-transform: none;
}
.mr-seg {
  display: inline-flex;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 10px;
  overflow: hidden;
}
.mr-seg button {
  border: 0;
  background: transparent;
  color: rgba(242, 236, 226, 0.75);
  padding: 7px 16px;
  font-size: 12.5px;
  cursor: pointer;
}
.mr-seg button + button {
  border-left: 1px solid rgba(255, 255, 255, 0.12);
}
.mr-seg button.on {
  background: rgba(217, 151, 76, 0.9);
  color: #2a2119;
  font-weight: 600;
}
.mr-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  font-size: 12.5px;
  color: rgba(242, 236, 226, 0.88);
  cursor: pointer;
}
.mr-row-label {
  flex: none;
  min-width: 68px;
  color: rgba(242, 236, 226, 0.7);
}
.mr-row input[type='range'] {
  flex: 1;
  min-width: 80px;
  accent-color: #d9974c;
}
.mr-row-val {
  flex: none;
  min-width: 46px;
  text-align: right;
  font-size: 11.5px;
  color: rgba(242, 236, 226, 0.6);
}
.mr-row input[type='checkbox'] {
  accent-color: #d9974c;
  width: 15px;
  height: 15px;
}
.mr-tip {
  margin: 6px 0 0;
  font-size: 11.5px;
  line-height: 1.7;
  color: rgba(242, 236, 226, 0.5);
}
.mr-bgm-info {
  font-size: 12.5px;
  margin-bottom: 6px;
}
.mr-muted {
  color: rgba(242, 236, 226, 0.5);
}
.mr-attribution {
  margin-top: 3px;
  font-size: 11px;
  line-height: 1.6;
  color: rgba(242, 236, 226, 0.42);
  word-break: break-all;
}
.mr-err {
  margin-top: 6px;
  font-size: 11.5px;
  color: #e8846a;
}
.mr-keys {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 2;
  color: rgba(242, 236, 226, 0.7);
}
.mr-keys kbd {
  display: inline-block;
  min-width: 18px;
  padding: 0 5px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  font-size: 11px;
  text-align: center;
}
.mr-audio {
  display: none;
}
/* 隐藏预加载图：不可见、不占位，只用来读 naturalWidth/naturalHeight */
.mr-preload {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
  left: -9999px;
  top: -9999px;
}

/* 抽屉动画 */
.mr-sheet-enter-active,
.mr-sheet-leave-active {
  transition: transform 0.22s ease, opacity 0.22s ease;
}
.mr-sheet-enter-from,
.mr-sheet-leave-to {
  transform: translateY(24px);
  opacity: 0;
}
</style>

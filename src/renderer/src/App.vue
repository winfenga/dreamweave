<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import SummaryView from './components/SummaryView.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import LibraryView from './components/LibraryView.vue'
import ReadingView from './components/ReadingView.vue'
import MapView from './components/MapView.vue'
import StageView from './components/StageView.vue'
import MangaView from './components/MangaView.vue'
import ImpressionView from './components/ImpressionView.vue'
import ScriptEditor from './components/ScriptEditor.vue'
import type { ImportSummary, ModelSettings, ViewData } from '../../shared/app-types'

type Tab =
  | 'library'
  | 'overview'
  | 'chapters'
  | 'entities'
  | 'files'
  | 'reading'
  | 'map'
  | 'stage'
  | 'manga'
  | 'impression'
  | 'script'
  | 'settings'

const summary = ref<ImportSummary | null>(null)
const view = ref<ViewData | null>(null)
const viewError = ref('')
const viewLoading = ref(false)
const error = ref<string>('')
const loading = ref(false)
/** 落地页 = 书库（不自动恢复上次打开的书） */
const tab = ref<Tab>('library')
/** 「章节」tab 点「阅读本章」时带过来的目标 byteStart（阅读页据此滚动定位） */
const readingTarget = ref<number | null>(null)
/** 进入「设置」标签页前的标签，关闭设置时据此返回（如从演出页进入则返回演出页） */
const prevTab = ref<Tab>('library')
/** 演出/音频设置：由顶栏统一加载，离开设置页时重读，舞台视图直接消费 */
const settings = ref<ModelSettings | null>(null)
/** 窗口级全屏状态（顶栏按钮显示用；系统侧 F11 触发也会同步） */
const isFullScreen = ref(false)
let unsubFs: (() => void) | null = null

/** 顶栏全屏按钮：切换并按主进程确认后的真实状态回写 */
async function toggleFullScreen(): Promise<void> {
  try {
    const res = await window.feather.toggleFullScreen()
    if (res.ok) isFullScreen.value = res.fullScreen
  } catch {
    /* 全屏切换失败不弹错（非关键路径） */
  }
}

const isSettingsTab = computed(() => tab.value === 'settings')

async function loadSettings(): Promise<void> {
  try {
    settings.value = await window.feather.getSettings()
  } catch {
    settings.value = null
  }
}

onMounted(() => {
  // F5 启动动画：保证最少展示 SPLASH_MIN_MS 再淡出（元素在 index.html，Vue 挂载前已可见）。
  // 之前淡出太快导致用户「看不到」——App 挂载即移除。现在页面加载到挂载通常 <300ms，
  // 该值保证完整动画节奏（约 3s）播完。
  const SPLASH_MIN_MS = 2900
  const splash = document.getElementById('splash')
  if (splash) {
    const wait = Math.max(0, SPLASH_MIN_MS - performance.now())
    window.setTimeout(() => {
      splash.classList.add('splash-out')
      window.setTimeout(() => splash.remove(), 650)
    }, wait)
  }
  void loadSettings()
  // 首帧对齐全屏真实状态 + 订阅系统侧变化（F11/系统菜单）
  void window.feather
    .getFullScreen()
    .then((on) => {
      isFullScreen.value = on
    })
    .catch(() => {})
  unsubFs = window.feather.onFullScreenChanged((on) => {
    isFullScreen.value = on
  })
})

onUnmounted(() => {
  if (unsubFs) unsubFs()
})

const fileCount = computed(() => summary.value?.files.length ?? 0)
// 「当前打开」标记不再由渲染层判定：`workspace:list` 已按工作库目录给出 `current`，
// 故这里不再需要 currentPkgId（按 pkgId 判定会把同一本书的多份副本同时标成「当前打开」）。
const needsView = computed(() => tab.value === 'map' || tab.value === 'stage' || tab.value === 'impression' || tab.value === 'script')
/** 传给 SummaryView 的窄化标签（保证与组件 props 联合类型一致） */
const summaryTab = computed<'overview' | 'chapters' | 'entities' | 'files'>(() => {
  const t = tab.value
  if (t === 'chapters' || t === 'entities' || t === 'files') return t
  return 'overview'
})

async function ensureView(): Promise<void> {
  if (!needsView.value || view.value || viewLoading.value) return
  viewLoading.value = true
  viewError.value = ''
  try {
    const res = await window.feather.getView()
    if (!res.ok || !res.data) {
      viewError.value = res.error ?? '渲染模型加载失败'
      return
    }
    view.value = res.data
  } catch (e) {
    viewError.value = (e as Error).message
  } finally {
    viewLoading.value = false
  }
}

/** P3 写回成功后：主进程已刷新会话，重新拉取并原地替换 view（不置空），
 *  避免 ScriptEditor 卸载导致保存成功提示只存活一个渲染 tick 不可见 */
async function reloadView(): Promise<void> {
  viewError.value = ''
  viewLoading.value = true
  try {
    const res = await window.feather.getView()
    if (!res.ok || !res.data) {
      viewError.value = res.error ?? '渲染模型加载失败'
      return
    }
    view.value = res.data
  } catch (e) {
    viewError.value = (e as Error).message
  } finally {
    viewLoading.value = false
  }
}

watch(tab, (_v, old) => {
  // 离开设置页：重读 settings，保证舞台/音频参数的改动立即生效
  if (old === 'settings') void loadSettings()
  void ensureView()
})

/** 进入「设置」标签页：记住来源标签，便于「关闭」返回 */
function openSettings(): void {
  if (tab.value !== 'settings') prevTab.value = tab.value
  tab.value = 'settings'
}
/** 「关闭」设置：返回进入前的标签页（无来源时回书库） */
function closeSettings(): void {
  tab.value = prevTab.value === 'settings' ? 'library' : prevTab.value
}

/** 切换到「阅读原文」：直接点标签栏进入时清掉上次的定位目标 */
function openReading(): void {
  readingTarget.value = null
  tab.value = 'reading'
}

/** 书库「打开」成功：更新摘要，清掉渲染模型与定位目标，切到概览 */
function onWorkspaceOpened(s: ImportSummary): void {
  summary.value = s
  view.value = null
  viewError.value = ''
  readingTarget.value = null
  tab.value = 'overview'
}

/** 「章节」tab 点「阅读本章」：切到阅读页并把目标 byteStart 传下去 */
function onReadChapter(byteStart: number): void {
  readingTarget.value = byteStart
  tab.value = 'reading'
}

/**
 * 导入：`.t2w`（默认）与 `.txt` 完全同构 —— 都是**无条件新建**一本工作库，零提示。
 * kind 经 preload 透传给主进程：仅用于文件框过滤项（预设路径时主进程按扩展名分流）。
 */
async function doImport(kind: 't2w' | 'txt' = 't2w'): Promise<void> {
  error.value = ''
  loading.value = true
  try {
    const res = await window.feather.importPackage(undefined, kind)
    if (res.canceled) return
    if (!res.ok || !res.summary) {
      error.value = res.error ?? '导入失败'
      return
    }
    summary.value = res.summary
    view.value = null
    viewError.value = ''
    readingTarget.value = null
    tab.value = 'overview'
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="app">
    <!-- macOS 风侧栏：书库 + 已打开书的各视图 + 设置；琥珀胶囊选中 -->
    <aside class="sidebar">
      <div class="sidebar-brand">
        <svg class="brand-feather" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            d="M20.5 3.5c-4.5-1.5-9.5.5-12.5 4.5-2.2 3-3 6.5-3.3 9.2l-1.4 3.1c-.1.3.2.6.5.4l2.9-1.6c2.7-.2 6.3-.9 9.3-3.1 4-3 6-8 4.5-12.5z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linejoin="round"
          />
          <path d="M4.5 19.5 14 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
        <span>DreamWeave</span>
      </div>

      <nav class="sidebar-nav">
        <button class="side-item" :class="{ active: tab === 'library' }" @click="tab = 'library'">
          <span class="side-ico">📚</span><span>书库</span>
        </button>
        <template v-if="summary">
          <div class="side-sep"></div>
          <div class="side-label">{{ summary.project.title }}</div>
          <button class="side-item" :class="{ active: tab === 'overview' }" @click="tab = 'overview'">
            <span class="side-ico">📋</span><span>概览</span>
          </button>
          <button class="side-item" :class="{ active: tab === 'map' }" @click="tab = 'map'">
            <span class="side-ico">🗺️</span><span>地图互动</span>
          </button>
          <button class="side-item" :class="{ active: tab === 'impression' }" @click="tab = 'impression'">
            <span class="side-ico">🧭</span><span>印象图谱</span>
          </button>
          <button class="side-item" :class="{ active: tab === 'stage' }" @click="tab = 'stage'">
            <span class="side-ico">🎬</span><span>视觉演出</span>
          </button>
          <button class="side-item" :class="{ active: tab === 'manga' }" @click="tab = 'manga'">
            <span class="side-ico">🎞️</span><span>漫画阅读</span>
          </button>
          <button class="side-item" :class="{ active: tab === 'script' }" @click="tab = 'script'">
            <span class="side-ico">📝</span><span>脚本修订</span>
          </button>
          <button class="side-item" :class="{ active: tab === 'reading' }" @click="openReading">
            <span class="side-ico">📖</span><span>阅读原文</span>
          </button>
          <button class="side-item" :class="{ active: tab === 'chapters' }" @click="tab = 'chapters'">
            <span class="side-ico">📄</span><span>章节</span><span class="side-count">{{ summary.chapters.length }}</span>
          </button>
          <button class="side-item" :class="{ active: tab === 'entities' }" @click="tab = 'entities'">
            <span class="side-ico">👤</span><span>实体</span>
          </button>
          <button class="side-item" :class="{ active: tab === 'files' }" @click="tab = 'files'">
            <span class="side-ico">📁</span><span>文件</span><span class="side-count">{{ fileCount }}</span>
          </button>
        </template>
        <div class="side-sep"></div>
        <button class="side-item" :class="{ active: isSettingsTab }" data-testid="tab-settings" @click="openSettings">
          <span class="side-ico">⚙️</span><span>设置</span>
        </button>
      </nav>
    </aside>

    <div class="main-col">
      <header class="topbar">
        <!-- 左侧占位与侧栏品牌位平衡；中间书名居中 -->
        <div class="topbar-side">
          <button class="btn" data-testid="open-settings" @click="openSettings">设置</button>
        </div>
        <h1>{{ summary ? summary.project.title : 'DreamWeave · 织梦' }}</h1>
        <div class="topbar-side topbar-right">
          <button
            class="btn"
            data-testid="toggle-fullscreen"
            :title="isFullScreen ? '退出全屏' : '进入全屏'"
            @click="toggleFullScreen"
          >
            {{ isFullScreen ? '⤡ 退出全屏' : '⤢ 全屏' }}
          </button>
          <button class="btn primary" :disabled="loading" @click="doImport()">
            {{ loading ? '导入中…' : '导入 .t2w' }}
          </button>
          <button class="btn" :disabled="loading" @click="doImport('txt')">
            {{ loading ? '导入中…' : '导入 .txt' }}
          </button>
        </div>
      </header>

      <!-- content-flush 让地图/演出/图谱/阅读占满可视区；但设置页比可视区高，
           进入设置时必须恢复滚动，否则「保存」等下方控件永远点不到 -->
      <div
        class="content"
        :class="{ 'content-flush': !isSettingsTab && (tab === 'map' || tab === 'stage' || tab === 'manga' || tab === 'impression' || tab === 'script' || tab === 'reading') }"
      >
        <div v-if="error" class="error">{{ error }}</div>

        <SettingsPanel v-if="isSettingsTab" @saved="loadSettings" @close="closeSettings" />

        <!-- 书库 = 落地页（无摘要时也显示；自带「书库为空」提示） -->
        <LibraryView
          v-else-if="tab === 'library'"
          @opened="onWorkspaceOpened"
          @import="doImport"
          @import-txt="doImport('txt')"
        />

        <template v-else-if="summary">
          <div v-if="viewError" class="error">{{ viewError }}</div>
          <div v-if="viewLoading" class="hint">正在整理渲染模型…</div>

          <MapView v-if="tab === 'map' && view" :view="view" />
          <ImpressionView v-else-if="tab === 'impression' && view" :view="view" />
          <StageView v-else-if="tab === 'stage' && view" :view="view" :settings="settings" />
          <MangaView v-else-if="tab === 'manga'" />
          <ScriptEditor v-else-if="tab === 'script' && view" :view="view" @saved="reloadView" />
          <ReadingView v-else-if="tab === 'reading'" :target="readingTarget" />
          <SummaryView
            v-else-if="tab === 'overview' || tab === 'chapters' || tab === 'entities' || tab === 'files'"
            :summary="summary"
            :tab="summaryTab"
            @read-chapter="onReadChapter"
          />
        </template>
      </div>
    </div>
  </div>
</template>

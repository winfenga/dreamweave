<script setup lang="ts">
/**
 * 漫画阅读（M1）。
 *
 * 数据来源 `window.feather.getMangaView()`（IPC `t2w:mangaView`），
 * 模型见 `shared/manga-types.ts`；解析在 `main/t2w/manga.ts`。
 *
 * 交互设计要点：
 *   - 左侧：章 → 页 导航树（当前章展开）；
 *   - 中间：整页图 + 分镜热区叠层（rect 是 0..1 归一化，直接按百分比定位，
 *     与图片实际像素尺寸无关 → 窗口缩放/大图都不需要重算）；
 *   - 右侧：当前页的全部台词，按分镜分组；点热区或台词都会互相高亮；
 *   - 键盘：← → 翻页，↑ ↓ 切章，Esc 取消分镜选中。
 *
 * 降级策略（缺图/缺热区都要能用）：
 *   - 页无图 → 显示「本页无插图」占位，但**分镜与台词照常可读**（文字才是主体）；
 *   - 分镜无 rect → 不画热区，但仍在右侧台词列表里出现，可点选。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import MangaReader from './MangaReader.vue'
import type { MangaChapter, MangaPage, MangaPanel, MangaViewData } from '../../../shared/manga-types'

const loading = ref(false)
const error = ref('')
const data = ref<MangaViewData | null>(null)

/** 当前章索引（chapters[] 下标） */
const chIdx = ref(0)
/** 当前页索引（当前章的 pages[] 下标） */
const pageIdx = ref(0)
/** 选中的分镜 no；null = 未选中 */
const activePanel = ref<number | null>(null)
/** 是否显示热区框（默认显示，可关闭以便纯粹看图） */
const showFrames = ref(true)
/** 图片加载失败标记（按 pageKey 记录） */
const brokenImages = ref<Set<string>>(new Set())
/**
 * 沉浸式阅读器是否打开。
 *
 * 为什么单独做覆盖层而不是「收起两栏 + 图片撑满」：
 * 三栏布局下图片高度受 `max-height: calc(100vh-230px)` 限制，竖版页在宽屏上
 * 只能铺成一条窄带 —— 这正是用户反馈的「全屏只有一小部分」。
 * 覆盖层用 `position: fixed; inset: 0` 独立铺满，不牵动三栏布局本身。
 */
const readerOpen = ref(false)

function openReader(): void {
  if (!data.value) return
  readerOpen.value = true
}
function closeReader(): void {
  readerOpen.value = false
}

const chapter = computed<MangaChapter | null>(() => data.value?.chapters[chIdx.value] ?? null)
const page = computed<MangaPage | null>(() => chapter.value?.pages[pageIdx.value] ?? null)

/** 全库页数（用于「第 x / y 页」全局进度） */
const totalPages = computed(() => data.value?.stats.pageCount ?? 0)
/** 当前全局页序号（1 起） */
const globalPageNo = computed(() => {
  if (!data.value) return 0
  let n = 0
  for (let i = 0; i < chIdx.value; i++) n += data.value.chapters[i].pages.length
  return n + pageIdx.value + 1
})

const stats = computed(() => data.value?.stats ?? null)

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const res = await window.feather.getMangaView()
    if (!res.ok || !res.data) {
      error.value = res.error ?? '漫画数据加载失败'
      data.value = null
      return
    }
    data.value = res.data
    // 初始定位到第一个有图的页，而不是死板地从第 1 章第 1 页起
    jumpToFirstPageWithImage()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

function jumpToFirstPageWithImage(): void {
  const d = data.value
  if (!d) return
  for (let ci = 0; ci < d.chapters.length; ci++) {
    const pi = d.chapters[ci].pages.findIndex((p) => p.hasImage)
    if (pi >= 0) {
      chIdx.value = ci
      pageIdx.value = pi
      return
    }
  }
  chIdx.value = 0
  pageIdx.value = 0
}

onMounted(() => {
  void load()
  window.addEventListener('keydown', onKey)
})
onUnmounted(() => window.removeEventListener('keydown', onKey))

/** 切章时把页索引复位到 0 */
watch(chIdx, () => {
  pageIdx.value = 0
  activePanel.value = null
})
watch(pageIdx, () => {
  activePanel.value = null
})

function selectChapter(i: number): void {
  chIdx.value = i
}

function selectPage(i: number): void {
  pageIdx.value = i
}

function prevPage(): void {
  const d = data.value
  if (!d) return
  if (pageIdx.value > 0) {
    pageIdx.value--
    return
  }
  // 跨章往前
  if (chIdx.value > 0) {
    chIdx.value--
    const prevCh = d.chapters[chIdx.value]
    pageIdx.value = Math.max(0, prevCh.pages.length - 1)
  }
}

function nextPage(): void {
  const d = data.value
  if (!d) return
  const ch = d.chapters[chIdx.value]
  if (pageIdx.value < ch.pages.length - 1) {
    pageIdx.value++
    return
  }
  // 跨章往后
  if (chIdx.value < d.chapters.length - 1) {
    chIdx.value++
    pageIdx.value = 0
  }
}

function onKey(e: KeyboardEvent): void {
  // 输入框里不劫持方向键
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
  if (!data.value) return
  if (e.key === 'ArrowLeft') {
    e.preventDefault()
    prevPage()
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    nextPage()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (chIdx.value > 0) chIdx.value--
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (chIdx.value < data.value.chapters.length - 1) chIdx.value++
  } else if (e.key === 'Escape') {
    activePanel.value = null
  }
}

function togglePanel(no: number): void {
  activePanel.value = activePanel.value === no ? null : no
}

/** 热区样式：rect 0..1 → 百分比 left/top/width/height */
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

function onImgError(key: string): void {
  const s = new Set(brokenImages.value)
  s.add(key)
  brokenImages.value = s
}

/** 台词类型图标 */
function speechIcon(type: string): string {
  if (type === 'say') return '💬'
  if (type === 'think') return '💭'
  return '📖'
}

/** 台词类型中文 */
function speechLabel(type: string): string {
  if (type === 'say') return '对白'
  if (type === 'think') return '心声'
  return '旁白'
}

/** 章节标题去掉重复的「第N章」前缀（records.chapters 的 title 自带） */
function chapterLabel(ch: MangaChapter): string {
  return ch.title || `第 ${ch.chapterSeq} 章`
}
</script>

<template>
  <div class="manga-root">
    <div v-if="loading" class="manga-hint">正在解析漫画数据…</div>
    <div v-else-if="error" class="manga-empty">
      <div class="manga-empty-ico">🎞️</div>
      <div class="manga-empty-title">没有可显示的漫画</div>
      <div class="manga-empty-desc">{{ error }}</div>
    </div>

    <template v-else-if="data">
      <!-- ===== 左：章节 / 页码导航 ===== -->
      <aside class="manga-nav">
        <div class="nav-head">
          <span class="nav-title">章节</span>
          <span class="nav-meta">{{ stats?.chapterCount }} 章 · {{ totalPages }} 页</span>
        </div>
        <div class="nav-list">
          <div v-for="(ch, i) in data.chapters" :key="ch.chapterSeq" class="nav-ch">
            <button class="nav-ch-btn" :class="{ active: i === chIdx }" @click="selectChapter(i)">
              <span class="nav-ch-name">{{ chapterLabel(ch) }}</span>
              <span class="nav-ch-badge">
                {{ ch.pages.length }} 页<template v-if="ch.music"> ♪</template>
              </span>
            </button>
            <!-- 当前章展开页码 -->
            <div v-if="i === chIdx" class="nav-pages">
              <button
                v-for="(p, pi) in ch.pages"
                :key="p.key"
                class="nav-page-btn"
                :class="{ active: pi === pageIdx, empty: !p.hasImage }"
                :title="p.hasImage ? `第 ${p.no} 页` : '本页无插图'"
                @click="selectPage(pi)"
              >
                <span class="nav-page-no">{{ p.no }}</span>
                <span class="nav-page-meta">{{ p.panels.length }}格</span>
              </button>
            </div>
          </div>
        </div>
        <div class="nav-stats">
          <div class="stat-row"><span>分镜</span><b>{{ stats?.panelCount }}</b></div>
          <div class="stat-row"><span>台词</span><b>{{ stats?.speechCount }}</b></div>
          <div class="stat-row"><span>特效</span><b>{{ stats?.effectCount }}</b></div>
          <div class="stat-row"><span>配音</span><b>{{ stats?.dubbingClipCount }}</b></div>
        </div>
      </aside>

      <!-- ===== 中：页面图 + 热区 ===== -->
      <main class="manga-stage">
        <div class="stage-bar">
          <div class="stage-bar-left">
            <span class="stage-ch">{{ chapter ? chapterLabel(chapter) : '' }}</span>
            <span class="stage-sep">·</span>
            <span class="stage-page">第 {{ page?.no ?? 0 }} 页</span>
            <span class="stage-count">（{{ globalPageNo }} / {{ totalPages }}）</span>
          </div>
          <div class="stage-bar-right">
            <span v-if="page && !page.hasImage" class="stage-warn">本页无插图</span>
            <span v-if="page?.colorMode" class="stage-chip">{{ page.colorMode === 'monochrome' ? '黑白' : page.colorMode }}</span>
            <button class="btn tiny" data-testid="open-reader" title="沉浸全屏阅读（一页 / 一格）" @click="openReader">
              ⛶ 沉浸阅读
            </button>
            <button
              class="btn tiny"
              :class="{ on: showFrames }"
              :title="showFrames ? '隐藏分镜框' : '显示分镜框'"
              @click="showFrames = !showFrames"
            >
              {{ showFrames ? '◱ 分镜' : '◻ 分镜' }}
            </button>
          </div>
        </div>

        <div class="stage-canvas">
          <!-- 有图：图 + 热区叠层 -->
          <div v-if="page?.imageUrl && !brokenImages.has(page.key)" class="page-wrap">
            <img
              class="page-img"
              :src="page.imageUrl"
              :alt="`第 ${page?.no} 页`"
              draggable="false"
              @error="onImgError(page!.key)"
            />
            <template v-if="showFrames">
              <button
                v-for="pn in page.panels"
                :key="pn.no"
                class="frame"
                :class="{ active: activePanel === pn.no, hasfx: pn.effectIds.length > 0 }"
                :style="frameStyle(pn)"
                :title="`第 ${pn.no} 格${pn.content ? '：' + pn.content.slice(0, 40) : ''}`"
                @click="togglePanel(pn.no)"
              >
                <span class="frame-no">{{ pn.no }}</span>
              </button>
            </template>
          </div>

          <!-- 无图：占位（分镜与台词仍在右侧可读） -->
          <div v-else class="page-placeholder">
            <div class="ph-ico">🖼️</div>
            <div class="ph-title">{{ page?.imageUrl ? '插图加载失败' : '本页无插图' }}</div>
            <div v-if="page?.context" class="ph-context">{{ page.context }}</div>
            <div class="ph-hint">分镜与台词仍可阅读 →</div>
          </div>
        </div>

        <!-- 底部：翻页 -->
        <div class="stage-foot">
          <button class="btn" :disabled="globalPageNo <= 1" @click="prevPage">← 上一页</button>
          <div class="foot-mid">
            <span v-if="page?.characters.length" class="foot-chars">
              出场：{{ page.characters.map((c) => c.name).filter(Boolean).join('、') }}
            </span>
            <span v-if="chapter?.music" class="foot-music" :title="chapter.music.attribution">
              ♪ {{ chapter.music.title }}<template v-if="chapter.music.author"> — {{ chapter.music.author }}</template>
            </span>
          </div>
          <button class="btn" :disabled="globalPageNo >= totalPages" @click="nextPage">下一页 →</button>
        </div>
      </main>

      <!-- ===== 右：分镜与台词 ===== -->
      <aside class="manga-side">
        <div class="side-head">
          <span class="nav-title">分镜台词</span>
          <button v-if="activePanel != null" class="btn tiny" @click="activePanel = null">显示全部</button>
        </div>
        <div class="side-body">
          <div v-if="page?.context" class="page-context">{{ page.context }}</div>

          <div v-for="pn in page?.panels ?? []" :key="pn.no" class="panel-block" :class="{ active: activePanel === pn.no }">
            <button class="panel-head" @click="togglePanel(pn.no)">
              <span class="panel-no">第 {{ pn.no }} 格</span>
              <span v-if="pn.effectIds.length" class="panel-fx">{{ pn.effectIds.join(' ') }}</span>
              <span class="panel-count">{{ pn.speech.length }} 句</span>
            </button>
            <div v-if="pn.content" class="panel-content">{{ pn.content }}</div>
            <div v-for="(sp, si) in pn.speech" :key="si" class="speech" :class="'sp-' + sp.type">
              <span class="sp-ico" :title="speechLabel(sp.type)">{{ speechIcon(sp.type) }}</span>
              <span class="sp-text">
                <b v-if="sp.speaker" class="sp-speaker">{{ sp.speaker }}：</b>{{ sp.text }}
              </span>
            </div>
            <div v-if="!pn.speech.length && !pn.content" class="panel-empty">（本格无内容）</div>
          </div>

          <div v-if="!(page?.panels ?? []).length" class="side-empty">本页没有分镜数据</div>
        </div>
      </aside>

      <!-- ===== 沉浸式阅读器（覆盖层，position:fixed 脱离三栏网格） ===== -->
      <MangaReader
        v-if="readerOpen && data"
        :data="data"
        :start-chapter="chIdx"
        :start-page="pageIdx"
        @close="closeReader"
      />
    </template>
  </div>
</template>

<style scoped>
.manga-root {
  display: grid;
  grid-template-columns: 216px minmax(0, 1fr) 340px;
  gap: 12px;
  height: 100%;
  min-height: 0;
  padding: 12px;
  box-sizing: border-box;
}

.manga-hint,
.manga-empty {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--muted);
}
.manga-empty-ico {
  font-size: 42px;
}
.manga-empty-title {
  font-size: 17px;
  font-weight: 600;
  color: var(--text);
}
.manga-empty-desc {
  max-width: 460px;
  text-align: center;
  font-size: 13px;
  color: var(--faint);
  line-height: 1.7;
}

/* ---------- 左导航 ---------- */
.manga-nav,
.manga-side {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-1);
  overflow: hidden;
}
.nav-head,
.side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
  flex: none;
}
.nav-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  letter-spacing: 0.04em;
}
.nav-meta {
  font-size: 11px;
  color: var(--faint);
}
.nav-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
}
.nav-ch {
  margin-bottom: 2px;
}
.nav-ch-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 100%;
  padding: 7px 9px;
  border: 0;
  border-radius: var(--radius-btn);
  background: transparent;
  color: var(--text);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast) ease;
}
.nav-ch-btn:hover {
  background: var(--accent-soft);
}
.nav-ch-btn.active {
  background: var(--accent);
  color: var(--accent-ink);
  font-weight: 600;
}
.nav-ch-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nav-ch-badge {
  flex: none;
  font-size: 10.5px;
  opacity: 0.72;
}
.nav-pages {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 4px 2px 6px 10px;
}
.nav-page-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  min-width: 44px;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--panel);
  color: var(--muted);
  font-size: 11px;
  cursor: pointer;
  transition: all var(--dur-fast) ease;
}
.nav-page-btn:hover {
  border-color: var(--accent);
  color: var(--text);
}
.nav-page-btn.active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--text);
  font-weight: 600;
}
.nav-page-btn.empty {
  opacity: 0.55;
  border-style: dashed;
}
.nav-page-no {
  font-size: 13px;
  font-weight: 600;
}
.nav-page-meta {
  font-size: 9.5px;
  color: var(--faint);
}
.nav-stats {
  flex: none;
  border-top: 1px solid var(--border);
  padding: 8px 12px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 10px;
  background: var(--panel-2);
}
.stat-row {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--faint);
}
.stat-row b {
  color: var(--text);
  font-weight: 600;
}

/* ---------- 中舞台 ---------- */
.manga-stage {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-1);
  overflow: hidden;
}
.stage-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
  flex: none;
}
.stage-bar-left {
  display: flex;
  align-items: baseline;
  gap: 5px;
  font-size: 12.5px;
  color: var(--text);
  min-width: 0;
}
.stage-ch {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stage-sep,
.stage-count {
  color: var(--faint);
}
.stage-bar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.stage-warn {
  font-size: 11.5px;
  color: var(--warn);
  padding: 2px 7px;
  border: 1px solid var(--warn);
  border-radius: 999px;
}
.stage-chip {
  font-size: 11px;
  color: var(--muted);
  padding: 2px 7px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
}

.stage-canvas {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  overflow: auto;
  background: #d9cdb9;
}
.page-wrap {
  position: relative;
  display: block;
  max-width: 100%;
  max-height: 100%;
  line-height: 0;
  box-shadow: var(--shadow-2);
}
.page-img {
  display: block;
  max-width: 100%;
  max-height: calc(100vh - 230px);
  width: auto;
  height: auto;
  user-select: none;
}
.frame {
  position: absolute;
  border: 2px solid rgba(217, 151, 76, 0.85);
  border-radius: 4px;
  background: rgba(217, 151, 76, 0.06);
  cursor: pointer;
  padding: 0;
  transition: background var(--dur-fast) ease, border-color var(--dur-fast) ease;
}
.frame:hover {
  background: rgba(217, 151, 76, 0.2);
  border-color: var(--accent-strong);
}
.frame.active {
  border-color: #c4823b;
  border-width: 3px;
  background: rgba(217, 151, 76, 0.26);
  box-shadow: 0 0 0 3px rgba(217, 151, 76, 0.3);
}
.frame.hasfx {
  border-style: dashed;
}
.frame-no {
  position: absolute;
  top: -1px;
  left: -1px;
  min-width: 17px;
  height: 17px;
  padding: 0 3px;
  border-radius: 4px 0 4px 0;
  background: var(--accent);
  color: var(--accent-ink);
  font-size: 10px;
  font-weight: 700;
  line-height: 17px;
  text-align: center;
}
.page-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 32px;
  color: var(--muted);
  max-width: 460px;
  text-align: center;
}
.ph-ico {
  font-size: 40px;
  opacity: 0.7;
}
.ph-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.ph-context {
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--muted);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-btn);
  padding: 10px 12px;
}
.ph-hint {
  font-size: 11.5px;
  color: var(--faint);
}

.stage-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  background: var(--panel-2);
  flex: none;
}
/* 翻页按钮不许被中间的乐曲线挤成两行 */
.stage-foot > .btn {
  flex: none;
  white-space: nowrap;
}
.foot-mid {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  min-width: 0;
  flex: 1;
  overflow: hidden;
}
.foot-chars {
  font-size: 11.5px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.foot-music {
  font-size: 11px;
  color: var(--faint);
  cursor: help;
}

/* ---------- 右台词 ---------- */
.side-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
}
.page-context {
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--muted);
  background: var(--panel-2);
  border-left: 3px solid var(--border-strong);
  border-radius: 4px;
  padding: 7px 9px;
  margin-bottom: 8px;
}
.panel-block {
  border: 1px solid transparent;
  border-radius: var(--radius-btn);
  margin-bottom: 6px;
  transition: border-color var(--dur-fast) ease, background var(--dur-fast) ease;
}
.panel-block.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.panel-head {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--radius-btn);
  background: transparent;
  color: var(--text);
  font-size: 11.5px;
  cursor: pointer;
  text-align: left;
}
.panel-head:hover {
  background: rgba(217, 151, 76, 0.12);
}
.panel-no {
  font-weight: 600;
  flex: none;
}
.panel-fx {
  font-size: 9.5px;
  color: var(--bad);
  background: rgba(194, 85, 75, 0.12);
  border-radius: 999px;
  padding: 1px 6px;
}
.panel-count {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--faint);
}
.panel-content {
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--muted);
  padding: 0 8px 6px;
}
.speech {
  display: flex;
  gap: 6px;
  padding: 5px 8px;
  font-size: 12.5px;
  line-height: 1.7;
  border-radius: 6px;
}
.speech + .speech {
  margin-top: 2px;
}
.sp-ico {
  flex: none;
  font-size: 11px;
  opacity: 0.85;
  line-height: 1.75;
}
.sp-text {
  color: var(--text);
}
.sp-narration .sp-text {
  color: var(--muted);
}
.sp-say .sp-text {
  color: var(--text);
  font-weight: 500;
}
.sp-think .sp-text {
  color: var(--muted);
  font-style: italic;
}
.sp-speaker {
  font-weight: 600;
  color: var(--accent-strong);
}
.panel-empty,
.side-empty {
  font-size: 11.5px;
  color: var(--faint);
  padding: 4px 8px;
}
.side-empty {
  text-align: center;
  padding: 20px;
}

.btn.tiny {
  padding: 2px 8px;
  font-size: 11px;
  border-radius: 6px;
}
.btn.tiny.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--text);
}
</style>

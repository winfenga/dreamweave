<script setup lang="ts">
/**
 * 书库（书架视图，落地页）。
 *
 * 布局口径（用户拍板，2026-11-05）：**书架**，不是表格。
 *   - 一本一个「书」的立体造型：封面 + 书脊 + 底部书页，有厚度、有投影、微微倾斜；
 *   - 封面正中是**书名**（用户在书名上要一眼能认出书，所以书名是封面的主体，不是说明文字）；
 *   - **每排固定 5 本**（`grid-template-columns: repeat(5, 1fr)`），窄窗口也不变列数，
 *     靠 `minmax(0, 1fr)` 让书本自身缩窄，避免出现「4 本 + 1 本掉到下一排」的破排。
 *
 * 数据主键照旧 = **工作库目录名**（`item.id`），不是 pkgId —— 同一 .t2w 可并存多份副本。
 * 「打开 / 导出 / 删除」一律按 id 调 IPC。
 *
 * 排序保留（表头没了，改为工具条上的下拉 + 升降序按钮），键与 localStorage 沿用旧值，
 * 老用户的排序偏好不会丢。
 */
import { computed, onMounted, ref } from 'vue'
import type { ImportSummary } from '../../../shared/app-types'
import type { WorkspaceListItem } from '../../../shared/workspace-types'

const emit = defineEmits<{
  (e: 'opened', summary: ImportSummary): void
  (e: 'import'): void
  (e: 'import-txt'): void
}>()

const items = ref<WorkspaceListItem[]>([])
const broken = ref<string[]>([])
const loading = ref(false)
const error = ref('')
const busyId = ref('')
/** 导出成功的提示（路径 + 大小）；新一次导出前清空 */
const exportNotice = ref('')

/** 排序键与方向（工具条上的下拉；选择持久化到 localStorage） */
type SortKey = 'title' | 'chapterCount' | 'charCount' | 't2wSize' | 'createdAt'
const SORT_KEY_LS = 'feather.lib.sort'
const VALID_SORT_KEYS: readonly SortKey[] = ['title', 'chapterCount', 'charCount', 't2wSize', 'createdAt']
const SORT_LABELS: Record<SortKey, string> = {
  createdAt: '导入时间',
  title: '书名',
  chapterCount: '章节数',
  charCount: '字符数',
  t2wSize: '体积'
}

function loadSortPref(): { key: SortKey; asc: boolean } {
  try {
    const raw = localStorage.getItem(SORT_KEY_LS)
    if (raw) {
      const p = JSON.parse(raw) as { key?: string; asc?: boolean }
      if (p.key && (VALID_SORT_KEYS as readonly string[]).includes(p.key)) {
        return { key: p.key as SortKey, asc: p.asc !== false }
      }
    }
  } catch {
    /* 脏数据按默认处理 */
  }
  return { key: 'createdAt', asc: false }
}

const sortKey = ref<SortKey>(loadSortPref().key)
const sortAsc = ref<boolean>(loadSortPref().asc)

function saveSortPref(): void {
  try {
    localStorage.setItem(SORT_KEY_LS, JSON.stringify({ key: sortKey.value, asc: sortAsc.value }))
  } catch {
    /* localStorage 不可用时排序仍生效，只是不记忆 */
  }
}

/** 换排序键：文本列默认升序，数值/时间列默认降序（新的在前） */
function onSortKeyChange(e: Event): void {
  const k = (e.target as HTMLSelectElement).value as SortKey
  if (!VALID_SORT_KEYS.includes(k)) return
  sortKey.value = k
  sortAsc.value = k === 'title'
  saveSortPref()
}

function toggleSortDir(): void {
  sortAsc.value = !sortAsc.value
  saveSortPref()
}

/** 排序后的列表（损坏项不参与排序，永远垫底） */
const sortedItems = computed(() => {
  const k = sortKey.value
  const mul = sortAsc.value ? 1 : -1
  return [...items.value].sort((a, b) => {
    if (k === 'title') return (a.title || '').localeCompare(b.title || '', 'zh-Hans-CN') * mul
    return ((Number(a[k]) || 0) - (Number(b[k]) || 0)) * mul
  })
})

const sizeOf = (n: number): string => {
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
  return n + ' B'
}

const hasAny = computed(() => items.value.length > 0 || broken.value.length > 0)

/**
 * 封面配色：按书名稳定取色（同一本书每次打开颜色一致，不会闪）。
 *
 * 用琥珀-棕-橄榄这一族的低饱和色，和软件整体米白暖纸底协调；
 * 避免高饱和撞色（那会让书架看起来像随机色卡而不是书架）。
 */
const SPINE_PALETTE: readonly { from: string; to: string; ink: string }[] = [
  { from: '#c98a4b', to: '#a86a34', ink: '#fffaf2' },
  { from: '#8a6f4e', to: '#6b543a', ink: '#fdf6ea' },
  { from: '#7d8a63', to: '#5f6b4a', ink: '#f7faef' },
  { from: '#a2705e', to: '#82533f', ink: '#fdf3ec' },
  { from: '#6f7f8a', to: '#546169', ink: '#f2f8fb' },
  { from: '#9b7a3f', to: '#7a5d2c', ink: '#fdf7e9' },
  { from: '#8d6a7a', to: '#6d4e5c', ink: '#fbf1f5' },
  { from: '#7a6c93', to: '#5b4f72', ink: '#f5f1fd' }
]

function hashOf(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

function paletteOf(item: WorkspaceListItem): { from: string; to: string; ink: string } {
  return SPINE_PALETTE[hashOf(item.title || item.id) % SPINE_PALETTE.length]
}

/** 封面上的格言式小字：用章节/字数这类真实数据，不用编造文案 */
function metaLine(item: WorkspaceListItem): string {
  const parts: string[] = []
  if (item.chapterCount) parts.push(`${item.chapterCount} 章`)
  if (item.charCount) parts.push(`${(item.charCount / 10000).toFixed(1)} 万字`)
  return parts.join(' · ')
}

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const res = await window.feather.listWorkspaces()
    if (!res.ok) {
      error.value = res.error ?? '读取书库失败'
      items.value = []
      broken.value = []
      return
    }
    items.value = res.items
    broken.value = res.broken
  } catch (e) {
    error.value = (e as Error).message
    items.value = []
    broken.value = []
  } finally {
    loading.value = false
  }
}

onMounted(() => void refresh())

async function openBook(item: WorkspaceListItem): Promise<void> {
  if (busyId.value) return
  busyId.value = item.id
  error.value = ''
  try {
    // 按**目录名**打开（主键 = 目录名，不是 pkgId）
    const res = await window.feather.openWorkspace(item.id)
    if (!res.ok || !res.summary) {
      error.value = res.error ?? '打开工作库失败'
      return
    }
    emit('opened', res.summary)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busyId.value = ''
  }
}

async function removeBook(id: string, title: string, root: string): Promise<void> {
  if (busyId.value) return
  const ok = window.confirm(
    `确定删除《${title || id}》吗？\n\n` +
      `将永久删除该工作库目录（含全部解析产物），不可恢复。\n\n` +
      `目录：${root}`
  )
  if (!ok) return
  busyId.value = id
  error.value = ''
  try {
    const res = await window.feather.deleteWorkspace(id)
    if (!res.ok) {
      error.value = res.error ?? '删除失败'
      return
    }
    await refresh()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busyId.value = ''
  }
}

/**
 * 一键导出：把该工作库反向打包成 .t2w。
 *
 * 目标路径由主进程弹保存框给出（默认文件名 `<书名>.t2w`）；导出期间本条目的按钮禁用，
 * 结果直接显示路径与大小。缺分片/缺资产不会静默丢 —— 主进程回传 warnings，这里一并提示。
 */
async function exportBook(item: WorkspaceListItem): Promise<void> {
  if (busyId.value) return
  busyId.value = item.id
  error.value = ''
  exportNotice.value = ''
  try {
    const res = await window.feather.exportT2w(item.id)
    if (res.canceled) return
    if (!res.ok || !res.path) {
      error.value = res.error ?? '导出失败'
      return
    }
    const warns = res.warnings && res.warnings.length ? `（${res.warnings.length} 项缺失已跳过）` : ''
    exportNotice.value = `已导出《${item.title || item.id}》：${res.path}（${sizeOf(res.bytes ?? 0)}）${warns}`
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busyId.value = ''
  }
}

async function reveal(): Promise<void> {
  error.value = ''
  try {
    const res = await window.feather.revealWorkspace()
    if (!res.ok) error.value = res.error ?? '打开文件夹失败'
  } catch (e) {
    error.value = (e as Error).message
  }
}
</script>

<template>
  <div class="lib">
    <div class="card lib-toolbar">
      <h2>书架</h2>
      <div class="lib-actions">
        <button class="btn primary" @click="emit('import')">导入 .t2w</button>
        <button class="btn" @click="emit('import-txt')">导入 .txt</button>
        <button class="btn" :disabled="loading" @click="refresh">
          {{ loading ? '读取中…' : '刷新' }}
        </button>
        <button class="btn" @click="reveal">打开文件夹</button>

        <span class="lib-sort">
          <label class="hint" for="lib-sort-key">排序</label>
          <select id="lib-sort-key" class="select" :value="sortKey" data-testid="lib-sort-key" @change="onSortKeyChange">
            <option v-for="k in VALID_SORT_KEYS" :key="k" :value="k">{{ SORT_LABELS[k] }}</option>
          </select>
          <button class="btn" :title="sortAsc ? '当前升序，点按改为降序' : '当前降序，点按改为升序'" data-testid="lib-sort-dir" @click="toggleSortDir">
            {{ sortAsc ? '↑ 升序' : '↓ 降序' }}
          </button>
        </span>

        <span class="hint">
          {{ items.length }} 本<template v-if="broken.length"> · {{ broken.length }} 本损坏</template>
        </span>
      </div>
    </div>

    <div v-if="error" class="error">{{ error }}</div>
    <div v-if="exportNotice" class="lib-notice">{{ exportNotice }}</div>

    <div v-if="!hasAny" class="empty lib-empty">
      <div class="big">📚</div>
      <div>书架是空的</div>
      <button class="btn primary" @click="emit('import')">点这里导入 .t2w</button>
      <button class="btn" @click="emit('import-txt')">点这里导入 .txt</button>
      <div class="hint">导入会新建一本书（不查重、不覆盖），可以反复导入同一个文件</div>
      <div class="hint">纯本地读取，不会上传任何数据</div>
    </div>

    <!-- ===== 书架 ===== -->
    <div v-else class="shelf" data-testid="lib-shelf">
      <div
        v-for="it in sortedItems"
        :key="it.id"
        class="slot"
        :data-book-id="it.id"
        :data-testid="'lib-book-' + it.id"
      >
        <div
          class="book"
          :class="{ 'book-current': it.current, 'book-busy': busyId === it.id }"
          :style="{ '--from': paletteOf(it).from, '--to': paletteOf(it).to, '--ink': paletteOf(it).ink }"
          role="button"
          tabindex="0"
          :title="`打开《${it.title || it.id}》`"
          @click="openBook(it)"
          @keydown.enter.prevent="openBook(it)"
          @keydown.space.prevent="openBook(it)"
        >
          <!-- 书脊（左侧窄条） -->
          <div class="book-spine" aria-hidden="true"><span class="spine-line"></span></div>
          <!-- 封面 -->
          <div class="book-cover">
            <span v-if="it.current" class="book-badge">当前</span>
            <div class="cover-title">{{ it.title || '(无标题)' }}</div>
            <div v-if="metaLine(it)" class="cover-meta">{{ metaLine(it) }}</div>
            <div class="cover-foot">{{ sizeOf(it.t2wSize) }}</div>
          </div>
          <!-- 底部书页厚度 -->
          <div class="book-pages" aria-hidden="true"></div>
        </div>

        <!-- 悬停/常驻的操作条（放在书外，避免遮挡封面书名） -->
        <div class="slot-ops">
          <button class="btn mini" :disabled="!!busyId" @click.stop="exportBook(it)">
            {{ busyId === it.id ? '导出中' : '导出' }}
          </button>
          <button class="btn mini danger" :disabled="!!busyId" @click.stop="removeBook(it.id, it.title, it.root)">
            删除
          </button>
        </div>
      </div>

      <!-- 损坏项：单独一张「破书」卡 -->
      <div v-for="name in broken" :key="'broken-' + name" class="slot">
        <div class="book book-broken" role="button" tabindex="0" :title="`索引损坏：${name}`">
          <div class="book-spine" aria-hidden="true"><span class="spine-line"></span></div>
          <div class="book-cover">
            <span class="book-badge bad">损坏</span>
            <div class="cover-title">{{ name }}</div>
            <div class="cover-foot">索引损坏或未解析完</div>
          </div>
          <div class="book-pages" aria-hidden="true"></div>
        </div>
        <div class="slot-ops">
          <button class="btn mini danger" :disabled="!!busyId" @click.stop="removeBook(name, name, '')">删除</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ===== 工具条 ===== */
.lib-toolbar h2 {
  margin-bottom: 10px;
}

.lib-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.lib-sort {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  padding-left: 6px;
  margin-left: 4px;
  border-left: 1px solid var(--border);
}

.lib-sort .select {
  width: auto;
  min-width: 92px;
  padding: 5px 8px;
}

.lib-notice {
  margin: 0 0 10px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius-btn);
  background: var(--panel);
  font-size: 12px;
  color: var(--muted);
  word-break: break-all;
}

.lib-empty {
  gap: 10px;
}

/* ===== 书架：每排固定 5 本 ===== */
.shelf {
  display: grid;
  /* 固定 5 列；minmax(0,1fr) 让书本自己缩窄，不会把第 5 本挤到下一排 */
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 26px 20px;
  padding: 6px 4px 28px;
  /* 木质隔板的感觉：一条极淡的横向纹理，不做重装饰 */
  background:
    repeating-linear-gradient(
      to bottom,
      transparent 0,
      transparent 156px,
      rgba(201, 183, 158, 0.16) 156px,
      rgba(201, 183, 158, 0.16) 158px,
      transparent 158px,
      transparent 182px
    );
}

.slot {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 7px;
  min-width: 0;
}

/* ===== 一本书 ===== */
.book {
  position: relative;
  display: flex;
  /* 竖版书：高比宽约 1.42（接近真实开本），宽度由 5 列网格决定 */
  aspect-ratio: 1 / 1.42;
  border-radius: 3px 7px 7px 3px;
  cursor: pointer;
  outline: none;
  transform: translateZ(0);
  transition:
    transform var(--dur) var(--spring),
    filter var(--dur-fast) ease;
  /* 投影分两层：贴地的短影 + 右侧的长影，立体感主要靠这个 */
  filter: drop-shadow(1px 2px 2px rgba(58, 46, 34, 0.22))
    drop-shadow(6px 8px 14px rgba(58, 46, 34, 0.16));
}

.book:hover,
.book:focus-visible {
  transform: translateY(-5px) rotate(-0.6deg);
  filter: drop-shadow(1px 3px 3px rgba(58, 46, 34, 0.26))
    drop-shadow(9px 12px 20px rgba(58, 46, 34, 0.24));
}

.book-current {
  /* 当前打开的那本：琥珀描边 + 稍亮，一眼能认出 */
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.book-busy {
  opacity: 0.62;
  pointer-events: none;
}

/* 书脊：左侧深色窄条 + 一道压印线 */
.book-spine {
  position: relative;
  width: 9%;
  min-width: 9px;
  border-radius: 3px 0 0 3px;
  background: linear-gradient(to right, rgba(0, 0, 0, 0.34), rgba(0, 0, 0, 0.12) 65%, rgba(255, 255, 255, 0.1));
}

.spine-line {
  position: absolute;
  inset: 6% auto 6% 62%;
  width: 1px;
  background: rgba(255, 255, 255, 0.28);
}

/* 封面：书名是主体 */
.book-cover {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 7px;
  padding: 12px 11px 12px 10px;
  border-radius: 0 7px 7px 0;
  background: linear-gradient(140deg, var(--from), var(--to));
  color: var(--ink);
  overflow: hidden;
}

/* 封面上一道柔和斜光，让平面色块有点纸面质感 */
.book-cover::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(118deg, rgba(255, 255, 255, 0.2) 0 26%, transparent 45% 100%);
  pointer-events: none;
}

.cover-title {
  position: relative;
  z-index: 1;
  font-size: clamp(12px, 1.05vw, 15px);
  font-weight: 700;
  line-height: 1.38;
  letter-spacing: 0.4px;
  text-align: center;
  /* 长书名最多 4 行，超出省略，保证每本书高度一致 */
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.24);
  word-break: break-word;
}

.cover-meta {
  position: relative;
  z-index: 1;
  font-size: 10px;
  text-align: center;
  opacity: 0.82;
  letter-spacing: 0.3px;
}

.cover-foot {
  position: absolute;
  z-index: 1;
  right: 9px;
  bottom: 7px;
  font-size: 9px;
  opacity: 0.7;
  letter-spacing: 0.3px;
}

.book-badge {
  position: absolute;
  z-index: 2;
  top: 6px;
  left: 7px;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 9px;
  line-height: 1.5;
  background: rgba(255, 255, 255, 0.9);
  color: #8a5a20;
  font-weight: 700;
}

.book-badge.bad {
  background: var(--bad);
  color: #fff;
}

/* 底部书页：几道白色横纹 = 纸页厚度 */
.book-pages {
  position: absolute;
  left: 2%;
  right: 0;
  bottom: -4px;
  height: 5px;
  border-radius: 0 0 4px 4px;
  background:
    repeating-linear-gradient(to bottom, #fffdf8 0 1px, #d9cdb6 1px 2px);
  box-shadow: 0 1px 2px rgba(58, 46, 34, 0.2);
  pointer-events: none;
}

.book-broken {
  cursor: default;
  filter: grayscale(0.7) drop-shadow(1px 2px 2px rgba(58, 46, 34, 0.18));
  --from: #a99f92;
  --to: #8b8175;
  --ink: #fbf7f0;
}

.book-broken:hover {
  transform: none;
}

/* ===== 书下操作条 ===== */
.slot-ops {
  display: flex;
  gap: 5px;
  justify-content: center;
  opacity: 0;
  transition: opacity var(--dur-fast) ease;
}

.slot:hover .slot-ops,
.slot:focus-within .slot-ops {
  opacity: 1;
}

.btn.mini {
  padding: 3px 9px;
  font-size: 11px;
  line-height: 1.5;
}

/* 窄窗口：仍然 5 列（用户要求），只把间距与字号收小 */
@media (max-width: 900px) {
  .shelf {
    gap: 18px 12px;
  }
  .cover-title {
    font-size: 11px;
  }
  .cover-meta,
  .cover-foot {
    display: none;
  }
}
</style>

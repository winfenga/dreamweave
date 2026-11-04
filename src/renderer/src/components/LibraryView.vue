<script setup lang="ts">
/**
 * 书库管理页（落地页）。
 *
 * - 列表 = `workspace:list`（逐个 readIndex；损坏项单列，不抛错）；
 * - 列表项主键 = `item.id`（**工作库目录名**）；「打开」/「删除」一律按它调 IPC。
 *   历史工作库的目录名恰等于 pkgId，但改造后新书目录名是 `<UTC14位>-<随机hex>`，
 *   与 pkgId 已解耦 —— 因此**必须用 id 而不是 pkgId**，否则新导入的书点不开。
 * - 「删除」→ 二次确认（显示书名 + 永久删除声明）→ `workspace:delete` → 刷新列表；
 * - 顶部：导入 .t2w（上抛 import 由 App 复用 doImport）/ 导入 .txt（上抛 import-txt）/
 *   刷新列表 / 打开工作库文件夹；
 * - 显示标题 = 来源文件名（由主进程给出）；同一来源反复导入可并存多本，**无任何重复/覆盖提示**；
 *   .txt 导入与 .t2w 完全同构：同样无条件新建一本工作库，列表标题同样取来源文件名。
 */
import { computed, onMounted, ref } from 'vue'
import type { ImportSummary } from '../../../shared/app-types'
import type { WorkspaceListItem } from '../../../shared/workspace-types'

/**
 * 无入参：「当前打开」判定已下移到主进程 —— 列表项自带的 `current` 字段按**目录**比较得出。
 * 早先用 `pkgId` 比较，改造后同一 pkgId 可并存多份副本，会把若干副本同时标成「当前打开」。
 */
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
/** 导出成功的提示（路径 + 大小）；新一次导出前清空，避免残留上一次的结果 */
const exportNotice = ref('')

/** 排序键与方向（表头点击排序；选择持久化到 localStorage） */
type SortKey = 'title' | 'chapterCount' | 'charCount' | 't2wSize' | 'createdAt'
const SORT_KEY_LS = 'feather.lib.sort'
const VALID_SORT_KEYS: readonly SortKey[] = ['title', 'chapterCount', 'charCount', 't2wSize', 'createdAt']

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

function setSort(key: SortKey): void {
  if (sortKey.value === key) {
    sortAsc.value = !sortAsc.value
  } else {
    sortKey.value = key
    sortAsc.value = key === 'title' // 文本列默认升序，数值/时间列默认降序（新的在前）
    if (key === 'title') sortAsc.value = true
    else sortAsc.value = false
  }
  try {
    localStorage.setItem(SORT_KEY_LS, JSON.stringify({ key: sortKey.value, asc: sortAsc.value }))
  } catch {
    /* localStorage 不可用时排序仍生效，只是不记忆 */
  }
}

function sortIcon(key: SortKey): string {
  if (sortKey.value !== key) return '↕'
  return sortAsc.value ? '↑' : '↓'
}

/** 排序后的可排序列表（损坏项不参与排序，永远垫底） */
const sortedItems = computed(() => {
  const k = sortKey.value
  const mul = sortAsc.value ? 1 : -1
  return [...items.value].sort((a, b) => {
    if (k === 'title') {
      const ta = a.title || ''
      const tb = b.title || ''
      return ta.localeCompare(tb, 'zh-Hans-CN') * mul
    }
    const na = Number(a[k]) || 0
    const nb = Number(b[k]) || 0
    return (na - nb) * mul
  })
})

const sizeOf = (n: number): string => {
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
  return n + ' B'
}

const hasAny = computed(() => items.value.length > 0 || broken.value.length > 0)

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
    // 按**目录名**删除
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
 * 一键导出（C2）：把该工作库反向打包成 .t2w。
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
    <div class="card">
      <h2>书库</h2>
      <div class="lib-actions">
        <button class="btn primary" @click="emit('import')">导入 .t2w</button>
        <button class="btn" @click="emit('import-txt')">导入 .txt</button>
        <button class="btn" :disabled="loading" @click="refresh">
          {{ loading ? '读取中…' : '刷新列表' }}
        </button>
        <button class="btn" @click="reveal">打开工作库文件夹</button>
        <span class="hint">{{ items.length }} 个工作库<template v-if="broken.length"> · {{ broken.length }} 个损坏</template></span>
      </div>
    </div>

    <div v-if="error" class="error">{{ error }}</div>
    <div v-if="exportNotice" class="lib-notice">{{ exportNotice }}</div>

    <div v-if="!hasAny" class="empty lib-empty">
      <div class="big">📚</div>
      <div>书库为空</div>
      <button class="btn primary" @click="emit('import')">点这里导入 .t2w</button>
      <button class="btn" @click="emit('import-txt')">点这里导入 .txt</button>
      <div class="hint">
        导入 .t2w 或 .txt 都会**无条件新建**一本工作库（不查重、不覆盖、零提示），可反复导入同一文件
      </div>
      <div class="hint">纯本地读取，不会上传任何数据</div>
    </div>

    <div v-else class="card">
      <table class="table lib-table">
        <thead>
          <tr>
            <th class="th-sort" data-testid="sort-title" @click="setSort('title')">书名 {{ sortIcon('title') }}</th>
            <th class="th-sort" data-testid="sort-chapterCount" @click="setSort('chapterCount')">
              章节 {{ sortIcon('chapterCount') }}
            </th>
            <th class="th-sort" data-testid="sort-charCount" @click="setSort('charCount')">
              字符数 {{ sortIcon('charCount') }}
            </th>
            <th class="th-sort" data-testid="sort-t2wSize" @click="setSort('t2wSize')">
              包体积 {{ sortIcon('t2wSize') }}
            </th>
            <th class="th-sort" data-testid="sort-createdAt" @click="setSort('createdAt')">
              导入时间 {{ sortIcon('createdAt') }}
            </th>
            <th>来源 .t2w</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="it in sortedItems" :key="it.id" :class="{ 'lib-current': it.current }">
            <td class="lib-title">
              <span>{{ it.title || '(无标题)' }}</span>
              <span v-if="it.current" class="badge ok lib-tag">当前打开</span>
            </td>
            <td class="num">{{ it.chapterCount }}</td>
            <td class="num">{{ it.charCount.toLocaleString() }}</td>
            <td class="num">{{ sizeOf(it.t2wSize) }}</td>
            <td class="num">{{ it.createdAt }}</td>
            <td class="lib-path" :title="it.t2wPath">{{ it.t2wPath || '(未知来源)' }}</td>
            <td><span class="badge ok">正常</span></td>
            <td class="lib-ops">
              <button class="btn" :disabled="!!busyId" @click="openBook(it)">打开</button>
              <button class="btn" :disabled="!!busyId" @click="exportBook(it)">
                {{ busyId === it.id ? '导出中…' : '导出' }}
              </button>
              <button class="btn danger" :disabled="!!busyId" @click="removeBook(it.id, it.title, it.root)">
                删除
              </button>
            </td>
          </tr>
          <tr v-for="name in broken" :key="'broken-' + name" class="lib-broken">
            <td class="lib-title">{{ name }}</td>
            <td class="num">—</td>
            <td class="num">—</td>
            <td class="num">—</td>
            <td class="num">—</td>
            <td class="lib-path" :title="name">(索引损坏或未解析完)</td>
            <td><span class="badge bad">已损坏</span></td>
            <td class="lib-ops">
              <button class="btn danger" :disabled="!!busyId" @click="removeBook(name, name, '')">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

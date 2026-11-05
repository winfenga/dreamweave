<script setup lang="ts">
/**
 * 任务面板（T5）：把原「解析」小卡片升级为**按 29 个任务分组**的面板。
 *
 * 三层信息，各走各的通道，互不依赖：
 *  1. **任务面板**（`tasksOverview` IPC → `buildTasksOverview`）：一行一个注册表任务，
 *     `实例 actual/expected` + 状态计数（成功/失败/跳过/本地/待跑）+ 失败首条原因 + 重跑按钮。
 *     打开面板即拉一次（不依赖 runId），运行中每 2 秒刷新一次，运行结束再拉一次。
 *  2. **本次运行进度**（`pipeline:progress` 事件 + `parseStatus` 每秒轮询）：进度条、
 *     当前任务、本次运行的成功/失败/跳过/本地计数、失败实例明细（实例键级）。
 *  3. **启动 / 取消 / 子集**：`parseStart`（range='all' 或任务 id 数组）/ `parseCancel`。
 *
 * 「来源包自带 N 条历史（不计入本机成绩）」单独成行：包内历史（导入 .t2w 时整包解包带来的
 * 12 字段 succeeded 条目）由 `persistence.loadTaskStates()` 在读取侧剔除，只在
 * `overview.inheritedTotal` 里计数展示 —— 让用户看懂「为什么本机成功数不是包内那个数」。
 *
 * 重跑复用同一个 `parseStart`：编排器按指纹幂等（已 succeeded 且指纹一致的实例自动跳过），
 * 故「重跑某任务」= `parseStart(pkgId, [taskId])`，无需另开接口。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type {
  ParseProgress,
  ParseStatus,
  TaskOverviewItem,
  TasksOverview
} from '../../../shared/pipeline-types'
import type { TaskState } from '../../../shared/workspace-types'
import ImagegenPanel from './ImagegenPanel.vue'

const props = defineProps<{ pkgId: string }>()

/** 运行中刷新任务面板的间隔（与 1 秒的 parseStatus 轮询并存，刻意更慢）。 */
const OVERVIEW_INTERVAL_MS = 2000
/** 运行中刷新 parseStatus 的间隔。 */
const STATUS_INTERVAL_MS = 1000

// —— 本次运行状态（parseStatus / 进度事件）——
const runId = ref('')
const phase = ref<ParseProgress['phase'] | ''>('')
const done = ref(0)
const total = ref(0)
const currentTask = ref('')
const running = ref(false)
const error = ref('')
const tasks = ref<Record<string, TaskState>>({})
const subset = ref('cacheWarming,seg')
const busy = ref(false)

// —— 任务面板（tasksOverview）——
const overview = ref<TasksOverview | null>(null)
const overviewError = ref('')

let unsub: (() => void) | null = null
let statusTimer: ReturnType<typeof setInterval> | null = null
let overviewTimer: ReturnType<typeof setInterval> | null = null

/** 本次运行的实例状态计数（parseStatus 口径）。 */
const counts = computed(() => {
  const c: Record<string, number> = { succeeded: 0, failed: 0, skipped: 0, local: 0, running: 0, pending: 0 }
  for (const s of Object.values(tasks.value)) {
    const k = s.status
    c[k] = (c[k] ?? 0) + 1
  }
  return c
})

/** 本次运行的失败实例明细（实例键级，parseStatus 口径）。 */
const failures = computed(() =>
  Object.entries(tasks.value)
    .filter(([, s]) => s.status === 'failed')
    .map(([k, s]) => ({ key: k, error: s.error ?? '' }))
)

/** 面板行（= 注册表任务，已按拓扑序）。 */
const rows = computed<TaskOverviewItem[]>(() => overview.value?.tasks ?? [])

const pct = computed(() => (total.value > 0 ? Math.round((done.value / total.value) * 100) : 0))

/** G4：毫秒 → 可读时长（1.2s / 45.3s / 3m05s） */
function fmtElapsed(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${String(s).padStart(2, '0')}s`
}

/** 运行中禁用一切会再次触发编排的按钮（避免并发两次 run）。 */
const actionsDisabled = computed(() => busy.value || running.value)

async function refreshStatus(): Promise<void> {
  if (!runId.value) return
  try {
    const st: ParseStatus = await window.dreamweave.parseStatus(runId.value)
    tasks.value = st.tasks
    done.value = st.done
    total.value = st.total
    if (st.error) error.value = st.error
    running.value = st.running
    if (!st.running) {
      stopStatusPolling()
      await finishRun()
    }
  } catch (e) {
    error.value = (e as Error).message
  }
}

function startStatusPolling(): void {
  if (statusTimer) clearInterval(statusTimer)
  statusTimer = setInterval(() => void refreshStatus(), STATUS_INTERVAL_MS)
}

function stopStatusPolling(): void {
  if (statusTimer) {
    clearInterval(statusTimer)
    statusTimer = null
  }
}

/** 运行中每 2 秒刷新任务面板（运行结束即停）。 */
function startOverviewPolling(): void {
  if (overviewTimer) clearInterval(overviewTimer)
  overviewTimer = setInterval(() => void refreshOverview(), OVERVIEW_INTERVAL_MS)
}

function stopOverviewPolling(): void {
  if (overviewTimer) {
    clearInterval(overviewTimer)
    overviewTimer = null
  }
}

/** 运行收尾：停止面板轮询并拉一次最终状态（失败明细/计数要反映本次结果）。 */
async function finishRun(): Promise<void> {
  stopOverviewPolling()
  await refreshOverview()
}

/** 拉一次任务面板（不依赖 runId；打开面板即拉）。 */
async function refreshOverview(): Promise<void> {
  try {
    const res = await window.dreamweave.tasksOverview(props.pkgId)
    if (!res.ok || !res.overview) {
      overviewError.value = res.error ?? '读取任务面板失败'
      return
    }
    overviewError.value = ''
    overview.value = res.overview
  } catch (e) {
    overviewError.value = (e as Error).message
  }
}

async function start(range: string[] | 'all', force = false): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const res = await window.dreamweave.parseStart(props.pkgId, range, force)
    if (!res.ok || !res.runId) {
      error.value = res.error ?? '启动解析失败'
      return
    }
    runId.value = res.runId
    phase.value = 'start'
    done.value = 0
    total.value = 0
    running.value = true
    startStatusPolling()
    startOverviewPolling()
    await refreshStatus()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

/**
 * 一键子集：按产物用途分组，让用户不必记 33 个任务名。
 *
 * 【为什么必须自动补全前置，而不能只传"目标任务"】
 * 编排器对 `range` 是**严格过滤**（`ordered.filter(t => rangeSet.has(t.id))`），
 * 不在 range 里的任务根本不会被调度。而每个任务都有自己的上游依赖，
 * 只传目标任务会因为「依赖未就绪」被整批跳过 —— 看起来像"点了没反应"。
 * 所以这里按注册表的 `dependsOn` 做一次**闭包展开**，把前置一并带上。
 *
 * 【分组口径】
 *   - 演出：feature 属于 visualNovel / events 的一组（剧本、特效、地图、印象）
 *   - 漫画：feature 属于 manga 的一组（分镜、特效、配乐）
 *   - 人物：feature 属于 entities / characters / relations / factions / items / creatures
 *   - always / any：公共基础（缓存预热、阅读记忆压缩），所有分组都要
 * 这套口径直接来自注册表的 feature 字段，不另设映射表 —— 注册表加任务时自动跟上。
 */
type SubsetKey = 'show' | 'manga' | 'people'

const SUBSET_DEFS: Record<SubsetKey, { label: string; hint: string; features: string[] }> = {
  show: {
    label: '只做演出',
    hint: '剧本 + 特效 + 地图 + 印象图谱（小说演出用）',
    features: ['visualNovel', 'events']
  },
  manga: {
    label: '只做漫画',
    hint: '分镜脚本 + 漫画特效 + 配乐需求',
    features: ['manga']
  },
  people: {
    label: '只做人物档案',
    hint: '人物/势力/物品/生物 + 关系网（角色卡用）',
    features: ['entities', 'characters', 'relations', 'factions', 'items', 'creatures']
  }
}

/**
 * 依赖声明 → 基础任务 id。
 * 注册表里的依赖带后缀语义（`X:i` / `X:*` / `X:next` / `X:selected` / `X:n`），
 * 展开闭包时只关心"是哪个任务"，后缀由编排器按实例自己解析。
 */
function depBaseOf(dep: string): string {
  const i = dep.indexOf(':')
  return i < 0 ? dep : dep.slice(0, i)
}

/** 公共基础任务：所有分组都必须带上（否则下游全部"依赖未就绪"） */
const ALWAYS_FEATURES = ['always', 'any']

/**
 * 计算某分组的**完整任务 id 列表**（含传递前置）。
 *
 * 做法：从种子集合出发反复扫表，凡是依赖落在集合内的一律并入，直到不再增长。
 * 复杂度是 O(n²) 但 n=33，完全可以忽略。
 */
function buildSubset(key: SubsetKey): string[] {
  const def = SUBSET_DEFS[key]
  const all = rows.value
  if (!all.length) return []

  const byId = new Map(all.map((t) => [t.id, t]))
  const picked = new Set<string>()

  // 种子：本组 feature + 公共基础
  for (const t of all) {
    if (def.features.includes(t.feature) || ALWAYS_FEATURES.includes(t.feature)) picked.add(t.id)
  }

  // 闭包展开：反复把"目标任务的前置"并进来
  let grew = true
  while (grew) {
    grew = false
    for (const id of [...picked]) {
      const t = byId.get(id)
      if (!t) continue
      for (const dep of t.dependsOn ?? []) {
        const base = depBaseOf(dep)
        if (byId.has(base) && !picked.has(base)) {
          picked.add(base)
          grew = true
        }
      }
    }
  }

  // 保持注册表原序（即拓扑序），编排器不需要再排
  return all.filter((t) => picked.has(t.id)).map((t) => t.id)
}

const subsetCounts = computed<Record<SubsetKey, number>>(() => {
  const out = { show: 0, manga: 0, people: 0 }
  if (!rows.value.length) return out
  for (const k of Object.keys(SUBSET_DEFS) as SubsetKey[]) out[k] = buildSubset(k).length
  return out
})

function startSubsetKey(key: SubsetKey): void {
  if (actionsDisabled.value) return
  const ids = buildSubset(key)
  if (!ids.length) {
    error.value = '任务清单还没加载出来，稍等再试'
    return
  }
  void start(ids)
}

function startAll(): void {
  void start('all')
}

/** 强制重跑（G3）：已成功的实例也重新发请求（忽略指纹幂等）。需二次确认。 */
function startAllForce(): void {
  if (actionsDisabled.value) return
  const ok = window.confirm(
    '强制重跑会对「已成功的实例」也重新发起请求（不消耗的本地任务除外），\n' +
      '可能产生额外的 LLM 调用耗时与用量。\n\n确定继续吗？'
  )
  if (!ok) return
  void start('all', true)
}

function startSubset(): void {
  const ids = subset.value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!ids.length) {
    error.value = '请输入要解析的任务 id（逗号分隔）'
    return
  }
  void start(ids)
}

/** 重跑某任务：复用 parseStart（编排器按指纹幂等，已成功且输入未变的实例自动跳过）。 */
function rerun(taskId: string): void {
  if (actionsDisabled.value) return
  void start([taskId])
}

async function cancel(): Promise<void> {
  if (!runId.value) return
  try {
    await window.dreamweave.parseCancel(runId.value)
  } catch (e) {
    error.value = (e as Error).message
  }
}

onMounted(() => {
  // 打开面板立即拉一次任务面板（不依赖 runId，刷新页面也能看到本机成绩）
  void refreshOverview()

  unsub = window.dreamweave.onParseProgress((ev: ParseProgress) => {
    if (ev.pkgId !== props.pkgId) return
    if (ev.runId) runId.value = ev.runId
    if (ev.done !== undefined) done.value = ev.done
    if (ev.total !== undefined) total.value = ev.total
    if (ev.taskId) currentTask.value = ev.instanceKey ? `${ev.taskId} · ${ev.instanceKey}` : ev.taskId
    if (ev.phase === 'done' || ev.phase === 'error' || ev.phase === 'cancelled') {
      phase.value = ev.phase
      running.value = false
      if (ev.message) error.value = ev.message
      void refreshStatus()
      void finishRun()
    } else if (ev.phase === 'start') {
      phase.value = 'start'
      running.value = true
      startOverviewPolling()
    } else if (ev.phase === 'task') {
      phase.value = 'task'
    }
  })
})

onUnmounted(() => {
  if (unsub) unsub()
  stopStatusPolling()
  stopOverviewPolling()
})
</script>

<template>
  <div class="card">
    <h2>任务面板</h2>

    <div v-if="overview" class="parse-line" data-testid="parse-overview-stats">
      <span class="badge ok">成功 {{ overview.localCounts.succeeded }}</span>
      <span class="badge bad">失败 {{ overview.localCounts.failed }}</span>
      <span class="badge">跳过 {{ overview.localCounts.skipped }}</span>
      <span class="badge">本地 {{ overview.localCounts.local }}</span>
      <span class="sub">
        本机：成功 {{ overview.localCounts.succeeded }} · 失败 {{ overview.localCounts.failed }} · 跳过
        {{ overview.localCounts.skipped }} · 本地 {{ overview.localCounts.local }}（共 {{ overview.localTotal }} 个实例 ·
        {{ overview.tasks.length }} 个任务）
      </span>
    </div>
    <div v-if="overview && overview.inheritedTotal > 0" class="parse-line">
      <span class="sub">来源包自带 {{ overview.inheritedTotal }} 条历史（不计入本机成绩）</span>
    </div>
    <div v-if="overviewError" class="error" style="margin-top: 10px">{{ overviewError }}</div>

    <!--
      一键子集：按「要什么产物」分组。
      放在「开始解析（全部）」下面而不是替代它 —— 想全跑的人仍然点原来那个按钮。
      每个按钮上带任务数，让人知道这次会发多少请求（33 个任务全跑是很贵的）。
    -->
    <div class="parse-presets" data-testid="parse-presets">
      <span class="hint">按用途解析：</span>
      <button
        v-for="(def, key) in SUBSET_DEFS"
        :key="key"
        class="btn preset-btn"
        :data-testid="'parse-preset-' + key"
        :disabled="actionsDisabled || !rows.length"
        :title="def.hint"
        @click="startSubsetKey(key as SubsetKey)"
      >
        {{ def.label }}
        <span class="preset-count">{{ subsetCounts[key as SubsetKey] }} 个任务</span>
      </button>
    </div>

    <div class="parse-actions" style="margin-top: 12px">
      <button class="btn primary" data-testid="parse-start" :disabled="actionsDisabled" @click="startAll">
        {{ running ? '解析中…' : '开始解析（全部）' }}
      </button>
      <input
        v-model="subset"
        class="select parse-subset"
        data-testid="parse-subset"
        placeholder="任务子集，逗号分隔，如 cacheWarming,seg"
        spellcheck="false"
      />
      <button class="btn" data-testid="parse-subset-start" :disabled="actionsDisabled" @click="startSubset">
        按子集解析
      </button>
      <button class="btn danger" data-testid="parse-force-start" :disabled="actionsDisabled" title="已成功的实例也重新请求" @click="startAllForce">
        强制重跑
      </button>
      <button v-if="running" class="btn danger" data-testid="parse-cancel" @click="cancel">取消</button>
    </div>

    <div v-if="phase" class="parse-progress">
      <div class="parse-bar"><i :style="{ width: pct + '%' }" /></div>
      <div class="parse-line">
        <span class="badge" :class="phase === 'error' ? 'bad' : phase === 'done' ? 'ok' : ''">{{ phase }}</span>
        <span>{{ done }} / {{ total }}</span>
        <span v-if="currentTask" class="hint">当前：{{ currentTask }}</span>
      </div>
      <div class="parse-line">
        <span class="badge ok">成功 {{ counts.succeeded }}</span>
        <span class="badge bad">失败 {{ counts.failed }}</span>
        <span class="badge">跳过 {{ counts.skipped }}</span>
        <span class="badge">本地 {{ counts.local }}</span>
      </div>
    </div>

    <div v-if="error" class="error" style="margin-top: 10px">{{ error }}</div>

    <div v-if="failures.length" class="parse-failures">
      <h4>本次运行失败实例（{{ failures.length }}）</h4>
      <div v-for="f in failures" :key="f.key" class="parse-failure">
        <div class="sub">{{ f.key }}</div>
        <div class="error" style="margin: 4px 0 0">{{ f.error }}</div>
      </div>
    </div>

    <div v-if="rows.length" class="parse-tasks">
      <h4>任务（{{ rows.length }}）</h4>
      <table class="table">
        <thead>
          <tr>
            <th>任务</th>
            <th>类型</th>
            <th>实例</th>
            <th>状态</th>
            <th data-testid="col-elapsed">耗时</th>
            <th>失败原因</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in rows" :key="t.id">
            <td>
              <div>{{ t.label }}</div>
              <div class="sub">{{ t.id }}</div>
            </td>
            <td>
              <span class="badge" :class="t.model ? '' : 'ok'">{{ t.model ? 'LLM' : '本地' }}</span>
            </td>
            <td class="num">{{ t.actual }} / {{ t.expected }}</td>
            <td>
              <div style="display: flex; gap: 4px; flex-wrap: wrap">
                <span class="badge" :class="t.counts.succeeded ? 'ok' : ''">成功 {{ t.counts.succeeded }}</span>
                <span class="badge" :class="t.counts.failed ? 'bad' : ''">失败 {{ t.counts.failed }}</span>
                <span class="badge">跳过 {{ t.counts.skipped }}</span>
                <span class="badge">本地 {{ t.counts.local }}</span>
                <span v-if="t.counts.running" class="badge ok">运行 {{ t.counts.running }}</span>
                <span class="badge">待跑 {{ t.counts.pending }}</span>
              </div>
            </td>
            <td class="num" :title="t.avgElapsedMs !== null ? `平均耗时（有耗时的 ${t.counts.succeeded + t.counts.failed + t.counts.local} 个实例）` : '暂无耗时数据'">
              {{ fmtElapsed(t.avgElapsedMs) }}
            </td>
            <td class="sub" style="word-break: break-all; max-width: 320px">
              <template v-if="t.failures.length">
                <div>{{ t.failures[0].error || '（无错误信息）' }}</div>
                <div v-if="t.failures.length > 1" class="sub">另有 {{ t.failures.length - 1 }} 条失败</div>
              </template>
            </td>
            <td>
              <button
                class="btn"
                :data-testid="`parse-rerun-${t.id}`"
                :disabled="actionsDisabled"
                :title="`重跑 ${t.label}`"
                @click="rerun(t.id)"
              >
                重跑
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 生图（本地 ComfyUI）：人物立绘 / 场景图 / 地图地点图标，回填工作库 -->
    <ImagegenPanel :pkg-id="pkgId" />
  </div>
</template>

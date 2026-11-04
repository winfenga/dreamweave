<script setup lang="ts">
/**
 * 生图面板（本地 ComfyUI）：人物立绘 / 场景图 / 地图地点图标 三类目标。
 *
 * - 目标清单来自 `imagegen:targets`（纯读，含缺图标记）；默认「只补缺图」，
 *   已有图时按钮变「重新生成」（force 覆盖：写新资产 + 条目指向新 entryPath，旧文件不删）。
 * - 顶部「批量生成全部缺图」：三类目标**逐张串行**调用 `imagegen:generate`，
 *   逐行显示进度 / 结果 / 错误（当前第 N / 共 M）。
 * - ComfyUI 地址、提示词模板、工作流 JSON 在「设置 → 生图（ComfyUI）」里配置。
 * - 生成成功后立绘/场景/地图 view 需重新拉取才可见（view 数据经 t2w:view 装配）。
 */
import { computed, onMounted, ref } from 'vue'
import type {
  CharTarget,
  IconTarget,
  ImagegenKind,
  ImagegenTargetsResult,
  SceneTarget
} from '../../../shared/imagegen-types'

const props = defineProps<{ pkgId: string }>()

const targets = ref<ImagegenTargetsResult['targets'] | null>(null)
const loadError = ref('')
const loading = ref(false)

/** 探活状态 */
const probeState = ref('')
const probing = ref(false)

/** 每行生成状态：targetId → {state, message} */
type RowState = { state: 'running' | 'ok' | 'error'; message?: string }
const rowStates = ref<Record<string, RowState>>({})

/** 批量进度（串行逐张） */
const batchRunning = ref(false)
const batchDone = ref(0)
const batchTotal = ref(0)

const busy = computed(() => batchRunning.value || Object.values(rowStates.value).some((r) => r.state === 'running'))

const missingCount = computed(() => {
  const t = targets.value
  if (!t) return 0
  return (
    t.chars.filter((c) => !c.hasImage).length +
    t.scenes.filter((s) => !s.hasImage).length +
    t.icons.filter((i) => !i.hasIcon).length
  )
})

async function refreshTargets(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const res = await window.feather.imagegenTargets(props.pkgId)
    if (!res.ok || !res.targets) {
      loadError.value = res.error ?? '读取生图目标失败'
      return
    }
    targets.value = res.targets
  } catch (e) {
    loadError.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

async function probe(): Promise<void> {
  probing.value = true
  probeState.value = '探活中…'
  try {
    const res = await window.feather.imagegenProbe()
    probeState.value = res.ok ? res.info ?? '已就绪' : res.error ?? '探活失败'
  } catch (e) {
    probeState.value = (e as Error).message
  } finally {
    probing.value = false
  }
}

function rowKey(kind: ImagegenKind, id: string): string {
  return `${kind}:${id}`
}

async function generate(kind: ImagegenKind, targetId: string, force: boolean): Promise<boolean> {
  const key = rowKey(kind, targetId)
  rowStates.value = { ...rowStates.value, [key]: { state: 'running' } }
  try {
    const res = await window.feather.imagegenGenerate(props.pkgId, { kind, targetId, force })
    if (!res.ok || !res.entryPath) {
      rowStates.value = { ...rowStates.value, [key]: { state: 'error', message: res.error ?? '生成失败' } }
      return false
    }
    const msg = res.skipped ? `已有图，跳过（${res.entryPath}）` : `已回填：${res.entryPath}`
    rowStates.value = { ...rowStates.value, [key]: { state: 'ok', message: msg } }
    return true
  } catch (e) {
    rowStates.value = { ...rowStates.value, [key]: { state: 'error', message: (e as Error).message } }
    return false
  }
}

function generateChar(t: CharTarget, force: boolean): void {
  if (busy.value) return
  void generate('char', `${t.charId}::${t.appearanceId}`, force).then(() => void refreshTargets())
}

function generateScene(t: SceneTarget, force: boolean): void {
  if (busy.value) return
  void generate('scene', t.sceneId, force).then(() => void refreshTargets())
}

function generateIcon(t: IconTarget, force: boolean): void {
  if (busy.value) return
  void generate('icon', t.locationType, force).then(() => void refreshTargets())
}

/** 批量生成全部缺图（串行；单张失败不中断，结束后统一刷新目标清单） */
async function generateAllMissing(): Promise<void> {
  const t = targets.value
  if (!t || busy.value) return
  const jobs: { kind: ImagegenKind; id: string }[] = [
    ...t.chars.filter((c) => !c.hasImage).map((c) => ({ kind: 'char' as const, id: `${c.charId}::${c.appearanceId}` })),
    ...t.scenes.filter((s) => !s.hasImage).map((s) => ({ kind: 'scene' as const, id: s.sceneId })),
    ...t.icons.filter((i) => !i.hasIcon).map((i) => ({ kind: 'icon' as const, id: i.locationType }))
  ]
  if (!jobs.length) return
  batchRunning.value = true
  batchDone.value = 0
  batchTotal.value = jobs.length
  try {
    for (const job of jobs) {
      await generate(job.kind, job.id, false)
      batchDone.value += 1
    }
  } finally {
    batchRunning.value = false
    await refreshTargets()
  }
}

onMounted(() => void refreshTargets())
</script>

<template>
  <div class="imagegen" data-testid="imagegen-panel">
    <div class="parse-line" style="margin-bottom: 8px">
      <button class="btn primary" data-testid="imagegen-generate-all" :disabled="busy || missingCount === 0" @click="generateAllMissing">
        {{ batchRunning ? `生成中 ${batchDone}/${batchTotal}…` : `批量生成全部缺图（${missingCount}）` }}
      </button>
      <button class="btn" data-testid="imagegen-probe" :disabled="probing" @click="probe">检测 ComfyUI 连接</button>
      <button class="btn" :disabled="loading || busy" @click="refreshTargets">刷新</button>
      <span v-if="probeState" class="hint" data-testid="imagegen-probe-state">{{ probeState }}</span>
    </div>
    <div class="hint" style="margin-bottom: 8px">
      生图使用本地 ComfyUI（出图模型建议 Qwen-Image）；服务地址、提示词模板与工作流 JSON 在「设置 → 生图（ComfyUI）」配置。
      生成成功后，立绘 / 场景 / 地图页面需重新进入才会加载新图。
    </div>

    <div v-if="loadError" class="error" style="margin-bottom: 8px">{{ loadError }}</div>

    <template v-if="targets">
      <h4>人物形象（{{ targets.chars.length }}）</h4>
      <table class="table">
        <thead>
          <tr><th>角色 / 形象</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="c in targets.chars" :key="`${c.charId}::${c.appearanceId}`">
            <td>
              <div>{{ c.charName }} · {{ c.appearanceName }}</div>
              <div class="sub">{{ c.charId }} / {{ c.appearanceId }}</div>
            </td>
            <td>
              <span class="badge" :class="c.hasImage ? 'ok' : ''">{{ c.hasImage ? '已有图' : '缺图' }}</span>
              <div v-if="rowStates[`char:${c.charId}::${c.appearanceId}`]" class="sub" style="max-width: 320px; word-break: break-all">
                <template v-if="rowStates[`char:${c.charId}::${c.appearanceId}`].state === 'running'">生成中…</template>
                <template v-else-if="rowStates[`char:${c.charId}::${c.appearanceId}`].state === 'ok'">{{ rowStates[`char:${c.charId}::${c.appearanceId}`].message }}</template>
                <span v-else class="error">{{ rowStates[`char:${c.charId}::${c.appearanceId}`].message }}</span>
              </div>
            </td>
            <td>
              <button
                class="btn"
                :data-testid="`imagegen-char-${c.charId}-${c.appearanceId}`"
                :disabled="busy"
                @click="generateChar(c, c.hasImage)"
              >
                {{ c.hasImage ? '重新生成' : '生成' }}
              </button>
            </td>
          </tr>
          <tr v-if="!targets.chars.length"><td colspan="3" class="sub">未找到人物形象产物（先运行 characterAppearance 任务）</td></tr>
        </tbody>
      </table>

      <h4>场景（{{ targets.scenes.length }}）</h4>
      <table class="table">
        <thead>
          <tr><th>场景</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="s in targets.scenes" :key="s.sceneId">
            <td>
              <div>{{ s.name }}</div>
              <div class="sub">{{ s.sceneId }}</div>
            </td>
            <td>
              <span class="badge" :class="s.hasImage ? 'ok' : ''">{{ s.hasImage ? '已有图' : '缺图' }}</span>
              <div v-if="rowStates[`scene:${s.sceneId}`]" class="sub" style="max-width: 320px; word-break: break-all">
                <template v-if="rowStates[`scene:${s.sceneId}`].state === 'running'">生成中…</template>
                <template v-else-if="rowStates[`scene:${s.sceneId}`].state === 'ok'">{{ rowStates[`scene:${s.sceneId}`].message }}</template>
                <span v-else class="error">{{ rowStates[`scene:${s.sceneId}`].message }}</span>
              </div>
            </td>
            <td>
              <button class="btn" :data-testid="`imagegen-scene-${s.sceneId}`" :disabled="busy" @click="generateScene(s, s.hasImage)">
                {{ s.hasImage ? '重新生成' : '生成' }}
              </button>
            </td>
          </tr>
          <tr v-if="!targets.scenes.length"><td colspan="3" class="sub">未找到场景清单（先运行 plotLocation / plotLocationMerge 任务）</td></tr>
        </tbody>
      </table>

      <h4>地点类型（{{ targets.icons.length }}）</h4>
      <table class="table">
        <thead>
          <tr><th>类型</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="i in targets.icons" :key="i.locationType">
            <td><div>{{ i.locationType }}</div></td>
            <td>
              <span class="badge" :class="i.hasIcon ? 'ok' : ''">{{ i.hasIcon ? '已有图标' : '缺图标' }}</span>
              <div v-if="rowStates[`icon:${i.locationType}`]" class="sub" style="max-width: 320px; word-break: break-all">
                <template v-if="rowStates[`icon:${i.locationType}`].state === 'running'">生成中…</template>
                <template v-else-if="rowStates[`icon:${i.locationType}`].state === 'ok'">{{ rowStates[`icon:${i.locationType}`].message }}</template>
                <span v-else class="error">{{ rowStates[`icon:${i.locationType}`].message }}</span>
              </div>
            </td>
            <td>
              <button class="btn" :data-testid="`imagegen-icon-${i.locationType}`" :disabled="busy" @click="generateIcon(i, i.hasIcon)">
                {{ i.hasIcon ? '重新生成' : '生成' }}
              </button>
            </td>
          </tr>
          <tr v-if="!targets.icons.length"><td colspan="3" class="sub">未找到地点类型（先运行 locationTree 任务）</td></tr>
        </tbody>
      </table>
    </template>
  </div>
</template>

<style scoped>
.imagegen {
  margin-top: 18px;
}
</style>

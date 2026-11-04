<script setup lang="ts">
/**
 * 「🎬 特效」编辑区块（挂在 ScriptEditor 编辑面板内）：
 * - 单句 chips（含来源角标 手动/AI + 移除）
 * - 范围条目 + 范围构建（场景 / 句区间）+ 移除
 * - `＋添加特效`（单句）/ `＋挂到范围` / `✨AI 推荐` / `清空`
 * - AI 挂载后可撤销提示条
 *
 * 每次改动都把「期望的完整列表」声明式写回原包（主进程负责备份/复检/原子改名）；
 * 成功后 emit('saved') 触发上层 reloadView，使 view 原地刷新。
 * 所有写回反馈经 emit('notify') 复用 ScriptEditor 既有 `se-message`。
 */
import { computed, onMounted, ref, watch } from 'vue'
import type { StageAction, ViewData } from '../../../shared/app-types'
import type { EffectCatalogEntry, EffectMount, EffectRange, EffectSource } from '../../../shared/effects-types'
import { catalogById, loadCatalog } from '../lib/effectCatalog'
import { buildLookups, speakerName } from '../lib/viewModel'
import EffectPicker from './EffectPicker.vue'

const props = defineProps<{ view: ViewData; action: StageAction }>()
const emit = defineEmits<{ saved: []; notify: [msg: string, kind: 'ok' | 'err' | 'info'] }>()

const lookups = computed(() => buildLookups(props.view))

// ---- 目录 ----
const entries = ref<EffectCatalogEntry[]>([])
const catalogError = ref('')
const byId = computed(() => catalogById(entries.value))
const nameOf = (id: string): string => byId.value.get(id)?.name ?? id

// ---- 本句特效（本地镜像；以 props.action.effects 为源）----
const sentenceEffects = ref<EffectMount[]>([])
watch(
  () => props.action,
  (a) => {
    sentenceEffects.value = (a?.effects ?? []).map((m) => ({ ...m }))
  },
  { immediate: true }
)

// ---- 范围特效（以 view.effectRanges 为源）----
const ranges = ref<EffectRange[]>([])
watch(
  () => props.view.effectRanges,
  (r) => {
    ranges.value = (r ?? []).map((x) => ({ ...x }))
  },
  { immediate: true }
)

const busy = ref(false)
const modelReady = ref(false)

// ---- AI 撤销快照 ----
interface AiUndo {
  prev: EffectMount[]
  count: number
  dropped: string[]
}
const aiUndo = ref<AiUndo | null>(null)

// ---- 选择器 ----
const pickerOpen = ref(false)
const pickerMode = ref<'single' | 'range'>('single')

// ---- 范围构建 ----
const rangeScope = ref<'scene' | 'orders'>('scene')
const rangeStart = ref(props.action.order)
const rangeEnd = ref(props.action.order)
const sceneLabel = computed(() => lookups.value.sceneNameById.get(props.action.locationId) ?? props.action.locationId ?? '（无场景）')
const hasScene = computed(() => !!props.action.locationId)

onMounted(async () => {
  const cat = await loadCatalog()
  if (cat.entries) entries.value = cat.entries
  else catalogError.value = cat.error ?? '特效目录不可用'
  try {
    // Step1 收敛后：模型配置唯一真源 = llm[] + activeLlmId（与 suggestEffects 的判据保持一致，
    // 消除"AI 按钮判据读旧三框、实际请求读 llm[]"的两套配置错位）。
    const ps = await window.dreamweave.getProviders()
    const list = ps.llm ?? []
    const act = list.find((p) => p.id === ps.activeLlmId) ?? list.find((p) => p.enabled) ?? list[0]
    modelReady.value = !!(act && act.enabled && act.baseURL.trim() && act.apiKey.trim() && act.model.trim())
  } catch {
    modelReady.value = false
  }
})

// ---------------------------------------------------------------- 写回
async function writeSentence(effects: EffectMount[]): Promise<boolean> {
  busy.value = true
  try {
    const res = await window.dreamweave.saveEffects({
      sentence: {
        chapterSeq: props.action.chapterSeq,
        order: props.action.order,
        type: props.action.type,
        effects
      }
    })
    if (!res.ok) {
      emit('notify', res.error ?? '特效写回失败', 'err')
      return false
    }
    const v = res.verify
    emit(
      'notify',
      `已写回特效 · 备份 ${res.backupPath ?? '(未生成)'} · 复检 ${v ? `${v.passed}/${v.total}` : '—'} 通过`,
      'ok'
    )
    emit('saved')
    return true
  } catch (e) {
    emit('notify', (e as Error).message, 'err')
    return false
  } finally {
    busy.value = false
  }
}

async function writeRanges(next: EffectRange[]): Promise<boolean> {
  busy.value = true
  try {
    const res = await window.dreamweave.saveEffects({ ranges: next })
    if (!res.ok) {
      emit('notify', res.error ?? '范围特效写回失败', 'err')
      return false
    }
    const v = res.verify
    emit(
      'notify',
      `已写回范围特效 ${next.length} 条 · 备份 ${res.backupPath ?? '(未生成)'} · 复检 ${v ? `${v.passed}/${v.total}` : '—'} 通过`,
      'ok'
    )
    emit('saved')
    return true
  } catch (e) {
    emit('notify', (e as Error).message, 'err')
    return false
  } finally {
    busy.value = false
  }
}

// ---------------------------------------------------------------- 单句操作
/** 乐观更新 + 回滚：写回失败则恢复本地镜像 */
async function applySentence(next: EffectMount[]): Promise<boolean> {
  const prev = sentenceEffects.value.map((m) => ({ ...m }))
  sentenceEffects.value = next
  const ok = await writeSentence(next)
  if (!ok) sentenceEffects.value = prev
  return ok
}

function openPicker(mode: 'single' | 'range'): void {
  pickerMode.value = mode
  pickerOpen.value = true
}

function onPickerConfirm(ids: string[]): void {
  pickerOpen.value = false
  if (pickerMode.value === 'single') void addSingle(ids)
  else void addRange(ids)
}

async function addSingle(ids: string[]): Promise<void> {
  const have = new Set(sentenceEffects.value.map((m) => m.effectId))
  const add: EffectMount[] = ids
    .filter((id) => !have.has(id))
    .map((id) => ({ effectId: id, source: 'manual' as EffectSource }))
  if (!add.length) {
    emit('notify', '所选特效已在本句挂载', 'info')
    return
  }
  await applySentence([...sentenceEffects.value, ...add])
}

async function removeOne(effectId: string): Promise<void> {
  await applySentence(sentenceEffects.value.filter((m) => m.effectId !== effectId))
}

async function clearAll(): Promise<void> {
  if (!sentenceEffects.value.length) return
  await applySentence([])
}

// ---------------------------------------------------------------- 范围操作
async function addRange(ids: string[]): Promise<void> {
  const useScene = rangeScope.value === 'scene' && hasScene.value
  const base = {
    chapterSeq: props.action.chapterSeq,
    source: 'manual' as EffectSource
  }
  const newRanges: EffectRange[] = ids.map((id) =>
    useScene
      ? { scope: 'scene', sceneId: props.action.locationId, effectId: id, ...base }
      : {
          scope: 'orders',
          orderStart: Math.min(rangeStart.value, rangeEnd.value),
          orderEnd: Math.max(rangeStart.value, rangeEnd.value),
          effectId: id,
          ...base
        }
  )
  const prev = ranges.value.map((r) => ({ ...r }))
  const next = [...prev, ...newRanges]
  ranges.value = next
  const ok = await writeRanges(next)
  if (!ok) ranges.value = prev
}

async function removeRange(index: number): Promise<void> {
  const prev = ranges.value.map((r) => ({ ...r }))
  const next = prev.filter((_, i) => i !== index)
  ranges.value = next
  const ok = await writeRanges(next)
  if (!ok) ranges.value = prev
}

function scopeLabel(r: EffectRange): string {
  if (r.scope === 'scene') {
    const nm = lookups.value.sceneNameById.get(r.sceneId ?? '') ?? r.sceneId ?? '?'
    return `场景：${nm}`
  }
  return `第 ${r.orderStart}~${r.orderEnd} 句`
}

// ---------------------------------------------------------------- AI 推荐
async function aiSuggest(): Promise<void> {
  if (!modelReady.value || busy.value) return
  const a = props.action
  const prev = sentenceEffects.value.map((m) => ({ ...m }))
  busy.value = true
  try {
    const r = await window.dreamweave.suggestEffects({
      text: a.text,
      speaker: speakerName(lookups.value, a) || undefined,
      scene: lookups.value.sceneNameById.get(a.locationId) ?? a.locationId,
      type: a.type
    })
    if (!r.ok) {
      emit('notify', r.error ?? 'AI 推荐失败', 'err')
      return
    }
    const items = r.items ?? []
    const dropped = r.dropped ?? []
    if (!items.length) {
      emit(
        'notify',
        dropped.length ? `模型未给出可用特效（已忽略 ${dropped.length} 个未知项）` : '模型未推荐任何特效',
        'info'
      )
      return
    }
    // manual 优先保留 ∪ AI（去重）
    const mergedMap = new Map<string, EffectMount>()
    for (const m of prev) mergedMap.set(m.effectId, m)
    for (const it of items) {
      if (!mergedMap.has(it.effectId)) mergedMap.set(it.effectId, { effectId: it.effectId, source: 'ai' })
    }
    const merged = [...mergedMap.values()]
    const ok = await writeSentence(merged)
    if (!ok) return
    sentenceEffects.value = merged
    aiUndo.value = { prev, count: merged.length - prev.length, dropped }
  } catch (e) {
    emit('notify', (e as Error).message, 'err')
  } finally {
    busy.value = false
  }
}

async function undoAi(): Promise<void> {
  const u = aiUndo.value
  if (!u) return
  const prev = u.prev.map((m) => ({ ...m }))
  const ok = await writeSentence(prev)
  if (!ok) return
  sentenceEffects.value = prev
  aiUndo.value = null
}
</script>

<template>
  <div class="fx-block" data-testid="se-fx-block">
    <div class="fx-head">
      <span class="fx-title">🎬 特效</span>
      <span class="fx-count" data-testid="se-fx-count">{{ sentenceEffects.length }}</span>
      <span class="spacer" />
      <button class="btn tiny" data-testid="se-fx-add" :disabled="busy" @click="openPicker('single')">
        ＋ 添加特效
      </button>
      <button class="btn tiny" data-testid="se-fx-add-range" :disabled="busy" @click="openPicker('range')">
        ＋ 挂到范围
      </button>
      <button
        class="btn tiny"
        data-testid="se-fx-ai"
        :disabled="busy || !modelReady"
        :title="modelReady ? '按本句语义自动推荐特效' : '未配置模型接入（设置 → Base URL / API Key / Model）'"
        @click="aiSuggest"
      >
        ✨ AI 推荐
      </button>
      <button class="btn tiny" data-testid="se-fx-clear" :disabled="busy || !sentenceEffects.length" @click="clearAll">
        清空
      </button>
    </div>

    <div v-if="catalogError" class="fx-catalog-err">{{ catalogError }}</div>

    <div v-if="aiUndo" class="fx-undo">
      ✨ AI 已挂载 {{ aiUndo.count }} 项
      <template v-if="aiUndo.dropped.length">（已忽略 {{ aiUndo.dropped.length }} 个未知项）</template>
      <span class="spacer" />
      <button class="btn tiny" data-testid="se-fx-undo" :disabled="busy" @click="undoAi">撤销</button>
    </div>

    <div class="fx-chips">
      <span v-for="m in sentenceEffects" :key="m.effectId" class="fx-chip" data-testid="se-fx-chip">
        <span class="fx-chip-name">{{ nameOf(m.effectId) }}</span>
        <em class="fx-source" data-testid="se-fx-source" :data-source="m.source">
          {{ m.source === 'ai' ? 'AI' : '手动' }}
        </em>
        <button
          class="fx-chip-x"
          data-testid="se-fx-chip-remove"
          :disabled="busy"
          title="移除该特效"
          @click="removeOne(m.effectId)"
        >
          ×
        </button>
      </span>
      <span v-if="!sentenceEffects.length" class="hint">（本句暂无特效）</span>
    </div>

    <div class="fx-range-builder">
      <span class="hint">范围：</span>
      <button class="chip-btn" :class="{ active: rangeScope === 'scene' }" :disabled="!hasScene" @click="rangeScope = 'scene'">
        场景（{{ sceneLabel }}）
      </button>
      <button class="chip-btn" :class="{ active: rangeScope === 'orders' }" @click="rangeScope = 'orders'">句区间</button>
      <template v-if="rangeScope === 'orders'">
        <input v-model.number="rangeStart" class="fx-num" type="number" min="0" data-testid="se-fx-range-start" />
        <span class="hint">~</span>
        <input v-model.number="rangeEnd" class="fx-num" type="number" min="0" data-testid="se-fx-range-end" />
      </template>
    </div>

    <div v-if="ranges.length" class="fx-ranges">
      <div v-for="(r, i) in ranges" :key="r.scope + i" class="fx-range-item" data-testid="se-fx-range-item">
        <span class="fx-range-label">{{ scopeLabel(r) }}</span>
        <span class="fx-range-name">{{ nameOf(r.effectId) }}</span>
        <span class="fx-source" data-testid="se-fx-source" :data-source="r.source">
          {{ r.source === 'ai' ? 'AI' : '手动' }}
        </span>
        <button class="fx-chip-x" :disabled="busy" title="移除该范围" @click="removeRange(i)">×</button>
      </div>
    </div>

    <EffectPicker
      v-if="pickerOpen"
      :entries="entries"
      :mode="pickerMode"
      :title="pickerMode === 'range' ? '挂到范围 · 选择特效' : '添加特效'"
      @confirm="onPickerConfirm"
      @cancel="pickerOpen = false"
    />
  </div>
</template>

<style scoped>
.fx-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  padding: 10px 12px;
}

.fx-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.fx-head .spacer {
  flex: 1;
}

.fx-title {
  font-size: 13px;
  font-weight: 600;
}

.fx-count {
  font-size: 11px;
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 7px;
}

.fx-catalog-err {
  font-size: 12px;
  color: var(--bad);
}

.fx-undo {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #b26b2a;
  background: var(--accent-soft);
  border: 1px solid var(--accent);
  border-radius: 8px;
  padding: 5px 10px;
}

.fx-undo .spacer {
  flex: 1;
}

.fx-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.fx-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  border-radius: 999px;
  padding: 2px 4px 2px 10px;
  font-size: 12px;
}

.fx-chip-name {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fx-source {
  font-style: normal;
  font-size: 9.5px;
  border-radius: 999px;
  padding: 0 6px;
  border: 1px solid var(--border);
  color: var(--muted);
}

.fx-source[data-source='ai'] {
  border-color: rgba(156, 111, 174, 0.6);
  color: #9c6fae;
}

.fx-chip-x {
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 14px;
  line-height: 1;
  padding: 0 6px;
  border-radius: 999px;
}

.fx-chip-x:hover {
  color: var(--bad);
}

.fx-range-builder {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.chip-btn {
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--muted);
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 11.5px;
}

.chip-btn.active {
  border-color: var(--accent);
  color: var(--text);
  background: var(--accent-soft);
}

.fx-num {
  width: 64px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text);
  border-radius: 6px;
  padding: 2px 6px;
  font-size: 12px;
}

.fx-ranges {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.fx-range-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px 8px;
  background: var(--panel-2);
}

.fx-range-label {
  color: var(--muted);
}

.fx-range-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

<script setup lang="ts">
/**
 * P3 脚本修订：浏览 / 搜索剧本台词，编辑后写回原 .t2w 包。
 *
 * 写回由主进程完成（script:save）：自动先备份 `原名.backup-时间戳.t2w`，
 * 重写整包后做成员级 sha256 复检，并刷新会话。本组件只负责选句与编辑。
 */
import { computed, ref, watch } from 'vue'
import type { StageAction, ViewData } from '../../../shared/app-types'
import SearchSelect, { type SearchOption } from './SearchSelect.vue'
import EffectBlock from './EffectBlock.vue'
import { buildLookups, speakerName } from '../lib/viewModel'

const props = defineProps<{ view: ViewData }>()
const emit = defineEmits<{ saved: [] }>()

const lookups = computed(() => buildLookups(props.view))

// ---- 筛选：章节 / 角色 / 场景 / 全文 ----
const chapterIdx = ref(0)
const speakerId = ref<string>('')
const sceneId = ref<string>('')
const query = ref('')

const chapterOptions = computed<SearchOption[]>(() =>
  props.view.chapters.map((c, i) => ({
    value: i,
    label: `${c.chapterSeq} · ${c.title}`,
    hint: `${c.count} 句`
  }))
)

const speakerOptions = computed<SearchOption[]>(() => [
  { value: '', label: '全部角色' },
  ...props.view.characters.map((c) => ({ value: c.id, label: c.name, hint: c.importanceLevel || undefined }))
])

const sceneOptions = computed<SearchOption[]>(() => [
  { value: '', label: '全部场景' },
  ...props.view.scenes.map((s) => ({ value: s.id, label: s.name || s.id }))
])

/** 当前筛选条件下的句子列表（全局下标 + action） */
const rows = computed(() => {
  const ch = props.view.chapters[chapterIdx.value]
  const q = query.value.trim()
  const out: { global: number; a: StageAction }[] = []
  props.view.actions.forEach((a, i) => {
    if (ch && a.chapterSeq !== ch.chapterSeq) return
    if (speakerId.value && a.characterId !== speakerId.value) return
    if (sceneId.value && a.locationId !== sceneId.value) return
    if (q && !a.text.includes(q)) return
    out.push({ global: i, a })
  })
  return out
})

// 全文搜索时跨章，自动收起章节限制的提示
const searching = computed(() => query.value.trim().length > 0)

// ---- 选中句与草稿 ----
const selectedGlobal = ref(-1)
const draft = ref('')
const saving = ref(false)
const message = ref('')
const messageKind = ref<'ok' | 'err' | 'info'>('info')

const selected = computed(() => {
  const i = selectedGlobal.value
  return i >= 0 && i < props.view.actions.length ? props.view.actions[i] : null
})

function selectRow(global: number): void {
  selectedGlobal.value = global
  draft.value = props.view.actions[global]?.text ?? ''
  message.value = ''
}

// 筛选条件变化后选中句可能被滤掉：若仍可见则保留，否则清空草稿区提示
watch(rows, (list) => {
  if (selectedGlobal.value >= 0 && !list.some((r) => r.global === selectedGlobal.value)) {
    selectedGlobal.value = -1
    draft.value = ''
  }
})

const dirty = computed(() => !!selected.value && draft.value !== selected.value.text)

// ---- P4 特效：列表角标 / 范围轻提示 / 写回反馈复用 se-message ----
/** 某句已挂特效数（0 = 不显示角标） */
function fxCount(a: StageAction): number {
  return a.effects?.length ?? 0
}

/** 某句是否落在任一范围特效内（轻提示，不加角标） */
function inRange(a: StageAction): boolean {
  for (const r of props.view.effectRanges ?? []) {
    if (a.chapterSeq !== r.chapterSeq) continue
    if (r.scope === 'scene') {
      if (r.sceneId && a.locationId === r.sceneId) return true
    } else {
      const s = Number(r.orderStart)
      const e = Number(r.orderEnd)
      if (Number.isFinite(s) && Number.isFinite(e) && a.order >= Math.min(s, e) && a.order <= Math.max(s, e)) {
        return true
      }
    }
  }
  return false
}

/** 特效写回反馈走既有 se-message（文案与文本写回区分） */
function onFxNotify(msg: string, kind: 'ok' | 'err' | 'info'): void {
  messageKind.value = kind
  message.value = msg
}

function typeLabel(t: string): string {
  switch (t) {
    case 'say':
      return '对白'
    case 'think':
      return '心声'
    case 'narration':
      return '旁白'
    case 'move':
      return '移动'
    case 'battle':
      return '战斗'
    default:
      return t
  }
}

async function save(): Promise<void> {
  const a = selected.value
  if (!a) return
  if (!dirty.value) {
    messageKind.value = 'info'
    message.value = '文本没有改动'
    return
  }
  saving.value = true
  message.value = ''
  try {
    const res = await window.dreamweave.saveScriptAction(
      {
        chapterSeq: a.chapterSeq,
        order: a.order,
        type: a.type,
        originalText: a.text
      },
      draft.value
    )
    if (!res.ok) {
      messageKind.value = 'err'
      message.value = res.error ?? '写回失败'
      return
    }
    const v = res.verify
    messageKind.value = 'ok'
    message.value =
      `已写回 · 备份 ${res.backupPath ?? '(未生成)'} · 复检 ${v ? `${v.passed}/${v.total}` : '—'} 通过` +
      (v && v.failed > 0 ? ` · ⚠️ ${v.failed} 个成员校验失败` : '')
    emit('saved')
  } catch (e) {
    messageKind.value = 'err'
    message.value = (e as Error).message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="script-editor" data-testid="script-editor">
    <div class="se-bar">
      <SearchSelect :options="chapterOptions" :model-value="chapterIdx" @update:model-value="chapterIdx = Number($event)" />
      <SearchSelect :options="speakerOptions" :model-value="speakerId" placeholder="搜索角色…" @update:model-value="speakerId = String($event)" />
      <SearchSelect :options="sceneOptions" :model-value="sceneId" placeholder="搜索场景…" @update:model-value="sceneId = String($event)" />
      <input v-model="query" class="se-search" placeholder="全文搜索台词…" spellcheck="false" data-testid="se-search" />
      <span class="se-count" data-testid="se-count">{{ rows.length }} 句{{ searching ? '（跨章）' : '' }}</span>
    </div>

    <div class="se-body">
      <div class="se-list" data-testid="se-list">
        <div
          v-for="r in rows"
          :key="r.global"
          class="se-item"
          :class="{ active: r.global === selectedGlobal }"
          :data-testid="'se-item-' + r.global"
          @click="selectRow(r.global)"
        >
          <span class="se-idx">#{{ r.global + 1 }}</span>
          <span class="se-type" :class="'t-' + r.a.type">{{ typeLabel(r.a.type) }}</span>
          <span class="se-speaker">{{ speakerName(lookups, r.a) || '—' }}</span>
          <span
            v-if="fxCount(r.a)"
            class="se-fx-badge"
            :data-testid="'se-item-fx-' + r.global"
            :title="`已挂 ${fxCount(r.a)} 个特效`"
          >
            🎬 {{ fxCount(r.a) }}
          </span>
          <span v-else-if="inRange(r.a)" class="se-range-badge" title="该句在某范围特效内">◧</span>
          <span class="se-preview">{{ r.a.text.slice(0, 40) || '(空)' }}</span>
        </div>
        <div v-if="!rows.length" class="se-empty">没有匹配的句子</div>
      </div>

      <div class="se-editor">
        <template v-if="selected">
          <div class="se-meta">
            <span class="se-type" :class="'t-' + selected.type">{{ typeLabel(selected.type) }}</span>
            <strong>{{ speakerName(lookups, selected) || '旁白' }}</strong>
            <span class="hint">第 {{ selected.chapterSeq }} 章 · 第 {{ selected.order }} 句 · #{{ selectedGlobal + 1 }}</span>
          </div>
          <textarea
            v-model="draft"
            class="se-textarea"
            rows="10"
            spellcheck="false"
            data-testid="se-textarea"
          ></textarea>
          <!-- P4 特效区块：textarea 之下、写回按钮之上 -->
          <EffectBlock
            v-if="selected"
            :key="selectedGlobal"
            :view="view"
            :action="selected"
            @saved="emit('saved')"
            @notify="onFxNotify"
          />
          <div class="se-actions">
            <button class="btn primary" :disabled="saving || !dirty" data-testid="se-save" @click="save">
              {{ saving ? '写回中…' : '写回原包' }}
            </button>
            <button class="btn" :disabled="saving || !dirty" @click="draft = selected.text">还原</button>
            <span v-if="dirty" class="se-dirty-hint">有未保存修改</span>
          </div>
          <div v-if="message" class="se-message" :class="messageKind" data-testid="se-message">{{ message }}</div>
          <div class="se-note">
            写回前会自动备份为 <code>原名.backup-时间戳</code>（与原文件同目录、原扩展名）；只改这一句的文本，不动其他任何数据。
          </div>
        </template>
        <div v-else class="se-placeholder">← 从左侧选一句话开始编辑</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.script-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.se-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  flex: none;
}

.se-search {
  flex: 1;
  min-width: 180px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text);
  border-radius: 8px;
  padding: 7px 12px;
  font-size: 13px;
  outline: none;
}

.se-search:focus {
  border-color: var(--accent);
}

.se-count {
  font-size: 12px;
  color: var(--muted);
  flex: none;
}

.se-body {
  display: grid;
  grid-template-columns: minmax(0, 5fr) minmax(0, 6fr);
  gap: 12px;
  min-height: 420px;
}

.se-list {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  overflow: auto;
  max-height: 62vh;
}

.se-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 7px 12px;
  font-size: 12.5px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
}

.se-item:hover {
  background: var(--panel-2);
}

.se-item.active {
  background: var(--accent-soft);
}

.se-idx {
  color: var(--muted);
  font-size: 11px;
  flex: none;
  min-width: 34px;
  text-align: right;
}

.se-type {
  flex: none;
  font-size: 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 7px;
  color: var(--muted);
}

.se-type.t-say {
  border-color: rgba(217, 151, 76, 0.55);
  color: #b26b2a;
}

.se-type.t-think {
  border-color: rgba(156, 111, 174, 0.55);
  color: #9c6fae;
}

.se-type.t-narration {
  border-color: var(--border-strong);
  color: var(--muted);
}

.se-speaker {
  flex: none;
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}

.se-preview {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
}

/* P4：列表项特效角标 / 范围轻提示（极小，不干扰既有排版） */
.se-fx-badge {
  flex: none;
  font-size: 10px;
  line-height: 1.6;
  border: 1px solid rgba(217, 151, 76, 0.55);
  color: #b26b2a;
  border-radius: 999px;
  padding: 0 6px;
}

.se-range-badge {
  flex: none;
  font-size: 10px;
  color: #9c6fae;
}

.se-empty {
  padding: 20px;
  text-align: center;
  color: var(--muted);
  font-size: 12px;
}

.se-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.se-meta {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 13px;
  flex: none;
}

.se-textarea {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  color: var(--text);
  padding: 12px 14px;
  font-size: 14px;
  line-height: 1.8;
  resize: vertical;
  outline: none;
  font-family: inherit;
}

.se-textarea:focus {
  border-color: var(--accent);
}

.se-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

.se-dirty-hint {
  font-size: 12px;
  color: var(--warn);
}

.se-message {
  font-size: 12.5px;
  border-radius: 8px;
  padding: 8px 12px;
  word-break: break-all;
}

.se-message.ok {
  background: rgba(78, 154, 95, 0.12);
  border: 1px solid rgba(78, 154, 95, 0.4);
  color: #2f6b40;
}

.se-message.err {
  background: rgba(194, 85, 75, 0.1);
  border: 1px solid rgba(194, 85, 75, 0.4);
  color: var(--bad);
}

.se-message.info {
  background: var(--panel-2);
  border: 1px solid var(--border);
  color: var(--muted);
}

.se-note {
  font-size: 11.5px;
  color: var(--muted);
  line-height: 1.7;
}

.se-note code {
  background: var(--panel-2);
  border-radius: 4px;
  padding: 1px 5px;
}

.se-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 300px;
  border: 1px dashed var(--border);
  border-radius: 10px;
  color: var(--muted);
  font-size: 13px;
}
</style>

<script setup lang="ts">
/**
 * 可搜索下拉（跳章用）：章节多时（实测有 24 章的包）原生 select 不好找。
 * 纯本地过滤，无网络；键盘 ↑/↓/Enter/Esc 全支持。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

export interface SearchOption {
  /** 数字（章节序号）或字符串（角色 id / 场景 id）均可 */
  value: number | string
  label: string
  hint?: string
}

const props = withDefaults(
  defineProps<{ options: SearchOption[]; modelValue: number | string; placeholder?: string }>(),
  {
    placeholder: '搜索…'
  }
)
const emit = defineEmits<{ 'update:modelValue': [number | string] }>()

const open = ref(false)
const query = ref('')
const active = ref(0)
const root = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return props.options
  return props.options.filter((o) => o.label.toLowerCase().includes(q) || String(o.value).includes(q))
})

const currentLabel = computed(() => props.options.find((o) => o.value === props.modelValue)?.label ?? '—')

watch(open, async (v) => {
  if (v) {
    query.value = ''
    active.value = Math.max(
      0,
      props.options.findIndex((o) => o.value === props.modelValue)
    )
    await nextTick()
    input.value?.focus()
    document.addEventListener('mousedown', onOutside, true)
  } else {
    document.removeEventListener('mousedown', onOutside, true)
  }
})

function onOutside(e: MouseEvent): void {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false
}

function pick(i: number): void {
  const o = filtered.value[i]
  if (!o) return
  emit('update:modelValue', o.value)
  open.value = false
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    active.value = Math.min(filtered.value.length - 1, active.value + 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    active.value = Math.max(0, active.value - 1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    pick(active.value)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    open.value = false
  }
}

onBeforeUnmount(() => document.removeEventListener('mousedown', onOutside, true))
</script>

<template>
  <div class="search-select" ref="root" data-testid="search-select">
    <button class="btn ss-trigger" :class="{ active: open }" data-testid="search-select-trigger" @click="open = !open">
      <span class="ss-label">{{ currentLabel }}</span>
      <span class="ss-caret">{{ open ? '▴' : '▾' }}</span>
    </button>
    <div v-if="open" class="ss-panel" data-testid="search-select-panel">
      <input
        ref="input"
        v-model="query"
        class="ss-input"
        data-testid="search-select-input"
        :placeholder="placeholder"
        spellcheck="false"
        @keydown="onKeydown"
      />
      <div class="ss-list">
        <div
          v-for="(o, i) in filtered"
          :key="o.value"
          class="ss-item"
          :class="{ active: i === active, selected: o.value === modelValue }"
          :data-testid="'search-select-item-' + o.value"
          @click="pick(i)"
          @mouseenter="active = i"
        >
          <span class="ss-item-label">{{ o.label }}</span>
          <span v-if="o.hint" class="ss-item-hint">{{ o.hint }}</span>
        </div>
        <div v-if="!filtered.length" class="ss-empty">无匹配项</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.search-select {
  position: relative;
  flex: none;
}

.ss-trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 240px;
}

.ss-trigger.active {
  border-color: var(--accent);
}

.ss-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ss-caret {
  color: var(--muted);
  font-size: 10px;
}

.ss-panel {
  position: absolute;
  z-index: 40;
  top: calc(100% + 6px);
  right: 0;
  width: 300px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(90, 70, 45, 0.35);
  overflow: hidden;
}

.ss-input {
  width: 100%;
  border: 0;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text);
  padding: 9px 12px;
  font-size: 13px;
  outline: none;
}

.ss-list {
  max-height: 260px;
  overflow: auto;
}

.ss-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 12px;
  font-size: 13px;
  cursor: pointer;
}

.ss-item.active {
  background: var(--accent-soft);
}

.ss-item.selected {
  color: #3a2e22;
  font-weight: 600;
}

.ss-item-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ss-item-hint {
  color: var(--muted);
  font-size: 11px;
}

.ss-empty {
  padding: 12px;
  color: var(--muted);
  font-size: 12px;
  text-align: center;
}
</style>

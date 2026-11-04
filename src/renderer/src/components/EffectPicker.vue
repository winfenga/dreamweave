<script setup lang="ts">
/**
 * 特效选择器浮层：7 大类分组 + 名称/id/描述搜索 + 多选。
 * 单句挂载（mode='single'）与范围挂载（mode='range'）复用同一组件，仅标题不同。
 */
import { computed, ref } from 'vue'
import type { EffectCatalogEntry } from '../../../shared/effects-types'
import { groupByCategory, searchEntries } from '../lib/effectCatalog'

const props = withDefaults(
  defineProps<{ entries: EffectCatalogEntry[]; mode?: 'single' | 'range'; title?: string }>(),
  { mode: 'single', title: '添加特效' }
)
const emit = defineEmits<{ confirm: [ids: string[]]; cancel: [] }>()

const query = ref('')
const selected = ref<Set<string>>(new Set())

const groups = computed(() => groupByCategory(searchEntries(props.entries, query.value)))

function toggle(id: string): void {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}

function confirm(): void {
  if (!selected.value.size) return
  emit('confirm', [...selected.value])
}
</script>

<template>
  <div class="fx-picker" data-testid="fx-picker" @click.self="emit('cancel')">
    <div class="fx-picker-panel">
      <header class="fx-picker-head">
        <strong>{{ title }}</strong>
        <span class="hint">{{ mode === 'range' ? '范围 · 可多选' : '单句 · 可多选' }}</span>
        <span class="spacer" />
        <input
          v-model="query"
          class="fx-picker-search"
          data-testid="fx-picker-search"
          placeholder="搜索名称 / id…"
          spellcheck="false"
        />
      </header>
      <div class="fx-picker-body">
        <section v-for="(g, gi) in groups" :key="g.category" class="fx-picker-group">
          <h5>{{ g.category }}</h5>
          <div class="fx-picker-items" :data-testid="'fx-picker-cat-' + gi">
            <button
              v-for="e in g.entries"
              :key="e.id"
              class="fx-picker-item"
              :class="{ active: selected.has(e.id) }"
              :data-testid="'fx-picker-item-' + e.id"
              :title="e.description"
              @click="toggle(e.id)"
            >
              <span class="fx-picker-name">{{ e.name }}</span>
              <span class="fx-picker-id">{{ e.id }}</span>
            </button>
          </div>
        </section>
        <div v-if="!groups.length" class="fx-picker-empty">无匹配项</div>
      </div>
      <footer class="fx-picker-foot">
        <span class="hint">已选 {{ selected.size }} 项</span>
        <span class="spacer" />
        <button class="btn" data-testid="fx-picker-cancel" @click="emit('cancel')">取消</button>
        <button class="btn primary" data-testid="fx-picker-confirm" :disabled="!selected.size" @click="confirm">
          确定
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.fx-picker {
  position: fixed;
  inset: 0;
  z-index: 70;
  background: rgba(43, 33, 22, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.fx-picker-panel {
  width: min(720px, 94vw);
  max-height: 84vh;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
}

.fx-picker-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}

.fx-picker-head .spacer {
  flex: 1;
}

.fx-picker-search {
  flex: 0 1 240px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text);
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12.5px;
  outline: none;
}

.fx-picker-search:focus {
  border-color: var(--accent);
}

.fx-picker-body {
  overflow: auto;
  padding: 10px 16px 16px;
  min-height: 0;
}

.fx-picker-group h5 {
  margin: 12px 0 6px;
  font-size: 11px;
  letter-spacing: 1px;
  color: var(--muted);
  font-weight: 600;
}

.fx-picker-items {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.fx-picker-item {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text);
  border-radius: 8px;
  padding: 5px 10px;
  font-size: 12.5px;
  max-width: 200px;
}

.fx-picker-item.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.fx-picker-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 180px;
}

.fx-picker-id {
  font-size: 10px;
  color: var(--muted);
}

.fx-picker-empty {
  padding: 20px;
  text-align: center;
  color: var(--muted);
  font-size: 12px;
}

.fx-picker-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
}

.fx-picker-foot .spacer {
  flex: 1;
}
</style>

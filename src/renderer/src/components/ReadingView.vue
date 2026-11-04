<script setup lang="ts">
/**
 * 阅读原文（应用内标签页）。
 *
 * - **懒加载**：仅在真正切到本页（onMounted）时调 `source:read`，不在应用启动时读整本原文；
 * - 布局：左侧章节导航 + 右侧连续正文滚动容器（white-space: pre-wrap，限宽便于阅读）；
 * - 每段渲染为 `<section :id="'rd-' + byteStart">`；点导航 → scrollIntoView + 高亮；
 * - `target` 由「章节」tab 传进来（byteStart），加载完成后自动滚到该章。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { ChapterInfo, ReadingSegment } from '../../../shared/app-types'

const props = defineProps<{ target?: number | null }>()

const loading = ref(false)
const error = ref('')
const segments = ref<ReadingSegment[]>([])
const chapters = ref<ChapterInfo[]>([])
const skipped = ref<string[]>([])
const loaded = ref(false)
const activeByte = ref<number | null>(null)

/** 章节导航按阅读顺序（byteStart 升序）显示（seq 乱序跳号，不能作阅读顺序依据） */
const navItems = computed(() => chapters.value.slice().sort((a, b) => a.byteStart - b.byteStart))

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const res = await window.dreamweave.readSource()
    if (!res.ok || !res.segments) {
      error.value = res.error ?? '读取原文失败'
      return
    }
    segments.value = res.segments
    chapters.value = res.chapters ?? []
    skipped.value = res.skippedChapters ?? []
    loaded.value = true
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
  // 注意：必须等 loading=false 让正文渲染出来（v-else 分支）后再定位，
  // 否则此时 section 尚未挂载，getElementById 找不到目标。
  if (loaded.value && props.target != null) {
    await nextTick()
    scrollToByte(props.target)
  }
}

onMounted(() => void load())

watch(
  () => props.target,
  async (t) => {
    if (t == null || !loaded.value) return
    await nextTick()
    scrollToByte(t)
  }
)

/** 命中包含该字节的段（段区间为 [byteStart, byteEnd)），用于定位 section。 */
function segmentForByte(byte: number): ReadingSegment | null {
  for (const s of segments.value) {
    if (byte >= s.byteStart && byte < s.byteEnd) return s
  }
  return null
}

function scrollToByte(byte: number): void {
  const seg = segmentForByte(byte)
  const key = seg ? seg.byteStart : byte
  const el = document.getElementById('rd-' + key)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  activeByte.value = key
}
</script>

<template>
  <div class="rd-wrap">
    <div v-if="loading" class="hint rd-status">正在读取原文…</div>
    <div v-else-if="error" class="error rd-status">{{ error }}</div>
    <template v-else>
      <aside class="rd-nav">
        <div class="rd-nav-head">章节（{{ navItems.length }}）</div>
        <div v-if="skipped.length" class="hint rd-skip">
          已跳过 {{ skipped.length }} 章（区间为空）
        </div>
        <button
          v-for="c in navItems"
          :key="c.byteStart"
          class="rd-nav-item"
          :class="{ active: activeByte === c.byteStart }"
          @click="scrollToByte(c.byteStart)"
        >
          <span class="rd-nav-seq">{{ c.seq }}</span>
          <span class="rd-nav-title" :title="c.title">{{ c.title || '(无标题)' }}</span>
        </button>
      </aside>

      <div class="rd-body">
        <section
          v-for="seg in segments"
          :id="'rd-' + seg.byteStart"
          :key="seg.byteStart"
          class="rd-sec"
          :class="{ active: activeByte === seg.byteStart }"
        >
          <h3 class="rd-sec-title">
            <span v-if="seg.seq != null" class="rd-sec-seq">#{{ seg.seq }}</span>
            {{ seg.title }}
          </h3>
          <div class="rd-text">{{ seg.text }}</div>
        </section>
      </div>
    </template>
  </div>
</template>

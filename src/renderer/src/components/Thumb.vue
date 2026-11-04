<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps<{
  filePath: string
  entryPath: string
  label: string
}>()

const emit = defineEmits<{ open: [payload: { label: string; url: string }] }>()

const root = ref<HTMLElement | null>(null)
const url = ref<string>('')
const failed = ref(false)
const loading = ref(false)
let started = false
let observer: IntersectionObserver | null = null

async function load(): Promise<void> {
  if (started) return
  started = true
  loading.value = true
  try {
    const res = await window.dreamweave.previewEntry(props.filePath, props.entryPath)
    if (res.ok && res.dataUrl) url.value = res.dataUrl
    else failed.value = true
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      void load()
      observer?.disconnect()
    }
  })
  if (root.value) observer.observe(root.value)
})

onBeforeUnmount(() => observer?.disconnect())

/** 窗口被遮挡时 IntersectionObserver 会被节流，故额外支持悬停/点击触发 */
async function open(): Promise<void> {
  await load()
  if (url.value) emit('open', { label: props.label, url: url.value })
}
</script>

<template>
  <div ref="root" class="thumb" :title="entryPath" @mouseenter="load" @click="open">
    <img v-if="url" :src="url" :alt="label" loading="lazy" />
    <div v-else class="ph">{{ failed ? '读取失败' : loading ? '加载中…' : '滚动加载' }}</div>
    <div class="name">{{ label }}</div>
  </div>
</template>

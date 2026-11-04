<script setup lang="ts">
/**
 * 特效层容器：舞台上唯一新增的 DOM 节点。
 * - `inset:0; pointer-events:none`，**无 z-index**（靠 DOM 顺序居于立绘与对话框之下，见 styles.css）。
 * - 暴露 `rootEl` 供 `StageEffectRuntime` 建自有节点（overlay/text/flash）。
 * - 本身不含任何特效逻辑，纯容器。
 */
import { ref } from 'vue'

const rootEl = ref<HTMLElement | null>(null)

defineExpose({ rootEl })
</script>

<template>
  <div ref="rootEl" class="effect-layer" data-testid="effect-layer"></div>
</template>

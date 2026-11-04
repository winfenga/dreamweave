<script setup lang="ts">
import type { LayoutNode } from '../lib/impressionModel'
import { locationColor } from '../lib/locationStyle'

defineOptions({ name: 'ImpressionBox' })

defineProps<{ node: LayoutNode; selectedId: string | null }>()
const emit = defineEmits<{ pick: [node: LayoutNode] }>()
</script>

<template>
  <div
    class="imp-box"
    :class="{ selected: node.id === selectedId, 'has-children': node.children.length > 0 }"
    :data-imp-id="node.id"
    :style="{
      left: node.rect.x + '%',
      top: node.rect.y + '%',
      width: node.rect.width + '%',
      height: node.rect.height + '%',
      borderColor: locationColor(node.locationType)
    }"
    @click.stop="emit('pick', node)"
  >
    <div v-if="node.children.length" class="imp-label" :title="node.name + ' · ' + node.locationType">
      {{ node.name }}
      <span v-if="node.sceneIds.length" class="badge-scene">🎬 {{ node.sceneIds.length }}</span>
    </div>
    <div v-else class="imp-leaf">{{ node.name }}</div>

    <ImpressionBox
      v-for="c in node.children"
      :key="c.id"
      :node="c"
      :selected-id="selectedId"
      @pick="emit('pick', $event)"
    />
  </div>
</template>

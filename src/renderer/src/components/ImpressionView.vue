<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ViewData } from '../../../shared/app-types'
import { buildLookups } from '../lib/viewModel'
import { buildImpressionTree, type LayoutNode } from '../lib/impressionModel'
import { locationColor } from '../lib/locationStyle'
import ImpressionBox from './ImpressionBox.vue'

const props = defineProps<{ view: ViewData }>()

const lookups = computed(() => buildLookups(props.view))
const root = computed(() =>
  props.view.impression
    ? buildImpressionTree(props.view.impression, props.view.mapNodes, props.view.scenesByNode, props.view.mapRoot)
    : null
)

const selectedId = ref<string | null>(null)
const selected = ref<LayoutNode | null>(null)

function pick(node: LayoutNode): void {
  selectedId.value = node.id
  selected.value = node
}

const selectedScenes = computed(() => {
  const s = selected.value
  if (!s) return []
  return s.sceneIds.map((id) => lookups.value.sceneById.get(id)).filter((x) => !!x)
})
const selectedActionCount = computed(() => selectedScenes.value.reduce((n, s) => n + (s?.actionCount ?? 0), 0))

/** 统计：矩形（不含代表画布的根）总数与最大嵌套层数 */
const boxCount = computed(() => {
  let n = 0
  let depth = 0
  // 根只占满画布，本身不算一个「矩形」
  const walk = (node: LayoutNode | null, d: number): void => {
    if (!node) return
    n++
    depth = Math.max(depth, d)
    node.children.forEach((c) => walk(c, d + 1))
  }
  root.value?.children.forEach((c) => walk(c, 1))
  return { boxes: n, depth }
})

const layoutGroups = computed(() => props.view.impression?.layouts ?? [])
</script>

<template>
  <div class="imp-wrap">
    <div class="imp-canvas">
      <template v-if="root">
        <div class="imp-root">
          <div class="imp-root-label">{{ root.name }}（{{ root.locationType }}）</div>
          <ImpressionBox
            v-for="c in root.children"
            :key="c.id"
            :node="c"
            :selected-id="selectedId"
            @pick="pick"
          />
        </div>
        <div class="imp-legend">
          gridSize={{ view.impression?.gridSize }} · {{ boxCount.boxes }} 个矩形 · {{ layoutGroups.length }} 层 · 最大嵌套
          {{ boxCount.depth }} 级
        </div>
      </template>
      <div v-else class="detail-empty">
        <div class="big">🧭</div>
        <p>该包没有印象图谱数据</p>
        <p class="hint">（records.results 中没有 :impressionLayout 主记录）</p>
      </div>
    </div>

    <aside class="map-detail">
      <template v-if="selected">
        <div class="detail-head">
          <span class="pill" :style="{ background: locationColor(selected.locationType) }">
            {{ selected.locationType }}
          </span>
          <h3>{{ selected.name }}</h3>
          <div class="hint">
            {{ selected.id }} · 矩形 x{{ selected.rect.x }} y{{ selected.rect.y }} {{ selected.rect.width }}×{{
              selected.rect.height
            }}（父容器百分比）
          </div>
        </div>

        <div class="stat-row">
          <div class="stat"><div class="k">子地点</div><div class="v">{{ selected.children.length }}</div></div>
          <div class="stat"><div class="k">关联场景</div><div class="v">{{ selectedScenes.length }}</div></div>
          <div class="stat"><div class="k">剧本条目</div><div class="v">{{ selectedActionCount }}</div></div>
        </div>

        <section v-if="selected.identInfos.length" class="block">
          <h4>识别信息 identInfos</h4>
          <p v-for="(t, i) in selected.identInfos" :key="i">{{ t }}</p>
        </section>

        <section v-for="s in selectedScenes" :key="s!.id" class="block scene-block">
          <h4>🎬 {{ s!.name }} <span class="hint">（{{ s!.id }} · {{ s!.actionCount }} 条）</span></h4>
          <img v-if="s!.imageUrl" :src="s!.imageUrl" :alt="s!.name" class="scene-img" />
          <div v-else class="thumb-missing">该场景无配图</div>
          <p v-if="s!.summary" class="scene-sum">{{ s!.summary }}</p>
        </section>

        <section v-if="!selectedScenes.length" class="block">
          <p class="hint">该地点没有直接挂载场景。</p>
        </section>
      </template>

      <div v-else class="detail-empty">
        <div class="big">🧭</div>
        <p>点击任意矩形查看地点详情</p>
        <p class="hint">
          {{ boxCount.boxes }} 个矩形 · {{ layoutGroups.length }} 层<br />
          矩形按 impressionLayout 的百分比坐标嵌套摆放
        </p>
      </div>
    </aside>
  </div>
</template>

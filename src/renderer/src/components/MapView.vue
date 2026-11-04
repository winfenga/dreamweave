<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch, type CSSProperties } from 'vue'
import type { MapTreeNode, ViewData } from '../../../shared/app-types'
import { buildLookups, type ViewLookups } from '../lib/viewModel'
import { layoutTree, type LaidOutNode } from '../lib/mapLayout'
import { buildLocationLegend, locationColor } from '../lib/locationStyle'
import { isMapEmpty, matchMapNodes, panToCenter } from '../lib/mapViewState'

const props = defineProps<{ view: ViewData }>()

const COL_W = 158
const ROW_H = 104
const NODE_W = 132
const NODE_H = 48
const PAD = 28

const lookups = computed<ViewLookups>(() => buildLookups(props.view))
const layout = computed(() => layoutTree(props.view.mapRoot))

/**
 * 地图数据来源徽章（T7-A）。
 *
 * `runtime` = 本机跑过 locationTree 写出的产物（绿）；`inherited` = 来源包自带的历史产物
 * （灰，本机尚未运行）；`unknown` = 根本没有该产物 → 不显示（空态已覆盖）。
 */
const sourceBadge = computed<{ text: string; ok: boolean } | null>(() => {
  const s = props.view.stats?.locationTreeSource
  if (s === 'runtime') return { text: '地图数据：本机运行产物', ok: true }
  if (s === 'inherited') return { text: '地图数据：来源包自带（本机尚未运行 locationTree）', ok: false }
  return null
})

/**
 * 图例：按**树里实际出现**的 locationType 动态生成（原来是硬编码 11 类，与真实数据的
 * 25~151 种类型严重脱节）。排序与去重见 `buildLocationLegend`。
 */
const legend = computed(() => buildLocationLegend(layout.value.nodes.map((n) => n.node)))

/**
 * 是否没有真实地图数据（红线：`ViewData.mapRoot` 不能改成 `MapTreeNode | null`，会牵连
 * StageView；所以判空放在这里）。命中时不画树，只显示一张空态卡片。
 * 判据与理由见 `lib/mapViewState.ts` 的 `isMapEmpty`。
 */
const mapEmpty = computed(() => isMapEmpty(props.view))

/** 空态卡片（只加必要的内联样式，不引入新样式体系） */
const emptyCardStyle: CSSProperties = {
  position: 'absolute',
  inset: '0',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '8px',
  textAlign: 'center',
  padding: '0 24px'
}

const canvasW = computed(() => layout.value.cols * COL_W + PAD * 2)
const canvasH = computed(() => layout.value.depth * ROW_H + PAD * 2)

const pos = computed(() => {
  const m = new Map<string, { x: number; y: number }>()
  for (const n of layout.value.nodes) {
    m.set(n.node.id, { x: Math.round(n.col * COL_W + PAD), y: n.depth * ROW_H + PAD })
  }
  return m
})

function nodeColor(type: string): string {
  return locationColor(type)
}

/** 预先算好连线路径，避免模板里做查表与非空断言 */
const edgePaths = computed(() => {
  const p = pos.value
  const nodeById = new Map(layout.value.nodes.map((n) => [n.node.id, n]))
  const midGap = (ROW_H - NODE_H) / 2
  return layout.value.edges
    .map((e) => {
      const a = p.get(e.from)
      const b = p.get(e.to)
      const to = nodeById.get(e.to)
      if (!a || !b || !to) return null
      const ax = a.x + NODE_W / 2
      const bx = b.x + NODE_W / 2
      return {
        d: `M ${ax} ${a.y + NODE_H} L ${ax} ${a.y + NODE_H + midGap} L ${bx} ${b.y - midGap} L ${bx} ${b.y}`,
        color: nodeColor(to.node.locationType)
      }
    })
    .filter((x): x is { d: string; color: string } => !!x)
})

/** 预先算好每个节点的绝对位置，模板直接取用 */
const placedNodes = computed(() => {
  const p = pos.value
  return layout.value.nodes.map((n) => ({ item: n, at: p.get(n.node.id) ?? { x: 0, y: 0 } }))
})

// ---- 缩放 / 平移 ----
const canvasEl = ref<HTMLElement | null>(null)
const scale = ref(1)
const tx = ref(24)
const ty = ref(16)
const dragging = ref(false)
let dragStart = { x: 0, y: 0, tx: 0, ty: 0 }

function onWheel(e: WheelEvent): void {
  e.preventDefault()
  const next = Math.min(2.6, Math.max(0.4, scale.value * Math.exp(-e.deltaY * 0.0012)))
  scale.value = Number(next.toFixed(3))
}

function onPointerDown(e: PointerEvent): void {
  dragging.value = true
  dragStart = { x: e.clientX, y: e.clientY, tx: tx.value, ty: ty.value }
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}

function onPointerMove(e: PointerEvent): void {
  if (!dragging.value) return
  tx.value = dragStart.tx + (e.clientX - dragStart.x)
  ty.value = dragStart.ty + (e.clientY - dragStart.y)
}

function onPointerUp(e: PointerEvent): void {
  dragging.value = false
  ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
}

function zoom(delta: number): void {
  scale.value = Number(Math.min(2.6, Math.max(0.4, scale.value + delta)).toFixed(3))
}

function resetView(): void {
  scale.value = 1
  tx.value = 24
  ty.value = 16
}

/** 缩放到刚好容纳全图并居中 —— 节点多时不至于挤成一团或跑出视野 */
function fit(): void {
  const el = canvasEl.value
  if (!el) return
  const pad = 26
  const s = Math.min((el.clientWidth - pad * 2) / canvasW.value, (el.clientHeight - pad * 2) / canvasH.value, 1.5)
  const next = Number(Math.max(0.3, s).toFixed(3))
  scale.value = next
  tx.value = Math.max(pad, (el.clientWidth - canvasW.value * next) / 2)
  ty.value = Math.max(pad, (el.clientHeight - canvasH.value * next) / 2)
}

onMounted(async () => {
  await nextTick()
  fit()
})

// ---- 选中 ----
const selectedId = ref<string | null>(null)
const selected = computed<LaidOutNode | null>(
  () => layout.value.nodes.find((n) => n.node.id === selectedId.value) ?? null
)
const selectedScenes = computed(() => {
  const s = selected.value
  if (!s) return []
  return lookups.value.scenesByNodeId.get(s.node.id) ?? []
})
const selectedActionCount = computed(() =>
  selectedScenes.value.reduce((sum, sc) => sum + sc.actionCount, 0)
)

function selectNode(n: LaidOutNode): void {
  selectedId.value = n.node.id
}

// ---- 搜索定位（70+ 节点时滚轮找地点太慢） ----
const searchQuery = ref('')
/** 当前跳到第几个匹配（-1 = 还没按过回车） */
const matchCursor = ref(-1)
const matches = computed(() => matchMapNodes(layout.value.nodes, searchQuery.value))

/** 换查询词 → 退回「未跳转」状态；**不动 selectedId**（清空输入框不取消选中） */
watch(searchQuery, () => {
  matchCursor.value = -1
})

/** 匹配提示：无输入不显示；有输入显示「n 个匹配 / 无匹配 / 第 k/n 个匹配」 */
const matchText = computed<string>(() => {
  if (!searchQuery.value.trim()) return ''
  const n = matches.value.length
  if (!n) return '无匹配'
  if (matchCursor.value < 0) return `${n} 个匹配`
  return `第 ${matchCursor.value + 1}/${n} 个匹配`
})

/** 把节点中心平移到视口中心（换算见 lib/mapViewState.ts 的 panToCenter） */
function focusNode(target: LaidOutNode): void {
  const el = canvasEl.value
  const at = pos.value.get(target.node.id)
  if (!el || !at) return
  const next = panToCenter({
    x: at.x,
    y: at.y,
    scale: scale.value,
    viewW: el.clientWidth,
    viewH: el.clientHeight,
    nodeW: NODE_W,
    nodeH: NODE_H
  })
  tx.value = Math.round(next.tx)
  ty.value = Math.round(next.ty)
}

/** 跳到第 i 个匹配（越界自动回绕，回车可循环逐个跳转） */
function gotoMatch(i: number): void {
  const list = matches.value
  if (!list.length) return
  const idx = ((i % list.length) + list.length) % list.length
  matchCursor.value = idx
  selectedId.value = list[idx].node.id
  focusNode(list[idx])
}

/** 回车 / 「↓」→ 下一个匹配（第一次回车跳第 1 个） */
function onSearchEnter(): void {
  gotoMatch(matchCursor.value + 1)
}

const searchInputStyle: CSSProperties = {
  width: '148px',
  background: 'var(--panel-2)',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  color: 'var(--text)',
  fontSize: '11.5px',
  padding: '3px 7px',
  outline: 'none'
}

const ancestors = computed(() => {
  const s = selected.value
  if (!s) return [] as MapTreeNode[]
  const byId = new Map(layout.value.nodes.map((n) => [n.node.id, n]))
  const out: MapTreeNode[] = []
  let cur: LaidOutNode | undefined = s
  while (cur?.parentId) {
    const p: LaidOutNode | undefined = byId.get(cur.parentId)
    if (!p) break
    out.unshift(p.node)
    cur = p
  }
  return out
})
</script>

<template>
  <div class="map-wrap">
    <div class="map-canvas" ref="canvasEl" @wheel="onWheel" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp">
      <!-- 空态：不画树，也不给缩放/图例（没有数据可操作），避免伪装成「地图已经通了」 -->
      <div v-if="mapEmpty" class="map-empty" data-testid="map-empty" :style="emptyCardStyle">
        <div style="font-size: 40px">🗺️</div>
        <div style="font-size: 15px; font-weight: 600; color: var(--text)">
          尚未运行 locationTree 任务，暂无地图数据
        </div>
        <div class="hint">
          到「概览」页的任务面板运行 locationTree 任务，完成后这里会显示地点树
        </div>
      </div>

      <template v-else>
      <div class="map-toolbar">
        <span v-if="sourceBadge" class="badge" :class="{ ok: sourceBadge.ok }" :title="sourceBadge.text">
          {{ sourceBadge.text }}
        </span>
        <input
          v-model="searchQuery"
          class="map-search"
          data-testid="map-search-input"
          type="search"
          placeholder="搜索地点名称"
          :style="searchInputStyle"
          @keydown.enter.prevent="onSearchEnter"
        />
        <span v-if="matchText" class="hint" style="min-width: 62px; text-align: center">{{ matchText }}</span>
        <button v-if="matches.length" class="btn" title="下一个匹配（回车）" @click="onSearchEnter">↓</button>
        <button class="btn" @click="zoom(0.15)">＋</button>
        <button class="btn" @click="zoom(-0.15)">－</button>
        <button class="btn" @click="fit">适应</button>
        <button class="btn" @click="resetView">重置</button>
        <span class="hint">{{ Math.round(scale * 100) }}%</span>
      </div>

      <div
        class="map-inner"
        :style="{
          width: canvasW + 'px',
          height: canvasH + 'px',
          transform: `translate(${tx}px, ${ty}px) scale(${scale})`
        }"
      >
        <svg class="map-edges" :width="canvasW" :height="canvasH">
          <path
            v-for="(e, i) in edgePaths"
            :key="i"
            :d="e.d"
            :stroke="e.color"
            stroke-width="1.6"
            fill="none"
            opacity="0.55"
          />
        </svg>

        <div
          v-for="pn in placedNodes"
          :key="pn.item.node.id"
          class="map-node"
          :data-node-id="pn.item.node.id"
          :class="{ selected: pn.item.node.id === selectedId, world: pn.item.node.locationType === '世界' }"
          :style="{
            left: pn.at.x + 'px',
            top: pn.at.y + 'px',
            width: NODE_W + 'px',
            height: NODE_H + 'px',
            borderColor: nodeColor(pn.item.node.locationType)
          }"
          @click.stop="selectNode(pn.item)"
        >
          <img
            v-if="pn.item.node.iconUrl"
            class="node-icon"
            :src="pn.item.node.iconUrl"
            :alt="pn.item.node.locationType"
          />
          <span class="type" :style="{ background: nodeColor(pn.item.node.locationType) }">
            {{ pn.item.node.locationType }}
          </span>
          <span class="name">{{ pn.item.node.name }}</span>
          <span v-if="pn.item.node.sceneIds.length" class="badge-scene" :title="`${pn.item.node.sceneIds.length} 个场景`">
            🎬 {{ pn.item.node.sceneIds.length }}
          </span>
        </div>
      </div>

      <!-- 图例按树里实际类型动态生成；类型很多（真实书最多 151 种）时靠 max-height + 滚动兜底 -->
      <div v-if="legend.length" class="map-legend" :style="{ maxHeight: '120px', overflowY: 'auto' }">
        <span v-for="e in legend" :key="e.type" :title="`${e.type} · ${e.count} 个`">
          <i :style="{ background: e.color }" />{{ e.type }}
          <b v-if="e.count > 1" style="opacity: 0.6; font-weight: 400">×{{ e.count }}</b>
        </span>
      </div>
      </template>
    </div>

    <aside class="map-detail">
      <template v-if="selected">
        <div class="detail-head">
          <span class="pill" :style="{ background: nodeColor(selected.node.locationType) }">
            {{ selected.node.locationType }}
          </span>
          <h3>{{ selected.node.name }}</h3>
          <div class="hint">{{ selected.node.id }}</div>
        </div>

        <div v-if="ancestors.length" class="crumbs">
          <template v-for="(a, i) in ancestors" :key="a.id">
            <span class="crumb">{{ a.name }}</span>
            <span v-if="i < ancestors.length - 1" class="sep">›</span>
          </template>
        </div>

        <div class="stat-row">
          <div class="stat"><div class="k">子地点</div><div class="v">{{ selected.node.children.length }}</div></div>
          <div class="stat"><div class="k">关联场景</div><div class="v">{{ selectedScenes.length }}</div></div>
          <div class="stat"><div class="k">剧本条目</div><div class="v">{{ selectedActionCount }}</div></div>
        </div>

        <section v-if="selected.node.identInfos.length" class="block">
          <h4>识别信息 identInfos</h4>
          <p v-for="(t, i) in selected.node.identInfos" :key="i">{{ t }}</p>
        </section>

        <section v-for="s in selectedScenes" :key="s.id" class="block scene-block">
          <h4>🎬 {{ s.name }} <span class="hint">（{{ s.id }} · {{ s.actionCount }} 条）</span></h4>
          <img v-if="s.imageUrl" :src="s.imageUrl" :alt="s.name" class="scene-img" />
          <div v-else class="thumb-missing">该场景无配图</div>
          <p v-if="s.summary" class="scene-sum">{{ s.summary }}</p>
          <p v-if="s.sceneDescription && s.sceneDescription !== s.summary" class="hint">{{ s.sceneDescription }}</p>
        </section>

        <section v-if="!selectedScenes.length" class="block">
          <p class="hint">该地图节点没有直接挂载场景。子地点里可能含有场景。</p>
        </section>
      </template>

      <div v-else class="detail-empty">
        <div class="big">🗺️</div>
        <p>点击任意节点查看地点详情</p>
        <p class="hint">
          共 {{ view.stats.mapNodeCount }} 个节点 · {{ view.stats.mapNodeCountWithScenes }} 个节点有场景<br />
          {{ view.scenes.length }} 个场景 · {{ view.actions.length }} 条剧本
        </p>
      </div>
    </aside>
  </div>
</template>

<style scoped>
/* 地点类型图标（reader :location-icons 回填后自动出现；无图标节点不渲染，退回色点） */
.node-icon {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 20px;
  height: 20px;
  object-fit: contain;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.85);
  pointer-events: none;
}
</style>

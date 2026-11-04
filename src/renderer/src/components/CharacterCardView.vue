<script setup lang="ts">
/**
 * 角色卡页面（列表 + 详情）。
 *
 * 【布局】左列表 / 右详情两栏，详情内再分页签（档案 · 关系 · 音色 · 世界书 · 酒馆）。
 * 分页签而不是一路平铺：角色卡信息量很大（20 人 × 档案/关系/形象/音色），
 * 平铺会把页面拉成几屏长，找东西只能滚。
 *
 * 【导出】PNG 走 SillyTavern 官方格式（立绘 + tEXt 内嵌 V2/V3 JSON），
 * 也可以导 JSON。这是用户「做能导出到酒馆的」这条需求的正解 ——
 * 导出后直接拖进 SillyTavern 就能用。
 */
import { computed, onMounted, ref } from 'vue'
import TavernPanel from './TavernPanel.vue'
import type {
  CardExportFormat,
  CharacterCard,
  CharacterCardSummary,
  LorebookEntry
} from '../../../shared/character-card-types'

const loading = ref(false)
const error = ref('')
const items = ref<CharacterCardSummary[]>([])
const stats = ref<{ cardCount: number; withVoice: number; withPortrait: number; relationCount: number } | null>(null)

/** 当前选中卡片 id */
const activeId = ref<string>('')
/** 详情（含世界书） */
const detail = ref<CharacterCard | null>(null)
const lorebook = ref<LorebookEntry[]>([])
const detailLoading = ref(false)

/** 详情内的页签 */
type Tab = 'profile' | 'relations' | 'portraits' | 'voice' | 'lore' | 'tavern'
const tab = ref<Tab>('profile')

/** 立绘预览（点击放大的那张） */
const previewPortrait = ref<string>('')
/** 当前选中的形象（导出 PNG 时用） */
const exportPortrait = ref<string>('')
/** 导出状态 */
const exporting = ref(false)
const exportMsg = ref('')
const exportErr = ref('')

/** 搜索（20 人还好，但角色多的书会用到） */
const query = ref('')

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return items.value
  return items.value.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      c.aliases.some((a) => a.toLowerCase().includes(q)) ||
      c.identInfos.some((i) => i.toLowerCase().includes(q))
  )
})

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const r = await window.feather.cardList()
    if (!r.ok || !r.items) {
      error.value = r.error ?? '角色卡加载失败'
      items.value = []
      return
    }
    items.value = r.items
    stats.value = r.stats ?? null
    if (!activeId.value && r.items.length) await pick(r.items[0].id)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

async function pick(id: string): Promise<void> {
  activeId.value = id
  detailLoading.value = true
  detail.value = null
  lorebook.value = []
  try {
    const r = await window.feather.cardGet(id)
    if (!r.ok || !r.card) {
      error.value = r.error ?? '读取角色卡失败'
      return
    }
    detail.value = r.card
    lorebook.value = r.lorebook ?? []
    previewPortrait.value = r.card.portraits.find((p) => p.imageUrl)?.imageUrl ?? ''
    exportPortrait.value = r.card.portraits.find((p) => p.imagePath)?.appearanceId ?? ''
    tab.value = 'profile'
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    detailLoading.value = false
  }
}

/** 导出当前卡片（或多选导出由父级触发；这里先做单张） */
async function doExport(format: CardExportFormat): Promise<void> {
  if (!detail.value) return
  exporting.value = true
  exportMsg.value = ''
  exportErr.value = ''
  try {
    const r = await window.feather.cardExport({
      cardIds: [detail.value.id],
      format,
      portraitAppearanceId: format === 'png' ? exportPortrait.value : undefined
    })
    if (r.canceled) {
      exportMsg.value = '已取消'
      return
    }
    if (!r.ok) {
      exportErr.value = r.error ?? '导出失败'
      if (r.skipped?.length) exportErr.value += `（${r.skipped.map((s) => s.reason).join('；')}）`
      return
    }
    exportMsg.value = `已导出 ${r.paths?.length ?? 0} 个文件：${(r.paths ?? []).join('、')}`
  } catch (e) {
    exportErr.value = (e as Error).message
  } finally {
    exporting.value = false
  }
}

/** 重要性分级 → 徽章色（CORE 暖红、HIGH 暖橙、其余中性） */
function levelClass(level: string): string {
  const l = level.toUpperCase()
  if (l === 'CORE') return 'lv-core'
  if (l === 'HIGH') return 'lv-high'
  if (l === 'MEDIUM') return 'lv-mid'
  return 'lv-low'
}

onMounted(() => {
  void load()
})
</script>

<template>
  <div class="cc-root">
    <div v-if="loading" class="cc-hint">正在整理角色卡…</div>
    <div v-else-if="error && !items.length" class="cc-empty">
      <div class="cc-empty-ico">🃏</div>
      <div class="cc-empty-title">没有可用的角色卡</div>
      <div class="cc-empty-desc">{{ error }}</div>
    </div>

    <template v-else>
      <!-- ===== 左：角色列表 ===== -->
      <aside class="cc-list">
        <div class="cc-list-head">
          <div class="cc-list-title">
            角色卡
            <span class="cc-list-meta">{{ stats?.cardCount ?? 0 }} 人</span>
          </div>
          <input v-model="query" class="cc-search" type="search" placeholder="搜索名字 / 别名 / 身份" />
        </div>
        <div class="cc-list-body">
          <button
            v-for="c in filtered"
            :key="c.id"
            class="cc-item"
            :class="{ active: c.id === activeId }"
            :data-testid="`card-item-${c.id}`"
            @click="pick(c.id)"
          >
            <img v-if="c.avatarUrl" class="cc-avatar" :src="c.avatarUrl" :alt="c.name" draggable="false" />
            <div v-else class="cc-avatar cc-avatar-ph">{{ c.name.slice(0, 1) }}</div>
            <div class="cc-item-main">
              <div class="cc-item-name">
                {{ c.name }}
                <span v-if="c.importanceLevel" class="cc-lv" :class="levelClass(c.importanceLevel)">
                  {{ c.importanceLevel }}
                </span>
              </div>
              <div class="cc-item-sub">{{ c.identInfos.slice(0, 2).join(' · ') || '—' }}</div>
              <div class="cc-item-badges">
                <span v-if="c.portraitCount" class="cc-badge">立绘 {{ c.portraitCount }}</span>
                <span v-if="c.hasVoice" class="cc-badge">音色</span>
                <span v-if="c.relationCount" class="cc-badge">关系 {{ c.relationCount }}</span>
              </div>
            </div>
          </button>
          <div v-if="!filtered.length" class="cc-none">没有匹配的角色</div>
        </div>
        <div v-if="stats" class="cc-list-foot">
          <span>有立绘 {{ stats.withPortrait }}</span>
          <span>有音色 {{ stats.withVoice }}</span>
          <span>关系 {{ stats.relationCount }}</span>
        </div>
      </aside>

      <!-- ===== 右：详情 ===== -->
      <main class="cc-detail">
        <div v-if="detailLoading" class="cc-hint">读取中…</div>
        <div v-else-if="!detail" class="cc-hint">左侧选择一个角色</div>

        <template v-else>
          <!-- 头部：立绘 + 名字 + 导出 -->
          <header class="cc-head">
            <div class="cc-head-portrait">
              <img
                v-if="previewPortrait"
                class="cc-portrait-img"
                :src="previewPortrait"
                :alt="detail.name"
                draggable="false"
              />
              <div v-else class="cc-portrait-ph">无立绘</div>
            </div>
            <div class="cc-head-main">
              <h2 class="cc-name">
                {{ detail.name }}
                <span v-if="detail.importanceLevel" class="cc-lv" :class="levelClass(detail.importanceLevel)">
                  {{ detail.importanceLevel }}
                </span>
                <span v-if="detail.lifeStatus" class="cc-life">{{ detail.lifeStatus }}</span>
              </h2>
              <div v-if="detail.aliases.length" class="cc-aliases">别名：{{ detail.aliases.join('、') }}</div>
              <div v-if="detail.identInfos.length" class="cc-idents">
                <span v-for="(t, i) in detail.identInfos" :key="i" class="cc-ident">{{ t }}</span>
              </div>
              <div class="cc-actions">
                <button class="btn" :disabled="exporting" data-testid="export-png" @click="doExport('png')">
                  {{ exporting ? '导出中…' : '导出酒馆卡片（PNG）' }}
                </button>
                <button class="btn" :disabled="exporting" data-testid="export-json" @click="doExport('json')">
                  导出 JSON
                </button>
                <select v-if="detail.portraits.length > 1" v-model="exportPortrait" class="cc-sel" title="导出 PNG 时使用的立绘">
                  <option v-for="p in detail.portraits.filter((x) => x.imagePath)" :key="p.appearanceId" :value="p.appearanceId">
                    {{ p.name }}
                  </option>
                </select>
              </div>
              <div v-if="exportMsg" class="cc-export-ok" data-testid="export-msg">{{ exportMsg }}</div>
              <div v-if="exportErr" class="cc-export-err" data-testid="export-err">{{ exportErr }}</div>
            </div>
          </header>

          <!-- 页签 -->
          <nav class="cc-tabs">
            <button :class="{ on: tab === 'profile' }" data-testid="tab-profile" @click="tab = 'profile'">档案</button>
            <button :class="{ on: tab === 'relations' }" data-testid="tab-relations" @click="tab = 'relations'">
              关系 <span class="cc-tab-n">{{ detail.relations.length }}</span>
            </button>
            <button :class="{ on: tab === 'portraits' }" data-testid="tab-portraits" @click="tab = 'portraits'">
              立绘 <span class="cc-tab-n">{{ detail.portraits.length }}</span>
            </button>
            <button :class="{ on: tab === 'voice' }" data-testid="tab-voice" @click="tab = 'voice'">
              音色 <span v-if="detail.voice" class="cc-dot"></span>
            </button>
            <button :class="{ on: tab === 'lore' }" data-testid="tab-lore" @click="tab = 'lore'">
              世界书 <span class="cc-tab-n">{{ lorebook.length }}</span>
            </button>
            <button :class="{ on: tab === 'tavern' }" data-testid="tab-tavern" @click="tab = 'tavern'">酒馆</button>
          </nav>

          <div class="cc-tab-body">
            <!-- 档案 -->
            <section v-if="tab === 'profile'" class="cc-sec" data-testid="pane-profile">
              <div class="cc-field">
                <div class="cc-field-label">人物档案</div>
                <div class="cc-field-body">{{ detail.profile || '（包内无人物档案）' }}</div>
              </div>
              <div class="cc-field">
                <div class="cc-field-label">出场章节</div>
                <div class="cc-chapters">
                  <span v-for="c in detail.appearanceChapters" :key="c" class="cc-ch">第 {{ c }} 章</span>
                  <span v-if="!detail.appearanceChapters.length" class="cc-muted">—</span>
                </div>
              </div>
              <div class="cc-field">
                <div class="cc-field-label">酒馆字段（导出时写进卡片）</div>
                <div class="cc-kv"><b>描述</b><p>{{ detail.description }}</p></div>
                <div class="cc-kv"><b>性格</b><p>{{ detail.personality || '—' }}</p></div>
                <div class="cc-kv"><b>场景</b><p>{{ detail.scenario }}</p></div>
                <div class="cc-kv"><b>开场白</b><p>{{ detail.firstMes }}</p></div>
                <div class="cc-kv"><b>作者备注</b><p>{{ detail.creatorNotes }}</p></div>
              </div>
            </section>

            <!-- 关系 -->
            <section v-else-if="tab === 'relations'" class="cc-sec" data-testid="pane-relations">
              <div v-if="!detail.relations.length" class="cc-muted">包内没有该角色的关系数据</div>
              <div v-for="(r, i) in detail.relations" :key="i" class="cc-rel">
                <div class="cc-rel-head">
                  <b>{{ r.otherName }}</b>
                  <span v-if="r.overview" class="cc-rel-overview">{{ r.overview }}</span>
                  <span v-if="r.fromChapter" class="cc-rel-range">第 {{ r.fromChapter }}–{{ r.toChapter }} 章</span>
                </div>
                <div v-if="r.summary" class="cc-rel-sum">{{ r.summary }}</div>
              </div>
            </section>

            <!-- 立绘 -->
            <section v-else-if="tab === 'portraits'" class="cc-sec" data-testid="pane-portraits">
              <div v-if="!detail.portraits.length" class="cc-muted">包内没有该角色的立绘</div>
              <div class="cc-portraits">
                <button
                  v-for="p in detail.portraits"
                  :key="p.appearanceId"
                  class="cc-portrait-card"
                  :class="{ on: previewPortrait === p.imageUrl }"
                  @click="previewPortrait = p.imageUrl ?? ''"
                >
                  <img v-if="p.imageUrl" class="cc-portrait-thumb" :src="p.imageUrl" :alt="p.name" draggable="false" />
                  <div v-else class="cc-portrait-thumb cc-portrait-miss">无图</div>
                  <div class="cc-portrait-meta">
                    <div class="cc-portrait-name">{{ p.name }}<span v-if="p.isDefault" class="cc-default">默认</span></div>
                    <div v-if="p.sex" class="cc-muted">{{ p.sex }}</div>
                    <div v-if="p.appearanceSummary" class="cc-portrait-desc">{{ p.appearanceSummary }}</div>
                  </div>
                </button>
              </div>
            </section>

            <!-- 音色 -->
            <section v-else-if="tab === 'voice'" class="cc-sec" data-testid="pane-voice">
              <div v-if="!detail.voice" class="cc-muted">包内没有该角色的音色档案</div>
              <template v-else>
                <div class="cc-kv"><b>音色类型</b><p>{{ detail.voice.voiceType || '—' }}</p></div>
                <div class="cc-kv"><b>音色描述</b><p>{{ detail.voice.description || '—' }}</p></div>
                <div v-if="detail.voice.sampleUrl" class="cc-field">
                  <div class="cc-field-label">参考样本</div>
                  <audio :src="detail.voice.sampleUrl" controls preload="none" class="cc-audio"></audio>
                </div>
              </template>
            </section>

            <!-- 世界书 -->
            <section v-else-if="tab === 'lore'" class="cc-sec" data-testid="pane-lore">
              <div class="cc-muted cc-lore-tip">
                这些条目会随卡片一起导出成 SillyTavern 的 character_book，也会在内置酒馆里按关键词注入。
              </div>
              <div v-for="e in lorebook" :key="e.id" class="cc-lore">
                <div class="cc-lore-head">
                  <b>{{ e.name }}</b>
                  <span v-if="e.constant" class="cc-lore-const">常驻</span>
                  <span v-if="e.keys.length" class="cc-lore-keys">{{ e.keys.join(' / ') }}</span>
                </div>
                <pre class="cc-lore-body">{{ e.content }}</pre>
              </div>
            </section>

            <!-- 酒馆 -->
            <section v-else-if="tab === 'tavern'" class="cc-sec cc-tv-wrap" data-testid="pane-tavern">
              <TavernPanel :card="detail" :lorebook="lorebook" />
            </section>
          </div>
        </template>
      </main>
    </template>
  </div>
</template>

<style scoped>
.cc-root {
  display: grid;
  grid-template-columns: 268px minmax(0, 1fr);
  gap: 12px;
  height: 100%;
  min-height: 0;
  padding: 12px;
  box-sizing: border-box;
}
.cc-hint,
.cc-empty {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--muted);
}
.cc-empty-ico {
  font-size: 42px;
}
.cc-empty-title {
  font-size: 17px;
  font-weight: 600;
  color: var(--text);
}
.cc-empty-desc {
  max-width: 460px;
  text-align: center;
  font-size: 13px;
  color: var(--faint);
  line-height: 1.7;
}

/* ---- 左列表 ---- */
.cc-list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-1);
  overflow: hidden;
}
.cc-list-head {
  flex: none;
  padding: 10px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
}
.cc-list-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 8px;
}
.cc-list-meta {
  font-size: 11px;
  font-weight: 400;
  color: var(--faint);
}
.cc-search {
  width: 100%;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--panel);
  color: var(--text);
  font-size: 12px;
  box-sizing: border-box;
}
.cc-list-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
}
.cc-item {
  display: flex;
  gap: 9px;
  width: 100%;
  padding: 8px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast) ease, border-color var(--dur-fast) ease;
}
.cc-item:hover {
  background: var(--accent-soft);
}
.cc-item.active {
  background: var(--accent-soft);
  border-color: var(--accent);
}
.cc-avatar {
  flex: none;
  width: 44px;
  height: 58px;
  border-radius: 6px;
  object-fit: cover;
  background: var(--panel-2);
}
.cc-avatar-ph {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  font-weight: 600;
  color: var(--muted);
}
.cc-item-main {
  flex: 1;
  min-width: 0;
}
.cc-item-name {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cc-item-sub {
  font-size: 11px;
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 2px;
}
.cc-item-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.cc-badge {
  font-size: 9.5px;
  padding: 1px 5px;
  border-radius: 999px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  color: var(--muted);
}
.cc-lv {
  font-size: 9px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 999px;
  letter-spacing: 0.04em;
}
.lv-core {
  background: rgba(194, 85, 75, 0.15);
  color: var(--bad);
}
.lv-high {
  background: rgba(217, 151, 76, 0.2);
  color: #b5732a;
}
.lv-mid,
.lv-low {
  background: var(--panel-2);
  color: var(--faint);
}
.cc-none {
  text-align: center;
  font-size: 12px;
  color: var(--faint);
  padding: 20px;
}
.cc-list-foot {
  flex: none;
  display: flex;
  justify-content: space-between;
  gap: 6px;
  padding: 7px 10px;
  border-top: 1px solid var(--border);
  background: var(--panel-2);
  font-size: 10.5px;
  color: var(--faint);
}

/* ---- 右详情 ---- */
.cc-detail {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-1);
  overflow: hidden;
}
.cc-head {
  flex: none;
  display: flex;
  gap: 16px;
  padding: 14px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
}
.cc-head-portrait {
  flex: none;
  width: 108px;
  height: 144px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--panel);
  border: 1px solid var(--border);
}
.cc-portrait-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.cc-portrait-ph {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 12px;
  color: var(--faint);
}
.cc-head-main {
  flex: 1;
  min-width: 0;
}
.cc-name {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 4px;
  font-size: 19px;
  font-weight: 700;
  color: var(--text);
}
.cc-life {
  font-size: 10.5px;
  font-weight: 500;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--panel);
  border: 1px solid var(--border);
  color: var(--muted);
}
.cc-aliases {
  font-size: 11.5px;
  color: var(--muted);
  margin-bottom: 5px;
}
.cc-idents {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 9px;
}
.cc-ident {
  font-size: 10.5px;
  padding: 1.5px 7px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--text);
}
.cc-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  align-items: center;
}
.cc-sel {
  padding: 4px 7px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  font-size: 11.5px;
}
.cc-export-ok {
  margin-top: 7px;
  font-size: 11.5px;
  color: #2f7a4a;
  word-break: break-all;
}
.cc-export-err {
  margin-top: 7px;
  font-size: 11.5px;
  color: var(--bad);
  word-break: break-all;
}

.cc-tabs {
  flex: none;
  display: flex;
  gap: 2px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
.cc-tabs button {
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--muted);
  padding: 9px 12px;
  font-size: 12.5px;
  cursor: pointer;
}
.cc-tabs button:hover {
  color: var(--text);
}
.cc-tabs button.on {
  color: var(--text);
  font-weight: 600;
  border-bottom-color: var(--accent);
}
.cc-tab-n {
  font-size: 10px;
  color: var(--faint);
  margin-left: 2px;
}
.cc-dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
  vertical-align: middle;
  margin-left: 3px;
}

.cc-tab-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px;
}
.cc-sec {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.cc-field-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--muted);
  margin-bottom: 5px;
}
.cc-field-body {
  font-size: 13px;
  line-height: 1.85;
  color: var(--text);
  white-space: pre-wrap;
}
.cc-chapters {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.cc-ch {
  font-size: 11px;
  padding: 1.5px 8px;
  border-radius: 999px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  color: var(--muted);
}
.cc-kv {
  margin-bottom: 10px;
}
.cc-kv b {
  display: block;
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 3px;
}
.cc-kv p {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--text);
  white-space: pre-wrap;
}
.cc-muted {
  font-size: 12px;
  color: var(--faint);
}

.cc-rel {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--panel-2);
}
.cc-rel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
  color: var(--text);
}
.cc-rel-overview {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--text);
}
.cc-rel-range {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--faint);
}
.cc-rel-sum {
  margin-top: 5px;
  font-size: 12px;
  line-height: 1.75;
  color: var(--muted);
}

.cc-portraits {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
}
.cc-portrait-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 7px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--panel-2);
  cursor: pointer;
  text-align: left;
}
.cc-portrait-card.on {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}
.cc-portrait-thumb {
  width: 100%;
  height: 150px;
  object-fit: contain;
  border-radius: 6px;
  background: var(--panel);
}
.cc-portrait-miss {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--faint);
}
.cc-portrait-meta {
  font-size: 11px;
  color: var(--muted);
}
.cc-portrait-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 5px;
}
.cc-default {
  font-size: 9px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-ink);
}
.cc-portrait-desc {
  margin-top: 3px;
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--faint);
}
.cc-audio {
  width: 100%;
  max-width: 420px;
}
.cc-lore-tip {
  line-height: 1.7;
  margin-bottom: 4px;
}
.cc-lore {
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--panel-2);
  padding: 10px 12px;
}
.cc-lore-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12.5px;
  color: var(--text);
  margin-bottom: 5px;
}
.cc-lore-const {
  font-size: 9.5px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-ink);
}
.cc-lore-keys {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--faint);
}
.cc-lore-body {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.75;
  color: var(--muted);
  white-space: pre-wrap;
  font-family: inherit;
}
/* 酒馆要占满页签可用高度，不能按内容撑开（否则输入框会跑到屏幕外） */
.cc-tv-wrap {
  height: 100%;
  min-height: 380px;
}
</style>

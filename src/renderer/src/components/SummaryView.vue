<script setup lang="ts">
import { computed, ref } from 'vue'
import Thumb from './Thumb.vue'
import ParsePanel from './ParsePanel.vue'
import type { ImportSummary } from '../../../shared/app-types'

const props = defineProps<{
  summary: ImportSummary
  tab: 'overview' | 'chapters' | 'entities' | 'files' | 'map' | 'stage' | 'impression'
}>()

const emit = defineEmits<{ (e: 'read-chapter', byteStart: number): void }>()

const lightbox = ref<{ label: string; url: string } | null>(null)

const p = computed(() => props.summary.project)
const images = computed(() => props.summary.files.filter((f) => f.kind === 'png' || f.kind === 'image'))
const others = computed(() => props.summary.files.filter((f) => !(f.kind === 'png' || f.kind === 'image')))
const verifyOk = computed(() => props.summary.verify.failed === 0)

const mb = (n: number): string => (n / 1024 / 1024).toFixed(2) + ' MB'
const kb = (n: number): string => (n / 1024).toFixed(1) + ' KB'
const sizeOf = (n: number): string => (n >= 1024 * 1024 ? mb(n) : kb(n))

const entityGroups = computed(() => [
  { key: 'characters', label: '人物 characters', count: props.summary.entities.characters, names: props.summary.entityNames.characters },
  { key: 'factions', label: '势力 factions', count: props.summary.entities.factions, names: props.summary.entityNames.factions },
  { key: 'items', label: '物品 items', count: props.summary.entities.items, names: props.summary.entityNames.items },
  { key: 'creatures', label: '生物 creatures', count: props.summary.entities.creatures, names: props.summary.entityNames.creatures }
])
</script>

<template>
  <div>
    <!-- 概览 -->
    <section v-if="tab === 'overview'">
      <div class="card">
        <h2>项目</h2>
        <div class="title">{{ p.title }}</div>
        <div class="sub">{{ summary.filePath }}</div>
        <div class="sub">id: {{ p.id }} · revisionId: {{ p.revisionId }}</div>
        <div class="stats">
          <div class="stat"><div class="k">章节数</div><div class="v">{{ p.chapterCount }}</div></div>
          <div class="stat"><div class="k">字符数</div><div class="v">{{ p.charCount.toLocaleString() }}</div></div>
          <div class="stat"><div class="k">成员文件</div><div class="v">{{ summary.files.length }}</div></div>
          <div class="stat"><div class="k">包体积</div><div class="v">{{ mb(summary.totalSize) }}</div></div>
        </div>
      </div>

      <div class="card">
        <h2>完整性</h2>
        <template v-if="summary.verify.total > 0">
          <span class="badge" :class="verifyOk ? 'ok' : 'bad'">
            sha256 校验 {{ summary.verify.passed }}/{{ summary.verify.total }} 通过
            <template v-if="summary.verify.failed"> · {{ summary.verify.failed }} 失败</template>
          </span>
          <span class="badge" :class="summary.guards.sumSizeMatches ? 'ok' : 'bad'" style="margin-left: 6px">
            Σsize 守卫
          </span>
          <span class="badge" :class="summary.guards.noTrailingBytes ? 'ok' : 'bad'" style="margin-left: 6px">
            无尾随字节
          </span>
          <div class="sub" style="margin-top: 8px">
            清单 JSON 长度 {{ summary.jsonLen.toLocaleString() }} 字节 · blob 起始偏移 {{ summary.blobStart.toLocaleString() }}
          </div>
        </template>
        <div v-else class="sub">（本次为重新打开已有工作库，未做来源整包校验）</div>
      </div>

      <div class="card">
        <h2>元数据</h2>
        <table class="table">
          <tbody>
            <tr><td>状态 status</td><td>{{ p.status }}</td></tr>
            <tr><td>编码 encoding</td><td>{{ p.encoding }}</td></tr>
            <tr><td>解析模式 parseMode</td><td>{{ p.parseMode }}</td></tr>
            <tr><td>脚本风格 storyScriptStyle</td><td>{{ p.storyScriptStyle }}</td></tr>
            <tr><td>更新时间 updatedAt</td><td>{{ p.updatedAt }}</td></tr>
          </tbody>
        </table>
      </div>

      <!-- 解析入口（A1）：开始/子集/取消 + 进度 + 失败可见 + 可重跑
           ⚠️ 这里必须传「工作库目录名」而不是「包内 ID」：
           ParsePanel / ImagegenPanel 内部把该值当作 `<userData>/workspace/` 下的目录名用
           （主进程 `join(workspaceRoot(), sanitizeSegment(pkgId))`）。传 p.id（包内 pkgId）
           会拼出不存在的路径 → 报「工作库索引缺失或不可读：…/<pkgId>/index.json (ENOENT)」，
           且所有任务计数回落到「全 0 / 全待跑」。 -->
      <ParsePanel :pkg-id="summary.workspaceDir" />
    </section>

    <!-- 章节 -->
    <section v-else-if="tab === 'chapters'">
      <div class="card">
        <h2>章节列表（{{ summary.chapters.length }}）</h2>
        <table class="table">
          <thead>
            <tr><th>#</th><th>标题</th><th>byteStart</th><th>byteEnd</th><th>字节长度</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="c in summary.chapters" :key="c.byteStart">
              <td class="num">{{ c.seq }}</td>
              <td>{{ c.title }}</td>
              <td class="num">{{ c.byteStart.toLocaleString() }}</td>
              <td class="num">{{ c.byteEnd.toLocaleString() }}</td>
              <td class="num">{{ (c.byteEnd - c.byteStart).toLocaleString() }}</td>
              <td>
                <button class="btn" @click="emit('read-chapter', c.byteStart)">阅读本章</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 实体 -->
    <section v-else-if="tab === 'entities'">
      <div class="card">
        <h2>实体统计（canonical.objects）</h2>
        <div class="stats">
          <div class="stat"><div class="k">characters</div><div class="v">{{ summary.entities.characters }}</div></div>
          <div class="stat"><div class="k">factions</div><div class="v">{{ summary.entities.factions }}</div></div>
          <div class="stat"><div class="k">items</div><div class="v">{{ summary.entities.items }}</div></div>
          <div class="stat"><div class="k">creatures</div><div class="v">{{ summary.entities.creatures }}</div></div>
        </div>
      </div>
      <div v-for="g in entityGroups" :key="g.key" class="card">
        <h2>{{ g.label }}（{{ g.count }}）</h2>
        <div v-if="g.names.length" class="grid" style="grid-template-columns: repeat(auto-fill, minmax(150px, 1fr))">
          <div v-for="(n, i) in g.names" :key="i" class="stat" style="padding: 6px 10px">{{ n }}</div>
        </div>
        <div v-else class="hint">（空）</div>
      </div>
    </section>

    <!-- 文件 -->
    <section v-else>
      <div class="card">
        <h2>图片（{{ images.length }}）</h2>
        <div v-if="images.length" class="grid">
          <Thumb
            v-for="f in images"
            :key="f.path"
            :file-path="summary.filePath"
            :entry-path="f.path"
            :label="f.path.split('/').slice(-2).join('/')"
            @open="lightbox = $event"
          />
        </div>
        <div v-else class="hint">（无图片成员）</div>
      </div>

      <div class="card">
        <h2>其它成员（{{ others.length }}）</h2>
        <table class="table">
          <thead><tr><th>path</th><th>类型</th><th>大小</th></tr></thead>
          <tbody>
            <tr v-for="f in others" :key="f.path">
              <td style="word-break: break-all">{{ f.path }}</td>
              <td class="num">{{ f.kind }}</td>
              <td class="num">{{ sizeOf(f.size) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <div v-if="lightbox" class="lightbox" @click="lightbox = null">
      <img :src="lightbox.url" :alt="lightbox.label" />
    </div>
  </div>
</template>

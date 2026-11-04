<script setup lang="ts">
/**
 * 漫画编排面板：讲述与配音 / 背景配乐 / 本页音色。
 *
 * 【布局对照】三块纵向排列、整页可滚动 —— 用户说过「不着急塞到一个界面，
 * 可以做成上下滑动的」，所以不做多页签，直接滚动。
 *
 * 【配色】完全沿用本软件的琥珀色系（--accent / --panel / --border 等变量），
 * 不引入截图里那套绿色（截图是另一个产品的主题）。
 *
 * 【关键交互】
 *   - 讲述与配音：每段可试听、单段可重配、整页可一键重配；
 *   - 背景配乐：显示当前曲目（含授权署名），可从候选池手动换曲；
 *   - 本页音色：改类型/描述后可保存；旁白与角色分列。
 *
 * 【为什么"重新配音"要禁用条件】段与 clip 无法安全对齐时（数量不一致），
 * 写回会把音频错配到别的句子上且听不出来。所以必须显示原因并禁用按钮。
 */
import { computed, onMounted, ref } from 'vue'
import type {
  ChapterMusicCard,
  PageProduction,
  PageVoiceCard,
  ProductionOverview
} from '../../../main/manga-production/index'

const props = defineProps<{
  chapterSeq: number
  pageNo: number
}>()

const emit = defineEmits<{ (e: 'close'): void; (e: 'changed'): void }>()

const loading = ref(false)
const error = ref('')
const overview = ref<ProductionOverview | null>(null)
const page = ref<PageProduction | null>(null)
const voices = ref<PageVoiceCard[]>([])
const music = ref<ChapterMusicCard | null>(null)

/** 正在试听的段 index（-1 = 无） */
const playingSeg = ref(-1)
let audio: HTMLAudioElement | null = null

/** 返回「这段是不是我们软件自己的界面配色」——配色在 style 里用变量，此处不涉及 */

/** 重新配音进行中 */
const redubbing = ref(false)
const redubMsg = ref('')
const redubErr = ref('')

/** 音色编辑草稿（characterId → {vt, vi}） */
const voiceDraft = ref<Record<string, { vt: string; vi: string }>>({})
const savingVoice = ref<string>('')
const voiceMsg = ref('')

/** 换曲面板 */
const showMusicPicker = ref(false)
const savingMusic = ref(false)
const musicMsg = ref('')

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const r = await window.feather.mangaProductionPage(props.chapterSeq, props.pageNo)
    if (!r.ok) {
      error.value = r.error ?? '编排数据加载失败'
      return
    }
    overview.value = r.overview ?? null
    page.value = r.page ?? null
    voices.value = r.voices ?? []
    music.value = r.music ?? null
    // 初始化音色草稿
    const d: Record<string, { vt: string; vi: string }> = {}
    for (const v of voices.value) d[v.characterId] = { vt: v.vt, vi: v.vi }
    voiceDraft.value = d
    redubMsg.value = ''
    redubErr.value = ''
    voiceMsg.value = ''
    musicMsg.value = ''
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
})

/** 统计：讲述条数（= 段所属 speech 去重）与段数 */
const speechCount = computed(() => {
  const p = page.value
  if (!p) return 0
  // fullText 相同的连续段属于同一条讲述
  let n = 0
  let prev = ''
  for (const s of p.segments) {
    if (s.fullText !== prev) {
      n++
      prev = s.fullText
    }
  }
  return n
})
const segCount = computed(() => page.value?.segments.length ?? 0)
const withClipCount = computed(() => page.value?.segments.filter((s) => s.hasClip).length ?? 0)

/** 试听一段 */
function play(segIndex: number): void {
  const p = page.value
  if (!p) return
  const seg = p.segments.find((s) => s.index === segIndex)
  if (!seg?.url) return
  if (audio) {
    audio.pause()
    audio = null
  }
  if (playingSeg.value === segIndex) {
    playingSeg.value = -1
    return
  }
  const a = new Audio(seg.url)
  audio = a
  playingSeg.value = segIndex
  a.onended = () => {
    playingSeg.value = -1
  }
  a.onerror = () => {
    playingSeg.value = -1
    redubErr.value = '该段音频加载失败（文件可能已被替换）'
  }
  void a.play().catch(() => {
    playingSeg.value = -1
  })
}

/** 试听音色样本 */
function playSample(v: PageVoiceCard): void {
  if (!v.sampleUrl) return
  if (audio) {
    audio.pause()
    audio = null
  }
  const a = new Audio(v.sampleUrl)
  audio = a
  void a.play().catch(() => {
    /* 浏览器自动播放限制，忽略 */
  })
}

/** 整页重新配音 */
async function redubAll(): Promise<void> {
  const p = page.value
  if (!p || redubbing.value) return
  if (!p.alignExact) {
    redubErr.value = `无法重配：${p.alignReason ?? '段落与配音段无法对齐'}`
    return
  }
  redubbing.value = true
  redubMsg.value = '正在逐段合成…'
  redubErr.value = ''
  try {
    // 把当前音色描述作为 TTS 的 voice 提示（角色 id → 描述）
    const map: Record<string, string> = {}
    for (const v of voices.value) {
      const d = voiceDraft.value[v.characterId]
      if (d?.vi) map[v.characterId] = d.vi
    }
    const r = await window.feather.mangaProductionRedub(p.chapterSeq, p.pageNo, map)
    if (!r.ok) {
      redubErr.value = r.error ?? '重新配音失败'
      redubMsg.value = ''
      return
    }
    redubMsg.value = `已重新合成 ${r.synthesized ?? 0} 段并写回（更新 ${r.updated ?? 0} 条配音记录）`
    await load()
    emit('changed')
  } catch (e) {
    redubErr.value = (e as Error).message
    redubMsg.value = ''
  } finally {
    redubbing.value = false
  }
}

/** 保存单个音色 */
async function saveVoice(v: PageVoiceCard): Promise<void> {
  const d = voiceDraft.value[v.characterId]
  if (!d) return
  savingVoice.value = v.characterId
  voiceMsg.value = ''
  try {
    const r = await window.feather.mangaProductionSaveVoice({
      characterId: v.characterId,
      vt: d.vt,
      vi: d.vi,
      isNarrator: v.isNarrator
    })
    if (!r.ok) {
      voiceMsg.value = r.error ?? '保存失败'
      return
    }
    voiceMsg.value = `已保存「${v.name}」的音色${r.created ? '（新建）' : ''}`
    await load()
    emit('changed')
  } catch (e) {
    voiceMsg.value = (e as Error).message
  } finally {
    savingVoice.value = ''
  }
}

/** 换曲 */
async function pickMusic(c: ChapterMusicCard['candidates'][number]): Promise<void> {
  const m = music.value
  if (!m || savingMusic.value) return
  savingMusic.value = true
  musicMsg.value = ''
  try {
    const r = await window.feather.mangaProductionSaveMusic({
      chapterSeq: m.chapterSeq,
      track: {
        id: c.id,
        title: c.title,
        author: c.author,
        url: c.url,
        durationSec: c.durationSec,
        licenseId: c.licenseId,
        attribution: c.attribution
      }
    })
    if (!r.ok) {
      musicMsg.value = r.error ?? '换曲失败'
      return
    }
    musicMsg.value = `已换为「${c.title}」`
    showMusicPicker.value = false
    await load()
    emit('changed')
  } catch (e) {
    musicMsg.value = (e as Error).message
  } finally {
    savingMusic.value = false
  }
}

/** 段落类型标签 */
function typeLabel(t: string): string {
  if (t === 'say') return '对白'
  if (t === 'think') return '心声'
  return '旁白'
}

/** 句号结尾的段显示省略号（截图里长文本会截断） */
function shorten(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}
</script>

<template>
  <div class="mp-root" data-testid="manga-production">
    <div v-if="loading" class="mp-hint">正在读取编排数据…</div>
    <div v-else-if="error" class="mp-err-big">{{ error }}</div>

    <template v-else>
      <!-- 顶栏 -->
      <header class="mp-head">
        <div class="mp-head-left">
          <span class="mp-title">
            第 {{ page?.chapterSeq }} 章 · 第 {{ page?.pageNo }} 页
          </span>
          <span class="mp-sub">{{ page?.pageIndex }} / {{ page?.totalPages }}</span>
          <span v-if="page && !page.alignExact" class="mp-warn" data-testid="mp-align-warn">
            对齐不完整：{{ page.alignReason }}
          </span>
        </div>
        <div class="mp-head-right">
          <button class="btn tiny" data-testid="mp-close" @click="emit('close')">返回阅读</button>
        </div>
      </header>

      <div class="mp-body">
        <!-- ===== ① 讲述与配音 ===== -->
        <section class="mp-card" data-testid="mp-dubbing">
          <div class="mp-card-head">
            <div class="mp-card-title">
              <span class="mp-ico">🔊</span>
              <b>讲述与配音</b>
              <span class="mp-meta">
                {{ speechCount }} 条讲述 · {{ segCount }} 段配音 · {{ withClipCount }} 段已有文件
              </span>
            </div>
            <div class="mp-card-actions">
              <button
                class="btn"
                :disabled="redubbing || !page?.alignExact || !segCount"
                data-testid="mp-redub"
                :title="page?.alignExact ? '逐段合成并写回' : page?.alignReason ?? ''"
                @click="redubAll"
              >
                {{ redubbing ? '合成中…' : '本页重新配音' }}
              </button>
            </div>
          </div>

          <div v-if="redubMsg" class="mp-ok" data-testid="mp-redub-msg">{{ redubMsg }}</div>
          <div v-if="redubErr" class="mp-err" data-testid="mp-redub-err">{{ redubErr }}</div>

          <div class="mp-seg-list">
            <div
              v-for="s in page?.segments ?? []"
              :key="s.index"
              class="mp-seg"
              :class="{ playing: playingSeg === s.index }"
              :data-testid="`mp-seg-${s.index}`"
            >
              <div class="mp-seg-no">{{ String(s.index + 1).padStart(2, '0') }}</div>
              <div class="mp-seg-main">
                <div class="mp-seg-meta">
                  <span class="mp-tag">{{ typeLabel(s.type) }}</span>
                  <span v-if="s.speaker" class="mp-speaker">{{ s.speaker }}</span>
                  <span class="mp-seg-panel">第 {{ s.panel }} 格</span>
                </div>
                <div class="mp-seg-text">{{ shorten(s.text) }}</div>
              </div>
              <div class="mp-seg-side">
                <span v-if="s.hasClip" class="mp-dur">{{ s.durationSec > 0 ? s.durationSec.toFixed(1) + 's' : '—' }}</span>
                <span v-else class="mp-noclip">无配音</span>
                <button
                  v-if="s.hasClip"
                  class="mp-btn-play"
                  :data-testid="`mp-play-${s.index}`"
                  @click="play(s.index)"
                >
                  {{ playingSeg === s.index ? '■ 停止' : '▷ 试听' }}
                </button>
              </div>
            </div>
            <div v-if="!(page?.segments ?? []).length" class="mp-empty">本页没有讲述文本</div>
          </div>
        </section>

        <!-- ===== ② 背景配乐 ===== -->
        <section class="mp-card" data-testid="mp-music">
          <div class="mp-card-head">
            <div class="mp-card-title">
              <span class="mp-ico">♪</span>
              <b>背景配乐</b>
              <span class="mp-meta">根据故事情绪为本章选择合适的背景音乐</span>
            </div>
            <div class="mp-card-actions">
              <button class="btn tiny" data-testid="mp-music-pick" @click="showMusicPicker = !showMusicPicker">
                {{ showMusicPicker ? '收起候选' : '手动换曲' }}
              </button>
            </div>
          </div>

          <div v-if="musicMsg" class="mp-ok" data-testid="mp-music-msg">{{ musicMsg }}</div>

          <div class="mp-music-cur" data-testid="mp-music-current">
            <div class="mp-music-label">当前页配乐 · 第 {{ page?.pageNo }} 页 · 1 段</div>
            <template v-if="music?.current">
              <div class="mp-music-title">{{ music.current.title }}</div>
              <div class="mp-music-author">{{ music.current.author }}</div>
              <div class="mp-music-tags">
                <span v-if="music.current.licenseId" class="mp-tag">{{ music.current.licenseId }}</span>
                <span v-if="music.current.bpm" class="mp-tag">{{ music.current.bpm }} BPM</span>
                <span v-if="music.current.durationSec" class="mp-tag">{{ Math.round(music.current.durationSec) }}s</span>
              </div>
              <audio
                v-if="music.current.url"
                class="mp-audio"
                :src="music.current.url"
                controls
                preload="none"
                data-testid="mp-music-audio"
              ></audio>
              <div class="mp-attribution">{{ music.current.attribution }}</div>
            </template>
            <div v-else class="mp-empty">本章没有配乐数据</div>
          </div>

          <div v-if="showMusicPicker" class="mp-music-pool" data-testid="mp-music-pool">
            <div class="mp-pool-label">候选曲目（来自包内 tracks 池，共 {{ music?.candidates.length ?? 0 }} 首）</div>
            <div
              v-for="c in music?.candidates ?? []"
              :key="c.id || c.url"
              class="mp-pool-item"
              :class="{ on: c.id && c.id === music?.current?.id }"
            >
              <div class="mp-pool-main">
                <div class="mp-pool-title">{{ c.title }}</div>
                <div class="mp-pool-meta">
                  {{ c.author }}
                  <span v-if="c.licenseId"> · {{ c.licenseId }}</span>
                  <span v-if="c.bpm"> · {{ c.bpm }} BPM</span>
                </div>
              </div>
              <button
                class="btn tiny"
                :disabled="savingMusic || (!!c.id && c.id === music?.current?.id)"
                @click="pickMusic(c)"
              >
                {{ c.id && c.id === music?.current?.id ? '使用中' : '换这首' }}
              </button>
            </div>
            <div v-if="!(music?.candidates.length)" class="mp-empty">包内没有候选曲目池</div>
          </div>
        </section>

        <!-- ===== ③ 本页音色 ===== -->
        <section class="mp-card" data-testid="mp-voices">
          <div class="mp-card-head">
            <div class="mp-card-title">
              <span class="mp-ico">🎙</span>
              <b>本页音色</b>
              <span class="mp-meta">仅显示本页人物 · 配置全书共用 · 修改后用于下次配音</span>
            </div>
            <div class="mp-card-actions">
              <span class="mp-count">{{ voices.length }} 个声音</span>
            </div>
          </div>

          <div v-if="voiceMsg" class="mp-ok" data-testid="mp-voice-msg">{{ voiceMsg }}</div>

          <div class="mp-voice-grid">
            <div
              v-for="v in voices"
              :key="v.characterId"
              class="mp-voice"
              :class="{ narrator: v.isNarrator }"
              :data-testid="`mp-voice-${v.characterId}`"
            >
              <div class="mp-voice-head">
                <span class="mp-ico-small">🎙</span>
                <b>{{ v.name }}</b>
                <span v-if="v.isNarrator" class="mp-badge">默认音色</span>
                <span class="mp-voice-count">{{ v.segmentCount }} 段</span>
              </div>

              <div class="mp-field">
                <label>音色</label>
                <input
                  v-if="voiceDraft[v.characterId]"
                  v-model="voiceDraft[v.characterId].vi"
                  class="mp-input"
                  :data-testid="`mp-voice-vi-${v.characterId}`"
                  placeholder="例如：中低音，沉稳，咬字清晰"
                />
              </div>

              <div class="mp-voice-actions">
                <button v-if="v.sampleUrl" class="mp-link" @click="playSample(v)">▷ 试听样本</button>
                <span v-else class="mp-muted">无参考样本</span>
                <button
                  class="mp-link"
                  :disabled="savingVoice === v.characterId"
                  :data-testid="`mp-voice-save-${v.characterId}`"
                  @click="saveVoice(v)"
                >
                  {{ savingVoice === v.characterId ? '保存中…' : '✓ 保存音色' }}
                </button>
              </div>

              <div class="mp-field">
                <label>声音类型</label>
                <select
                  v-if="voiceDraft[v.characterId]"
                  v-model="voiceDraft[v.characterId].vt"
                  class="mp-input"
                  :data-testid="`mp-voice-vt-${v.characterId}`"
                >
                  <option value="">未指定</option>
                  <option value="androgynous">中性音</option>
                  <option value="young_male">青年男声</option>
                  <option value="mature_male">成熟男声</option>
                  <option value="old_male">老年男声</option>
                  <option value="girl">少女音</option>
                  <option value="young_female">青年女声</option>
                  <option value="mature_female">成熟女声</option>
                  <option value="old_female">老年女声</option>
                </select>
              </div>

              <div class="mp-field">
                <label>声音描述</label>
                <textarea
                  v-if="voiceDraft[v.characterId]"
                  v-model="voiceDraft[v.characterId].vi"
                  class="mp-textarea"
                  rows="3"
                  :data-testid="`mp-voice-desc-${v.characterId}`"
                ></textarea>
              </div>
            </div>
            <div v-if="!voices.length" class="mp-empty">本页没有可配音的人物</div>
          </div>
        </section>

        <!-- 概览统计 -->
        <footer v-if="overview" class="mp-foot">
          全书 {{ overview.stats.segmentCount }} 段讲述 · 已有配音 {{ overview.stats.withClip }} 段 ·
          {{ overview.stats.chapterWithMusic }} 章有配乐 · {{ overview.stats.voiceCount }} 个音色档案
        </footer>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 全部使用本软件的琥珀色系变量，不引入截图里的绿色 */
.mp-root {
  position: fixed;
  inset: 0;
  z-index: 58;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--text);
}
.mp-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--muted);
  font-size: 13px;
}
.mp-err-big {
  margin: auto;
  padding: 24px;
  max-width: 560px;
  color: var(--bad);
  font-size: 13px;
  line-height: 1.8;
  text-align: center;
}
.mp-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 18px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-glass);
  backdrop-filter: blur(12px);
}
.mp-head-left {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.mp-title {
  font-size: 14px;
  font-weight: 600;
}
.mp-sub {
  font-size: 11.5px;
  color: var(--faint);
}
.mp-warn {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--warn);
  color: var(--warn);
}
.mp-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 18px 28px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.mp-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-1);
  overflow: hidden;
  /*
   * ⚠️ `flex: none` 不能省。
   *
   * `.mp-body` 是 `display:flex; flex-direction:column`，卡片默认会参与 flex 收缩。
   * 没有这行时，内容多的卡片（讲述与配音）会抢走高度，后面的卡片（背景配乐/本页音色）
   * 被压成只剩卡头高度 —— 正文其实渲染了、但被 `overflow:hidden` 裁掉，
   * 表现就是"只有标题没有内容"，而 DOM 里查内容又查得到（截图前就是这样漏过去的）。
   */
  flex: none;
}
.mp-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
}
.mp-card-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}
.mp-card-title b {
  font-size: 14px;
  font-weight: 600;
}
.mp-ico {
  font-size: 14px;
  color: var(--accent-strong);
}
.mp-ico-small {
  font-size: 11px;
  color: var(--accent-strong);
}
.mp-meta {
  font-size: 11.5px;
  color: var(--faint);
}
.mp-card-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.mp-count {
  font-size: 11.5px;
  color: var(--muted);
}
.mp-ok {
  margin: 0 16px;
  margin-top: 10px;
  padding: 7px 11px;
  border-radius: 7px;
  background: rgba(90, 150, 100, 0.1);
  border: 1px solid rgba(90, 150, 100, 0.35);
  color: #2f7a4a;
  font-size: 11.5px;
  line-height: 1.6;
  word-break: break-all;
}
.mp-err {
  margin: 0 16px;
  margin-top: 10px;
  padding: 7px 11px;
  border-radius: 7px;
  background: rgba(194, 85, 75, 0.1);
  border: 1px solid var(--bad);
  color: var(--bad);
  font-size: 11.5px;
  line-height: 1.6;
  word-break: break-all;
}
.mp-empty {
  padding: 20px;
  text-align: center;
  font-size: 12px;
  color: var(--faint);
}
.mp-muted {
  font-size: 11.5px;
  color: var(--faint);
}

/* ---- 段列表 ---- */
.mp-seg-list {
  padding: 8px 12px 12px;
}
.mp-seg {
  display: flex;
  gap: 11px;
  padding: 9px 10px;
  border-bottom: 1px solid var(--border);
  border-radius: 7px;
  transition: background var(--dur-fast) ease;
}
.mp-seg:last-child {
  border-bottom: 0;
}
.mp-seg:hover {
  background: var(--accent-soft);
}
.mp-seg.playing {
  background: var(--accent-soft);
}
.mp-seg-no {
  flex: none;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--panel-2);
  border: 1px solid var(--border);
  font-size: 10.5px;
  font-weight: 700;
  color: var(--muted);
}
.mp-seg-main {
  flex: 1;
  min-width: 0;
}
.mp-seg-meta {
  display: flex;
  align-items: baseline;
  gap: 7px;
  margin-bottom: 2px;
}
.mp-tag {
  font-size: 9.5px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--text);
}
.mp-speaker {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent-strong);
}
.mp-seg-panel {
  font-size: 10.5px;
  color: var(--faint);
}
.mp-seg-text {
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text);
}
.mp-seg-side {
  flex: none;
  display: flex;
  align-items: center;
  gap: 9px;
}
.mp-dur {
  font-size: 11px;
  color: var(--muted);
  min-width: 38px;
  text-align: right;
}
.mp-noclip {
  font-size: 10.5px;
  color: var(--faint);
}
.mp-btn-play {
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text);
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 999px;
  cursor: pointer;
}
.mp-btn-play:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
}

/* ---- 配乐 ---- */
.mp-music-cur {
  padding: 14px 16px;
}
.mp-music-label {
  font-size: 11px;
  color: var(--faint);
  margin-bottom: 6px;
}
.mp-music-title {
  font-size: 17px;
  font-weight: 600;
  color: var(--text);
}
.mp-music-author {
  font-size: 12px;
  color: var(--muted);
  margin-top: 2px;
}
.mp-music-tags {
  display: flex;
  gap: 6px;
  margin-top: 7px;
  flex-wrap: wrap;
}
.mp-audio {
  width: 100%;
  max-width: 460px;
  margin-top: 10px;
  height: 36px;
}
.mp-attribution {
  margin-top: 8px;
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--faint);
  word-break: break-all;
}
.mp-music-pool {
  border-top: 1px solid var(--border);
  padding: 10px 16px 14px;
  background: var(--panel-2);
}
.mp-pool-label {
  font-size: 11px;
  color: var(--faint);
  margin-bottom: 8px;
}
.mp-pool-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 8px;
  border-radius: 7px;
}
.mp-pool-item:hover {
  background: var(--accent-soft);
}
.mp-pool-item.on {
  background: var(--accent-soft);
}
.mp-pool-main {
  min-width: 0;
}
.mp-pool-title {
  font-size: 12.5px;
  color: var(--text);
}
.mp-pool-meta {
  font-size: 10.5px;
  color: var(--faint);
  margin-top: 1px;
}

/* ---- 音色 ---- */
.mp-voice-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 12px;
  padding: 12px 16px 16px;
}
.mp-voice {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel-2);
  padding: 12px;
}
.mp-voice.narrator {
  border-left: 3px solid var(--accent);
}
.mp-voice-head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.mp-voice-head b {
  font-size: 13.5px;
}
.mp-badge {
  font-size: 9.5px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-ink);
  font-weight: 600;
}
.mp-voice-count {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--faint);
}
.mp-voice-actions {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 8px 0 10px;
}
.mp-link {
  border: 0;
  background: transparent;
  color: var(--accent-strong);
  font-size: 11.5px;
  cursor: pointer;
  padding: 0;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.mp-link:hover {
  color: var(--accent);
}
.mp-link:disabled {
  color: var(--faint);
  cursor: not-allowed;
  text-decoration: none;
}
.mp-field {
  margin-bottom: 9px;
}
.mp-field label {
  display: block;
  font-size: 10.5px;
  color: var(--faint);
  margin-bottom: 4px;
}
.mp-input,
.mp-textarea {
  width: 100%;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--panel);
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
  box-sizing: border-box;
}
.mp-textarea {
  line-height: 1.65;
  resize: vertical;
}
.mp-input:focus,
.mp-textarea:focus {
  outline: none;
  border-color: var(--accent);
}

.mp-foot {
  text-align: center;
  font-size: 11px;
  color: var(--faint);
  padding: 4px 0 10px;
}
</style>

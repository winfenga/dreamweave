<script setup lang="ts">
/**
 * 内置酒馆（简化版 SillyTavern）。
 *
 * 【为什么是「稍微简单一点的酒馆」】用户的判断：世界书本身不复杂，
 * 真正复杂的是**操作 UI 与模型参数**（温度、惩罚这些）。
 * 所以这里的取舍是：
 *   - **参数给全**：温度/top_p/top_k/频率惩罚/存在惩罚/重复惩罚/上限/停止词/种子。
 *     每一项都能真正发到请求里（`null` 表示不发该字段），并且**回显实际发出的 JSON**，
 *     调了没反应时能一眼看出是参数没发出去、还是模型不理；
 *   - **操作简化**：不做分支对话、不做多角色群聊、不做正则重写 —— 那些是酒馆里
 *     最重且与本软件无关的部分。
 *
 * 【会话存哪儿】主进程存到工作库目录，跟书走。换书即换会话，不会串。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type {
  CharacterCard,
  LorebookEntry,
  TavernMessage,
  TavernParams,
  TavernSession,
  TavernSettings
} from '../../../shared/character-card-types'

const props = defineProps<{ card: CharacterCard; lorebook: LorebookEntry[] }>()

// ---- 状态 ----
const messages = ref<TavernMessage[]>([])
const input = ref('')
const generating = ref(false)
const errorMsg = ref('')
const settings = ref<TavernSettings | null>(null)
const params = ref<TavernParams>({
  temperature: 0.85,
  topP: 0.95,
  topK: null,
  frequencyPenalty: 0.2,
  presencePenalty: 0.2,
  repetitionPenalty: null,
  maxTokens: 800,
  stop: [],
  seed: null
})
const useLorebook = ref(true)
const showParams = ref(false)
const showDebug = ref(false)
/** 最近一次的请求体回显与命中详情 */
const lastUsed = ref<Record<string, unknown> | null>(null)
const lastHits = ref<string[]>([])
const listEl = ref<HTMLElement | null>(null)

const cardName = computed(() => props.card.name)

let seq = 0
function newId(): string {
  seq++
  return `m${Date.now()}-${seq}`
}

async function scrollToBottom(): Promise<void> {
  await nextTick()
  const el = listEl.value
  if (el) el.scrollTop = el.scrollHeight
}

/** 载入：设置 + 已有会话 + 若空则放开场白 */
async function init(): Promise<void> {
  const s = await window.dreamweave.tavernGetSettings()
  settings.value = s
  if (s) {
    params.value = { ...s.params }
    useLorebook.value = s.useLorebook
  }
  const r = await window.dreamweave.cardGet(props.card.id)
  const session: TavernSession | null = r.session ?? null
  if (session?.messages?.length) {
    messages.value = session.messages
  } else {
    messages.value = [
      {
        id: newId(),
        role: 'assistant',
        content: props.card.firstMes || `（${cardName.value} 看着你，等你开口。）`,
        speakerId: props.card.id,
        speakerName: cardName.value,
        at: Date.now()
      }
    ]
  }
  void scrollToBottom()
}

watch(
  () => props.card.id,
  () => {
    void init()
  }
)

onMounted(() => {
  void init()
})

async function persist(): Promise<void> {
  try {
    await window.dreamweave.tavernSaveSession(props.card.id, messages.value, null)
  } catch {
    /* 保存失败不该打断对话 */
  }
}

async function send(): Promise<void> {
  const text = input.value.trim()
  if (!text || generating.value) return
  errorMsg.value = ''
  input.value = ''

  const userMsg: TavernMessage = { id: newId(), role: 'user', content: text, at: Date.now() }
  messages.value.push(userMsg)
  await scrollToBottom()
  generating.value = true

  try {
    const r = await window.dreamweave.tavernGenerate({
      cardId: props.card.id,
      messages: messages.value,
      params: params.value,
      useLorebook: useLorebook.value
    })
    lastUsed.value = r.usedParams ?? null
    lastHits.value = r.loreHits ?? []
    if (!r.ok || !r.content) {
      errorMsg.value = r.error ?? '生成失败'
      return
    }
    messages.value.push({
      id: newId(),
      role: 'assistant',
      content: r.content,
      speakerId: props.card.id,
      speakerName: cardName.value,
      loreHits: r.loreHits,
      at: Date.now()
    })
    await persist()
    await scrollToBottom()
  } catch (e) {
    errorMsg.value = (e as Error).message
  } finally {
    generating.value = false
  }
}

/** 重新生成最后一条角色回复 */
async function regenerate(): Promise<void> {
  if (generating.value) return
  // 从末尾往前找最后一条 assistant 并移除它（保留 user 输入）
  for (let i = messages.value.length - 1; i >= 0; i--) {
    if (messages.value[i].role === 'assistant') {
      messages.value.splice(i, 1)
      break
    }
  }
  // 最后一条若是开场白之外就重发
  const lastUser = [...messages.value].reverse().find((m) => m.role === 'user')
  if (!lastUser) {
    // 没有用户输入 → 直接根据开场白重问一次
    messages.value.push({ id: newId(), role: 'user', content: '（继续）', at: Date.now() })
  }
  generating.value = true
  errorMsg.value = ''
  try {
    const r = await window.dreamweave.tavernGenerate({
      cardId: props.card.id,
      messages: messages.value,
      params: params.value,
      useLorebook: useLorebook.value
    })
    lastUsed.value = r.usedParams ?? null
    lastHits.value = r.loreHits ?? []
    if (!r.ok || !r.content) {
      errorMsg.value = r.error ?? '生成失败'
      return
    }
    messages.value.push({
      id: newId(),
      role: 'assistant',
      content: r.content,
      speakerId: props.card.id,
      speakerName: cardName.value,
      loreHits: r.loreHits,
      at: Date.now()
    })
    await persist()
    await scrollToBottom()
  } catch (e) {
    errorMsg.value = (e as Error).message
  } finally {
    generating.value = false
  }
}

async function resetChat(): Promise<void> {
  messages.value = [
    {
      id: newId(),
      role: 'assistant',
      content: props.card.firstMes || `（${cardName.value} 看着你，等你开口。）`,
      speakerId: props.card.id,
      speakerName: cardName.value,
      at: Date.now()
    }
  ]
  errorMsg.value = ''
  await persist()
}

async function saveParams(): Promise<void> {
  const next: TavernSettings = {
    params: params.value,
    useLorebook: useLorebook.value,
    lorebookLimit: settings.value?.lorebookLimit ?? 6,
    historyLimit: settings.value?.historyLimit ?? 12,
    replyCount: settings.value?.replyCount ?? 1
  }
  settings.value = next
  await window.dreamweave.tavernSaveSettings(next)
}

/** 滑杆值 ↔ null 语义：用户拖动即生效；有个单独的「默认」勾选可以置回 null（不发该字段） */
const nullFlags = ref<Record<string, boolean>>({})
function toggleNull(key: keyof TavernParams): void {
  nullFlags.value[key] = !nullFlags.value[key]
  if (nullFlags.value[key]) {
    ;(params.value as unknown as Record<string, unknown>)[key] = null
  } else {
    ;(params.value as unknown as Record<string, unknown>)[key] = 0
  }
}
function isNull(key: keyof TavernParams): boolean {
  return params.value[key] === null
}

function onKeydown(e: KeyboardEvent): void {
  // Enter 发送，Shift+Enter 换行
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void send()
  }
}

/** 停止词编辑（每行一个） */
const stopText = computed({
  get: () => (params.value.stop ?? []).join('\n'),
  set: (v: string) => {
    params.value.stop = v.split('\n').filter((s) => s.length > 0)
  }
})
</script>

<template>
  <div class="tv-root" data-testid="tavern">
    <!-- 顶栏 -->
    <header class="tv-head">
      <div class="tv-head-left">
        <span class="tv-title">{{ cardName }}</span>
        <span class="tv-sub">{{ messages.filter((m) => m.role === 'user').length }} 轮对话</span>
      </div>
      <div class="tv-head-right">
        <button class="btn tiny" data-testid="tv-toggle-params" @click="showParams = !showParams">
          {{ showParams ? '收起参数' : '⚙ 模型参数' }}
        </button>
        <button class="btn tiny" data-testid="tv-toggle-debug" @click="showDebug = !showDebug">调试</button>
        <button class="btn tiny" data-testid="tv-reset" @click="resetChat">重开</button>
      </div>
    </header>

    <!-- 参数抽屉 -->
    <div v-if="showParams" class="tv-params" data-testid="tv-params">
      <div class="tv-params-grid">
        <label class="tv-p">
          <span class="tv-p-label">
            温度 temperature
            <b class="tv-p-val" :class="{ muted: isNull('temperature') }">
              {{ isNull('temperature') ? '默认（不发送）' : params.temperature }}
            </b>
          </span>
          <input
            :disabled="isNull('temperature')"
            :value="params.temperature ?? 0.85"
            type="range"
            min="0"
            max="2"
            step="0.05"
            data-testid="p-temperature"
            @input="params.temperature = Number(($event.target as HTMLInputElement).value)"
          />
          <button class="tv-null" :class="{ on: isNull('temperature') }" @click="toggleNull('temperature')">
            {{ isNull('temperature') ? '恢复默认值' : '用模型默认' }}
          </button>
        </label>

        <label class="tv-p">
          <span class="tv-p-label">
            top_p
            <b class="tv-p-val" :class="{ muted: isNull('topP') }">
              {{ isNull('topP') ? '默认（不发送）' : params.topP }}
            </b>
          </span>
          <input
            :disabled="isNull('topP')"
            :value="params.topP ?? 0.95"
            type="range"
            min="0"
            max="1"
            step="0.01"
            @input="params.topP = Number(($event.target as HTMLInputElement).value)"
          />
          <button class="tv-null" :class="{ on: isNull('topP') }" @click="toggleNull('topP')">
            {{ isNull('topP') ? '恢复默认值' : '用模型默认' }}
          </button>
        </label>

        <label class="tv-p">
          <span class="tv-p-label">
            频率惩罚
            <b class="tv-p-val" :class="{ muted: isNull('frequencyPenalty') }">
              {{ isNull('frequencyPenalty') ? '默认（不发送）' : params.frequencyPenalty }}
            </b>
          </span>
          <input
            :disabled="isNull('frequencyPenalty')"
            :value="params.frequencyPenalty ?? 0"
            type="range"
            min="-2"
            max="2"
            step="0.05"
            @input="params.frequencyPenalty = Number(($event.target as HTMLInputElement).value)"
          />
          <button class="tv-null" :class="{ on: isNull('frequencyPenalty') }" @click="toggleNull('frequencyPenalty')">
            {{ isNull('frequencyPenalty') ? '恢复默认值' : '用模型默认' }}
          </button>
        </label>

        <label class="tv-p">
          <span class="tv-p-label">
            存在惩罚
            <b class="tv-p-val" :class="{ muted: isNull('presencePenalty') }">
              {{ isNull('presencePenalty') ? '默认（不发送）' : params.presencePenalty }}
            </b>
          </span>
          <input
            :disabled="isNull('presencePenalty')"
            :value="params.presencePenalty ?? 0"
            type="range"
            min="-2"
            max="2"
            step="0.05"
            @input="params.presencePenalty = Number(($event.target as HTMLInputElement).value)"
          />
          <button class="tv-null" :class="{ on: isNull('presencePenalty') }" @click="toggleNull('presencePenalty')">
            {{ isNull('presencePenalty') ? '恢复默认值' : '用模型默认' }}
          </button>
        </label>

        <label class="tv-p">
          <span class="tv-p-label">
            重复惩罚
            <b class="tv-p-val" :class="{ muted: isNull('repetitionPenalty') }">
              {{ isNull('repetitionPenalty') ? '默认（不发送）' : params.repetitionPenalty }}
            </b>
          </span>
          <input
            :disabled="isNull('repetitionPenalty')"
            :value="params.repetitionPenalty ?? 1"
            type="range"
            min="0.5"
            max="2"
            step="0.05"
            @input="params.repetitionPenalty = Number(($event.target as HTMLInputElement).value)"
          />
          <button class="tv-null" :class="{ on: isNull('repetitionPenalty') }" @click="toggleNull('repetitionPenalty')">
            {{ isNull('repetitionPenalty') ? '恢复默认值' : '用模型默认' }}
          </button>
        </label>

        <label class="tv-p">
          <span class="tv-p-label">
            top_k
            <b class="tv-p-val" :class="{ muted: isNull('topK') }">
              {{ isNull('topK') ? '默认（不发送）' : params.topK }}
            </b>
          </span>
          <input
            :disabled="isNull('topK')"
            :value="params.topK ?? 40"
            type="range"
            min="0"
            max="200"
            step="1"
          />
          <button class="tv-null" :class="{ on: isNull('topK') }" @click="toggleNull('topK')">
            {{ isNull('topK') ? '恢复默认值' : '用模型默认' }}
          </button>
        </label>
      </div>

      <div class="tv-params-row">
        <label class="tv-inline">
          <span>输出上限</span>
          <input v-model.number="params.maxTokens" type="number" min="64" max="8192" step="64" class="tv-num" />
        </label>
        <label class="tv-inline">
          <span>种子</span>
          <input
            :value="params.seed ?? ''"
            type="number"
            placeholder="随机"
            class="tv-num"
            @input="params.seed = ($event.target as HTMLInputElement).value === '' ? null : Number(($event.target as HTMLInputElement).value)"
          />
        </label>
        <label class="tv-inline">
          <input v-model="useLorebook" type="checkbox" data-testid="p-lorebook" />
          <span>注入世界书</span>
        </label>
        <button class="btn tiny" data-testid="p-save" @click="saveParams">保存为默认</button>
      </div>

      <label class="tv-stop">
        <span>停止词（每行一个；以换行开头有意义，不会被去掉）</span>
        <textarea v-model="stopText" rows="2" placeholder="例：&#10;用户："></textarea>
      </label>

      <p class="tv-tip">
        「用模型默认」= **不发送该字段**；把滑杆拖到 0 是显式发送 0（确定性贪心解码），两者语义不同。
      </p>
    </div>

    <!-- 消息列表 -->
    <div ref="listEl" class="tv-list" data-testid="tv-list">
      <div
        v-for="m in messages"
        :key="m.id"
        class="tv-msg"
        :class="m.role === 'user' ? 'is-user' : 'is-char'"
      >
        <div class="tv-msg-who">{{ m.role === 'user' ? '你' : m.speakerName || cardName }}</div>
        <div class="tv-msg-body">{{ m.content }}</div>
        <div v-if="showDebug && m.loreHits?.length" class="tv-msg-debug">
          命中世界书：{{ m.loreHits.join('、') }}
        </div>
      </div>
      <div v-if="generating" class="tv-typing">{{ cardName }} 正在输入…</div>
    </div>

    <!-- 错误 -->
    <div v-if="errorMsg" class="tv-err" data-testid="tv-error">{{ errorMsg }}</div>

    <!-- 调试面板 -->
    <div v-if="showDebug && lastUsed" class="tv-debug" data-testid="tv-debug">
      <div class="tv-debug-head">
        <b>上次实际发送的请求体</b>
        <span class="tv-debug-hits">命中 {{ lastHits.length }} 条世界书</span>
      </div>
      <pre class="tv-debug-body">{{ JSON.stringify(lastUsed, null, 1) }}</pre>
    </div>

    <!-- 输入区 -->
    <footer class="tv-input">
      <textarea
        v-model="input"
        class="tv-textarea"
        data-testid="tv-input"
        rows="2"
        placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"
        :disabled="generating"
        @keydown="onKeydown"
      ></textarea>
      <div class="tv-input-side">
        <button class="btn" :disabled="generating || !input.trim()" data-testid="tv-send" @click="send">
          {{ generating ? '生成中…' : '发送' }}
        </button>
        <button class="btn tiny" :disabled="generating" data-testid="tv-regen" @click="regenerate">重新生成</button>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.tv-root {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--panel);
  overflow: hidden;
}
.tv-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
}
.tv-head-left {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.tv-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
}
.tv-sub {
  font-size: 11px;
  color: var(--faint);
}
.tv-head-right {
  display: flex;
  gap: 6px;
  flex: none;
}

/* 参数区 */
.tv-params {
  flex: none;
  max-height: 46%;
  overflow-y: auto;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
}
.tv-params-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 10px 16px;
}
.tv-p {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.tv-p-label {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
  font-size: 11.5px;
  color: var(--muted);
}
.tv-p-val {
  font-size: 11.5px;
  color: var(--text);
  font-weight: 600;
}
.tv-p-val.muted {
  color: var(--faint);
  font-weight: 400;
}
.tv-p input[type='range'] {
  width: 100%;
  accent-color: var(--accent);
}
.tv-null {
  align-self: flex-start;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--muted);
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  cursor: pointer;
}
.tv-null.on {
  background: var(--accent-soft);
  color: var(--text);
  border-color: var(--accent);
}
.tv-params-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}
.tv-inline {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--muted);
}
.tv-num {
  width: 88px;
  padding: 3px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  font-size: 11.5px;
}
.tv-stop {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 9px;
  font-size: 11.5px;
  color: var(--muted);
}
.tv-stop textarea {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  font-size: 11.5px;
  font-family: inherit;
  resize: vertical;
}
.tv-tip {
  margin: 8px 0 0;
  font-size: 10.5px;
  line-height: 1.7;
  color: var(--faint);
}

/* 消息 */
.tv-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.tv-msg {
  max-width: 82%;
  padding: 9px 12px;
  border-radius: 12px;
  background: var(--panel-2);
  border: 1px solid var(--border);
}
.tv-msg.is-user {
  align-self: flex-end;
  background: var(--accent-soft);
  border-color: var(--accent);
}
.tv-msg.is-char {
  align-self: flex-start;
}
.tv-msg-who {
  font-size: 10.5px;
  font-weight: 700;
  color: var(--accent-strong);
  margin-bottom: 3px;
}
.tv-msg-body {
  font-size: 13px;
  line-height: 1.85;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}
.tv-msg-debug {
  margin-top: 4px;
  font-size: 10px;
  color: var(--faint);
}
.tv-typing {
  align-self: flex-start;
  font-size: 11.5px;
  color: var(--faint);
  padding: 4px 10px;
}
.tv-err {
  flex: none;
  margin: 0 12px 8px;
  padding: 7px 10px;
  border-radius: 7px;
  background: rgba(194, 85, 75, 0.1);
  border: 1px solid var(--bad);
  color: var(--bad);
  font-size: 11.5px;
  line-height: 1.6;
}
.tv-debug {
  flex: none;
  max-height: 24%;
  overflow-y: auto;
  margin: 0 12px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-2);
}
.tv-debug-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  color: var(--muted);
}
.tv-debug-hits {
  color: var(--faint);
}
.tv-debug-body {
  margin: 0;
  padding: 8px 10px;
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--muted);
  white-space: pre-wrap;
  word-break: break-all;
  font-family: Consolas, monospace;
}

/* 输入 */
.tv-input {
  flex: none;
  display: flex;
  gap: 10px;
  padding: 10px 12px;
  border-top: 1px solid var(--border);
  background: var(--panel-2);
}
.tv-textarea {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  color: var(--text);
  font-size: 12.5px;
  font-family: inherit;
  line-height: 1.7;
  resize: none;
}
.tv-input-side {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: none;
}
</style>

<script setup lang="ts">
/**
 * 通用「多组接入配置」编辑器（LLM 与 TTS 共用）。
 *
 * 由 `kind` + 若干开关控制差异，所有增删改/选「当前使用」/逐行探活/模型探测/失败切换顺序
 * 逻辑**只写一处**：
 * - `kind='llm'`：显示「检测连接」+「探测模型」+ 供应商类型 + 失败切换顺序；不显示音色。
 * - `kind='tts'`：显示音色 + 「检测连接」（**用 /audio/speech 探**，见 providers.ts 说明）。
 *
 * 【两种测试的分工，别混】
 *   - **检测连接**（probeProvider）：用已填 model 真发一次请求 → 「这组现在能跑吗」；
 *   - **探测模型**（listModels）：GET /models 列模型 → 「这个端点有哪些模型可选」。
 * 填 model 之前探活必然失败，那时恰恰最需要看模型名单，所以两个都要有。
 *
 * 持久化：组件**自持状态**，每次结构变更即落盘；落盘前**重新读取**全量 provider 设置、
 * 只覆盖自己的那一侧（llm 或 tts），因此**绝不会清空/覆盖另一侧**。
 * fail 时本地回滚，保持界面与磁盘一致。
 *
 * testid 约定：`<prefix>-row-<id>` / `<prefix>-active-<id>` / `<prefix>-probe-<id>` /
 * `<prefix>-probe-result-<id>` / `<prefix>-models-<id>` / `<prefix>-models-result-<id>` /
 * `<prefix>-edit-<id>` / `<prefix>-del-<id>` / `<prefix>-add` / `<prefix>-form(-*)`
 */
import { computed, onMounted, ref } from 'vue'
import type { LlmProvider, TtsProvider } from '../../../shared/pipeline-types'

const props = withDefaults(
  defineProps<{
    /** 编辑哪一种配置 */
    kind: 'llm' | 'tts'
    /** 区块标题 */
    heading: string
    /** 标题下方说明（可空） */
    hint?: string
    /** testid 前缀（'llm' | 'tts'） */
    testidPrefix: string
    /** 是否显示「检测连接」按钮（llm/tts 都显示；tts 走 /audio/speech 探） */
    showProbe?: boolean
    /** 是否显示「探测模型」按钮（只有 LLM 有意义：TTS 端点通常不提供 /models） */
    showModels?: boolean
    /** 是否显示音色字段（tts=true） */
    showVoice?: boolean
    /** 是否显示供应商类型（llm=true） */
    showProviderKind?: boolean
    /** 是否显示「失败切换顺序」区块（llm=true） */
    showChain?: boolean
    /** 新增按钮文案 */
    addLabel?: string
    /** 空列表提示 */
    emptyHint?: string
  }>(),
  {
    hint: '',
    showProbe: false,
    showModels: false,
    showVoice: false,
    showProviderKind: false,
    showChain: false,
    addLabel: '+ 新增配置',
    emptyHint: '（还没有任何配置，点下方「+ 新增配置」）'
  }
)

const isLlm = computed(() => props.kind === 'llm')

/** 行数据用 TtsProvider（LlmProvider 的超集；llm 行 voice 恒为 ''，界面隐藏） */
const rows = ref<TtsProvider[]>([])
const activeId = ref('')
const chain = ref<string[]>([])
const loading = ref(true)
const error = ref('')

/** 供应商类型建议项（providerKind 为自由字符串，决定输出上限字段：minimax/mimo → max_completion_tokens） */
const PROVIDER_KINDS = ['custom', 'openai', 'deepseek', 'glm', 'qwen', 'minimax', 'mimo']

// —— 新增 / 编辑表单 ——
interface FormState {
  id: string | null
  label: string
  baseURL: string
  apiKey: string
  model: string
  providerKind: string
  voice: string
}
const form = ref<FormState | null>(null)
const formError = ref('')

// —— 每行「检测连接」结果（按 id 独立，互不覆盖）——
interface ProbeState {
  state: 'idle' | 'loading' | 'ok' | 'err'
  text: string
}
const probeStates = ref<Record<string, ProbeState>>({})
const probeOf = (id: string): ProbeState => probeStates.value[id] ?? { state: 'idle', text: '' }
const setProbe = (id: string, next: ProbeState): void => {
  probeStates.value = { ...probeStates.value, [id]: next }
}

/**
 * 每行「探测模型」结果。
 *
 * `models` 非空时界面渲染成可点的芯片：点一下直接把该模型名填进对应配置，
 * 免得用户手抄长模型名（实测有 `buddy:deepseek-v4.1-flash` 这种，手抄必错）。
 */
interface ModelsState {
  state: 'idle' | 'loading' | 'ok' | 'err'
  text: string
  models: string[]
  owners: Record<string, string>
}
const EMPTY_MODELS: ModelsState = { state: 'idle', text: '', models: [], owners: {} }
const modelsStates = ref<Record<string, ModelsState>>({})
const modelsOf = (id: string): ModelsState => modelsStates.value[id] ?? EMPTY_MODELS
const setModels = (id: string, next: ModelsState): void => {
  modelsStates.value = { ...modelsStates.value, [id]: next }
}

/** 探测模型并列出候选（不需要先填 model） */
async function listModelsOfRow(p: TtsProvider): Promise<void> {
  if (modelsOf(p.id).state === 'loading') return
  if (!p.baseURL.trim()) {
    setModels(p.id, { state: 'err', text: '请先填 Base URL', models: [], owners: {} })
    return
  }
  setModels(p.id, { state: 'loading', text: '探测中…', models: [], owners: {} })
  try {
    const r = await window.dreamweave.listModels({ id: p.id })
    if (r.ok && r.models?.length) {
      const owners = r.owners ?? {}
      const ownerCount = new Set(Object.values(owners).filter(Boolean)).size
      const time = r.ms ? ` · ${r.ms} ms` : ''
      const ownerText = ownerCount > 1 ? ` · ${ownerCount} 个归属` : ''
      setModels(p.id, {
        state: 'ok',
        text: `✅ 发现 ${r.models.length} 个模型${ownerText}${time}`,
        models: r.models,
        owners
      })
    } else {
      setModels(p.id, { state: 'err', text: `❌ ${r.error ?? '未发现任何模型'}`, models: [], owners: {} })
    }
  } catch (e) {
    setModels(p.id, { state: 'err', text: `❌ ${(e as Error).message}`, models: [], owners: {} })
  }
}

/** 一键把探测到的模型名填进该行配置（手抄长模型名容易错） */
async function useModel(p: TtsProvider, model: string): Promise<void> {
  const prev = snapshot()
  p.model = model
  setModels(p.id, { ...modelsOf(p.id), text: `已填入模型：${model}` })
  const r = await persist()
  if (!r.ok) {
    error.value = r.error ?? '保存失败'
    restore(prev)
    return
  }
  // 模型变了 → 旧的探活结论已失效，清掉避免误导
  setProbe(p.id, { state: 'idle', text: '' })
}

/**
 * 表单里的模型探测：直接拿**还没保存**的 baseURL/apiKey 去问，
 * 于是「先填地址→探测→挑模型→保存」是顺畅的一条线，不必先保存一次再看。
 */
const formModels = ref<ModelsState>(EMPTY_MODELS)

async function listModelsForForm(): Promise<void> {
  const f = form.value
  if (!f) return
  if (formModels.value.state === 'loading') return
  if (!f.baseURL.trim()) {
    formModels.value = { state: 'err', text: '请先填 Base URL', models: [], owners: {} }
    return
  }
  formModels.value = { state: 'loading', text: '探测中…', models: [], owners: {} }
  try {
    const r = await window.dreamweave.listModels({ baseURL: f.baseURL.trim(), apiKey: f.apiKey })
    if (r.ok && r.models?.length) {
      const owners = r.owners ?? {}
      const time = r.ms ? ` · ${r.ms} ms` : ''
      formModels.value = {
        state: 'ok',
        text: `✅ 发现 ${r.models.length} 个模型${time}`,
        models: r.models,
        owners
      }
    } else {
      formModels.value = { state: 'err', text: `❌ ${r.error ?? '未发现任何模型'}`, models: [], owners: {} }
    }
  } catch (e) {
    formModels.value = { state: 'err', text: `❌ ${(e as Error).message}`, models: [], owners: {} }
  }
}

/** 配置是否"未填完整"（baseURL/model 任一为空 → 不可用） */
const incomplete = (p: LlmProvider): boolean => !p.baseURL.trim() || !p.model.trim()

/** 可加入失败切换顺序的候选（启用、非当前、不在链中） */
const chainCandidates = computed(() =>
  rows.value.filter((p) => p.enabled && p.id !== activeId.value && !chain.value.includes(p.id))
)
const labelOf = (id: string): string => rows.value.find((p) => p.id === id)?.label || id

onMounted(() => void load())

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const ps = await window.dreamweave.getProviders()
    const list = (isLlm.value ? ps.llm : ps.tts) as TtsProvider[]
    rows.value = list.map((p) => ({ ...p, voice: p.voice ?? '' }))
    activeId.value = isLlm.value ? ps.activeLlmId : ps.activeTtsId
    chain.value = [...(ps.fallbackChain ?? [])]
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

/** llm 侧 payload：只取 LlmProvider 字段（去掉 voice） */
function llmPayload(): LlmProvider[] {
  return rows.value.map(({ id, label, baseURL, apiKey, model, enabled, providerKind }) => ({
    id,
    label,
    baseURL,
    apiKey,
    model,
    enabled,
    providerKind
  }))
}
/** tts 侧 payload：含 voice */
function ttsPayload(): TtsProvider[] {
  return rows.value.map(({ id, label, baseURL, apiKey, model, enabled, providerKind, voice }) => ({
    id,
    label,
    baseURL,
    apiKey,
    model,
    enabled,
    providerKind,
    voice
  }))
}

/** 覆盖式保存：**重新读取**另一侧后原样带回，避免清空；只改动本组件负责的那一侧。 */
async function persist(): Promise<{ ok: boolean; error?: string }> {
  const ps = await window.dreamweave.getProviders()
  return window.dreamweave.saveProviders({
    llm: isLlm.value ? llmPayload() : ps.llm,
    tts: isLlm.value ? ps.tts : ttsPayload(),
    activeLlmId: isLlm.value ? activeId.value : ps.activeLlmId,
    activeTtsId: isLlm.value ? ps.activeTtsId : activeId.value,
    fallbackChain: isLlm.value ? [...chain.value] : ps.fallbackChain
  })
}

// —— 快照 / 回滚 ——
interface Snapshot {
  rows: TtsProvider[]
  activeId: string
  chain: string[]
}
const snapshot = (): Snapshot => ({ rows: rows.value.map((p) => ({ ...p })), activeId: activeId.value, chain: [...chain.value] })
function restore(s: Snapshot): void {
  rows.value = s.rows
  activeId.value = s.activeId
  chain.value = s.chain
}

function newId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `p-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

// ---------------------------------------------------------------- 增删改
function startAdd(): void {
  form.value = { id: null, label: '', baseURL: '', apiKey: '', model: '', providerKind: 'custom', voice: '' }
  formError.value = ''
  formModels.value = EMPTY_MODELS
}
function startEdit(p: TtsProvider): void {
  form.value = {
    id: p.id,
    label: p.label,
    baseURL: p.baseURL,
    apiKey: p.apiKey,
    model: p.model,
    providerKind: p.providerKind ?? 'custom',
    voice: p.voice ?? ''
  }
  formError.value = ''
  formModels.value = EMPTY_MODELS
}
function cancelForm(): void {
  form.value = null
  formError.value = ''
  formModels.value = EMPTY_MODELS
}

/** 提交表单：先本地套用再落盘；主进程会用 validateBaseURL 复校（renderer 无法直用主进程校验） */
async function submitForm(): Promise<void> {
  const f = form.value
  if (!f) return
  formError.value = ''
  const prev = snapshot()
  const existing = f.id ? rows.value.find((p) => p.id === f.id) : undefined
  const entry: TtsProvider = {
    id: f.id ?? newId(),
    label: f.label.trim() || f.model.trim() || '新配置',
    baseURL: f.baseURL.trim(),
    apiKey: f.apiKey,
    model: f.model.trim(),
    enabled: existing ? existing.enabled : true,
    providerKind: f.providerKind || 'custom',
    voice: f.voice
  }
  if (f.id) {
    const i = rows.value.findIndex((p) => p.id === f.id)
    if (i >= 0) rows.value[i] = entry
    else rows.value.push(entry)
  } else {
    rows.value.push(entry)
  }
  const r = await persist()
  if (!r.ok) {
    formError.value = r.error ?? '保存失败'
    restore(prev)
    return
  }
  form.value = null
}

async function delRow(p: TtsProvider): Promise<void> {
  const prev = snapshot()
  rows.value = rows.value.filter((x) => x.id !== p.id)
  chain.value = chain.value.filter((id) => id !== p.id)
  if (activeId.value === p.id) activeId.value = rows.value[0]?.id ?? ''
  const r = await persist()
  if (!r.ok) {
    error.value = r.error ?? '删除失败'
    restore(prev)
  }
}

async function setActive(p: TtsProvider): Promise<void> {
  const prev = snapshot()
  activeId.value = p.id
  chain.value = chain.value.filter((id) => id !== p.id)
  const r = await persist()
  if (!r.ok) {
    error.value = r.error ?? '保存失败'
    restore(prev)
  }
}

async function toggleEnabled(p: TtsProvider): Promise<void> {
  const prev = snapshot()
  p.enabled = !p.enabled
  // 当前使用项被停用：仍保留 active 指向（主进程 activeProvider 会回退到首个启用项）
  const r = await persist()
  if (!r.ok) {
    error.value = r.error ?? '保存失败'
    restore(prev)
  }
}

// ---------------------------------------------------------------- 失败切换顺序（仅 llm）
function chainMove(i: number, dir: -1 | 1): void {
  const j = i + dir
  if (j < 0 || j >= chain.value.length) return
  const prev = snapshot()
  const arr = [...chain.value]
  const tmp = arr[i]
  arr[i] = arr[j]
  arr[j] = tmp
  chain.value = arr
  void saveChain(prev)
}
function chainRemove(i: number): void {
  const prev = snapshot()
  chain.value = chain.value.filter((_, k) => k !== i)
  void saveChain(prev)
}
function chainAdd(id: string): void {
  if (!id || chain.value.includes(id) || id === activeId.value) return
  const prev = snapshot()
  chain.value = [...chain.value, id]
  void saveChain(prev)
}
async function saveChain(prev: Snapshot): Promise<void> {
  const r = await persist()
  if (!r.ok) {
    error.value = r.error ?? '保存失败'
    restore(prev)
  }
}

// ---------------------------------------------------------------- 检测连接（仅 llm）
async function probeRow(p: TtsProvider): Promise<void> {
  if (!props.showProbe) return
  if (probeOf(p.id).state === 'loading') return
  if (incomplete(p)) {
    setProbe(p.id, { state: 'err', text: '未填完整，不可用' })
    return
  }
  setProbe(p.id, { state: 'loading', text: '检测中…（最坏约 2 分钟）' })
  // 先把当前列表落盘，保证探活读取的是你眼前这份配置（probeProvider 读磁盘上的 provider）
  const savedRes = await persist()
  if (!savedRes.ok) {
    setProbe(p.id, { state: 'err', text: `保存失败：${savedRes.error ?? '未知'}` })
    return
  }
  try {
    const r = await window.dreamweave.probeProvider(p.id)
    if (r.ok) {
      setProbe(p.id, { state: 'ok', text: `✅ 可连接 · ${r.httpStatus ?? '—'} · ${r.ms ?? 0} ms` })
    } else {
      setProbe(p.id, { state: 'err', text: `❌ 不可连接 · ${r.error ?? '未知原因'}` })
    }
  } catch (e) {
    setProbe(p.id, { state: 'err', text: `❌ 不可连接 · ${(e as Error).message}` })
  }
}
</script>

<template>
  <div class="provider-editor">
    <h2>{{ heading }}</h2>
    <p v-if="hint" class="hint" style="margin-top: -4px; margin-bottom: 14px">{{ hint }}</p>

    <!-- 列表 -->
    <div v-if="rows.length" class="p-row p-head">
      <span class="c-active">当前使用</span>
      <span class="c-name">名称</span>
      <span class="c-url">Base URL</span>
      <span class="c-model">模型</span>
      <span class="c-kind">{{ showProviderKind ? '供应商' : '音色' }}</span>
      <span class="c-enable">启用</span>
      <span class="c-ops">操作</span>
    </div>
    <div
      v-for="p in rows"
      :key="p.id"
      class="p-row"
      :data-testid="testidPrefix + '-row-' + p.id"
      :class="{ 'p-bad': incomplete(p) }"
    >
      <span class="c-active">
        <input
          type="radio"
          :name="'active-' + kind"
          :value="p.id"
          :checked="activeId === p.id"
          :data-testid="testidPrefix + '-active-' + p.id"
          @change="setActive(p)"
        />
      </span>
      <span class="c-name">
        {{ p.label || '(未命名)' }}
        <span v-if="incomplete(p)" class="badge-bad">未填完整，不可用</span>
      </span>
      <span class="c-url">{{ p.baseURL || '—' }}</span>
      <span class="c-model">{{ p.model || '—' }}</span>
      <span class="c-kind">{{ showProviderKind ? p.providerKind || 'custom' : p.voice || 'alloy' }}</span>
      <span class="c-enable">
        <input type="checkbox" :checked="p.enabled" @change="toggleEnabled(p)" />
      </span>
      <span class="c-ops">
        <button
          v-if="showProbe"
          class="btn"
          :data-testid="testidPrefix + '-probe-' + p.id"
          :disabled="probeOf(p.id).state === 'loading' || incomplete(p)"
          :title="incomplete(p) ? '未填完整，不可用' : '发送一次最小请求验证连通性'"
          @click="probeRow(p)"
        >
          {{ probeOf(p.id).state === 'loading' ? '检测中…' : '检测连接' }}
        </button>
        <button
          v-if="showModels"
          class="btn"
          :data-testid="testidPrefix + '-models-' + p.id"
          :disabled="modelsOf(p.id).state === 'loading' || !p.baseURL.trim()"
          :title="!p.baseURL.trim() ? '请先填 Base URL' : 'GET /models 列出该端点可用模型（不需要已填模型名）'"
          @click="listModelsOfRow(p)"
        >
          {{ modelsOf(p.id).state === 'loading' ? '探测中…' : '探测模型' }}
        </button>
        <button class="btn" :data-testid="testidPrefix + '-edit-' + p.id" @click="startEdit(p)">编辑</button>
        <button class="btn" :data-testid="testidPrefix + '-del-' + p.id" @click="delRow(p)">删除</button>
      </span>
      <span
        v-if="probeOf(p.id).text"
        class="probe"
        :class="{
          'probe-ok': probeOf(p.id).state === 'ok',
          'probe-err': probeOf(p.id).state === 'err',
          'probe-loading': probeOf(p.id).state === 'loading'
        }"
        :data-testid="testidPrefix + '-probe-result-' + p.id"
      >
        {{ probeOf(p.id).text }}
      </span>
      <span
        v-if="modelsOf(p.id).text"
        class="probe"
        :class="{
          'probe-ok': modelsOf(p.id).state === 'ok',
          'probe-err': modelsOf(p.id).state === 'err',
          'probe-loading': modelsOf(p.id).state === 'loading'
        }"
        :data-testid="testidPrefix + '-models-result-' + p.id"
      >
        {{ modelsOf(p.id).text }}
        <!-- 候选模型：点一下直接填入，免得手抄长模型名出错 -->
        <span v-if="modelsOf(p.id).models.length" class="model-chips" :data-testid="testidPrefix + '-models-list-' + p.id">
          <button
            v-for="m in modelsOf(p.id).models"
            :key="m"
            class="model-chip"
            :class="{ 'model-chip-on': p.model === m }"
            :title="modelsOf(p.id).owners[m] ? `${m} · ${modelsOf(p.id).owners[m]}` : m"
            :data-testid="testidPrefix + '-model-chip-' + p.id + '-' + m"
            @click="useModel(p, m)"
          >
            {{ m }}
          </button>
        </span>
      </span>
    </div>
    <div v-if="!rows.length && !loading" class="hint">{{ emptyHint }}</div>

    <div style="margin-top: 10px">
      <button v-if="!form" class="btn primary" :data-testid="testidPrefix + '-add'" @click="startAdd">
        {{ addLabel }}
      </button>
    </div>

    <!-- 新增 / 编辑表单 -->
    <div v-if="form" class="p-form" :data-testid="testidPrefix + '-form'">
      <div class="field">
        <label>名称（label）</label>
        <input
          v-model="form.label"
          placeholder="如：本地 · auto"
          spellcheck="false"
          :data-testid="testidPrefix + '-form-label'"
        />
      </div>
      <div class="field">
        <label>Base URL</label>
        <input
          v-model="form.baseURL"
          placeholder="https://your-endpoint.example.com/v1"
          spellcheck="false"
          :data-testid="testidPrefix + '-form-baseurl'"
        />
      </div>
      <div class="field">
        <label>API Key</label>
        <input
          v-model="form.apiKey"
          type="password"
          placeholder="sk-..."
          spellcheck="false"
          :data-testid="testidPrefix + '-form-apikey'"
        />
      </div>
      <div class="field">
        <label>模型（model）</label>
        <div style="display: flex; gap: 8px; align-items: center">
          <input
            v-model="form.model"
            placeholder="如：auto"
            spellcheck="false"
            style="flex: 1"
            :data-testid="testidPrefix + '-form-model'"
          />
          <!-- 表单里也能探测：填 model 之前先看这个端点有哪些可选 -->
          <button
            v-if="showModels"
            class="btn"
            :data-testid="testidPrefix + '-form-models'"
            :disabled="formModels.state === 'loading' || !form.baseURL.trim()"
            :title="!form.baseURL.trim() ? '请先填 Base URL' : 'GET /models 列出可用模型'"
            @click="listModelsForForm"
          >
            {{ formModels.state === 'loading' ? '探测中…' : '探测模型' }}
          </button>
        </div>
        <div
          v-if="formModels.text"
          class="probe"
          :class="{
            'probe-ok': formModels.state === 'ok',
            'probe-err': formModels.state === 'err',
            'probe-loading': formModels.state === 'loading'
          }"
          :data-testid="testidPrefix + '-form-models-result'"
        >
          {{ formModels.text }}
          <span v-if="formModels.models.length" class="model-chips" :data-testid="testidPrefix + '-form-models-list'">
            <button
              v-for="m in formModels.models"
              :key="m"
              class="model-chip"
              :class="{ 'model-chip-on': form.model === m }"
              :title="formModels.owners[m] ? `${m} · ${formModels.owners[m]}` : m"
              @click="form.model = m"
            >
              {{ m }}
            </button>
          </span>
        </div>
      </div>
      <div v-if="showVoice" class="field">
        <label>音色（voice）</label>
        <input v-model="form.voice" placeholder="留空则用端点默认音色，如 alloy" spellcheck="false" :data-testid="testidPrefix + '-form-voice'" />
      </div>
      <div v-if="showProviderKind" class="field">
        <label>
          供应商类型（providerKind）
          <span class="hint"> minimax/mimo → max_completion_tokens，其它 → max_tokens</span>
        </label>
        <input
          v-model="form.providerKind"
          :list="testidPrefix + '-pk-opts'"
          spellcheck="false"
          :data-testid="testidPrefix + '-form-kind'"
        />
        <datalist :id="testidPrefix + '-pk-opts'">
          <option v-for="k in PROVIDER_KINDS" :key="k" :value="k" />
        </datalist>
      </div>
      <div v-if="formError" class="error" :data-testid="testidPrefix + '-form-error'">{{ formError }}</div>
      <div style="display: flex; gap: 10px">
        <button class="btn primary" :data-testid="testidPrefix + '-form-save'" @click="submitForm">保存该配置</button>
        <button class="btn" @click="cancelForm">取消</button>
      </div>
    </div>

    <!-- 失败切换顺序（仅 LLM） -->
    <template v-if="showChain">
      <h2 style="margin-top: 22px">失败切换顺序（fallbackChain）</h2>
      <p class="hint" style="margin-top: -4px; margin-bottom: 8px">主配置失败时按此顺序换用；留空则仅在启用项之间轮询。</p>
      <div class="chain">
        <span class="chain-chip chain-head">{{ labelOf(activeId) || '（未选当前）' }}（当前）</span>
        <span v-for="(id, i) in chain" :key="id" class="chain-chip">
          {{ i + 1 }}. {{ labelOf(id) }}
          <button class="mini" :disabled="i === 0" title="上移" @click="chainMove(i, -1)">↑</button>
          <button class="mini" :disabled="i === chain.length - 1" title="下移" @click="chainMove(i, 1)">↓</button>
          <button class="mini" title="移除" @click="chainRemove(i)">✕</button>
        </span>
        <span v-if="!chain.length" class="hint">（空）</span>
      </div>
      <div v-if="chainCandidates.length" style="margin-top: 8px">
        <select
          class="select"
          @change="chainAdd(($event.target as HTMLSelectElement).value); ($event.target as HTMLSelectElement).selectedIndex = 0"
        >
          <option value="">+ 加入顺序…</option>
          <option v-for="c in chainCandidates" :key="c.id" :value="c.id">{{ c.label || c.id }}</option>
        </select>
      </div>
    </template>

    <div v-if="error" class="error" style="margin-top: 8px">{{ error }}</div>
  </div>
</template>

<style scoped>
.p-row {
  display: grid;
  grid-template-columns: 68px 1.2fr 2fr 1fr 0.9fr 46px 1.6fr;
  gap: 8px;
  align-items: center;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 6px;
  font-size: 12px;
}

.p-head {
  border: none;
  color: var(--muted);
  font-weight: 600;
  padding-bottom: 0;
}

.p-bad {
  border-color: rgba(194, 85, 75, 0.55);
}

.c-url,
.c-model {
  word-break: break-all;
  color: var(--muted);
}

.c-ops {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.badge-bad {
  margin-left: 6px;
  font-size: 11px;
  color: var(--bad);
}

.probe {
  grid-column: 1 / -1;
  font-size: 12px;
}
.probe-ok {
  color: #2f6b40;
}
.probe-err {
  color: var(--bad);
}
.probe-loading {
  color: var(--muted);
}

/* 候选模型芯片：一行放不下就换行，不撑破行网格 */
.model-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 6px;
}

.model-chip {
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel-2);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px;
  line-height: 1.6;
  cursor: pointer;
  transition:
    border-color var(--dur-fast) ease,
    background var(--dur-fast) ease;
}

.model-chip:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.model-chip-on {
  border-color: var(--accent-strong);
  background: var(--accent-soft);
  font-weight: 700;
}

.p-form {
  margin-top: 10px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-2);
}

.chain {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.chain-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 12px;
  background: var(--panel-2);
}

.chain-head {
  opacity: 0.75;
}

.mini {
  border: 1px solid var(--border);
  background: transparent;
  color: inherit;
  border-radius: 4px;
  cursor: pointer;
  line-height: 1;
  padding: 1px 4px;
}

.mini:disabled {
  opacity: 0.35;
  cursor: default;
}
</style>

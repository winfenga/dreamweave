<script setup lang="ts">
/**
 * 设置面板（批2）：
 * - **模型接入** 与 **配音接入** 均改为通用 `ProviderListEditor`（增删改/选「当前使用」/逐行探活/失败切换顺序）：
 *   两份配置共用同一套 UI 逻辑，以后改 UI 只改一处。
 * - LLM：唯一真源 `llm[] + activeLlmId + fallbackChain`；每行「检测连接」（异步、加载禁点、按行独立）。
 * - TTS：唯一真源 `tts[] + activeTtsId`；含音色；**不做**「检测连接」（本机聚合服务不支持 /audio/speech）。
 * - 「试听」按钮保留，走当前「配音接入」选中的配置（`speak()` 取 `activeProvider('tts')`）。
 * - 音频 / 演出参数保持原样，仍经 `settings:save` 落盘。
 * - 旧单组字段 `ttsVoice` 不再由本面板编辑（仅主进程侧幂等迁移为一条 legacy 配音），避免历史数据丢失。
 */
import { onMounted, ref } from 'vue'
import { COMMON_LEVELS } from '../lib/stageColors'
import ProviderListEditor from './ProviderListEditor.vue'
import {
  CHAR_TEMPLATE_HINT,
  DEFAULT_CHAR_PROMPT_TEMPLATE,
  DEFAULT_ICON_PROMPT_TEMPLATE,
  DEFAULT_NEGATIVE_PROMPT,
  DEFAULT_SCENE_NEGATIVE_PROMPT,
  DEFAULT_SCENE_PROMPT_TEMPLATE,
  DEFAULT_WORKFLOW_JSON,
  ICON_TEMPLATE_HINT,
  SCENE_TEMPLATE_HINT,
  WORKFLOW_HINT
} from '../../../shared/imagegen-defaults'

const emit = defineEmits<{ close: []; saved: [] }>()

// —— 音频 / 演出参数（保持原样）——
const voiceVolume = ref(0.9)
const bgmPath = ref('')
const bgmVolume = ref(0.35)
const stageZoom = ref(1)
const dialogMode = ref<'normal' | 'transparent'>('normal')
const autoplayPolicy = ref<'dubbing' | 'tts' | 'timer'>('dubbing')
const roleColors = ref<Record<string, string>>({})

const saved = ref(false)
const error = ref('')
const ttsState = ref('')
const bgmState = ref('')

// —— 生图（ComfyUI）——
const comfyBaseUrl = ref('http://127.0.0.1:8188')
const comfyModel = ref('')
const comfyWidth = ref(832)
const comfyHeight = ref(1216)
const comfySteps = ref(20)
const comfyCfg = ref(4)
const comfyNegative = ref('')
const comfyCharTpl = ref('')
const comfyIconTpl = ref('')
const comfySceneTpl = ref('')
/** D2：场景专用负面词（与人物那份相反） */
const comfySceneNegative = ref('')
/** B：画风预设 */
const comfyCharArtPreset = ref<'anime' | 'realistic' | 'custom'>('anime')
const comfyCharArtCustom = ref('')
const comfySceneArtPreset = ref<'anime' | 'custom'>('anime')
const comfySceneArtCustom = ref('')
/** C2：LLM 提示词改写 */
const comfyRewriteEnabled = ref(false)
const comfyRewriteTarget = ref<'qwen-image-2.1' | 'moss-image' | 'generic'>('qwen-image-2.1')
const comfyWorkflow = ref('')
const comfyProbeState = ref('')
const comfyProbing = ref(false)

const LLM_HINT =
  '「当前使用」的那组会被解析链路与「✨AI 推荐特效」使用；失败时按「失败切换顺序」依次换用。' +
  '点某行「检测连接」可验证该组是否可用（最坏约 2 分钟）。Base URL 不要包含 /chat/completions（调用时自动追加）。'
const TTS_HINT =
  '配音（兜底音源）：仅当「自动播放音源」选 TTS、或你主动点「试听」时，才会调用当前「配音接入」选中的那组。' +
  '结果按 sha256(文本+音色+模型) 缓存到本地，重复台词不重复合成。'

onMounted(() => void loadAll())

async function loadAll(): Promise<void> {
  const s = await window.feather.getSettings()
  voiceVolume.value = s.voiceVolume
  bgmPath.value = s.bgmPath
  bgmVolume.value = s.bgmVolume
  stageZoom.value = s.stageZoom
  dialogMode.value = s.dialogMode
  autoplayPolicy.value = s.autoplayPolicy
  roleColors.value = { ...s.roleColors }
  const c = s.comfyui
  comfyBaseUrl.value = c.baseUrl
  comfyModel.value = c.model
  comfyWidth.value = c.width
  comfyHeight.value = c.height
  comfySteps.value = c.steps
  comfyCfg.value = c.cfg
  comfyNegative.value = c.negativePrompt
  comfyCharTpl.value = c.charPromptTemplate
  comfyIconTpl.value = c.iconPromptTemplate
  comfySceneTpl.value = c.scenePromptTemplate ?? DEFAULT_SCENE_PROMPT_TEMPLATE
  comfySceneNegative.value = c.sceneNegativePrompt ?? DEFAULT_SCENE_NEGATIVE_PROMPT
  comfyCharArtPreset.value = c.charArtStylePreset ?? 'anime'
  comfyCharArtCustom.value = c.charArtStyleCustom ?? ''
  comfySceneArtPreset.value = c.sceneArtStylePreset ?? 'anime'
  comfySceneArtCustom.value = c.sceneArtStyleCustom ?? ''
  comfyRewriteEnabled.value = c.promptRewriteEnabled === true
  comfyRewriteTarget.value = c.promptRewriteTarget ?? 'qwen-image-2.1'
  comfyWorkflow.value = c.workflowJson
}

// ---------------------------------------------------------------- 生图（ComfyUI）
async function probeComfy(): Promise<void> {
  comfyProbing.value = true
  comfyProbeState.value = '探活中…'
  try {
    const res = await window.feather.imagegenProbe()
    comfyProbeState.value = res.ok ? res.info ?? '已就绪' : res.error ?? '探活失败'
  } catch (e) {
    comfyProbeState.value = (e as Error).message
  } finally {
    comfyProbing.value = false
  }
}

/** 校验工作流 JSON：JSON 合法 + 必须含 {{prompt}} 占位（可读错误，不允许保存）。 */
function validateComfyWorkflow(): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(comfyWorkflow.value)
  } catch (e) {
    return `工作流 JSON 解析失败：${(e as Error).message}`
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '工作流 JSON 必须是一个对象'
  if (!comfyWorkflow.value.includes('{{prompt}}')) return '工作流 JSON 中未找到 {{prompt}} 占位符'
  return ''
}

// ---------------------------------------------------------------- 音频 / 试听
async function pickBgm(): Promise<void> {
  bgmState.value = ''
  const res = await window.feather.pickBgm()
  if (res.canceled) return
  if (!res.ok || !res.filePath) {
    bgmState.value = res.error ?? '选择失败'
    return
  }
  bgmPath.value = res.filePath
  bgmState.value = `已就绪：${res.url}`
}

function clearBgm(): void {
  bgmPath.value = ''
  bgmState.value = '已清除（保存后生效）'
}

async function testTts(): Promise<void> {
  ttsState.value = '合成中…'
  // 不传 voice → speak() 用当前「配音接入」选中的那组的 voice（拿不到则由端点默认）
  const res = await window.feather.speak('StageView 配音试听。这是一段用于验证音频链路的文本。')
  if (!res.ok || !res.url) {
    ttsState.value = res.error ?? '合成失败'
    return
  }
  ttsState.value = `${res.cached ? '缓存命中' : '已合成'} ${res.bytes ?? 0} 字节，播放中…`
  const a = new Audio(res.url)
  a.volume = voiceVolume.value
  void a.play().catch((e: unknown) => {
    ttsState.value = `播放失败：${(e as Error)?.message ?? e}`
  })
  a.addEventListener('ended', () => {
    ttsState.value = '播放完毕'
  })
}

// ---------------------------------------------------------------- 保存（音频/演出参数）
async function save(): Promise<void> {
  saved.value = false
  error.value = ''
  // 工作流 JSON 先本地校验（失败给可读错误，不允许保存）
  const wfErr = validateComfyWorkflow()
  if (wfErr) {
    error.value = wfErr
    return
  }
  // 多组配置由各自的 ProviderListEditor 在每次变更时即时落盘；此处保存演出/音频/生图参数。
  const res = await window.feather.saveSettings({
    voiceVolume: voiceVolume.value,
    bgmPath: bgmPath.value,
    bgmVolume: bgmVolume.value,
    stageZoom: stageZoom.value,
    dialogMode: dialogMode.value,
    autoplayPolicy: autoplayPolicy.value,
    // Vue 3.5：ref 对象值会包 reactive 代理，直接传会撞结构化克隆，必须展开成普通对象
    roleColors: { ...roleColors.value },
    comfyui: {
      baseUrl: comfyBaseUrl.value.trim() || 'http://127.0.0.1:8188',
      model: comfyModel.value,
      width: Number(comfyWidth.value) || 832,
      height: Number(comfyHeight.value) || 1216,
      steps: Number(comfySteps.value) || 20,
      cfg: Number(comfyCfg.value) || 4,
      negativePrompt: comfyNegative.value,
      charPromptTemplate: comfyCharTpl.value,
      iconPromptTemplate: comfyIconTpl.value,
      scenePromptTemplate: comfySceneTpl.value,
      sceneNegativePrompt: comfySceneNegative.value,
      charArtStylePreset: comfyCharArtPreset.value,
      charArtStyleCustom: comfyCharArtCustom.value,
      sceneArtStylePreset: comfySceneArtPreset.value,
      sceneArtStyleCustom: comfySceneArtCustom.value,
      promptRewriteEnabled: comfyRewriteEnabled.value,
      promptRewriteTarget: comfyRewriteTarget.value,
      workflowJson: comfyWorkflow.value
    }
  })
  if (!res.ok) {
    error.value = res.error ?? '保存失败'
    return
  }
  saved.value = true
  emit('saved')
  await loadAll()
}
</script>

<template>
  <div class="card">
    <ProviderListEditor
      kind="llm"
      testid-prefix="llm"
      heading="模型接入（多组配置）"
      :hint="LLM_HINT"
      add-label="+ 新增配置"
      :show-probe="true"
      :show-provider-kind="true"
      :show-chain="true"
    />

    <ProviderListEditor
      kind="tts"
      testid-prefix="tts"
      heading="配音接入（多组配置）"
      :hint="TTS_HINT"
      add-label="+ 新增配音配置"
      empty-hint="（还没有配音配置；本机聚合服务通常不支持 /audio/speech，如需可自行添加其它端点）"
      :show-voice="true"
    />

    <h2 style="margin-top: 22px">配音试听</h2>
    <div style="display: flex; gap: 10px; align-items: center; margin-bottom: 8px">
      <button class="btn" data-testid="tts-test" @click="testTts">🔊 试听 TTS</button>
      <span v-if="ttsState" class="hint" data-testid="tts-state">{{ ttsState }}</span>
    </div>

    <h2 style="margin-top: 22px">音频</h2>
    <div class="field">
      <label>语音音量 <span class="hint">{{ Math.round(voiceVolume * 100) }}%</span></label>
      <input v-model.number="voiceVolume" type="range" min="0" max="1" step="0.05" data-testid="voice-volume" />
    </div>
    <div class="field">
      <label>BGM 音量 <span class="hint">{{ Math.round(bgmVolume * 100) }}%</span></label>
      <input v-model.number="bgmVolume" type="range" min="0" max="1" step="0.05" data-testid="bgm-volume" />
    </div>
    <div class="field">
      <label>背景音乐（本地文件，循环播放）</label>
      <div style="display: flex; gap: 8px; align-items: center">
        <input :value="bgmPath" placeholder="未选择" readonly style="flex: 1" data-testid="bgm-path" />
        <button class="btn" data-testid="bgm-pick" @click="pickBgm">选择…</button>
        <button class="btn" data-testid="bgm-clear" @click="clearBgm">清除</button>
      </div>
      <div v-if="bgmState" class="hint" data-testid="bgm-state">{{ bgmState }}</div>
    </div>

    <h2 style="margin-top: 22px">演出</h2>
    <div class="field">
      <label>舞台缩放 <span class="hint">{{ stageZoom.toFixed(2) }}×（0.70 ~ 1.60）</span></label>
      <input v-model.number="stageZoom" type="range" min="0.7" max="1.6" step="0.05" data-testid="stage-zoom" />
    </div>
    <div class="field">
      <label>对话框模式</label>
      <select v-model="dialogMode" class="select" data-testid="dialog-mode">
        <option value="normal">常规（不透明底）</option>
        <option value="transparent">透明（低遮挡，看立绘用）</option>
      </select>
    </div>
    <div class="field">
      <label>自动播放音源</label>
      <select v-model="autoplayPolicy" class="select" data-testid="autoplay-policy">
        <option value="dubbing">包内配音优先（无配音则定时器）</option>
        <option value="tts">TTS 合成优先（未配置则回退配音/定时器）</option>
        <option value="timer">只用定时器（不播放任何音频）</option>
      </select>
    </div>
    <div class="field">
      <label>角色名牌配色（按 importanceLevel）</label>
      <div class="color-row">
        <span v-for="lv in COMMON_LEVELS" :key="lv" class="color-cell">
          <input
            type="color"
            :value="roleColors[lv]"
            :data-testid="'color-' + lv"
            @input="roleColors = { ...roleColors, [lv]: ($event.target as HTMLInputElement).value }"
          />
          <small>{{ lv }}</small>
        </span>
      </div>
      <div class="hint">分级取值随包而异（还可能出现 TEMP 等），未预设的级别自动用兜底色。</div>
    </div>

    <h2 style="margin-top: 22px">生图（ComfyUI）</h2>
    <div class="hint" style="margin-bottom: 8px">
      用本地 ComfyUI 生成人物立绘、场景图与地图地点图标（出图模型建议 Qwen-Image）。
      生成入口在「概览」页的任务面板下方。此处未配置好之前不要点生成。
    </div>
    <div class="field">
      <label>ComfyUI 服务地址</label>
      <div style="display: flex; gap: 8px; align-items: center">
        <input v-model="comfyBaseUrl" placeholder="http://127.0.0.1:8188" spellcheck="false" style="flex: 1" data-testid="comfy-base-url" />
        <button class="btn" data-testid="comfy-probe" :disabled="comfyProbing" @click="probeComfy">检测连接</button>
      </div>
      <div v-if="comfyProbeState" class="hint" data-testid="comfy-probe-state">{{ comfyProbeState }}</div>
    </div>
    <div class="field">
      <label>出图模型名（ckpt_name）</label>
      <input v-model="comfyModel" placeholder="留空 = 用工作流 JSON 里写死的模型" spellcheck="false" data-testid="comfy-model" />
      <div class="hint">非空时替换工作流里的 <span v-pre>{{model}}</span> 占位；工作流没写该占位则不改模型名。</div>
    </div>
    <div class="field" style="display: flex; gap: 12px; flex-wrap: wrap">
      <span>宽度 <input v-model.number="comfyWidth" type="number" min="64" max="4096" step="64" style="width: 90px" data-testid="comfy-width" /></span>
      <span>高度 <input v-model.number="comfyHeight" type="number" min="64" max="4096" step="64" style="width: 90px" data-testid="comfy-height" /></span>
      <span>步数 <input v-model.number="comfySteps" type="number" min="1" max="100" style="width: 80px" data-testid="comfy-steps" /></span>
      <span>CFG <input v-model.number="comfyCfg" type="number" min="1" max="30" step="0.5" style="width: 80px" data-testid="comfy-cfg" /></span>
    </div>
    <div class="field">
      <label>人物/图标负面提示词（要求透明背景）</label>
      <textarea v-model="comfyNegative" rows="3" data-testid="comfy-negative" style="width: 100%; font-family: ui-monospace, SFMono-Regular, Consolas, monospace" />
      <div class="hint">用于人物立绘与地图图标。已压制「背景 / 白色背景 / 白边」，确保出图为透明底。</div>
      <div style="margin-top: 4px">
        <button class="btn" data-testid="comfy-negative-reset" @click="comfyNegative = DEFAULT_NEGATIVE_PROMPT">恢复默认</button>
      </div>
    </div>
    <div class="field">
      <label>场景图负面提示词（要求背景充实）</label>
      <textarea v-model="comfySceneNegative" rows="3" data-testid="comfy-scene-negative" style="width: 100%; font-family: ui-monospace, SFMono-Regular, Consolas, monospace" />
      <div class="hint">
        用于场景背景图。与上面那份**相反**：压制「空白背景 / 透明背景」，并要求不含人物。
        两者对背景的要求互斥，不能共用一份。
      </div>
      <div style="margin-top: 4px">
        <button class="btn" data-testid="comfy-scene-negative-reset" @click="comfySceneNegative = DEFAULT_SCENE_NEGATIVE_PROMPT">恢复默认</button>
      </div>
    </div>
    <div class="field">
      <label>人物画风预设</label>
      <select v-model="comfyCharArtPreset" data-testid="comfy-char-art-preset" style="width: 100%">
        <option value="anime">精致二次元立绘（默认）</option>
        <option value="realistic">电影质感真人</option>
        <option value="custom">自定义</option>
      </select>
      <div v-if="comfyCharArtPreset === 'custom'" style="margin-top: 6px">
        <textarea v-model="comfyCharArtCustom" rows="6" data-testid="comfy-char-art-custom" placeholder="填写自定义画风文本（作为 {{artStyle}} 注入人物模板）" style="width: 100%; font-family: ui-monospace, SFMono-Regular, Consolas, monospace" />
      </div>
      <div class="hint">
        包内自带 <code>:character-art-style</code> 时**以包内为准**，此处预设仅作缺省兜底
        （避免与包内画风重复两遍）。
      </div>
    </div>
    <div class="field">
      <label>场景画风预设</label>
      <select v-model="comfySceneArtPreset" data-testid="comfy-scene-art-preset" style="width: 100%">
        <option value="anime">日式手绘动画背景（默认）</option>
        <option value="custom">自定义</option>
      </select>
      <div v-if="comfySceneArtPreset === 'custom'" style="margin-top: 6px">
        <textarea v-model="comfySceneArtCustom" rows="6" data-testid="comfy-scene-art-custom" placeholder="填写自定义画风文本（作为 {{artStyle}} 注入场景模板）" style="width: 100%; font-family: ui-monospace, SFMono-Regular, Consolas, monospace" />
      </div>
    </div>
    <div class="field">
      <label>
        <input v-model="comfyRewriteEnabled" type="checkbox" data-testid="comfy-rewrite-enabled" />
        启用 LLM 提示词改写
      </label>
      <div class="hint">
        开启后，模板拼出的结构化描述会先交给 LLM 按目标模型规范重写，再送 ComfyUI。
        改写失败会自动回落原模板输出，不会中断出图。
        <b>需要先在「模型接入」里配置好一组 LLM。</b>
      </div>
      <div style="margin-top: 6px">
        <label style="display: block; margin-bottom: 4px">目标模型</label>
        <select v-model="comfyRewriteTarget" data-testid="comfy-rewrite-target" style="width: 100%">
          <option value="qwen-image-2.1">Qwen-Image 2.1（400–500 词英文观察式描述 + 宽高比）</option>
          <option value="moss-image">MOSS-Image（英文自然语言或 tag 串）</option>
          <option value="generic">通用 / SD 系（75 token 内标签串）</option>
        </select>
      </div>
    </div>
    <div class="field">
      <label>人物立绘提示词模板（多行）</label>
      <textarea v-model="comfyCharTpl" rows="8" data-testid="comfy-char-tpl" style="width: 100%; font-family: ui-monospace, SFMono-Regular, Consolas, monospace" />
      <div class="hint">{{ CHAR_TEMPLATE_HINT }}</div>
      <div style="margin-top: 4px">
        <button class="btn" data-testid="comfy-char-tpl-reset" @click="comfyCharTpl = DEFAULT_CHAR_PROMPT_TEMPLATE">恢复默认</button>
      </div>
    </div>
    <div class="field">
      <label>地图图标提示词模板（多行）</label>
      <textarea v-model="comfyIconTpl" rows="6" data-testid="comfy-icon-tpl" style="width: 100%; font-family: ui-monospace, SFMono-Regular, Consolas, monospace" />
      <div class="hint">{{ ICON_TEMPLATE_HINT }}</div>
      <div style="margin-top: 4px">
        <button class="btn" data-testid="comfy-icon-tpl-reset" @click="comfyIconTpl = DEFAULT_ICON_PROMPT_TEMPLATE">恢复默认</button>
      </div>
    </div>
    <div class="field">
      <label>场景背景图提示词模板（多行）</label>
      <textarea v-model="comfySceneTpl" rows="8" data-testid="comfy-scene-tpl" style="width: 100%; font-family: ui-monospace, SFMono-Regular, Consolas, monospace" />
      <div class="hint">{{ SCENE_TEMPLATE_HINT }}</div>
      <div style="margin-top: 4px">
        <button class="btn" data-testid="comfy-scene-tpl-reset" @click="comfySceneTpl = DEFAULT_SCENE_PROMPT_TEMPLATE">恢复默认</button>
      </div>
    </div>
    <div class="field">
      <label>ComfyUI 工作流 JSON（API 格式，多行）</label>
      <textarea v-model="comfyWorkflow" rows="12" data-testid="comfy-workflow" style="width: 100%; font-family: ui-monospace, SFMono-Regular, Consolas, monospace" spellcheck="false" />
      <div class="hint">{{ WORKFLOW_HINT }}</div>
      <div style="margin-top: 4px; display: flex; gap: 8px">
        <button class="btn" data-testid="comfy-workflow-reset" @click="comfyWorkflow = DEFAULT_WORKFLOW_JSON">恢复默认</button>
        <button class="btn" @click="error = validateComfyWorkflow() || '工作流 JSON 校验通过'">校验</button>
      </div>
    </div>

    <div v-if="error" class="error" style="margin-bottom: 10px">{{ error }}</div>
    <div style="display: flex; gap: 10px; align-items: center">
      <button class="btn primary" data-testid="settings-save" @click="save">保存</button>
      <button class="btn" data-testid="settings-close" @click="emit('close')">关闭</button>
      <span v-if="saved" class="hint" data-testid="settings-saved">已保存</span>
    </div>
  </div>
</template>

<style scoped>
.color-row {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}

.color-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  color: var(--muted);
}

.color-cell input[type='color'] {
  width: 34px;
  height: 26px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-2);
  padding: 2px;
  cursor: pointer;
}
</style>

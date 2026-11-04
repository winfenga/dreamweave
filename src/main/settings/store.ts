import { app } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ComfyuiSettings, ModelSettings } from '../../shared/app-types'
import type { LlmProvider, TtsProvider } from '../../shared/pipeline-types'
import { DEFAULT_ROLE_COLORS } from '../../shared/app-types'
import { defaultComfyuiSettings } from '../../shared/imagegen-defaults'

/**
 * 设置存储：多组模型接入（任意 OpenAI 兼容，不绑定供应商）+ 本地演出/音频参数。
 *
 * 所有字段都有默认值；loadSettings 会做一次清洗（夹紧音量/缩放、校验枚举、补全配色、
 * 清洗/迁移多配置），因此旧版本写下的 settings.json 或缺字段都能安全读入。
 *
 * 旧单组字段 `baseURL/apiKey/model/ttsVoice` **保留只读兼容**：
 * 新装（无 llm[]）时 `llm[]` 由旧字段迁移为一条 `{id:'legacy'}`（有旧凭据）或预置三条（全新安装）；
 * `tts[]` 同理迁移旧 `ttsVoice`（追加一条 `{id:'legacy'}`），但**不预置**（本机服务不支持 TTS）。
 */
export type { ModelSettings } from '../../shared/app-types'

/** 预置三条本地 provider（便于演示切换；active = local-auto）。 */
export const PRESET_LLM: LlmProvider[] = [
  {
    id: 'local-auto',
    label: '本地 · auto',
    baseURL: 'http://127.0.0.1:31415/v1',
    apiKey: 'freellmapi-310a1428ef96d50d6d20ece910d68d21dd12915db5e8e63d',
    model: 'auto',
    enabled: true,
    providerKind: 'custom'
  },
  {
    id: 'local-fusion',
    label: '本地 · fusion',
    baseURL: 'http://127.0.0.1:31415/v1',
    apiKey: 'freellmapi-310a1428ef96d50d6d20ece910d68d21dd12915db5e8e63d',
    model: 'fusion',
    enabled: true,
    providerKind: 'custom'
  },
  {
    id: 'local-glm',
    label: '本地 · glm-5.3',
    baseURL: 'http://127.0.0.1:31415/v1',
    apiKey: 'freellmapi-310a1428ef96d50d6d20ece910d68d21dd12915db5e8e63d',
    model: 'glm-5.3',
    enabled: true,
    providerKind: 'custom'
  }
]

function presetClone(): LlmProvider[] {
  return PRESET_LLM.map((p) => ({ ...p }))
}

export const DEFAULT_SETTINGS: ModelSettings = {
  baseURL: '',
  apiKey: '',
  model: '',
  ttsVoice: '',
  voiceVolume: 0.9,
  bgmPath: '',
  bgmVolume: 0.35,
  stageZoom: 1,
  dialogMode: 'normal',
  autoplayPolicy: 'dubbing',
  roleColors: { ...DEFAULT_ROLE_COLORS },
  llm: presetClone(),
  tts: [],
  activeLlmId: 'local-auto',
  activeTtsId: '',
  fallbackChain: ['local-fusion', 'local-glm'],
  comfyui: defaultComfyuiSettings()
}

const ZOOM_MIN = 0.7
const ZOOM_MAX = 1.6
const ZOOM_STEP = 0.05

function clamp(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 把缩放夹到 [0.7, 1.6] 并对齐到 0.05 步进（避免 0.7000000000000001 之类） */
export function normalizeZoom(v: unknown): number {
  const c = clamp(v, ZOOM_MIN, ZOOM_MAX, DEFAULT_SETTINGS.stageZoom)
  const snapped = Math.round((c - ZOOM_MIN) / ZOOM_STEP) * ZOOM_STEP + ZOOM_MIN
  return Math.round((snapped + Number.EPSILON) * 100) / 100
}

/** 清洗一条 provider（缺 id → null）。 */
function sanitizeProvider(raw: unknown): LlmProvider | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : ''
  if (!id) return null
  return {
    id,
    label: typeof o.label === 'string' && o.label ? o.label : id,
    baseURL: typeof o.baseURL === 'string' ? o.baseURL : '',
    apiKey: typeof o.apiKey === 'string' ? o.apiKey : '',
    model: typeof o.model === 'string' ? o.model : '',
    enabled: o.enabled === false ? false : true,
    providerKind: typeof o.providerKind === 'string' && o.providerKind ? o.providerKind : 'custom'
  }
}

function sanitizeTts(raw: unknown): TtsProvider | null {
  const base = sanitizeProvider(raw)
  if (!base) return null
  const o = raw as Record<string, unknown>
  return { ...base, voice: typeof o.voice === 'string' ? o.voice : '' }
}

/** 按 id 去重（保首现序）。 */
function dedupeProviders<T extends { id: string }>(list: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const p of list) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    out.push(p)
  }
  return out
}

/** 读入时清洗：缺字段补默认、越界夹紧、非法枚举回落、配色补全、多配置清洗/迁移。 */
export function sanitizeSettings(raw: Partial<ModelSettings> | null | undefined): ModelSettings {
  const s = raw ?? {}
  const roleColors: Record<string, string> = { ...DEFAULT_ROLE_COLORS }
  for (const [k, v] of Object.entries(s.roleColors ?? {})) {
    if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) roleColors[k] = v.toLowerCase()
  }
  const dialogMode = s.dialogMode === 'transparent' ? 'transparent' : 'normal'
  const policy =
    s.autoplayPolicy === 'tts' || s.autoplayPolicy === 'timer' ? s.autoplayPolicy : 'dubbing'

  const legacyBase = typeof s.baseURL === 'string' ? s.baseURL : ''
  const legacyKey = typeof s.apiKey === 'string' ? s.apiKey : ''
  const legacyModel = typeof s.model === 'string' ? s.model : ''
  const legacyVoice = typeof s.ttsVoice === 'string' ? s.ttsVoice : ''

  // ---- LLM 多配置 ----
  // 读取清洗 + 旧字段一次性迁移（设计要求：不丢用户配置、幂等、不擅自改 active）：
  //   ① 无 llm[]（旧版本 settings）+ 旧三框有值 → 建 1 条 {id:'legacy'}（P5 既有口径，llm.length===1）；
  //   ② 无 llm[] + 旧三框全空 → 预置三条（全新安装，既有点；verify-pipeline/qa 断言 llm.length===3）；
  //   ③ 已有 llm[]（新版本）→ **追加式迁移**：旧三框有值且 llm[] 中**不存在**「baseURL+model 相同」项时补一条 legacy，
  //      **绝不覆盖/删除**用户已有多组配置；命中「baseURL+model 相同」即视为已迁移 → 连续 load 不再重复追加（幂等）。
  let llm: LlmProvider[]
  const legacyNonNull = !!(legacyBase || legacyKey || legacyModel)
  if (Array.isArray(s.llm)) {
    llm = dedupeProviders((s.llm as unknown[]).map(sanitizeProvider).filter((x): x is LlmProvider => !!x))
    if (legacyNonNull) {
      const alreadyMigrated = llm.some(
        (p) => p.id === 'legacy' || (p.baseURL === legacyBase && p.model === legacyModel)
      )
      if (!alreadyMigrated) {
        llm = [
          ...llm,
          {
            id: 'legacy',
            label: legacyModel ? `旧配置 · ${legacyModel}` : '旧配置',
            baseURL: legacyBase,
            apiKey: legacyKey,
            model: legacyModel,
            enabled: true,
            providerKind: 'custom'
          }
        ]
      }
    }
  } else if (legacyNonNull) {
    llm = [
      {
        id: 'legacy',
        label: legacyModel ? `旧配置 · ${legacyModel}` : '旧配置',
        baseURL: legacyBase,
        apiKey: legacyKey,
        model: legacyModel,
        enabled: true,
        providerKind: 'custom'
      }
    ]
  } else {
    llm = presetClone()
  }

  // ---- TTS 多配置 ----
  // 迁移（A3，照 llm 的 alreadyMigrated 模式）：旧 `ttsVoice`（或旧三框有值）→ 追加**一条** legacy TTS，
  // `voice` 取旧 ttsVoice。旧版本 TTS 复用同一 baseURL/apiKey/model，故这里精确复原为一条 tts provider。
  //   - **不预置 TTS**（与 llm 预置 3 条不同）：用户未要求，且本机聚合服务不支持 /audio/speech，
  //     预置只会造出「假可用」配置；故 tts[] 为空且旧值全空 → 保持空（界面显示"未配置"即可）。
  //   - **幂等**：命中 `id==='legacy'` 或 baseURL+model+voice 相同 → 视为已迁移，连续 load 不重复追加。
  //   - 用户自定义 tts[] 条目原样保留，绝不覆盖/删除。
  let tts: TtsProvider[]
  const ttsLegacyNonNull = !!(legacyVoice || legacyBase || legacyKey || legacyModel)
  const legacyTts = (): TtsProvider => ({
    id: 'legacy',
    label: legacyModel ? `旧配置 · ${legacyModel}` : '旧配置',
    baseURL: legacyBase,
    apiKey: legacyKey,
    model: legacyModel,
    enabled: true,
    providerKind: 'custom',
    voice: legacyVoice
  })
  if (Array.isArray(s.tts)) {
    tts = dedupeProviders((s.tts as unknown[]).map(sanitizeTts).filter((x): x is TtsProvider => !!x))
    if (ttsLegacyNonNull) {
      const alreadyMigrated = tts.some(
        (p) => p.id === 'legacy' || (p.baseURL === legacyBase && p.model === legacyModel && p.voice === legacyVoice)
      )
      if (!alreadyMigrated) tts = [...tts, legacyTts()]
    }
  } else if (ttsLegacyNonNull) {
    tts = [legacyTts()]
  } else {
    tts = []
  }

  const activeLlmId =
    typeof s.activeLlmId === 'string' && llm.some((p) => p.id === s.activeLlmId)
      ? s.activeLlmId
      : llm[0]?.id ?? ''
  const activeTtsId =
    typeof s.activeTtsId === 'string' && tts.some((p) => p.id === s.activeTtsId)
      ? s.activeTtsId
      : tts[0]?.id ?? ''

  const chainRaw = Array.isArray(s.fallbackChain)
    ? (s.fallbackChain as unknown[]).filter((x): x is string => typeof x === 'string')
    : []
  const fallbackChain = chainRaw.filter((id) => id !== activeLlmId && llm.some((p) => p.id === id))

  // ---- ComfyUI 生图（加性：旧 settings.json 无该字段 → 整体补默认）----
  const dflt = defaultComfyuiSettings()
  const rawComfy = (s.comfyui ?? {}) as Partial<ComfyuiSettings>
  const comfyui: ComfyuiSettings = {
    baseUrl: typeof rawComfy.baseUrl === 'string' && rawComfy.baseUrl.trim() ? rawComfy.baseUrl.trim() : dflt.baseUrl,
    model: typeof rawComfy.model === 'string' ? rawComfy.model : dflt.model,
    // 宽高夹到 [64, 4096]（Qwen-Image 常用 832×1216）；步数 [1, 100]；CFG [1, 30]
    width: Math.round(clamp(rawComfy.width, 64, 4096, dflt.width)),
    height: Math.round(clamp(rawComfy.height, 64, 4096, dflt.height)),
    steps: Math.round(clamp(rawComfy.steps, 1, 100, dflt.steps)),
    cfg: clamp(rawComfy.cfg, 1, 30, dflt.cfg),
    negativePrompt: typeof rawComfy.negativePrompt === 'string' ? rawComfy.negativePrompt : dflt.negativePrompt,
    charPromptTemplate:
      typeof rawComfy.charPromptTemplate === 'string' && rawComfy.charPromptTemplate.trim()
        ? rawComfy.charPromptTemplate
        : dflt.charPromptTemplate,
    iconPromptTemplate:
      typeof rawComfy.iconPromptTemplate === 'string' && rawComfy.iconPromptTemplate.trim()
        ? rawComfy.iconPromptTemplate
        : dflt.iconPromptTemplate,
    scenePromptTemplate:
      typeof rawComfy.scenePromptTemplate === 'string' && rawComfy.scenePromptTemplate.trim()
        ? rawComfy.scenePromptTemplate
        : dflt.scenePromptTemplate,
    charArtStylePreset: ((): 'anime' | 'realistic' | 'custom' => {
      const v = rawComfy.charArtStylePreset
      return v === 'realistic' || v === 'custom' || v === 'anime' ? v : dflt.charArtStylePreset
    })(),
    charArtStyleCustom:
      typeof rawComfy.charArtStyleCustom === 'string' ? rawComfy.charArtStyleCustom : dflt.charArtStyleCustom,
    sceneArtStylePreset: ((): 'anime' | 'custom' => {
      const v = rawComfy.sceneArtStylePreset
      return v === 'custom' || v === 'anime' ? v : dflt.sceneArtStylePreset
    })(),
    sceneArtStyleCustom:
      typeof rawComfy.sceneArtStyleCustom === 'string' ? rawComfy.sceneArtStyleCustom : dflt.sceneArtStyleCustom,
    workflowJson:
      typeof rawComfy.workflowJson === 'string' && rawComfy.workflowJson.trim()
        ? rawComfy.workflowJson
        : dflt.workflowJson
  }

  return {
    baseURL: legacyBase,
    apiKey: legacyKey,
    model: legacyModel,
    ttsVoice: legacyVoice,
    voiceVolume: clamp(s.voiceVolume, 0, 1, DEFAULT_SETTINGS.voiceVolume),
    bgmPath: typeof s.bgmPath === 'string' ? s.bgmPath : '',
    bgmVolume: clamp(s.bgmVolume, 0, 1, DEFAULT_SETTINGS.bgmVolume),
    stageZoom: normalizeZoom(s.stageZoom),
    dialogMode,
    autoplayPolicy: policy,
    roleColors,
    llm,
    tts,
    activeLlmId,
    activeTtsId,
    fallbackChain,
    comfyui
  }
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export async function loadSettings(): Promise<ModelSettings> {
  try {
    const raw = await readFile(settingsPath(), 'utf8')
    return sanitizeSettings(JSON.parse(raw) as Partial<ModelSettings>)
  } catch {
    return sanitizeSettings(null)
  }
}

export async function saveSettings(next: Partial<ModelSettings>): Promise<ModelSettings> {
  const merged = sanitizeSettings({ ...(await loadSettings()), ...next })
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(settingsPath(), JSON.stringify(merged, null, 2), 'utf8')
  return merged
}

/** 校验 baseURL：仅允许 http/https，且不得以 /chat/completions 结尾（与上游一致） */
export function validateBaseURL(baseURL: string): { ok: boolean; reason?: string } {
  const v = baseURL.trim()
  if (!v) return { ok: false, reason: '请填写完整的 Base URL' }
  let url: URL
  try {
    url = new URL(v)
  } catch {
    return { ok: false, reason: 'URL 解析失败' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: '仅支持 http/https' }
  }
  if (url.username || url.password || url.search || url.hash) {
    return { ok: false, reason: 'Base URL 不得含用户名/密码/查询/片段' }
  }
  if (/\/chat\/completions\/?$/.test(v)) {
    return { ok: false, reason: 'Base URL 不得以 /chat/completions 结尾' }
  }
  return { ok: true }
}

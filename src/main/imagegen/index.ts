/**
 * 生图编排入口（imagegen:* IPC 的实现层，**不 import electron** —— node 直跑可测）。
 *
 * 流程（单张）：读工作库目标清单 → 解析目标 → 缺图判定（force 可跳过）→
 * 拼提示词（模板渲染）→ applyWorkflow 替换占位符 → ComfyUI 提交/轮询/下载 →
 * backfill 落盘回填 → 返回新 entryPath。批量由渲染层逐张串行调用（前端显示 N/M）。
 */
import type { ComfyuiSettings } from '../../shared/app-types'
import type {
  ImagegenGenerateRequest,
  ImagegenGenerateResult,
  ImagegenProbeResult,
  SceneTarget
} from '../../shared/imagegen-types'
import type { ImagegenTargets } from './data'
import { probeComfyui, generateViaComfyui } from './comfyui'
import { applyWorkflow } from './workflow'
import { DEFAULT_SCENE_NEGATIVE_PROMPT } from '../../shared/imagegen-defaults'
import { renderCharPrompt, renderIconPrompt, renderScenePrompt } from './prompts'
import {
  buildRewriteMessages,
  parseRewriteJson,
  ratioToSize,
  type PromptTarget,
  type RewriteResult
} from './prompt-rewrite'
import { activeProvider } from '../pipeline/providers'
import { buildRequestBody, endpointOf } from '../pipeline/llm-client'
import { validateBaseURL } from '../settings/store'
import type { LlmProvider } from '../../shared/pipeline-types'
import { readImagegenTargets } from './data'
import { commitCharImage, commitLocationIcon, commitSceneImage } from './backfill'

/** 探活（settings.comfyui.baseUrl）。 */
export async function probeImagegen(comfy: ComfyuiSettings): Promise<ImagegenProbeResult> {
  return probeComfyui(comfy.baseUrl)
}

/**
 * C2：调 LLM 按目标模型规范改写提示词。
 *
 * 复用 `effects-suggest.ts` 同一套「唯一真源配置」（`settings.llm[]` + `activeLlmId`）
 * 与同一套请求构造（`buildRequestBody`，不含 temperature、json_object 模式）。
 * 失败返回 `{prompt: null, error}`，**不抛错** —— 调用方回落原模板输出。
 */
async function rewritePrompt(
  structured: string,
  target: PromptTarget,
  kind: 'char' | 'scene' | 'icon'
): Promise<RewriteResult> {
  const resolved = (await activeProvider('llm')) as LlmProvider | null
  if (!resolved) return { prompt: null, negative: null, ratio: null, error: '尚未配置模型接入' }
  if (!resolved.enabled) return { prompt: null, negative: null, ratio: null, error: '当前模型配置已被禁用' }
  if (!resolved.baseURL.trim() || !resolved.apiKey.trim() || !resolved.model.trim()) {
    return { prompt: null, negative: null, ratio: null, error: '模型配置的 Base URL / API Key / Model 未填完整' }
  }
  const check = validateBaseURL(resolved.baseURL)
  if (!check.ok) return { prompt: null, negative: null, ratio: null, error: `Base URL 不合法：${check.reason}` }

  const messages = buildRewriteMessages(structured, target, kind)
  const reqBody = buildRequestBody(resolved, messages, { maxTokens: 4096 })

  let res: globalThis.Response
  try {
    res = await fetch(endpointOf(resolved), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${resolved.apiKey.trim()}` },
      body: JSON.stringify(reqBody),
      signal: AbortSignal.timeout(90_000)
    })
  } catch (e) {
    return { prompt: null, negative: null, ratio: null, error: `改写请求失败：${(e as Error).message}` }
  }
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 200)
    } catch {
      // 忽略
    }
    return { prompt: null, negative: null, ratio: null, error: `改写上游返回 ${res.status}${detail ? `：${detail}` : ''}` }
  }
  let parsed: unknown
  try {
    parsed = await res.json()
  } catch (e) {
    return { prompt: null, negative: null, ratio: null, error: `改写响应非 JSON：${(e as Error).message}` }
  }
  const content = (() => {
    if (!parsed || typeof parsed !== 'object') return ''
    const choices = (parsed as Record<string, unknown>).choices
    if (!Array.isArray(choices) || !choices.length) return ''
    const msg = (choices[0] as Record<string, unknown>)?.message as Record<string, unknown> | undefined
    const c = msg?.content
    return typeof c === 'string' ? c : ''
  })()
  if (!content) return { prompt: null, negative: null, ratio: null, error: '改写响应缺少 choices[0].message.content' }

  const r = parseRewriteJson(content)
  if (!r.prompt) return { prompt: null, negative: null, ratio: null, error: '改写结果里没有 rewritten_prompt' }
  return r
}

/** 待生成清单（纯读）。 */
export async function imagegenTargets(root: string): Promise<{ ok: boolean; error?: string; targets?: ImagegenTargets }> {
  try {
    return { ok: true, targets: await readImagegenTargets(root) }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 解析人物目标（targetId = `${charId}::${appearanceId}`）。 */
function resolveCharTarget(targets: ImagegenTargets, targetId: string): { charId: string; appearanceId: string } | null {
  const sep = targetId.indexOf('::')
  if (sep <= 0 || sep === targetId.length - 2) return null
  const charId = targetId.slice(0, sep)
  const appearanceId = targetId.slice(sep + 2)
  const hit = targets.chars.find((c) => c.charId === charId && c.appearanceId === appearanceId)
  return hit ? { charId, appearanceId } : null
}

/**
 * 单张生成 + 回填。
 *
 * @param root 工作库根目录
 * @param comfy settings.comfyui（baseUrl / 模板 / 工作流 / 尺寸步数等）
 */
export async function imagegenGenerate(
  root: string,
  comfy: ComfyuiSettings,
  req: ImagegenGenerateRequest
): Promise<ImagegenGenerateResult> {
  try {
    const targets = await readImagegenTargets(root)

    // ---- 缺图判定（默认只补缺图；force = 重新生成覆盖）----
    const existingPath = ((): string => {
      if (req.kind === 'char') {
        const t = targets.chars.find((c) => `${c.charId}::${c.appearanceId}` === req.targetId)
        return t?.imagePath ?? ''
      }
      if (req.kind === 'scene') {
        const t = targets.scenes.find((s) => s.sceneId === req.targetId)
        return t?.imagePath ?? ''
      }
      const t = targets.icons.find((i) => i.locationType === req.targetId)
      return t?.iconPath ?? ''
    })()
    if (existingPath && req.force !== true) {
      return { ok: true, skipped: true, entryPath: existingPath }
    }

    // ---- 提示词 ----
    let prompt = ''
    if (req.kind === 'char') {
      const t = targets.chars.find((c) => `${c.charId}::${c.appearanceId}` === req.targetId)
      if (!t) return { ok: false, error: `未知的人物形象目标：${req.targetId}` }
      prompt = renderCharPrompt(
        t,
        targets.context,
        comfy.charPromptTemplate,
        comfy.charArtStylePreset,
        comfy.charArtStyleCustom
      )
    } else if (req.kind === 'scene') {
      const t: SceneTarget | undefined = targets.scenes.find((s) => s.sceneId === req.targetId)
      if (!t) {
        // 悬空场景 id（不在任何 plotLocation/merge 产物里）：跳过并警告，不写盘
        return { ok: false, error: `未知的场景 id（不在场景清单里，已跳过）：${req.targetId}` }
      }
      // 场景图提示词：走模板（B3，来自新版 plot_scene_image_user_prompt 的本地化版本），
      // 与人物/图标共用同一负面与工作流通道。模板可被设置页覆盖。
      prompt = renderScenePrompt(
        t,
        targets.context,
        comfy.scenePromptTemplate,
        comfy.sceneArtStylePreset,
        comfy.sceneArtStyleCustom
      )
    } else {
      const t = targets.icons.find((i) => i.locationType === req.targetId)
      if (!t) return { ok: false, error: `未知的地点类型目标：${req.targetId}` }
      prompt = renderIconPrompt(t, targets.context, comfy.iconPromptTemplate)
    }

    // ---- 负面提示词分流 ----
    // 人物/图标要求透明背景 → 用 negativePrompt（压制 background）
    // 场景图要求背景充实 → 用 sceneNegativePrompt（压制"空白/透明背景"）
    // 共用一份会让场景图把背景压没，这是旧实现的隐患。
    let negativePrompt =
      req.kind === 'scene'
        ? comfy.sceneNegativePrompt ?? DEFAULT_SCENE_NEGATIVE_PROMPT
        : comfy.negativePrompt

    // ---- 提示词改写（C2，可选）----
    // 模板输出是「小说描述 + 画风」的拼接，人类可读但不是扩散模型最优输入。
    // 开启改写后交给 LLM 按目标模型规范重写（Qwen-Image 要 400–500 词英文观察描述，
    // MOSS 要 tag 或自然语言，SD 系要 75 token 内标签）。
    // 改写失败**不阻断出图**：warn 记一笔，继续用模板输出。
    let finalPrompt = prompt
    let width = comfy.width
    let height = comfy.height
    let rewriteWarning: string | undefined

    if (comfy.promptRewriteEnabled === true) {
      const target = comfy.promptRewriteTarget ?? 'qwen-image-2.1'
      const rw = await rewritePrompt(prompt, target, req.kind)
      if (rw.prompt) {
        finalPrompt = rw.prompt
        if (rw.negative) negativePrompt = rw.negative
        if (rw.ratio) {
          const size = ratioToSize(rw.ratio, comfy.width, comfy.height)
          if (size) {
            width = size.width
            height = size.height
          }
        }
      } else {
        rewriteWarning = `提示词改写未生效，已用原模板输出（${rw.error ?? '未知原因'}）`
      }
    }

    // ---- 工作流替换 + 提交 ----
    const workflow = applyWorkflow({
      workflowJson: comfy.workflowJson,
      prompt: finalPrompt,
      negative: negativePrompt,
      model: comfy.model,
      width,
      height,
      steps: comfy.steps,
      cfg: comfy.cfg
    })
    const gen = await generateViaComfyui({ baseUrl: comfy.baseUrl, workflow })

    // ---- 落盘回填 ----
    if (req.kind === 'char') {
      const r = resolveCharTarget(targets, req.targetId)
      if (!r) return { ok: false, error: `未知的人物形象目标：${req.targetId}` }
      const committed = await commitCharImage(root, r.charId, r.appearanceId, gen.bytes)
      return { ok: true, entryPath: committed.entryPath, ...(rewriteWarning ? { warning: rewriteWarning } : {}) }
    }
    if (req.kind === 'scene') {
      const committed = await commitSceneImage(root, req.targetId, gen.bytes)
      return { ok: true, entryPath: committed.entryPath, ...(rewriteWarning ? { warning: rewriteWarning } : {}) }
    }
    const committed = await commitLocationIcon(root, req.targetId, gen.bytes)
    return { ok: true, entryPath: committed.entryPath, ...(rewriteWarning ? { warning: rewriteWarning } : {}) }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

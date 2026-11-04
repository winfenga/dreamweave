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
import { renderCharPrompt, renderIconPrompt } from './prompts'
import { readImagegenTargets } from './data'
import { commitCharImage, commitLocationIcon, commitSceneImage } from './backfill'

/** 探活（settings.comfyui.baseUrl）。 */
export async function probeImagegen(comfy: ComfyuiSettings): Promise<ImagegenProbeResult> {
  return probeComfyui(comfy.baseUrl)
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
      prompt = renderCharPrompt(t, targets.context, comfy.charPromptTemplate)
    } else if (req.kind === 'scene') {
      const t: SceneTarget | undefined = targets.scenes.find((s) => s.sceneId === req.targetId)
      if (!t) {
        // 悬空场景 id（不在任何 plotLocation/merge 产物里）：跳过并警告，不写盘
        return { ok: false, error: `未知的场景 id（不在场景清单里，已跳过）：${req.targetId}` }
      }
      // 场景图提示词：用场景描述直接成文（与人物/图标共用同一负面与工作流通道）
      prompt = [
        `为小说创作一张场景插画，题材：${targets.context.novelGenre}。`,
        `场景名称：「${t.name}」。`,
        t.sceneDescription ? `场景描述：${t.sceneDescription}` : `场景概述：${t.summary}`,
        `世界观氛围：${targets.context.worldImpression}`,
        '构图要求：无人物或人物极小作为点缀，重点呈现环境氛围与空间层次；',
        '画面无文字、无水印；画风与小说题材一致，光影自然，色彩和谐。'
      ]
        .filter((l) => l.trim())
        .join('\n')
    } else {
      const t = targets.icons.find((i) => i.locationType === req.targetId)
      if (!t) return { ok: false, error: `未知的地点类型目标：${req.targetId}` }
      prompt = renderIconPrompt(t, targets.context, comfy.iconPromptTemplate)
    }

    // ---- 工作流替换 + 提交 ----
    const workflow = applyWorkflow({
      workflowJson: comfy.workflowJson,
      prompt,
      negative: comfy.negativePrompt,
      model: comfy.model,
      width: comfy.width,
      height: comfy.height,
      steps: comfy.steps,
      cfg: comfy.cfg
    })
    const gen = await generateViaComfyui({ baseUrl: comfy.baseUrl, workflow })

    // ---- 落盘回填 ----
    if (req.kind === 'char') {
      const r = resolveCharTarget(targets, req.targetId)
      if (!r) return { ok: false, error: `未知的人物形象目标：${req.targetId}` }
      const committed = await commitCharImage(root, r.charId, r.appearanceId, gen.bytes)
      return { ok: true, entryPath: committed.entryPath }
    }
    if (req.kind === 'scene') {
      const committed = await commitSceneImage(root, req.targetId, gen.bytes)
      return { ok: true, entryPath: committed.entryPath }
    }
    const committed = await commitLocationIcon(root, req.targetId, gen.bytes)
    return { ok: true, entryPath: committed.entryPath }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

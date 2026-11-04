/**
 * ComfyUI 工作流（API 格式 JSON）解析 + 占位符替换 + 校验。
 *
 * 不假定 Qwen-Image 在 ComfyUI 里的节点结构：设置里可粘贴任意 API 格式工作流 JSON，
 * 程序只做**字符串值**的占位符替换，不重排/不增删节点：
 *   - `{{prompt}}` / `{{negative}}`：正/负面提示词（所有字符串值内替换）；
 *   - `{{model}}`：settings.comfyui.model 非空时替换；空则原样保留（不强改模型名）；
 *   - `{{width}} {{height}} {{steps}} {{cfg}}`：**整值占位** —— 字符串值恰好等于该占位符时
 *     替换为数字（settings 数值）；出现在更长文本里则不动。用户自贴工作流不写这些占位
 *     → 其数值参数完全不被程序触碰；
 *   - `{{seed}}`：整值占位，替换为每次随机的整数（固定 seed 会反复出同一张图）。
 */
import type { ComfyuiSettings } from '../../shared/app-types'

/** 整值占位 → settings 字段映射 */
const NUMERIC_PLACEHOLDERS: Record<string, keyof Pick<ComfyuiSettings, 'width' | 'height' | 'steps' | 'cfg'>> = {
  '{{width}}': 'width',
  '{{height}}': 'height',
  '{{steps}}': 'steps',
  '{{cfg}}': 'cfg'
}

/** 校验工作流 JSON：JSON 合法 + 必须含 {{prompt}} 占位。返回可读错误。 */
export function validateWorkflowJson(text: string): { ok: boolean; error?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `工作流 JSON 解析失败：${(e as Error).message}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '工作流 JSON 必须是一个对象（API 格式的节点映射）' }
  }
  const nodes = Object.values(parsed as Record<string, unknown>)
  if (!nodes.length) return { ok: false, error: '工作流 JSON 不能为空对象' }
  for (const n of nodes) {
    if (!n || typeof n !== 'object' || Array.isArray(n)) continue
    const inputs = (n as Record<string, unknown>).inputs
    if (inputs && typeof inputs === 'object' && !Array.isArray(inputs)) {
      for (const v of Object.values(inputs as Record<string, unknown>)) {
        if (typeof v === 'string' && v.includes('{{prompt}}')) return { ok: true }
      }
    }
  }
  return { ok: false, error: '工作流 JSON 中未找到 {{prompt}} 占位符（正面提示词将无处填入）' }
}

/** 深遍历：对所有字符串值做替换（数组 / 对象继续下钻，其余类型原样）。 */
function walkStrings(node: unknown, fn: (s: string) => string | number): unknown {
  if (typeof node === 'string') return fn(node)
  if (Array.isArray(node)) return node.map((v) => walkStrings(v, fn))
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = walkStrings(v, fn)
    return out
  }
  return node
}

export interface ApplyWorkflowInput {
  /** ComfyUI API 格式工作流 JSON 字符串 */
  workflowJson: string
  prompt: string
  negative: string
  /** 出图模型名（空 = 不替换 {{model}}） */
  model: string
  width: number
  height: number
  steps: number
  cfg: number
  /** 指定随机种子（验证脚本用；缺省每次随机） */
  seed?: number
}

/**
 * 解析 + 替换占位符 → 可直接 POST /prompt 的工作流对象。
 * JSON 非法时抛**可读**错误（含 validateWorkflowJson 的说明）。
 */
export function applyWorkflow(input: ApplyWorkflowInput): Record<string, unknown> {
  const v = validateWorkflowJson(input.workflowJson)
  if (!v.ok) throw new Error(v.error ?? '工作流 JSON 不合法')
  const parsed = JSON.parse(input.workflowJson) as unknown

  const seed = input.seed ?? Math.floor(Math.random() * 2 ** 48)
  return walkStrings(parsed, (s) => {
    // 整值占位（含 {{seed}}）必须恰好等于整个字符串值 → 替换为数字
    if (s === '{{seed}}') return input.seed ?? seed
    const numericKey = NUMERIC_PLACEHOLDERS[s]
    if (numericKey) {
      const n = input[numericKey]
      if (Number.isFinite(n)) return n
    }
    let out = s
      .replace(/\{\{\s*prompt\s*\}\}/g, input.prompt)
      .replace(/\{\{\s*negative\s*\}\}/g, input.negative)
    // {{model}}：仅在设置了模型名时替换；空则原样保留（不强改用户工作流的模型名）
    if (input.model.trim()) out = out.replace(/\{\{\s*model\s*\}\}/g, input.model.trim())
    return out
  }) as Record<string, unknown>
}

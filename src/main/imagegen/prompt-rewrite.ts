/**
 * 生图提示词改写（C2）：把模板拼出的「结构化语义」交给 LLM，
 * 按**目标模型规范**改写成该模型能吃的提示词。
 *
 * 为什么需要这一层：
 *   模板渲染出来的是「小说描述 + 画风附加」的拼接，人类可读但**不是**扩散模型的最优输入。
 *   Qwen-Image 2.1 要的是 400–500 词的英文观察式描述（见 docs/image-prompt-specs.md），
 *   MOSS-Image 要的是 tag 串或自然语言 + 官方负向词，SD 系要 75 token 内的标签。
 *   同一个结构化语义，三种模型三种写法。
 *
 * 铁律：**改写只做重组与细化，不得新增原文没有的设定**。
 *   实测教训：包里写「朴素水手装」，模型很容易扩写成「华服」——
 *   一旦提示词里出现原文没有的华丽描述，出图就会错位。system 里反复强调这条。
 *
 * 失败即回落：改写失败（未配置模型 / 超时 / 返回空）时**返回 null**，
 *   调用方用原模板输出继续，绝不因为改写坏了就画不出图。
 */
import type { ChatMessage } from '../../shared/pipeline-types'

/** 目标模型 */
export type PromptTarget = 'qwen-image-2.1' | 'moss-image' | 'generic'

export const PROMPT_TARGETS: { id: PromptTarget; label: string; hint: string }[] = [
  {
    id: 'qwen-image-2.1',
    label: 'Qwen-Image 2.1',
    hint: '输出 400–500 词英文观察式描述 + wh_ratio；禁质量词与祈使句'
  },
  {
    id: 'moss-image',
    label: 'MOSS-Image',
    hint: '英文自然语言或 tag 串；自带 Layout 能力，可用官方负向词'
  },
  {
    id: 'generic',
    label: '通用 / SD 系',
    hint: '标签式，控制在 75 token 内，避免超长被 CLIP 截断'
  }
]

/**
 * 每种目标模型的 system 提示词。
 *
 * 内容来自官方规范（docs/image-prompt-specs.md），不是自由发挥。
 * 共同部分（事实忠实、不编造）放在末尾统一追加。
 */
const SYSTEM_BY_TARGET: Record<PromptTarget, string> = {
  'qwen-image-2.1': `你是 Qwen-Image 2.1 的图像提示词改写专家。

你的任务：把给定的中文结构化资料，改写成一段**英文**的图像描述。

写作规则（严格遵守）：
1. 输出一段观察式描述，约 20 句、400–500 词。现在时、第三人称、陈述句。
2. 视角是「一个观察者在描述已成形的画面里有什么」，不是「画一个…」。
   不用祈使句（不要 create / make / ensure / should）。
3. 开头一句约 20 词：The image is a ⟨vertical|wide|square⟩ ⟨style⟩ ⟨photograph|illustration|portrait|scene⟩ of ⟨subject⟩, ⟨background and palette⟩.
   媒介名词不可省略。
4. 之后按方位走画面：背景与景深 → 姿态与位置 → 头部与面部 → 躯干与每件衣物 → 手持物 → 边缘。
   约三分之一的句子以方位短语开头（On the left side of the frame, …）。
   要覆盖四角、边缘与中心，不要全挤在中间。
5. 光照单独一句，写明光源、方向、质量与它留下的明暗。
6. 收尾一句：The overall composition …（构图、色调、风格、氛围），只写一句。
7. 颜色必须带修饰词（deep navy / muted olive / pale cream），不写光板色名。
   材质说具体（brushed metal / coarse linen / frosted glass）。
8. 年龄写人生阶段或年代（a teenager / in her thirties），不写具体岁数。
9. 枚举而非概括：不写 several items，要逐件说清。
10. **绝对不要**出现质量词：no masterpiece, 8K, highly detailed, award-winning, best quality。
11. **绝对不要**在描述正文里写比例、分辨率、像素数。

只输出 JSON，不要任何解释：
{"rewritten_prompt": "<英文描述>", "wh_ratio": "<如 2:3>"}`,

  'moss-image': `你是 MOSS-Image 的图像提示词改写专家。

你的任务：把给定的中文结构化资料，改写成 MOSS-Image 能用的英文提示词。

写作规则：
1. 用英文输出。MOSS-Image 英文训练量最多，效果最稳。
2. 形式二选一，优先用**自然语言段落**（60–150 词），信息密度高胜过堆标签。
   若资料明显适合标签化（人物立绘、单物体），也可用 tag 串。
3. 用 tag 串时，按官方推荐顺序组织：
   Quality → Score → Meta → Year → Character → Series → Artist → General
   例：best quality, highres, 1girl, young man, 1815 french sailor, navy short jacket
4. 文字排版：如需画面中出现文字，用直引号保留原文并说明位置。
5. 光照、构图、景别写清楚——MOSS 对这类描述响应好。
6. **不要**编造原文没有的服饰、发色、道具。

只输出 JSON，不要任何解释：
{"rewritten_prompt": "<英文提示词>", "negative_prompt": "<可选的负向词，留空则用默认>"}
默认负向词（官方实测有效）：nsfw, worst quality, bad anatomy, watermark, jpeg artifact`,

  generic: `你是图像生成提示词改写专家，目标模型是 Stable Diffusion 系（CLIP 文本编码器）。

你的任务：把给定的中文结构化资料，改写成**标签式英文提示词**。

写作规则：
1. 输出逗号分隔的英文标签串，**严格控制在 75 token 以内**（超出会被 CLIP 静默截断）。
2. 优先级顺序：主体 → 外貌/服饰 → 姿态 → 背景 → 画风 → 质量词。
   超出长度时从**尾部**删减（先删质量词，再删背景）。
3. 关键特征用括号加权：主体特征 (word:1.2)，次要元素 (word:0.9)。不要滥用。
4. 画风词要具体：cel shading, anime style, lineart, flat color, photorealistic。
5. **不要**编造原文没有的服饰、发色、道具。

只输出 JSON：
{"rewritten_prompt": "<标签串>", "negative_prompt": "<负向词>"}
默认负向词：worst quality, low quality, watermark, text, signature, bad anatomy, extra fingers`
}

/** 所有目标共享的硬约束（追加在 system 末尾） */
const COMMON_RULES = `

=== 最重要的约束（违反即失败）===
下面给你的是**小说原文提炼出的既定事实**，不是创作题材。你必须：
- 只使用资料里出现过的外貌、服饰、发色、年龄、时代、地域特征。
- 绝对不得新增原文没有的设定。典型错误：资料写「朴素水手装」你写成「华服」；
  资料写「黑发」你写成「银发」；资料写「十九岁」你写成「孩童」。
- 资料没写的细节，你可以合理补足**画法层面**的细节
  （光影、材质质感、构图、镜头），但**不得补足设定层面**的内容
  （不得新增服饰款式、配饰、纹样、武器、道具）。
- 若资料信息不足以支撑完整画面，就按已有信息克制描述，不要编造来填充长度。`

/**
 * 构造改写用的 messages。
 *
 * @param structured 模板渲染出的结构化语义（就是当前 `renderCharPrompt` 的产物）
 * @param target 目标模型
 * @param kind 生图类别（影响措辞：立绘 vs 场景）
 */
export function buildRewriteMessages(
  structured: string,
  target: PromptTarget,
  kind: 'char' | 'scene' | 'icon'
): ChatMessage[] {
  const kindHint =
    kind === 'char'
      ? '【本次类型】角色立绘：单人全身像，需要清晰的面部、发型、每件衣物的形制与颜色。'
      : kind === 'scene'
        ? '【本次类型】场景背景图：不含人物，重点是空间结构、建筑材质、光线与氛围。'
        : '【本次类型】地图地点图标：单一物体或剪影，高度概括，纯色背景，无文字。'
  return [
    { role: 'system', content: SYSTEM_BY_TARGET[target] + COMMON_RULES },
    { role: 'user', content: `${kindHint}\n\n【结构化资料】\n${structured}` }
  ]
}

/** 改写结果 */
export interface RewriteResult {
  /** 改写后的正向提示词；null = 未改写（调用方用原模板输出） */
  prompt: string | null
  /** 改写后的负向提示词；null = 用设置里的默认 */
  negative: string | null
  /** 宽高比（仅 Qwen-Image 会返回）；null = 用设置里的宽高 */
  ratio: string | null
  /** 失败原因（prompt 为 null 时给出，供 UI 提示） */
  error?: string
}

/** 从模型返回里抽 JSON（容忍 ```json 包裹与前后的解释文字） */
export function parseRewriteJson(content: string): {
  prompt: string | null
  negative: string | null
  ratio: string | null
} {
  let text = (content ?? '').trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fence) text = fence[1].trim()
  let obj: unknown = null
  try {
    obj = JSON.parse(text)
  } catch {
    const s = text.indexOf('{')
    const e = text.lastIndexOf('}')
    if (s >= 0 && e > s) {
      try {
        obj = JSON.parse(text.slice(s, e + 1))
      } catch {
        return { prompt: null, negative: null, ratio: null }
      }
    } else {
      return { prompt: null, negative: null, ratio: null }
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { prompt: null, negative: null, ratio: null }
  }
  const o = obj as Record<string, unknown>
  const prompt = typeof o.rewritten_prompt === 'string' && o.rewritten_prompt.trim() ? o.rewritten_prompt.trim() : null
  const negative =
    typeof o.negative_prompt === 'string' && o.negative_prompt.trim() ? o.negative_prompt.trim() : null
  const ratioRaw = typeof o.wh_ratio === 'string' ? o.wh_ratio.trim() : ''
  // 宽高比只接受 `N:M` 形式
  const ratio = /^\d{1,2}:\d{1,2}$/.test(ratioRaw) ? ratioRaw : null
  return { prompt, negative, ratio }
}

/** 宽高比 → 像素尺寸（保持总像素接近设置里的 width×height） */
export function ratioToSize(
  ratio: string | null,
  baseWidth: number,
  baseHeight: number
): { width: number; height: number } | null {
  if (!ratio) return null
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(ratio)
  if (!m) return null
  const rw = Number(m[1])
  const rh = Number(m[2])
  if (!rw || !rh) return null
  const targetPixels = Math.max(1, baseWidth * baseHeight)
  const scale = Math.sqrt(targetPixels / (rw * rh))
  // 对齐到 16 的倍数（MOSS-Image 与多数 SD 系工作流都要求）
  const align16 = (n: number): number => Math.max(256, Math.round(n / 16) * 16)
  return { width: align16(rw * scale), height: align16(rh * scale) }
}

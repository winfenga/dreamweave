/**
 * 生图（本地 ComfyUI）共享默认值 —— 主进程（prompts/workflow 渲染）与渲染进程
 * （设置页「恢复默认」）共用同一份，单一事实源。
 *
 * 提示词**不照抄原版**：在原版 characterAppearance / worldImpression 字段基础上，
 * 改写成面向 Qwen-Image 的中文自然语言正面提示词（单人多角度立绘 / 单物体图标）。
 */

/** 人物立绘正面提示词模板。占位符：{{name}} {{aliases}} {{sex}} {{appearanceSummary}} {{visualKeywords}} {{worldImpression}} {{novelGenre}} */
export const DEFAULT_CHAR_PROMPT_TEMPLATE = [
  '为小说创作一张角色全身立绘插画，题材：{{novelGenre}}。',
  '画面主体：一位{{sex}}，名叫「{{name}}」{{aliases}}。',
  '外貌细节：{{appearanceSummary}}。',
  '造型关键词：{{visualKeywords}}。',
  '世界观氛围：{{worldImpression}}。',
  '构图要求：单人全身像，站姿自然放松，完整呈现从头顶到脚部的整体形象，',
  '人物居中、视线朝向观者；背景使用干净的浅色纯色渐变，不带任何文字、水印或杂物。',
  '画面质量：高清细腻，线条流畅，色彩和谐统一，人物比例准确，',
  '画风与「{{novelGenre}}」的整体视觉气质一致。'
].join('\n')

/** 地图地点图标正面提示词模板。占位符：{{locationType}} {{iconStyle}} {{novelGenre}} */
export const DEFAULT_ICON_PROMPT_TEMPLATE = [
  '一枚地图界面用的地点类型图标，表现「{{locationType}}」。',
  '画面主体：一个能代表{{locationType}}的单一物体或剪影，居中放置并占满画面主体位置。',
  '背景：纯色干净背景，无任何文字、水印、边框或多余装饰。',
  '美术风格：{{iconStyle}}。',
  '整体气质与「{{novelGenre}}」一致；造型高度概括、轮廓清晰、边缘整洁，',
  '缩小到很小的尺寸时依然能一眼辨认出类别。画面中不出现任何文字。'
].join('\n')

/** 通用负面提示词（低质、水印、文字等）。 */
export const DEFAULT_NEGATIVE_PROMPT =
  '低质量，低分辨率，模糊，噪点，画面扭曲，比例失调，多余肢体，多余手指，肢体畸形，' +
  '面部崩坏，画面中出现多个人物，水印，文字，签名，logo，边框，裁切不完整，杂乱背景'

/**
 * 内置标准 text2img 工作流模板（ComfyUI **API 格式** JSON 字符串）。
 *
 * 节点链：CheckpointLoaderSimple → CLIPTextEncode×2 → KSampler → VAEDecode → SaveImage。
 * 占位符（提交前由 imagegen/workflow.ts 做字符串替换）：
 *   - `{{prompt}}` / `{{negative}}`：正/负面提示词（**必须**含 {{prompt}}，校验项）；
 *   - `{{model}}`：出图模型名（settings.comfyui.model 非空时替换；空则原样保留）；
 *   - `{{width}} {{height}} {{steps}} {{cfg}}`：整值占位（必须是该字符串值的**全部**内容），
 *     替换后转为数字；用户自贴工作流不写这些占位 → 程序不强改其数值；
 *   - `{{seed}}`：整值占位，替换为每次随机的整数（避免固定 seed 出重复图）。
 */
export const DEFAULT_WORKFLOW_JSON = JSON.stringify(
  {
    '1': {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: '{{model}}' }
    },
    '2': {
      class_type: 'CLIPTextEncode',
      inputs: { text: '{{prompt}}', clip: ['1', 1] }
    },
    '3': {
      class_type: 'CLIPTextEncode',
      inputs: { text: '{{negative}}', clip: ['1', 1] }
    },
    '4': {
      class_type: 'KSampler',
      inputs: {
        seed: '{{seed}}',
        steps: '{{steps}}',
        cfg: '{{cfg}}',
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1,
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['5', 0]
      }
    },
    '5': {
      class_type: 'EmptyLatentImage',
      inputs: { width: '{{width}}', height: '{{height}}', batch_size: 1 }
    },
    '6': {
      class_type: 'VAEDecode',
      inputs: { samples: ['4', 0], vae: ['1', 2] }
    },
    '7': {
      class_type: 'SaveImage',
      inputs: { filename_prefix: 'feather', images: ['6', 0] }
    }
  },
  null,
  2
)

/** 设置页占位符说明（人物模板） */
export const CHAR_TEMPLATE_HINT =
  '可用占位符：{{name}} 角色名 · {{aliases}} 别名（自动拼成「（别名：a、b）」，无别名时为空） · ' +
  '{{sex}} 性别气质 · {{appearanceSummary}} 外貌概述 · {{visualKeywords}} 视觉关键词（顿号连接） · ' +
  '{{worldImpression}} 世界观概述 · {{novelGenre}} 小说题材。缺失的变量替换为空串。'

/** 设置页占位符说明（图标模板） */
export const ICON_TEMPLATE_HINT =
  '可用占位符：{{locationType}} 地点类型名（一类型一图标） · {{iconStyle}} 图标画风' +
  '（取 worldImpression 产物的 locationIconArtStyle 字段） · {{novelGenre}} 小说题材。'

/** 设置页工作流说明 */
export const WORKFLOW_HINT =
  '粘贴 ComfyUI「API 格式」工作流 JSON（工作流菜单里开启 Dev mode 后可导出 API 格式）。' +
  '程序提交前会把 {{prompt}}/{{negative}} 替换为正/负面提示词；' +
  '{{model}} 在上方填写了模型名时替换；整值占位 {{width}}/{{height}}/{{steps}}/{{cfg}}/' +
  '{{seed}} 必须是该字符串值的全部内容，替换后转为数字（{{seed}} 为每次随机）。' +
  '不写这些占位的工作流，其数值不会被程序改动。'

/** ComfyuiSettings 默认值（读取旧 settings.json 缺该字段时整体补默认） */
export function defaultComfyuiSettings(): {
  baseUrl: string
  model: string
  width: number
  height: number
  steps: number
  cfg: number
  negativePrompt: string
  charPromptTemplate: string
  iconPromptTemplate: string
  workflowJson: string
} {
  return {
    baseUrl: 'http://127.0.0.1:8188',
    model: '',
    width: 832,
    height: 1216,
    steps: 20,
    cfg: 4,
    negativePrompt: DEFAULT_NEGATIVE_PROMPT,
    charPromptTemplate: DEFAULT_CHAR_PROMPT_TEMPLATE,
    iconPromptTemplate: DEFAULT_ICON_PROMPT_TEMPLATE,
    workflowJson: DEFAULT_WORKFLOW_JSON
  }
}

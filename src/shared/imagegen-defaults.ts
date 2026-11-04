/**
 * 生图（本地 ComfyUI）共享默认值 —— 主进程（prompts/workflow 渲染）与渲染进程
 * （设置页「恢复默认」）共用同一份，单一事实源。
 *
 * 提示词**不照抄原版**：在原版 characterAppearance / worldImpression 字段基础上，
 * 改写成面向 Qwen-Image 的中文自然语言正面提示词（单人多角度立绘 / 单物体图标）。
 */

/**
 * 提示词**不照抄原版**：在原版 characterAppearance / worldImpression 字段基础上，
 * 改写成面向 Qwen-Image 的中文自然语言正面提示词（单人多角度立绘 / 单物体图标）。
 *
 * §5 改造（2026-11-04）：新增三份**画风基座**（`ART_STYLE_*`），来自新版模板
 * `visual_novel_art_style` / `visual_novel_art_style_realistic` / `visual_novel_scene_art_style`。
 * 它们不是独立模板，而是作为 `{{artStyle}}` 注入到人物/场景模板里 —— 这解决了两处旧缺口：
 *   1) `ImagegenContext.charArtStyle` 一直在采集（reader `:character-art-style`）却**从未被使用**；
 *   2) 场景图此前完全没有画风约束，全靠模型自由发挥。
 *
 * 选择方式：`ComfyuiSettings.charArtStylePreset` = `anime`（默认）| `realistic` | `custom`。
 */

/**
 * 人物画风基座：精致二次元立绘（默认）。
 *
 * 【为什么是压缩版】原版 `visual_novel_art_style` 是 1392 字符的**画法规范书**
 * （线条粗细、阴影形状、发束节奏、材质反射…）。那些是给「会画画的助手」看的，
 * 对 Qwen-Image / MOSS 这类扩散模型基本无效——它们只按语义 token 出图，
 * 不理解「线稿有粗细变化」该怎么执行。实测整条提示词 1859 字符里 75% 是画风，
 * 真正的角色描述只有 300 字，注意力被严重稀释。
 *
 * 【压缩原则】只保留扩散模型**真正响应**的三类信息：
 *   1) 画风定位（赛璐璐 / 厚涂 / 真人）——决定整体质感
 *   2) 质量词（best quality 类）——稳定出图下限
 *   3) 禁则（不要什么）——负向约束比正向画法更有效
 * 删掉全部「怎么画」的过程描述。
 *
 * 原版的「资料边界」段保留：它管的是**内容忠实度**（原文说朴素就别画华服），
 * 这条对扩散模型有效，不能删。
 */
export const ART_STYLE_CHAR_ANIME =
  '精致二次元角色立绘，日式赛璐璐风格，商业游戏美术水准，线条干净，色块分明，五官刻画精细。' +
  '原作设定优先：原文写朴素、普通、破旧的衣着就保持原貌，不擅自改成华服；' +
  '同一人物各形象保持共有的面部与体型特征。' +
  '全身像，人物完整不裁切，姿态自然，双手清晰可见。' +
  '透明背景，无背景场景、无文字、无水印、无边框。' +
  '不要照片质感、不要三维渲染、不要草稿线条、不要塑料感、不要过曝、不要大面积渐变、不要白色描边或发光效果。'

/**
 * 人物画风基座：电影质感真人（可选）。
 *
 * 压缩逻辑同 anime 版。注意它与 anime 版**互斥**：
 * 原版明确写「不采用动漫大眼/赛璐璐色块」，两者叠加会打架，由设置项二选一。
 */
export const ART_STYLE_CHAR_REALISTIC =
  '真人写实电影质感角色立绘，如同高质量人像摄影，自然人体比例，真实面部结构，细腻皮肤纹理，柔和可信的光影。' +
  '原作设定优先：原文写朴素、普通、破旧的衣着就保持原貌，不擅改成华服；' +
  '同一人物各形象保持共有的面部与体型特征；奇幻或非人特征忠于原文并以可信实体材质表现。' +
  '全身像，人物完整不裁切，姿态自然，双手清晰可见。' +
  '透明背景，无摄影棚背景、无文字、无水印、无边框。' +
  '不要动漫大眼、不要赛璐璐色块、不要线稿描边、不要三维建模感、不要蜡像式磨皮、不要过曝、不要塑料质感。'

/**
 * 场景画风基座（默认）。
 *
 * 与人物 anime 基座同源（原版明确要求「与精修赛璐璐人物协调」），
 * 否则会出「二次元人物站在真实照片里」的割裂感。
 * 压缩同 anime 人物版：只留画风定位、构图要点、禁则。
 */
export const ART_STYLE_SCENE_ANIME =
  '日式动画背景美术，与赛璐璐人物协调，不透明水彩与水粉质感，手绘感强。' +
  '人眼高度平视，中景或适度广景，透视可信，前中远景层次分明，空间尺度适合人物站位。' +
  '画面中部偏上保持视觉平静，为前景人物留出叠放空间；底部约四分之一避让对话框，关键地标安排在它上方。' +
  '不画任何人物，不预画对话框、安全区、边框、文字、水印或界面元素。' +
  '不画成旅游照片、建筑效果图、游戏建模截图或舞台布景。'
/** 画风基座预设标识 */
export type ArtStylePreset = 'anime' | 'realistic' | 'custom'

/** 人物画风预设 → 基座文本（custom 时由设置里的自定义文本提供，此处返回空串） */
export function charArtStyleOf(preset: ArtStylePreset | undefined, custom?: string): string {
  if (preset === 'custom') return (custom ?? '').trim()
  if (preset === 'realistic') return ART_STYLE_CHAR_REALISTIC
  return ART_STYLE_CHAR_ANIME
}

/** 场景画风预设 → 基座文本（暂无 realistic 场景基座，回落 anime） */
export function sceneArtStyleOf(preset: ArtStylePreset | undefined, custom?: string): string {
  if (preset === 'custom') return (custom ?? '').trim()
  return ART_STYLE_SCENE_ANIME
}

/** 人物立绘正面提示词模板。占位符：{{name}} {{aliases}} {{sex}} {{appearanceSummary}} {{visualKeywords}} {{worldImpression}} {{novelGenre}} {{artStyle}} */
export const DEFAULT_CHAR_PROMPT_TEMPLATE = [
  '为小说创作一张角色全身立绘插画，题材：{{novelGenre}}。',
  '画面主体：一位{{sex}}，名叫「{{name}}」{{aliases}}。',
  '外貌细节：{{appearanceSummary}}。',
  '造型关键词：{{visualKeywords}}。',
  '世界观氛围：{{worldImpression}}。',
  '构图要求：单人全身像，站姿自然放松，完整呈现从头顶到脚部的整体形象，',
  '人物居中、视线朝向观者；背景使用干净的浅色纯色渐变，不带任何文字、水印或杂物。',
  '画面质量：高清细腻，线条流畅，色彩和谐统一，人物比例准确，',
  '画风与「{{novelGenre}}」的整体视觉气质一致。',
  '',
  '{{artStyle}}'
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

/**
 * 场景背景图正面提示词模板（新版 `plot_scene_image_user_prompt` 的本地化版本）。
 *
 * 与原版差异：原版是**直接出图**的任务描述（「直接生成图片供下载，不返回 JSON」），
 * 我们走 ComfyUI，需要的是 **text2img 正面提示词**，因此保留其构图与避让约束，
 * 去掉对模型下的执行指令。
 *
 * 占位符：{{sceneName}} {{summary}} {{sceneDescription}} {{worldImpression}} {{novelGenre}} {{artStyle}}
 */
export const DEFAULT_SCENE_PROMPT_TEMPLATE = [
  '为小说创作一张 16:9 的完整场景背景插画，题材：{{novelGenre}}。',
  '场景名称：「{{sceneName}}」。',
  '场景资料：{{summary}}',
  '现场细节：{{sceneDescription}}',
  '世界观氛围：{{worldImpression}}',
  '美术指导：{{artStyle}}',
  '构图与避让要求：具备可信的空间纵深；画面中部偏上保留视觉上相对平静、尺度合理的区域，',
  '供前景人物叠加使用——不要在该位置放置大件前景物体、强烈光斑或密集纹样；',
  '底部约四分之一可能被对话框遮挡，关键地点特征与主要视觉焦点安排在它上方；',
  '左右两侧保留裁切余量。',
  '画面内容：不绘制任何人物，不预画对话框、安全区、人物轮廓、边框、文字、水印或界面元素；',
  '不制作拼贴、多视图设定稿或海报。底部与人物站位处仍绘制自然连续的完整环境，',
  '不是空白、透明区域或刻意空出的地板。',
  '代表状态：若资料包含互斥状态（如完好与废墟、白昼与黑夜），择其一有明确依据的典型状态，',
  '保留与之相容的空间结构与标志物，不把两种状态拼接起来；资料稀少时依据场景名称与世界观克制设计，',
  '不编造剧情事实。',
  '画面质量：高清细腻，材质可信且有手绘质感，光影有环境依据，色彩和谐统一，',
  '画风与「{{novelGenre}}」的整体视觉气质一致。'
].join('\n')

/** 场景模板占位符说明（设置页用） */
export const SCENE_TEMPLATE_HINT =
  '可用占位符：{{sceneName}} 场景名 · {{summary}} 场景概述 · {{sceneDescription}} 场景细节 · ' +
  '{{worldImpression}} 世界观概述 · {{novelGenre}} 小说题材 · {{artStyle}} 场景画风指导语。缺失的变量替换为空串。'

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
  scenePromptTemplate: string
  charArtStylePreset: ArtStylePreset
  charArtStyleCustom: string
  sceneArtStylePreset: 'anime' | 'custom'
  sceneArtStyleCustom: string
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
    scenePromptTemplate: DEFAULT_SCENE_PROMPT_TEMPLATE,
    charArtStylePreset: 'anime',
    charArtStyleCustom: '',
    sceneArtStylePreset: 'anime',
    sceneArtStyleCustom: '',
    workflowJson: DEFAULT_WORKFLOW_JSON
  }
}

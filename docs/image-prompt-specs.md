# 生图提示词改写规范（按目标模型）

> 本文档记录**每种目标模型**的提示词写作规范，供 `prompt-rewrite.ts` 拼 system 提示词使用。
> 来源均为官方文档（2026-11 核对），不是猜测。
>
> 设计意图：模板拼出来的「结构化语义」→ LLM 按目标模型规范改写成「模型能吃的提示词」。

---

## 1. Qwen-Image 2.1

**官方规范来源**：[Alibaba Cloud Model Studio](https://www.alibabacloud.com/help/en/model-studio/qwen-image-api)、
[Prompt Rewriting System Specification](https://raw.githubusercontent.com/iamyoki/qwen-image-2.1-skill/main/skills/qwen-image-2-1-prompter/references/t2i_rules.md)

### 核心特征

| 项 | 值 |
|---|---|
| 语言 | **英文**（中文 brief 也输出英文描述；图内文字保留原文） |
| 长度 | 约 20 句 / **400–500 词** |
| 形式 | **一段观察式描述**，不是指令 |
| 视角 | 现在时、第三人称、陈述句；「描述画面里有什么」而非「画一个…」 |
| 比例 | 只放在 `wh_ratio` 字段，**不写进正文** |

### 八步结构

1. **拆 brief**：分清「固定项」（用户明确指定的文字/物体/颜色/位置）与「开放项」（要自己决定的）
2. **定画幅**：竖构图 `2:3`、横 `3:2`、方形 `1:1`、宽银幕 `16:9`
3. **开头一句**（约 20 词）：`The image is a ⟨vertical/wide⟩ ⟨style⟩ ⟨photograph/poster/illustration/portrait⟩ of ⟨subject⟩, ⟨background & palette⟩.` —— **媒介名词不可省**
4. **列清单**：空间清单（8–14 个方位短语，要覆盖四角/边缘/中心）+ 文字清单
5. **走画面**：
   - 分区域画面（海报/页面/多物体）→ 背景 → 顶部带 → 左中右 → 底部带
   - 单一主体（人像/特写）→ 背景与景深 → 姿态与位置 → 头部面部 → 躯干与各件衣物 → 手持物 → 边缘
   - **约 1/3 的句子以方位短语开头**（`On the right side of the frame, …`）
6. **文字排布**：每条文字写明「在哪、什么样子、写的什么」，字符串用直引号原样保留
7. **光照单列一句**：光源、方向、质量、留下的明暗
8. **收尾一句**：`The overall composition …`（构图/色调/风格/氛围，**只一句**，不要第二个总结）

### 硬性禁则

- 不写质量词：**no** "masterpiece" / "8K" / "highly detailed" / "award-winning"
- 不用祈使句：no "create" / "make sure" / "the AI should"
- 不把比例/分辨率写进正文
- 颜色要带修饰词（deep navy / muted olive / pale cream），不写光板色名
- 材质要说具体（brushed metal / coarse linen / frosted glass）
- 年龄写人生阶段或年代（a teenager / in her thirties），**不写具体岁数**
- 枚举而非概括：不写 "several items"，要逐件说清
- 不确定的要模糊化（`appears to be`、`likely`），给不出就并列两个可能

### 输出格式

```json
{"rewritten_prompt": "<英文描述>", "wh_ratio": "2:3"}
```

---

## 2. MOSS-Image

**官方规范来源**：[MOSS-Image USERGUIDE_ZH](https://github.com/OpenMOSS/MOSS-Image/blob/main/USERGUIDE_ZH.md)

### 核心特征

| 项 | 值 |
|---|---|
| 语言 | **英文优先**（训练量最多），中文亦可 |
| 形式 | 自然语言 / Tag 串 / JSON Layout **三种都支持** |
| 长度 | 无硬性；长 prompt 用 CFG 3.0，短 prompt 适当调高 |
| 特有 | **原生 Layout 控制**（JSON bbox），支持精确文字排版 |

### Tag 串推荐顺序（若走 tag 形式）

```
Quality → Score → Meta → Year → Character → Series → Artist → General
```

例：`best quality, highres, hatsune miku, vocaloid, @foo bar, 1girl, blue hair`

### 推荐负面提示词（官方实测有效）

```
nsfw, worst quality, bad anatomy, watermark, jpeg artifact
```

### 推理参数建议（与提示词配合）

- 分辨率：1M / 1.5M / 2M 总像素；0.25M–4M 可外推
- 长宽比：任意，但宽高必须是 **16 的整数倍**
- Steps：**≥ 50** 效果最佳
- CFG：默认 **3.0**（3.0–6.0）；长 prompt 用 3.0，短 prompt 调高
- Shift：5.0 ／ Sampler：Euler
- SLG：推荐 `uncond skip`，skip layer **22**

### Layout Prompt（实验性）

```json
{
  "summary": {"meta": ["poster"], "canvas": "single", "caption": "整体场景与风格"},
  "items": [
    {"label": "object", "caption": "描述", "bbox": [-192,-288,384,288]}
  ],
  "bbox_coord_space": "abs_centralized",
  "bbox_format": "yxyx"
}
```

- `bbox_format: yxyx` → `[y_min, x_min, y_max, x_max]`
- `bbox_coord_space: abs_centralized` → 以画布中心为原点，1024×1024 画布范围是 -512..+512

### 文字渲染

支持中英渲染与自动换行，但未必完全符合预期。追求准确率时在 prompt 里**手动加 `\n`** 或直接换行。

---

## 3. 通用（不指定模型 / 本地 SD 系）

保守做法：

- 正向：`主体描述 + 风格词 + 质量词`，逗号分隔标签
- 负向：`worst quality, low quality, watermark, text, signature, bad anatomy`
- 长度控制在 75 token 以内（SD1.5/SDXL 的 CLIP 上限，超出被截断）

---

## 4. 与 DreamWeave 当前实现的关系

| 环节 | 现状 | 目标 |
|---|---|---|
| 模板渲染 | 产出「结构化语义」（谁/外貌/时代/画风） | 保留，作为**事实来源** |
| LLM 改写 | ❌ 无 | 按上表规范改写成目标模型提示词 |
| ComfyUI | 直接吃模板输出 | 吃改写后的结果 |

**关键约束**：改写只能**重组与细化**，不得新增原文没有的设定。
包里写「朴素水手装」，不能改写成「华服」——这类错位实测发生过。

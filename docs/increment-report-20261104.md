# 增量升级验收报告（2026-11-04）

> 依据文档：`增量设计_提示词复用与特效改造_20261104.md`
> 工作区：`D:\galcomic\dreamweave`（GitHub `winfenga/dreamweave`）
> 本报告记录**每条改动的证据**，不是计划。

---

## 0. 总览

| 线 | 内容 | 状态 | 验收方式 |
|---|---|---|---|
| **B** | 提示词模板同步（覆盖 7 + 新增 23） | ✅ 完成 | 逐字节比对 + 变量集闭环 |
| **B3** | 场景背景图提示词模板 | ✅ 完成 | 32 项断言 |
| **A1** | `cutin` + `actor` handler | ✅ 完成 | 真机 24 项 + 覆盖率 30→38 |
| **A5** | 剩余 6 个 handler | ✅ 完成 | 覆盖率 38→**74/74** |
| **A2** | 目录 `guide` + `target` | ✅ 完成 | 30 项断言 |
| **A3** | 输出 `cId` + 挂载 `characterId` | ✅ 完成 | 6 种边界 |
| **A4** | system 五段结构化 | ✅ 完成 | 源码契约检查 |
| **C** | 漫画生产链 4 个任务 | ✅ 完成 | 50 项断言 |

---

## 1. B 线：提示词模板

### 1.1 文档核对结果（先用证据复核，不照抄文档）

| 文档声称 | 实测 | 结论 |
|---|---|---|
| 8 个可直接覆盖 | **9 个**实质改动 | 文档漏算 `story_script_coherent` |
| 15 个只差换行符，因「旧快照 CRLF / 线上 LF」 | **13 个**只差换行符，且**旧快照是 LF 不是 CRLF**（`hasCRLF=false`） | 数字与原因都错 |
| `story_script_*` 2 个绝对不能覆盖 | 确实 +2286 / +2271 字节 | ✅ 对 |
| `cache_warming` 400 → 191 | 406 → 191（-215） | ✅ 基本对 |
| 12 个已 404 弃用 | 我们独有正好 12 个，名单吻合 | ✅ 对 |

**结论：文档表格只列了 7 行却写「8 个」，且把 `story_script_coherent` 误归到第 2 节。** 按实测执行。

### 1.2 实际动作

- 覆盖 7 个（排除 2 个 `story_script_*`）：`effect_semantics_selection` / `cache_warming` / `plot_location` / `chapter_seg` / `plot_location_merge` / `wiki_entity_merge_review` / `chunk_wiki_draft_character`
- 新增 23 个模板入仓（36 → **59 份**）
- 旧版 7 份备份于 `resources/prompts_backup_20261104/`

**关键安全确认：所有 9 个实质改动的变量集合均未变**，覆盖不会导致静默填空串。

验证：`npm run compare:prompts`

---

## 2. B3：场景背景图

### 2.1 问题

原实现是**硬编码的 6 行字符串**：

```ts
prompt = [
  `为小说创作一张场景插画，题材：${ctx.novelGenre}。`,
  `场景名称：「${t.name}」。`,
  t.sceneDescription ? `场景描述：${t.sceneDescription}` : `场景概述：${t.summary}`,
  `世界观氛围：${ctx.worldImpression}`,
  '构图要求：无人物或人物极小作为点缀，重点呈现环境氛围与空间层次；',
  '画面无文字、无水印；画风与小说题材一致，光影自然，色彩和谐。'
]
```

缺三样东西：**画风指导**（`artStyle` 从未被使用）、**构图避让**（人物叠加区、对话框区）、**"不绘制人物"这条硬约束**（原文只写"人物极小作为点缀"，等于允许画人）。

### 2.2 改法

改为可配置模板，6 个占位符，源自新版 `plot_scene_image_user_prompt` 的本地化版本：

- 保留原版的构图避让：中部偏上留平静区、底部 1/4 避让对话框、左右留裁切余量
- 保留原版的互斥状态处理（不把完好/废墟、白昼/黑夜拼一起）
- 明确「不绘制任何人物，不预画对话框/边框/文字」
- 删除原版的执行指令（「直接生成图片供下载，不返回 JSON」——那是给多模态模型的话，ComfyUI 要的是 text2img 正面提示词）

`ComfyuiSettings` 新增**可选** `scenePromptTemplate`，旧 `settings.json` 自动补默认；设置页新增编辑框 + 恢复默认。

验证：`npm run verify:scene-prompt` → **32 项通过**

---

## 3. A 线：特效改造

### 3.1 覆盖率（最硬的一条指标）

| 阶段 | 可播条数 | 覆盖率 |
|---|---|---|
| 改造前 | 30 / 74 | 40.5% |
| A1 后 | 38 / 74 | 51.4% |
| **A5 后** | **74 / 74** | **100%** |

`handlers` 目录从 6 个文件增至 **14 个**（`actor` `ambient` `birds` `blur` `camera` `cutin` `distortion` `eyelids` `flash` `overlay` `particles` `shake` `text` `tone`）。

验证：`npm run verify:effect-coverage -- --expect 74`

### 3.2 契约扩展（全部可选，向后兼容）

```ts
// 挂载点：这个特效作用在谁身上
interface EffectMount {
  effectId: string
  source: EffectSource
  characterId?: string        // 新增
}

// handler 上下文：立绘通道
interface TrackContext {
  overlay: FxOverlayHost
  scene: SceneTarget
  action: StageAction | null
  entry: EffectCatalogEntry
  actors?: ActorSource        // 新增
  targetCharacterId?: string  // 新增
}

interface ActorSource {
  resolve(characterId?: string): ActorPortrait | null
}
```

**降级链**（每一环缺失都静默跳过，不抛错、不影响同句其它特效）：
`actors 通道缺失` → `该角色无立绘` → `variant 未预见` → 不播

### 3.3 实现要点（值得记录的取舍）

**`cutin`**：用 `background-size` 比例裁上半身，**不依赖图片实际像素**，所以不需要等 `naturalWidth`；斜切用 `clip-path` 而非 `skew`（后者会露空白角）。

**`actor`**：在 overlay 建立绘副本做动画，**不动 StageView 拥有的 `<img>`** —— 改别人的节点就无法在 `stop()` 时完整还原。

**粒子类**（`ambient` `particles` `birds`）：全部走**纯 CSS 动画**而非 JS 每帧更新。雨最多 600 颗，JS 驱动 600 个 transform 会明显掉帧；CSS 交给合成器，清理只需移除一个节点。用稳定伪随机 seed 保证重播画面一致。

**`camera` vs `shake` vs `distortion`**：
- `shake` = 整块平移（有方向感），随时间衰减
- `camera` = 平滑插值到目标构图，到点保持
- `distortion` = 画面本身形变（多正弦叠加），走 camera 通道但语义不同

### 3.4 真机验证（24 项）

`scripts/verify-effects-ui.mjs` 在真实 Electron 渲染进程里逐条挂载，观察 DOM 与 CSS 变量，再验证清理。

**过程中发现的一处「非 bug」值得记录**：第一句往往是纯叙述（`characterId` 为空），此时 `actors.resolve()` 返回 `null` 是**正确行为**——`cutin`/`actor` 本就不该在该句播放。验收必须先导航到有角色的句子，否则测的是「没立绘时不该播」而不是「有立绘时能播」。已修正验收脚本。

### 3.5 A2：目录 guide + target

从新版 FB 目录按 `preset` 匹配，**24 条灌入**（757 字符）。

**发现源数据缺陷**：FB 里 `dizzy` / `startled-awakening` / `sword-clash` / `dream` 四条的 `guide` 字段装的其实是**类别名**（`air` / `camera` / `vision`），不是判断依据。这类值喂给模型会造成错误联想（让它以为"这条特效属于 camera 类"），已识别并剔除。

`target: true` 仅 `portrait-cutin` 一条 —— FB 里 e01/s08/s09 三条有此约束，后两条是我们没有渲染实现的新特效，按文档要求**不写入目录**。

**23 个我们没有的新特效只登记不启用**，绝不进目录（否则模型会推荐，而渲染层连 kind 都没有）。

### 3.6 A4：system 五段结构化

原 system **只有一句话**，只说了「要什么」，没说「什么时候不该要」——这是漏挂与乱挂的直接原因。

改为五段：`【角色】`/`【输入结构】`/`【特效清单】`/`【选择原则】`/`【输出约束】`

`catalogDigest()` 从 `description.slice(0, 40)` 改为 **`guide` 优先且不截断**。

原因：`portrait-cutin` 的 description 是「自动检测当前立绘的不透明顶部与底部，按有效高度比例…」——这是**怎么工作**，不是**何时该用**；还被截到 40 字，模型看到的是残缺的能力描述，不可能知道「普通说话别用这个」。

---

## 4. C 线：漫画生产链

### 4.1 新增 4 个任务

| 任务 | 执行粒度 | 输入 | 输出 |
|---|---|---|---|
| `mangaScript` | per-chunk | 原文 + 世界印象 + 人物形象 + 阅读记忆 | 章/页/分镜/台词 |
| `mangaEffects` | global | 完整漫画脚本 | 逐格特效 |
| `mangaMusic` | global | 完整漫画脚本 | 配乐需求分组 |
| `mangaMusicMerge` | global | 全部需求分组 | 合并后分组 |

注册表 **29 → 33 条**（`scripts/apply-manga-tasks.mjs`，幂等，含备份）

### 4.2 三个关键设计判断

**① `mangaScript` 强制单批**（`inputBudgetTokens: 100000`）
输出里 `pages[].panels[].lines` 引用的是**章节内行号**；若按 L2 切批，同一章被拆到两批会各自产出部分 pages，合并后页序错乱且 `panels.no` 在页内重复。

**② `mangaEffects` 不复用 `resources/effects/effect-catalog.json`**
漫画特效 id 是 `e01`/`e02`/`a18` 这套命名空间，VN 的是 `portrait-cutin`/`rain` —— **两套完全不同的目录**。而且漫画不能定位人物、不能替换背景、不能分离角色、不能增加表情，所以 `portrait-cutin`/`actor-*` 这类**不在此列**。新建 30 条独立目录。

**③ parse 侧把模板硬约束落实到校验**
- `a18` 必须带合法 `#RRGGBB`，否则丢弃该条
- 同格内 id 去重、同格只输出一次
- 目录外 id 丢弃（防臆造）
- `energy` ∈ 1~5、`pace` ∈ {慢,中,快,自由}、`fromPage ≤ toPage`

### 4.3 真包认知修正（两处）

**① `mangaMusic` 在 recon 里有 4 种形态**
只有 `024` 是 `:brief`（键 `musicGroups`），`026` 是 `:tracks`（键 `groups`），`025` 是 plan 变体，`027` 是 `:select:0`。**必须按内容识别，不能按文件名序号猜**——首版就踩了这个坑。

**② `recon/manifest.json` 存的是 `records` 层**（无外层 `records` 键），而 `buildMangaView` 期望完整 manifest，需要包一层。

### 4.4 一个重要的数据事实

真包 `results.mangaScript:0` 的 panels **没有 `speech` 字段** —— 它只在 `reader/project-edits` 的编辑版里出现（86 条台词）。这说明 speech 是后续编辑阶段补的，或包内原产出就是半成品。

本适配器的处理：**parse 宽容补空数组**（不因缺 speech 报错），但 **buildMessages 按模板要求模型产出 speech** —— 这样新生成的包无需二次编辑即可播放。

---

## 5. 全部验证命令

```bash
npm run typecheck                    # TS 全通过
npm run build                        # 构建通过
npm run compare:prompts              # 模板比对：47 同名 / 2 实质改动（受保护）
npm run verify:scene-prompt          # 32 项
npm run verify:effect-coverage       # 74/74（可加 -- --expect 74 断言）
npm run verify:effect-guide          # 30 项
npm run verify:manga                 # 18 项（漫画解析器）
npm run verify:manga-pipeline        # 50 项（漫画生产链适配器）
npm run verify:manga-ui              # 21 项（漫画视图 E2E）
npm run verify:effects-ui            # 24 项（特效真机 E2E）
```

**真机 E2E 前置**：`electron . --remote-debugging-port=9222`

---

## 6. 未做 / 后续

| 项 | 原因 |
|---|---|
| `story_script_*` 两个模板 | 字段名 `cs→chapterSeq` / `o→order` / `lId→locationId` 全改，覆盖即全线读不到数据；需连同 action 数据模型一起迁（跨 5 个文件 + 存量数据），单独立项 |
| 23 个新版新特效（glass-shatter/ice/flames/…） | 我们没有渲染实现，按文档要求只登记不启用 |
| 曲库（`music_annotation` / `chapter_music_*`） | 需要曲库服务，当前只能手动选本地 BGM 文件 |
| `novel_generation_*` / `novel_qa_*`（7 份） | 多轮 agent 架构，与单轮 JSON 任务模型对不上，且不在「读一本书」主目标上 |
| 第 5 步（特效推荐粒度改为整场） | 文档标注可选，需改 `EffectSuggestInput`/IPC/面板交互，等前四步效果验证完再看 |

---

## 7. 补充：B/C/D 线扩展（2026-11-04 晚）

### 7.1 B 线收尾：画风基座压缩

**问题**：原版 `visual_novel_art_style` 是 **1392 字符的画法规范书**（线条粗细变化、
阴影形状、发束节奏、材质反射…）。那些是给「会画画的助手」看的，
对 Qwen-Image / MOSS 这类扩散模型基本无效——它们按语义 token 出图，
不理解「线稿有粗细变化」该怎么执行。整条提示词 1859 字符里 75% 是画风，
真正的角色描述只有 300 字，注意力被严重稀释。

**压缩后**：anime 198 / realistic 226 / scene 181 字符（**-86%**）。
完整提示词 1859 → **494 字符（-73%）**。

原则：只留扩散模型真正响应的三类信息——画风定位、质量词、禁则。
删掉全部「怎么画」的过程描述。原版的「资料边界」段保留（它管内容忠实度，
原文写朴素就别画华服，这条对扩散模型有效）。

**同时修掉一处实测问题**：包内 `:character-art-style` 就是
`visual_novel_art_style` 原文（该包本身用这份提示词生成），
「基座 + 包内」拼接会重复两遍。改为 `pickArtStyle()`：包内优先、基座兜底。

新增 `scripts/show-prompt.mjs`：用真实工作库渲染最终提示词，不跑 ComfyUI 也能看效果。

### 7.2 C1：拆 worldImpression

`worldImpression` 里塞了整条剧情走向（马赛港→渔船→婚宴→伊夫堡→巴黎→越狱→复仇）。
那是给人看的背景理解，绘图模型只需要**画面事实**。

新增 `visualImpression` 字段（200–350 字，纯视觉），明确禁止剧情走向/人物命运/
情节路线/后续事件。生图优先用它，旧包回落 `worldImpression`（不动存量）。

### 7.3 C2：LLM 提示词改写

模板输出是「小说描述 + 画风」的拼接，人类可读但不是扩散模型最优输入。
新增 `prompt-rewrite.ts`，按目标模型规范改写：

| 目标模型 | 规范 |
|---|---|
| Qwen-Image 2.1 | 400–500 词英文观察式描述 + `wh_ratio`；禁质量词与祈使句 |
| MOSS-Image | 英文自然语言或 tag 串 + 官方负向词 |
| 通用/SD | 75 token 内标签串 |

规范来源 [docs/image-prompt-specs.md](./image-prompt-specs.md)（官方文档核对）。

**铁律**：只重组与细化，不得新增原文没有的设定（避免「朴素水手装」被写成「华服」）。
改写失败自动回落原模板输出，不阻断出图。

### 7.4 D：透明图 + 审查拦截

**D1 透明图**：采用 Qwen-Image 2.1 官方固定句式，严格置于人物/图标模板**首尾**：

```
This is an RGBA image with transparency. <描述>.
The image has alpha channel and the background is transparent.
```

扩散模型对序列首尾 attention 权重最高；此前「透明背景」埋在中段是最弱位置。
实测现有图已是 RGBA（四角 alpha=0，透明像素 74.8%），但那是靠「浅色渐变背景」
碰巧得到，换模型就会出白底。

**D2 负面词分流**：人物/图标压制 `background`/`scene`/`白色背景`/`白边`；
场景压制 `空白背景`/`透明背景` 并要求无人物。两者对背景要求**完全相反**，
共用一份会让场景图把背景压没。

**D3 审查拦截**（用户策略：返回不足 50 字即判定）：
- `singleChat` 层拦截，标 `blocked`
- `chatWithFallback` 遇 blocked **立即终止**：不重试、不换配置
  （同一内容换哪个模型都会被拦，重试只是白烧 token）
- 新增第七种任务状态 `blocked`（与 `failed` 区分：failed 可重试，
  blocked 必须人工处理）
- 下游任务跳过时明确提示「依赖任务被审查拦截」而非傻等
- 抽出 `depKeysFor` 供 `depSatisfied` 与 `findBlockedDep` 共用

### 7.5 §5 八个「位置已有」模板全部落地

| 模板 | 落点 | 实现 |
|---|---|---|
| `visual_novel_art_style` | `imagegen-defaults.ts` | `ART_STYLE_CHAR_ANIME` |
| `visual_novel_art_style_realistic` | 同上 | `ART_STYLE_CHAR_REALISTIC` |
| `visual_novel_scene_art_style` | 同上 | `ART_STYLE_SCENE_ANIME` |
| `plot_scene_image_user_prompt` | 同上 | `DEFAULT_SCENE_PROMPT_TEMPLATE` |
| `chapter_recognition_system_prompt` | `chapter-recognition*.ts` | 正则失败时 LLM 兜底切章 |
| `scene_group_image_user_prompt` | `scene-grouping.ts` | 启发式场景分组省图 |
| `location_type_sprite_sheet` | `sprite-sheet.ts` | 网格布局 + `{{types}}` |
| `character_map_sprite_sheet` | 同上 | 同上 |

---

## 8. 全部验证脚本（14 个，全通过）

```bash
npm run typecheck                 # TS 全通过
npm run build                     # 构建通过
node scripts/compare-prompts.mjs  # 模板比对（实质改动仅 2 个受保护的 story_script）
node scripts/verify-t2w.mjs
node scripts/verify-workspace-units.mjs
node scripts/verify-batching.mjs
node scripts/verify-t4-task-state.mjs        # 40 通过
node scripts/verify-t5-overview.mjs          # 76 通过
node scripts/verify-effect-coverage.mjs      # 74/74 可播
node scripts/verify-effect-guide.mjs         # 30 通过
node scripts/verify-manga-pipeline.mjs       # 50 通过
node scripts/verify-manga.mjs                # 18 通过
node scripts/verify-scene-prompt.mjs         # 32 通过
node scripts/verify-transparency-guard.mjs   # 42 通过
node scripts/verify-chapter-recognition.mjs  # 45 通过
node scripts/verify-imagegen-layout.mjs      # 50 通过
```

真机 E2E（需 `electron . --remote-debugging-port=9222`）：
`verify-manga-ui.mjs` 21 项 · `verify-effects-ui.mjs` 24 项 · `verify-settings-ui.mjs` 23 项

---

## 9. 两处陈旧断言的修复（记录原因）

| 脚本 | 症状 | 真因 |
|---|---|---|
| `verify-t5-overview` | 71/5 失败 | 硬编码任务数 29；C 线新增 4 个任务后注册表变 33。改为动态取 `EXPECT_TASKS` |
| `verify-t4-task-state` | 39/1 失败 | E2 用 `includes` 逐字匹配幂等判据，但实现后来加了 `!force` 短路。**已验证该行在最初基线 `5faf392` 就带着 `!force`**，属脚本陈旧而非本次回归。改为语义断言 |

这两处都不是本次改动引入的，但不修会让回归信号失真，故一并修复。

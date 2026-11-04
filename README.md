# DreamWeave · 织梦

纯本地的桌面应用：把小说或漫画**解析成可看、可听、可交互的成品**。

导入一本书 → 自动解析（人物、世界观、场景、剧本、分镜）→ 用五种方式呈现：
逐句演出的舞台、可点击的地图、印象图谱、沉浸式漫画阅读器、可导出到 SillyTavern 的角色卡。

**全部本地运行，不上传任何数据。** 解析与配音调用用户自己配置的模型端点。

---

## 技术栈

| 层 | 选型 |
|---|---|
| 壳 | Electron 33（主进程 + preload） |
| 界面 | Vue 3 + TypeScript + Vite |
| 构建 | electron-vite |
| 依赖 | **运行期零第三方依赖**（`dependencies: {}`），UI 全部手写 CSS |

零运行期依赖是有意的：这是个本地阅读器，不该为了界面美观背上几百个传递依赖。

---

## 环境要求

- Node.js ≥ 20
- `npm install` 使用淘宝镜像（见 `.npmrc`），首次约 40s

---

## 常用命令

```bash
npm install          # 安装依赖
npm run dev          # 开发窗口（热更新）
npm run build        # 编译到 out/（不生成安装包）
npm run typecheck    # 主进程 + 渲染进程类型检查

# 验证（详见「验证套件」一节）
npm run verify:t2w              # 容器格式：解包/打包/逐成员 sha256/读写往返
npm run verify:workspace-units  # 工作库读写层单元验证
npm run verify:shelf            # 书架 + 模型探测 + 工作库格式兼容
npm run verify:cards-ui         # 角色卡 + 内置酒馆 + 导出 SillyTavern
npm run verify:manga-reader     # 沉浸式漫画阅读器
npm run verify:manga-production-ui  # 漫画编排面板（讲述与配音/配乐/音色/世界书）
npm run verify:effects-ui       # 演出特效
```

> ⚠️ 若终端里带 `ELECTRON_RUN_AS_NODE=1`（部分 IDE 会注入），Electron 会被当成纯 Node 跑而报
> `Cannot read properties of undefined (reading 'whenReady')`。
> 解决：`env -u ELECTRON_RUN_AS_NODE npm run dev`。

---

## 两种内容，两条链路

同一套界面吃两种包，**按包内实际产物自动适配**：

| | 小说包 | 漫画包 |
|---|---|---|
| 产物 | `storyScript`（逐句行动） | `mangaScript`（分页分镜）+ 页面图 |
| 主界面 | 🎬 视觉演出 | 🎞️ 漫画阅读 |
| 人物形象 | `characterAppearances[]` | `characterSpriteInfos[]` |
| 人物关系 | 有（`characterRelation` 任务） | **无**（漫画链路不产出） |

漫画线的包打开「视觉演出」会显示一句正常的空状态说明，不报错、两者互不干扰。

---

## 六个主要界面

### 🎬 视觉演出

按 `storyScript.actions` 的 `order` 播放，按 `chapterSeq` 分章。

- 每句同屏：**背景** = `locationId` 的场景图，**立绘** = `characterId` 的角色图，**文本** = `text`
- `narration` / `say` / `think` / `move` / `battle` 各有样式
- 快捷键：`←` `→` 翻页、**空格**推进、**`V`** 播放/暂停、**`F11`** 全屏
- 缺图不崩：场景无图显示占位纹理，角色无立绘显示占位卡片
- 预解码下一句的场景图，避免切场景闪白
- 74 条特效（斜切入场、人物本体演出、环境粒子…）由 `resources/effects` 驱动

### 🎞️ 沉浸式漫画阅读器

两种模式：**一页一个** / **一格一个**。

- 台词**贴在底部居中**，只留文字，无边框无底色（不遮挡画面）
- 页面上**没有翻页按钮**：空格或点画面任意位置 = 向前，右键 = 回退
- 「上一页」收进底部上滑的选项抽屉里（避免按钮常驻挡画）
- `A` 键切换自动播放；有配音时**按配音时长推进**，无配音回落定时器
- 左右留一点边框，不贴屏幕边缘

### 🃏 角色卡 + 内置酒馆

从 canonical 投影出人物档案、立绘、音色，组成卡片页；每张卡可以：

- **导出 PNG 角色卡**：手写 PNG 编码器写入 `tEXt` 块（`chara` = V2、`ccv3` = V3），
  直接拖进 SillyTavern 可用；`data.character_book` 由世界书生成
- **导出 JSON**
- **在软件内置酒馆里直接聊**：温度 / top_p / 频率惩罚 / 存在惩罚 / 重复惩罚 / top_k 全部可调，
  每个参数都有「用模型默认」开关（关掉就不发该字段，而不是发一个默认值）

### 🗺️ 地图互动 / 🧭 印象图谱

- 地图：`locationTree` 渲染成可交互地图，19 种地点类型着色，滚轮缩放拖拽平移
- 印象图谱：`impressionLayout.layout`
  —— ⚠️ 注意 `layouts` 在 `data.layout.layouts`，**不在** `data` 顶层
- 两者共用详情逻辑：点节点看 `identInfos` / 关联场景 / 场景图 / 剧本条目数

### 📖 阅读原文 / 📝 脚本修订 / 📄 章节 / 👤 实体 / 📁 文件

- 阅读原文按章切段（**字节级钳制**，不会把多字节汉字切两半，全书一个字符不丢）
- 脚本修订：改单句文本，写回前自动备份，写后做成员级 sha256 复检
- 文件页缩略图懒加载（滚动进视野/悬停/点击才加载），点击放大

---

## 书库（书架）

导入的书以**书架**形式排列：每本一个立体书本造型（书脊 + 封面 + 底部书页厚度），
封面正中是书名，**每排固定 5 本**（窄窗口靠书本自身缩窄，不破排）。

- 点书即打开
- 封面配色按书名哈希稳定取色，每次进来颜色一致
- 支持按书名/章节数/字符数/体积/导入时间排序
- 同一来源可重复导入多本（不查重、不覆盖），各自独立
- 索引损坏的书单列成「破书」，可删除，不会影响其他书

---

## 工作库（数据存哪、什么格式）

导入的包会被解成**工作库**，此后所有读写都在工作库层，`dwe` 容器只出现在两个边界：

```
.dwe / .t2w 包  ──导入(解包)──►  工作库  ──导出(打包)──►  .dwe 包
                                   ↑
                        所有功能都在这一层
```

```
<userData>/workspace/<目录名>/
├─ index.json                  索引（原子写）
├─ meta/origin-header.bin      来源包头（未编辑档的黄金样本）
├─ records/<name>.json         容器分片：chapters/chunks/tasks/reader
├─ records/results/<taskId>.json  无损解析产物
├─ records/attempts/<taskId>.json 尝试审计
├─ assets/<kind>/<sha256><ext> 内容寻址资产
└─ cards/tavern-sessions.json  酒馆会话（跟书走，不跟人走）
```

- 目录名 = `<UTC14位>-<随机hex>`，与包内编号**解耦**，因此同一包可并存多份
- 主键永远是**目录名**，不是 `pkgId`
- 资产按 sha256 内容寻址，天然去重且不可变

### 格式兼容策略：读时兼容，写时升级

工作库 `index.json` 的 `format` 有两个值：

- 写：`dreamweave-workspace`（新）
- 读：新值与历史值 `txt2world-workspace` **都接受**

**不做批量迁移**。历史工作库不因一个字符串被锁死；任何一本被重新写入后自然升级。
`workspace:formats` 是个只读体检接口，可统计磁盘上各格式的库数（用来证明兼容确实生效，
而不是靠迁移蒙混过去）。

---

## 容器格式（`dwe` / 历史 `t2w`）

`txt2world-package-v1`，头部 12 字节 + 紧排 blob：

| 偏移 | 长度 | 类型 | 字段 |
|---|---|---|---|
| `0x00` | 8 | ASCII | `magic` = `T2WPKG1\n` |
| `0x08` | 4 | uint32 **大端** | `jsonLen` |
| `0x0C` | `jsonLen` | UTF-8 | 清单 JSON |
| `0x0C+jsonLen` | `Σ files[].size` | 裸字节 | 二进制块，按 `files[]` 顺序紧密拼接 |

- `files[]` 每项只有 `path` / `size` / `sha256`，**没有 offset**；
  偏移按 `offset[i] = 12 + jsonLen + Σ_{k<i} size` 累加推算
- 无对齐、无 padding、无尾随字节
- 写回时重算每个成员 sha256 并回填

> 容器 magic 仍是历史值 `T2WPKG1`，因此**旧 `.t2w` 包可直接导入**。导出的默认扩展名是 `.dwe`。
>
> 界面与对外文案里已不再出现 t2w 字样；仍在代码/磁盘里保留 `t2w` 的地方只有三类，
> 都是**改名会破坏兼容性的**：
> - 容器 magic `T2WPKG1`（旧包靠它识别）
> - `index.json` 的持久化字段名 `t2wPath` / `t2wSize` / `t2wSha256`（改名会让现存工作库读不出来）
> - 目录名 `src/main/t2w/`（纯内部组织，不影响数据）

---

## 解析流水线

`src/main/pipeline/` 实现上游 DAG 的任务编排，33 条任务（**29 条 LLM 调用 + 4 条本地计算**）：

```
cacheWarming → seg/chunkLocationSummary/plot → worldImpression/draft → merge → mergeReview
  → canonical → characterAppearance → draftAlign → characterRelation/lineAnnotation/plotLocation
  → storyScript → effectAnnotation → performanceReview → event
  ── 漫画线分支 ──
  mangaScript → mangaEffects/mangaMusic → mangaMusicMerge
```

- 任务注册表在 `resources/pipeline/task-registry.json`（构建期静态快照）
- 拓扑排序用 Kahn，成环在启动前拦截
- 上游产物按 `dependsOn` 后缀语义解析（`X:i` / `X:*` / `X:next` / `X:selected` / 裸 `X`）
- 长输入按 L2 token 预算切批，合并发生在 **parse 之前**的原始文本层

### 一个容易踩的坑：SSE

某些 OpenAI 兼容网关**无视 `stream:false`**，仍返回 `text/event-stream`。
直接 `res.json()` 会失败，表现为「探活失败」+「响应缺少 choices[0].message.content」——
端点本身完全正常。

所有调用统一走 `readChatCompletion()`（内部先 `parseSseCompletion` 聚合再解析）。
`/audio/speech` 是音频二进制，不走这条路。

---

## 模型接入

支持任意 OpenAI 兼容端点，多组配置可并存：

- 「当前使用」的那组用于解析链路
- 失败时按 `fallbackChain` 依次换用
- **每个配置行有两个按钮，分工不同**：
  - **探测模型**：`GET /models` 只读模型目录，**不需要填模型名** → 「这端点有哪些模型可选」
  - **检测连接**：用已填模型真发一次请求 → 「这组现在能跑吗」
- 探测到的模型渲染成芯片，**点一下直接填入**（长模型名手抄必错）

配音（TTS）配置走 `/audio/speech`，**检测连接也走这个接口**——
拿对话接口去探纯 TTS 端点必然 404，会把好配置判成坏的。

ComfyUI 生图同理：「探测模型」读 `/object_info/CheckpointLoaderSimple` 的 `ckpt_name` 候选。

---

## 图片常驻（`dwe://` 自定义协议）

演出与地图需要大图常驻，所以不用 base64 data URL：

- 主进程注册 `dwe://<assetKey>/<entryPath>`，直接从包 buffer 按偏移切片返回，
  **不落盘、不二次解码**
- 响应带 `content-type` 与 `cache-control: immutable`，同一 URL 在 Chromium 侧只解码一次，
  来回切场景不重新读包
- `assetKey` = `sha256(pkgId + 来源包 sha256)` 前 16 位，天然避免串包
- CSP 在 `src/renderer/index.html`，`img-src`/`media-src`/`connect-src` 需同时放开 `dwe:`

> 三处必须一致（主进程 handle / CSP / URL 拼接）。少改一处，图片音频会全 404。

---

## 验证套件

三种验证，各有分工：

**① 纯 Node 单元验证**（不需启动应用）
`verify:t2w` `verify:workspace-units` `verify:card-export` `verify:tavern-core` `verify:llm-sse`

**② CDP 真机 E2E**（需应用带 `--remote-debugging-port` 启动）
`verify:shelf` `verify:cards-ui` `verify:manga-ui` `verify:manga-reader`
`verify:manga-production-ui` `verify:manga-voice` `verify:manga-lore` `verify:effects-ui`

```powershell
# 启动带调试端口
.\node_modules\electron\dist\electron.exe . --remote-debugging-port=9333
# 另一终端
$env:CDP_ENDPOINT="http://127.0.0.1:9333"
node scripts/verify-shelf.mjs --shot shot.png
```

**③ 数据面探针**
`scripts/probe-*.mjs` 用于确认包内真实数据形状（不依赖界面）。

### 写 CDP 测试的两个坑

**坑 1：主进程会话 ≠ 渲染层状态。**
`reload` 后主进程会话仍在，但页面已回落地页。若脚本只看 IPC 就判断「书已打开」，
后续所有 UI 断言会在**空页面**上跑。复用条件必须同时检查渲染层（如侧栏有无对应入口）。

**坑 2：按标题找书不可靠。**
书架标题是**来源文件名**，同一路径可重复导入多本。按标题找会随机命中旧的那本。
正确做法是按 `origin.t2wPath` 相同 + `createdAt` 最新定位。

---

## 目录结构

```
dreamweave/
├─ src/
│  ├─ main/
│  │  ├─ index.ts                # 创建窗口 + 注册协议 + IPC
│  │  ├─ asset-protocol.ts       # dwe:// 协议（包内资产切片直出）
│  │  ├─ cache-protocol.ts       # cache:// 协议（TTS/BGM 缓存）
│  │  ├─ t2w/                    # 容器格式：core.mjs 是唯一实现
│  │  ├─ workspace/              # 工作库读写层（索引/分片/资产/会话）
│  │  ├─ pipeline/               # 解析流水线（33 任务 DAG + 编排器）
│  │  ├─ character-card/         # 角色卡构建 + PNG 导出 + 内置酒馆
│  │  ├─ manga-production/       # 漫画编排（配音/配乐/音色/世界书）
│  │  ├─ imagegen/               # ComfyUI 生图（提示词模板 + 回填）
│  │  ├─ effects/                # 演出特效库
│  │  ├─ tts/                    # TTS 合成（含缓存）
│  │  └─ ipc/                    # 全部 IPC 通道
│  ├─ preload/index.ts           # contextBridge 暴露 window.feather
│  ├─ shared/                    # 主进程 / 渲染进程共享类型
│  └─ renderer/src/
│     ├─ App.vue                 # 侧栏导航 + 标签路由
│     ├─ lib/
│     │  ├─ viewModel.ts         # 查表结构（场景图/立绘/分章索引）
│     │  ├─ stageEffects/        # 特效运行时（唯一调度器）
│     │  └─ …                    # mapLayout / impressionModel / …
│     └─ components/             # 22 个组件，见下
├─ resources/
│  ├─ pipeline/task-registry.json  # 33 任务定义
│  ├─ prompts/                     # 提示词模板
│  └─ effects/                     # 74 条特效目录
└─ scripts/                        # 验证与探针
```

### 主要组件

| 组件 | 作用 |
|---|---|
| `LibraryView.vue` | 书架（落地页） |
| `StageView.vue` | 🎬 视觉演出 |
| `MangaView.vue` / `MangaReader.vue` | 🎞️ 漫画三栏视图 / 沉浸阅读器 |
| `MangaProduction.vue` | 漫画编排面板 |
| `CharacterCardView.vue` / `TavernPanel.vue` | 🃏 角色卡 / 内置酒馆 |
| `MapView.vue` / `ImpressionView.vue` / `ImpressionBox.vue` | 🗺️ 地图互动 / 🧭 印象图谱 |
| `ReadingView.vue` / `ScriptEditor.vue` | 📖 阅读原文 / 📝 脚本修订 |
| `SettingsPanel.vue` / `ProviderListEditor.vue` | ⚙️ 设置 / 多组模型配置编辑器 |
| `ParsePanel.vue` | 解析任务面板 |
| `ImagegenPanel.vue` | 生图面板 |

---

## 已知边界

- **漫画包没有人物关系数据**：漫画链路的任务清单不含 `characterRelation`，
  所以漫画侧的世界书只做人物档案 + 世界观两类条目（不补、不猜）
- **网易云在线拉取未接**：漫画包内的配乐只有元数据与在线直链（`music.tftgamer.com`），
  播放器默认关闭，开启后才会对外发起请求（不静默联网）
- **本机聚合服务不支持 `/audio/speech`**：TTS 需要用户自己配置支持该接口的端点

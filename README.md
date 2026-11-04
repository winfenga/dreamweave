# 羽毛笔 · 桌面版（feather）

纯本地 Electron 桌面应用，用于**导入 `.t2w` 包并查看其中的解析结果**。
本阶段只实现「读包 + 展示」，**不打包、不调用任何大模型**。

> 这是按自行理解的格式规范重新实现的独立工程，仅供个人学习自用。

## 技术栈

- Electron 33（主进程 + preload）
- Vue 3 + TypeScript + Vite（renderer）
- `electron-vite` 统一构建
- 无 UI 组件库，手写 CSS

## 环境要求

- Node.js ≥ 20（开发时使用 `C:\Users\wfsyb\.workbuddy\binaries\node\versions\22.22.2-6\node.exe`，npm 10.9.7）
- 依赖安装已配置淘宝镜像（见 `.npmrc`），首次 `npm install` 约 40s

## 常用命令

```bash
npm install          # 安装依赖
npm run dev          # 启动开发窗口（热更新）
npm run build        # 仅编译源码到 out/，不生成安装包
npm run typecheck    # 主进程 + 渲染进程类型检查
npm run verify:t2w   # 校验 D:/aaaTemp 下全部 .t2w（含逐成员 sha256 与读写往返）
npm run verify:views # 端到端验证「地图互动 / 视觉演出」两视图（需 dev 带 --remote-debugging-port=9222）
npm run smoke:summary # 单独跑一遍真实 summary 模块并打印界面将展示的数据
```

> ⚠️ 若你的终端里带有 `ELECTRON_RUN_AS_NODE=1`（部分 IDE/工具会注入），Electron 会被当成纯 Node 运行而报
> `Cannot read properties of undefined (reading 'whenReady')`。
> 解决：`env -u ELECTRON_RUN_AS_NODE npm run dev`。

## 目录结构

```
feather/
├─ electron.vite.config.ts        # 三端构建配置
├─ src/
│  ├─ main/                       # Electron 主进程
│  │  ├─ index.ts                 # 创建窗口 + 注册协议 + 注册 IPC
│  │  ├─ session.ts               # 当前打开的包会话（含 assetKey / assetBase）
│  │  ├─ asset-protocol.ts        # t2w:// 自定义协议：从包内切片直出图片
│  │  ├─ ipc/index.ts             # import / preview / view / settings 通道
│  │  ├─ t2w/
│  │  │  ├─ core.mjs              # 【格式核心】magic/jsonLen/blob 切分与组装（单一实现）
│  │  │  ├─ core.d.mts            # 上面这份 JS 的类型声明
│  │  │  ├─ format.ts             # 类型化门面（供 TS 侧调用）
│  │  │  ├─ index.ts              # readPackage / readEntry / writePackage
│  │  │  ├─ summary.ts            # 抽取「概览/章节/实体/文件」要展示的摘要
│  │  │  └─ view.ts               # 抽取「地图互动/视觉演出」的渲染模型
│  │  ├─ settings/store.ts        # 模型接入三字段（baseURL/apiKey/model），仅存取
│  │  └─ pipeline/                # 【预留】解析流水线目录，本阶段不实现
│  ├─ preload/index.ts            # contextBridge 暴露 window.feather
│  ├─ shared/                     # 主进程 / 渲染进程共享类型
│  │  ├─ t2w-types.ts             # 容器格式类型
│  │  └─ app-types.ts             # ImportSummary / ViewData / ModelSettings
│  └─ renderer/                   # Vue 3 界面
│     ├─ index.html
│     └─ src/
│        ├─ App.vue               # 顶部导航 + 标签路由
│        ├─ main.ts / styles.css / env.d.ts
│        ├─ lib/
│        │  ├─ viewModel.ts       # 查表结构（场景图/立绘/分章索引）
│        │  ├─ mapLayout.ts       # 树的整洁布局算法
│        │  ├─ impressionModel.ts # 印象图谱：扁平 placements → 嵌套树
│        │  └─ locationStyle.ts   # 地点类型 → 颜色（地图与印象图谱共用）
│        └─ components/
│           ├─ SummaryView.vue    # 概览 / 章节 / 实体 / 文件
│           ├─ MapView.vue        # 🗺️ 地图互动
│           ├─ ImpressionView.vue # 🧭 印象图谱（外层：画布 + 详情）
│           ├─ ImpressionBox.vue  # 🧭 印象图谱（递归矩形）
│           ├─ StageView.vue      # 🎬 视觉演出（含 move / battle 表现）
│           ├─ Thumb.vue          # 文件页缩略图（懒加载 + 点击放大）
│           └─ SettingsPanel.vue  # 模型接入设置（仅存取）
├─ resources/prompts/             # 36 个 prompt 模板（本阶段仅落位，未接入逻辑）
└─ scripts/
   ├─ verify-t2w.mjs              # 容器格式验证（复用 src/main/t2w/core.mjs）
   ├─ verify-views.mjs            # 两视图端到端验证 + 自动截图（走 CDP）
   └─ smoke-summary.mts           # summary 运行时冒烟测试
```

## `.t2w` 容器格式（txt2world-package-v1）

| 偏移 | 长度 | 类型 | 字段 |
|---|---|---|---|
| `0x00` | 8 | ASCII | `magic` = `T2WPKG1\n` (`54 32 57 50 4b 47 31 0a`) |
| `0x08` | 4 | uint32 **大端** | `jsonLen`：其后 JSON 的字节长度 |
| `0x0C` | `jsonLen` | UTF-8 | 清单 JSON（`format` / `includesSource` / `project` / `records` / `files`） |
| `0x0C+jsonLen` | `Σ files[].size` | 裸字节 | 二进制块，按 `files[]` 顺序**紧密拼接** |

- `files[]` 每项只有 `path` / `size` / `sha256` **三个字段，没有 offset**；
  成员偏移需按 `offset[i] = 12 + jsonLen + Σ_{k<i} size` 累加推算。
- 无对齐、无 padding、无分隔符；末尾无尾随字节。
- 读写双向：`writePackage()` 会重新计算每个成员的 sha256 并回填清单。

## 导入流程

1. 点「导入 .t2w」→ 主进程 `dialog.showOpenDialog` 选包 → `readPackage()` 解析并逐成员校验 sha256
   → `buildSummary()` 抽取摘要 → 经 IPC 回到渲染进程。
2. 界面分七个标签：概览 / 🗺️ 地图互动 / 🧭 印象图谱 / 🎬 视觉演出 / 章节 / 实体 / 文件。
   文件页中的图片支持**懒加载缩略图**（滚动进入视野、或悬停、或点击时加载），点击可放大预览。

`window.feather.importPackage(filePath?)` 支持传入路径直接读取（用于「打开方式」与自动化测试），
不传参则弹出文件选择框。

## 🗺️ 地图互动

把 `records.results[:locationTree].data.tree` 渲染成可交互地图。

- 节点按 `locationType` 着色（世界/国家/首都/港口城市/海湾/商船/住宅/监狱/地牢/宫殿/岛屿… 共 19 种），
  父子之间画折线连线；右上角支持 ＋ / － / 适应 / 重置，滚轮缩放、拖拽平移，默认自动「适应窗口」。
- 点击节点 → 右侧显示 `name` / `locationType` / `identInfos` / 祖先面包屑，
  以及「子地点 / 关联场景 / 剧本条目」三个计数。
- 若该节点出现在某条 `plotLocations[].mapLocationId` 上，则会展示对应场景图
  （用 `plotLocations[].id` 去 `records.reader[:scene-images].individual` 取图）与 `summary` / `sceneDescription`。
- 地图节点带 🎬 角标，表示该地点挂载了几个场景。

## 🧭 印象图谱

把 `records.results[:impressionLayout].data.layout` 渲染成**嵌套矩形**（treemap 风格）。

- 数据形状实测为 `{ tree, layout: { gridSize: 100, layouts: [...] } }` ——
  注意 `layouts` **不在** `.data` 顶层，而是 `data.layout.layouts`。
- `layouts[]` 是 `{ parentId, mode, placements: [{ id, rect: {x,y,width,height} }] }`；
  `gridSize=100` 表示 rect 是**父容器内的百分比**。
- 渲染：`rootParentId`（通常是 `novel-world`）代表整块画布，其 placements 作为一级矩形，
  每个矩形内部再按各自 parentId 的 placements 递归嵌套，层级用方框嵌套 + 边距体现。
- 点击矩形 → 与地图互动复用同一套详情逻辑（`identInfos` / 关联场景 / 场景图 / 剧本条目数）。
- 名称与类型查表顺序：`locationTree.locations` → 地图树兜底（树根 `novel-world` 只在地图树里）。

## 🎬 视觉演出

按 `records.results[:storyScript].data.actions` 的 `order` 播放，并按 `chapterSeq` 分章。

- 每条动作同屏呈现：**背景** = `locationId` 对应的场景图；**立绘** = `characterId` 对应的角色图；
  **文本** = `text`（`narration` / `say` / `think` / `move` / `battle` 各自样式）。
- 控件：上一句 / 自动播放（速度 0.7x–3x）/ 下一句 / 跳章下拉 / 章节胶囊按钮；
  顶部显示「第 N / 总数 句 · 本章 x / y」与进度条。
- 快捷键：`←` `→` 翻页、**空格** 推进（未打完字先显全，已打完则下一句，等同单击对话框）、
  **`V`** 播放/暂停、**`F11`** 窗口级全屏（再按一次或 `Esc` 退出；有立绘模态时 `Esc` 先关模态）。
- 舞台缩放（0.7x–1.6x）只作用于**对话框与立绘**，场景背景固定不动；
  对话框高度锁死，打字过程中不会随行数增长而跳动。
- 缺图时不崩：场景无图显示占位纹理，角色无立绘显示占位卡片。
- 会自动预解码下一句的场景图，避免切场景闪白。

### `move`：场景迁移

- 起终点都有 → 顶部出现「A ⟶ B」过渡卡 + 背景横向扫过的迁移感，过渡后背景即 `toLocationId` 目标场景。
- **只有起点、没有终点**（实测合法数据：跨 7 包 29 条 move 里有 3 条）→ 走**降级分支**：
  显示「A ⟶ 前往未知地点」的开放式过渡卡 + 淡出扫过，**不报错、不空白**，继续正常播放。
- 两者都为空 → 按普通行渲染。
- `text` 照常显示（这类句子通常写着「他走出房间…」）。

### `battle`：目标高亮

- `targetIds` 非空 → 右侧浮出目标角色卡：**用已加载的立绘**做强调（放大入场 + 描边 + 抖动），
  无立绘时退化为姓名卡；同时叠加红色径向闪光与「⚔ 战斗」标签。
- `targetIds` 为空 → 显示「未指明目标」并按普通行处理。
- 不引入任何新素材，纯 CSS 动效。

> 实测分布（跨 7 包 4917 条 actions）：`move` 29 条（`fromLocationId` 29 / `toLocationId` 26）、
> `battle` 25 条（`targetIds` 25）；`narration`/`say`/`think` 三项恒为 0。
> 含 move/battle 的包：`艾莉娜…MMT (1)`（move 67 / battle 5）、`【主角档案】`（54 / 76）、
> `和拟态族…`（46 / 4）、`梦舞蝶影`（7 / 1）——《基督山伯爵》**两者都是 0**。

## 两个易踩的坑（已用 7 个样本包实证，见 `src/main/t2w/view.ts` 注释）

**1. `:storyScript` 是按 chunk 产出的，必须全部合并。**
多 chunk 的包会同时存在 `storyScript:0` … `storyScript:<chunkCount-1>`，
以及同 chunk 的 `storyScript:<n>:batch:<b>` 分批变体（后者要排除，否则重复计数）。
只取第一条会静默地把演出缩到 1/N —— 实测某包 `chunkCount=11`：
只取第一条 = **745 条动作 / 仅第 1 个 chunk**；合并全部 = **8015 条动作 / 24 章**。

**2. `scene-images` 的 key 是「合并后」的场景 id，需要 `plotLocationMerge.idMap` 转换。**
- `actions[].locationId` 与 `storyScript.plotLocations[].id` 用的是**合并前** id（`L-<chunk>-l<n>`）
- `records.reader[:scene-images].individual` 的 key 用的是**合并后** id（`PL-<n>`）
- 两者**没有交集**；`plotLocationMerge.data.idMap`（`L-*` → `PL-*`，实测 244 条）就是桥
- 只有「单 chunk 且无 merge 产物」的包（如基督山伯爵，id 恰为 `S-*`）两边才恰好相等

`view.ts` 的 `imagePathFor()` 做两级解析：先按原 id 直配，失败再用 `idMap` 换到合并 id 配，
`idMap` 缺失时还会退回 `plotLocationMerge.locations[].sourceLocationIds` 反查。

**3. `:batch:<n>` / `:grouped:*` / `:plan` / `:repair` 变体与主记录并存，必须显式排除。**
实测 `【主角档案】`（chunkCount=11）：`storyScript` 有 11 条 chunk 级 + **16 条 batch 级**；
`locationTree` 有 2 条（主 + `:batch:0`）、`plotLocationMerge` 有 3 条、`characterAppearance` 有 41 条。
若不过滤 `:batch:`，动作数会从 **8015 虚高到 14319**（多算 6304 条，且都是重复的中间产物）。
`pickResult()` 里用 `isVariant()` 统一排除，不依赖「主记录恰好排在最前」的运气。

## 图片常驻（`t2w://` 自定义协议）

演出与地图需要大图常驻，因此不用 base64 data URL（文件页的 `Thumb.vue` 仍用 data URL，够用即可）：

- 主进程注册 `t2w://<assetKey>/<entryPath>`，直接从**已读入内存的包 buffer** 按偏移切片返回，
  不落盘、不二次解码；响应带 `content-type` 与 `cache-control: public, max-age=31536000, immutable`，
  于是同一 URL 在 Chromium 侧只解码一次，来回切场景不会重新读包。
- `assetKey` = 包绝对路径的 sha256 前 16 位，随 `ViewData.assetBase` 下发，天然避免不同包串图。
- 渲染进程侧：`img-src` 与 `connect-src` 已放开 `t2w:`（见 `src/renderer/index.html` 的 CSP）。

## 模型接入（本阶段只有结构）

设置项固定为三个字段，**不绑定任何供应商、不假设"本地模型"**：

- `baseURL`（不含 `/chat/completions`，调用时自动追加）
- `apiKey`（`Authorization: Bearer <apiKey>`）
- `model`

设置保存在 Electron `userData/settings.json`，本阶段不发起任何网络请求。

## 后续规划

- `src/main/pipeline/`：按上游 DAG（`reading → entities ∥ events ∥ world ∥ impression → publish`）
  实现 29 条任务，其中 26 条为 LLM 调用、3 条（`merge` / `canonical` / `draftAlign`）为纯本地计算。
- `resources/prompts/`：把 36 个模板接入对应任务。

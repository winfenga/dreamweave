# feather 界面诊断与设计规范（P0 产出）

> 2026-10-17 · 「颜值」UI 改造 · 风格定案：**暖纸 · 苹果风**
> 诊断范围：styles.css（1769 行）+ App.vue + 全部 15 个组件 + main/index.ts + index.html
> 红线状态：**StageView.vue 的「零改动」约束由用户于 2026-10-17 解除**（放映厅也要浅色），
> 但仍守两条底线：①只动样式层，布局算法（缩放补偿、锚点、恒等基线契约）不碰，强耦合处回报；
> ②`dependencies` 恒为 `{}`，`core.mjs` 零改动。

---

## 1. 视觉方向定案（用户原话 + 设计落法）

- 背景 `#EDE4D8`（米白），强调 `#D9974C`（琥珀）——**整体不要黑色深色调**。
- 放映厅（演出舞台）同样转浅色，全应用统一。
- 交互按 Apple 风格：毛玻璃、胶囊选中、iOS 开关、分段控件、灵动过渡。
- 新增启动动画（splash，含羽毛笔品牌元素）。
- 用户手里有生图工具，需要素材时开清单（见 §7）。

### 1.1 「暖纸 · 苹果风」设计令牌（v1）

```
--bg:            #EDE4D8   窗口底
--panel:         #FBF7F0   卡片/面板（比底亮半档）
--panel-2:       #F3E7D3   侧栏/顶栏/嵌入面（微深一档）
--panel-glass:   rgba(251,247,240,0.72)  毛玻璃面板底（配 backdrop-filter）
--border:        #E0D2BA
--border-strong: #C9B79E
--text:          #3A2E22   主文字（暖深棕）
--muted:         #6B5B48   次文字
--faint:         #9C8B76   弱文字/占位
--accent:        #D9974C   琥珀
--accent-strong: #C4823B   琥珀 hover
--accent-soft:   #F6E3C8   琥珀选中底
--accent-ink:    #FFFFFF   琥珀底上的文字
--ok:            #4E9A5F   成功（暖化后的绿）
--warn:          #B98A2F   警告
--bad:           #C2554B   危险（暖化后的红）
--shadow-1:      0 1px 3px rgba(90,70,45,0.10)
--shadow-2:      0 6px 20px rgba(90,70,45,0.14)
--radius-window: 14px / --radius-card: 12px / --radius-btn: 9px / --radius-pill: 999px
--dur-fast: 130ms / --dur: 180ms / --spring: cubic-bezier(0.34, 1.3, 0.5, 1)
```

### 1.2 Apple 交互要素落点

| 要素 | 落点 |
|---|---|
| 毛玻璃 | 顶栏、地图工具条、图例、对话框（`backdrop-filter: blur(14px) saturate(1.4)`） |
| 胶囊选中 | 侧栏项、tab、章节页码，选中 = 琥珀胶囊 + 180ms ease |
| 按压回弹 | 全部按钮 `:active { transform: scale(0.97) }`，spring 曲线 |
| iOS 开关 | 设置页音量类布尔项、舞台自动播放 |
| 分段控件 | 脚本编辑器类型筛选、书库排序方向 |
| 弹性 hover | 卡片 `translateY(-1px) + shadow-2`，节点 hover 已有 translateY 保留 |

---

## 2. 现状诊断（问题清单）

### 2.1 全局层（styles.css）

- **P1｜主题色硬编码散布**：全库约 50 处硬编码深色（`rgba(11,14,18,*)`、`#0a0d11`、
  `#0f1319`、`#cfe0ff`、`#8fb6ff` 等），分布在 StageView(13)、ScriptEditor(18)、
  EffectBlock(5)、ProviderListEditor(4)、MapView(1, JS 内联样式)、SearchSelect(2)、
  EffectPicker(1) + styles.css 内 `#cfe0ff/#dbe2ea` 等多处。换浅色主题必须逐一收编为令牌。
- **P1｜main/index.ts:40 `backgroundColor: '#0f1216'`**：窗口底色硬编码深色，启动白闪的根源之一，需同步改 `#EDE4D8`。
- **P2｜字号无系统**：11 / 11.5 / 12 / 12.5 / 13 / 13.5 / 14 / 15.5 / 17 / 20 / 26 / 30 / 72 / 92px 混用。演出页大字保留，工作区收敛为 11 / 12 / 13 / 15 / 17 / 20 六档。
- **P2｜间距无系统**：6/7/8/10/12/14/16/18/20/24/28px 混用，收敛为 4px 基数（4/8/12/16/20/24/32）。
- **P3｜控件状态残缺**：`.btn` 缺 `:active` 回弹与 focus-visible；`.field input:focus` 只换边框色无光环；badge 无 hover；`.select` 无 hover。
- **P3｜滚动条**：未定义样式，浅色主题下默认滚动条突兀，需 `::-webkit-scrollbar` 暖棕细滚动条。
- **P3｜`.tabs` 平铺按钮无容器感**：改为 macOS 分段控件形态（整条胶囊 + 滑块式选中）或侧栏化（见 §3）。

### 2.2 逐页

| 页面 | 问题 |
|---|---|
| 书库 LibraryView | 表格边框生硬、空态只有 emoji+文字，操作按钮挤在一格；无排序（P1 缺口） |
| 概览 SummaryView | `.card h2` 全大写英文风格与暖纸气质不符；stats 卡片单调；校验徽章三连挤在一行 |
| 任务面板 ParsePanel | 徽章连排（成功/失败/跳过/本地/运行/待跑 六连）视觉噪音大；失败明细区块弱 |
| 阅读 ReadingView | 正文 `#dbe2ea` 硬编码；章节导航 active 态是深蓝底，需琥珀胶囊；正文行高 1.95 良好保留 |
| 地图 MapView | 画布径向渐变蓝紫氛围与暖纸冲突；工具条/图例深底浮层；节点底 `rgba(30,36,46,.94)` 硬编码；搜索框 JS 内联 `#0f1319` |
| 印象 ImpressionView | 紫色虚线根框 + 深色盒底，需整体换暖色系（保留类型色相区分，只调明度适配浅底） |
| 舞台 StageView | 全屏背景 `#06080b`、退出钮深底、模态遮罩深黑、打字光标 `#cfe0ff`、场景名暗金 `#c2a14d`——全部转暖纸浅色系；布局契约（--ui-scale、--fx-*、transform-origin、clamp 宽度公式）**一律不动** |
| 脚本 ScriptEditor | 18 处硬编码色 + 深色预览框，scoped 内整体换令牌 |
| 设置 SettingsPanel | 结构清晰问题小；色板格子、滑杆需换肤；布尔项可升级 iOS 开关（P3 可选） |

### 2.3 特效层（P4 fx-*）处置原则

特效层（fx-overlay/fx-text/fx-flash、move/battle）是**演出内容**而非 UI，黑场 letterbox、血色
vignette、爆闪等语义色保持原样——它们叠在舞台画面上，与主题无关。只把外层容器边框、
move-card 深底等「UI 性质」的部分换到暖纸令牌。

---

## 3. 结构升级：顶栏 → 侧栏（Apple 味的关键）

现状 11 个 tab 平铺顶栏，这是「工具感」的最大来源。改为 **macOS 风侧栏**：

```
┌────────┬──────────────────────────┐
│ 侧栏    │  顶栏（毛玻璃，拖拽区）      │
│ 书库    ├──────────────────────────┤
│ 概览    │                          │
│ 地图    │      内容区               │
│ 印象    │                          │
│ 演出    │                          │
│ 脚本    │                          │
│ 阅读    │                          │
│ 章节    │                          │
│ 实体    │                          │
│ 文件    │                          │
│ ────   │                          │
│ 设置    │                          │
└────────┴──────────────────────────┘
```

- 侧栏 `--panel-2` 底 + 琥珀胶囊选中 + 分组分隔线；顶栏瘦身为毛玻璃拖拽条（书名居中）。
- **titleBarStyle: hiddenInset** + 自绘窗控是苹果味的门票，但涉及窗口拖拽区 `-webkit-app-region` 重排，
  属结构改动 → 与启动动画一起放 P1（见 §5 顺序理由）。
- `App.vue` 的 Tab 联合类型、testid、事件流全部保留；`data-testid` 一个不减（验证脚本依赖）。

---

## 4. 启动动画方案（用户需求 ④）

- **形态**：`index.html` 内联 splash 层（零依赖、首帧即现）——米白底 + 羽毛笔图形
  （内联 SVG，后续可换生图素材）+ 琥珀描边自绘动画；主进程 `ready-to-show` 后窗口淡入，
  splash 800ms 内淡出移除（最短展示 600ms，防闪跳）。
- **主进程配合**：`main/index.ts` 窗口 `show: false` 已有，`backgroundColor` 同步换暖纸色，
  保证首帧无白闪无黑闪。
- **不做**：独立透明 splash 窗口（复杂度高收益小）；依赖图片文件的 splash（首帧前加载不可靠）。

---

## 5. 实施顺序（P1→P3，每步一提交）

1. **F1 令牌层 + 全局基础件**：styles.css 顶部令牌重写 + body/滚动条/按钮/输入/徽章/table/card 全量换肤 + 六态补齐。typecheck+build。
2. **F2 逐组件硬编码收编**：MapView 内联搜索框 → CSS 类；ScriptEditor / EffectBlock / EffectPicker / SearchSelect / ProviderListEditor 硬编码色 → 令牌。
3. **F3 舞台转浅色**：StageView scoped 样式层换肤（布局契约不动）；styles.css 演出段同步；特效层按 §2.3 原则保留。**用户已授权，强耦合处回报。**
4. **F4 侧栏改造**：App.vue 布局重排 + styles.css 侧栏/分段控件样式。testid 全保留。
5. **F5 启动动画**：index.html splash + main/index.ts 配合（backgroundColor/淡入）。
6. **G1 顶栏全屏按钮**：调现成 `window.feather.toggleFullScreen()`（preload:80 已就绪），顶栏加按钮 + `onFullScreenChanged` 同步图标。
7. **G2 书库排序**：表头点击排序（书名/章节/字符数/体积/导入时间），localStorage 记忆选择。
8. **G3 强制重跑**：`parseStart(pkgId, range)` → 编排器 `OrchestratorOptions` 加 `force?: boolean`，
   `runInstance` 幂等判断（orchestrator.ts:397）改为 `!force && prev?.status==='succeeded' && …`；
   ParsePanel 加「强制重跑」按钮（danger 样式，带 confirm）。**改的是 orchestrator.ts 与 IPC 透传，非 core.mjs。**
9. **G4 任务面板耗时列**：`TaskState` 加 `elapsedMs?: number`；orchestrator `runInstance` 记
   `Date.now()` 差值随 `setState` 落盘；tasksOverview 透出；ParsePanel 表格加「耗时」列（旧数据无值显示 —）。
10. **P3 精修**：逐页过间距/层级/徽章降噪（六连徽章→紧凑计数），最终 typecheck+build+验证脚本。

每个 F/G 步骤独立 git 提交，消息带 `UI:` 或 `FEAT:` 前缀，随时可断可回退
（基线标签 `ui-baseline-20261017`）。

---

## 6. 验证口径

- 每步：`npm run typecheck` + `npm run build`。
- 涉 IPC/编排的 G3/G4：跑相关 verify 脚本 + FEATHER_USER_DATA 隔离目录实机验证，
  **绝不碰用户 7 本真实工作库**。
- testid 回归：G 步骤不得删除任何 `data-testid`。

## 7. 生图素材清单（给用户的采购单，可选）

| 素材 | 用途 | 规格 | 优先级 |
|---|---|---|---|
| 羽毛笔 logo（暖棕/琥珀线条，透明底） | 启动动画 C 位、侧栏顶部、关于页 | 1024×1024 PNG 透明底 | 高 |
| 应用图标（macOS 圆角方形风） | 任务栏/窗口图标 | 512×512 PNG | 中 |
| 暖纸纹理（极淡纸张肌理，可平铺） | 窗口底可选质感 | 512×512 可平铺 PNG | 低（无也成立） |

有素材就换真图，没有就用内联 SVG 兜底，两条路都通。

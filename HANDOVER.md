# 羽毛笔·桌面版（feather）交接清单 — P1+P2 Galgame 演出引擎与音频系统

> 交接时间：2026-10-15 · 作者：feather-builder · 状态：**功能代码基本写完，音频播放有 1 个未修复的头号卡点，验收未全绿**

## 0. 一分钟总览

- P1（演出引擎 Galgame 化）8 项里 7 项完成并验证通过，第 8 项「自动播放节奏」因音频数据面 bug 卡死。
- P2（音频系统）4 项代码全部完成，但「包内配音播放」在**长音频文件**上不可用（详见 §3）。
- 仓库**不是 git 仓库**（tx/ 与 feather/ 都没有 .git）——原计划 3 个 commit 一个都没提交过，所有改动都在工作区。
- dev 栈当前以 `env -u ELECTRON_RUN_AS_NODE npm run dev -- --remote-debugging-port=9222` 运行中，CDP 9222 可达。
- 测试包：`D:/aaaTemp/基督山伯爵 · 前十章｜归航与陷阱 (1).t2w`（1977 actions / 69 dubbing clips / 21 portraits / 248 个成员全部 sha256 通过）。

## 1. 原始规格 17 项逐项状态

### P1 演出引擎 Galgame 化
| # | 项 | 状态 | 说明 |
|---|----|------|------|
| 1 | 流式打字机 `lib/typer.ts` | ✅ | verify-stage ① PASS（逐字增长 + 一键显全） |
| 2 | 点击推进（先显全再下一句） | ✅ | ② PASS |
| 3 | 右键隐藏/恢复对话框 | ✅ | ③ PASS |
| 4 | 立绘放大模态（全量立绘+形象 tab） | ✅ | ⑥ PASS（含多立绘角色 tab 切换、图片解码） |
| 5 | 对话框双模 normal/transparent | ✅ | ⑦ 已修 IPC 克隆 bug（见 §3.2），**待复跑确认** |
| 6 | 舞台缩放 0.7–1.6 步进 0.05 | ✅ | ④ PASS（含边界夹紧 + UI 同步） |
| 7 | 分级名牌配色（importanceLevel） | ✅ | ⑤ PASS（MEDIUM → rgb(157,245,192) 与设置色值一致） |
| 8 | 自动播放节奏 配音→TTS→定时器 | ❌ | 配音路径卡死（§3.1）；TTS/定时器路径被 autoRunning 卡死连带挂掉（§3.3） |

### P2 音频系统
| # | 项 | 状态 | 说明 |
|---|----|------|------|
| 9 | `StageAudioController` 包内配音播放 | ❌ | 代码完整，但长 clip 播到 ~11.9s  stall、`ended` 不触发（§3.1） |
| 10 | TTS `speak()` sha256 缓存（主进程） | ✅ | `tts:speak` IPC + 缓存 + `cache://tts/<sha>.mp3`；未配置时返回可读错误 |
| 11 | BGM 选择/播放/循环/音量 | ✅ | `media:pickBgm` + `resolveBgm` + `setBgm`；自动播放拦截时静默 |
| 12 | 音量 voice/bgm | ✅ | 设置滑块 → `setVolumes` 实时生效 |

### 数据层 + 协议 + 设置
| # | 项 | 状态 | 说明 |
|---|----|------|------|
| 13 | ModelSettings/ViewData 扩展 | ✅ | dialogMode/stageZoom/autoplayPolicy/roleColors/voiceVolume/bgmVolume/bgmPath + TTS 模型接入配置 |
| 14 | characterPortraits 全量 + `:characterAppearance` 合并 | ✅ | 21 portraits、多形象角色（老唐太斯）进模态 |
| 15 | importanceLevel / aliases | ✅ | 分级分布 {CORE:4, HIGH:8, MEDIUM:6, LOW:2}，别名进模态 |
| 16 | `cache://` 协议（限 tts/ 与 bgm/ + 路径穿越防护） | ✅ | 非法路径 403 实测 |
| 17 | `t2w://` Range 支持 | ✅ | 206 + content-range + 后缀范围 `bytes=-16` 实测通过 |

## 2. 验证结果（按最后实际运行）

| 验证 | 结果 | 关键输出 |
|------|------|----------|
| `npm run typecheck` | ✅ 通过 | exit 0（最新改动后跑过） |
| `npm run build` | ❌ 未跑 | 最新改动后没跑过 |
| `npm run verify:t2w` | ✅ 通过 | 1814/1814 passed, 0 failed（单包导入 verify 248/248） |
| `npm run verify:views` | ⚠️ 存疑 | 第 6 节曾因 fetch bug 改为 XHR，协议修复后已还原为 `fetch(u)` 版本且 `node --check` 通过，但**未完整复跑确认 exit 0** |
| `npm run verify:stage` | ❌ PASS 27 · FAIL 7 · SKIP 0 | 失败项见下 |

verify:stage 失败项原文（最后一次运行）：
1. `保存后面板关闭且已生效 — 保存=true 关闭=true 提示「undefined」面板已关=true` → IPC 克隆 bug，**已修**（SettingsPanel.vue `roleColors: { ...roleColors.value }`），未复跑
2. `transparent 模式：对话框带 dialog-transparent — class="stage-textbox t-say" data-testid=dialog-normal` → 同根因，未复跑
3. `自动播放按配音节奏推进 — 角标「🔊 配音」，20288ms` ← 头号卡点
4. `TTS 未配置 → 定时器兜底且不卡死 — 角标「」，20304ms` ← 连带卡死
5. `角标说明回退原因 — 「」` ← 连带
6. `定时器策略正常推进 — 角标「」` ← 连带（纯定时器不涉音频也挂，证明是 autoRunning 卡死传染）
7. `运行期无异常 / 无 console.error — 5 条`（3 条陈旧诊断日志 `cache://tts/deadbeef.mp3`(404)、`cache://evil/x.mp3`(403)、`t2w://nohost/x.png`(404) + 1 条克隆异常 + 1 条重复 404）

已通过项：①②③④⑤⑥、设置面板区块齐全、暂停静止、playing 置假、⑩ Range 三项、无网络层失败。

### 2.1 今天新拿到的根因证据（probe-audio.mjs，务必看）

对同一个 31.104s / 195864 字节的配音 clip，三条播放路径**全部** stall：

```
[exp1 控制器 playClip] {"raced":{"timeout":true},"elapsed":12010,
  "el":{"readyState":4,"networkState":1,"errorCode":null,"paused":false,"currentTime":11.8,"duration":31.104}}
[exp2 裸 Audio 立即 play] {"timeout":true,"readyState":4,"networkState":1,"currentTime":11.94}
[exp3 裸 Audio 先等元数据] {"played":{"timeout":true,"readyState":4,"currentTime":11.93}}
[fetch 对照] {"status":200,"ct":"audio/mpeg","len":195864,"cl":"195864"}
```

- `networkState=1`（IDLE，加载已完成）、`readyState=4`（HAVE_ENOUGH_DATA）、`paused=false`、`error=null`，但 currentTime 冻结在 ~11.9s——**不是缓冲等待，是解码数据耗尽/损坏**。
- 早前实测：3.096s / 15840 字节的**短** clip 能正常 `ended:true`。→ 长文件才暴露。
- fetch 拿到的 length 正确，但**字节内容未校验**。高度怀疑 `readEntry()` 返回的 Buffer subarray 视图（byteOffset≠0）在经 `protocol.handle` → `new Response(view)` 时字节错位或被截断。

## 3. 当前卡点（按优先级）

### 3.1 头号：t2w:// 长音频数据面损坏（file:line）
- `src/main/t2w/index.ts:66` — `readEntry()` 返回 `buf.subarray(offsets[idx], offsets[idx] + f.size)`（非零 byteOffset 的 Buffer 视图）。
- `src/main/asset-protocol.ts:171` — 该视图直接 `return rangeResponse(buf, ...)` → `new Response(body, ...)`。
- 现象：长 clip 播放 ~11.9s 后 stall（见 §2.1）。**未验证**：renderer fetch 到的字节与 Node 直读 .t2w 的字节是否一致。
- 注意：图片（`<img>`）和 fetch JSON 都正常，说明错位若存在也只影响大 body/媒体管线的路径，别被"图片正常"误导。

### 3.2 已修待复跑：Vue 3.5 ref 代理导致 IPC 结构化克隆崩溃
- `src/renderer/src/components/SettingsPanel.vue`（save 内）— `roleColors.value` 是 reactive() 代理，直接传给 `ipcRenderer.invoke` 报 `An object could not be cloned`。已改为 `roleColors: { ...roleColors.value }` 并留注释。**未复跑 verify:stage ⑦ 确认。**

### 3.3 autoRunning 卡死传染（连带 ⑨ 全挂）
- `src/renderer/src/components/StageView.vue:281-296` — `autoLoop()` 一旦 `await waitForPace(a)` 不返回，`finally` 不执行 → `autoRunning` 恒为 true → 之后所有 autoplay 点击因 `if (!autoRunning)` 为假而不再启动循环。这就是 ⑨ 连纯定时器策略都挂的原因。修完 3.1 后建议给 `autoLoop` 加 watchdog 兜底。

### 3.4 验收脚本噪音
- `scripts/verify-stage.mjs` — `Page.reload` 之后没有清空 `runtimeErrors` / `netFailures`，我此前诊断脚本产生的 404/403 被 CDP 回放混进 ⑪。修法：reload 的 `sleep(2500)` 之后 `runtimeErrors.length = 0; netFailures.length = 0`。
- 另：`feather_stage_transparent.png` 上一版拍到的还是设置面板内容（transparent 生效失败的同根因），修完 3.2 复跑即可。

## 4. 接手人第一步干什么

1. **先证伪/证实数据面**（最高优先级，半小时内）：
   ```bash
   # Node 侧直读 .t2w（用 core.mjs 的 decodeHeader/computeOffsets）拿到那个 mp3 的 sha256；
   # dev 栈里 fetch('t2w://<key>/<path>') 拿 arrayBuffer 算 sha256，两者比对。
   ```
   不一致 → 在 `src/main/asset-protocol.ts` 的 `rangeResponse()` 里把视图拷贝成连续 buffer 再进 Response（如 `Buffer.from(body.buffer, body.byteOffset, body.byteLength)` 或 `Uint8Array.prototype.slice`），重启 dev 栈，跑 `node scripts/probe-audio.mjs`，exp2 应出现 `{"ended":true}`。
2. 给 `StageView.vue` 的 `autoLoop` 加 watchdog（或 `waitForPace` 整体包超时），保证任何情况下 `autoRunning` 都能复位。
3. `verify-stage.mjs` reload 后清空两个错误数组；复跑至 11 项断言全绿、4 张截图齐（stream/transparent/modal/settings）。
4. 回归：`npm run typecheck` → `npm run build` → `npm run verify:t2w` → `npm run verify:views`。
5. `git init` 后按原计划分 3 个 commit（①数据层+协议+设置 ②演出引擎 ③验收脚本与截图）。

## 5. 改动文件清单

### 新建
- `src/main/tts/index.ts` — TTS speak + sha256 缓存
- `src/main/media/index.ts` — BGM 文件选择
- `src/main/cache-protocol.ts` — cache:// 协议（CACHE_PRIVILEGE + 路径穿越防护）
- `src/renderer/src/lib/typer.ts` — 流式打字机
- `src/renderer/src/lib/stageAudio.ts` — StageAudioController
- `src/renderer/src/lib/stageColors.ts` — 分级配色
- `scripts/verify-stage.mjs` — 11 项断言 + 4 截图（主交付物）
- `scripts/probe-dubbing.mjs` / `probe-dubbing2.mjs` / `probe-stage.mjs` / `probe-stage2.mjs` / `probe-stage3.mjs` / `probe-audio.mjs` / `smoke-view.mjs` — 探针（可删，probe-audio.mjs 建议留到卡点修完）

### 修改
- `src/main/index.ts` — **重大 bug 修复**：两次 `registerSchemesAsPrivileged` 合并为一次（分多次调用只有最后一次生效，导致 t2w 丢掉 supportFetchAPI，renderer `fetch()` 全挂）
- `src/main/asset-protocol.ts` — 导出 ASSET_PRIVILEGE；rangeResponse/preflightResponse/audioMimeOf
- `src/main/ipc/index.ts` — `tts:speak` / `media:pickBgm`
- `src/main/settings/store.ts` — 新设置项持久化
- `src/preload/index.ts` — speak/pickBgm/resolveBgm 暴露
- `src/renderer/src/App.vue` — `content-flush` 加 `!showSettings` 条件（否则设置面板「保存」点不到）；设置按钮 testid
- `src/renderer/src/components/StageView.vue` — Galgame 演出引擎主体（打字机/点击推进/右键隐藏/缩放/分级色/自动播放/立绘模态）
- `src/renderer/src/components/SettingsPanel.vue` — TTS/音频/演出设置区块 + §3.2 克隆 bug 修复
- `src/renderer/index.html` — favicon `data:,`（消除 dev 404 污染 console）
- `src/renderer/src/lib/viewModel.ts` — dubbingByKey 等查找表
- `src/shared/app-types.ts` — ModelSettings 扩展
- `package.json` — `verify:stage` / `smoke:view` 脚本
- `scripts/verify-views.mjs` — 第 6 节 Range 断言（曾临时改 XHR，已还原 fetch）

## 6. 环境备忘

- dev 启动：`cd feather && env -u ELECTRON_RUN_AS_NODE npm run dev -- --remote-debugging-port=9222`（shell 带 ELECTRON_RUN_AS_NODE 时必须 -u）
- 截图前必须 `Page.bringToFront`，否则 captureScreenshot 挂死（verify-stage.mjs 已内置 bringToFront + 3 重试 + 15s 超时）
- CDP `Input.dispatchMouseEvent` 才产生 user activation；程序式 `el.click()` 不产生
- dev 栈不 reload，UI 状态跨脚本运行残留——验收脚本启动先 `Page.reload`
- 不改 `src/main/t2w/core.mjs`；不硬编码 id 前缀；recon/ 只读；不做打包、不做 LLM 管线

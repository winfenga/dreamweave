# 音频「长片段卡死」调查 —— 结论：原判断是错的

> 调查时间：2026-11-04
> 触发：`HANDOVER.md` §3.1 把「`t2w://` 长音频数据面损坏」列为头号待修 bug
> 结论：**该 bug 不存在**。数据完好，`t2w://` 协议正常，长音频能完整播完。
> 真正的问题是 `pause()` 不触发 `ended` 导致的 promise 悬挂，已在 `stageAudio.ts` 修复。

---

## 0. 一分钟结论

原 `HANDOVER` 的判断链是：*长 clip 播到 ~11.9s 就 stall → 怀疑 `Buffer.subarray` 视图经
`protocol.handle` → `new Response(view)` 时字节错位或截断 → 建议在 `rangeResponse()` 里拷贝成连续 buffer。*

**这条判断在三个环节上都被证伪：**

| 环节 | 原判断 | 实测 |
|---|---|---|
| 数据完整性 | 怀疑解码数据耗尽/损坏 | 69 个片段逐帧解析，**0 坏帧**，Xing 头全对 |
| 视图传字节 | 怀疑 subarray 视图错位 | Node 侧三种传法 sha256 **全等于原文件** |
| 播放本身 | 长 clip 播不完 | 真实 Electron + 真实 `t2w://`，31.1s clip **完整 ended** |

真正原因见 §5。

---

## 1. 原始证据（`HANDOVER.md` §2.1）

对同一个 31.104s / 195864 字节的配音 clip，三条播放路径全部 stall：

```
[exp1 控制器 playClip] {"raced":{"timeout":true},"elapsed":12010,
  "el":{"readyState":4,"networkState":1,"errorCode":null,"paused":false,"currentTime":11.8,"duration":31.104}}
[exp2 裸 Audio 立即 play] {"timeout":true,"readyState":4,"networkState":1,"currentTime":11.94}
[exp3 裸 Audio 先等元数据] {"played":{"timeout":true,"readyState":4,"currentTime":11.93}}
[fetch 对照] {"status":200,"ct":"audio/mpeg","len":195864,"cl":"195864"}
```

关键误读点：**三个实验的 `elapsed` 全是 12000ms 左右**，而 clip 时长是 **31.104s**。

| 实验 | 超时预算 | 读到 currentTime | clip 时长 | 是否真播完 |
|---|---|---|---|---|
| exp1 控制器 | 12010ms | 11.8s | 31.104s | 否（被超时截断） |
| exp2 裸 Audio | 12000ms | 11.94s | 31.104s | 否（被超时截断） |
| exp3 等元数据 | 12000ms | 11.93s | 31.104s | 否（被超时截断） |
| 短 clip 对照 | 12000ms | 3.096s | **3.096s** | **是** |

`currentTime` 停在 ~11.9s **不是冻结，是探针在 12 秒时正常读取到的即时进度**。
短 clip（3.096s）能在 12s 内等到 `ended`，长 clip（31.1s）等不到 ——
于是被误读成「只有长文件暴露问题 → 一定是数据损坏」。

`readyState:4`（HAVE_ENOUGH_DATA）、`networkState:1`（IDLE）、`error:null`、`paused:false`
这四项其实**全部指向正常播放中**，当时被解读反了。

---

## 2. 数据面验证（`scripts/probe-audio-data.mjs`）

从样本包中取最长的配音片段（`1:45`，214968 字节）：

```
viewA byteOffset 37020599 byteLength 214968
viewA sha256 30a3e402...
copyB sha256 30a3e402...
manifest sha256 30a3e402...
视图与拷贝一致: true
与清单一致: true
直读 sha256 30a3e402... 一致: true

=== MP3 帧解析
解析到帧数 1363
解析长度 214968 / 文件长度 214968
坏帧位置 -1
推算时长 32.712 s
```

三条独立取字节路径（整包大 buffer 的 subarray、拷贝成连续 buffer、按偏移直读）**hash 完全一致**，
且与 manifest 里的 sha256 相符。**数据没有错位，也没有截断。**

---

## 3. 全量片段扫描（`scripts/probe-all-clips.mjs`）

对样本包内**全部 69 个**配音片段做逐帧 MP3 解析：

```
片段总数 69
有问题的片段数 0
Xing 帧数不符的片段数 0
Xing 字节数不符的片段数 0
```

HANDOVER 点名的那个 195864 字节片段（`1:5`）：

```json
{
  "key": "1:5", "size": 195864, "id3": 0,
  "frames": 1297, "duration": 31.128,
  "consumed": 195864, "badAt": -1, "trailing": 0,
  "declaredFrames": 1296, "declaredBytes": 195864, "hasXing": true
}
```

`declaredBytes` 与实际文件长度**精确相等**，`trailing: 0` 表示没有多余尾字节，
`badAt: -1` 表示全程无坏帧。**这个文件是完好的。**

---

## 4. 容器头深挖（`scripts/probe-mp3-header.mjs`）

怀疑过 VBR 的 Xing/TOC 表声明与实际不符导致 Chromium 算错时长：

```
=== Xing/Info 头
flags 00001111 声明帧数 1362 声明字节数 214968
文件实际字节数 214968
字节数一致: true
实际可解帧数 1363 解析长度 214968 停在哪 -1
TOC 单调递增: true
```

声明的字节数与文件长度精确一致；声明帧数 1362 vs 实际 1363 是 LAME 常见的差一（首帧不计入），
不影响播放。**容器头正常。**

---

## 5. 真实播放验证（`scripts/electron-audio-probe.cjs`）

最关键的一步：**用真实 Electron、真实 `t2w://` 协议、原样复刻应用侧代码**
（`readEntry` 的 subarray 返回形态 + `rangeResponse` 的 Range 处理），播放那个 195864 字节的片段。

```json
{
 "play": {
  "ended": true,
  "elapsed": 31340,
  "duration": 31.104,
  "currentTime": 31.104,
  "events": [
   ["waiting", 1, 0, 0, 2],
   ["durationchange", 10, 0, 1, 1],
   ["loadedmetadata", 10, 0, 1, 1],
   ["loadeddata", 259, 0, 4, 1],
   ["canplay", 259, 0, 4, 1],
   ["playing", 259, 0, 4, 1],
   ["canplaythrough", 259, 0, 4, 1],
   ["ended", 31340, 31.1, 4, 1]
  ]
 }
}
```

**`ended: true`，播放了 31340ms 直至 31.104s 终点。** 事件序列干净：
元数据 10ms 到位、数据 259ms 解码完、无 `stalled`、无 `waiting` 反复。

同时验证 Node 侧 `Response` 传子视图不掉字节（`scripts/probe-response-view.mjs`）：

```
master.length 4214968
view.byteOffset 1234567 view.byteLength 214968
[subarray-view]  len=214968 sha=30a3e402...  匹配原始 clip: true
[copied-buffer]  len=214968 sha=30a3e402...  匹配原始 clip: true
[uint8-slice]    len=214968 sha=30a3e402...  匹配原始 clip: true
```

**HANDOVER 建议的「拷贝成连续 buffer」修法没有必要**，三种传法字节都对。

---

## 6. 真正的 bug：`pause()` 不触发 `ended`

排除了数据面之后，问题落到 `StageAudioController.playClip()` 的**结算条件**上：

```ts
// 修复前：只有三种情况能让 promise 结算
const onEnded = () => done({ ok: true, ... })      // 播完
const onError = () => done({ ok: false, 'load-error' })
const timer = setTimeout(() => done({ ok: false, 'timeout' }), MAX_CLIP_MS)  // 120 秒
```

而 `stopVoice()` 只做 `pause()` + `currentTime = 0`：

```ts
// 修复前
stopVoice(): void {
  for (const a of this.voicePool) {
    a.pause()
    a.currentTime = 0
  }
}
```

**HTMLMediaElement 被 `pause()` 之后不会触发 `ended`。** 于是：

1. 自动播放进行中，用户按暂停 → `watch(playing)` 调 `audio.stopVoice()`
2. `playClip` 的 promise 因为没收到 `ended` 而**继续悬着**
3. `waitForPace()` 不返回 → `autoLoop()` 的 `await` 卡住
4. `autoRunning` 保持 `true`，直到 120 秒超时
5. 这 120 秒内再点「自动播放」，`if (!autoRunning)` 为假，**循环再也起不来**
6. 连纯定时器策略也被牵连（同一个 `autoLoop`）

这解释了 HANDOVER §3.3 记录的「`autoRunning` 卡死传染 ⑨ 全挂」现象 ——
**不是音频数据问题，是 promise 生命周期问题。**

### 修法

给每个进行中的播放登记一个会话，让任何主动打断都能显式结算它：

```ts
interface PlaySession {
  audio: HTMLAudioElement
  settle: (r: PlayClipResult) => void
}

private sessions = new Set<PlaySession>()

playClip(url) {
  // ...
  const done = (r) => { /* ...去重、清定时器、移出 sessions、resolve */ }
  session = { audio, settle: done }
  this.sessions.add(session)
  // ...
}

private cancelSessions(audio?, reason = 'cancelled') {
  for (const s of [...this.sessions]) {
    if (audio && s.audio !== audio) continue
    s.settle({ ok: false, reason, url: s.audio.src })
  }
}

stopVoice(): void {
  this.cancelSessions(undefined, 'cancelled')  // 先结算，再 pause
  for (const a of this.voicePool) { a.pause(); a.currentTime = 0 }
}
```

配套三层保险（`StageView.vue`）：
1. `waitForPace` 收到 `cancelled` 时不再走定时器兜底（打断不是失败）
2. `autoLoop` 每句独立 watchdog（120s），到点停声、跳过该句继续
3. `finally` 无条件复位 `autoRunning`

---

## 7. 验收脚本的连带修正

原 `verify-stage.mjs` 的 ⑧ 用固定 `40 × 500ms = 20s` 轮询等「自动播放推进」，
而样本包配音最长 **33 秒** —— **必然超时失败**。这不是产品 bug，是测试预算不足。

修法：先用 `loadedmetadata` 量出该句 clip 的真实时长，再按
`max(25s, clipMs + 12s)` 定预算，并把实际用时打进断言说明。

另修 HANDOVER §3.4 记录的问题：`Page.reload` 之后清空 `runtimeErrors` / `netFailures`，
避免 CDP 回放上一轮的诊断 404/403 造成假失败。

---

## 8. 复现方式

```bash
# 1) 数据面（纯 Node，不需要 Electron）
node scripts/probe-audio-data.mjs   "testdata/monte-cristo-10ch.t2w"
node scripts/probe-all-clips.mjs    "testdata/monte-cristo-10ch.t2w"
node scripts/probe-mp3-header.mjs

# 2) Node 侧 Response 传字节
node scripts/probe-response-view.mjs

# 3) 真实 Electron 播放（需真实窗口，不能在受限沙箱里跑）
npx electron scripts/electron-audio-probe.cjs "testdata/monte-cristo-10ch.t2w" 195864
```

> ⚠️ Electron 在受限沙箱下启动会直接崩（`exit 0x80000003`），
> 第 3 步需要在完全权限环境运行。

---

## 9. 教训

1. **超时预算是测试的一部分**：用固定超时等一个可能比超时更长的操作，
   得到的「失败」是测试的失败，不是产品的失败。
2. **`readyState:4` / `error:null` / `paused:false` 是「正在正常播放」的证据**，
   不应被解读成「解码数据耗尽」。
3. **先证伪最贵的假设**：原计划要改 `rangeResponse` 的字节处理（影响所有 `<img>`/`<audio>`），
   但先花十分钟比对 sha256 就能排除它。
4. 一个 promise 悬挂会顺着 `await` 链污染整个状态机（`autoRunning`），
   所以「可取消」应当是这类等待型 API 的一等公民。

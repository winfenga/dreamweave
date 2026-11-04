# testdata — 本地测试用 .t2w 包

`.t2w` 是 DreamWeave 的输入容器格式（`txt2world-package-v1`），见仓库根 `README.md`。
本目录的包**不入库**（`.gitignore` 里 `testdata/*.t2w`），因为单个 5–91MB、且属外部作品素材。

## 当前本地已就位

| 文件 | 体积 | 说明 |
|---|---|---|
| `monte-cristo-10ch.t2w` | 83.6 MB | 《基督山伯爵 · 前十章｜归航与陷阱》。**验收主用包**：1977 条动作 / 69 条配音 / 21 个立绘形象 / 39 张场景图 / 248 个成员 |

## 为什么用这个包做验收

它是现有样本里数据面最全的一份，能同时覆盖：

- `storyScript` 多 chunk 合并（含 `:batch:` 变体必须排除的坑）
- `plotLocationMerge.idMap` 的「合并前 id → 合并后 id」桥接（场景图靠它才能配上）
- `locationTree` / `impressionLayout`（地图互动、印象图谱）
- `:dubbing:clip:*` 包内配音 —— **长音频验收的唯一来源**（最长 33s，见下方注意事项）
- `characterAppearance` 多形象角色（老唐太斯多套立绘）
- 完整 `importanceLevel` 分布（CORE/HIGH/MEDIUM/LOW）

## 注意事项（踩过的坑）

**1. 验收脚本的等待预算必须按音频实际时长算。**
该包配音最长 33 秒。早期 `verify-stage.mjs` 用固定的 20 秒轮询预算等「自动播放推进」，
遇到 30s+ 的 clip 必然超时失败 —— 曾被误判成「长音频数据面损坏」，实际数据完好。
现在脚本先 `loadedmetadata` 量出 clip 时长，再按 `时长 + 12s` 定预算。

**2. 该包同时存在主记录与中间产物变体。**
如 `storyScript:0` … `storyScript:10`（每个 chunk 一条）+ 16 条 `:batch:` 变体。
解析时**必须排除** `:batch:` / `:grouped:` / `:plan` / `:repair`，否则动作数会从 8015 虚高到 14319。
详见 `src/main/t2w/view.ts` 顶部注释。

## 换包测试

换其他 `.t2w` 时可直接放进本目录，验收脚本支持传路径：

```bash
npm run verify:t2w -- "testdata/你的包.t2w"
npm run verify:stage
```

`verify:stage` 默认读 `D:/aaaTemp` 下的路径，换包时改 `scripts/verify-stage.mjs` 的
`const P = process.argv[2] ?? '...'` 默认值，或直接传参。

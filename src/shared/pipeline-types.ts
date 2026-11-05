/**
 * LLM 解析流水线（pipeline）共享类型 —— 主进程与 renderer 可共用（纯类型，无运行期导入）。
 *
 * 设计依据：`docs/增量设计_存储重构与解析链路.md` §3.3（TS 类型）、§6.1~§6.10（编排/分批/多配置/写并发）。
 */
import type { TaskState } from './workspace-types'

// ---------------------------------------------------------------------------
// 任务注册表（`resources/pipeline/task-registry.json`，29 条）
// ---------------------------------------------------------------------------

/** 单条任务定义（照抄 recon `oo` 表字段）。 */
export interface TaskDef {
  id: string
  kind: string
  code: string
  label: string
  /** 功能门：always / any / events / visualNovel / entities / characters / … */
  feature: string
  /** 执行说明（自然语言，供 UI 展示） */
  execution: string
  input: string
  output: string
  /** true = 真 LLM 调用；false = 纯本地程序步骤（merge / canonical / draftAlign） */
  model: boolean
  thinking: 'enabled' | 'disabled'
  effort: number
  maxTokens: number
  /** true = 全书一次（全局单例）；false = 每个 chunk 一个实例 */
  global: boolean
  setting: string
  /** 依赖声明（后缀语义见 `dag.ts` / 设计 §6.2） */
  dependsOn: string[]
}

// ---------------------------------------------------------------------------
// 分批（L2 单次输入预算）
// ---------------------------------------------------------------------------

export interface BatchingConfig {
  /** L2 单次输入预算（token）。默认 8000，可配 4000–24000 */
  inputBudgetTokens: number
  /** 递归最大深度（默认 3） */
  maxDepth: number
  /** 不可切分单元超预算时是否放行（默认 true） */
  allowOversizeUnit: boolean
}

/** 一个批次（payload 为待喂入 LLM 的文本片段）。 */
export interface BatchUnit {
  index: number
  tokenEstimate: number
  /** 该批是「不可切分单元且超预算」的放行批 */
  oversize: boolean
  payload: string
}

export interface BatchPlan {
  depth: number
  batches: BatchUnit[]
  /** 是否需要（继续）分批：batches.length<=1 且无放行批 → true */
  converged: boolean
  warnings: string[]
}

/** 一轮分批决策留痕（供 verify / 日志观察「切批→调 LLM→合并→再切」轨迹）。 */
export interface BatchTraceStep {
  depth: number
  batchCount: number
  tokenEstimates: number[]
  oversizeCount: number
  warnings: string[]
}

// ---------------------------------------------------------------------------
// 多配置 / 探活 / fallback（N-4~N-8）
// ---------------------------------------------------------------------------

export type ProviderKind = 'llm' | 'tts'

/** 一条 LLM 配置（任意 OpenAI 兼容，不绑定供应商）。 */
export interface LlmProvider {
  id: string
  label: string
  baseURL: string
  apiKey: string
  model: string
  enabled: boolean
  /**
   * provider 类型标签（决定输出上限二选一字段）：
   * minimax / mimo → `max_completion_tokens`；其它（含 custom）→ `max_tokens`。
   */
  providerKind?: string
}

/** 一条 TTS 配置（多一组 voice）。 */
export interface TtsProvider extends LlmProvider {
  voice: string
}

/** 多配置总表。 */
export interface ProviderSettings {
  llm: LlmProvider[]
  tts: TtsProvider[]
  activeLlmId: string
  activeTtsId: string
  /** 失败时按序换 LLM；空 = 仅在 llm[] 内轮询启用项 */
  fallbackChain: string[]
}

/** 探活结果（可读）。 */
export interface ProbeResult {
  ok: boolean
  httpStatus?: number
  ms?: number
  error?: string
}

/**
 * 模型探测结果：问端点「你有哪些模型」。
 *
 * 与 `ProbeResult`（探活）是**两件事**，用途也不同：
 *   - 探活：用**已填的 model** 发一次最小对话请求，验证「这组配置现在能不能真的跑」；
 *   - 探测：单独 `GET /models`，验证「这个端点的 Key 对不对、有哪些模型可选」。
 *
 * 分开的理由：填模型之前没法探活（没 model 必然失败），但那时**恰恰最需要**知道
 * 端点上有哪些模型名可用 —— 否则用户只能靠猜或去别处查文档。
 */
export interface ModelListResult {
  ok: boolean
  /** 探测到的模型 id 列表（按 id 排序；端点返回顺序不稳定，排序后便于扫读） */
  models?: string[]
  /** owned_by 归属（模型 id → 归属），部分端点不返回 */
  owners?: Record<string, string>
  httpStatus?: number
  ms?: number
  error?: string
  /** 端点的 baseURL（便于确认探测的是哪一组） */
  baseURL?: string
}

// ---------------------------------------------------------------------------
// 消息 / 用量
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface TokenUsage {
  input: number
  hit: number
  miss: number
  output: number
  raw: unknown
}

// ---------------------------------------------------------------------------
// attempts 留痕（每 taskId 一份分片，内含多次尝试）
// ---------------------------------------------------------------------------

export interface AttemptRecord {
  /** 唯一 id（append attempts 分片的条目 key） */
  id: string
  taskId: string
  instanceKey: string
  providerId: string
  model: string
  startedAt: string
  endedAt: string
  status: 'succeeded' | 'failed'
  usage: TokenUsage | null
  fingerprint: string
  /** 请求/响应原文 artifact 相对路径（相对工作库根；未落盘为 null） */
  requestPath: string | null
  responsePath: string | null
  communicationMs: number
  error: string | null
}

// ---------------------------------------------------------------------------
// 进度 / 状态（IPC）
// ---------------------------------------------------------------------------

export interface ParseProgress {
  runId: string
  pkgId: string
  phase: 'start' | 'task' | 'done' | 'error' | 'cancelled'
  taskId?: string
  instanceKey?: string
  status?: TaskState['status']
  done?: number
  total?: number
  message?: string
}

export interface ParseStatus {
  runId: string
  pkgId: string
  running: boolean
  done: number
  total: number
  tasks: Record<string, TaskState>
  error?: string
}

// ---------------------------------------------------------------------------
// 任务面板视图（T5）：29 个任务分组 + 实时状态 + 失败重跑 + 来源包历史
// ---------------------------------------------------------------------------

/**
 * 一个任务实例在本机状态表里的一条明细（面板「失败原因」列用）。
 * `key` = 实例键（`<pkgId>:<revisionId>:<taskId>[:<chunkIndex>]`），逐字透传。
 */
export interface TaskInstanceState {
  key: string
  status: string
  error: string | null
}

/** 状态计数（与 `TaskState['status']` 一一对应 + `pending` 表示「尚未跑」）。 */
export interface TaskCounts {
  succeeded: number
  failed: number
  skipped: number
  local: number
  running: number
  pending: number
  /**
   * 内容审查拦截的实例数（D3）。
   *
   * 与 `failed` 分开计：failed 可重试，blocked 重试无意义（同一内容换模型还是被拦）。
   * UI 应把 blocked > 0 渲染成醒目的「需人工处理」提示，而不是普通失败红点。
   */
  blocked?: number
}

/** 面板里的一行 = 注册表里的一个任务（不是实例）。 */
export interface TaskOverviewItem {
  id: string
  label: string
  kind: string
  /** 功能门（always / any / events / visualNovel / entities / …） */
  feature: string
  /** true = LLM 任务；false = 本地程序步骤 */
  model: boolean
  /** true = 全书一个实例 */
  global: boolean
  execution: string
  dependsOn: string[]
  /** 期望实例数（global ? 1 : chunksLen） */
  expected: number
  /** 本机已写入的实例数 */
  actual: number
  counts: TaskCounts
  /** 失败实例明细（仅 failed） */
  failures: { key: string; error: string }[]
  /**
   * 最近一次执行的平均耗时（毫秒，G4）：有 elapsedMs 的实例取平均，四舍五入；
   * 无任何已耗时实例（旧数据/未跑）→ null，面板显示「—」。
   */
  avgElapsedMs: number | null
}

/** 任务面板整体视图（`pipeline:tasksOverview` 的返回值）。 */
export interface TasksOverview {
  pkgId: string
  title: string
  /** 本机实例合计（各状态计数之和） */
  localTotal: number
  localCounts: TaskCounts
  /** 来源包自带历史条目数（不计入本机成绩） */
  inheritedTotal: number
  tasks: TaskOverviewItem[]
}

// ---------------------------------------------------------------------------
// 任务适配器运行期接口（adapter 只提供 buildInput/parse/mergeSemantics）
// ---------------------------------------------------------------------------

/** 一次 LLM 调用结果（已含 provider 与用量）。 */
export interface LlmCallResult {
  content: string
  providerId: string
  model: string
  usage: TokenUsage | null
}

/**
 * 原文按章切好的一片（供组装「带行号原文」）。
 * `seq` = 原书章节号（可能乱序跳号，勿当数组下标）；`text` = 按 byteStart/byteEnd 从原文资产切出的该章正文（UTF-8）。
 */
export interface ChapterSlice {
  seq: number
  title: string
  text: string
}

/**
 * 上游产物条目（聚合型适配器消费；真身见 `src/main/pipeline/upstream.ts`）。
 * key 形如 `<pkgId>:<revisionId>:<taskId>[:<chunkIndex>]…`（实例键，逐字透传）。
 */
export interface UpstreamEntry {
  key: string
  value: unknown
}

/** 传给任务适配器的运行期上下文。 */
export interface TaskRuntime {
  task: TaskDef
  pkgId: string
  revisionId: string
  /** 全局任务为 null；chunk 任务为 chunk 序号 */
  chunkIndex: number | null
  instanceKey: string
  chunkText: string
  /**
   * 本 chunk 的章节切片（按章切好的原文；全局任务为 undefined）。
   * 适配器据此组装「带行号原文」（各章从 1 重新编号）——避免依赖 chunkText 里的章节边界。
   */
  chunkChapters?: ChapterSlice[]
  /**
   * 工作库根（只读用途：聚合型适配器读上游产物）。
   * 可选：测试/合成 rt 可不挂；真身由 orchestrator.makeRuntime 注入。
   */
  root?: string
  /** 书名（index.title；worldImpression 等模板要用）。可选，同上。 */
  title?: string
  /** 读某任务在本工作库的全部产物条目（按插入序）；taskId 不存在 → 空数组 */
  readUpstream?: (taskId: string) => Promise<UpstreamEntry[]>
  /** 调用 LLM（内部含同配置退避重试 + 换配置 fallback + attempts 留痕） */
  llm(
    messages: ChatMessage[],
    opts?: {
      maxTokens?: number
      thinking?: 'enabled' | 'disabled'
      effort?: number
      /** 放开「不足 50 字 = 审查拦截」判定（见 `LlmTaskAdapter.allowShortOutput`） */
      allowShortOutput?: boolean
    }
  ): Promise<LlmCallResult>
  /** 读取并渲染提示词模板（缺失 → 抛可读错误） */
  render(name: string, vars?: Record<string, unknown>): Promise<string>
  /** 记一条运行日志（进度/调试） */
  log(message: string): void
  /** 本次实例的告警收集（如分批超额放行） */
  warnings: string[]
}

/** 一条 LLM 任务适配器。 */
export interface LlmTaskAdapter {
  id: string
  /** 单次输入来源（用于 L2 预算估算与语义切批） */
  inputText(rt: TaskRuntime): Promise<string>
  /** 用（可能被切批的）文本构造 messages */
  buildMessages(batchText: string, rt: TaskRuntime): Promise<ChatMessage[]>
  /** 机械合并策略（§6.7） */
  mergeStrategy: 'concat-dedup-order' | 'recon-merge' | 'recon-canonical'
  /** 去重稳定键（可选；缺省用 id/key/name 或 JSON 串） */
  keyOf?(part: unknown): string
  /**
   * 可选：**按任务覆盖 L2 分批配置**（T6-G ①，加性可选——未声明的适配器行为不变）。
   *
   * 仅用于**输出含跨批必碰撞的本地引用**的任务提高单批概率：如 lineAnnotation 的输出是
   * 「本地 id 地点目录 + 逐行引用本地 id」——L2 切批后各批模型各自从 l1 编号，**跨批
   * 本地 id 碰撞**，而合并发生在 parse **之前**的 raw 文本层面、无法事后消歧 → 行
   * 引用会错乱。真实生态该任务 maxTokens=120000 即单次调用；chunking 策略
   * targetTokens=42000 保证单 chunk ≤ ~42K tokens，lineAnnotation 声明
   * `{inputBudgetTokens: 100000}`（表达「单批意图 + 输入上界」，引擎上限日后上调时
   * 自动受益）。
   *
   * 【覆盖如何生效（T6-G 修正后，读前必知）】orchestrator 的合并算式
   * （`{...deps.batchingCfg, ...adapter.batching}`）**不经** `defaultBatchingConfig`
   * 的 `clampBudget`——覆盖值原样进 cfg；且 `planBatches` **信任 cfg 入参**（T6-G 修正：
   * 原先的二次夹紧会把覆盖值压回 L2 上限 24000 使覆盖失效，已修；仅防运行期脏值——
   * 非有限/非正数回退 `DEFAULT_L2_TOKENS`）。故显式覆盖**全量生效**：lineAnnotation 的
   * 100000 对 chunk ≤ ~42K tokens 稳定单批（大书逐行地点标注不再因切批碰撞而丢失）。
   * parse 侧防御（如 lineAnnotation 的重复本地 id 检测——引用置 null 不猜）仍是纵深防御。
   */
  batching?: Partial<BatchingConfig>
  /**
   * 可选：**该任务的设计输出本来就极短**，需放开「返回不足 50 字 = 审查拦截」的判定。
   *
   * 目前只有 `cacheWarming` 为 true——它的输出契约就是 `{"answer":"ok"}`（15 字符），
   * 而全局审查拦截规则按长度判定（<50 字即拒绝语），会把它的正确回答稳定判成拦截，
   * 导致整条流水线卡在第一个任务（详见 `llm-client.ts` 的 `ChatOptions.allowShortOutput`）。
   *
   * 未声明的适配器行为完全不变（加性可选字段）。
   */
  allowShortOutput?: boolean
  /**
   * 解析并校验模型输出。
   *
   * T6-F：签名加**可选第二参 `rt`**（加性可选，向后兼容——TS 中「少参数函数可赋给多参数
   * 签名」，现有 10 个适配器无需改动）。动机：plotLocation 需要按 chunk 分配**全局唯一
   * id**（`L-{chunk}-l{n}`，对齐真实生态 `L-0-l1`；模型自产 id 是 chunk 本地短 id
   * `l1`/`l2`，跨 chunk 会碰撞，必须由程序用 `rt.chunkIndex` 重编），而 parse 原本
   * 拿不到 chunkIndex。
   * 约束（写入即纪律）：`rt` 仅作**同步字段直读**（chunkIndex/pkgId/instanceKey/task/
   * chunkText/chunkChapters），**不得在 parse 里做异步 IO**（parse 是同步函数）——需要读
   * 上游产物的组装一律在 inputText/buildMessages 做。
   */
  parse(content: string, rt?: TaskRuntime): unknown
}

/** 一条本地程序步骤（model:false；不发请求）。 */
export interface LocalTaskStep {
  id: string
  run(rt: TaskRuntime): Promise<unknown>
}

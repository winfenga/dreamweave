/**
 * 解析编排器（设计 §6）。
 *
 * - 按 `dag.topoOrder()`（Kahn）执行；非 global 任务对每个 chunk 生成实例；`global:true` 全书一次；
 * - 3 条 `model:false`（merge/canonical/draftAlign）走本地程序步骤，**不发请求**，状态写 `'local'`；
 * - 真 LLM 任务经 **L2 分批引擎**（切批 → 各批调 LLM → 机械合并 → 递归 ≤3）；
 * - 并发闸门 `limiter.acquire(plot||compact ? 10 : seg ? 1 : 5)`；
 * - 实例键 `<pkgId>:<revisionId>:<taskId>[:<chunkIndex>][:batch:<b>]`；
 * - 幂等续跑：`records/tasks.json` 为状态源；同指纹且 succeeded → 复用产物、跳过请求；**跨重启有效**。
 */
import { createHash, randomUUID } from 'node:crypto'
import type {
  AttemptRecord,
  BatchingConfig,
  ChapterSlice,
  ChatMessage,
  LlmCallResult,
  LlmProvider,
  ParseProgress,
  ParseStatus,
  TaskDef,
  TaskRuntime
} from '../../shared/pipeline-types'
import type { TaskState, WorkspaceIndex } from '../../shared/workspace-types'
import { readIndex } from '../workspace/index-store'
import { getWorkspaceSession } from '../workspace/session'
import { loadChunkSources, type ChunkSource } from './chunk-source'
import { loadSettings } from '../settings/store'
import { loadTaskRegistry, VIRTUAL_STEPS, depBase } from './task-registry'
import { topoOrder, parseDepSuffix } from './dag'
import { providerChain } from './providers'
import { chatWithFallback } from './llm-client'
import { Limiter, defaultBatchingConfig, runWithBatching } from './batching'
import { renderPrompt } from './prompt-loader'
import { readUpstreamResults } from './upstream'
import { LOCAL_STEP_MAP, LLM_ADAPTERS } from './tasks'
import {
  appendAttempt,
  loadTaskStates,
  mirrorTasksToIndex,
  saveTaskState,
  writeResult
} from './persistence'

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
function nowIso(): string {
  return new Date().toISOString()
}

export interface OrchestratorOptions {
  /** 工作库根（缺省取当前会话的 root） */
  root?: string
  /** 只跑这些任务 id；'all'/缺省 = 全部 29 任务 */
  range?: string[] | 'all'
  /** L1 原文 chunk 文本数组（缺省从工作库 `records/chunks` 读取） */
  chunks?: string[]
  /** L2 分批配置覆盖 */
  batching?: Partial<BatchingConfig>
  /** 并发闸门总量覆盖 */
  concurrency?: number
  /**
   * 强制重跑（G3）：为 true 时忽略「同指纹且已 succeeded」的幂等跳过，
   * 已成功的实例也重新发请求。默认 false（保持原幂等行为）。
   */
  force?: boolean
}

interface RunState {
  runId: string
  pkgId: string
  root: string
  revisionId: string
  /** 书名（index.title；经 makeRuntime 注入 rt.title 供模板使用） */
  title: string
  cancelled: boolean
  total: number
  done: number
  states: Record<string, TaskState>
  /** G4 耗时结算表：实例键 → running 起点的墙钟毫秒（setState 内部消费） */
  startedAt: Record<string, number>
  error?: string
}

const runs = new Map<string, RunState>()
const listeners = new Set<(ev: ParseProgress) => void>()

/** 订阅解析进度（返回取消订阅函数）。 */
export function onProgress(cb: (ev: ParseProgress) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function emit(ev: ParseProgress): void {
  for (const cb of listeners) {
    try {
      cb(ev)
    } catch {
      // 订阅者异常不影响编排
    }
  }
}

/** 实例键（对齐平台 `Xa`，设计 §6.1）。 */
export function instanceKey(
  pkgId: string,
  revisionId: string,
  taskId: string,
  chunkIndex: number | null,
  batch?: number
): string {
  let k = `${pkgId}:${revisionId}:${taskId}`
  if (chunkIndex !== null && chunkIndex !== undefined) k += `:${chunkIndex}`
  if (batch !== undefined) k += `:batch:${batch}`
  return k
}

/** 并发权重（recon：plot/compact=10、seg=1、其它=5）。 */
function weightOf(taskId: string): number {
  if (taskId === 'plot' || taskId === 'compact') return 10
  if (taskId === 'seg') return 1
  return 5
}

/** 派生并发总量（recon：custom=1、deepseek=100、其它=3）。 */
function deriveConcurrency(providerKind?: string): number {
  const k = (providerKind ?? 'custom').toLowerCase()
  if (k === 'deepseek') return 100
  if (k === 'custom') return 1
  return 3
}

/** 计算任务实例指纹：`sha256(taskId|chunkIndex|输入摘要|model|thinking|effort|maxTokens)`。 */
export function fingerprintOf(
  task: TaskDef,
  chunkIndex: number | null,
  inputDigest: string,
  model: string
): string {
  return sha256(
    [task.id, chunkIndex ?? 'global', inputDigest, model, task.thinking, task.effort, task.maxTokens].join('|')
  )
}

/**
 * 解析一条依赖声明对应的实例键列表（`depSatisfied` 与 `findBlockedDep` 共用）。
 *
 * 抽出来的理由：两处都要按同样的后缀语义（`X:i` / `X:*` / `X:next` / 全局单例）
 * 算出「这条依赖关心哪些实例键」。各写一份必然漂移——一处改了另一处没改，
 * 会出现「判定为未就绪但说不出是哪个 blocked」的诡异状态。
 */
function depKeysFor(
  dep: string,
  node: string,
  allTasks: TaskDef[],
  pkgId: string,
  revisionId: string,
  chunksLen: number,
  chunkIndex: number | null
): string[] {
  const parsed = parseDepSuffix(dep)
  const nodeTask = allTasks.find((t) => t.id === node)
  if (!nodeTask) return []
  const keys: string[] = []
  if (parsed.suffix === 'chunk-n') {
    keys.push(instanceKey(pkgId, revisionId, node, parsed.chunkIndex ?? 0))
  } else if (parsed.suffix === 'next-chunk') {
    const nextIdx = (chunkIndex ?? 0) + 1
    if (nextIdx < chunksLen) keys.push(instanceKey(pkgId, revisionId, node, nextIdx))
  } else if (nodeTask.global) {
    keys.push(instanceKey(pkgId, revisionId, node, null))
  } else {
    for (let c = 0; c < chunksLen; c++) keys.push(instanceKey(pkgId, revisionId, node, c))
  }
  return keys
}

/** 判断某依赖声明是否已就绪（导出供验证脚本做边界单测）。 */
export function depSatisfied(
  dep: string,
  states: Record<string, TaskState>,
  allTasks: TaskDef[],
  pkgId: string,
  revisionId: string,
  chunksLen: number,
  chunkIndex: number | null
): boolean {
  const base = depBase(dep)
  if (VIRTUAL_STEPS.includes(base)) return true // 伴随程序步骤：不阻塞
  // 解析目标节点
  const ids = new Set(allTasks.map((t) => t.id))
  let nodes: string[]
  if (ids.has(dep)) nodes = [dep]
  else if (ids.has(base)) nodes = [base]
  else nodes = allTasks.filter((t) => t.kind === base).map((t) => t.id)
  if (!nodes.length) return true // 无可解析节点 → 不阻塞（注册表已校验）

  for (const node of nodes) {
    const keys = depKeysFor(dep, node, allTasks, pkgId, revisionId, chunksLen, chunkIndex)
    for (const k of keys) {
      const st = states[k]?.status
      if (st !== 'succeeded' && st !== 'local') return false
    }
  }
  return true
}

/**
 * 在依赖链里找一个处于 `blocked` 状态的实例，用于给下游任务更准确的跳过原因。
 *
 * 只看**直接依赖**（一层）。为什么不做递归：直接依赖被标 blocked 已经足够说明问题，
 * 递归会遍历整个上游图且收益很小——用户看到「任务 X 被审查拦截」就知道该去处理谁。
 *
 * @returns 被拦截的任务 id；没有则 null
 */
function findBlockedDep(
  task: TaskDef,
  states: Record<string, TaskState>,
  allTasks: TaskDef[],
  pkgId: string,
  revisionId: string,
  chunksLen: number,
  chunkIndex: number | null
): string | null {
  for (const dep of task.dependsOn) {
    const node = dep.split(':')[0]
    const keys = depKeysFor(dep, node, allTasks, pkgId, revisionId, chunksLen, chunkIndex)
    for (const k of keys) {
      if (states[k]?.status === 'blocked') return node
    }
  }
  return null
}

/** 启动一次解析（'all' 或指定任务子集；幂等：已 succeeded 的实例直接跳过）。 */
export async function start(pkgId: string, opts: OrchestratorOptions = {}): Promise<{ ok: boolean; runId?: string; error?: string }> {
  const root = opts.root ?? getWorkspaceSession()?.root
  if (!root) return { ok: false, error: '尚未导入工作库，无法启动解析' }

  let index: WorkspaceIndex
  try {
    index = await readIndex(root)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }

  const reg = await loadTaskRegistry()
  if (!reg.ok || !reg.tasks) return { ok: false, error: reg.error ?? '任务注册表加载失败' }
  const allTasks = reg.tasks

  let topo
  try {
    topo = topoOrder(allTasks)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }

  // L1 原文：优先用调用方注入（测试/自定义）；否则从工作库按章切片装配。
  // 切不到（缺 chunks/chapters/原文资产）→ 直接返回可读错误，**绝不退化成「拿书名当正文」**。
  let chunks: string[]
  let chunkChapters: ChapterSlice[][] = []
  if (opts.chunks) {
    chunks = opts.chunks
    chunkChapters = opts.chunks.map((t) => [{ seq: 1, title: '（注入原文）', text: t }])
  } else {
    let sources: ChunkSource[]
    try {
      sources = await loadChunkSources(root, index)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
    chunks = sources.map((s) => s.text)
    chunkChapters = sources.map((s) => s.chapters)
  }
  const chunksLen = Math.max(1, chunks.length)
  const rangeSet = opts.range && opts.range !== 'all' ? new Set(opts.range) : null

  // 过滤：range 内（缺省全量），保持拓扑顺序
  const ordered = topo.order
    .map((id) => allTasks.find((t) => t.id === id)!)
    .filter((t) => !rangeSet || rangeSet.has(t.id))

  // 实例总数
  let total = 0
  for (const t of ordered) total += t.global ? 1 : chunksLen

  const runId = randomUUID()
  const prevStates = await loadTaskStates(root)
  const state: RunState = {
    runId,
    pkgId,
    root,
    revisionId: index.origin.revisionId,
    title: index.title,
    cancelled: false,
    total,
    done: 0,
    states: prevStates,
    startedAt: {}
  }
  runs.set(runId, state)
  emit({ runId, pkgId, phase: 'start', done: 0, total })

  // 配置与闸门
  const settings = await loadSettings()
  const providers: LlmProvider[] = await providerChain()
  const activeKind = providers[0]?.providerKind
  const batchingCfg = defaultBatchingConfig(opts.batching)
  const limiter = new Limiter(opts.concurrency ?? deriveConcurrency(activeKind))

  // 异步执行（不阻塞 IPC 返回）；进度经 onProgress 推送
  void (async () => {
    try {
      for (const task of ordered) {
        if (state.cancelled) break
        const instances = task.global ? [null] : Array.from({ length: chunksLen }, (_, i) => i)
        for (const chunkIndex of instances) {
          if (state.cancelled) break
          const key = instanceKey(pkgId, state.revisionId, task.id, chunkIndex)
          const chunkText = chunkIndex === null ? chunks.join('\n\n') : chunks[chunkIndex] ?? ''
          const chapterSlices = chunkIndex === null ? null : chunkChapters[chunkIndex] ?? null
          await runInstance(state, task, allTasks, key, chunkIndex, chunkText, chapterSlices, {
            providers,
            batchingCfg,
            limiter,
            settingsModel: settings.model,
            chunksLen
          }, opts.force === true)
          state.done++
          const st = state.states[key]?.status
          emit({
            runId,
            pkgId,
            phase: 'task',
            taskId: task.id,
            instanceKey: key,
            status: st,
            done: state.done,
            total
          })
        }
      }
      await mirrorTasksToIndex(root, state.states)
      if (state.cancelled) {
        emit({ runId, pkgId, phase: 'cancelled', done: state.done, total })
      } else {
        emit({ runId, pkgId, phase: 'done', done: state.done, total })
      }
    } catch (e) {
      state.error = (e as Error).message
      await mirrorTasksToIndex(root, state.states).catch(() => undefined)
      emit({ runId, pkgId, phase: 'error', message: state.error, done: state.done, total })
    }
  })()

  return { ok: true, runId }
}

interface RunDeps {
  providers: LlmProvider[]
  batchingCfg: BatchingConfig
  limiter: Limiter
  settingsModel: string
  chunksLen: number
}

/** 执行单个任务实例（LLM 或本地步骤）。 */
async function runInstance(
  state: RunState,
  task: TaskDef,
  allTasks: TaskDef[],
  key: string,
  chunkIndex: number | null,
  chunkText: string,
  chapterSlices: ChapterSlice[] | null,
  deps: RunDeps,
  /** G3：force=true 时不做「已成功即跳过」的幂等复用 */
  force = false
): Promise<void> {
  const root = state.root
  const pkgId = state.pkgId
  const revisionId = state.revisionId

  const setState = async (partial: Partial<TaskState>): Promise<void> => {
    const prev = state.states[key]
    const next: TaskState = {
      status: partial.status ?? prev?.status ?? 'pending',
      fingerprint: partial.fingerprint !== undefined ? partial.fingerprint : prev?.fingerprint ?? null,
      updatedAt: nowIso(),
      error: partial.error !== undefined ? partial.error : prev?.error ?? null
    }
    // G4 耗时：running 起表记起点；落终态（succeeded/failed/local/skipped）时结算 elapsedMs
    if (partial.status === 'running') {
      state.startedAt[key] = Date.now()
    } else if (partial.status && partial.status !== 'pending') {
      const t0 = state.startedAt[key]
      if (t0 !== undefined) {
        next.elapsedMs = Date.now() - t0
        delete state.startedAt[key]
      }
    }
    state.states[key] = next
    await saveTaskState(root, key, next)
  }

  // ---- 本地步骤（model:false，不发请求）----
  if (!task.model) {
    const step = LOCAL_STEP_MAP[task.id]
    if (!step) {
      await setState({ status: 'skipped', error: '本里程碑未实现该本地步骤，跳过' })
      return
    }
    const fp = sha256([task.id, chunkIndex ?? 'global', 'local', task.label].join('|'))
    await setState({ status: 'running', fingerprint: fp, error: null })
    try {
      const rt = makeRuntime(state, task, key, chunkIndex, chunkText, chapterSlices, deps, fp)
      const data = await step.run(rt)
      await writeResult(root, key, { data, local: true, warnings: rt.warnings, at: nowIso() })
      await setState({ status: 'local', fingerprint: fp, error: null })
    } catch (e) {
      await setState({ status: 'failed', fingerprint: fp, error: (e as Error).message })
    }
    return
  }

  // ---- LLM 任务 ----
  const adapter = LLM_ADAPTERS[task.id]
  if (!adapter) {
    await setState({ status: 'skipped', error: '本里程碑（M2）未实现该 LLM 任务适配器，跳过' })
    return
  }
  // 依赖就绪
  const ready = task.dependsOn.every((dep) =>
    depSatisfied(dep, state.states, allTasks, pkgId, revisionId, deps.chunksLen, chunkIndex)
  )
  if (!ready) {
    // 区分「等前序任务」与「前序任务被审查拦截」——后者不会自己好起来，
    // 提示用户去处理而不是傻等，这是拦截机制的另一半价值。
    const blockedDep = findBlockedDep(task, state.states, allTasks, pkgId, revisionId, deps.chunksLen, chunkIndex)
    if (blockedDep) {
      await setState({
        status: 'skipped',
        error: `依赖任务被内容审查拦截（${blockedDep}），本任务不会继续。请处理该任务后重新运行。`
      })
      return
    }
    await setState({ status: 'skipped', error: '依赖未就绪，跳过（等待前序任务）' })
    return
  }

  const rt0 = makeRuntime(state, task, key, chunkIndex, chunkText, chapterSlices, deps, '')
  let input: string
  try {
    input = await adapter.inputText(rt0)
  } catch (e) {
    await setState({ status: 'failed', error: `构造输入失败：${(e as Error).message}` })
    return
  }
  const inputDigest = sha256(input).slice(0, 16)
  const model = deps.providers[0]?.model ?? deps.settingsModel ?? ''
  const fp = fingerprintOf(task, chunkIndex, inputDigest, model)

  // 幂等：同指纹且已成功 → 复用产物，跳过请求（force=true 时忽略，强制重发）
  const prev = state.states[key]
  if (!force && prev?.status === 'succeeded' && prev.fingerprint === fp) {
    return // 保持 succeeded，不再发请求
  }

  await setState({ status: 'running', fingerprint: fp, error: null })
  const rt = makeRuntime(state, task, key, chunkIndex, chunkText, chapterSlices, deps, fp)
  try {
    // T6-G ①：按任务覆盖 L2 分批配置（仅 adapter.batching 声明时生效）。合并算式不经
    // defaultBatchingConfig 的夹紧（刻意——覆盖值原样进 cfg）；planBatches 信任 cfg
    // （T6-G 修正，仅防脏值回退默认），故显式覆盖全量生效，语义见
    // shared/pipeline-types.ts 的 LlmTaskAdapter.batching 注释
    const cfg: BatchingConfig = adapter.batching ? { ...deps.batchingCfg, ...adapter.batching } : deps.batchingCfg
    const result = await runWithBatching(
      input,
      async (text: string) => {
        const messages = await adapter.buildMessages(text, rt)
        const r = await rt.llm(messages, {
          maxTokens: task.maxTokens,
          thinking: task.thinking,
          effort: task.effort
        })
        return r.content
      },
      cfg,
      {
        mergeStrategy: adapter.mergeStrategy,
        keyOf: adapter.keyOf,
        limiter: deps.limiter,
        weight: weightOf(task.id)
      }
    )
    // T6-F：parse 加可选第二参 rt（plotLocation 按 chunk 重编 id 用；老适配器不收该参）
    const data = adapter.parse(result.output, rt)
    await writeResult(root, key, {
      data,
      depth: result.depth,
      calls: result.calls,
      warnings: [...result.warnings, ...rt.warnings],
      at: nowIso()
    })
    await setState({ status: 'succeeded', fingerprint: fp, error: null })
  } catch (e) {
    // 审查拦截 → 标记 blocked 而不是 failed。
    // 语义差别：failed 会被下次运行重试（合理的，网络/上游抖动值得重试）；
    // blocked 不该自动重试——同一段内容换哪个模型都会被拦，重试只是白烧 token，
    // 而且会给用户「再点一次就好」的错误暗示。故单独成一种状态，UI 上醒目提示。
    const err = e as Error & { blocked?: boolean }
    if (err.blocked) {
      await setState({ status: 'blocked', fingerprint: fp, error: err.message })
      return
    }
    await setState({ status: 'failed', fingerprint: fp, error: err.message })
  }
}

/** 构造任务运行期上下文。 */
function makeRuntime(
  state: RunState,
  task: TaskDef,
  key: string,
  chunkIndex: number | null,
  chunkText: string,
  chapterSlices: ChapterSlice[] | null,
  deps: RunDeps,
  fingerprint: string
): TaskRuntime {
  const warnings: string[] = []
  const rt: TaskRuntime = {
    task,
    pkgId: state.pkgId,
    revisionId: state.revisionId,
    chunkIndex,
    instanceKey: key,
    chunkText,
    chunkChapters: chapterSlices ?? undefined,
    // T6-B：聚合型适配器（worldImpression 等）读上游产物的运行期注入（可选字段）
    root: state.root,
    title: state.title,
    readUpstream: (tid: string) => readUpstreamResults(state.root, tid),
    warnings,
    log: (message: string) => {
      emit({ runId: state.runId, pkgId: state.pkgId, phase: 'task', taskId: task.id, instanceKey: key, message })
    },
    render: (name: string, vars?: Record<string, unknown>) => renderPrompt(name, vars ?? {}),
    llm: async (messages: ChatMessage[], opts): Promise<LlmCallResult> => {
      if (!deps.providers.length) throw new Error('没有可用的模型配置（请在设置中新增并选中一条）')
      const outcome = await chatWithFallback(
        messages,
        {
          taskId: task.id,
          maxTokens: opts?.maxTokens ?? task.maxTokens,
          thinking: opts?.thinking ?? task.thinking,
          effort: opts?.effort ?? task.effort
        },
        deps.providers,
        async (log) => {
          const rec: AttemptRecord = {
            id: `${key}#${log.providerId}#${Date.now()}#${Math.random().toString(16).slice(2, 8)}`,
            taskId: task.id,
            instanceKey: key,
            providerId: log.providerId,
            model: log.model,
            startedAt: new Date(Date.now() - log.communicationMs).toISOString(),
            endedAt: nowIso(),
            status: log.ok ? 'succeeded' : 'failed',
            usage: log.usage,
            fingerprint,
            requestPath: null,
            responsePath: null,
            communicationMs: log.communicationMs,
            error: log.error ?? null
          }
          await appendAttempt(state.root, task.id, rec)
        }
      )
      if (!outcome.ok) {
        // 审查拦截 → 抛可识别错误，让任务层标记 blocked 而不是普通失败。
        // 关键区别：普通失败会自动重试/换配置；blocked 必须**停下来等人处理**，
        // 因为同一段内容换哪个模型都会被拦，自动重试只是白烧 token。
        if (outcome.blocked) {
          const e = new Error(outcome.error ?? '内容审查拦截') as Error & { blocked?: boolean }
          e.blocked = true
          throw e
        }
        throw new Error(outcome.error ?? 'LLM 调用失败')
      }
      return {
        content: outcome.content ?? '',
        providerId: outcome.providerId ?? '',
        model: outcome.model ?? '',
        usage: outcome.usage ?? null
      }
    }
  }
  return rt
}

/** 查询某次运行状态。 */
export function parseStatus(runId: string): ParseStatus {
  const s = runs.get(runId)
  if (!s) {
    return { runId, pkgId: '', running: false, done: 0, total: 0, tasks: {}, error: `未找到运行：${runId}` }
  }
  return {
    runId,
    pkgId: s.pkgId,
    running: !s.error && !s.cancelled ? s.done < s.total : false,
    done: s.done,
    total: s.total,
    tasks: s.states,
    error: s.error
  }
}

/** 取消某次运行（协作式：实例/任务间检查）。 */
export function cancel(runId: string): { ok: boolean } {
  const s = runs.get(runId)
  if (!s) return { ok: false }
  s.cancelled = true
  return { ok: true }
}

/** 续跑：以同一工作库重跑（已 succeeded 的实例自动跳过）。 */
export function resume(runId: string, range?: string[] | 'all'): Promise<{ ok: boolean; runId?: string; error?: string }> {
  const s = runs.get(runId)
  if (!s) return Promise.resolve({ ok: false, error: `未找到运行：${runId}` })
  return start(s.pkgId, { root: s.root, range })
}

/** 当前是否有运行中的任务（供 UI）。 */
export function hasRunning(): boolean {
  for (const s of runs.values()) if (!s.error && !s.cancelled && s.done < s.total) return true
  return false
}

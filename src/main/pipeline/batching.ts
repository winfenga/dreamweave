/**
 * 层级化分批 + 机械合并 + 递归（L2 · 设计 §6.7 / §3.3）。
 *
 * 规则本体（对任一会调 LLM 的任务 T，输入 I，预算 L2）：
 *   1. `estimate(I) ≤ L2` → 单次调用，结束。
 *   2. 否则按**语义边界**（段落/条目/章节，不切断一条实体描述）切 k 批，每批 ≤ L2。
 *   3. k 批各自调 LLM（受并发闸门约束，可并行）。
 *   4. 对 k 个输出做**机械合并**（程序计算，不发请求）得 I′。
 *   5. `estimate(I′) ≤ L2` → 结束；否则 `I = I′` 回到步骤 1，**递归至多 3 层**。
 *
 * 两个边界：① 不可切分单元本身超预算 → 放行超额 + warning，不报错不阻塞；
 *           ② 递归到 maxDepth 仍超 → 接受结果 + warning，不无限迭代。
 *
 * token 估算器（同 recon `Ra()`）：逐字符累加，`charCode<=127` 记 3，否则记 6；
 * 再 `Math.ceil(Σ/10)`。即 CJK ≈ 0.6 / ASCII ≈ 0.3 token/字。
 */
import type { BatchPlan, BatchTraceStep, BatchingConfig } from '../../shared/pipeline-types'
import { mergeOutputs, type MergeStrategy } from './merge'

export const DEFAULT_L2_TOKENS = 8000
export const L2_MIN_TOKENS = 4000
export const L2_MAX_TOKENS = 24000
export const DEFAULT_MAX_DEPTH = 3

/** 默认分批配置（可用部分覆盖）。 */
export function defaultBatchingConfig(over?: Partial<BatchingConfig>): BatchingConfig {
  return {
    inputBudgetTokens: clampBudget(over?.inputBudgetTokens ?? DEFAULT_L2_TOKENS),
    maxDepth: Math.max(1, Math.floor(over?.maxDepth ?? DEFAULT_MAX_DEPTH)),
    allowOversizeUnit: over?.allowOversizeUnit ?? true
  }
}

/** L2 预算夹紧到 [4000, 24000]。 */
export function clampBudget(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return DEFAULT_L2_TOKENS
  return Math.min(L2_MAX_TOKENS, Math.max(L2_MIN_TOKENS, Math.round(n)))
}

/** recon 同款 token 估算器。 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let sum = 0
  for (let i = 0; i < text.length; i++) {
    sum += text.charCodeAt(i) <= 127 ? 3 : 6
  }
  return Math.ceil(sum / 10)
}

/** 语义切分单元：段落 → 行 → 句子；返回 units（oversize 标记不可再切分又超预算的单元）。 */
function splitUnits(text: string, budget: number): { units: string[]; oversizeUnits: number } {
  const out: string[] = []
  let oversizeUnits = 0
  const paras = text.split(/\n{2,}/)
  const pushUnit = (u: string): void => {
    const t = u.replace(/\s+$/, '')
    if (!t.trim()) return
    out.push(t)
  }
  for (const para of paras) {
    if (estimateTokens(para) <= budget) {
      pushUnit(para)
      continue
    }
    // 段落超预算 → 按行切（不切断一行内的实体描述优先；行仍超再按句切）
    const lines = para.split(/\n/)
    for (const line of lines) {
      if (estimateTokens(line) <= budget) {
        pushUnit(line)
        continue
      }
      const sentences = line.split(/(?<=[。！？!?；;])/)
      let buf = ''
      let allFits = true
      for (const s of sentences) {
        if (estimateTokens(s) > budget) {
          allFits = false
          break
        }
        if (estimateTokens(buf + s) > budget && buf) {
          pushUnit(buf)
          buf = s
        } else {
          buf += s
        }
      }
      if (!allFits) {
        // 单句仍超预算 → 不可切分单元：整行放行为一个单元
        oversizeUnits++
        pushUnit(line)
      } else {
        pushUnit(buf)
      }
    }
  }
  return { units: out, oversizeUnits }
}

/** 贪心装箱：把 units 打进每批 ≤ budget 的批次；超预算单元单独成批并标记 oversize。 */
function packUnits(units: string[], budget: number): { payload: string[]; oversize: boolean[] } {
  const payload: string[] = []
  const oversize: boolean[] = []
  let buf = ''
  for (const u of units) {
    const tu = estimateTokens(u)
    if (tu > budget) {
      if (buf) {
        payload.push(buf)
        oversize.push(false)
        buf = ''
      }
      payload.push(u)
      oversize.push(true)
      continue
    }
    const candidate = buf ? `${buf}\n\n${u}` : u
    if (estimateTokens(candidate) > budget && buf) {
      payload.push(buf)
      oversize.push(false)
      buf = u
    } else {
      buf = candidate
    }
  }
  if (buf) {
    payload.push(buf)
    oversize.push(false)
  }
  return { payload, oversize }
}

/**
 * 制定一批的分批计划（单层；递归由 `runWithBatching` 驱动）。
 *
 * 【预算信任 cfg（T6-G 修正，醒目）】`cfg.inputBudgetTokens` **原样采用**（仅防运行期
 * 脏值回退默认）——夹紧职责在配置构造侧 `defaultBatchingConfig`（默认路径的 cfg 本就
 * 合法）；按任务显式覆盖（`LlmTaskAdapter.batching`，orchestrator 合并进 cfg 时不经
 * `defaultBatchingConfig`）必须在此生效，否则二次夹紧会把覆盖值压回 L2 上限、使
 * 「输出含跨批必碰撞的本地引用」的任务（如 lineAnnotation 单批 100000）失去单批能力。
 *
 * @param payload 待处理文本
 * @param cfg 分批配置
 * @param depth 当前递归深度（写入 plan）
 */
export function planBatches(payload: string, cfg: BatchingConfig, depth = 0): BatchPlan {
  // 预算信任 cfg 入参：夹紧职责在配置构造侧（defaultBatchingConfig 已夹紧默认值）；
  // 按任务显式覆盖（LlmTaskAdapter.batching，如 lineAnnotation 单批 100000）原样生效（T6-G 修正）。
  // 仅防御运行期脏值：非有限/非正数回退 DEFAULT_L2_TOKENS。
  const rawBudget = cfg.inputBudgetTokens
  const budget = Number.isFinite(rawBudget) && rawBudget > 0 ? rawBudget : DEFAULT_L2_TOKENS
  const warnings: string[] = []
  const total = estimateTokens(payload)
  if (total <= budget) {
    return {
      depth,
      batches: [{ index: 0, tokenEstimate: total, oversize: false, payload }],
      converged: true,
      warnings
    }
  }
  const { units, oversizeUnits } = splitUnits(payload, budget)
  if (!units.length) {
    // 极端：无可切分边界（整体不可切分）
    if (!cfg.allowOversizeUnit) {
      throw new Error(`输入超过预算（${total} > ${budget} token）且不可切分，已按配置拒绝`)
    }
    warnings.push(`输入不可切分且超预算（${total} > ${budget} token），已放行（warning）`)
    return { depth, batches: [{ index: 0, tokenEstimate: total, oversize: true, payload }], converged: true, warnings }
  }
  const { payload: batches, oversize } = packUnits(units, budget)
  if (oversizeUnits > 0) {
    warnings.push(`存在 ${oversizeUnits} 个不可切分单元超过预算（${budget} token），已超额放行（warning）`)
  }
  const plan: BatchPlan = {
    depth,
    batches: batches.map((p, i) => ({ index: i, tokenEstimate: estimateTokens(p), oversize: oversize[i], payload: p })),
    converged: false,
    warnings
  }
  if (!cfg.allowOversizeUnit && plan.batches.some((b) => b.oversize)) {
    throw new Error(`存在不可切分单元超过预算（${budget} token）且 allowOversizeUnit=false，已拒绝`)
  }
  // 全部批次都为放行批（没有可再切的余地）→ 视为收敛
  if (plan.batches.every((b) => b.oversize)) {
    plan.converged = true
    plan.warnings.push('全部批次均为不可切分放行批，无法继续细分')
  }
  return plan
}

/** 简单并发闸门（按权重 acquire；容量不足则排队）。 */
export class Limiter {
  private active = 0
  private queue: Array<{ weight: number; resolve: () => void }> = []
  constructor(private total: number) {
    this.total = Math.max(1, Math.floor(total))
  }
  acquire(weight: number): Promise<void> {
    const w = Math.max(1, Math.min(Math.floor(weight), this.total))
    if (this.active + w <= this.total) {
      this.active += w
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => this.queue.push({ weight: w, resolve }))
  }
  release(weight: number): void {
    const w = Math.max(1, Math.min(Math.floor(weight), this.total))
    this.active -= w
    this.drain()
  }
  private drain(): void {
    while (this.queue.length && this.active + this.queue[0].weight <= this.total) {
      const next = this.queue.shift()!
      this.active += next.weight
      next.resolve()
    }
  }
}

export interface RunBatchingOptions {
  mergeStrategy?: MergeStrategy
  keyOf?: (x: unknown) => string
  limiter?: Limiter
  /** 并发权重（默认 5，对齐 recon：plot/compact=10、seg=1、其它=5） */
  weight?: number
  onTrace?: (step: BatchTraceStep) => void
}

export interface RunBatchingResult {
  output: string
  depth: number
  warnings: string[]
  calls: number
  trace: BatchTraceStep[]
}

/**
 * 分批执行 + 机械合并 + 递归（≤ cfg.maxDepth）。
 *
 * @param input 初始输入文本
 * @param run   单批执行器（内部应真正调用 LLM）
 * @param cfg   分批配置
 */
export async function runWithBatching(
  input: string,
  run: (text: string) => Promise<string>,
  cfg: BatchingConfig,
  opts: RunBatchingOptions = {}
): Promise<RunBatchingResult> {
  const strategy: MergeStrategy = opts.mergeStrategy ?? 'concat-dedup-order'
  const warnings: string[] = []
  const trace: BatchTraceStep[] = []
  let calls = 0
  let current = input
  let depth = 0

  const exec = async (text: string): Promise<string> => {
    if (opts.limiter) await opts.limiter.acquire(opts.weight ?? 5)
    try {
      calls++
      return await run(text)
    } finally {
      if (opts.limiter) opts.limiter.release(opts.weight ?? 5)
    }
  }

  for (;;) {
    const plan = planBatches(current, cfg, depth)
    for (const w of plan.warnings) warnings.push(w)
    const step: BatchTraceStep = {
      depth,
      batchCount: plan.batches.length,
      tokenEstimates: plan.batches.map((b) => b.tokenEstimate),
      oversizeCount: plan.batches.filter((b) => b.oversize).length,
      warnings: plan.warnings
    }
    trace.push(step)
    opts.onTrace?.(step)

    if (plan.converged || plan.batches.length <= 1) {
      const outputs = await Promise.all(plan.batches.map((b) => exec(b.payload)))
      const merged = outputs.length === 1 ? outputs[0] : mergeOutputs<string>(strategy, outputs, opts.keyOf)
      return { output: merged, depth, warnings, calls, trace }
    }

    // 切批 → 各批调 LLM（受闘门约束）→ 机械合并
    const outputs = await Promise.all(plan.batches.map((b) => exec(b.payload)))
    current = mergeOutputs<string>(strategy, outputs, opts.keyOf)
    depth++
    if (depth >= cfg.maxDepth) {
      warnings.push(`递归已达最大深度 ${cfg.maxDepth}，接受当前结果（可能仍超预算）`)
      return { output: current, depth, warnings, calls, trace }
    }
  }
}

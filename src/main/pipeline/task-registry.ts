/**
 * 任务注册表加载 + 校验（设计 §6.1）。
 *
 * 注册表是**构建期静态快照**（`resources/pipeline/task-registry.json`，照抄 recon `oo`），
 * 运行期只读。校验口径：
 *   - `id` 唯一；
 *   - `dependsOn` 可解析（= 已登记的 task id / kind，或 recon 登记的伴随程序步骤）；
 *   - `effort` 为正整数（recon 口径 `∈[1,max(2,efforts.length)]`，无供应商档位时按 >0 整数校验）。
 * 违规**抛可读错误**（注册表是编排前提，不可静默降级）。
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resourcesDir } from '../effects/catalog'
import type { TaskDef } from '../../shared/pipeline-types'

/**
 * recon 登记的**伴随程序步骤**（非独立任务、不发起请求）：
 * `memoryBefore/memoryAfter`（记忆快照）、`templates`（提示词模板集）。
 * 它们可作为 `dependsOn` 的目标，但不进入 29 任务调度。
 */
export const VIRTUAL_STEPS: readonly string[] = ['memoryBefore', 'memoryAfter', 'templates']

export interface TaskRegistryResult {
  ok: boolean
  tasks?: TaskDef[]
  error?: string
  warnings?: string[]
}

function registryPath(dir?: string): string {
  return join(dir ?? join(resourcesDir(), 'pipeline'), 'task-registry.json')
}

/** 归一化：注册表允许是数组或 `{ tasks: [...] }`。 */
function normalizeRegistry(raw: unknown): TaskDef[] {
  if (Array.isArray(raw)) return raw as TaskDef[]
  if (raw && typeof raw === 'object') {
    const list = (raw as Record<string, unknown>).tasks
    if (Array.isArray(list)) return list as TaskDef[]
  }
  return []
}

/** 依赖后缀 → 基名（`cacheWarming:i` → `cacheWarming`；裸 id 原样）。 */
export function depBase(dep: string): string {
  const i = dep.indexOf(':')
  return i < 0 ? dep : dep.slice(0, i)
}

/**
 * 加载并校验注册表。
 * @param dir 可选：覆盖 pipeline 资源目录（默认 `<resources>/pipeline`）。
 */
export async function loadTaskRegistry(dir?: string): Promise<TaskRegistryResult> {
  const path = registryPath(dir)
  if (!existsSync(path)) {
    return { ok: false, error: `任务注册表缺失：${path}` }
  }
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (e) {
    return { ok: false, error: `任务注册表不可读：${path}（${(e as Error).message}）` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `任务注册表 JSON 损坏：${(e as Error).message}` }
  }
  const tasks = normalizeRegistry(parsed)
  if (!tasks.length) return { ok: false, error: '任务注册表未解析到任何任务' }

  const warnings: string[] = []
  const ids = new Set<string>()
  const kinds = new Set<string>()
  for (const t of tasks) {
    if (!t || typeof t.id !== 'string' || !t.id) {
      return { ok: false, error: '任务注册表存在缺少合法 id 的条目' }
    }
    if (ids.has(t.id)) return { ok: false, error: `任务 id 重复：${t.id}` }
    ids.add(t.id)
    if (typeof t.kind === 'string' && t.kind) kinds.add(t.kind)
  }

  for (const t of tasks) {
    if (!['enabled', 'disabled'].includes(t.thinking)) {
      return { ok: false, error: `任务 ${t.id} 的 thinking 非法：${String(t.thinking)}` }
    }
    if (!Number.isInteger(t.effort) || t.effort < 1) {
      return { ok: false, error: `任务 ${t.id} 的 effort 非法（须为正整数）：${String(t.effort)}` }
    }
    if (!Number.isFinite(t.maxTokens) || t.maxTokens <= 0) {
      return { ok: false, error: `任务 ${t.id} 的 maxTokens 非法：${String(t.maxTokens)}` }
    }
    if (!Array.isArray(t.dependsOn)) {
      return { ok: false, error: `任务 ${t.id} 的 dependsOn 非法（须为数组）` }
    }
    for (const dep of t.dependsOn) {
      if (typeof dep !== 'string' || !dep) {
        return { ok: false, error: `任务 ${t.id} 存在非法依赖项` }
      }
      const base = depBase(dep)
      const resolvable =
        ids.has(dep) || ids.has(base) || kinds.has(base) || VIRTUAL_STEPS.includes(base)
      if (!resolvable) {
        return { ok: false, error: `任务 ${t.id} 的依赖不可解析：${dep}（基名 ${base} 未登记）` }
      }
      if (VIRTUAL_STEPS.includes(base)) {
        warnings.push(`任务 ${t.id} 依赖伴随程序步骤 ${dep}（不进入 29 任务调度）`)
      }
    }
  }

  return { ok: true, tasks, warnings }
}

/** 便利：一次性校验并断言（校验失败抛可读错误）。 */
export async function requireTaskRegistry(dir?: string): Promise<TaskDef[]> {
  const r = await loadTaskRegistry(dir)
  if (!r.ok || !r.tasks) throw new Error(r.error ?? '任务注册表加载失败')
  return r.tasks
}

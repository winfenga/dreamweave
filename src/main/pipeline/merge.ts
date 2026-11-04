/**
 * 机械合并引擎（设计 §6.7 / §3.3）。
 *
 * 三种策略：
 *   - `concat-dedup-order`（默认）：**拼接 + 去重 + 保序**。对数组按稳定键去重、保留首次出现序；
 *     对文本按非空行拼接去重；对对象深度合并后递归去重。
 *   - `recon-merge` / `recon-canonical`：**字段级合并**（仅 recon 已定义的 merge / canonical 沿用；
 *     对象字段并集、数组拼接、标量取首个非空）。
 *
 * 关键不变量：不发请求（`model:false` 语义）；同一输入必得同一输出（确定性）。
 */

export type MergeStrategy = 'concat-dedup-order' | 'recon-merge' | 'recon-canonical'

/** 稳定键：优先 id/key/name/appearanceId/locationId，否则 JSON 串。 */
export function defaultKeyOf(x: unknown): string {
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>
    for (const k of ['id', 'key', 'name', 'appearanceId', 'locationId', 'characterId']) {
      const v = o[k]
      if (typeof v === 'string' && v) return v
      if (typeof v === 'number') return String(v)
    }
  }
  try {
    return JSON.stringify(x)
  } catch {
    return String(x)
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 字段级合并（并集）：a 优先，b 补空；数组拼接；对象递归。 */
function combineFirst(a: unknown, b: unknown): unknown {
  if (a === undefined || a === null) return b
  if (b === undefined || b === null) return a
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b]
  if (isPlainObject(a) && isPlainObject(b)) {
    const out: Record<string, unknown> = { ...a }
    for (const [k, v] of Object.entries(b)) {
      out[k] = k in out ? combineFirst(out[k], v) : v
    }
    return out
  }
  if (typeof a === 'string' && a === '') return b
  return a
}

/** 递归去重：数组按稳定键去重保序；对象逐字段递归。 */
function dedupeDeep(value: unknown, keyOf: (x: unknown) => string): unknown {
  if (Array.isArray(value)) {
    const seen = new Set<string>()
    const out: unknown[] = []
    for (const item of value) {
      const k = keyOf(item)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(dedupeDeep(item, keyOf))
    }
    return out
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = dedupeDeep(v, keyOf)
    return out
  }
  return value
}

/** 把片段解析为 JSON 对象（失败返回 null）。 */
function tryParseObject(s: string): Record<string, unknown> | null {
  const text = s.trim()
  if (!text) return null
  let t = text
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fence) t = fence[1].trim()
  try {
    const v = JSON.parse(t)
    return isPlainObject(v) ? v : null
  } catch {
    const a = t.indexOf('{')
    const b = t.lastIndexOf('}')
    if (a >= 0 && b > a) {
      try {
        const v = JSON.parse(t.slice(a, b + 1))
        return isPlainObject(v) ? v : null
      } catch {
        return null
      }
    }
    return null
  }
}

/**
 * 合并多个片段。
 * @param strategy 合并策略
 * @param parts 片段数组（同型）
 * @param keyOf 稳定键（可选）
 */
export function mergeOutputs<T>(strategy: MergeStrategy, parts: T[], keyOf?: (x: unknown) => string): T {
  const k = keyOf ?? defaultKeyOf
  if (!parts || parts.length === 0) {
    throw new Error('机械合并失败：没有可合并的片段')
  }
  if (parts.length === 1) return parts[0]

  const fieldLevel = strategy === 'recon-merge' || strategy === 'recon-canonical'

  // 全部为字符串：尝试按 JSON 对象合并；否则按文本行拼接去重
  if (parts.every((p) => typeof p === 'string')) {
    const strs = parts as unknown as string[]
    const objects = strs.map(tryParseObject)
    if (objects.every((o) => o !== null)) {
      const combined = (objects as Record<string, unknown>[]).reduce((acc, o) => combineFirst(acc, o) as Record<string, unknown>)
      const result = fieldLevel ? combined : (dedupeDeep(combined, k) as Record<string, unknown>)
      return JSON.stringify(result) as unknown as T
    }
    const seen = new Set<string>()
    const lines: string[] = []
    for (const s of strs) {
      for (const raw of s.split('\n')) {
        const line = raw.trim()
        if (!line) continue
        const key = fieldLevel ? line : line
        if (!fieldLevel && seen.has(key)) continue
        seen.add(key)
        lines.push(line)
      }
    }
    return lines.join('\n') as unknown as T
  }

  // 对象 / 任意结构：先字段级合并，再按策略去重
  const combined = parts.reduce((acc: unknown, p) => combineFirst(acc, p), undefined)
  return (fieldLevel ? combined : dedupeDeep(combined, k)) as T
}

/**
 * ComfyUI HTTP 客户端（标准 API 契约，零依赖 —— Node 22 内建 fetch）。
 *
 * 端点：
 *   - `GET  {base}/system_stats`            探活；
 *   - `POST {base}/prompt`                  提交工作流 `{prompt: <对象>, client_id}` → `{prompt_id}`；
 *   - `GET  {base}/history/{prompt_id}`     轮询（默认 1s 间隔 / 300s 超时），
 *                                           完成后取 `outputs[*].images[0]` 的 filename/subfolder/type；
 *   - `GET  {base}/view?filename=&subfolder=&type=`  下载图片字节。
 *
 * 所有错误**可读**：连接拒绝 / 超时 / 工作流执行报错（history 里 status.messages 的
 * execution_error 透出 node_type + exception_message）。
 */

/** 提交 + 轮询 + 下载的完整一次生图 */
export interface ComfyGenerateOptions {
  baseUrl: string
  /** 已替换完占位符的工作流对象（applyWorkflow 的产出） */
  workflow: Record<string, unknown>
  /** 客户端标识（缺省随机生成） */
  clientId?: string
  /** 轮询超时（毫秒，默认 300s —— 本地大模型出图较慢） */
  timeoutMs?: number
  /** 轮询间隔（毫秒，默认 1s；验证脚本可调小） */
  pollIntervalMs?: number
  /** 可注入的 fetch（验证脚本不用；留作扩展点） */
  fetchImpl?: typeof fetch
}

export interface ComfyGenerateResult {
  promptId: string
  /** 图片原始字节 */
  bytes: Buffer
  filename: string
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function readableFetchError(prefix: string, e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e)
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(msg)) {
    return new Error(`${prefix}：无法连接 ComfyUI（${msg}）。请确认服务已启动、地址正确。`)
  }
  if (/aborted|timeout|ETIMEDOUT/i.test(msg)) {
    return new Error(`${prefix}：请求超时（${msg}）`)
  }
  return new Error(`${prefix}：${msg}`)
}

/**
 * 列出 ComfyUI 上可用的**出图模型**（`ckpt_name` 候选）。
 *
 * 走 ComfyUI 标准信息接口 `GET /object_info/CheckpointLoaderSimple`：
 * 其 `input.required.ckpt_name[0]` 就是当前已安装的 checkpoint 名单数组。
 *
 * 【为什么值得单独做】设置页里「出图模型名（ckpt_name）」原本只能手抄，
 * 而 checkpoint 文件名往往带版本/精度/作者前缀（如 `qwen-image-1.0-fp8.safetensors`），
 * 抄错一个字就是一句「模型不存在」。列出候选让用户点选，直接消掉这类错误。
 *
 * 兼容性：该接口形状随 ComfyUI 版本略有差异，故按「找 ckpt_name 的字符串数组」
 * 宽松解析而非死抠字段路径；找不到就返回可读错误，**不猜**。
 */
export async function listComfyuiModels(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; models?: string[]; error?: string }> {
  const base = trimBase(baseUrl)
  let res: Response
  try {
    res = await fetchImpl(`${base}/object_info/CheckpointLoaderSimple`, {
      method: 'GET',
      signal: AbortSignal.timeout(10_000)
    })
  } catch (e) {
    return { ok: false, error: readableFetchError('探测模型失败', e).message }
  }
  if (!res.ok) return { ok: false, error: `探测模型失败：HTTP ${res.status} ${res.statusText}` }
  let j: unknown
  try {
    j = await res.json()
  } catch {
    return { ok: false, error: '探测模型失败：响应不是 JSON（ComfyUI 版本可能过旧）' }
  }
  const models = findCkptNames(j)
  if (!models.length) {
    return { ok: false, error: '探测模型失败：没有找到任何 checkpoint（models/checkpoints 目录为空？）' }
  }
  return { ok: true, models: [...models].sort((a, b) => a.localeCompare(b)) }
}

/** 递归找 ckpt_name 的候选清单（形状随版本变，只认「非空字符串数组」）。 */
function findCkptNames(node: unknown, depth = 0): string[] {
  if (depth > 8 || !node || typeof node !== 'object') return []
  const o = node as Record<string, unknown>
  // 命中：ckpt_name: [ ["a.safetensors", …], {…} ]
  const ck = o.ckpt_name
  if (Array.isArray(ck) && Array.isArray(ck[0])) {
    const arr = ck[0].filter((x): x is string => typeof x === 'string' && !!x.trim())
    if (arr.length) return arr
  }
  for (const v of Object.values(o)) {
    const hit = findCkptNames(v, depth + 1)
    if (hit.length) return hit
  }
  return []
}

/** 探活：GET /system_stats。成功返回可读摘要。 */
export async function probeComfyui(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; info?: string; error?: string }> {
  const base = trimBase(baseUrl)
  let res: Response
  try {
    res = await fetchImpl(`${base}/system_stats`, { method: 'GET', signal: AbortSignal.timeout(5000) })
  } catch (e) {
    return { ok: false, error: readableFetchError('探活失败', e).message }
  }
  if (!res.ok) return { ok: false, error: `探活失败：HTTP ${res.status} ${res.statusText}` }
  try {
    const j = (await res.json()) as { system?: { comfyui_version?: string; python_version?: string } }
    const sys = j.system ?? {}
    return {
      ok: true,
      info: `ComfyUI ${sys.comfyui_version ?? '（未知版本）'} 已就绪`
    }
  } catch {
    return { ok: true, info: 'ComfyUI 已就绪（响应不是 JSON，按可达处理）' }
  }
}

interface ComfyImageRef {
  filename: string
  subfolder?: string
  type?: string
}

/** history.status.messages 里的 execution_error 摘要 */
function extractExecutionError(status: unknown): string | null {
  const messages = (status as { messages?: unknown[] } | undefined)?.messages
  if (!Array.isArray(messages)) return null
  for (const m of messages) {
    if (!Array.isArray(m)) continue
    const [tag, payload] = m as [string, Record<string, unknown>]
    if (tag === 'execution_error' && payload && typeof payload === 'object') {
      const node = payload.node_type ?? payload.node_id ?? '?'
      const exc = payload.exception_message ?? JSON.stringify(payload)
      return `工作流执行出错（节点 ${node}）：${exc}`
    }
  }
  return null
}

/**
 * 一次完整生图：提交 → 轮询 history → 下载第一张 output 图。
 * 工作流执行报错 / 轮询超时 / 无输出图均抛可读错误。
 */
export async function generateViaComfyui(opts: ComfyGenerateOptions): Promise<ComfyGenerateResult> {
  const base = trimBase(opts.baseUrl)
  const doFetch = opts.fetchImpl ?? fetch
  const clientId = opts.clientId ?? `feather-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  const timeoutMs = opts.timeoutMs ?? 300_000
  const intervalMs = opts.pollIntervalMs ?? 1000

  // 1) 提交
  let promptId: string
  try {
    const res = await doFetch(`${base}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: opts.workflow, client_id: clientId }),
      signal: AbortSignal.timeout(30_000)
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`提交工作流失败：HTTP ${res.status} ${res.statusText}${text ? `（${text.slice(0, 300)}）` : ''}`)
    }
    const j = (await res.json()) as { prompt_id?: string; error?: unknown }
    if (!j.prompt_id) throw new Error(`提交工作流失败：响应缺少 prompt_id${j.error ? `（${JSON.stringify(j.error).slice(0, 200)}）` : ''}`)
    promptId = j.prompt_id
  } catch (e) {
    throw readableFetchError('提交工作流失败', e)
  }

  // 2) 轮询 history
  const deadline = Date.now() + timeoutMs
  let imageRef: ComfyImageRef | null = null
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs))
    let hist: Record<string, { status?: unknown; outputs?: Record<string, { images?: ComfyImageRef[] }> }> | null
    try {
      const res = await doFetch(`${base}/history/${encodeURIComponent(promptId)}`, {
        method: 'GET',
        signal: AbortSignal.timeout(10_000)
      })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      hist = (await res.json()) as typeof hist
    } catch (e) {
      throw readableFetchError(`查询生成状态失败（prompt_id=${promptId}）`, e)
    }
    const entry = hist?.[promptId]
    if (!entry) continue // 尚未入列
    const execErr = extractExecutionError(entry.status)
    if (execErr) throw new Error(execErr)
    const completed = (entry.status as { completed?: boolean } | undefined)?.completed === true
    if (!completed) continue
    // 取第一张 output 图（优先 type==='output'）
    for (const nodeOut of Object.values(entry.outputs ?? {})) {
      for (const img of nodeOut.images ?? []) {
        if (img?.filename && (img.type ?? 'output') === 'output') {
          imageRef = img
          break
        }
        if (img?.filename && !imageRef) imageRef = img
      }
      if (imageRef) break
    }
    break
  }
  if (!imageRef) {
    throw new Error(`生成超时（${Math.round(timeoutMs / 1000)}s 内未完成，prompt_id=${promptId}）。可在设置里重试。`)
  }

  // 3) 下载字节
  const qs = new URLSearchParams({
    filename: imageRef.filename,
    subfolder: imageRef.subfolder ?? '',
    type: imageRef.type ?? 'output'
  })
  let bytes: Buffer
  try {
    const res = await doFetch(`${base}/view?${qs.toString()}`, {
      method: 'GET',
      signal: AbortSignal.timeout(60_000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    bytes = Buffer.from(await res.arrayBuffer())
  } catch (e) {
    throw readableFetchError(`下载图片失败（${imageRef.filename}）`, e)
  }
  if (!bytes.length) throw new Error(`下载图片失败：${imageRef.filename} 内容为空`)
  return { promptId, bytes, filename: imageRef.filename }
}

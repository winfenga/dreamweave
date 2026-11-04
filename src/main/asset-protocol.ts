/**
 * 包内二进制成员的常驻访问协议：dwe://<assetKey>/<entryPath>
 *
 * 设计要点（对应「演出 / 地图需要大图常驻，不要每次切换都重新解码」）：
 * - 图片直接从已读入内存的包 buffer 里按偏移切片返回，**不落盘、不二次解码**；
 * - 响应带 `cache-control: immutable`，同一个 URL 在 Chromium 侧只解码一次，
 *   于是「切场景 → 切回来」不会重新读包、也不会重新解码。
 * - 支持 `Range: bytes=`（音频 `<audio>` 拖动进度条时会发 Range 请求），
 *   与 cache:// 共用同一个 rangeResponse()。
 */
import { protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { resolveStorePath } from './workspace/assets'
import { getWorkspaceSession } from './workspace/session'

/**
 * 包内资产的自定义 scheme 名。
 *
 * 历史名是 `t2w`（沿袭上游 txt2world），现改为自家的 `dwe`。
 * 这是**彻底换名**：主进程 `protocol.handle`、渲染层 CSP、以及 URL 拼接全部走同一个常量，
 * 三处必须一致 —— 少改一处，图片/音频会全 404（协议不匹配比文件缺失更难排查）。
 *
 * 只影响**运行期** URL；磁盘数据（index.json 的字段名）不含 scheme 名，历史工作库无需迁移。
 */
export const ASSET_SCHEME = 'dwe'

/**
 * scheme 特权声明。
 * 注意：**所有自定义 scheme 必须在 app ready 之前用一次 `registerSchemesAsPrivileged` 注册**。
 * 实测：分两次调用（先 t2w 后 cache）时只有后一次生效 —— 前一个 scheme 退化成非特权 scheme，
 * 表现为 `<img>`/`<audio>`/XHR 都正常，唯独 renderer 的 fetch() 报 "Failed to fetch"。
 * 因此这里只导出声明，由 src/main/index.ts 合并后一次性注册。
 */
export const ASSET_PRIVILEGE = {
  scheme: ASSET_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
}

function mimeOf(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.json':
      return 'application/json'
    case '.txt':
      return 'text/plain; charset=utf-8'
    case '.mp3':
      return 'audio/mpeg'
    case '.wav':
      return 'audio/wav'
    case '.ogg':
      return 'audio/ogg'
    case '.m4a':
    case '.mp4':
      return 'audio/mp4'
    case '.opus':
      return 'audio/opus'
    case '.flac':
      return 'audio/flac'
    case '.aac':
      return 'audio/aac'
    default:
      return 'application/octet-stream'
  }
}

/** 媒体类扩展名 → content-type（cache:// 复用） */
export function audioMimeOf(path: string): string {
  return mimeOf(path)
}

/**
 * 按 Range 头切片返回 200/206/416。
 * 无 Range 头或解析失败时退回 200 全量（并带 accept-ranges 让客户端知道可拖）。
 */
export function rangeResponse(
  body: Uint8Array,
  mime: string,
  rangeHeader: string | null,
  cacheControl = 'public, max-age=31536000, immutable'
): Response {
  const size = body.byteLength
  const baseHeaders: Record<string, string> = {
    'content-type': mime,
    'accept-ranges': 'bytes',
    'cache-control': cacheControl,
    // 渲染进程可能带 Range 头主动 fetch（会触发预检），本地协议统一放行
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'Range',
    'access-control-expose-headers': 'content-range, content-length, accept-ranges, content-type'
  }
  const m = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null
  if (!m) {
    return new Response(body, { status: 200, headers: { ...baseHeaders, 'content-length': String(size) } })
  }
  const startRaw = m[1]
  const endRaw = m[2]
  let start: number
  let end: number
  if (startRaw === '') {
    // 后缀范围：bytes=-N 取最后 N 字节
    if (endRaw === '') {
      return new Response('malformed range', { status: 416, headers: { ...baseHeaders, 'content-range': `bytes */${size}` } })
    }
    const n = Number(endRaw)
    if (!Number.isFinite(n) || n <= 0) {
      return new Response('malformed range', { status: 416, headers: { ...baseHeaders, 'content-range': `bytes */${size}` } })
    }
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(startRaw)
    end = endRaw === '' ? size - 1 : Number(endRaw)
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return new Response('malformed range', { status: 416, headers: { ...baseHeaders, 'content-range': `bytes */${size}` } })
    }
  }
  if (start >= size || start > end) {
    return new Response('range not satisfiable', {
      status: 416,
      headers: { ...baseHeaders, 'content-range': `bytes */${size}` }
    })
  }
  end = Math.min(end, size - 1)
  const slice = body.subarray(start, end + 1)
  return new Response(slice, {
    status: 206,
    headers: {
      ...baseHeaders,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': String(slice.byteLength)
    }
  })
}

/**
 * CORS 预检（OPTIONS）响应：本地协议统一放行 Range 头。
 * 必须是**无 body** 的 2xx，否则 Chromium 判定预检失败。
 */
export function preflightResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': 'Range',
      'access-control-max-age': '86400'
    }
  })
}

/** 必须在 app ready 之后调用 */
export function registerAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    if (request.method === 'OPTIONS') return preflightResponse()
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('bad url', { status: 400 })
    }
    const key = url.hostname
    const entryPath = decodeURIComponent(url.pathname.replace(/^\//, ''))

    // M1-T1：改为从**工作库**直出（index 资产表 entryPath→store → 读文件成连续 Buffer）
    const session = getWorkspaceSession()
    if (!session) return new Response('no workspace open', { status: 404 })
    if (session.assetKey !== key) return new Response('workspace not current', { status: 404 })
    if (!entryPath) return new Response('missing entry', { status: 400 })

    try {
      const abs = resolveStorePath(session.root, session.index, entryPath)
      if (!abs) return new Response(`entry not found: ${entryPath}`, { status: 404 })
      // ⚠️ 关键修复：`readFile` 得到**连续 Buffer**（显式 `Buffer.from` 拷贝），
      // 根治旧 `readEntry` 返回大包 buffer 的 `subarray` 视图（byteOffset ≠ 0）
      // 交给 `Response` 后长音频 ~11.9s stall 的问题。
      const buf = Buffer.from(await readFile(abs))
      return rangeResponse(buf, mimeOf(entryPath), request.headers.get('range'))
    } catch (e) {
      return new Response(`entry read failed: ${(e as Error).message}`, { status: 404 })
    }
  })
}

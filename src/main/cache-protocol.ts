/**
 * 本地缓存访问协议：cache://<tts|bgm>/<文件名>
 *
 * 只服务 userData 下两个受控目录里的文件：
 *   - tts/   TTS 合成结果，文件名 = sha256(文本+音色+模型) + 扩展名
 *   - bgm/   用户自选 BGM 的副本，文件名 = sha256(原路径+大小) + 扩展名
 *
 * 安全约束（路径穿越防护）：
 *   - host 只允许 tts / bgm；
 *   - 文件名做白名单正则，拒绝 `..`、绝对路径、反斜杠、空段、URL 编码绕过
 *     （decode 后再校验，且要求解析结果仍位于目标目录内）。
 */
import { app, protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, normalize, sep } from 'node:path'
import { audioMimeOf, preflightResponse, rangeResponse } from './asset-protocol'

export const CACHE_SCHEME = 'cache'

/**
 * scheme 特权声明（与 dwe:// 同批注册，见 asset-protocol.ts 的说明）。
 */
export const CACHE_PRIVILEGE = {
  scheme: CACHE_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
}

const ALLOWED_HOSTS = ['tts', 'bgm'] as const
type AllowedHost = (typeof ALLOWED_HOSTS)[number]

/** 文件名白名单：十六进制摘要 + 已知音频扩展名 */
export const NAME_RE = /^[0-9a-fA-F]{16,128}\.(mp3|wav|ogg|oga|m4a|mp4|opus|flac|aac)$/i

function isAllowedHost(h: string): h is AllowedHost {
  return (ALLOWED_HOSTS as readonly string[]).includes(h)
}

/**
 * 把 cache:// 的 host+path 解析成 userData 下的绝对路径；
 * 任何越界尝试都返回 null（调用方回 403）。
 */
export function resolveCachePath(host: string, rawPath: string): string | null {
  if (!isAllowedHost(host)) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    return null
  }
  decoded = decoded.replace(/^\/+/, '')
  if (!decoded || decoded.includes('\0')) return null
  // 反斜杠在 Windows 上也是分隔符，一律拒绝，避免 tts\..\x 之类绕过
  if (decoded.includes('\\')) return null
  if (decoded.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null
  if (isAbsolute(decoded)) return null
  if (!NAME_RE.test(decoded)) return null
  const base = join(app.getPath('userData'), host)
  const full = normalize(join(base, decoded))
  // 双保险：规范化之后必须仍落在 base 目录内
  if (!full.startsWith(base + sep) || full === base) return null
  return full
}

/** 必须在 app ready 之后调用 */
export function registerCacheProtocol(): void {
  protocol.handle(CACHE_SCHEME, async (request) => {
    if (request.method === 'OPTIONS') return preflightResponse()
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('bad url', { status: 400 })
    }
    const full = resolveCachePath(url.hostname, url.pathname)
    if (!full) return new Response('forbidden cache path', { status: 403 })
    try {
      const buf = await readFile(full)
      // 缓存内容可能被替换（重新合成/换 BGM），不能用 immutable
      return rangeResponse(buf, audioMimeOf(full), request.headers.get('range'), 'no-cache')
    } catch {
      return new Response('cache miss', { status: 404 })
    }
  })
}

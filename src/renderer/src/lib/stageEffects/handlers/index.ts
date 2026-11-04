/**
 * 轨道处理器注册表（可扩展性的核心）。
 *
 * 用 Vite 的 `import.meta.glob('./*.ts', { eager: true })` 在**编译期**静态收集同目录所有
 * handler 文件，各文件 `export default` 一个 `TrackHandler`。于是：
 *   - **新增一种 kind = 新增 1 个文件，本文件零改动**（P0-16）；
 *   - 重复 kind 去重并告警（不静默）；
 *   - 缺省（目录里存在但无对应 handler 的 kind）由运行时跳过并告警，绝不阻断整句其它特效。
 */
import type { TrackHandler, TrackHandlerModule } from '../../../../../shared/effects-types'

const modules = import.meta.glob<TrackHandlerModule>('./*.ts', { eager: true })

function isHandler(x: unknown): x is TrackHandler {
  const h = x as TrackHandler | undefined
  return !!h && typeof h.kind === 'string' && typeof h.start === 'function'
}

/** 已发现的全部处理器（排除注册表自身 index.ts） */
export const HANDLERS: TrackHandler[] = Object.entries(modules)
  .filter(([path]) => !/(^|\/)index\.ts$/.test(path))
  .map(([, m]) => m.default)
  .filter(isHandler)

/** kind -> handler；重复 kind 保留先到者并告警 */
export function buildRegistry(list: TrackHandler[] = HANDLERS): Map<string, TrackHandler> {
  const map = new Map<string, TrackHandler>()
  for (const h of list) {
    if (map.has(h.kind)) {
      console.warn(`[fx] 重复的轨道处理器 kind：${h.kind}，保留先到者、忽略后到者`)
      continue
    }
    map.set(h.kind, h)
  }
  return map
}

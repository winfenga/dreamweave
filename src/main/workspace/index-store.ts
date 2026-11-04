/**
 * index.json 的原子读写 + 结构校验（设计 §3.1 / §3.3）。
 *
 * - 缺失/损坏给**可读错误**（A-P0-4）；
 * - 写入走 `tmp + rename`（原子替换，进程崩溃不产生半截文件）。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { INDEX_FILE, INDEX_VERSION, WORKSPACE_FORMAT } from './paths'
import type { WorkspaceIndex } from './types'

/** 结构校验：任意不符即抛可读错误（告警不阻断仅用于资产，不用于 index 骨架）。 */
function validateIndex(raw: unknown, source: string): WorkspaceIndex {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`工作库索引内容不是对象：${source}`)
  }
  const o = raw as Record<string, unknown>
  if (o.indexVersion !== INDEX_VERSION) {
    throw new Error(`工作库索引版本不符（期望 ${INDEX_VERSION}，实际 ${String(o.indexVersion)}）：${source}`)
  }
  if (o.format !== WORKSPACE_FORMAT) {
    throw new Error(`工作库索引 format 不符（期望 "${WORKSPACE_FORMAT}"，实际 "${String(o.format)}"）：${source}`)
  }
  if (typeof o.pkgId !== 'string' || o.pkgId.length === 0) {
    throw new Error(`工作库索引缺少 pkgId：${source}`)
  }
  if (typeof o.title !== 'string') {
    throw new Error(`工作库索引缺少 title：${source}`)
  }
  if (!o.origin || typeof o.origin !== 'object') {
    throw new Error(`工作库索引缺少 origin 指纹：${source}`)
  }
  if (!o.manifest || typeof o.manifest !== 'object') {
    throw new Error(`工作库索引缺少 manifest 骨架：${source}`)
  }
  if (!Array.isArray(o.shards)) {
    throw new Error(`工作库索引缺少 shards[]：${source}`)
  }
  if (!Array.isArray(o.assets)) {
    throw new Error(`工作库索引缺少 assets[]：${source}`)
  }
  if (!o.tasks || typeof o.tasks !== 'object') {
    throw new Error(`工作库索引缺少 tasks 状态表：${source}`)
  }
  if (!o.integrity || typeof o.integrity !== 'object') {
    throw new Error(`工作库索引缺少 integrity：${source}`)
  }
  return o as unknown as WorkspaceIndex
}

/** 读取并校验 `index.json`；缺失/损坏 → 抛可读错误。 */
export async function readIndex(root: string): Promise<WorkspaceIndex> {
  const abs = join(root, INDEX_FILE)
  let text: string
  try {
    text = await readFile(abs, 'utf8')
  } catch (e) {
    throw new Error(`工作库索引缺失或不可读：${abs}（${(e as Error).message}）`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new Error(`工作库索引 JSON 损坏：${abs}（${(e as Error).message}）`)
  }
  return validateIndex(parsed, abs)
}

/** 原子写入 `index.json`（tmp + rename）。 */
export async function writeIndex(root: string, idx: WorkspaceIndex): Promise<void> {
  await mkdir(root, { recursive: true })
  const abs = join(root, INDEX_FILE)
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  await writeFile(tmp, JSON.stringify(idx, null, 2), 'utf8')
  await rename(tmp, abs)
}

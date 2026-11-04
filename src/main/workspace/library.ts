/**
 * 书库（工作库集合）读写辅助 —— 列表 / 删除路径防护 / 原文切段（设计 §9）。
 *
 * 刻意**不依赖 electron**：调用方（IPC 层）传入 `<userData>/workspace` 绝对根，
 * 这样本模块可被 node 验证脚本直接打包执行（与 workspace/index.ts 其余模块一致）。
 */
import { randomBytes } from 'node:crypto'
import { lstat, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { WorkspaceListItem } from '../../shared/workspace-types'
import type { ChapterInfo, ReadingSegment } from '../../shared/app-types'
import { readIndex } from './index-store'
import { sanitizeSegment } from './paths'

/** 原文字面片段（包内 entryPath 形如 `<pkgId>/source/body.utf8.txt`） */
const SOURCE_ENTRY_SUFFIX = '/source/body.utf8.txt'
const SOURCE_ENTRY_PLAIN = 'source/body.utf8.txt'

/**
 * 生成新建工作库的目录名：`<UTC 时刻 14 位>-<3 字节随机 hex>`（如 `20261017001530-a1b2c3`）。
 *
 * - 前 14 位 = ISO 时刻去掉 `-`/`:`/`T` 后取前 14 位，即 `yyyymmddHHMMSS`（UTC）；
 *   字典序即时间序 → 目录名天然可按「导入先后」排序。
 * - 后 6 位 = 3 字节随机 hex：保证**同一秒内**连续导入也不撞名。
 *
 * 纯函数（便于测试）；最终是否可用还需 `allocWorkspaceDirName()` 做存在性校验。
 */
export function newWorkspaceDirName(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14)
  return `${stamp}-${randomBytes(3).toString('hex')}`
}

/** 路径是否存在（读不到即视为不存在；不区分文件与目录）。 */
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/**
 * 分配一个**当前不存在**的工作库目录名（导入专用）。
 *
 * 生成 → 检查目标目录是否已被占用 → 占用则重新生成，最多 `retries` 次；
 * 仍冲突 → 抛可读错误。**绝不复用/覆盖已有工作库**，也从不提示「重复」。
 */
export async function allocWorkspaceDirName(wsRoot: string, retries = 8): Promise<string> {
  for (let i = 0; i < retries; i++) {
    const name = newWorkspaceDirName()
    if (!(await pathExists(join(wsRoot, name)))) return name
  }
  throw new Error(`无法分配唯一的工作库目录名：连续 ${retries} 次生成均已被占用`)
}

/** 该资产行是否为「全书原文」成员。 */
export function isSourceEntry(entryPath: string): boolean {
  return entryPath.endsWith(SOURCE_ENTRY_SUFFIX) || entryPath === SOURCE_ENTRY_PLAIN
}

/** 递归统计目录下所有普通文件字节和（容错：读不到的条目按 0 计；符号链接不跟随，避免环）。 */
async function dirBytes(dir: string): Promise<number> {
  let total = 0
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const abs = join(dir, e.name)
    try {
      if (e.isDirectory()) {
        total += await dirBytes(abs)
      } else if (e.isFile()) {
        total += (await stat(abs)).size
      }
      // 符号链接 / 其它类型跳过（不跟随，避免越界与环）
    } catch {
      /* 单个条目失败不影响整表 */
    }
  }
  return total
}

/** 书库列表结果：正常项 + 损坏目录名（目录不存在 → 均为空，不是错误）。 */
export interface WorkspaceListData {
  items: WorkspaceListItem[]
  broken: string[]
}

/**
 * 扫描 `wsRoot` 下的一级子目录，逐个 `readIndex`。
 *
 * - 成功 → 产出 `WorkspaceListItem`；
 * - 失败（索引缺失/损坏/半成品）→ 跳过并记入 `broken[]`，**绝不抛崩**；
 * - `wsRoot` 不存在 → 返回空数组。
 *
 * @param currentRoot 当前会话所在工作库根（可选）。传入时据此给 `current` 打标 ——
 *   **按目录判定**：改造后同一 pkgId 可有多份副本，按 pkgId 判定会误标多行。
 */
export async function listWorkspaces(wsRoot: string, currentRoot?: string): Promise<WorkspaceListData> {
  let names: string[]
  try {
    const entries = await readdir(wsRoot, { withFileTypes: true })
    names = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return { items: [], broken: [] }
  }

  const items: WorkspaceListItem[] = []
  const broken: string[] = []

  for (const name of names) {
    const root = join(wsRoot, name)
    try {
      const index = await readIndex(root)
      const project = index.manifest.project as Record<string, unknown>
      // 显示标题取**来源文件名**（用户要求：包内书名可能一字不差，无法分辨同名书）；
      // 来源路径缺失/为空才回退包内书名。index.title 本身保持不动（它是包内原始真相）。
      const srcPath = index.origin?.t2wPath
      const fileTitle = typeof srcPath === 'string' && srcPath.trim() ? basename(srcPath) : ''
      items.push({
        id: name,
        pkgId: index.pkgId,
        title: fileTitle || index.title,
        root,
        // 「当前打开」按目录判定（同一 pkgId 可有多份副本，比 pkgId 会误标）
        current: typeof currentRoot === 'string' && currentRoot.length > 0 && root === currentRoot,
        t2wPath: index.origin.t2wPath,
        t2wSize: Number(index.origin.t2wSize ?? 0),
        createdAt: index.origin.createdAt,
        chapterCount: Number(project?.chapterCount ?? 0) || 0,
        charCount: Number(project?.charCount ?? 0) || 0,
        assetCount: index.assets.length,
        totalBytes: await dirBytes(root),
        broken: false
      })
    } catch {
      broken.push(name)
    }
  }

  return { items, broken }
}

/** 目录解析结果 */
export interface WorkspaceDirResult {
  ok: boolean
  dir?: string
  error?: string
}

/**
 * 解析**工作库目录名** → 工作库目录绝对路径，并做**越界防护**。
 *
 * 拒绝：空串 / 含 `..`、`/`、`\` / 触发 `sanitizeSegment` 改名（其它非法字符）/
 * `dirname(dir) !== wsRoot`。任一不满足即返回可读错误。
 *
 * 注：入参语义是**目录名**（= `WorkspaceListItem.id`）。历史工作库的目录名恰等于 pkgId，
 * 但 T1 之后新书目录名是 `<UTC14位>-<随机hex>`，与 pkgId 已解耦，故报错文案统一写「目录名」。
 */
export function resolveWorkspaceDir(wsRoot: string, pkgId: string): WorkspaceDirResult {
  if (typeof pkgId !== 'string' || pkgId.length === 0) {
    return { ok: false, error: '目录名不能为空' }
  }
  if (pkgId.includes('..') || pkgId.includes('/') || pkgId.includes('\\')) {
    return { ok: false, error: '目录名含非法路径字符（.. / \\），已拒绝' }
  }
  const seg = sanitizeSegment(pkgId)
  if (seg !== pkgId) {
    return { ok: false, error: '目录名含非法字符，已拒绝' }
  }
  const dir = join(wsRoot, seg)
  if (dirname(dir) !== wsRoot) {
    return { ok: false, error: '路径越界，已拒绝' }
  }
  return { ok: true, dir }
}

/**
 * 删除前安全检查：目录必须真实存在、是**目录**（不是文件）、且**不是符号链接**。
 * 通过返回 null，否则返回可读错误。
 */
export async function assertSafeWorkspaceDir(dir: string): Promise<string | null> {
  let st: import('node:fs').Stats
  try {
    st = await lstat(dir)
  } catch {
    return '工作库目录不存在'
  }
  if (st.isSymbolicLink()) {
    return '目标为符号链接，拒绝删除'
  }
  if (!st.isDirectory()) {
    return '目标不是目录，拒绝删除'
  }
  return null
}

/** 删除工作库目录（先安全检查，再 `rm -r`；不拼 shell，不走 shell 命令）。 */
export async function removeWorkspaceDir(dir: string): Promise<{ ok: boolean; error?: string }> {
  const guard = await assertSafeWorkspaceDir(dir)
  if (guard) return { ok: false, error: guard }
  await rm(dir, { recursive: true, force: false })
  return { ok: true }
}

/** 切段结果 */
export interface ReadingSlice {
  segments: ReadingSegment[]
  skippedChapters: string[]
}

/**
 * 按章节字节区间把原文切成不重叠的段（**字节级钳制**，天然避免把一个多字节汉字切两半）。
 *
 * - 章节按 `byteStart` 升序；第 i 段实际区间 = `[max(byteStart_i, 前段 byteEnd), byteEnd_i]`；
 * - 钳制后区间为空 → 跳过该章并记入 `skippedChapters`；
 * - 首章之前的头部、末章之后的尾部各作为一段返回（`seq:null`），保证**全书一个字符都不丢**；
 * - 每段独立 `subarray().toString('utf8')`。
 */
export function buildReadingSegments(buf: Buffer, chapters: ChapterInfo[]): ReadingSlice {
  const len = buf.length
  const sorted = chapters
    .filter((c) => Number.isFinite(c.byteStart) && Number.isFinite(c.byteEnd))
    .slice()
    .sort((a, b) => a.byteStart - b.byteStart)

  const segments: ReadingSegment[] = []
  const skippedChapters: string[] = []
  let prev = 0

  // 首章之前的头部
  const firstStart = sorted.length ? Math.max(0, Math.min(sorted[0].byteStart, len)) : 0
  if (firstStart > 0) {
    segments.push({
      seq: null,
      title: '（正文之外 · 卷首）',
      byteStart: 0,
      byteEnd: firstStart,
      text: Buffer.from(buf.subarray(0, firstStart)).toString('utf8')
    })
    prev = firstStart
  }

  for (const c of sorted) {
    const from = Math.max(c.byteStart, prev, 0)
    const to = Math.min(c.byteEnd, len)
    if (to <= from) {
      skippedChapters.push(c.title || `#${c.seq}`)
      continue
    }
    segments.push({
      seq: c.seq,
      title: c.title,
      byteStart: from,
      byteEnd: to,
      text: Buffer.from(buf.subarray(from, to)).toString('utf8')
    })
    prev = to
  }

  // 末章之后的尾部
  if (prev < len) {
    segments.push({
      seq: null,
      title: '（正文之外 · 卷末）',
      byteStart: prev,
      byteEnd: len,
      text: Buffer.from(buf.subarray(prev, len)).toString('utf8')
    })
  }

  return { segments, skippedChapters }
}

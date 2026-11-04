/**
 * 本地媒体（BGM）选取与缓存。
 *
 * 用户自选的 BGM 是任意本地路径，不能直接给渲染进程用 file://（CSP 不收）。
 * 做法：选文件时复制一份到 userData/bgm/<sha256(路径+大小)><ext>，
 * 之后一律通过 cache://bgm/<文件名> 访问；缓存缺失时按原路径重新复制。
 */
import { BrowserWindow, dialog } from 'electron'
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { NAME_RE } from '../cache-protocol'

export interface PickBgmResult {
  ok: boolean
  canceled?: boolean
  /** 用户选择的原始路径（写入设置，便于展示与重新定位） */
  filePath?: string
  /** cache://bgm/<文件名> */
  url?: string
  error?: string
}

export interface ResolveBgmResult {
  ok: boolean
  url?: string
  error?: string
}

function bgmDir(): string {
  return join(app.getPath('userData'), 'bgm')
}

/** 缓存文件名：原路径 + 大小 的摘要，换文件/改内容都会换名 */
export function bgmCacheName(filePath: string, size: number): string {
  const h = createHash('sha256').update(`${filePath}|${size}`).digest('hex').slice(0, 32)
  const ext = extname(filePath).toLowerCase().replace(/[^a-z0-9.]/g, '') || '.mp3'
  return `${h}${ext}`
}

/** 确保缓存副本存在（不存在则从原路径复制），返回 cache:// URL */
export async function resolveBgm(filePath: string): Promise<ResolveBgmResult> {
  const p = (filePath ?? '').trim()
  if (!p) return { ok: false, error: '未选择 BGM 文件' }
  let s: Awaited<ReturnType<typeof stat>>
  try {
    s = await stat(p)
  } catch {
    return { ok: false, error: `BGM 文件不存在或不可读：${p}` }
  }
  if (!s.isFile()) return { ok: false, error: 'BGM 路径不是文件' }
  if (s.size <= 0) return { ok: false, error: 'BGM 文件为空' }
  const name = bgmCacheName(p, s.size)
  if (!NAME_RE.test(name)) return { ok: false, error: 'BGM 文件扩展名不受支持' }
  const dir = bgmDir()
  await mkdir(dir, { recursive: true })
  const dest = join(dir, name)
  try {
    await stat(dest)
  } catch {
    try {
      await copyFile(p, dest)
    } catch (e) {
      return { ok: false, error: `复制 BGM 到缓存失败：${(e as Error).message}` }
    }
  }
  return { ok: true, url: `cache://bgm/${name}` }
}

/** 弹出文件选择框挑选 BGM，并写入缓存；取消时返回 canceled */
export async function pickBgm(win?: BrowserWindow): Promise<PickBgmResult> {
  const picked = await dialog.showOpenDialog(win as BrowserWindow, {
    title: '选择背景音乐',
    properties: ['openFile'],
    filters: [
      { name: '音频文件', extensions: ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'mp4', 'opus', 'flac', 'aac'] },
      { name: '全部文件', extensions: ['*'] }
    ]
  })
  if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true }
  const filePath = picked.filePaths[0]
  const res = await resolveBgm(filePath)
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true, filePath, url: res.url }
}

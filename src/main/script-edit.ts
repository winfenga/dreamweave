/**
 * P3 脚本修订：把对某一句台词的修改写回工作库 storyScript 分片（M1-T3 分片级）。
 *
 * 铁律（用户拍板，见 recon/交接清单；写回目标已由整包迁移为分片，语义不变）：
 * - **写回前自动备份**：来源包 `原名.backup-YYYYMMDD-HHmmss.t2w`，放在同目录
 * - 只改 records.results 里 `:storyScript` 记录的 `actions[].text`
 *   （含 `:batch:` 变体：写回要保持所有副本一致，四重匹配保证只改目标句），
 *   不动任何资产（图片/mp3 内容寻址，sha256 天然不可变）
 * - 写完做成员级 sha256 复检（分片 + 资产），全过才算成功
 * - 不碰 `src/main/t2w/`（格式核心是生命线）
 * - **写回必须经 `workspace/shards.ts` 唯一入口**（per-path 串行队列 + tmp→复检→rename，
 *   设计 §6.10/v3.4），禁止绕过直写分片文件
 *
 * 定位句子的键：`chapterSeq + order + type + 原文本` 四重匹配。
 * 只用 order 不够——多 chunk 包里同一 order 可能出现在不同 chunk 的记录中，
 * 加原文本二次确认，保证改的就是用户眼前那一句。
 */
import { getWorkspaceSession } from './workspace/session'
import {
  writeStoryScriptShards,
  storyScriptData,
  type ShardEditOutcome
} from './workspace/shard-write'
import type { T2wManifest } from '../shared/t2w-types'

export interface ScriptSaveTarget {
  chapterSeq: number
  order: number
  type: string
  /** 原文本：二次确认定位，防止改错句 */
  originalText: string
}

export interface ScriptSaveResult {
  ok: boolean
  error?: string
  /** 备份文件路径（写回前自动生成） */
  backupPath?: string
  /** 实际改动的记录与下标（多 chunk 包可能命中同句的多条记录） */
  updated?: { recordKey: string; actionIndex: number }[]
  /** 写回后成员级校验摘要 */
  verify?: { total: number; passed: number; failed: number }
  /** 实际写盘的分片文件（相对工作库根） */
  writtenShards?: string[]
}

/**
 * 四重匹配 mutator（含 `:batch:` 全副本）：
 * 直接修改传入条目内的 actions[].text，返回命中清单。
 */
function makeTextMutator(
  target: ScriptSaveTarget,
  newText: string
): (entries: import('./workspace/types').KeyedEntry[]) => {
  touchedEntries: { recordKey: string; actionIndex: number }[]
  rangesUpdated: number
} {
  return (entries) => {
    const touchedEntries: { recordKey: string; actionIndex: number }[] = []
    for (const entry of entries) {
      const key = String(entry.key)
      if (!key.includes(':storyScript')) continue
      const data = storyScriptData(entry.value)
      const actions = data?.actions
      if (!Array.isArray(actions)) continue
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i] as Record<string, unknown> | null
        if (!a || typeof a !== 'object') continue
        if (
          a.chapterSeq === target.chapterSeq &&
          a.order === target.order &&
          a.type === target.type &&
          a.text === target.originalText
        ) {
          a.text = newText
          touchedEntries.push({ recordKey: key, actionIndex: i })
        }
      }
    }
    return { touchedEntries, rangesUpdated: 0 }
  }
}

export async function saveScriptAction(
  target: ScriptSaveTarget,
  newText: string
): Promise<ScriptSaveResult> {
  try {
    const session = getWorkspaceSession()
    if (!session) return { ok: false, error: '尚未导入任何书籍' }

    const r = await writeStoryScriptShards(session.root, session.index.origin.t2wPath, () =>
      makeTextMutator(target, newText)
    )
    if (!r.ok) {
      // MUTATION_MISS = 四重匹配未命中（探查阶段零写盘、零备份，P0-24）
      if (r.error === 'MUTATION_MISS') {
        return {
          ok: false,
          error: `没有定位到第 ${target.chapterSeq} 章第 ${target.order} 句（原文本不匹配，可能已被修改过——请重新导入或刷新后再试）`
        }
      }
      return { ok: false, error: r.error }
    }

    const outcome: ShardEditOutcome = r.outcome
    return {
      ok: true,
      backupPath: r.backupPath,
      updated: outcome.touchedEntries,
      verify: { total: outcome.verify.total, passed: outcome.verify.passed, failed: outcome.verify.failed },
      writtenShards: outcome.touchedFiles
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 供类型检查引用（manifest 形状未变，仅数据源切换） */
export type { T2wManifest }

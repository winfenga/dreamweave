/**
 * P4 特效写回核心（主进程）· M1-T3 分片级迁移。
 *
 * 严格沿用 P3 `script-edit.ts` 的铁律，并保留「复检失败时磁盘字节不变」（P0-24）
 * 语义——分片世界里由唯一写入口的 `tmp → 复检 → rename` 原子写承担：
 *   队列内读信封 → 三元键定位改字段 → 队列内原子写分片 → index 行更新 → 成员级复检。
 * 任一环节失败：tmp 被清理、目标分片字节不变、index 不更新，返回可读错误（P0-24）。
 *
 * 定位（P0-8/P0-23）：单句只用 `chapterSeq + order + type` 三元键，**从不比对 text**；
 * 多副本（含 `:batch:` 变体）**全部写入**，范围特效在所有副本 `data.effectRanges` 逐字相等。
 *
 * 注意：本文件独立于 `script-edit.ts`（P3 已验收），但共用 `workspace/shard-write.ts`
 * 的写回骨架与 stamp 格式，保证「同一记录通道」的字段级正交共存。
 */
import { getWorkspaceSession } from './workspace/session'
import { writeStoryScriptShards, storyScriptData } from './workspace/shard-write'
import type { KeyedEntry } from './workspace/types'
import type {
  EffectsSavePayload,
  EffectsSaveResult,
  EffectMount,
  EffectRange
} from '../shared/effects-types'

/** 深拷贝（写盘失败时信封保持原状） */
function deepCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

/** 单句定位：只用 chapterSeq+order+type，**从不比对 text** */
function matchThreeKey(
  a: Record<string, unknown>,
  t: { chapterSeq: number; order: number; type: string }
): boolean {
  return a.chapterSeq === t.chapterSeq && a.order === t.order && a.type === t.type
}

/**
 * 构建 P4 mutator（声明式：renderer 传期望完整列表，main 定位 + diff）。
 * - `payload.sentence` 缺省 = 不改单句；`payload.ranges` 缺省 = 不改范围。
 * - 单句：三元键命中副本内所有匹配动作（保守一致）。
 * - 范围：同一份 ranges 写入**本分片内所有** storyScript 副本的 data.effectRanges
 *   （「全部副本」由 shard-write 逐分片调用 mutator 达成——每个分片内的副本都会被写）。
 */
function makeEffectsMutator(payload: EffectsSavePayload) {
  const nextEffects: EffectMount[] | null = payload.sentence
    ? deepCopy(payload.sentence.effects ?? [])
    : null
  // 「缺省」必须是 null（= 不改范围），不能是 []：
  // [] 会让下面的 `if (ranges !== null)` 恒为真，于是每次只改单句的写回都会把
  // data.effectRanges 覆写成 []（静默丢失全部范围特效），同时让 rangesUpdated 恒 ≥1
  // —— 进而使 writeStoryScriptShards 的 MUTATION_MISS 永不触发，P0-24「不写盘」破防。
  const ranges: EffectRange[] | null = payload.ranges !== undefined ? deepCopy(payload.ranges) : null

  return (entries: KeyedEntry[]): {
    touchedEntries: { recordKey: string; actionIndex: number }[]
    rangesUpdated: number
  } => {
    const touchedEntries: { recordKey: string; actionIndex: number }[] = []
    let rangesUpdated = 0

    for (const entry of entries) {
      const key = String(entry.key)
      if (!key.includes(':storyScript')) continue
      const data = storyScriptData(entry.value)
      if (!data) continue

      // ---- 单句：三元键定位 ----
      if (nextEffects && payload.sentence) {
        const actions = data.actions
        if (Array.isArray(actions)) {
          for (let i = 0; i < actions.length; i++) {
            const a = actions[i] as Record<string, unknown> | null
            if (!a || typeof a !== 'object') continue
            if (matchThreeKey(a, payload.sentence)) {
              a.effects = deepCopy(nextEffects)
              touchedEntries.push({ recordKey: key, actionIndex: i })
            }
          }
        }
      }

      // ---- 范围：本分片内所有 storyScript 副本逐字相等 ----
      if (ranges !== null) {
        data.effectRanges = deepCopy(ranges)
        rangesUpdated++
      }
    }
    return { touchedEntries, rangesUpdated }
  }
}

/**
 * 写回一次特效状态。
 * - 命中数 0（且范围副本数 0）→ 返回错误，**不备份、不写盘**（磁盘与 index 原状，P0-24）。
 */
export async function saveEffectsAction(payload: EffectsSavePayload): Promise<EffectsSaveResult> {
  try {
    const session = getWorkspaceSession()
    if (!session) return { ok: false, error: '尚未导入任何书籍' }

    // 无单句且无范围 → 无事可做（与旧实现一致：不备份不写盘）
    if (!payload.sentence && payload.ranges === undefined) {
      return { ok: false, error: '没有需要写回的内容（既无单句特效也无范围特效）' }
    }

    const r = await writeStoryScriptShards(session.root, session.index.origin.t2wPath, () =>
      makeEffectsMutator(payload)
    )
    if (!r.ok) {
      if (r.error === 'MUTATION_MISS') {
        if (payload.sentence) {
          const t = payload.sentence
          return {
            ok: false,
            error: `没有定位到第 ${t.chapterSeq} 章第 ${t.order} 句（type=${t.type}，三元键未命中，可能已刷新或导入错误）`
          }
        }
        return { ok: false, error: '没有定位到任何 storyScript 副本（可能已刷新或导入错误）' }
      }
      return { ok: false, error: r.error }
    }

    return {
      ok: true,
      backupPath: r.backupPath,
      updated: r.outcome.touchedEntries,
      rangesUpdated: r.outcome.rangesUpdated,
      verify: {
        total: r.outcome.verify.total,
        passed: r.outcome.verify.passed,
        failed: r.outcome.verify.failed
      },
      writtenBytes: r.outcome.touchedFiles.reduce((n, f) => n + f.length, 0) || r.outcome.touchedFiles.length,
      writtenShards: r.outcome.touchedFiles
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message || String(e) }
  }
}

/**
 * `mangaScript` 任务适配器（C 线；模板 `manga_script_user_prompt`）。
 *
 * 产物：`records/results/mangaScript:<chunk>.json`（条目 key = 实例键）。
 * 输入：**带行号原文**（与 seg/cacheWarming 逐字同构，见 `../chunk-source`）。
 * 模板变量（4 个，全部来自上游产物或运行期）：
 *   - `chapterSeqs`       本 chunk 的章节号列表（模板要求「仅处理本批指定的章节」）
 *   - `worldImpression`   世界印象正文（`readUpstream('worldImpression')`）
 *   - `characters`        人物与可用形象（`readUpstream('canonical')` + `characterAppearance`）
 *   - `chunkReadingMemory` 此前阅读记忆（`readUpstream('memoryBefore')`，可缺）
 *
 * 输出契约（模板【输出契约】段，与 gmzz-10.t2w 实摘逐字一致）：
 * ```jsonc
 * { "chapters": [
 *     { "chapterSeq": 1,
 *       "pages": [
 *         { "context": "本页共用背景/衣着/道具",
 *           "characters": [{ "name": "克莱恩·莫雷蒂", "appearanceId": "D-0-C-0-A-1" }],
 *           "panels": [
 *             { "no": 1, "lines": [[5,18]], "scene": "",
 *               "content": "特写：……",
 *               "speech": [{ "type": "narration", "text": "……" }] }
 *           ] } ] } ] }
 * ```
 *
 * 【与 `speech` 相关的关键事实】
 *   模板要求**每格必须有 speech**（narration / say / think 三种）。
 *   但实包里 `results.mangaScript:0` 的 panels **没有 speech 字段**——
 *   它只在 `reader/project-edits` 的编辑版里出现（86 条台词）。
 *   这说明 speech 是**后续编辑阶段**补的，或者包内原产出就是半成品。
 *   本适配器按模板契约要求模型产出 speech（parse 侧宽容：缺失补空数组），
 *   这样新生成的包无需二次编辑即可播放。
 *
 * 【为什么强制单批】输出里 `pages[].panels[].lines` 引用的是**章节内行号**，
 * 若按 L2 切批，同一章被拆到两批会各自产出部分 pages，合并后页序错乱且
 * `panels.no` 在页内重复。故声明 `batching:{inputBudgetTokens:100000}`
 * （与 lineAnnotation / storyScript / plotLocationMerge 同一理由）。
 */
import type {
  ChatMessage,
  LlmTaskAdapter,
  TaskRuntime,
  UpstreamEntry
} from '../../../shared/pipeline-types'
import { numberLines } from '../chunk-source'
import { parseJsonLoose } from './cacheWarming'

/** 非空字符串 */
function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/** 从上游条目里取第一个可用正文（有些产物是 `{data:{...}}` 信封） */
function unwrapEntryValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const o = value as Record<string, unknown>
  const d = o.data
  if (d && typeof d === 'object' && !Array.isArray(d)) return d as Record<string, unknown>
  return o
}

/** 拼接全部上游条目的某个字符串字段（按条目顺序） */
async function joinUpstreamField(
  rt: TaskRuntime,
  taskId: string,
  field: string
): Promise<string> {
  if (typeof rt.readUpstream !== 'function') return ''
  let entries: UpstreamEntry[]
  try {
    entries = await rt.readUpstream(taskId)
  } catch {
    return ''
  }
  const parts: string[] = []
  for (const e of entries) {
    const v = unwrapEntryValue(e.value)
    if (!v) continue
    const f = v[field]
    if (nonEmptyString(f)) parts.push(f.trim())
  }
  return parts.join('\n').trim()
}

/**
 * 人物与可用形象（模板 `characters` 变量）。
 *
 * 数据来源两处，按 (charId, appearanceId) 合并：
 *   - `canonical`：`objects.characters[]` 给 name/aliases/identInfos/summary
 *   - `characterAppearance`：`{charId: [{appearanceId, name, sex, appearanceSummary, visualKeywords}]}`
 *
 * 输出格式对齐模板期望（模型要按 name + appearanceId 引用人物）：
 * ```
 * - 克莱恩·莫雷蒂（周明瑞、愚者）
 *   形象 D-0-C-0-A-1：黑发褐瞳，体型单薄…｜关键词：黑发、褐瞳、书卷气
 * ```
 * 没有 appearanceId 的人物也列出来（模型可能只需要名字），但不给形象行。
 */
async function buildCharactersText(rt: TaskRuntime): Promise<string> {
  if (typeof rt.readUpstream !== 'function') return ''
  const lines: string[] = []

  // ---- canonical ----
  let canonicalChars: Record<string, unknown>[] = []
  try {
    const entries = await rt.readUpstream('canonical')
    for (const e of entries) {
      const v = unwrapEntryValue(e.value)
      const objs = v?.objects as Record<string, unknown> | undefined
      const chars = objs?.characters
      if (Array.isArray(chars)) {
        canonicalChars = chars.filter(
          (c): c is Record<string, unknown> => !!c && typeof c === 'object' && !Array.isArray(c)
        )
        break
      }
    }
  } catch {
    // 无 canonical：仅靠 characterAppearance 也能列出
  }

  // ---- characterAppearance（charId -> 形象数组）----
  const appearancesByChar = new Map<string, Record<string, unknown>[]>()
  try {
    const entries = await rt.readUpstream('characterAppearance')
    for (const e of entries) {
      const v = unwrapEntryValue(e.value)
      if (!v) continue
      for (const [charId, arr] of Object.entries(v)) {
        if (!Array.isArray(arr)) continue
        const list = arr.filter(
          (x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
        )
        if (!list.length) continue
        const prev = appearancesByChar.get(charId) ?? []
        // 按 appearanceId 去重，先到先得
        const seen = new Set(prev.map((p) => String(p.appearanceId ?? '')))
        for (const ap of list) {
          const id = String(ap.appearanceId ?? '')
          if (id && seen.has(id)) continue
          prev.push(ap)
          if (id) seen.add(id)
        }
        appearancesByChar.set(charId, prev)
      }
    }
  } catch {
    // 无形象产物：只列人物名
  }

  for (const c of canonicalChars) {
    const id = String(c.id ?? '')
    const name = String(c.name ?? id)
    if (!name) continue
    const aliases = Array.isArray(c.aliases)
      ? c.aliases.filter((a): a is string => typeof a === 'string' && !!a)
      : []
    const head = aliases.length ? `- ${name}（${aliases.join('、')}）` : `- ${name}`
    lines.push(head)
    const aps = appearancesByChar.get(id) ?? []
    for (const ap of aps) {
      const apId = String(ap.appearanceId ?? '')
      if (!apId) continue
      const desc = nonEmptyString(ap.appearanceSummary) ? ap.appearanceSummary.trim() : ''
      const kw = Array.isArray(ap.visualKeywords)
        ? ap.visualKeywords.filter((k): k is string => typeof k === 'string' && !!k).join('、')
        : ''
      const sex = nonEmptyString(ap.sex) ? `${ap.sex.trim()}，` : ''
      const detail = [sex + desc, kw ? `关键词：${kw}` : ''].filter(Boolean).join('｜')
      lines.push(`  形象 ${apId}${detail ? `：${detail}` : ''}`)
    }
  }

  // canonical 里没有、但形象产物里有的人（兜底，保证人物不被漏掉）
  const known = new Set(canonicalChars.map((c) => String(c.id ?? '')))
  for (const [charId, aps] of appearancesByChar) {
    if (known.has(charId)) continue
    lines.push(`- ${charId}`)
    for (const ap of aps) {
      const apId = String(ap.appearanceId ?? '')
      if (apId) lines.push(`  形象 ${apId}`)
    }
  }

  return lines.join('\n').trim()
}

/** 本 chunk 的章节号列表（模板 `chapterSeqs`）。 */
function chapterSeqsOf(rt: TaskRuntime): number[] {
  const chs = rt.chunkChapters ?? []
  const seqs = chs.map((c) => c.seq).filter((n) => Number.isFinite(n))
  return seqs.length ? seqs : [1]
}

/** 阅读记忆（模板 `chunkReadingMemory`）：memoryBefore 产物里的压缩记忆正文。 */
async function buildReadingMemoryText(rt: TaskRuntime): Promise<string> {
  const direct = await joinUpstreamField(rt, 'memoryBefore', 'memory')
  if (direct) return direct
  // 有些实现把记忆放在 compactMemory / chunksSummary
  for (const f of ['compactMemory', 'chunkSummary', 'summary']) {
    const t = await joinUpstreamField(rt, 'memoryBefore', f)
    if (t) return t
  }
  return ''
}

export const mangaScriptAdapter: LlmTaskAdapter = {
  id: 'mangaScript',
  mergeStrategy: 'concat-dedup-order',
  // 输出含页/格本地序号，切批会跨批碰撞 → 强制单批
  batching: { inputBudgetTokens: 100000 },

  /**
   * 稳定键：chapters[] 按 chapterSeq；pages[] 按页内顺序（无 id）。
   *
   * 为什么要显式给：`concat-dedup-order` 的 `combineFirst` 对数组是拼接，
   * 同一章若被重复产出（重试/多副本）会留下两份 pages。按 chapterSeq 去重
   * 保留首次，符合「先到先得」语义。
   *
   * pages 与 panels 不另给键：它们只在各自 chapter 内部生效，
   * 且 `defaultKeyOf` 会退化成 JSON 串比较——同一页两次产出内容不同时不该去重，
   * 那反而会掩盖真实差异。这里只保证「章」这一层的唯一性。
   */
  keyOf(part: unknown): string {
    if (typeof part === 'string') return `warn:${part}`
    if (part && typeof part === 'object' && !Array.isArray(part)) {
      const o = part as Record<string, unknown>
      if (typeof o.chapterSeq === 'number') return `chapter:${o.chapterSeq}`
    }
    try {
      return JSON.stringify(part)
    } catch {
      return String(part)
    }
  },

  async inputText(rt: TaskRuntime): Promise<string> {
    // 与 seg 逐字同构：有章节切片按「各章从 1 重新编号」；否则视作单章
    const chapters = rt.chunkChapters ?? [{ seq: 1, title: '（单章原文）', text: rt.chunkText }]
    return numberLines(chapters)
  },

  async buildMessages(batchText: string, rt: TaskRuntime): Promise<ChatMessage[]> {
    const system = await rt.render('common_system_prompt', {})
    const seqs = chapterSeqsOf(rt)
    const [worldImpression, characters, memory] = await Promise.all([
      joinUpstreamField(rt, 'worldImpression', 'worldImpression'),
      buildCharactersText(rt),
      buildReadingMemoryText(rt)
    ])
    if (!worldImpression) {
      rt.warnings.push('mangaScript：缺少 worldImpression 产物，模板变量将为空')
    }
    if (!characters) {
      rt.warnings.push('mangaScript：缺少人物资料（canonical/characterAppearance），模型可能编造 appearanceId')
    }
    if (!memory) {
      rt.warnings.push('mangaScript：缺少阅读记忆（memoryBefore），跨章衔接可能不连贯')
    }
    const instruction = await rt.render('manga_script_user_prompt', {
      chapterSeqs: seqs.join(','),
      worldImpression,
      characters,
      chunkReadingMemory: memory
    })
    // 任务指令放最后（与 seg/cacheWarming 一致）
    return [
      { role: 'system', content: system },
      { role: 'user', content: batchText },
      { role: 'user', content: instruction }
    ]
  },

  parse(content: string): unknown {
    const obj = parseJsonLoose(content)
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const o = obj as Record<string, unknown>
      const chapters = o.chapters
      if (Array.isArray(chapters)) {
        // 形状校验 + 规范化：缺 speech 补空数组（模板要求有，但实测包内原产出没有）
        const normalized = chapters
          .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && !Array.isArray(c))
          .map((c) => {
            const pages = Array.isArray(c.pages) ? c.pages : []
            return {
              chapterSeq: typeof c.chapterSeq === 'number' ? c.chapterSeq : 0,
              pages: pages
                .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && !Array.isArray(p))
                .map((p) => {
                  const panels = Array.isArray(p.panels) ? p.panels : []
                  return {
                    context: typeof p.context === 'string' ? p.context : '',
                    characters: Array.isArray(p.characters)
                      ? p.characters
                          .filter(
                            (x): x is Record<string, unknown> =>
                              !!x && typeof x === 'object' && !Array.isArray(x)
                          )
                          .map((x) => ({
                            name: typeof x.name === 'string' ? x.name : '',
                            appearanceId: typeof x.appearanceId === 'string' ? x.appearanceId : ''
                          }))
                      : [],
                    panels: panels
                      .filter(
                        (x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
                      )
                      .map((pn, i) => ({
                        no: typeof pn.no === 'number' ? pn.no : i + 1,
                        lines: Array.isArray(pn.lines)
                          ? pn.lines.filter(
                              (l): l is number[] =>
                                Array.isArray(l) && l.length >= 2 && l.every((n) => typeof n === 'number')
                            )
                          : [],
                        scene: typeof pn.scene === 'string' ? pn.scene : '',
                        content: typeof pn.content === 'string' ? pn.content : '',
                        speech: Array.isArray(pn.speech)
                          ? pn.speech
                              .filter(
                                (s): s is Record<string, unknown> =>
                                  !!s && typeof s === 'object' && !Array.isArray(s)
                              )
                              .map((s) => ({
                                type:
                                  typeof s.type === 'string' && s.type
                                    ? s.type
                                    : 'narration',
                                ...(typeof s.speaker === 'string' && s.speaker
                                  ? { speaker: s.speaker }
                                  : {}),
                                text: typeof s.text === 'string' ? s.text : ''
                              }))
                              .filter((s) => s.text)
                          : []
                      }))
                  }
                })
            }
          })
        // 🔴 解析出 0 章 = 本实例没有可用产物，**必须抛错**而不是「成功但空」。
        //
        // 历史事故（用户实测）：模型三次都成功返回了 8216 / 14197 / 11613 token 的内容，
        // 但 parse 全部落空 → 写出的产物 `chapters: []`，任务状态却是 `succeeded`。
        // 于是下游 mangaEffects / mangaMusic 报「mangaScript 产物里没有任何 chapters」，
        // 用户看到的是「漫画跑完了但什么都没有」，而且界面上漫画任务全是绿的（成功）。
        //
        // 静默成功比失败更糟：它会污染状态机、让重跑逻辑认为无需重跑、
        // 也让用户误以为需要去查下游。抛错→任务标 failed→面板红→可重跑，才是正确语义。
        if (normalized.length === 0) {
          throw new Error(
            'mangaScript 解析结果没有任何章节（chapters 为空数组）：模型可能返回了空壳或输出被截断，请检查原始响应后重跑'
          )
        }
        return { chapters: normalized, warnings: Array.isArray(o.warnings) ? o.warnings : [] }
      }
    }
    // ⚠️ 解析失败 → **抛错**，而不是 return 空产物。
    //
    // 历史事故（用户实测）：模型成功返回了 8216 / 14197 / 11613 token 的内容，
    // 但 parse 全部落空 → 这里 return `{chapters: [], raw: content.slice(0,500)}`，
    // 任务状态却是 `succeeded`。于是下游 mangaEffects / mangaMusic 报
    // 「mangaScript 产物里没有任何 chapters」，用户在界面上看到漫画任务全绿
    // 却「什么都没有」。**静默成功比失败更糟**：污染状态机、重跑逻辑认为无需重跑、
    // 用户还得去查下游才能发现上游是空的。
    //
    // 同时：原实现只存 500 字符 → 事后完全无法判断「模型输出残缺」还是
    // 「解析策略有 bug」，只能对着半截字符串猜。现在把真实长度、结尾片段、
    // 失败原因全部写进异常消息，让下一次失败一次就能定位。
    const text = String(content ?? '')
    const failReason = (() => {
      const obj = parseJsonLoose(text)
      if (obj === null) return 'parseJsonLoose 返回 null（响应不是合法 JSON）'
      if (typeof obj !== 'object' || Array.isArray(obj))
        return `解析结果不是对象（实际 ${Array.isArray(obj) ? 'array' : typeof obj}）`
      if (!Array.isArray((obj as Record<string, unknown>).chapters))
        return `顶层缺少 chapters 数组（实际字段：${Object.keys(obj as Record<string, unknown>).join(',') || '无'}）`
      return '未知原因'
    })()
    throw new Error(
      `mangaScript 解析失败：${failReason}。响应共 ${text.length} 字符，` +
        `开头 ${JSON.stringify(text.slice(0, 120))}，结尾 ${JSON.stringify(text.slice(-160))}。` +
        (text.length > 20000 ? '响应很长，可能被上游按实际输出上限截断（JSON 未闭合）——请减小分片体量或换支持长输出的模型后重跑。' : '')
    )
  }
}

/**
 * `characterAppearance` 任务适配器（T6-G 第七批；模板 `character_appearance_user_prompt`）。
 *
 * 产物：`records/results/characterAppearance.json`（global 任务每书一次，key =
 * `<pkgId>:<revisionId>:characterAppearance`；投影登记见 `../reproject.ts` 的
 * `entities/appearances.json`）。
 * 消费端：`t2w/view.ts:193-220` `collectAppearances`——**map 形态与数组形态都吃**、
 * 按 (charId, appearanceId) 去重（先到先得）；`view.ts:220+` 汇入 CharacterVisual。
 * 下游：lineAnnotation（T6-G ③）的模板 `characters` 变量直接消费本产物主条目。
 *
 * 输入：**canonical 产物的 `objects.characters`**（经 `rt.readUpstream('canonical')`，
 * 双形态 `value?.data ?? value`）。每人构造 `{id, name, aliases, identInfos,
 * firstChunkSummary, characterSpriteInfos}`（顺序即输入序）：
 *  - `firstChunkSummary` = 该角色 `chunkSummaryList` 按 chunkIndex 升序的**首条**
 *    `summaryText`（无 → `''`）——模板「首个切片摘要」只用首条；
 *  - `characterSpriteInfos` **原样带出**（merge 本地步骤已给每条打上来源 chunkIndex，
 *    见 `./local.ts` `concatSpriteInfos`）——**每条自带来源 chunkIndex，是 parse 侧
 *    sourceIndexes 解析的依据**（快照表即由此建）。
 * 无 canonical 产物 / 无 characters → 抛可读错误。
 *
 * 【为什么 buildMessages 只发 2 条消息（与 seg/plot 等的 3 条不同）】
 * 模板只有单变量 `{{{characters}}}` 且**全嵌指令**（输入资料嵌在指令里，原文不作变量）：
 * system（common_system_prompt）+ user（渲染后的任务指令）= 2 条（与 locationTree /
 * batchLocationSummary/impressionLayout 同构）。
 *
 * 【batchText 为什么不拆用（醒目）】输入是 JSON **数组**，切半后各批拿到非法 JSON
 * 片段；且模板要求「每个人物恰好返回一次」——各批必须看到全量名单。故 buildMessages
 * 用与 inputText **同一共享 helper**（`readAppearanceInputs`）从 rt 现算输入数组，
 * 不从 batchText 拆回。代价：L2 若切批，各批指令相同、都产全量人物 → 靠机械合并收敛
 * （keyOf 按人物 id，跨批重复首现获胜）；当前书量级（canonical 人物数组数千 token）
 * **单批收敛**（depth=0、calls=1）。
 *
 * 【parse：程序分配 appearanceId 与 chunkIndexes（模板契约的程序侧履约）】
 * 模板明言「无需生成 appearanceId 或 chunkIndexes，程序会据来源分配」——落地规则：
 *  - `appearanceId = ${charId}-A-${n+1}`（n = 该形象在模型 appearances 数组中的位置，
 *    **从 0 计**；对齐真实数据 `D-0-C-1-A-1`）。位置即模型输出的稳定坐标、跨 run 确定；
 *    跳过缺 name 的形象会留编号洞（刻意：不重排位置，避免同输入不同 run 编号漂移）。
 *  - `chunkIndexes`：`sourceIndexes` 整数数组逐项查**快照**中该角色 spriteInfos 对应
 *    下标取 chunkIndex（越界/来源不可解析 → 跳过该项 + warning），收集**去重升序**；
 *    角色无 spriteInfos（推断形象）→ `[]`。快照由 buildMessages 经 `../rt-stash` 挂载
 *    （parse 是同步函数、禁止异步 IO，见 T6-F ① 纪律与 rt-stash 文件头约束 1）。
 *  - 输出形象对象字段集严格为 `{appearanceId, name, sex, appearanceSummary,
 *    visualKeywords, chunkIndexes}`。
 *
 * 【输出为主条目 MAP 形态（醒目）】`{charId: [形象对象...]}`——对齐真实库主条目；
 * view.ts collectAppearances 吃 map 形态。**不写子实例条目** `:characterAppearance:
 * <charId>`（真实库与该单角色键并存，本引擎单实例架构只写主条目；view 双形态去重，
 * 见 view.ts:193 注释）。parse 期 warning 一律进 `rt.warnings`（orchestrator 合并进
 * 信封 warnings）——MAP 形态**不设 warnings 键**（view 会把它当人物条目遍历）。
 *
 * 【与真实库 `5662f1d3` 的逐字段对比结论】
 * 对齐：主条目 `{charId: AppearanceRaw[]}`；形象字段 appearanceId（`D-0-C-1-A-1` 形态）/
 * name/sex/appearanceSummary/visualKeywords/chunkIndexes。
 * 有意差异：① 真实库同 key 并存 `:batch:N` 变体与 `…:characterAppearance:<charId>` 单角色
 * 条目（view 去重消费），本引擎单实例只写主条目；② `chunkIndexes` 当前**无 view 消费者**
 * （view.ts:118 仅类型声明），但按模板契约解析保真（下游 T6-I effectAnnotation 潜在消费）；
 * ③ 真实库形象可能带 `inferred` 字段（view.ts:119 类型声明），本适配器不生成（模板无此
 * 契约；推断形象以 chunkIndexes 为空表达）。
 *
 * 合并策略：`concat-dedup-order` + 显式 `keyOf`（人物条目按 id、形象对象按 JSON 串
 * 兜底；合并先于 parse 的现实约束与理由见 `characterAppearanceKeyOf` 处注释）。
 */
import type { ChatMessage, LlmTaskAdapter, TaskRuntime, UpstreamEntry } from '../../../shared/pipeline-types'
import { parseJsonLoose } from './cacheWarming'
import { readRtSnapshot, stashRtSnapshot } from '../rt-stash'

/** 字符串数组成员过滤（非字符串元素剔除；非数组 → `[]`）。 */
function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** 别名归一为字符串数组（新模板契约字符串数组 / 老数据对象数组 `[{alias,type}]` 两代形状都收）。 */
function aliasArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const x of v) {
    if (typeof x === 'string') out.push(x)
    else if (x && typeof x === 'object' && !Array.isArray(x) && typeof (x as Record<string, unknown>).alias === 'string') {
      out.push((x as Record<string, unknown>).alias as string)
    }
  }
  return out
}

/** 双形态解包：`{data:{…}}` 信封 → data；裸值原样（本流水线本地步骤信封与真实库老数据均兼容）。 */
function unwrapData(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const d = (value as Record<string, unknown>).data
    if (d !== undefined && d !== null) return d
  }
  return value
}

/** chunkSummaryList 按 chunkIndex 升序的首条 summaryText（无 → `''`；缺 chunkIndex 按 0 排，稳定排序保原序）。 */
function firstChunkSummaryOf(v: unknown): string {
  const entries = (Array.isArray(v) ? v : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
    .map((x) => ({
      chunkIndex: typeof x.chunkIndex === 'number' && Number.isFinite(x.chunkIndex) ? x.chunkIndex : 0,
      summaryText: typeof x.summaryText === 'string' ? x.summaryText : ''
    }))
    .sort((a, b) => a.chunkIndex - b.chunkIndex)
  return entries.length ? entries[0].summaryText : ''
}

/** 一个输入人物（模板 `characters` 数组元素；字段集即契约，顺序即模板可读性顺序）。 */
interface AppearanceInputChar {
  id: string
  name: string
  aliases: string[]
  identInfos: string[]
  firstChunkSummary: string
  characterSpriteInfos: unknown[]
}

/** buildMessages 挂载、parse 读取的快照（每角色 spriteInfos 对照表；null = 该条来源不可解析）。 */
interface AppearanceSnapshot {
  spriteChunkIndexes: Map<string, Array<number | null>>
}

/**
 * 读 canonical 产物 → 人物输入数组 + 每人 spriteInfos 的 chunkIndex 快照表。
 *
 * inputText 与 buildMessages **共用**（同一共享 helper，保证两处输入逐字一致）；
 * 快照只在 buildMessages 挂载（parse 用，见文件头）。缺 id 的 canonical 人物条目
 * 跳过 + warning（id 是形象归属键，不可缺）。
 */
async function readAppearanceInputs(rt: TaskRuntime): Promise<{
  chars: AppearanceInputChar[]
  spriteChunkIndexes: Map<string, Array<number | null>>
}> {
  if (typeof rt.readUpstream !== 'function') {
    throw new Error('characterAppearance 需要 canonical 产物：运行期未提供 readUpstream（rt 须由编排器 makeRuntime 构造）')
  }
  const entries: UpstreamEntry[] = await rt.readUpstream('canonical')
  let characters: unknown[] | null = null
  let sawCanonical = false
  for (const e of entries) {
    const data = unwrapData(e.value)
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue
    const objects = (data as Record<string, unknown>).objects
    if (!objects || typeof objects !== 'object' || Array.isArray(objects)) continue
    sawCanonical = true
    const chars = (objects as Record<string, unknown>).characters
    if (Array.isArray(chars)) {
      characters = chars
      break
    }
  }
  if (!characters) {
    // 区分「读不到 canonical 产物」（索引/依赖问题，重跑 canonical 可解）
    // 与「canonical 产出了但 characters 为空」（上游 merge 没提取出人物，
    // 要检查 mergeReview / draftCharacter 的质量）——两者处置完全不同，
    // 混成一句话会让用户按错误的按钮重跑。
    throw new Error(
      entries.length === 0
        ? 'characterAppearance 需要 canonical 产物：工作库中没有任何 canonical 结果，请先运行 canonical 任务'
        : sawCanonical
          ? 'characterAppearance 需要 canonical 产物：canonical 结果里 objects.characters 为空（上游未提取出任何人物），请先检查 draftCharacter / mergeReview 产物，或重跑这些任务后再跑 canonical'
          : 'characterAppearance 需要 canonical 产物：canonical 结果缺少 objects 字段，请先重跑 canonical 任务'
    )
  }
  const chars: AppearanceInputChar[] = []
  const spriteChunkIndexes = new Map<string, Array<number | null>>()
  for (const raw of characters) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      rt.warnings.push('characterAppearance：跳过非对象的 canonical 人物条目')
      continue
    }
    const c = raw as Record<string, unknown>
    if (typeof c.id !== 'string' || !c.id) {
      rt.warnings.push('characterAppearance：跳过缺 id 的 canonical 人物条目（id 是形象归属键，不可缺）')
      continue
    }
    const spriteInfos = Array.isArray(c.characterSpriteInfos) ? c.characterSpriteInfos : []
    chars.push({
      id: c.id,
      name: typeof c.name === 'string' ? c.name : '',
      aliases: aliasArray(c.aliases),
      identInfos: stringArray(c.identInfos),
      firstChunkSummary: firstChunkSummaryOf(c.chunkSummaryList),
      characterSpriteInfos: spriteInfos
    })
    // 快照：第 i 个 spriteInfo 的来源 chunkIndex（非有限数字 → null，parse 解析到即跳过该项）
    spriteChunkIndexes.set(
      c.id,
      spriteInfos.map((s) => {
        if (s && typeof s === 'object' && !Array.isArray(s)) {
          const ci = (s as Record<string, unknown>).chunkIndex
          if (typeof ci === 'number' && Number.isFinite(ci)) return ci
        }
        return null
      })
    )
  }
  return { chars, spriteChunkIndexes }
}

/**
 * characters 条目的稳定键（供 `concat-dedup-order` 的 dedupeDeep 用）。
 *
 * 【为什么不能只按 id（合并先于 parse 的现实约束）】`mergeOutputs` 在 parse **之前**
 * 对**原始模型文本**合并（orchestrator：`runWithBatching(input, …, {keyOf}) → adapter.parse(
 * result.output, rt)`），故 keyOf 看到的是模型输出：人物条目（有 `id`）按 id 键——同人物
 * 跨批重复（各批都看到全量名单）按 id 相消、首现获胜；形象对象（无 id）与脏条目退化为
 * JSON 串兜底——同批重复内容靠整串去重（默认的 `defaultKeyOf` 会误取 appearanceId 等
 * 模型自产字段，且 parse 前 appearanceId 尚未分配，只能按整串）。
 */
export function characterAppearanceKeyOf(part: unknown): string {
  if (part && typeof part === 'object' && !Array.isArray(part)) {
    const o = part as Record<string, unknown>
    if (typeof o.id === 'string' && o.id) return o.id
  }
  try {
    return JSON.stringify(part)
  } catch {
    return String(part)
  }
}

export const characterAppearanceAdapter: LlmTaskAdapter = {
  id: 'characterAppearance',
  mergeStrategy: 'concat-dedup-order',
  keyOf: characterAppearanceKeyOf,

  async inputText(rt: TaskRuntime): Promise<string> {
    // 输入 = canonical 人物数组的 JSON 序列化（供指纹/预算估算；模板变量在 buildMessages 现算）
    const { chars } = await readAppearanceInputs(rt)
    return JSON.stringify(chars)
  },

  async buildMessages(_batchText: string, rt: TaskRuntime): Promise<ChatMessage[]> {
    // 与 inputText 同一共享 helper 从 rt 现算（不从 batchText 拆回——JSON 数组切半即非法
    // 片段，且各批必须看到全量名单，理由见文件头）
    const { chars, spriteChunkIndexes } = await readAppearanceInputs(rt)
    // parse 侧 sourceIndexes → chunkIndexes 的唯一依据（约束：必须在 buildMessages stash，
    // inputText 的 rt0 与 parse 的 rt 不是同一实例，见 ../rt-stash 文件头）
    stashRtSnapshot(rt, { spriteChunkIndexes } satisfies AppearanceSnapshot)
    const system = await rt.render('common_system_prompt', {})
    const instruction = await rt.render('character_appearance_user_prompt', {
      // 预序列化 JSON 字符串（prompt-loader 对 JS 数组会换行拼接）
      characters: JSON.stringify(chars)
    })
    // 输入嵌在模板单变量里（{{{characters}}} 全嵌指令），故只 2 条消息（理由见文件头）
    return [
      { role: 'system', content: system },
      { role: 'user', content: instruction }
    ]
  },

  parse(content: string, rt?: TaskRuntime): unknown {
    const warn = (msg: string): void => {
      // MAP 形态不设 warnings 键（view 会当人物条目遍历）→ parse 期 warning 进 rt.warnings
      rt?.warnings.push(msg)
    }
    // 快照（buildMessages 挂载；rt 缺失/未 stash → 不校验归属、sourceIndexes 全跳过）
    const snapshot = readRtSnapshot<AppearanceSnapshot>(rt)
    const obj = parseJsonLoose(content)
    const o = obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null

    // ---- 协议校验：characters 必须是数组（缺 → raw 兜底，不抛崩）----
    if (!o || !Array.isArray(o.characters)) {
      warn(`characterAppearance：模型输出无法解析为人物形象协议（缺 characters 数组），走 raw 兜底（${(content ?? '').slice(0, 200)}）`)
      return {}
    }

    // 快照 id 集（缺快照 → 不校验归属，兼容测试/合成调用）
    const knownIds = snapshot ? new Set(snapshot.spriteChunkIndexes.keys()) : null
    const out: Record<string, Record<string, unknown>[]> = {}
    const doneIds = new Set<string>()

    for (const item of o.characters) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        warn(`characterAppearance：跳过非对象的 characters 条目（${JSON.stringify(item)?.slice(0, 80) ?? 'null'}）`)
        continue
      }
      const c = item as Record<string, unknown>
      // id 非空字符串且 ∈ 快照 id 集（模板契约「输入 id 标识人物，必须原样返回」）
      const id = typeof c.id === 'string' ? c.id : ''
      if (!id) {
        warn('characterAppearance：跳过缺 id 的 characters 条目（id 必须原样返回输入中的人物ID）')
        continue
      }
      if (knownIds && !knownIds.has(id)) {
        warn(`characterAppearance：跳过 id=${id} 的条目（不在 canonical 输入人物集中）`)
        continue
      }
      if (doneIds.has(id)) {
        warn(`characterAppearance：人物 ${id} 重复返回，保留首条（模板契约「每个人物恰好返回一次」）`)
        continue
      }
      doneIds.add(id)
      const spriteIndexes = snapshot?.spriteChunkIndexes.get(id) ?? []
      const rawAppearances = Array.isArray(c.appearances) ? c.appearances : []
      if (!rawAppearances.length) {
        warn(`characterAppearance：人物 ${id} 未返回任何形象（模板契约「不遗漏」）`)
      }
      const appearances: Record<string, unknown>[] = []
      rawAppearances.forEach((raw, n) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          warn(`characterAppearance：跳过人物 ${id} 第 ${n + 1} 个非对象形象`)
          return
        }
        const a = raw as Record<string, unknown>
        // name 必填非空字符串（模板「给每套形象一个简短且有输入依据的名称」）
        if (typeof a.name !== 'string' || a.name.trim().length === 0) {
          warn(`characterAppearance：跳过人物 ${id} 第 ${n + 1} 个缺 name 的形象`)
          return
        }
        // sex：仅 男/女/''（模板「只能为男、女或空字符串」；其它值归一为 '' + warning）
        let sex = ''
        if (a.sex === '男' || a.sex === '女') {
          sex = a.sex
        } else if (a.sex !== undefined && a.sex !== null && a.sex !== '') {
          warn(`characterAppearance：人物 ${id} 形象「${a.name}」sex=${JSON.stringify(a.sex)} 非法，归一为空字符串`)
        }
        // sourceIndexes → chunkIndexes（逐项查快照；越界/来源不可解析 → 跳过该项 + warning）
        const chunkSet = new Set<number>()
        const rawIndexes = Array.isArray(a.sourceIndexes) ? a.sourceIndexes : []
        rawIndexes.forEach((si, k) => {
          if (typeof si !== 'number' || !Number.isInteger(si)) {
            warn(`characterAppearance：人物 ${id} 形象「${a.name}」第 ${k + 1} 个 sourceIndex 非整数（${JSON.stringify(si) ?? 'undefined'}），跳过该项`)
            return
          }
          const ci = si >= 0 && si < spriteIndexes.length ? spriteIndexes[si] : undefined
          if (ci === undefined || ci === null) {
            warn(`characterAppearance：人物 ${id} 形象「${a.name}」sourceIndex=${si} 越界或来源不可解析，跳过该项`)
            return
          }
          chunkSet.add(ci)
        })
        appearances.push({
          // 程序分配（模板「无需生成 appearanceId 或 chunkIndexes，程序会据来源分配」；
          // n = 数组位置从 0 计，对齐真实数据 D-0-C-1-A-1）
          appearanceId: `${id}-A-${n + 1}`,
          name: a.name,
          sex,
          appearanceSummary: typeof a.appearanceSummary === 'string' ? a.appearanceSummary : '',
          visualKeywords: stringArray(a.visualKeywords),
          chunkIndexes: [...chunkSet].sort((x, y) => x - y)
        })
      })
      out[id] = appearances
    }

    // 输入人物未被模型返回 → warning（模板契约「不遗漏、不增加名单外人物」）
    if (knownIds) {
      for (const id of knownIds) {
        if (!doneIds.has(id)) warn(`characterAppearance：输入人物 ${id} 未被模型返回任何形象`)
      }
    }
    return out
  }
}

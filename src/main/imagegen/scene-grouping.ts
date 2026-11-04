/**
 * 场景图分组（§5 `scene_group_image_user_prompt` 的**程序侧**）。
 *
 * 解决的问题：场景图是整个生图链路里最贵的一环（一张 2K 图几十秒）。
 * 一本 20 个场景的书，逐个生成要跑很久。但实际很多场景**可以共用一张背景**：
 *   - 同一间屋子的早晨/傍晚（光照变化由 tone 特效覆盖，不需要重画）
 *   - 同一地点只是出场人物/对白不同
 *   - 描述高度相似的两个场景
 *
 * 模板明确给出了分组原则：**空间结构、主要布景、画面状态一致 → 可共用；
 * 不同房间/室内外/昼夜/完好与损毁/重大布景变化 → 应分组**。
 *
 * 本模块只做**启发式初筛**，不调 LLM：
 *   - 依据 `mapLocationId`：同一地图节点下的场景优先归组（模块自带的强信号）
 *   - 场景名/描述的词汇重合度：低重合度不强行合并
 *   - 明确冲突信号（昼夜/室内外/损坏）强制分组
 *
 * 为什么不让 LLM 做：分组错的代价是「两个不同房间用同一张图」，
 * 视觉上非常明显。启发式保守分组（宁可多分）比 LLM 激进合并安全。
 * 用户可以手动改。
 */

/** 参与分组的场景（来自 `readImagegenTargets` 的 scenes） */
export interface SceneForGrouping {
  sceneId: string
  name: string
  summary: string
  sceneDescription: string
  /** 所属地图节点 id（可能为 null） */
  mapLocationId?: string | null
}

/** 一个场景组 */
export interface SceneGroup {
  groupId: string
  /** 组成员的 sceneId（稳定顺序） */
  sceneIds: string[]
  /** 代表性场景（组内第一个）——生成时用它拼提示词 */
  representative: SceneForGrouping
  /** 分组理由（给人看） */
  reason: string
}

/** 冲突信号：出现这些词说明画面状态显著不同，必须分组 */
const CONFLICT_PATTERNS: { key: string; re: RegExp; label: string }[] = [
  { key: 'day', re: /白昼|白天|正午|清晨|早晨|上午|日光|阳光明媚/, label: '白天' },
  { key: 'night', re: /夜晚|夜里|深夜|午夜|月夜|夜色|入夜/, label: '夜晚' },
  { key: 'dusk', re: /黄昏|傍晚|日落|夕阳|暮色/, label: '黄昏' },
  { key: 'dawn', re: /黎明|拂晓|破晓|日出/, label: '黎明' },
  { key: 'indoor', re: /室内|屋内|房间|屋中|船舱|车厢|大厅|走廊/, label: '室内' },
  { key: 'outdoor', re: /室外|户外|野外|街道|广场|庭院|甲板|山顶|海边/, label: '室外' },
  { key: 'intact', re: /完好|整洁|堂皇|华丽|崭新/, label: '完好' },
  { key: 'ruined', re: /废墟|残破|破败|荒芜|坍塌|焚毁|焦黑/, label: '损毁' }
]

/** 提取一个场景的冲突标记集合 */
function conflictTags(s: SceneForGrouping): Set<string> {
  const text = `${s.name}\n${s.summary}\n${s.sceneDescription}`
  const out = new Set<string>()
  for (const { key, re } of CONFLICT_PATTERNS) {
    if (re.test(text)) out.add(key)
  }
  return out
}

/** 两组冲突标记是否互斥（例如一个有 day 一个有 night） */
function tagsConflict(a: Set<string>, b: Set<string>): boolean {
  // 互斥对：昼夜、室内外、完好损毁
  const pairs: [string, string][] = [
    ['day', 'night'],
    ['day', 'dusk'],
    ['day', 'dawn'],
    ['indoor', 'outdoor'],
    ['intact', 'ruined']
  ]
  for (const [x, y] of pairs) {
    if ((a.has(x) && b.has(y)) || (a.has(y) && b.has(x))) return true
  }
  return false
}

/** 中文分词粗糙版：按 2-gram 取字符片段，用于估算词汇重合度 */
function grams(s: string): Set<string> {
  const t = s.replace(/[\s，。、；：""''（）()【】\[\]…—\-·,.;:!?！？]/g, '')
  const out = new Set<string>()
  for (let i = 0; i + 2 <= t.length; i++) out.add(t.slice(i, i + 2))
  return out
}

/** Jaccard 相似度 */
function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

/**
 * 对场景做启发式分组。
 *
 * 分组规则（保守优先，宁可多分）：
 *   1. 同一 `mapLocationId` 下的场景**才考虑**合并（不同节点默认不合并）
 *   2. 冲突标记互斥 → 不合并
 *   3. 名称+描述相似度 ≥ 阈值 → 合并
 *   4. 否则各自成组
 *
 * @param threshold 相似度阈值（默认 0.34；调高会分得更细）
 */
export function groupScenes(scenes: SceneForGrouping[], threshold = 0.34): SceneGroup[] {
  const groups: { members: SceneForGrouping[]; tags: Set<string>[]; grams: Set<string>[] }[] = []

  for (const s of scenes) {
    const tags = conflictTags(s)
    const g = grams(`${s.name} ${s.summary} ${s.sceneDescription}`)

    // 找一个可合并的已存在组
    let target: (typeof groups)[number] | null = null
    for (const grp of groups) {
      const head = grp.members[0]
      // 规则 1：必须同地图节点（两边都有值且不同 → 不合并；任一方缺失 → 允许尝试）
      if (s.mapLocationId && head.mapLocationId && s.mapLocationId !== head.mapLocationId) continue
      // 规则 2：冲突标记互斥 → 不合并
      if (grp.tags.some((t) => tagsConflict(t, tags))) continue
      // 规则 3：相似度达标 → 合并
      const sim = Math.max(...grp.grams.map((gg) => similarity(g, gg)))
      if (sim >= threshold) {
        target = grp
        break
      }
    }

    if (target) {
      target.members.push(s)
      target.tags.push(tags)
      target.grams.push(g)
    } else {
      groups.push({ members: [s], tags: [tags], grams: [g] })
    }
  }

  return groups.map((grp, i) => {
    const rep = grp.members[0]
    const reason =
      grp.members.length === 1
        ? `独立场景（${rep.name}）`
        : `空间结构与主要布景相近，共用一张背景（${grp.members.map((m) => m.name).join('、')}）`
    return {
      groupId: `sg${i + 1}`,
      sceneIds: grp.members.map((m) => m.sceneId),
      representative: rep,
      reason
    }
  })
}

/**
 * 计算分组收益（给 UI 显示「X 个场景 → Y 张图」）。
 */
export function groupSavings(scenes: SceneForGrouping[], threshold?: number): {
  sceneCount: number
  groupCount: number
  saved: number
  groups: SceneGroup[]
} {
  const groups = groupScenes(scenes, threshold)
  return {
    sceneCount: scenes.length,
    groupCount: groups.length,
    saved: Math.max(0, scenes.length - groups.length),
    groups
  }
}

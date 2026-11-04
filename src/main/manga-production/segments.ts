/**
 * 漫画段落切分：speech → 配音段（clip）。
 *
 * 【为什么需要它 —— 实测得出的映射规则】
 *
 * 截图上「12 条讲述 · 30 段配音」曾让我以为是两份独立数据。实测 gmzz-10 后确认：
 *
 *   **30 = 第 1 章 12 条台词按 `。！？` 切成的句子段。**
 *
 * 证据（逐条对上，不是推断）：
 *   - 第 1 章台词总字数 708，30 段平均 24 字；
 *   - 按 `。！？` 切分恰好得到 **30 段**（按「任意标点」会得到 77 段，按「。！？…」得 34 段）；
 *   - 切分结果与截图逐字一致：
 *       [0] "周明瑞是被一阵剧烈的头痛疼醒的。"           16 字 → 截图 5.0s
 *       [1] "梦里的低语还没散去…手脚却怎么也动不了。"    42 字 → 截图 11.5s
 *     字数比 16:42 = 27.6%:72.4%，截图时长比 5.0:11.5 = 30.3%:69.7% —— 吻合。
 *
 * 【为什么 clip 自己不带文本】clip 里只有 `fingerprint`（既不是 sha(文本)，
 * 各种拼法都撞不上）和 `order`（1000000 起）。也就是说**包内没有可直接对账的
 * 文本线索**，只能靠"同一切分规则 + 章内顺序"来重建对应关系。
 * 因此这里的分段器必须与产出方使用**完全相同的切分规则**，否则 order 会错位。
 */

/** 配音段：一句台词切出的一个句子 */
export interface MangaSpeechSegment {
  /** 章内全局段序号（0 起），对应 clip.order - 1000000 */
  index: number
  /** 所属章 */
  chapterSeq: number
  /** 所属页（1 起） */
  page: number
  /** 所属分镜（页内 1 起） */
  panel: number
  /** 该段在所属 speech 内的序号（0 起） */
  segIndexInSpeech: number
  /** 该 speech 在本页内的序号（用于回显/定位） */
  speechIndexInPage: number
  /** 原始台词类型（narration/say/think） */
  type: string
  /** 说话人（narration 通常为空） */
  speaker: string
  /** 该段的文本 */
  text: string
  /** 该段所属 speech 的完整文本（重新合成时用来回退整句） */
  fullText: string
}

/**
 * 切分一条台词为句子段。
 *
 * **必须与产出方同规则**：只在 `。！？` 之后切，且保留标点在前段末尾。
 * 用 `lookbehind`（`(?<=[。！？])`）而不是 `split(/[。！？]/)` ——
 * 后者会把标点丢掉，文本不可逆，重新合成时会读出没有句号的怪句子。
 */
export function splitSpeechToSegments(text: string): string[] {
  if (typeof text !== 'string' || !text) return []
  return text
    .split(/(?<=[。！？])/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 章节的最小输入形状（只取分段需要的字段，避免依赖完整 MangaViewData） */
export interface SegmentSourcePage {
  /** 页序号（1 起） */
  page: number
  panels: {
    /** 分镜序号（页内 1 起） */
    no: number
    speech: { type: string; speaker?: string; text: string }[]
  }[]
}

/**
 * 把一章的台词展开成配音段序列，并与 clip 的 `order - 1000000` 对齐。
 *
 * 返回顺序 = 配音顺序（页 → 格 → 台词 → 句）。
 */
export function buildSegmentIndex(chapterSeq: number, pages: SegmentSourcePage[]): MangaSpeechSegment[] {
  const out: MangaSpeechSegment[] = []
  let idx = 0
  // 页与格按**它们在数组里的顺序**遍历：包内 page/no 字段有过不一致（实测 page 恒为 1
  // 而实际有 11 页，真正可靠的是数组顺序），所以不按 page 字段排序。
  for (const pg of pages) {
    let speechIdxInPage = 0
    for (const pn of pg.panels ?? []) {
      for (const sp of pn.speech ?? []) {
        const fullText = sp.text ?? ''
        const segs = splitSpeechToSegments(fullText)
        for (let i = 0; i < segs.length; i++) {
          out.push({
            index: idx++,
            chapterSeq,
            page: pg.page,
            panel: pn.no,
            segIndexInSpeech: i,
            speechIndexInPage: speechIdxInPage,
            type: sp.type ?? '',
            speaker: sp.speaker ?? '',
            text: segs[i],
            fullText
          })
        }
        speechIdxInPage++
      }
    }
  }
  return out
}

/**
 * 把配音段序列与 clip 列表对齐，返回 `order → segment` 映射。
 *
 * 若段数与 clip 数不一致，**不做任何猜测性对齐**：宁可返回空映射并给出提示，
 * 也不要错配（错配会让用户"重新配音"时把 A 句的音频写到 B 句上，且听不出来）。
 */
export function alignSegmentsToClips(
  segments: MangaSpeechSegment[],
  clips: { order: number }[],
  orderBase = 1_000_000
): { map: Map<number, MangaSpeechSegment>; exact: boolean; reason?: string } {
  const map = new Map<number, MangaSpeechSegment>()
  if (!segments.length || !clips.length) {
    return { map, exact: false, reason: '没有台词或没有配音段' }
  }
  if (segments.length !== clips.length) {
    return {
      map,
      exact: false,
      reason: `段落数（${segments.length}）与配音段数（${clips.length}）不一致，无法安全对齐`
    }
  }
  const sorted = [...clips].sort((a, b) => a.order - b.order)
  for (let i = 0; i < segments.length; i++) {
    map.set(sorted[i].order - orderBase, segments[i])
  }
  // 严格校验 order 是否连续（0..n-1）；不连续说明对齐假设不成立
  const keys = [...map.keys()].sort((a, b) => a - b)
  const contiguous = keys.every((k, i) => k === i)
  if (!contiguous) {
    return {
      map,
      exact: false,
      reason: `配音段序号不连续（${keys[0]}..${keys[keys.length - 1]}），无法按顺序对齐`
    }
  }
  return { map, exact: true }
}

/**
 * 章节结构识别 · LLM 兜底通道（§5 `chapter_recognition_system_prompt`）。
 *
 * 解决的问题：`txt-import.ts` 的 `splitChapters()` 是**纯正则**实现，
 * 只认「第X章」「Chapter N」「序章/楔子」「番外」「#」这几种写法。
 * 实测常见失败：
 *   - 只用「一、二、三」或「1. 2. 3.」编号的中文小说 → 一个章都切不出来，退化成整本单章
 *   - 混用「卷一」+「第一章」（有两级结构）→ 只切到其中一级
 *   - 标题用全角空格、特殊符号分隔 → SEP_CLASS 覆盖不到
 *
 * 本模块按新版模板的设计走：**程序统计候选组，LLM 只做「选哪个组当章节」的判断**，
 * 不生成正则、不切文本。这是关键约束——让 LLM 直接产出切分结果不可靠（会丢字、
 * 会幻觉行号），而「二选一/多选一」的判断它很擅长。
 *
 * 失败即回落：任何一步出错（未配置 LLM / 超时 / 返回不可解析 / status=uncertain）
 * 都返回 null，调用方继续用正则结果。**绝不因为兜底坏了就导入失败。**
 */

/** 候选组：同一「格式家族」的标题行集合 */
export interface ChapterCandidateGroup {
  /** 唯一组 id（程序生成，供模型引用） */
  groupId: string
  /** 标题格式的家族描述，如「第{n}章」「{n}、」「Chapter {n}」 */
  family: string
  /** 程序初始分类（不是结论）：chapter | volume | special | unknown */
  kind: 'chapter' | 'volume' | 'special' | 'unknown'
  /** 该组命中条数 */
  count: number
  /** 有实质正文的条目数（与下一条候选或显式卷标记之间 ≥200 个非空白正文字符） */
  substantive: number
  /** 正文为空的条目数 */
  empty: number
  /** 编号重新出现 1 的次数 */
  resets: number
  /** 相邻两条编号均可解析时，当前编号 ≠ 上一条+1 的次数（跨卷重置也计入） */
  discontinuities: number
  /** 样例（首、尾、中间各一条） */
  samples: ChapterSample[]
  /** 异常样例（短正文或编号异常） */
  anomalies: ChapterSample[]
  /** 未发送的异常数量 */
  omittedAnomalies: number
}

export interface ChapterSample {
  /** 候选 id，仅用于定位 */
  candidateId: string
  /** 清理后全文行号（从 1 开始） */
  line: number
  /** 可解析的原始标题编号（无法解析时省略） */
  number?: number
  /** 原始标题整行 */
  title: string
  /** 该间隔正文字符数 */
  bodyCharacters: number
  /** 标题后最多 180 字符的上下文 */
  following: string
  /** 紧邻的上一个候选组或 null */
  previousGroup: string | null
}

/** 模板输入的结构报告 */
export interface ChapterStructureReport {
  characters: number
  candidateCount: number
  groups: ChapterCandidateGroup[]
}

/** 模型返回的单组判定 */
export interface ChapterGroupDecision {
  groupId: string
  role: 'chapter' | 'volume' | 'special' | 'ignore'
}

/** 模型返回的完整判定 */
export interface ChapterRecognitionResult {
  version: 1
  status: 'ready' | 'uncertain'
  groups: ChapterGroupDecision[]
  volumeTitle: 'sameLine' | 'nextShortLine'
  numbering: 'continuous' | 'restartPerVolume'
  reason: string
}

/** 一行候选标题 */
interface CandidateLine {
  candidateId: string
  lineNo: number
  title: string
  charStart: number
  number: number | null
  familyKey: string
  familyLabel: string
  kind: 'chapter' | 'volume' | 'special' | 'unknown'
  bodyCharacters: number
  following: string
}

/**
 * 识别一行的「格式家族」。
 *
 * 只做**轻量归一**，不追求完备——目的是把「第1章」「第2章」归到同一族，
 * 让模型看到「这个族有 40 条、编号连续」而不是 40 个孤立行。
 *
 * @returns null 表示这一行不像标题（不进候选）
 */
function classifyLine(body: string): { familyKey: string; familyLabel: string; number: number | null; kind: CandidateLine['kind'] } | null {
  const t = body.trim()
  if (!t) return null
  // 标题行不应太长（超长多半是正文里恰好以数字开头）
  if (t.length > 60) return null

  // 1) 第N章 / 第N回 / 第N节 ...
  let m = /^第\s*([0-9０-９一二三四五六七八九十百千零〇两]+)\s*([章回节篇部卷集话話])/.exec(t)
  if (m) {
    const kindMap: Record<string, CandidateLine['kind']> = {
      卷: 'volume',
      部: 'volume',
      集: 'volume',
      章: 'chapter',
      回: 'chapter',
      节: 'chapter',
      篇: 'chapter',
      话: 'chapter',
      話: 'chapter'
    }
    return {
      familyKey: `di-${m[2]}`,
      familyLabel: `第{n}${m[2]}`,
      number: cnToNumber(m[1]),
      kind: kindMap[m[2]] ?? 'unknown'
    }
  }

  // 2) Chapter N / CHAPTER N
  m = /^(?:chapter|chap\.?)\s*([0-9]+)\b/i.exec(t)
  if (m) {
    return { familyKey: 'chapter-en', familyLabel: 'Chapter {n}', number: Number(m[1]), kind: 'chapter' }
  }

  // 3) 「一、」「十二、」（中文序号 + 顿号）
  m = /^([0-9０-９一二三四五六七八九十百千零〇两]+)\s*[、.．]\s*\S/.exec(t)
  if (m) {
    return {
      familyKey: 'cn-num-dun',
      familyLabel: '{n}、',
      number: cnToNumber(m[1]),
      kind: 'chapter'
    }
  }

  // 4) 「卷一」「卷1」
  m = /^卷\s*([0-9０-９一二三四五六七八九十百千零〇两]+)/.exec(t)
  if (m) {
    return { familyKey: 'juan-lead', familyLabel: '卷{n}', number: cnToNumber(m[1]), kind: 'volume' }
  }

  // 5) 序章 / 楔子 / 尾声 / 番外
  if (/^(序章|序言|序曲|楔子|前言|引子|尾声|终章|后记|跋|番外)/.test(t)) {
    return { familyKey: 'special', familyLabel: '特殊篇章', number: null, kind: 'special' }
  }

  // 6) Markdown 标题
  m = /^(#{1,6})\s+\S/.exec(t)
  if (m) {
    return { familyKey: `md-${m[1].length}`, familyLabel: `${m[1]} 标题`, number: null, kind: 'unknown' }
  }

  return null
}

/** 中文数字 → 整数（够用即可；解析不了返回 null） */
export function cnToNumber(s: string): number | null {
  if (!s) return null
  // 全角数字
  const normalized = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  if (/^[0-9]+$/.test(normalized)) return Number(normalized)
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9
  }
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 }
  let total = 0
  let section = 0
  let digit = 0
  for (const ch of normalized) {
    if (ch in digits) {
      digit = digits[ch]
    } else if (ch in units) {
      const u = units[ch]
      if (digit === 0) digit = 1
      section += digit * u
      digit = 0
    } else {
      return null
    }
  }
  total = section + digit
  return total > 0 ? total : null
}

/**
 * 扫描全文，产出**结构报告**（喂给模型的最小必要信息）。
 *
 * 不把全文发给模型：一本 30 万字的小说塞不进去，也没必要——
 * 判断「哪个组是章节」只需要统计特征 + 少量样例。
 *
 * @param text 全书正文（已解码）
 * @param maxGroups 最多保留几个候选组（按 count 降序，避免长尾噪声）
 */
export function buildStructureReport(text: string, maxGroups = 12): ChapterStructureReport {
  const lines = text.split('\n')
  const candidates: CandidateLine[] = []
  let pos = 0
  let candidateSeq = 0

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const lineStart = pos
    pos += raw.length + 1
    const trimmed = raw.trimStart()
    if (!trimmed) continue
    const body = trimmed.trimEnd()
    const cls = classifyLine(body)
    if (!cls) continue
    candidateSeq += 1
    candidates.push({
      candidateId: `c${candidateSeq}`,
      lineNo: i + 1,
      title: body,
      charStart: lineStart + (raw.length - trimmed.length),
      number: cls.number,
      familyKey: cls.familyKey,
      familyLabel: cls.familyLabel,
      kind: cls.kind,
      bodyCharacters: 0, // 稍后回填
      following: body.slice(0, 180)
    })
  }

  // 回填「本候选到下一候选之间的正文字符数」
  for (let i = 0; i < candidates.length; i++) {
    const start = candidates[i].charStart + candidates[i].title.length
    const end = i + 1 < candidates.length ? candidates[i + 1].charStart : text.length
    const seg = text.slice(start, Math.max(start, end))
    candidates[i].bodyCharacters = seg.replace(/\s/g, '').length
    candidates[i].following = text.slice(start, start + 180).replace(/\s+/g, ' ').trim()
  }

  // 按家族分组
  const byFamily = new Map<string, CandidateLine[]>()
  for (const c of candidates) {
    const arr = byFamily.get(c.familyKey) ?? []
    arr.push(c)
    byFamily.set(c.familyKey, arr)
  }

  // 按条数降序取前 maxGroups 个家族（长尾多半是正文误匹配）
  const sortedFamilies = [...byFamily.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, maxGroups)

  const groups: ChapterCandidateGroup[] = sortedFamilies.map(([, list], gi) => {
    const numbers = list.map((c) => c.number).filter((n): n is number => n !== null)
    // resets：编号「重新出现 1」的次数 = 编号 1 出现次数 − 1（首次不是"重新"）。
    // 模板原文是「编号重新出现1的次数」，语义是**回绕**次数，不是"编号为1的条数"。
    // 连续编号的 1..N 应为 0；跨卷重置（1..10, 1..10）应为 1。
    const onesCount = numbers.filter((n) => n === 1).length
    const resets = Math.max(0, onesCount - 1)
    // discontinuities：相邻可解析编号 ≠ 前一条+1 的次数
    let discontinuities = 0
    for (let i = 1; i < numbers.length; i++) {
      if (numbers[i] !== numbers[i - 1] + 1 && numbers[i] !== 1) discontinuities++
    }
    const substantive = list.filter((c) => c.bodyCharacters >= 200).length
    const empty = list.filter((c) => c.bodyCharacters < 20).length
    const anomalies = list.filter((c) => c.bodyCharacters < 20 || c.bodyCharacters > 60000).slice(0, 3)
    const omittedAnomalies = Math.max(0, list.filter((c) => c.bodyCharacters < 20 || c.bodyCharacters > 60000).length - 3)

    // 样例：首、中、尾各一条（去重）
    const pickIdx = new Set<number>([0, Math.floor(list.length / 2), list.length - 1])
    const samples: ChapterSample[] = [...pickIdx]
      .filter((i) => i >= 0 && i < list.length)
      .map((i) => toSample(list[i], gi > 0 ? `g${gi}` : null))

    return {
      groupId: `g${gi + 1}`,
      family: list[0].familyLabel,
      kind: list[0].kind,
      count: list.length,
      substantive,
      empty,
      resets,
      discontinuities,
      samples,
      anomalies: anomalies.map((c) => toSample(c, gi > 0 ? `g${gi}` : null)),
      omittedAnomalies
    }
  })

  return {
    characters: text.length,
    candidateCount: candidates.length,
    groups
  }
}

function toSample(c: CandidateLine, prevGroup: string | null): ChapterSample {
  return {
    candidateId: c.candidateId,
    line: c.lineNo,
    ...(c.number !== null ? { number: c.number } : {}),
    title: c.title,
    bodyCharacters: c.bodyCharacters,
    following: c.following,
    previousGroup: prevGroup
  }
}

/** 模型返回的 JSON 解析（严格按模板输出契约） */
export function parseRecognitionJson(content: string): ChapterRecognitionResult | null {
  let text = (content ?? '').trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fence) text = fence[1].trim()
  let obj: unknown = null
  try {
    obj = JSON.parse(text)
  } catch {
    const s = text.indexOf('{')
    const e = text.lastIndexOf('}')
    if (s < 0 || e <= s) return null
    try {
      obj = JSON.parse(text.slice(s, e + 1))
    } catch {
      return null
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const o = obj as Record<string, unknown>
  if (o.version !== 1) return null
  const status = o.status === 'ready' || o.status === 'uncertain' ? o.status : null
  if (!status) return null
  if (!Array.isArray(o.groups)) return null
  const groups: ChapterGroupDecision[] = []
  for (const g of o.groups) {
    if (!g || typeof g !== 'object' || Array.isArray(g)) continue
    const gr = g as Record<string, unknown>
    const groupId = typeof gr.groupId === 'string' ? gr.groupId : ''
    const role = gr.role
    if (!groupId) continue
    if (role !== 'chapter' && role !== 'volume' && role !== 'special' && role !== 'ignore') continue
    groups.push({ groupId, role })
  }
  if (!groups.length) return null
  const volumeTitle =
    o.volumeTitle === 'nextShortLine' ? 'nextShortLine' : 'sameLine'
  const numbering =
    o.numbering === 'restartPerVolume' ? 'restartPerVolume' : 'continuous'
  const reason = typeof o.reason === 'string' ? o.reason.slice(0, 600) : ''
  return { version: 1, status, groups, volumeTitle, numbering, reason }
}

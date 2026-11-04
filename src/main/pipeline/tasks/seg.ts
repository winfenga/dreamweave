/**
 * `seg` 任务适配器（T6-A 第一批；模板 `chapter_seg_user_prompt`）。
 *
 * 产物：`records/results/seg.json`（条目 key = 实例键）。
 * 输入：**带行号原文**（与 cacheWarming 逐字同构：每行首「行号 + 一个空格」、
 * 各章从 1 重新编号、每章外包 `【原文行：1-N】`；见 `../chunk-source`）。
 *
 * 输出（与真实工作库 `5662f1d3` 的 results 分片实摘同构）：
 * ```jsonc
 * { "output": { "chapters": [ { "chapterSeq": 1,
 *     "segments": [ { "起始行号": 1, "结束行号": 11, "name": "开头倒叙——……", "summary": "……" } ] } ] },
 *   "warnings": [] }
 * ```
 * 注意：模型输出用**中文字段名**（`起始行号`/`结束行号`）——模板契约如此，照抄不英文化。
 *
 * 【派生层说明】真实工作库的 seg 数据还有一层**程序派生**的 `data.segments`
 * （扁平数组：`id = S-{章}-{序}`、`chapterSeq`、`index`、`start/end` 字符偏移）。
 * 已 grep 全仓（`src/` 含 renderer）：**没有任何消费者读 `data.segments` 或 `S-` 前缀 id**
 * （`segments` 的全部命中都是 ReadingSegment 阅读切段 / 分片键拆分等无关代码）。
 * 故本适配器 `parse()` 只产模型数据 `{output, warnings}`；派生层留待消费者实现时补，
 * 不自行扩展适配器接口。
 *
 * 合并策略：`concat-dedup-order` + 显式 `keyOf`（理由见 `segKeyOf` 处注释）。
 * parse 必填键（顶层）：`output`（对象）；`warnings` 缺失时补 `[]`（模型常省略）。
 * 模型级契约（不逐层校验，与 cacheWarming 只校验 `answer` 同风格）：
 * `output.chapters: [{ chapterSeq, segments: [{ 起始行号, 结束行号, name, summary }] }]`。
 */
import type { ChatMessage, LlmTaskAdapter, TaskRuntime } from '../../../shared/pipeline-types'
import { numberLines } from '../chunk-source'
import { parseJsonLoose } from './cacheWarming'

/**
 * 章/段条目的稳定键（供 `concat-dedup-order` 的 dedupeDeep 用）。
 *
 * 为什么必须显式提供（读 `../merge` 后的结论）：
 *  - L2 切批按**段落/行/句子**边界（`splitUnits`），不尊重章边界——同一章可能被多个批次
 *    各自产出片段；`mergeOutputs` 对对象先字段级 `combineFirst`（`chapters` 数组直接拼接），
 *    再 `dedupeDeep` 按稳定键去重。章条目的天然稳定键是 `chapterSeq`（模板契约：每章恰好一次），
 *    同章重复产出时保留首次出现（与 `combineFirst` 的「a 优先」语义一贯）。
 *  - 缺省 `defaultKeyOf` 对章对象会退化成整对象 JSON 串（同章不同片段会双双保留，
 *    下游看到重复 chapterSeq）；对段对象会误取 `name` 字段（跨章重名段虽在不同数组不会相消，
 *    但章内重名段会互相吞）。故按结构分流：章 → `chapter:<seq>`，段 → `seg:<起始行号>`
 *    （模板保证章内不漏不重叠，起始行号章内唯一），其余退化为 JSON 串。
 */
export function segKeyOf(part: unknown): string {
  if (typeof part === 'string') return `warn:${part}`
  if (part && typeof part === 'object' && !Array.isArray(part)) {
    const o = part as Record<string, unknown>
    if (typeof o.chapterSeq === 'number') return `chapter:${o.chapterSeq}`
    if (typeof o['起始行号'] === 'number') return `seg:${o['起始行号']}`
  }
  try {
    return JSON.stringify(part)
  } catch {
    return String(part)
  }
}

/**
 * 从 rt 推导模板变量（`chapter_seg_user_prompt` 的 `{{{var}}}` 占位符）。
 * 缺 chunkChapters 时视作单章（seq=1）并给合理回退，绝不传 undefined。
 */
function segTemplateVars(rt: TaskRuntime): Record<string, unknown> {
  const chapters = rt.chunkChapters ?? [{ seq: 1, title: '（单章原文）', text: rt.chunkText }]
  const seqs = chapters.map((c) => c.seq).filter((n) => Number.isFinite(n))
  const first = seqs.length ? seqs[0] : 1
  const last = seqs.length ? seqs[seqs.length - 1] : 1
  return {
    chunkIndex: rt.chunkIndex ?? 0,
    // 章节范围：`首章seq-末章seq`（如 `1-4`）；单章时就是该数字
    chapterRange: first === last ? String(first) : `${first}-${last}`
  }
}

export const segAdapter: LlmTaskAdapter = {
  id: 'seg',
  mergeStrategy: 'concat-dedup-order',
  keyOf: segKeyOf,

  async inputText(rt: TaskRuntime): Promise<string> {
    // 与 cacheWarming 逐字同构：有章节切片按「各章从 1 重新编号」组装；
    // 否则（调用方直接注入 chunkText）视作单章原文。
    const chapters = rt.chunkChapters ?? [{ seq: 1, title: '（单章原文）', text: rt.chunkText }]
    return numberLines(chapters)
  },

  async buildMessages(batchText: string, rt: TaskRuntime): Promise<ChatMessage[]> {
    const system = await rt.render('common_system_prompt', {})
    const instruction = await rt.render('chapter_seg_user_prompt', segTemplateVars(rt))
    // 任务指令放最后（与 cacheWarming 一致）
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
      const output = o.output
      // 必填键：顶层 output（对象）。warnings 模型常省略 → 补 []，保持形状稳定。
      if (output && typeof output === 'object' && !Array.isArray(output)) {
        return { output, warnings: Array.isArray(o.warnings) ? o.warnings : [] }
      }
    }
    // 兜底（与 cacheWarming 的 raw 兜底同风格）：不抛崩，保留原文截断供排查
    return { output: null, warnings: [], raw: (content ?? '').slice(0, 500) }
  }
}

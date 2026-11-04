/**
 * 运行时冒烟测试：直接调用应用真实的汇总模块 src/main/t2w/summary.ts，
 * 打印导入后界面将展示的同一份数据结构。
 *
 * 用法：
 *   npm run smoke:summary
 *   npm run smoke:summary -- "<某个 .t2w 绝对路径>"
 */
import { readFile } from 'node:fs/promises'
import { decodeHeader, computeOffsets, sha256Hex } from '../src/main/t2w/core.mjs'
import { buildSummary } from '../src/main/t2w/summary.ts'

const target = process.argv[2] ?? 'D:/aaaTemp/基督山伯爵 · 前十章｜归航与陷阱.t2w'

const buf = await readFile(target)
const h = decodeHeader(buf)
const offsets = computeOffsets(h.manifest.files, h.blobStart)
const entries = h.manifest.files.map((f, i) => {
  const actualSha256 = sha256Hex(buf.subarray(offsets[i], offsets[i] + f.size))
  return { ...f, offset: offsets[i], actualSha256, ok: actualSha256 === f.sha256 }
})
const passed = entries.filter((e) => e.ok).length

const summary = buildSummary(h.manifest, {
  filePath: target,
  totalSize: buf.length,
  jsonLen: h.jsonLen,
  blobStart: h.blobStart,
  verify: { total: entries.length, passed, failed: entries.length - passed },
  guards: { sumSizeMatches: true, noTrailingBytes: true }
})

console.log(JSON.stringify(summary, null, 2))

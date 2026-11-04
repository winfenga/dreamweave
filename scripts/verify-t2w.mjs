/**
 * .t2w 容器格式验证脚本（直接复用应用主进程的同一份实现 src/main/t2w/core.mjs）
 *
 * 用法：
 *   node scripts/verify-t2w.mjs                       # 校验 D:/aaaTemp 下全部 .t2w
 *   node scripts/verify-t2w.mjs --size 79989228       # 只校验指定体积的包
 *   node scripts/verify-t2w.mjs "<某个包的绝对路径>"   # 校验单个包
 *
 * 验证内容（与 recon/格式规范_t2w.md 对齐）：
 *   1. magic == "T2WPKG1\n"；2. jsonLen 为大端 u32；3. format == txt2world-package-v1
 *   4. Σ files[i].size == 总长 - (12 + jsonLen)
 *   5. (blobStart + Σ size) == 总长（无尾随字节）
 *   6. 每个成员切片 sha256 == 清单声明的 sha256
 *   7. 读 → 写 → 读 往返一致（写出即自洽，sha256 回填正确）
 */
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { computeOffsets, decodeHeader, encodePackage, sha256Hex } from '../src/main/t2w/core.mjs'

function verify(buf) {
  const { jsonLen, blobStart, manifest } = decodeHeader(buf)
  const files = manifest.files
  const total = buf.length
  const blobLen = total - blobStart
  const sumSize = files.reduce((s, f) => s + f.size, 0)
  const offsets = computeOffsets(files, blobStart)

  const results = files.map((f, i) => {
    const offset = offsets[i]
    const actual = sha256Hex(buf.subarray(offset, offset + f.size))
    return { path: f.path, offset, size: f.size, ok: actual === f.sha256 }
  })
  const lastOffset = offsets.length ? offsets[offsets.length - 1] + files[files.length - 1].size : blobStart

  return {
    jsonLen,
    blobStart,
    manifest,
    total,
    sumSize,
    blobLen,
    guardSum: sumSize === blobLen,
    guardTail: lastOffset === total,
    results
  }
}

function extractBlobs(buf, parsed) {
  const out = []
  const offsets = computeOffsets(parsed.manifest.files, parsed.blobStart)
  parsed.manifest.files.forEach((f, i) => out.push(buf.subarray(offsets[i], offsets[i] + f.size)))
  return out
}

function chaptersOf(records) {
  const node = records?.chapters
  const list = Array.isArray(node)
    ? node.map((it) => (it && typeof it === 'object' && 'value' in it ? it.value : it))
    : node && typeof node === 'object'
      ? Object.values(node)
      : []
  return list.filter(Boolean).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
}

function canonicalOf(records) {
  const results = records?.results
  const list = Array.isArray(results)
    ? results.map((it) => ({ key: it?.key, value: it?.value }))
    : results && typeof results === 'object'
      ? Object.entries(results).map(([key, value]) => ({ key, value }))
      : []
  const hit = list.find((x) => typeof x.key === 'string' && x.key.endsWith(':canonical'))
  return hit?.value ?? null
}

async function targets() {
  const arg = process.argv[2]
  if (arg && arg !== '--size') return [arg]
  const sizeArg = process.argv.indexOf('--size')
  const wantSize = sizeArg >= 0 ? Number(process.argv[sizeArg + 1]) : null
  const dir = 'D:/aaaTemp'
  const names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith('.t2w'))
  const found = []
  for (const n of names) {
    const p = join(dir, n)
    const size = (await readFile(p)).length
    if (wantSize && size !== wantSize) continue
    found.push(p)
  }
  return found
}

async function main() {
  const list = await targets()
  console.log(`共 ${list.length} 个目标包（实现来自 src/main/t2w/core.mjs，与应用共用）\n`)
  const report = []

  for (const p of list) {
    const buf = await readFile(p)
    const parsed = verify(buf)
    const passed = parsed.results.filter((r) => r.ok).length
    const failed = parsed.results.length - passed

    const proj = parsed.manifest.project
    const chapters = chaptersOf(parsed.manifest.records)
    const objs = canonicalOf(parsed.manifest.records)?.objects ?? {}
    const cnt = (k) => (Array.isArray(objs[k]) ? objs[k].length : 0)

    // 读 → 写 → 读 往返
    const roundTrip = encodePackage(parsed.manifest, extractBlobs(buf, parsed))
    const tmp = join(tmpdir(), `t2w-roundtrip-${Date.now()}.t2w`)
    await writeFile(tmp, roundTrip)
    const back = verify(await readFile(tmp))
    await unlink(tmp)
    const roundTripOk =
      back.manifest.project.title === proj.title &&
      back.manifest.files.length === parsed.manifest.files.length &&
      back.results.every((r) => r.ok)

    console.log('='.repeat(78))
    console.log(`包: ${basename(p)}`)
    console.log(`  路径: ${p}`)
    console.log(`  总长: ${parsed.total} 字节`)
    console.log(`  magic "T2WPKG1\\n": OK | jsonLen(BE): ${parsed.jsonLen} | blobStart: ${parsed.blobStart}`)
    console.log(`  守卫 Σsize==blobLen: ${parsed.guardSum ? 'PASS' : 'FAIL'} (Σ=${parsed.sumSize}, blobLen=${parsed.blobLen})`)
    console.log(`  守卫 无尾随字节:    ${parsed.guardTail ? 'PASS' : 'FAIL'}`)
    console.log(`  sha256 成员校验:    ${passed}/${parsed.results.length} 通过, ${failed} 失败`)
    console.log(`  project.title:      ${JSON.stringify(proj.title)}`)
    console.log(`  chapterCount=${proj.chapterCount} charCount=${proj.charCount} revisionId=${proj.revisionId}`)
    console.log(`  records.chapters:   ${chapters.length} 条`)
    console.log(
      `  canonical.objects:  characters=${cnt('characters')} factions=${cnt('factions')} items=${cnt('items')} creatures=${cnt('creatures')}`
    )
    console.log(`  读→写→读 往返:      ${roundTripOk ? 'PASS' : 'FAIL'}`)
    if (failed > 0) {
      console.log('  失败成员:')
      for (const r of parsed.results.filter((x) => !x.ok)) {
        console.log(`    BAD ${r.path} @${r.offset} size=${r.size}`)
      }
    }
    report.push({
      file: basename(p),
      total: parsed.total,
      files: parsed.results.length,
      passed,
      failed,
      guardSum: parsed.guardSum,
      guardTail: parsed.guardTail,
      roundTripOk,
      title: proj.title,
      chapterCount: proj.chapterCount,
      charCount: proj.charCount,
      entities: {
        characters: cnt('characters'),
        factions: cnt('factions'),
        items: cnt('items'),
        creatures: cnt('creatures')
      }
    })
  }

  console.log('\n' + '='.repeat(78))
  console.log('汇总(JSON):')
  console.log(JSON.stringify(report, null, 2))
  const allOk = report.every((r) => r.failed === 0 && r.guardSum && r.guardTail && r.roundTripOk)
  console.log(`\n总体: ${allOk ? 'ALL PASS' : 'HAS FAILURES'}`)
  process.exitCode = allOk ? 0 : 1
}

main().catch((e) => {
  console.error('ERROR:', e.message)
  process.exitCode = 2
})

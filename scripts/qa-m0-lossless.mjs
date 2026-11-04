/**
 * QA-M0 · 独立无损往返复现（不采信工程师的 verify.ts / assembleManifest 作为唯一证据）
 *
 * 对全部 8 个样本包，独立复现：
 *   R0  M0-T0 原始断言：encodePackage(decodeHeader(原包).manifest, 原blobs) == 原包（逐字节）
 *   R1  G1 默认档：unpack → pack → 整包 sha256 与原包逐字节相等
 *   R2  G2 强档（关键）：删掉 meta/origin-header.bin + index.origin.hasOriginHeader=false
 *       → 强制 encodePackage 路径 → 整包仍与源逐字节相等
 *       （这才真正证明「重建无损」，G1 可能被 origin-header 拼接"掩盖"）
 *   R3  成员级：自己切 srcBlobs 算 sha256，与 src.files[i] / out.files[i] / store 字节三方比对
 *   R4  容器级：自己读 index.json + 分片文件重建（不调用被测 rebuildContainer），与源 records JSON.stringify 深比较
 *   R5  骨架不外泄：导出 manifest 顶层键序 == 源，且无 containerKeyed/project 等骨架字段泄漏
 *
 * 用法：node scripts/qa-m0-lossless.mjs
 */
import { mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(here, '..')
const SAMPLE_DIR = 'D:/aaaTemp'
const SCRATCH = join(FEATHER, 'scratch', 'qa-m0-lossless')
const core = await import(pathToFileURL(join(FEATHER, 'src/main/t2w/core.mjs')).href)

async function loadWorkspace() {
  const result = await build({
    entryPoints: [join(FEATHER, 'src/main/workspace/index.ts')],
    bundle: true, format: 'esm', platform: 'node', write: false,
    external: ['node:*'], logLevel: 'silent'
  })
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))
}
const ws = await loadWorkspace()

const sha256 = (b) => createHash('sha256').update(b).digest('hex')
const jeq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const safe = (f, i) => `${String(i).padStart(2, '0')}_${basename(f).replace(/[^\w.-]+/g, '_')}`

/** 独立重建某容器（不调用被测模块） */
function myRebuild(idx, shardEntriesByName) {
  const out = {}
  for (const name of idx.manifest.recordsKeys) {
    const rows = idx.shards.filter((s) => s.container === name)
    const entries = []
    for (const s of rows) entries.push(...(shardEntriesByName.get(s.file) ?? []))
    entries.sort((a, b) => a.seq - b.seq)
    const kind = idx.manifest.containers[name] ?? 'array'
    const keyed = idx.manifest.containerKeyed?.[name] ?? true
    if (kind === 'object') {
      const o = {}
      for (const e of entries) o[e.key] = e.value
      out[name] = o
    } else {
      out[name] = keyed ? entries.map((e) => ({ key: e.key, value: e.value })) : entries.map((e) => e.value)
    }
  }
  return out
}

const rows = []
async function main() {
  await rm(SCRATCH, { recursive: true, force: true })
  await mkdir(SCRATCH, { recursive: true })
  const names = (await readdir(SAMPLE_DIR)).filter((n) => n.toLowerCase().endsWith('.t2w')).sort()
  console.log(`QA-M0 独立无损往返：${names.length} 个样本包\n`)

  for (let i = 0; i < names.length; i++) {
    const pkg = join(SAMPLE_DIR, names[i])
    const key = safe(pkg, i)
    const problems = []

    const srcBuf = await readFile(pkg)
    const srcSha = sha256(srcBuf)
    const h = core.decodeHeader(srcBuf)
    const manifest = h.manifest
    const offsets = core.computeOffsets(manifest.files, h.blobStart)
    const srcBlobs = manifest.files.map((f, k) => Buffer.from(srcBuf.subarray(offsets[k], offsets[k] + f.size)))

    // R0
    const repro = core.encodePackage(manifest, srcBlobs)
    const r0 = repro.equals(srcBuf)

    // unpack
    const root = join(SCRATCH, 'ws', key)
    const unpackRes = await ws.unpack(pkg, root)
    const unpackReturnsIndex = unpackRes && unpackRes.index && unpackRes.index.indexVersion === 1

    // R4 independent container rebuild (before any mutation)
    const idx = JSON.parse(await readFile(join(root, 'index.json'), 'utf8'))
    const shardEntriesByName = new Map()
    for (const s of idx.shards) {
      const env = JSON.parse(await readFile(join(root, s.file), 'utf8'))
      shardEntriesByName.set(s.file, env.entries)
    }
    const rebuilt = myRebuild(idx, shardEntriesByName)
    const srcRec = manifest.records ?? {}
    const recKeysSame = jeq(Object.keys(rebuilt), Object.keys(srcRec))
    const badContainers = Object.keys(srcRec).filter((n) => !jeq(rebuilt[n], srcRec[n]))
    const r4 = recKeysSame && badContainers.length === 0
    if (!r4) problems.push(`容器不等: ${badContainers.join(',')}; keysSame=${recKeysSame}`)
    // 六容器形态记录
    const six = ['chapters', 'chunks', 'tasks', 'results', 'attempts', 'reader']
    const sixPresent = six.filter((n) => n in srcRec)

    // R1 G1
    const out1 = join(SCRATCH, 'out-g1', key)
    const pack1 = await ws.pack(root, out1)
    const outBuf1 = await readFile(out1)
    const r1 = outBuf1.equals(srcBuf)
    if (!r1) problems.push(`G1 整包不等 (byteExact=${pack1.byteExact}, usedOriginHeader=${pack1.usedOriginHeader})`)

    // R3 member-level (from G1 output)
    const oh1 = core.decodeHeader(outBuf1)
    let r3 = oh1.manifest.files.length === manifest.files.length
    for (let k = 0; k < manifest.files.length && r3; k++) {
      const a = manifest.files[k], b = oh1.manifest.files[k]
      const storeBuf = await readFile(join(root, idx.assets[k].store))
      if (a.path !== b.path || a.size !== b.size || a.sha256 !== b.sha256) { r3 = false; problems.push(`成员#${k} files[] 不符: ${a.path}`) }
      if (sha256(srcBlobs[k]) !== a.sha256) { r3 = false; problems.push(`成员#${k} 源自切sha不符: ${a.path}`) }
      if (sha256(storeBuf) !== a.sha256) { r3 = false; problems.push(`成员#${k} store sha不符: ${a.path}`) }
      if (!storeBuf.equals(srcBlobs[k])) { r3 = false; problems.push(`成员#${k} store 字节≠源: ${a.path}`) }
    }

    // R5 骨架不外泄
    const outKeys = Object.keys(oh1.manifest)
    const srcKeys = Object.keys(manifest)
    const r5 = jeq(outKeys, srcKeys) && !('containerKeyed' in oh1.manifest)
    if (!r5) problems.push(`骨架键序/泄漏: out=${JSON.stringify(outKeys)} src=${JSON.stringify(srcKeys)}`)

    // R2 强档 G2：禁用 origin-header
    const idx2 = JSON.parse(await readFile(join(root, 'index.json'), 'utf8'))
    idx2.origin.hasOriginHeader = false
    await writeFile(join(root, 'index.json'), JSON.stringify(idx2, null, 2), 'utf8')
    await rm(join(root, 'meta', 'origin-header.bin'), { force: true })
    const out2 = join(SCRATCH, 'out-g2', key)
    const pack2 = await ws.pack(root, out2)
    const outBuf2 = await readFile(out2)
    const r2 = outBuf2.equals(srcBuf)
    if (!r2) problems.push(`G2(无origin-header) 整包不等 (byteExact=${pack2.byteExact}, usedOriginHeader=${pack2.usedOriginHeader})`)

    rows.push({
      name: names[i], srcSha, R0: r0, R1_G1: r1, R2_G2: r2, R3_member: r3, R4_container: r4, R5_skeleton: r5,
      unpackReturnsIndex, files: manifest.files.length, sixPresent, problems
    })
    const pass = r0 && r1 && r2 && r3 && r4 && r5
    console.log(`${pass ? '✅' : '❌'} ${names[i]}`)
    console.log(`    R0=${r0 ? 'ok' : 'NO'} R1(G1)=${r1 ? 'ok' : 'NO'} R2(G2无header)=${r2 ? 'ok' : 'NO'} R3成员=${r3 ? 'ok' : 'NO'} R4容器=${r4 ? 'ok' : 'NO'} R5骨架=${r5 ? 'ok' : 'NO'}  files=${manifest.files.length} 六容器=[${sixPresent.join(',')}]`)
    for (const p of problems) console.log(`      ⚠ ${p}`)

    // 清理本包工作库与输出，控制磁盘峰值
    await rm(root, { recursive: true, force: true })
    await rm(out1, { force: true })
    await rm(out2, { force: true })
  }

  const allOk = rows.every((r) => r.R0 && r.R1_G1 && r.R2_G2 && r.R3_member && r.R4_container && r.R5_skeleton)
  await writeFile(join(SCRATCH, 'result.json'), JSON.stringify(rows, null, 2), 'utf8')
  console.log(`\n==== QA-M0 独立无损往返：${allOk ? 'ALL PASS ✅' : 'HAS FAILURES ❌'} ====`)
  process.exitCode = allOk ? 0 : 1
}
main().catch((e) => { console.error('ERROR:', e?.stack ?? e); process.exitCode = 2 })

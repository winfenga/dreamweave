/**
 * M0-T3 · 工作库无损往返 golden 验收（设计 §5.3 断言清单 W1–W11）。
 *
 * 用项目已装的 esbuild 把 `src/main/workspace/` 打成单文件 ESM 后执行（零新增依赖）。
 *
 * 断言：
 *   W1  8 包「导入→导出」整包 sha256 逐字节相等（未编辑档 G1）
 *   W2  files[] 顺序 + 每项 path/size/sha256 与源全等
 *   W3  records 每个容器重建后与源深相等（含 results key 集合+顺序、reader、chapters、chunks、tasks、attempts）
 *   W4  project 全字段深等、顶层键序与 records 键序不变
 *   W5  副本基数：storyScript 条数（chunk 级 + batch 级）+ 合并动作数 == 源
 *   W6  未知字段保留：注入未知顶层键 + 未知 results 条目后往返不丢
 *   W7  编辑定点等价：仅目标分片变、其余分片 sha256 不变、二进制逐字节不变
 *   W8  自检：人为删分片 / 改资产 → workspaceVerify 报出具体缺失项
 *   W9  单句编辑（冷缓存单列，单分片读写）wall-time < 5s
 *   W10 叶真源守恒：reproject 前后 storyScript/plotLocation 分片 sha256 不变，且未被 reproject 触及
 *   W11 删全部可重建投影 → reproject → 与删前逐文件深等
 *
 * 形态覆盖：W1–W4 跑全部样本；W5–W11 覆盖「多 chunk」「有 plotLocationMerge」两类形态（缺失即判失败）。
 *
 * 用法：node scripts/verify-workspace.mjs
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(here, '..')
const SAMPLE_DIR = 'D:/aaaTemp'
const SCRATCH = join(FEATHER, 'scratch', 'm0-verify')
const PROJECTIONS_FILES = [
  'entities/canonical.json',
  'entities/appearances.json',
  'entities/relations.json',
  'world/location-tree.json',
  'world/plot-location-merge.json',
  'world/impression-layout.json',
  'script/line-annotation.json',
  'script/effect-annotation.json',
  'script/performance-review.json',
  'events/event-tree.json'
]

const core = await import(pathToFileURL(join(FEATHER, 'src/main/t2w/core.mjs')).href)

async function loadWorkspace() {
  const entry = join(FEATHER, 'src/main/workspace/index.ts')
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    external: ['node:*'],
    logLevel: 'silent'
  })
  const code = result.outputFiles[0].text
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
}

const ws = await loadWorkspace()

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const jeq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const safeName = (f) => basename(f).replace(/[^\w.-]+/g, '_')
const asyncStat = async (p) => {
  try {
    return await readFile(p)
  } catch {
    return null
  }
}

function toKeyed(node) {
  if (Array.isArray(node)) return node.map((it, i) => ({ key: String(it?.key ?? i), value: it?.value }))
  if (node && typeof node === 'object') return Object.entries(node).map(([key, value]) => ({ key, value }))
  return []
}
function unwrap(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'object') {
    const d = v.data
    if (d !== undefined && d !== null) return d
  }
  return v
}
/** 与 view.ts pickStoryScriptChunks 同规则（排除 :batch:，按 chunk 序号升序合并）。 */
function pickStoryScriptChunks(results) {
  const rank = (k) => {
    const m = /:storyScript(?::(\d+))?/.exec(k)
    return m && m[1] ? Number(m[1]) : 0
  }
  const hits = results
    .filter((r) => typeof r.key === 'string' && r.key.includes(':storyScript') && !r.key.includes(':batch:'))
    .sort((a, b) => rank(a.key) - rank(b.key))
  const list = hits.map((r) => unwrap(r.value)).filter((d) => !!d)
  if (list.length) return list
  return results
    .filter((r) => typeof r.key === 'string' && r.key.includes(':storyScript'))
    .map((r) => unwrap(r.value))
    .filter((d) => !!d)
    .slice(0, 1)
}
function ssStats(records) {
  const results = toKeyed(records.results)
  const all = results.filter((r) => r.key.includes(':storyScript'))
  const chunkLevel = all.filter((r) => !r.key.includes(':batch:'))
  const actionCount = pickStoryScriptChunks(results).reduce((s, d) => s + (d.actions?.length ?? 0), 0)
  return { allCount: all.length, chunkCount: chunkLevel.length, actionCount }
}
function actionsOf(value) {
  const d = value && typeof value === 'object' && value.data != null ? value.data : value
  return Array.isArray(d?.actions) ? d.actions : null
}
function shapeOf(manifest) {
  const results = toKeyed(manifest.records?.results ?? {})
  const shapes = new Set(results.map((r) => r.key.split(':').slice(2).join(':')))
  const chunkSeqs = new Set()
  for (const r of results) {
    const m = /:storyScript:(\d+)/.exec(r.key)
    if (m) chunkSeqs.add(Number(m[1]))
  }
  return {
    multiChunk: chunkSeqs.size > 1,
    hasPlotLocationMerge: [...shapes].some((s) => s.includes('plotLocationMerge')),
    chunkSeqs: [...chunkSeqs].sort((a, b) => a - b),
    charCount: manifest.project?.charCount ?? null
  }
}

// ---------------------------------------------------------------------------
const results = [] // { w, pkg, ok, detail }
const record = (w, pkg, ok, detail = '') => results.push({ w, pkg, ok, detail })
const shapes = new Map()

async function main() {
  await rm(SCRATCH, { recursive: true, force: true })
  await mkdir(SCRATCH, { recursive: true })

  const names = (await readdir(SAMPLE_DIR)).filter((n) => n.toLowerCase().endsWith('.t2w')).sort()
  const pkgs = names.map((n) => join(SAMPLE_DIR, n))
  console.log(`M0-T3 · 工作库无损往返 golden（${pkgs.length} 个样本包）\n`)

  const smallIndexes = []

  // ---- 全样本：W1–W4 ----
  for (let i = 0; i < pkgs.length; i++) {
    const pkg = pkgs[i]
    // 目录名用「序号_」前缀，杜绝 safeName 清洗 CJK 后可能的重名（实测「关于宗门…」与「梦舞蝶衣…」同形）
    const key = `${String(i).padStart(2, '0')}_${safeName(pkg)}`
    const srcBuf = await readFile(pkg)
    const src = core.decodeHeader(srcBuf).manifest
    const shape = shapeOf(src)
    shapes.set(basename(pkg), shape)

    const root = join(SCRATCH, 'ws', key)
    const outPath = join(SCRATCH, 'out', key)
    await ws.unpack(pkg, root)
    const packRes = await ws.pack(root, outPath)
    const outBuf = await readFile(outPath)
    const outH = core.decodeHeader(outBuf)
    const out = outH.manifest
    const rebuilt = await ws.assembleManifest(root, await ws.readIndex(root))

    // W1
    const w1 = packRes.byteExact && srcBuf.equals(outBuf) && sha256(srcBuf) === sha256(outBuf)
    record('W1', basename(pkg), w1, `byteExact=${packRes.byteExact} srcSha=${sha256(srcBuf).slice(0, 12)}…`)

    // W2
    const srcFiles = src.files
    const outFiles = out.files
    const w2 =
      srcFiles.length === outFiles.length &&
      srcFiles.every((f, i) => f.path === outFiles[i].path && f.size === outFiles[i].size && f.sha256 === outFiles[i].sha256)
    record('W2', basename(pkg), w2, `files=${srcFiles.length}`)

    // S1【M0-T5/A3.2】输出包结构性断言：Σ(size) == blobLen 且无尾随字节（与 M0-T5/A1 同一判据的正向）
    const outSum = outFiles.reduce((s, f) => s + f.size, 0)
    const outBlobLen = outBuf.length - outH.blobStart
    const s1 = outSum === outBlobLen
    record('S1', basename(pkg), s1, `Σsize=${outSum} blobLen=${outBlobLen}`)

    // W3
    const srcRec = src.records ?? {}
    const rebuiltRec = rebuilt.records ?? {}
    const w3 = Object.keys(srcRec).every((name) => JSON.stringify(rebuiltRec[name]) === JSON.stringify(srcRec[name])) && jeq(Object.keys(rebuiltRec), Object.keys(srcRec))
    const badContainers = Object.keys(srcRec).filter((n) => JSON.stringify(rebuiltRec[n]) !== JSON.stringify(srcRec[n]))
    record('W3', basename(pkg), w3, badContainers.length ? `不等容器: ${badContainers.join(',')}` : `containers=${Object.keys(srcRec).join(',')}`)

    // W4
    const w4 =
      jeq(rebuilt.project, src.project) &&
      jeq(Object.keys(rebuilt), Object.keys(src)) &&
      jeq(Object.keys(rebuilt.records ?? {}), Object.keys(srcRec))
    record('W4', basename(pkg), w4, w4 ? '' : 'project/键序不符')

    smallIndexes.push({ pkg, basename: basename(pkg), key, root, size: srcBuf.length })
  }

  // ---- R2【M0-T5/A3.1】删掉 meta/origin-header.bin 后，导出仍整包逐字节相等（Q1 自足 · 强档） ----
  for (const { pkg, basename: name, key } of smallIndexes) {
    const root = join(SCRATCH, 'r2', key)
    await ws.unpack(pkg, root)
    await rm(join(root, 'meta/origin-header.bin'), { force: true })
    const idx = await ws.readIndex(root)
    idx.origin.hasOriginHeader = false
    await ws.writeIndex(root, idx)
    const outPath = join(SCRATCH, 'r2', 'out', key)
    const res = await ws.pack(root, outPath)
    const outBuf = await readFile(outPath)
    const srcBuf = await readFile(pkg)
    const ok = res.byteExact && srcBuf.equals(outBuf) && sha256(srcBuf) === sha256(outBuf)
    record('R2', name, ok, `删 origin-header 后 byteExact=${res.byteExact} usedOriginHeader=${res.usedOriginHeader}`)
  }

  // ---- W5：副本基数（全样本） ----
  for (const { pkg, basename: name, root } of smallIndexes) {
    const src = core.decodeHeader(await readFile(pkg)).manifest
    const rebuilt = await ws.assembleManifest(root, await ws.readIndex(root))
    const a = ssStats(src.records)
    const b = ssStats(rebuilt.records)
    const ok = a.allCount === b.allCount && a.chunkCount === b.chunkCount && a.actionCount === b.actionCount
    record('W5', name, ok, `all ${a.allCount}=${b.allCount} chunk ${a.chunkCount}=${b.chunkCount} actions ${a.actionCount}=${b.actionCount}`)
  }

  // ---- 选样：最小包做 W6，最大 storyScript 包做 W9 ----
  const bySize = [...smallIndexes].sort((a, b) => a.size - b.size)
  const smallest = bySize[0]

  // ---- W6：未知字段保留（最小包） ----
  {
    const root = join(SCRATCH, 'w6', smallest.key)
    await ws.unpack(smallest.pkg, root)
    const idx = await ws.readIndex(root)
    idx.manifest.topLevelKeys.push('__w6_unknown_top__')
    idx.manifest.extra['__w6_unknown_top__'] = { probe: 'top', nested: [1, 2, 3] }
    const injFile = 'records/results/__w6_unknown_task__.json'
    const injKey = `${idx.origin.pkgId}:${idx.origin.revisionId}:__w6_unknown_task__:0`
    const injVal = { data: { probe: 'results', deep: { x: true } }, responsePath: 'p' }
    const sha = await ws.writeShard(root, injFile, {
      shard: 'records/results/__w6_unknown_task__',
      container: 'results',
      entries: [{ seq: 2 ** 31, key: injKey, value: injVal }]
    })
    idx.shards.push({ name: 'records/results/__w6_unknown_task__', file: injFile, container: 'results', entryCount: 1, sha256: sha })
    await ws.writeIndex(root, idx)
    const outPath = join(SCRATCH, 'w6', 'out.t2w')
    await ws.pack(root, outPath)
    const m = core.decodeHeader(await readFile(outPath)).manifest
    const found = toKeyed(m.records.results).find((r) => r.key === injKey)
    const ok = jeq(m.__w6_unknown_top__, { probe: 'top', nested: [1, 2, 3] }) && found !== undefined && jeq(found.value, injVal)
    record('W6', smallest.basename, ok, ok ? '未知顶层键+未知 results 条目均在' : '注入字段丢失')
  }

  // ---- W7 + W9：编辑定点等价 + 单分片编辑耗时（选带 storyScript 的样本） ----
  for (const { pkg, basename: name, key, root } of smallIndexes) {
    const idx = await ws.readIndex(root)
    const ssRow = idx.shards.find((s) => s.file.startsWith('script/story-script.') && s.file.endsWith('.json'))
    if (!ssRow) continue

    // 全部 shard/asset 的前值
    const beforeShardSha = new Map()
    for (const s of idx.shards) beforeShardSha.set(s.file, sha256(await readFile(join(root, s.file))))
    const beforeAssetSha = new Map()
    for (const a of idx.assets) beforeAssetSha.set(a.store, sha256(await readFile(join(root, a.store))))
    const srcManifest = core.decodeHeader(await readFile(pkg)).manifest

    // 冷缓存单列：仅读写命中分片（W9 计时）
    // ⚠️【M0-T5/A3.4】该计时**只是 `readShard + writeShard` 的文件 I/O**，**非端到端**；
    //    真正的「单句编辑端到端 < 5s」在 **M1-T4** 验证（含装配/复检/备份全链）。
    const t0 = performance.now()
    const env = await ws.readShard(root, ssRow.file)
    const entry = env.entries.find((e) => actionsOf(e.value)?.length)
    const actions = actionsOf(entry.value)
    const origText = actions[0].text
    actions[0].text = origText + '（M0测）'
    const newSha = await ws.writeShard(root, ssRow.file, env)
    const editMs = performance.now() - t0
    record('W9', name, editMs < 5000, `单分片读写 ${editMs.toFixed(0)}ms (<5000ms)；⚠️非端到端（端到端见 M1-T4）`)

    // 更新索引里该分片 sha
    ssRow.sha256 = newSha
    await ws.writeIndex(root, idx)

    // 其余分片 sha256 不变
    let othersUnchanged = true
    for (const s of idx.shards) {
      if (s.file === ssRow.file) continue
      if (sha256(await readFile(join(root, s.file))) !== beforeShardSha.get(s.file)) othersUnchanged = false
    }
    // 二进制资产逐字节不变
    let assetsUnchanged = true
    for (const a of idx.assets) {
      if (sha256(await readFile(join(root, a.store))) !== beforeAssetSha.get(a.store)) assetsUnchanged = false
    }
    // 导出（已编辑 → G2），校验 files[] 全等 + 编辑生效 + 二进制不变
    const outPath = join(SCRATCH, 'w7', key)
    const packRes = await ws.pack(root, outPath)
    const outBuf = await readFile(outPath)
    const out = core.decodeHeader(outBuf).manifest
    const filesSame =
      out.files.length === srcManifest.files.length &&
      out.files.every((f, i) => f.path === srcManifest.files[i].path && f.size === srcManifest.files[i].size && f.sha256 === srcManifest.files[i].sha256)
    const editedHit = toKeyed(out.records.results)
      .map((r) => actionsOf(r.value))
      .some((acts) => Array.isArray(acts) && acts.some((act) => act.text === origText + '（M0测）'))
    const w7 = othersUnchanged && assetsUnchanged && filesSame && editedHit && packRes.byteExact === false
    record('W7', name, w7, `其余分片不变=${othersUnchanged} 资产不变=${assetsUnchanged} files全等=${filesSame} 编辑生效=${editedHit} byteExact=${packRes.byteExact}`)
  }

  // ---- W8：自检（删一个分片 + 改一个资产） ----
  {
    const root = join(SCRATCH, 'w8', smallest.key)
    await ws.unpack(smallest.pkg, root)
    const idx = await ws.readIndex(root)
    const clean = await ws.verifyWorkspace(root, idx)
    // 人为删一个分片
    const victim = idx.shards.find((s) => s.container === 'results')
    await rm(join(root, victim.file))
    // 人为改一个资产
    const victimAsset = idx.assets[0]
    const bytes = await readFile(join(root, victimAsset.store))
    const tampered = Buffer.from(bytes)
    tampered[0] = (tampered[0] + 1) & 0xff
    await writeFile(join(root, victimAsset.store), tampered)
    const issues = await ws.verifyWorkspace(root, idx)
    const ok =
      clean.length === 0 &&
      issues.some((s) => s.includes('缺失') && s.includes(victim.file)) &&
      issues.some((s) => s.includes(victimAsset.path))
    record('W8', smallest.basename, ok, `干净=${clean.length}项 损坏后=${issues.length}项（含分片缺失+资产不符）`)
  }

  // ---- W10 + W11：叶真源守恒 + 投影可删可重建（覆盖多 chunk + PLM） ----
  for (const { pkg, basename: name, key } of smallIndexes) {
    const shape = shapes.get(name)
    if (!shape.hasPlotLocationMerge && !shape.multiChunk) continue
    const root = join(SCRATCH, 'w10', key)
    await ws.unpack(pkg, root)
    const idx = await ws.readIndex(root)
    const leafRows = idx.shards.filter((s) => ws.isLeafTruthFile(s.file))
    const leafBefore = new Map()
    // 【M0-T5/A3.3】同时记录叶真源**非空**（空文件也能"sha 不变"，故须显式断言非空）
    const leafEmpty = []
    for (const s of leafRows) {
      const b = await readFile(join(root, s.file))
      leafBefore.set(s.file, sha256(b))
      if (b.length === 0) leafEmpty.push(s.file)
    }

    // 首次 reproject（生成投影）
    const r1 = await ws.reproject(root, idx)
    let w10 = leafRows.length > 0 && leafEmpty.length === 0
    for (const s of leafRows) {
      if (sha256(await readFile(join(root, s.file))) !== leafBefore.get(s.file)) w10 = false
    }
    if (r1.touched.some((f) => ws.isLeafTruthFile(f)) || r1.removed.some((f) => ws.isLeafTruthFile(f))) w10 = false
    record('W10', name, w10, `叶真源=${leafRows.length}个 未变且非空(空=${leafEmpty.length}); reproject触及叶真源=${r1.touched.some(ws.isLeafTruthFile) || r1.removed.some(ws.isLeafTruthFile)}`)

    // 投影快照
    const snap = new Map()
    for (const f of PROJECTIONS_FILES) {
      const b = await asyncStat(join(root, f))
      if (b) snap.set(f, b.toString('utf8'))
    }
    // 删除全部投影
    for (const f of PROJECTIONS_FILES) await rm(join(root, f), { force: true })
    // 重建
    await ws.reproject(root, idx)
    let w11 = snap.size > 0
    for (const [f, text] of snap) {
      const b = await asyncStat(join(root, f))
      if (!b || b.toString('utf8') !== text) w11 = false
    }
    // 叶真源仍不变
    for (const s of leafRows) {
      if (sha256(await readFile(join(root, s.file))) !== leafBefore.get(s.file)) w11 = false
    }
    record('W11', name, w11, `投影 ${snap.size} 个，删→重建逐文件深等=${w11}`)
  }

  // ---- 输出 ----
  printReport()
}

function printReport() {
  const byW = new Map()
  for (const r of results) {
    if (!byW.has(r.w)) byW.set(r.w, [])
    byW.get(r.w).push(r)
  }
  for (const w of ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'W10', 'W11', 'R2', 'S1']) {
    const rows = byW.get(w) ?? []
    if (!rows.length) {
      console.log(`${w}: ⚠️ 未执行`)
      continue
    }
    const ok = rows.every((r) => r.ok)
    console.log(`${w}: ${ok ? '✅' : '❌'} (${rows.filter((r) => r.ok).length}/${rows.length})`)
    for (const r of rows) {
      console.log(`    ${r.ok ? '·' : '❌'} ${r.pkg}  ${r.detail}`)
    }
  }

  console.log('\n样本形态：')
  for (const [name, s] of shapes) {
    console.log(`  ${name}  multiChunk=${s.multiChunk} chunkSeqs=${JSON.stringify(s.chunkSeqs)} plotLocationMerge=${s.hasPlotLocationMerge} charCount=${s.charCount}`)
  }
  const multiChunkSeen = [...shapes.values()].some((s) => s.multiChunk)
  const plmSeen = [...shapes.values()].some((s) => s.hasPlotLocationMerge)
  console.log(`\n形态覆盖：多chunk=${multiChunkSeen} 有plotLocationMerge=${plmSeen}`)

  const allOk = results.every((r) => r.ok) && multiChunkSeen && plmSeen && results.length > 0
  console.log(`\n==== M0-T3：W1–W11 ${allOk ? 'ALL PASS ✅' : 'HAS FAILURES ❌'} ====`)
  process.exitCode = allOk ? 0 : 1
}

main().catch((e) => {
  console.error('ERROR:', e?.stack ?? e?.message ?? e)
  process.exitCode = 2
})

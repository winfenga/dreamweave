/**
 * QA-M0 · 边界与实现偏差独立实测（D + E + G 项）
 *
 * 覆盖：
 *  E7  未编辑判定的三个反例（改资产 / 绕过写回改分片 / 全未改）
 *  E8  骨架 project / containerKeyed 的用途与"不外泄"
 *  E9  attempts 同 taskId 多副本能否无损共存（覆盖式写盘经典丢数据点）
 *  E10 shard name 仅元数据（乱改 name 仍逐字节相等）
 *  E11 reproject 只写投影层、绝不碰 records/** 与叶真源；W10/W11 独立复现
 *  E12 unpack 返回 WorkspaceIndex；exportT2w 未实现
 *  E6e 极小包 / 0 results 往返
 *  E6f 重复 key / 同 key 多副本（不丢弃/不去重/不重排）
 *  D6a 包被截断（头部区 / blob 区）行为
 *  D6b index 损坏 / 缺字段 → 可读错误
 *  D6c 缺分片 / D6d 改资产 → 自检报出具体项
 *  G15 冷缓存单分片编辑：定点写盘（只命中分片+index 变化）+ 耗时
 *
 * 用法：node scripts/qa-m0-edges.mjs
 */
import { mkdir, readFile, readdir, rm, writeFile, stat, utimes } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const FEATHER = join(here, '..')
const SAMPLE_DIR = 'D:/aaaTemp'
const SCRATCH = join(FEATHER, 'scratch', 'qa-m0-edges')
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

let pass = 0, fail = 0
const results = []
function check(id, name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ [${id}] ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  ❌ [${id}] ${name}${detail ? ' — ' + detail : ''}`) }
  results.push({ id, name, ok: !!cond, detail })
}

/** 构造最小合法 .t2w */
function makeT2w({ project = { id: 'pid', revisionId: 'rev', title: 'T' }, records = {}, files = [], blobs = [], includesSource = false }) {
  const manifest = { format: 'txt2world-package-v1', includesSource, project, records, files }
  return core.encodePackage(manifest, blobs)
}

async function walk(root, rel = '') {
  const out = []
  const dir = join(root, rel)
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await walk(root, r)))
    else out.push(r)
  }
  return out
}

async function pickSamples() {
  const names = (await readdir(SAMPLE_DIR)).filter((n) => n.toLowerCase().endsWith('.t2w')).sort()
  const withSize = []
  for (const n of names) withSize.push({ n, size: (await stat(join(SAMPLE_DIR, n))).size })
  withSize.sort((a, b) => a.size - b.size)
  return { smallest: join(SAMPLE_DIR, withSize[0].n), smallestName: withSize[0].n, names }
}

async function main() {
  await rm(SCRATCH, { recursive: true, force: true })
  await mkdir(SCRATCH, { recursive: true })
  const { smallest, smallestName, names } = await pickSamples()
  console.log(`QA-M0 边界/偏差实测（最小样本：${smallestName}）\n`)

  // 找多 chunk + 有 plotLocationMerge 的包（1 号【主角档案】11 chunk，或 MMT(1)）
  let multiPkg = null, multiName = null
  for (const n of names) {
    const buf = await readFile(join(SAMPLE_DIR, n))
    const m = core.decodeHeader(buf).manifest
    const results_ = m.records?.results
    const keyed = Array.isArray(results_) ? results_.map((r) => r.key) : Object.keys(results_ ?? {})
    const chunks = new Set()
    for (const k of keyed) { const mm = /:storyScript:(\d+)/.exec(String(k)); if (mm) chunks.add(Number(mm[1])) }
    if (chunks.size > 1) { multiPkg = join(SAMPLE_DIR, n); multiName = n; break }
  }

  // =========================================================== E7
  console.log('\n== E7 未编辑判定的反例 ==')
  {
    const root = join(SCRATCH, 'e7', 'base')
    await ws.unpack(smallest, root)
    const idx = await ws.readIndex(root)

    // E7③ 什么都没改
    const outNoop = join(SCRATCH, 'e7', 'noop.t2w')
    const r3 = await ws.pack(root, outNoop)
    check('E7③', '全未改：unedited=true 且 byteExact=true', r3.unedited === true && r3.byteExact === true, `unedited=${r3.unedited} byteExact=${r3.byteExact}`)
    const srcBuf = await readFile(smallest)
    check('E7③', '全未改：导出整包逐字节==源', (await readFile(outNoop)).equals(srcBuf))

    // E7① 只改资产字节，不动 index
    const a0 = idx.assets[0]
    const storeAbs = join(root, a0.store)
    const orig = await readFile(storeAbs)
    const tampered = Buffer.from(orig); tampered[0] = (tampered[0] + 7) & 0xff
    await writeFile(storeAbs, tampered)
    const outA = join(SCRATCH, 'e7', 'asset.t2w')
    const ra = await ws.pack(root, outA)
    const outABuf = await readFile(outA)
    const ohA = core.decodeHeader(outABuf)
    const newSha = sha256(tampered)
    const filesUpdated = ohA.manifest.files[0].sha256 === newSha
    check('E7①', '只改资产：不得声称未编辑（byteExact=false）', ra.byteExact === false && ra.unedited === false, `byteExact=${ra.byteExact} unedited=${ra.unedited}`)
    check('E7①', '只改资产：导出 files[0].sha256 反映新内容（encodePackage 重算）', filesUpdated, `out=${ohA.manifest.files[0].sha256.slice(0,12)} new=${newSha.slice(0,12)}`)
    // 还原
    await writeFile(storeAbs, orig)

    // E7① b：改资产 + 同步更新 index.assets sha（模拟"合法编辑"）
    await writeFile(storeAbs, tampered)
    const idxA = await ws.readIndex(root)
    idxA.assets[0].sha256 = newSha
    await ws.writeIndex(root, idxA)
    const outA2 = join(SCRATCH, 'e7', 'asset2.t2w')
    const ra2 = await ws.pack(root, outA2)
    check('E7①b', '改资产+更新index.sha：仍判已编辑（头部==origin 不成立）', ra2.byteExact === false && ra2.unedited === false, `byteExact=${ra2.byteExact} unedited=${ra2.unedited}`)
    await writeFile(storeAbs, orig)

    // E7② 只改一个 shard，绕过写回路径（手工改盘），不动 index
    const idxB = await ws.readIndex(root)
    const victim = idxB.shards.find((s) => s.container === 'results')
    const vAbs = join(root, victim.file)
    const vEnv = JSON.parse(await readFile(vAbs, 'utf8'))
    vEnv.entries[0].value = { __edited_by_qa__: true, echo: vEnv.entries[0].value }
    await writeFile(vAbs, JSON.stringify(vEnv), 'utf8') // 直接改盘，不动 index
    const outS = join(SCRATCH, 'e7', 'shard.t2w')
    const rs = await ws.pack(root, outS)
    const ohS = core.decodeHeader(await readFile(outS))
    const resultsKeyed = Array.isArray(ohS.manifest.records.results)
      ? ohS.manifest.records.results.map((r) => ({ key: String(r.key), value: r.value }))
      : Object.entries(ohS.manifest.records.results).map(([key, value]) => ({ key, value }))
    const detectedEdit = resultsKeyed.some((r) => r.value && typeof r.value === 'object' && r.value.__edited_by_qa__ === true)
    check('E7②', '只改分片(绕过写回)：仍判已编辑，不得误判未编辑', rs.byteExact === false && rs.unedited === false, `byteExact=${rs.byteExact} unedited=${rs.unedited}`)
    check('E7②', '只改分片：导出内容确实带上了改动（非导出旧内容）', detectedEdit)
  }

  // =========================================================== E8
  console.log('\n== E8 骨架 project / containerKeyed ==')
  {
    const root = join(SCRATCH, 'e8')
    await ws.unpack(smallest, root)
    const idx = await ws.readIndex(root)
    const src = core.decodeHeader(await readFile(smallest)).manifest
    check('E8', '骨架 project 完整保留（== 源 project 深等）', jeq(idx.manifest.project, src.project))
    check('E8', '骨架含 containerKeyed（>=1 键）', idx.manifest.containerKeyed && Object.keys(idx.manifest.containerKeyed).length > 0)
    const out = join(SCRATCH, 'e8.t2w')
    await ws.pack(root, out)
    const om = core.decodeHeader(await readFile(out)).manifest
    check('E8', '导出 manifest 不泄漏骨架字段 containerKeyed', !('containerKeyed' in om))
    check('E8', '导出 project 深等源', jeq(om.project, src.project))
  }

  // =========================================================== E9
  console.log('\n== E9 attempts 同 taskId 多副本共存 ==')
  {
    const records = {
      attempts: [
        { taskId: 'cacheWarming:0', attempt: 1, note: 'a' },
        { taskId: 'cacheWarming:0', attempt: 2, note: 'b' },
        { taskId: 'cacheWarming:0', attempt: 3, note: 'c' },
        { taskId: 'seg:1', attempt: 1, note: 'z' }
      ],
      results: []
    }
    const pkg = makeT2w({ project: { id: 'pid', revisionId: 'rev', title: 'attempts' }, records })
    const pp = join(SCRATCH, 'e9.t2w'); await writeFile(pp, pkg)
    const root = join(SCRATCH, 'e9')
    await ws.unpack(pp, root)
    const idx = await ws.readIndex(root)
    const cw = idx.shards.find((s) => s.file === 'records/attempts/cacheWarming.json')
    const sg = idx.shards.find((s) => s.file === 'records/attempts/seg.json')
    check('E9', '同 taskId 命中同一文件', !!cw, cw ? `entryCount=${cw.entryCount}` : cw)
    check('E9', '同 taskId 3 条全保留（不互相覆盖）', cw?.entryCount === 3)
    check('E9', '不同 taskId → 不同文件', !!sg && sg.file !== cw?.file)
    const out = join(SCRATCH, 'e9.out.t2w'); await ws.pack(root, out)
    check('E9', 'attempts 往返整包逐字节相等', (await readFile(out)).equals(pkg))
    const om = core.decodeHeader(await readFile(out)).manifest
    const back = Array.isArray(om.records.attempts) ? om.records.attempts : Object.values(om.records.attempts)
    check('E9', 'attempts 重建顺序/内容全等（3+1 条）', jeq(back, records.attempts), `got=${back.length}条`)
  }

  // =========================================================== E6e
  console.log('\n== E6e 极小包 / 0 results ==')
  {
    const pkg = makeT2w({ project: { id: 'tiny', revisionId: 'r0', title: 'tiny' }, records: { results: [] } })
    const pp = join(SCRATCH, 'tiny.t2w'); await writeFile(pp, pkg)
    const root = join(SCRATCH, 'tiny')
    await ws.unpack(pp, root)
    const out = join(SCRATCH, 'tiny.out.t2w')
    await ws.pack(root, out)
    check('E6e', '极小包(0 results, 0 files) 往返逐字节相等', (await readFile(out)).equals(pkg))
  }
  {
    // 完全没有 records 键
    const pkg = makeT2w({ project: { id: 'norec', revisionId: 'r0', title: 'norec' }, records: {} })
    const pp = join(SCRATCH, 'norec.t2w'); await writeFile(pp, pkg)
    const root = join(SCRATCH, 'norec')
    await ws.unpack(pp, root)
    const out = join(SCRATCH, 'norec.out.t2w')
    await ws.pack(root, out)
    check('E6e', '无 records 键的包往返逐字节相等', (await readFile(out)).equals(pkg))
  }

  // =========================================================== E6f
  console.log('\n== E6f 重复 key / 同 key 多副本 ==')
  {
    const records = {
      results: [
        { key: 'p:r:plot:0', value: { a: 1 } },
        { key: 'p:r:plot:0', value: { a: 2 } },            // 重复 key
        { key: 'p:r:plot:0:batch:0', value: { a: 3 } },
        { key: 'p:r:storyScript:0', value: { data: { actions: [{ text: 'x' }] } } },
        { key: 'p:r:storyScript:0:batch:0', value: { data: { actions: [{ text: 'x0' }] } } },
        { key: 'p:r:storyScript:0:batch:1', value: { data: { actions: [{ text: 'x1' }] } } },
        { key: 'p:r:storyScript:1', value: { data: { actions: [{ text: 'y' }] } } }
      ]
    }
    const pkg = makeT2w({ project: { id: 'p', revisionId: 'r', title: 'dup' }, records })
    const pp = join(SCRATCH, 'dup.t2w'); await writeFile(pp, pkg)
    const root = join(SCRATCH, 'dup')
    await ws.unpack(pp, root)
    const idx = await ws.readIndex(root)
    const ss0 = idx.shards.find((s) => s.file === 'script/story-script.0.json')
    const ss1 = idx.shards.find((s) => s.file === 'script/story-script.1.json')
    const plot = idx.shards.find((s) => s.file === 'records/results/plot.json')
    check('E6f', 'storyScript:0 + 2 个 :batch: 同文件(3 条)', ss0?.entryCount === 3, `ss0=${ss0?.entryCount}`)
    check('E6f', 'storyScript:1 独立文件', ss1?.entryCount === 1)
    check('E6f', '重复 key(plot:0 ×2) 不去重(plot 文件 3 条含 batch)', plot?.entryCount === 3, `plot=${plot?.entryCount}`)
    const out = join(SCRATCH, 'dup.out.t2w'); await ws.pack(root, out)
    check('E6f', '含重复 key/多副本 往返逐字节相等', (await readFile(out)).equals(pkg))
    const om = core.decodeHeader(await readFile(out)).manifest
    check('E6f', '重建顺序与源完全一致（零重排/零去重）', jeq(om.records.results, records.results))
  }

  // =========================================================== D6a 截断
  console.log('\n== D6a 包被截断 ==')
  {
    const full = await readFile(smallest)
    // 头部区截断
    const cutHeader = full.subarray(0, 10)
    const pp = join(SCRATCH, 'cut-header.t2w'); await writeFile(pp, cutHeader)
    const root = join(SCRATCH, 'cut-header')
    let threw = null
    try { await ws.unpack(pp, root) } catch (e) { threw = e }
    let rootExists = true
    try { await stat(root); rootExists = true } catch { rootExists = false }
    check('D6a', '头部区截断(<12B) → 抛可读错误', !!threw, threw ? threw.message : 'NO THROW')
    check('D6a', '头部区截断 → 不产生半成品工作库', !rootExists)

    // JSON 区截断（jsonLen 声明 > 实际）
    const cutJson = full.subarray(0, 200)
    const pj = join(SCRATCH, 'cut-json.t2w'); await writeFile(pj, cutJson)
    const rootJ = join(SCRATCH, 'cut-json')
    let threwJ = null
    try { await ws.unpack(pj, rootJ) } catch (e) { threwJ = e }
    check('D6a', 'JSON 区截断(清单越界) → 抛可读错误', !!threwJ, threwJ ? threwJ.message : 'NO THROW')

    // blob 区截断（尾部截掉 4096B）—— 观察行为
    const cutBlob = full.subarray(0, full.length - 4096)
    const pb = join(SCRATCH, 'cut-blob.t2w'); await writeFile(pb, cutBlob)
    const rootB = join(SCRATCH, 'cut-blob')
    let threwB = null, unpacked = false
    try { await ws.unpack(pb, rootB); unpacked = true } catch (e) { threwB = e }
    let issues = null
    if (unpacked) {
      try { issues = await ws.verifyWorkspace(rootB, await ws.readIndex(rootB)) } catch (e) { issues = ['THREW: ' + e.message] }
    }
    const detected = Array.isArray(issues) && issues.some((s) => s.includes('资产'))
    check('D6a', 'blob 区截断：unpack 是否抛可读错误（期望抛）', !!threwB, threwB ? threwB.message : (unpacked ? 'NO THROW（产生了工作库）' : 'NO THROW'))
    check('D6a', 'blob 区截断：即便不抛，自检能报出资产不符（可检出）', detected, detected ? `${issues.length}项` : JSON.stringify(issues))
  }

  // =========================================================== D6b index 损坏
  console.log('\n== D6b index.json 损坏 / 缺字段 ==')
  {
    const root = join(SCRATCH, 'd6b')
    await ws.unpack(smallest, root)
    const good = await readFile(join(root, 'index.json'), 'utf8')
    await writeFile(join(root, 'index.json'), '{not json', 'utf8')
    let e1 = null; try { await ws.readIndex(root) } catch (e) { e1 = e }
    check('D6b', '损坏 JSON → 抛可读错', !!e1, e1?.message)
    await writeFile(join(root, 'index.json'), JSON.stringify({ indexVersion: 1, format: 'txt2world-workspace' }), 'utf8')
    let e2 = null; try { await ws.readIndex(root) } catch (e) { e2 = e }
    check('D6b', '缺字段 → 抛可读错', !!e2, e2?.message)
    await writeFile(join(root, 'index.json'), good, 'utf8')
  }

  // =========================================================== D6c/D6d 自检
  console.log('\n== D6c/D6d 自检报出具体缺失/不符项 ==')
  {
    const root = join(SCRATCH, 'd6cd')
    await ws.unpack(smallest, root)
    const idx = await ws.readIndex(root)
    const clean = await ws.verifyWorkspace(root, idx)
    check('D6c/d', '干净工作库自检 = 0 项', clean.length === 0)
    const victim = idx.shards.find((s) => s.container === 'results') ?? idx.shards[0]
    await rm(join(root, victim.file), { force: true })
    const va = idx.assets[0]
    const b = await readFile(join(root, va.store))
    const t = Buffer.from(b); t[3] = (t[3] + 1) & 0xff
    await writeFile(join(root, va.store), t)
    const issues = await ws.verifyWorkspace(root, idx)
    check('D6c', '报出具体缺失分片文件', issues.some((s) => s.includes('缺失') && s.includes(victim.file)), victim.file)
    check('D6d', '报出具体不符资产', issues.some((s) => s.includes(va.path)), va.path)
  }

  // =========================================================== E10 shard name
  console.log('\n== E10 shard name 仅元数据 ==')
  {
    const root = join(SCRATCH, 'e10')
    await ws.unpack(smallest, root)
    const idx = await ws.readIndex(root)
    for (const s of idx.shards) s.name = 'GARBAGE/' + Math.random().toString(36).slice(2)
    await ws.writeIndex(root, idx)
    const out = join(SCRATCH, 'e10.t2w')
    const r = await ws.pack(root, out)
    check('E10', '乱改 shard.name 后仍逐字节相等（name 不参与重建/路由）', (await readFile(out)).equals(await readFile(smallest)), `byteExact=${r.byteExact}`)
  }

  // =========================================================== E11 reproject
  console.log('\n== E11 reproject 只写投影层 + W10/W11 独立复现 ==')
  if (multiPkg) {
    const root = join(SCRATCH, 'e11', 'multi')
    await ws.unpack(multiPkg, root)
    const idx = await ws.readIndex(root)
    const projections = [
      'entities/canonical.json', 'entities/appearances.json', 'entities/relations.json',
      'world/location-tree.json', 'world/plot-location-merge.json', 'world/impression-layout.json',
      'script/line-annotation.json', 'script/effect-annotation.json', 'script/performance-review.json',
      'events/event-tree.json'
    ]
    const projSet = new Set(projections)
    const before = new Map()
    for (const f of await walk(root)) before.set(f, sha256(await readFile(join(root, f))))

    await ws.reproject(root, idx)

    let recordsTouched = [], assetsTouched = [], metaTouched = [], leafTouched = [], otherTouched = []
    for (const f of await walk(root)) {
      const after = sha256(await readFile(join(root, f)))
      const was = before.get(f)
      if (was === undefined) {
        if (!projSet.has(f)) otherTouched.push('新增:' + f)
        continue
      }
      if (was === after) continue
      if (f.startsWith('records/')) recordsTouched.push(f)
      else if (f.startsWith('assets/')) assetsTouched.push(f)
      else if (f.startsWith('meta/')) metaTouched.push(f)
      else if (f === 'world/plot-locations.json' || (f.startsWith('script/story-script.') && f.endsWith('.json'))) leafTouched.push(f)
      else if (!projSet.has(f)) otherTouched.push('改:' + f)
    }
    check('E11', 'reproject 不触碰 records/**', recordsTouched.length === 0, recordsTouched.join(','))
    check('E11', 'reproject 不触碰 assets/**', assetsTouched.length === 0, assetsTouched.join(','))
    check('E11', 'reproject 不触碰 meta/**', metaTouched.length === 0, metaTouched.join(','))
    check('E11', 'reproject 不触碰叶真源(story-script.*/plot-locations)', leafTouched.length === 0, leafTouched.join(','))
    check('E11', 'reproject 只新增/改投影层文件', otherTouched.length === 0, otherTouched.join(','))

    // W10: 叶真源 sha 前后不变
    const leafRows = idx.shards.filter((s) => ws.isLeafTruthFile(s.file))
    let w10 = true
    for (const s of leafRows) if (sha256(await readFile(join(root, s.file))) !== before.get(s.file)) w10 = false
    check('W10', 'reproject 前后叶真源 sha256 不变（独立复现）', w10, `叶真源 ${leafRows.length} 个`)

    // W11: 快照→删投影→reproject→逐文件深等
    const snap = new Map()
    for (const f of projections) { try { snap.set(f, await readFile(join(root, f))) } catch { /* 无 */ } }
    for (const f of projections) await rm(join(root, f), { force: true })
    // 删除后工作库仍自检干净
    const issuesAfterDel = await ws.verifyWorkspace(root, idx)
    await ws.reproject(root, idx)
    let w11 = snap.size > 0
    for (const [f, b] of snap) {
      try { if (!(await readFile(join(root, f))).equals(b)) w11 = false } catch { w11 = false }
    }
    check('W11', '删全部投影→reproject→逐文件深等（独立复现）', w11, `投影 ${snap.size} 个`)
    check('W11', '删投影不影响 records 自检（投影不入 index.shards）', issuesAfterDel.length === 0, issuesAfterDel.slice(0, 3).join('; '))
  } else {
    check('E11', '找到多 chunk 样本', false, '无多 chunk 样本可用于 reproject 测试')
  }

  // =========================================================== E12
  console.log('\n== E12 unpack 返回 / exportT2w ==')
  {
    check('E12', 'pack(root,outPath) 存在', typeof ws.pack === 'function')
    check('E12', 'exportT2w 未实现（M0 只需 pack）', typeof ws.exportT2w === 'undefined')
    const root = join(SCRATCH, 'e12')
    const res = await ws.unpack(smallest, root)
    check('E12', 'unpack 返回 WorkspaceIndex', !!(res && res.index && res.index.indexVersion === 1 && Array.isArray(res.index.shards)))
  }

  // =========================================================== G15 定点写盘
  console.log('\n== G15 冷缓存单分片编辑：定点写盘 + 耗时 ==')
  {
    const root = join(SCRATCH, 'g15')
    await ws.unpack(smallest, root)
    const idx = await ws.readIndex(root)
    const target = idx.shards.find((s) => s.container === 'results') ?? idx.shards[0]
    const before = new Map()
    for (const f of await walk(root)) before.set(f, await stat(join(root, f)).then((s) => s.mtimeMs))
    // 冷缓存：仅读命中分片、改一个值、写回
    const t0 = performance.now()
    const env = await ws.readShard(root, target.file)
    env.entries[0] = { ...env.entries[0], value: { __qa_edit__: 1 } }
    const newSha = await ws.writeShard(root, target.file, env)
    target.sha256 = newSha
    await ws.writeIndex(root, idx)
    const ms = performance.now() - t0
    const changed = []
    for (const f of await walk(root)) {
      const after = await stat(join(root, f)).then((s) => s.mtimeMs)
      if (before.get(f) !== after) changed.push(f)
    }
    const allowed = new Set([target.file, 'index.json'])
    const unexpected = changed.filter((f) => !allowed.has(f))
    check('G15', '编辑耗时 < 5000ms（W9 口径）', ms < 5000, `${ms.toFixed(1)}ms`)
    check('G15', '定点写盘：仅命中分片 + index.json 变化', unexpected.length === 0, `变化文件: ${changed.join(', ')}`)
    // 缓存友好观察（补充：命中分片 size 变化，其余分片/资产按 mtime 未动）
    const otherShardsUntouched = idx.shards.filter((s) => s.file !== target.file)
      .every((s) => before.get(s.file) === undefined || changed.indexOf(s.file) === -1)
    check('G15', '其余分片均未被重写', otherShardsUntouched)
  }

  await writeFile(join(SCRATCH, 'result.json'), JSON.stringify(results, null, 2), 'utf8')
  console.log(`\n==== QA-M0 边界/偏差：${pass} 通过 / ${fail} 失败 ====`)
  process.exitCode = fail === 0 ? 0 : 1
}
main().catch((e) => { console.error('ERROR:', e?.stack ?? e); process.exitCode = 2 })

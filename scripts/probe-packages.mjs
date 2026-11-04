/**
 * 跨包核对：character-images / characterAppearance / canonical.importanceLevel / dubbing 的存在性与形态
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const { decodeHeader } = await import(pathToFileURL(join(here, '../src/main/t2w/core.mjs')).href)

const targets = process.argv.slice(2)
if (!targets.length) process.exit(2)

const toEntries = (node) => {
  if (Array.isArray(node)) return node.map((v, i) => [String(v?.key ?? i), v])
  if (node && typeof node === 'object') return Object.entries(node)
  return []
}

for (const t of targets) {
  let buf
  try {
    buf = await readFile(t)
  } catch (e) {
    console.log('SKIP', t, e.message)
    continue
  }
  let manifest
  try {
    manifest = decodeHeader(buf).manifest
  } catch (e) {
    console.log('BAD', t, e.message)
    continue
  }
  const name = t.split(/[\\/]/).pop()
  const reader = toEntries(manifest.records?.reader ?? {})
  const results = toEntries(manifest.records?.results ?? {})
  const files = manifest.files ?? []

  console.log('\n===== ' + name + ' =====')
  console.log('files:', files.length, 'reader:', reader.length, 'results:', results.length)

  // character-images
  const ci = reader.find(([k]) => k.includes(':character-images'))
  if (ci) {
    const v = ci[1]?.value
    const val = v?.data ?? v
    const keys = Object.keys(val ?? {})
    const sample = val?.[keys[0]]
    console.log('character-images: keys=' + keys.length, 'firstValIsArray=' + Array.isArray(sample),
      'entryFields=' + (Array.isArray(sample) ? JSON.stringify([...new Set(sample.flatMap((e) => Object.keys(e)))]) : typeof sample))
    console.log('  keys sample:', keys.slice(0, 8))
  } else console.log('character-images: ABSENT')

  // scene-images
  const si = reader.find(([k]) => k.includes(':scene-images'))
  if (si) {
    const v = si[1]?.value
    const val = v?.data ?? v
    console.log('scene-images: topKeys=' + JSON.stringify(Object.keys(val ?? {})),
      'individual=' + Object.keys(val?.individual ?? {}).length,
      'shared=' + Object.keys(val?.shared ?? {}).length)
  } else console.log('scene-images: ABSENT')

  // characterAppearance
  const ca = results.filter(([k]) => k.includes(':characterAppearance'))
  if (ca.length) {
    const v = ca[0][1]?.value
    const val = v?.data ?? v
    const keys = Object.keys(val ?? {})
    const sample = val?.[keys[0]]
    console.log('characterAppearance: entries=' + ca.length, 'keys=' + keys.length,
      'valIsArray=' + Array.isArray(sample),
      'fields=' + (Array.isArray(sample) ? JSON.stringify([...new Set(sample.flatMap((e) => Object.keys(e)))]) : typeof sample))
  } else console.log('characterAppearance: ABSENT')

  // canonical
  const canon = results.find(([k]) => k.includes(':canonical'))
  if (canon) {
    const v = canon[1]?.value
    const val = v?.data ?? v
    const chars = val?.objects?.characters ?? []
    const lv = {}
    for (const c of chars) lv[c.importanceLevel ?? '<none>'] = (lv[c.importanceLevel ?? '<none>'] ?? 0) + 1
    console.log('canonical chars:', chars.length, 'importanceLevel dist:', JSON.stringify(lv))
    console.log('  hasAliases:', chars.filter((c) => Array.isArray(c.aliases)).length,
      'hasCharacterAppearances:', chars.filter((c) => Array.isArray(c.characterAppearances)).length)
    if (chars.length) console.log('  char[0] appearances:', JSON.stringify(chars[0].characterAppearances?.[0] ?? null).slice(0, 300))
  }

  // dubbing
  const dub = reader.filter(([k]) => k.includes(':dubbing:'))
  const clips = dub.filter(([k]) => k.includes(':dubbing:clip:'))
  const voices = dub.filter(([k]) => k.includes(':dubbing:voice:'))
  const audioFiles = files.filter((f) => /\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(f.path))
  if (dub.length) {
    const vals = clips.map(([, v]) => v?.value?.data ?? v?.value)
    const byType = {}
    for (const v of vals) byType[v?.actionType ?? '?'] = (byType[v?.actionType ?? '?'] ?? 0) + 1
    const byCh = {}
    for (const v of vals) byCh[v?.chapterSeq ?? '?'] = (byCh[v?.chapterSeq ?? '?'] ?? 0) + 1
    console.log('dubbing: total=' + dub.length, 'clips=' + clips.length, 'voices=' + voices.length,
      'audioMembers=' + audioFiles.length)
    console.log('  clip byType:', JSON.stringify(byType), 'byCh:', JSON.stringify(byCh))
    console.log('  clip fields:', vals[0] ? JSON.stringify(Object.keys(vals[0])) : '-')
    const withPath = vals.filter((v) => typeof v?.path === 'string').length
    console.log('  clips with .path:', withPath)
    if (voices.length) {
      const vv = voices[0][1]?.value?.data ?? voices[0][1]?.value
      console.log('  voice[0]:', JSON.stringify(vv).slice(0, 400))
    }
  } else console.log('dubbing: ABSENT')
}

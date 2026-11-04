/** 地点类型 → 颜色（地图视图与印象图谱共用，避免两处各写一份） */

export const LOCATION_TYPE_COLOR: Record<string, string> = {
  世界: '#7c5cff',
  国家: '#4f8cff',
  首都: '#3d9be9',
  城市: '#3d9be9',
  港口城市: '#2f9e8f',
  海湾: '#2f9e8f',
  港口: '#38a3a5',
  商船: '#c48b3f',
  住宅: '#8a7fd6',
  渔村: '#5fb37a',
  镇: '#5fb37a',
  草原: '#79b356',
  森林: '#4f9e6a',
  酒家: '#c98a4b',
  宅邸: '#a86fd6',
  司法建筑: '#6f8fd6',
  监狱: '#8d8f96',
  要塞监狱: '#7d8b99',
  牢房: '#6d7b89',
  地牢: '#5d6b79',
  宫殿: '#d6a94f',
  书房: '#b08fd6',
  岛屿: '#4fae8f'
}

/**
 * 上表已占用的色值（小写）。兜底色生成时要避开它们，否则「未知类型」会伪装成既有类型。
 * 只读取、不修改 LOCATION_TYPE_COLOR —— 那 25 项映射是设计资产。
 */
const KNOWN_HEX: ReadonlySet<string> = new Set(
  Object.values(LOCATION_TYPE_COLOR).map((c) => c.toLowerCase())
)

/** 兜底色的固定饱和度/明度：深色 UI 上必须可读，且色相之间的可分辨度由色相单独承担 */
const FALLBACK_S = 58
const FALLBACK_L = 62
/** 撞色时的色相步进（与 360 互质，保证 12 次重试覆盖 12 个不同色相） */
const HUE_STEP = 29
const HUE_TRIES = 12

/** FNV-1a 32 位：同字符串恒得同值（跨会话/跨机器稳定，不依赖随机或渲染顺序） */
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** HSL → `#rrggbb`（与 LOCATION_TYPE_COLOR 同形态，可直接进 style） */
function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100
  const ln = l / 100
  const c = (1 - Math.abs(2 * ln - 1)) * sn
  const hp = ((((h % 360) + 360) % 360) / 60) % 6
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (hp < 1) {
    r = c
    g = x
  } else if (hp < 2) {
    r = x
    g = c
  } else if (hp < 3) {
    g = c
    b = x
  } else if (hp < 4) {
    g = x
    b = c
  } else if (hp < 5) {
    r = x
    b = c
  } else {
    r = c
    b = x
  }
  const m = ln - c / 2
  const two = (v: number): string =>
    Math.round(Math.min(1, Math.max(0, v + m)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${two(r)}${two(g)}${two(b)}`
}

/**
 * 未命中 LOCATION_TYPE_COLOR 的类型的**稳定兜底色**。
 *
 * 公式：`hue = FNV1a(type) % 360`，`hslToHex(hue, 58%, 62%)`；若结果与既有 25 色中的
 * 任一色值相同，则 `hue += 29` 重试（最多 12 次），保证不会和已知类型撞色。
 * 同类型 → 同色相 → 每次渲染一致（不依赖节点顺序、不引入随机）。
 */
export function fallbackLocationColor(type: string): string {
  const base = fnv1a(type) % 360
  let hex = hslToHex(base, FALLBACK_S, FALLBACK_L)
  for (let i = 1; i < HUE_TRIES && KNOWN_HEX.has(hex); i++) {
    hex = hslToHex((base + i * HUE_STEP) % 360, FALLBACK_S, FALLBACK_L)
  }
  return hex
}

export function locationColor(type: string): string {
  return LOCATION_TYPE_COLOR[type] ?? fallbackLocationColor(type)
}

/** 图例条目：类型 + 该类型在树里出现的次数 + 颜色 */
export interface LocationLegendEntry {
  type: string
  count: number
  color: string
}

/**
 * 按**树里实际出现的** locationType 生成图例（不再硬编码 11 类）。
 *
 * 排序：出现次数降序 → 类型名升序（`localeCompare(…, 'zh')`），
 * 于是「世界/国家/城市」这类高频类型永远在前面，同频次时中文按拼音稳定排列。
 * 空字符串类型（脏数据）直接丢弃，不占图例格位。
 * 不截断条数：真实书最多 151 种类型，容器 `max-height + overflow:auto` 兜底（见 MapView）。
 */
export function buildLocationLegend(
  nodes: readonly { locationType: string }[]
): LocationLegendEntry[] {
  const counts = new Map<string, number>()
  for (const n of nodes) {
    const t = (n.locationType ?? '').trim()
    if (!t) continue
    counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count, color: locationColor(type) }))
    .sort((a, b) => (b.count - a.count) || a.type.localeCompare(b.type, 'zh'))
}

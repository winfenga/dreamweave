/**
 * Sprite Sheet 布局（§5 `location_type_sprite_sheet` + `character_map_sprite_sheet`）。
 *
 * 解决的问题：地图上要显示「地点类型图标」与「Q 版人物小图」。
 * 逐个生成太慢也太贵——一张图里排 N 格，一次出全部。
 *
 * 模板明确规格（必须严格遵守，否则切格会错位）：
 *   - 严格 `columns × rows` 网格，**填满全部格子**
 *   - 每格等大正方形，建议 512×512
 *   - 无外边距、无沟槽、无网格线
 *   - 每个元素在自己格子内居中，四周约 12% 安全留白，**不跨格**
 *   - 透明背景 PNG
 *   - 不增加空行/空格/占位符
 *
 * 本模块只做**布局计算**（行列数、整图尺寸、每格裁切矩形），
 * 不调 LLM、不生图——那是 `imagegen` 的事。
 */

/** 单个格子的位置（像素，左上角原点，右/下开区间） */
export interface SpriteCell {
  /** 格序号（0 基，行优先：左上 → 右下） */
  index: number
  /** 该格对应的类型名 / 人物名（供提示词「逐格顺序」用） */
  label: string
  x: number
  y: number
  width: number
  height: number
}

/** 布局规格 */
export interface SpriteSheetLayout {
  columns: number
  rows: number
  /** 每格边长（像素，正方形） */
  cellSize: number
  /** 整图宽高（= columns*cellSize × rows*cellSize） */
  width: number
  height: number
  /** 全部格子（行优先顺序，长度 = columns*rows） */
  cells: SpriteCell[]
  /** 实际填入的格数（= items.length） */
  filled: number
  /** 空格数（模板要求填满，>0 时应提示） */
  empty: number
}

/** 建议的每格边长（模板推荐 512） */
export const DEFAULT_CELL_SIZE = 512

/**
 * 计算最紧凑的网格：尽量接近正方形，列数 ≥ 行数（宽略大于高，符合屏幕）。
 *
 * @param itemCount 项目数（地点类型数 / 人物数）
 * @param cellSize 每格边长
 * @param maxColumns 列数上限（太宽会让单格变小、细节丢失）
 */
export function planSpriteSheet(
  itemCount: number,
  items: string[],
  cellSize = DEFAULT_CELL_SIZE,
  maxColumns = 6
): SpriteSheetLayout {
  const n = Math.max(0, itemCount)
  if (n === 0) {
    return {
      columns: 0,
      rows: 0,
      cellSize,
      width: 0,
      height: 0,
      cells: [],
      filled: 0,
      empty: 0
    }
  }
  // 列数取 ceil(sqrt(n))，并夹在 [1, maxColumns]
  const columns = Math.min(maxColumns, Math.max(1, Math.ceil(Math.sqrt(n))))
  const rows = Math.ceil(n / columns)
  const width = columns * cellSize
  const height = rows * cellSize

  const cells: SpriteCell[] = []
  for (let i = 0; i < columns * rows; i++) {
    const col = i % columns
    const row = Math.floor(i / columns)
    cells.push({
      index: i,
      label: items[i] ?? '',
      x: col * cellSize,
      y: row * cellSize,
      width: cellSize,
      height: cellSize
    })
  }

  return {
    columns,
    rows,
    cellSize,
    width,
    height,
    cells,
    filled: n,
    empty: columns * rows - n
  }
}

/**
 * 生成模板 `{{types}}` 变量（「逐格顺序」段落）。
 *
 * 格式：`第 N 格（第 r 行第 c 列）：<label>`。
 * 为什么要写行列：模板要求「每格对应下方一种类型」，模型需要明确的顺序锚点，
 * 只说「1. A 2. B」它可能排成竖排或错位。
 */
export function formatSpriteTypes(layout: SpriteSheetLayout): string {
  const lines: string[] = []
  for (const c of layout.cells) {
    if (!c.label) continue
    const col = (c.index % layout.columns) + 1
    const row = Math.floor(c.index / layout.columns) + 1
    lines.push(`第 ${c.index + 1} 格（第 ${row} 行第 ${col} 列）：${c.label}`)
  }
  return lines.join('\n')
}

/**
 * 从整图里裁出某一格（纯计算，返回矩形；实际裁切由调用方做）。
 *
 * 用途：生成完 sprite sheet 后，要把它拆回单张图标供地图/列表使用。
 * 注意模板要求「四周约 12% 安全留白」，所以裁切时**不要**再额外内缩，
 * 直接按格子边界裁即可（留白已经在格内了）。
 */
export function cellRect(layout: SpriteSheetLayout, index: number): SpriteCell | null {
  return layout.cells[index] ?? null
}

/**
 * 安全留白比例（模板要求每格四周约 12%）。
 * 用于给生图提示词强调，以及校验裁切结果时判断主体是否越界。
 */
export const SAFE_PADDING_RATIO = 0.12

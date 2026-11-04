/**
 * 工作库类型门面（主进程侧）。
 *
 * 权威类型定义在 `src/shared/workspace-types.ts`（设计 §2.2：新增 shared/workspace-types.ts 更干净），
 * 本文件按设计 §2.1 保留为 `workspace/types.ts`，统一再导出并补充主进程内部类型。
 */
import type { WorkspaceIndex } from '../../shared/workspace-types'

export * from '../../shared/workspace-types'

/** `.t2w` → 工作库 的解包结果 */
export interface UnpackResult {
  index: WorkspaceIndex
  /** 来源包字节数（= origin.t2wSize） */
  sourceBytes: number
}

/**
 * 工作库 → `.t2w` 的**底层**打包结果（`pack()` 返回）。
 *
 * 命名带 Detail 是为了与 `packWorkspace()` 的 IPC 门面结果 `PackResult`（在 `pack.ts` 内定义，
 * 形状为 `{ok, path, bytes, error}`）区分 —— 两者都经 `workspace/index.ts` 桶导出，不能同名。
 */
export interface PackDetailResult {
  outPath: string
  bytes: number
  sha256: string
  /** 导出字节是否与来源包逐字节相等（= sha256 == origin.t2wSha256） */
  byteExact: boolean
  /** 导出时是否判定为「未编辑」（分片/资产 sha256 全部与 index 记录一致） */
  unedited: boolean
  /** 未编辑档是否走了 origin-header 拼接路径（G1） */
  usedOriginHeader: boolean
}

/** 重建投影的结果 */
export interface ReprojectResult {
  /** 本次重新生成的投影文件（相对路径） */
  touched: string[]
  /** 本次删除的既有投影文件（相对路径） */
  removed: string[]
}

/**
 * 工作库（txt2world-workspace）读写层 —— 共享只读类型（主进程与 renderer 可共用）。
 *
 * 设计依据：`docs/增量设计_存储重构与解析链路.md` §3.1（index schema）、§3.2（分片信封）、§3.3（TS 类型）。
 * 本文件为纯类型（无运行期导入），可被 node 端与 web 端同时引用。
 */
import type { T2wManifest } from './t2w-types'

/** 容器在源中的形态：数组 / 对象映射 */
export type ContainerKind = 'array' | 'object'

/** 无损条目：`seq` = 容器内全局序号（数组下标 / 对象 Object.keys 序），导出排序唯一依据 */
export interface KeyedEntry<T = unknown> {
  seq: number
  /** 条目 key：**保真原类型**（数字 key 不得被强制转字符串，M0-T5/A2） */
  key: string | number
  value: T
}

/** 统一分片信封（records/*、results/*、reader、attempts 同构） */
export interface ShardEnvelope<T = unknown> {
  /** 路由名（= <file> 去掉扩展名） */
  shard: string
  /** 来源容器（chapters/chunks/tasks/results/attempts/reader…） */
  container: string
  entries: KeyedEntry<T>[]
}

export type AssetKind = 'image' | 'audio' | 'source' | 'other'

/** 资产表一行；数组顺序 == files[] 顺序（导出保序依据） */
export interface AssetRow {
  /** 包内逻辑路径（原 files[].path 原样） */
  path: string
  size: number
  sha256: string
  /** 工作库内相对 store 路径：assets/<kind>/<sha256><ext> */
  store: string
  kind: AssetKind
}

/** 来源包指纹（来源可删后工作库自足） */
export interface OriginInfo {
  t2wPath: string
  t2wSize: number
  t2wSha256: string
  manifestJsonSha256: string
  /** meta/origin-header.bin 是否存在（未编辑档 golden G1） */
  hasOriginHeader: boolean
  projectId: string
  revisionId: string
  createdAt: string
}

/** 容器级骨架（导出用；records 内容不在此重复） */
export interface ManifestSkeleton {
  includesSource: boolean
  /** 顶层键序（format/includesSource/project/records/files…） */
  topLevelKeys: string[]
  /** 未预见的顶层键（向前兼容） */
  extra: Record<string, unknown>
  /** records 顶层键序 */
  recordsKeys: string[]
  /** 各容器在源中的形态 */
  containers: Record<string, ContainerKind>
  /**
   * 扩展（设计 §3.1 未列，落地必要）：各容器条目是否为 `{key,value}` 形态。
   * 为 true 时重建输出 `[{key,value}]`；false 时输出原始条目数组（保证无损）。
   */
  containerKeyed: Record<string, boolean>
  /**
   * 扩展（设计 §3.1 未列，落地必要）：完整 `project` 对象。
   * 导出需 `project` 全字段逐字节相等（W4），故随骨架持久化。
   */
  project: Record<string, unknown>
}

/** 分片索引行 */
export interface ShardRow {
  name: string
  file: string
  container: string
  entryCount: number
  sha256: string
}

/** 任务状态（对应 records.tasks + 编排器状态；M0 由解包器填充最小集） */
export interface TaskState {
  /**
   * `blocked` = **内容审查拦截**（D3）。
   *
   * 与 `failed` 的区别：failed 通常是网络/上游/数据问题，值得重试；
   * blocked 是上游模型拒绝生成（返回 200 但内容是「对不起，我不能…」这类拒绝语），
   * 重试与换配置都无效，**必须停下来等人处理**（换模型 / 改写提示词 / 人工介入）。
   * 依赖该任务的下游任务也不会继续跑——这是拦截机制的核心目的。
   */
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'local' | 'blocked'
  fingerprint: string | null
  updatedAt: string
  error: string | null
  /**
   * 最近一次实际执行的耗时（毫秒，G4）：从 running → 终态（succeeded/failed/local）的墙钟差。
   * 缺省 = 旧数据或跳过/待跑实例，无耗时可言。
   */
  elapsedMs?: number
  /**
   * 状态来源标记。`'runtime'` = 本机本次/历次运行写入；缺省 = **来源包自带的历史状态**
   * （导入 t2w 时整包解包带进来的，不是本机成绩）。
   * 读取侧据此过滤（见 persistence.loadTaskStates），避免「包内历史」被当成「本机已跑」。
   */
  source?: 'runtime'
}

/** 工作库索引（<root>/index.json） */
export interface WorkspaceIndex {
  indexVersion: 1
  format: 'txt2world-workspace'
  pkgId: string
  title: string
  origin: OriginInfo
  manifest: ManifestSkeleton
  shards: ShardRow[]
  assets: AssetRow[]
  tasks: Record<string, TaskState>
  integrity: { createdAt: string; lastVerifiedAt: string | null }
}

/** 工作库元信息（供 registry/list 使用的精简视图） */
export interface WorkspaceMeta {
  pkgId: string
  title: string
  root: string
  t2wPath: string
  createdAt: string
}

/**
 * 书库列表项（`workspace:list` 返回）。
 *
 * 逐目录 `readIndex` 后产出；`broken` 表示索引缺失/损坏/半成品。
 * 计数取 `manifest.project`（取不到给 0）；`totalBytes` = 该目录下所有文件字节和。
 */
export interface WorkspaceListItem {
  /**
   * **工作库目录名** —— 列表与 IPC 的唯一主键（打开/删除均按它拼路径）。
   *
   * 历史工作库的目录名恰等于 `pkgId`；改造后新书目录名 = `<UTC14位>-<随机hex>`，
   * 与包内编号解耦，因此同一 .t2w 反复导入可并存多本。上层不得再用 pkgId 去拼路径。
   */
  id: string
  /** 书在平台的原始编号（index.pkgId）——**降级为元数据**，仅供显示，不可作主键 */
  pkgId: string
  /** 显示用标题：默认取来源文件名（同标题的多个包由此可分），缺来源路径时回退包内书名 */
  title: string
  /** 工作库根（<userData>/workspace/<id>） */
  root: string
  /**
   * 是否为**当前会话打开的那本** —— 按 `root` 判定，不按 pkgId。
   *
   * 改造后同一 pkgId 可并存多份副本（同一个 .t2w 反复导入），
   * 若按 pkgId 判定会把同一本书的若干副本**同时**标成「当前打开」，属误导，故必须按目录判定。
   */
  current: boolean
  /** 来源 .t2w 路径（仅作展示，不保证仍存在） */
  t2wPath: string
  /** 来源 .t2w 字节数（origin.t2wSize） */
  t2wSize: number
  /** 工作库创建时间（origin.createdAt） */
  createdAt: string
  chapterCount: number
  charCount: number
  assetCount: number
  /** 工作库目录（含全部解析产物）字节和 */
  totalBytes: number
  /** 是否损坏：为 false 才会出现在正常列表结果里（损坏项另记于 broken[]） */
  broken: boolean
}

/** `workspace:list` 结果：正常项 + 损坏目录名（目录不存在 → 均为空，不是错误） */
export interface WorkspaceListResult {
  ok: boolean
  error?: string
  items: WorkspaceListItem[]
  /** 索引缺失/损坏/半成品的一级子目录名（原样保留，便于用户排查） */
  broken: string[]
}

/**
 * `workspace:exportT2w` 结果（一键导出，C2）。
 *
 * 形状与 `packWorkspace()` 一致并透传 `warnings`（缺分片/缺资产不静默丢）；
 * 用户取消保存框 → `{ok:false, canceled:true}`（不是错误，UI 不报错）。
 */
export interface ExportT2wResult {
  ok: boolean
  path?: string
  bytes?: number
  warnings?: string[]
  canceled?: boolean
  error?: string
}

/** 分片路由的返回值 */
export interface ShardRoute {
  name: string
  file: string
  container: string
}

/** 供 view/summary 复用的同形数据（= 原 T2wManifest） */
export type AssembledManifest = T2wManifest

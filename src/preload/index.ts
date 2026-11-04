import { contextBridge, ipcRenderer } from 'electron'
import type {
  ImportResult,
  ModelSettings,
  SourceReadResult,
  SpeakResult,
  ViewResult
} from '../shared/app-types'
import type { MangaViewResult } from '../shared/manga-types'
import type { WorkspaceListResult } from '../shared/workspace-types'
import type { ExportT2wResult } from '../shared/workspace-types'
import type {
  ModelListResult,
  ParseProgress,
  ParseStatus,
  ProbeResult,
  ProviderSettings,
  TasksOverview
} from '../shared/pipeline-types'
import type { ScriptSaveResult, ScriptSaveTarget } from '../main/script-edit'
import type {
  EffectCatalogResult,
  EffectsSavePayload,
  EffectsSaveResult,
  EffectSuggestInput,
  EffectSuggestResult
} from '../shared/effects-types'
import type {
  ImagegenGenerateRequest,
  ImagegenGenerateResult,
  ImagegenProbeResult,
  ImagegenTargetsResult
} from '../shared/imagegen-types'
import type {
  CardExportRequest,
  CardExportResult,
  CharacterCardListResult,
  CharacterCardResult,
  TavernGenerateRequest,
  TavernGenerateResult,
  TavernMessage,
  TavernParams,
  TavernSaveResult,
  TavernSettings
} from '../shared/character-card-types'
import type { ProductionPageResult } from '../main/manga-production/service'

export type { ImportResult, ModelSettings, SpeakResult } from '../shared/app-types'
export type { ReadingSegment, SourceReadResult } from '../shared/app-types'
export type { WorkspaceListItem, WorkspaceListResult } from '../shared/workspace-types'
/** 一键导出结果（C2）：ok/path/bytes/warnings/canceled/error */
export type { ExportT2wResult } from '../shared/workspace-types'
export type { ParseProgress, ParseStatus, ProbeResult, ProviderSettings } from '../shared/pipeline-types'
export type { ModelListResult } from '../shared/pipeline-types'
export type { TaskCounts, TaskInstanceState, TaskOverviewItem, TasksOverview } from '../shared/pipeline-types'
export type { ScriptSaveResult, ScriptSaveTarget } from '../main/script-edit'
export type {
  EffectCatalogEntry,
  EffectCatalogResult,
  EffectMount,
  EffectRange,
  EffectsSavePayload,
  EffectsSaveResult,
  EffectSuggestInput,
  EffectSuggestItem,
  EffectSuggestResult
} from '../shared/effects-types'
export type {
  CharTarget,
  IconTarget,
  ImagegenContext,
  ImagegenGenerateRequest,
  ImagegenGenerateResult,
  ImagegenKind,
  ImagegenProbeResult,
  ImagegenTargetsResult,
  SceneTarget
} from '../shared/imagegen-types'

/**
 * 把 Vue 响应式对象「拍平」成 IPC 能安全传输的普通值。
 *
 * 【为什么必须做】渲染层传进来的 `messages.value` / `params.value` 是 Vue 的
 * `reactive`/`ref` **Proxy 对象**。Electron 的 IPC 用 structured clone 序列化参数，
 * 遇到 Proxy 会抛：
 *   `An object could not be cloned.`
 * 这个错误在界面上表现为「点发送毫无反应 / 内置酒馆用不了」，且报错只在渲染进程
 * 控制台里出现，主进程完全收不到请求 —— 很难从现象反推原因。
 *
 * 用 `JSON.parse(JSON.stringify())` 而不是 `structuredClone()`：后者对 Proxy
 * 同样会抛；JSON 往返只保留纯数据（字符串/数字/布尔/null/数组/对象），
 * 正是 IPC 需要的形状，也顺手丢掉 undefined 与函数。
 */
function toPlainData<T>(v: T): T {
  if (v === null || v === undefined) return v
  try {
    return JSON.parse(JSON.stringify(v)) as T
  } catch {
    // 极端情况（含循环引用）退化为原值，让主进程给出更具体的错误
    return v
  }
}

const api = {
  /**
   * 导入并新建一本工作库（无条件新建、零提示；.t2w 与 .txt 完全同构）。
   * @param filePath 直接指定的来源路径（用于「打开方式」与自动化测试）；不传则弹出文件选择框
   * @param kind 仅用于文件框过滤项（预设路径时按扩展名分流，忽略此参）
   */
  importPackage: (filePath?: string, kind?: 't2w' | 'txt'): Promise<ImportResult> =>
    ipcRenderer.invoke('t2w:import', filePath, kind),
  previewEntry: (filePath: string, entryPath: string): Promise<{ ok: boolean; dataUrl?: string; error?: string }> =>
    ipcRenderer.invoke('t2w:preview', filePath, entryPath),
  /** 地图互动 / 视觉互动的渲染模型 */
  getView: (): Promise<ViewResult> => ipcRenderer.invoke('t2w:view'),
  /** 漫画线投影模型（漫画包不产出 storyScript，走独立通道） */
  getMangaView: (): Promise<MangaViewResult> => ipcRenderer.invoke('t2w:mangaView'),
  getSettings: (): Promise<ModelSettings> => ipcRenderer.invoke('settings:get'),
  saveSettings: (next: Partial<ModelSettings>): Promise<{ ok: boolean; error?: string; settings?: ModelSettings }> =>
    ipcRenderer.invoke('settings:save', next),
  /** TTS 合成（缓存优先；未配置模型接入时返回可读错误，不发起网络请求） */
  speak: (text: string, voice?: string): Promise<SpeakResult> => ipcRenderer.invoke('tts:speak', text, voice),
  /** 挑选 BGM：复制进 userData/bgm，返回 cache:// URL */
  pickBgm: (): Promise<{
    ok: boolean
    canceled?: boolean
    filePath?: string
    url?: string
    error?: string
  }> => ipcRenderer.invoke('media:pickBgm'),
  /** 按设置里的 bgmPath 解析/补建缓存副本 */
  resolveBgm: (
    filePath: string
  ): Promise<{ ok: boolean; url?: string; error?: string }> => ipcRenderer.invoke('media:resolveBgm', filePath),
  /** 窗口级全屏：设为指定状态，返回主进程确认后的真实状态 */
  setFullScreen: (on: boolean): Promise<{ ok: boolean; fullScreen: boolean }> =>
    ipcRenderer.invoke('window:setFullScreen', on),
  /** 窗口级全屏：在 true/false 之间切换 */
  toggleFullScreen: (): Promise<{ ok: boolean; fullScreen: boolean }> => ipcRenderer.invoke('window:toggleFullScreen'),
  /** 查询当前是否处于窗口级全屏（首帧与 UI 对齐用） */
  getFullScreen: (): Promise<boolean> => ipcRenderer.invoke('window:getFullScreen'),
  /** 订阅系统侧触发的全屏变化（F11 / 系统菜单），返回取消订阅函数 */
  onFullScreenChanged: (cb: (on: boolean) => void): (() => void) => {
    const listener = (_event: unknown, on: boolean): void => cb(on)
    ipcRenderer.on('window:fullScreenChanged', listener)
    return () => ipcRenderer.removeListener('window:fullScreenChanged', listener)
  },
  /** P3 脚本修订：写回某一句台词（主进程自动先备份原包） */
  saveScriptAction: (target: ScriptSaveTarget, newText: string): Promise<ScriptSaveResult> =>
    ipcRenderer.invoke('script:save', target, newText),
  /** P4 特效：读取特效目录（惰性加载 + 缓存；缺失/损坏返回可读错误） */
  getEffectCatalog: (): Promise<EffectCatalogResult> => ipcRenderer.invoke('effects:catalog'),
  /** P4 特效：写回单句特效 / 范围特效（主进程自动先备份 + tmp + 复检 + 原子改名） */
  saveEffects: (payload: EffectsSavePayload): Promise<EffectsSaveResult> =>
    ipcRenderer.invoke('effects:save', payload),
  /** P4 特效：LLM 推荐（任意 OpenAI 兼容端点；未配置模型立即报错不发请求） */
  suggestEffects: (input: EffectSuggestInput): Promise<EffectSuggestResult> =>
    ipcRenderer.invoke('effects:suggest', input),

  // —— M2 解析链路 ——
  /** 启动一次解析：range='all' 或任务 id 子集；force=true 强制重跑已成功实例（G3） */
  parseStart: (pkgId: string, range?: string[] | 'all', force?: boolean): Promise<{ ok: boolean; runId?: string; error?: string }> =>
    ipcRenderer.invoke('pipeline:parseStart', pkgId, range ?? 'all', force === true),
  /** 查询某次运行状态 */
  parseStatus: (runId: string): Promise<ParseStatus> => ipcRenderer.invoke('pipeline:parseStatus', runId),
  /** 取消某次运行 */
  parseCancel: (runId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('pipeline:parseCancel', runId),
  /**
   * 29 任务面板视图（T5）：本机状态计数 + 每任务失败明细 + 来源包历史条数（不计入本机成绩）。
   * @param pkgId 工作库**目录名**（`WorkspaceListItem.id`）；不传则用当前会话的工作库
   */
  tasksOverview: (pkgId?: string): Promise<{ ok: boolean; overview?: TasksOverview; error?: string }> =>
    ipcRenderer.invoke('pipeline:tasksOverview', pkgId),
  /** 订阅解析进度（返回取消订阅函数） */
  onParseProgress: (cb: (ev: ParseProgress) => void): (() => void) => {
    const listener = (_event: unknown, ev: ParseProgress): void => cb(ev)
    ipcRenderer.on('pipeline:progress', listener)
    return () => ipcRenderer.removeListener('pipeline:progress', listener)
  },

  // —— 多配置（N-4~N-8）——
  /** 读取全部 LLM/TTS 配置 + active + fallback 链 */
  getProviders: (): Promise<ProviderSettings> => ipcRenderer.invoke('ops:getProviders'),
  /** 覆盖式保存多配置 */
  saveProviders: (next: Partial<ProviderSettings>): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('ops:saveProviders', next),
  /** 探活指定配置 */
  probeProvider: (id: string): Promise<ProbeResult> => ipcRenderer.invoke('ops:probeProvider', id),
  /**
   * 探测端点有哪些模型（GET /models）。
   *
   * 传 `{ id }` 探测已保存配置；传 `{ baseURL, apiKey }` 探测表单里还没保存的。
   * 与 `probeProvider` 分工不同：那个需要已填 model，这个不需要 —— 填模型之前先看有哪些可选。
   */
  listModels: (arg: { id?: string; baseURL?: string; apiKey?: string }): Promise<ModelListResult> =>
    ipcRenderer.invoke('ops:listModels', arg),

  // —— 书库管理 ——
  /** 列出 <userData>/workspace 下所有工作库（损坏项单列于 broken[]，不抛错） */
  listWorkspaces: (): Promise<WorkspaceListResult> => ipcRenderer.invoke('workspace:list'),
  /**
   * 打开已有工作库（复用索引，不再解包）。
   * @param dirName 工作库**目录名**（= `WorkspaceListItem.id`）—— 不再是包内编号
   */
  openWorkspace: (dirName: string): Promise<ImportResult> => ipcRenderer.invoke('workspace:open', dirName),
  /** 真删磁盘工作库目录（按目录名；越界防护在主进程，二次确认由渲染层负责） */
  deleteWorkspace: (dirName: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('workspace:delete', dirName),
  /**
   * 一键导出（C2）：把工作库反向打包成 `.t2w`。
   * @param dirName 工作库**目录名**（= `WorkspaceListItem.id`）
   * @param outPath 导出目标绝对路径；不传 → 主进程弹保存框（默认 `<书名>.t2w`）
   */
  exportT2w: (dirName: string, outPath?: string): Promise<ExportT2wResult> =>
    ipcRenderer.invoke('workspace:exportT2w', dirName, outPath),
  /** 在系统文件管理器中打开工作库文件夹（只读打开，不写盘） */
  revealWorkspace: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('workspace:reveal'),
  /**
   * format 体检（只读诊断）：统计磁盘上每本工作库索引里的原始 format 串。
   *
   * 用途：工作库格式「读时兼容新旧两值」，此接口用来证明历史值确实还在盘上、
   * 且全部被接受 —— 不是靠批量迁移蒙混过去的。不改任何文件。
   */
  inspectWorkspaceFormats: (): Promise<{
    next: number
    legacy: number
    rejected: number
    rejectedSamples: string[]
    unreadable: number
    total: number
    error?: string
  }> => ipcRenderer.invoke('workspace:formats'),

  // —— 阅读原文 ——
  /** 读取当前工作库全书原文（按章切段；无会话/无原文/非 UTF-8 → 可读错误） */
  readSource: (): Promise<SourceReadResult> => ipcRenderer.invoke('source:read'),

  // —— 生图（本地 ComfyUI）——
  /** 探活 ComfyUI（GET /system_stats；连接拒绝/超时 → 可读错误） */
  imagegenProbe: (): Promise<ImagegenProbeResult> => ipcRenderer.invoke('imagegen:probe'),
  /**
   * 列出 ComfyUI 已安装的出图模型（ckpt_name 候选）。
   * 与探活分工不同：探活验服务在不在，这个回答「能用哪些模型」。
   */
  imagegenModels: (): Promise<{ ok: boolean; models?: string[]; error?: string }> =>
    ipcRenderer.invoke('imagegen:models'),
  /**
   * 待生成清单（人物形象/场景/地点类型，含缺图标记；纯读）。
   * @param pkgId 工作库**目录名**；不传则用当前会话的工作库
   */
  imagegenTargets: (pkgId?: string): Promise<ImagegenTargetsResult> =>
    ipcRenderer.invoke('imagegen:targets', pkgId),
  /** 单张生成 + 回填（批量由渲染层逐张串行调用，前端显示 N/M） */
  imagegenGenerate: (pkgId: string, req: ImagegenGenerateRequest): Promise<ImagegenGenerateResult> =>
    ipcRenderer.invoke('imagegen:generate', pkgId, req),

  // —— 角色卡 + 内置酒馆 ——
  /** 角色卡列表（轻量投影，不含档案正文） */
  cardList: (): Promise<CharacterCardListResult> => ipcRenderer.invoke('card:list'),
  /** 单张角色卡详情（含相关世界书与已有会话） */
  cardGet: (cardId: string): Promise<CharacterCardResult> => ipcRenderer.invoke('card:get', cardId),
  /**
   * 导出角色卡。
   * PNG = SillyTavern 卡片（立绘 + tEXt 内嵌 V2/V3 JSON）；JSON = 独立文件。
   * 不传 outDir 时主进程弹目录选择框。
   */
  cardExport: (req: CardExportRequest): Promise<CardExportResult> =>
    ipcRenderer.invoke('card:export', toPlainData(req)),
  /** 读酒馆设置（无则返回 null，由渲染层补默认） */
  tavernGetSettings: (): Promise<TavernSettings | null> => ipcRenderer.invoke('tavern:getSettings'),
  /** 存酒馆设置（拍平后再传，见 toPlainData 注释） */
  tavernSaveSettings: (s: TavernSettings): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('tavern:saveSettings', toPlainData(s)),
  /** 生成一条角色回复（messages/params 都是 Vue Proxy，必须拍平） */
  tavernGenerate: (req: TavernGenerateRequest): Promise<TavernGenerateResult> =>
    ipcRenderer.invoke('tavern:generate', toPlainData(req)),
  /** 保存对话（按卡片 id 归并，一本书一套会话） */
  tavernSaveSession: (
    cardId: string,
    messages: TavernMessage[],
    params: TavernParams | null
  ): Promise<TavernSaveResult> =>
    ipcRenderer.invoke('tavern:saveSession', cardId, toPlainData(messages), toPlainData(params)),

  // —— 漫画编排（讲述与配音 / 背景配乐 / 本页音色）——
  /** 取某一页的编排数据（段、配音状态、音色、配乐、概览） */
  mangaProductionPage: (chapterSeq: number, pageNo: number): Promise<ProductionPageResult> =>
    ipcRenderer.invoke('mangaProduction:page', chapterSeq, pageNo),
  /** 保存本页音色档案（写回 :dubbing:voice:<charId>） */
  mangaProductionSaveVoice: (input: {
    characterId: string
    vt: string
    vi: string
    isNarrator: boolean
  }): Promise<{ ok: boolean; error?: string; created?: boolean }> =>
    ipcRenderer.invoke('mangaProduction:saveVoice', toPlainData(input)),
  /**
   * 重新配音本页：逐段 TTS 合成后一次性写回 clip。
   * @param voiceMap characterId → 音色描述（作为 TTS 的 voice 提示）
   */
  mangaProductionRedub: (
    chapterSeq: number,
    pageNo: number,
    voiceMap: Record<string, string>
  ): Promise<{ ok: boolean; error?: string; updated?: number; synthesized?: number }> =>
    ipcRenderer.invoke('mangaProduction:redub', chapterSeq, pageNo, toPlainData(voiceMap)),
  /** 换章级配乐（写回 mangaMusic:chapter:* 的 selection.track） */
  mangaProductionSaveMusic: (input: {
    chapterSeq: number
    track: {
      id: string
      title: string
      author: string
      url: string
      durationSec: number
      licenseId: string
      attribution: string
    }
  }): Promise<{ ok: boolean; error?: string; updated?: number }> =>
    ipcRenderer.invoke('mangaProduction:saveMusic', toPlainData(input))
}

export type FeatherApi = typeof api

contextBridge.exposeInMainWorld('feather', api)
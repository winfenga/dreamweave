import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { readFile, rm, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type {
  ImportResult,
  ModelSettings,
  SourceReadResult,
  ViewResult
} from '../../shared/app-types'
import type { MangaViewResult } from '../../shared/manga-types'
import type { ExportT2wResult, WorkspaceListResult } from '../../shared/workspace-types'
import type {
  ParseStatus,
  ProbeResult,
  ProviderSettings,
  TasksOverview
} from '../../shared/pipeline-types'
import { buildSummary, extractChapters } from '../t2w/summary'
import { buildViewData } from '../t2w/view'
import { buildMangaView } from '../t2w/manga'
import { readPackage } from '../t2w'
import { loadSettings, saveSettings, validateBaseURL } from '../settings/store'
import { resolveStorePath } from '../workspace/assets'
import { readIndex } from '../workspace/index-store'
import {
  allocWorkspaceDirName,
  assertSafeWorkspaceDir,
  buildReadingSegments,
  isSourceEntry,
  listWorkspaces,
  resolveWorkspaceDir
} from '../workspace/library'
import { assembleManifest } from '../workspace/manifest-assembler'
import { packWorkspace } from '../workspace/pack'
import { WORKSPACE_DIR_NAME, sanitizeSegment } from '../workspace/paths'
import {
  clearWorkspaceSession,
  getWorkspaceSession,
  makeSession,
  setWorkspaceSession
} from '../workspace/session'
import { unpack } from '../workspace/unpack'
import { buildTxtWorkspace } from '../workspace/txt-import'
import { speak } from '../tts'
import { pickBgm, resolveBgm } from '../media'
import { saveScriptAction, type ScriptSaveResult, type ScriptSaveTarget } from '../script-edit'
import { loadCatalog } from '../effects/catalog'
import { saveEffectsAction } from '../effects-edit'
import { suggestEffects } from '../effects-suggest'
import {
  cancel as pipelineCancel,
  onProgress as onPipelineProgress,
  parseStatus as pipelineParseStatus,
  start as pipelineStart
} from '../pipeline/orchestrator'
import { probeProvider, saveProviders } from '../pipeline/providers'
import { buildTasksOverview } from '../pipeline/overview'
import type {
  EffectCatalogResult,
  EffectsSavePayload,
  EffectsSaveResult,
  EffectSuggestInput,
  EffectSuggestResult
} from '../../shared/effects-types'
import type {
  ImagegenGenerateRequest,
  ImagegenGenerateResult,
  ImagegenProbeResult,
  ImagegenTargetsResult
} from '../../shared/imagegen-types'
import { imagegenGenerate, imagegenTargets, probeImagegen } from '../imagegen'

export const IPC = {
  importPackage: 't2w:import',
  previewEntry: 't2w:preview',
  view: 't2w:view',
  /** 漫画线投影模型（独立通道：漫画包不产出 storyScript） */
  mangaView: 't2w:mangaView',
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  /** 合成一段文本（缓存优先；未配置模型接入时返回可读错误，不发起请求） */
  ttsSpeak: 'tts:speak',
  /** 弹出文件框挑选 BGM，复制进 userData/bgm 后返回 cache:// URL */
  mediaPickBgm: 'media:pickBgm',
  /** 按设置里的 bgmPath 重新定位/补建缓存副本 */
  mediaResolveBgm: 'media:resolveBgm',
  /** 窗口级全屏：设为指定状态，返回主进程确认后的真实状态 */
  windowSetFullScreen: 'window:setFullScreen',
  /** 窗口级全屏：在 true/false 之间切换 */
  windowToggleFullScreen: 'window:toggleFullScreen',
  /** 查询当前是否为窗口级全屏（渲染进程首帧对齐用） */
  windowGetFullScreen: 'window:getFullScreen',
  /** 主进程 → 渲染进程：全屏状态变化（含系统侧 F11 / 系统菜单触发的） */
  windowFullScreenChanged: 'window:fullScreenChanged',
  /** P3 脚本修订：把某一句台词的修改写回原包（写回前自动备份） */
  scriptSave: 'script:save',
  /** P4 特效：读取特效目录（惰性加载 + 缓存） */
  effectsCatalog: 'effects:catalog',
  /** P4 特效：写回单句特效 / 范围特效（备份 + tmp + 复检 + 原子改名） */
  effectsSave: 'effects:save',
  /** P4 特效：LLM 推荐（任意 OpenAI 兼容端点 + 白名单过滤） */
  effectsSuggest: 'effects:suggest',
  /** M2 解析：启动一次解析（range='all' 或任务 id 子集） */
  pipelineParseStart: 'pipeline:parseStart',
  /** M2 解析：查询某次运行状态 */
  pipelineParseStatus: 'pipeline:parseStatus',
  /** M2 解析：取消某次运行 */
  pipelineParseCancel: 'pipeline:parseCancel',
  /** M2 解析（T5）：29 任务面板视图（本机状态 + 失败明细 + 来源包历史条数） */
  pipelineTasksOverview: 'pipeline:tasksOverview',
  /** M2 解析：主进程 → 渲染进程 进度事件 */
  pipelineProgress: 'pipeline:progress',
  /** 多配置：读取全部 LLM/TTS 配置 + active + fallback 链 */
  opsGetProviders: 'ops:getProviders',
  /** 多配置：覆盖式保存（增删改 + 选 active + fallback 链） */
  opsSaveProviders: 'ops:saveProviders',
  /** 多配置：探活指定配置 */
  opsProbeProvider: 'ops:probeProvider',
  /** 书库：列出 <userData>/workspace 下所有工作库（损坏项跳过并单列） */
  workspaceList: 'workspace:list',
  /** 书库：按**目录名**打开已有工作库（复用索引，不再解包）→ 装配 manifest → 摘要 */
  workspaceOpen: 'workspace:open',
  /** 书库：按**目录名**真删磁盘工作库目录（越界防护 + 二次确认在渲染层） */
  workspaceDelete: 'workspace:delete',
  /** 书库：在系统文件管理器中打开工作库文件夹（只读打开，不写盘） */
  workspaceReveal: 'workspace:reveal',
  /** 书库：一键导出 —— 把工作库反向打包成 .t2w（C2；outPath 缺省时弹保存框） */
  workspaceExportT2w: 'workspace:exportT2w',
  /** 阅读原文：按章切段返回当前工作库的全书原文 */
  sourceRead: 'source:read',
  /** 生图：探活 ComfyUI（GET /system_stats） */
  imagegenProbe: 'imagegen:probe',
  /** 生图：待生成清单（人物形象/场景/地点类型，含缺图标记；纯读） */
  imagegenTargets: 'imagegen:targets',
  /** 生图：单张生成 + 回填（批量由渲染层逐张串行调用） */
  imagegenGenerate: 'imagegen:generate'
} as const

export type { ScriptSaveResult, ScriptSaveTarget }

export type { SourceReadResult } from '../../shared/app-types'
export type { WorkspaceListItem, WorkspaceListResult } from '../../shared/workspace-types'

/** 全屏操作结果：始终回传主进程确认后的真实状态，渲染进程不自行乐观假设 */
export type FullScreenResult = { ok: boolean; fullScreen: boolean }

/**
 * `workspace:exportT2w` 结果（一键导出，C2）—— 定义在 `shared/workspace-types`，
 * 此处再导出是为了让 IPC 与 preload 共用同一份类型（preload 不 import main，避免把
 * 主进程模块拖进 web 端类型检查）。
 */
export type { ExportT2wResult }

export type { ImportResult } from '../../shared/app-types'

function mimeOf(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    default:
      return 'application/octet-stream'
  }
}

/**
 * 导入 .t2w：**无条件新建**一本工作库。
 *
 * 目录名由 `allocWorkspaceDirName()` 现场分配（`<UTC14位>-<随机hex>`，已校验未被占用），
 * **与包内编号彻底解耦** —— 因此同一个 .t2w 反复导入会各自独立成书，互不影响；
 * 既没有「已存在则复用/覆盖」的分支，也不产生任何「重复/覆盖」提示。
 *
 * 来源整包大小用 `stat().size`（不再把整包读进内存只为算 sha）；
 * `index.origin.t2wSha256` 等来源指纹由 `unpack()` 内部负责计算并落盘。
 */
async function loadPackage(filePath: string): Promise<ImportResult> {
  try {
    const pkg = await readPackage(filePath)

    // 工作库根：`<userData>/workspace/<现场分配的目录名>`
    const wsRoot = join(app.getPath('userData'), WORKSPACE_DIR_NAME)
    const dirName = await allocWorkspaceDirName(wsRoot)
    const root = join(wsRoot, dirName)

    // 每次都新建：无 open-or-create 分支，无指纹比对，无去重
    const r = await unpack(filePath, root)
    const index = r.index

    // 记入工作库会话后，包内成员即可通过 t2w://<key>/<entryPath> 从工作库 assets/ 常驻访问
    setWorkspaceSession(makeSession(root, index))
    const manifest = await assembleManifest(root, index)
    const summary = buildSummary(manifest, {
      filePath,
      totalSize: (await stat(filePath)).size,
      jsonLen: pkg.jsonLen,
      blobStart: pkg.blobStart,
      verify: pkg.verifySummary,
      guards: pkg.guards
    })
    return { ok: true, summary }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * 导入 .txt：**无条件新建**一本工作库（与 `loadPackage` 完全同构，零提示）。
 *
 * 目录名由 `allocWorkspaceDirName()` 现场分配（`<UTC14位>-<随机hex>`），与文件内容彻底解耦 ——
 * 同一个 .txt 反复导入会各自独立成书，互不影响；没有「已存在则复用/覆盖」分支，也无重复提示。
 * 章节切分、chunk 装箱、编码检测全部在 `buildTxtWorkspace()` 内完成（node 可测，不依赖 electron）。
 *
 * 摘要的中性口径与 `openWorkspace` 一致：来源不是 .t2w 容器（无 manifest/blob 区），
 * verify/guards 取中性值；`totalSize` 用索引里的 `origin.t2wSize`（= 原始文件字节数）。
 */
async function loadTxt(filePath: string): Promise<ImportResult> {
  try {
    // 工作库根：`<userData>/workspace/<现场分配的目录名>`
    const wsRoot = workspaceRoot()
    const dirName = await allocWorkspaceDirName(wsRoot)
    const root = join(wsRoot, dirName)

    // 每次都新建：无 open-or-create 分支，无指纹比对，无去重
    const index = await buildTxtWorkspace(filePath, root)

    // 记入工作库会话后，包内成员即可通过 t2w://<key>/<entryPath> 从工作库 assets/ 常驻访问
    setWorkspaceSession(makeSession(root, index))
    const manifest = await assembleManifest(root, index)
    const summary = buildSummary(manifest, {
      filePath,
      totalSize: index.origin.t2wSize,
      jsonLen: 0,
      blobStart: 0,
      verify: { total: 0, passed: 0, failed: 0 },
      guards: { sumSizeMatches: true, noTrailingBytes: true }
    })
    return { ok: true, summary }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 书库根：`<userData>/workspace`（与 loadPackage 的 root 计算同源）。 */
function workspaceRoot(): string {
  return join(app.getPath('userData'), WORKSPACE_DIR_NAME)
}

/**
 * 打开已有工作库（复用索引，不再解包）。
 *
 * 来源整包上下文缺失（本次未读来源包），故 `SummarySource` 用索引里的 origin 指纹兜底，
 * verify/guards 取中性值 → 概览页据此显示「未做来源整包校验」。
 *
 * @param dirName 工作库**目录名**（= `WorkspaceListItem.id`；不再是包内编号 pkgId）
 */
async function openWorkspace(dirName: string): Promise<ImportResult> {
  try {
    const r = resolveWorkspaceDir(workspaceRoot(), dirName)
    if (!r.ok || !r.dir) return { ok: false, error: r.error }
    const root = r.dir
    const index = await readIndex(root)
    setWorkspaceSession(makeSession(root, index))
    const manifest = await assembleManifest(root, index)
    const summary = buildSummary(manifest, {
      filePath: index.origin.t2wPath,
      totalSize: index.origin.t2wSize,
      jsonLen: 0,
      blobStart: 0,
      verify: { total: 0, passed: 0, failed: 0 },
      guards: { sumSizeMatches: true, noTrailingBytes: true }
    })
    return { ok: true, summary }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * 无漫画线时给渲染层的提示文案。
 * 「本包是纯文本线（storyScript 产出），没有 mangaScript 任务产物」时返回它。
 */
const EMPTY_MANGA_HINT = '本工作库没有漫画线数据（未产出 mangaScript / 页面图），可能是纯文本演出包。'

export function registerIpc(): void {
  // presetPath 用于「打开方式 / 命令行 / 自动化测试」直接指定包路径；不传则弹出文件选择框。
  // kind 仅决定文件框的过滤项与标题（.t2w 与 .txt 都可选 / 仅 .txt）；预设路径时**按扩展名分流**，忽略 kind。
  ipcMain.handle(
    IPC.importPackage,
    async (event, presetPath?: string, kind?: 't2w' | 'txt'): Promise<ImportResult> => {
      // 按扩展名分流：.txt → loadTxt（无条件新建），其余 → loadPackage（.t2w 解包）
      const dispatch = async (p: string): Promise<ImportResult> =>
        extname(p).toLowerCase() === '.txt' ? loadTxt(p) : loadPackage(p)
      if (presetPath) return dispatch(presetPath)

      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const picked = await dialog.showOpenDialog(win as BrowserWindow, {
        title: kind === 'txt' ? '导入文本文档' : '导入 .t2w 包或文本文档',
        properties: ['openFile'],
        filters:
          kind === 'txt'
            ? [
                { name: '文本文档', extensions: ['txt'] },
                { name: '全部文件', extensions: ['*'] }
              ]
            : [
                { name: 'T2W 包', extensions: ['t2w'] },
                { name: '文本文档', extensions: ['txt'] },
                { name: '全部文件', extensions: ['*'] }
              ]
      })
      if (picked.canceled || picked.filePaths.length === 0) {
        return { ok: false, canceled: true }
      }
      return dispatch(picked.filePaths[0])
    }
  )

  ipcMain.handle(
    IPC.previewEntry,
    async (
      _event,
      _filePath: string,
      entryPath: string
    ): Promise<{ ok: boolean; dataUrl?: string; error?: string }> => {
      try {
        const session = getWorkspaceSession()
        if (!session) return { ok: false, error: '尚未导入任何工作库' }
        const abs = resolveStorePath(session.root, session.index, entryPath)
        if (!abs) return { ok: false, error: `资产不存在于工作库：${entryPath}` }
        const buf = Buffer.from(await readFile(abs))
        const dataUrl = `data:${mimeOf(entryPath)};base64,${buf.toString('base64')}`
        return { ok: true, dataUrl }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
  )

  // 地图互动 / 视觉互动所需的渲染模型（从当前工作库装配出与今日同形的 manifest，解析算法不变）
  ipcMain.handle(IPC.view, async (): Promise<ViewResult> => {
    try {
      const session = getWorkspaceSession()
      if (!session) return { ok: false, error: '尚未导入任何工作库' }
      const index = await readIndex(session.root)
      const manifest = await assembleManifest(session.root, index)
      return { ok: true, data: buildViewData(manifest, session.assetBase) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // 漫画线投影模型（独立于 view：漫画包不产出 storyScript，两条线数据结构不同）
  ipcMain.handle(IPC.mangaView, async (): Promise<MangaViewResult> => {
    try {
      const session = getWorkspaceSession()
      if (!session) return { ok: false, error: '尚未导入任何工作库' }
      const index = await readIndex(session.root)
      const manifest = await assembleManifest(session.root, index)
      const data = buildMangaView(manifest, session.assetBase)
      if (!data) return { ok: false, error: EMPTY_MANGA_HINT }
      return { ok: true, data }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle(IPC.settingsGet, async (): Promise<ModelSettings> => loadSettings())

  ipcMain.handle(
    IPC.settingsSave,
    async (_event, next: Partial<ModelSettings>): Promise<{ ok: boolean; error?: string; settings?: ModelSettings }> => {
      if (next.baseURL && !validateBaseURL(next.baseURL).ok) {
        return { ok: false, error: validateBaseURL(next.baseURL).reason }
      }
      const saved = await saveSettings(next)
      return { ok: true, settings: saved }
    }
  )

  ipcMain.handle(
    IPC.ttsSpeak,
    async (_event, text: string, voice?: string) => speak(text, { voice })
  )

  ipcMain.handle(IPC.mediaPickBgm, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    return pickBgm(win)
  })

  ipcMain.handle(IPC.mediaResolveBgm, async (_event, filePath: string) => resolveBgm(filePath))

  ipcMain.handle(IPC.windowSetFullScreen, (event, on: boolean): FullScreenResult => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { ok: false, fullScreen: false }
    win.setFullScreen(!!on)
    return { ok: true, fullScreen: win.isFullScreen() }
  })

  ipcMain.handle(IPC.windowToggleFullScreen, (event): FullScreenResult => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { ok: false, fullScreen: false }
    win.setFullScreen(!win.isFullScreen())
    return { ok: true, fullScreen: win.isFullScreen() }
  })

  ipcMain.handle(IPC.windowGetFullScreen, (event): boolean => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win ? win.isFullScreen() : false
  })

  // P3 脚本修订：定位 → 备份 → storyScript 分片原子写（唯一入口）→ 成员级复检
  ipcMain.handle(
    IPC.scriptSave,
    async (_event, target: ScriptSaveTarget, newText: string): Promise<ScriptSaveResult> =>
      saveScriptAction(target, newText)
  )

  // P4 特效目录：惰性加载 + 内存缓存（缺失/损坏返回可读错误，应用不崩）
  ipcMain.handle(IPC.effectsCatalog, async (): Promise<EffectCatalogResult> => loadCatalog())

  // P4 特效写回：三元键定位 → 备份 → storyScript 分片原子写（唯一入口）→ 成员级复检
  ipcMain.handle(
    IPC.effectsSave,
    async (_event, payload: EffectsSavePayload): Promise<EffectsSaveResult> => saveEffectsAction(payload)
  )

  // P4 特效推荐：未配置模型立即报错不发请求；未知 id 白名单过滤
  ipcMain.handle(
    IPC.effectsSuggest,
    async (_event, input: EffectSuggestInput): Promise<EffectSuggestResult> => suggestEffects(input)
  )

  // M2 解析：启动 / 状态 / 取消（进度经 pipelineProgress 事件推送）
  ipcMain.handle(
    IPC.pipelineParseStart,
    async (
      _event,
      pkgId: string,
      range?: string[] | 'all',
      force?: boolean
    ): Promise<{ ok: boolean; runId?: string; error?: string }> => {
      try {
        return await pipelineStart(pkgId, { range: range ?? 'all', force: force === true })
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
  )

  ipcMain.handle(IPC.pipelineParseStatus, async (_event, runId: string): Promise<ParseStatus> => pipelineParseStatus(runId))

  ipcMain.handle(IPC.pipelineParseCancel, async (_event, runId: string): Promise<{ ok: boolean }> => pipelineCancel(runId))

  /**
   * 任务面板（T5）：29 任务分组视图（本机状态 / 失败明细 / 来源包历史）。
   *
   * root 取法：传了 pkgId（= 工作库**目录名**，与 `workspace:list` 的 `id` 同源）→
   * `<userData>/workspace/<sanitizeSegment(pkgId)>`；不传 → 当前会话 root。
   * 与书库路径规则一致（`resolveWorkspaceDir` 同样对目录名过 `sanitizeSegment`），
   * 故「从哪个入口点进来」都定位到同一本工作库；两处都取不到 → 可读错误而不是空面板。
   */
  ipcMain.handle(
    IPC.pipelineTasksOverview,
    async (
      _event,
      pkgId?: string
    ): Promise<{ ok: boolean; overview?: TasksOverview; error?: string }> => {
      try {
        const root = pkgId ? join(workspaceRoot(), sanitizeSegment(pkgId)) : getWorkspaceSession()?.root
        if (!root) return { ok: false, error: '尚未打开任何工作库，无法读取任务面板' }
        return { ok: true, overview: await buildTasksOverview(root) }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
  )

  // 进度事件：编排器 → 所有窗口（订阅一次即可）
  onPipelineProgress((ev) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue
      win.webContents.send(IPC.pipelineProgress, ev)
    }
  })

  // 多配置：读取 / 保存 / 探活
  ipcMain.handle(IPC.opsGetProviders, async (): Promise<ProviderSettings> => {
    const s = await loadSettings()
    return {
      llm: s.llm,
      tts: s.tts,
      activeLlmId: s.activeLlmId,
      activeTtsId: s.activeTtsId,
      fallbackChain: s.fallbackChain
    }
  })

  ipcMain.handle(
    IPC.opsSaveProviders,
    async (_event, next: Partial<ProviderSettings>): Promise<{ ok: boolean; error?: string }> => saveProviders(next)
  )

  ipcMain.handle(IPC.opsProbeProvider, async (_event, id: string): Promise<ProbeResult> => probeProvider(id))

  // —— 书库管理 ——
  ipcMain.handle(IPC.workspaceList, async (): Promise<WorkspaceListResult> => {
    try {
      // 「当前打开」按目录判定：把当前会话的工作库根传给列表层（按 pkgId 会误标同一本书的多份副本）
      const { items, broken } = await listWorkspaces(workspaceRoot(), getWorkspaceSession()?.root)
      return { ok: true, items, broken }
    } catch (e) {
      return { ok: false, error: (e as Error).message, items: [], broken: [] }
    }
  })

  ipcMain.handle(IPC.workspaceOpen, async (_event, dirName: string): Promise<ImportResult> =>
    openWorkspace(dirName)
  )

  ipcMain.handle(
    IPC.workspaceDelete,
    async (_event, dirName: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const r = resolveWorkspaceDir(workspaceRoot(), dirName)
        if (!r.ok || !r.dir) return { ok: false, error: r.error }
        const guard = await assertSafeWorkspaceDir(r.dir)
        if (guard) return { ok: false, error: guard }
        // 删前先清会话：避免删除后会话仍指向已不存在的目录（按目录定位，不再比 pkgId）
        if (getWorkspaceSession()?.root === r.dir) clearWorkspaceSession()
        await rm(r.dir, { recursive: true, force: false })
        return { ok: true }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
  )

  /**
   * 一键导出（C2）：工作库 → `.t2w`。
   *
   * - 入参 `dirName` = 工作库**目录名**（= `WorkspaceListItem.id`），走与打开/删除同一套
   *   `resolveWorkspaceDir` 越界防护；`root` 由它拼出，不接受外部传绝对路径。
   * - `outPath` 缺省 → `dialog.showSaveDialog`（默认文件名 `<书名>.t2w`，filters 限定 t2w）；
   *   用户取消 → `{ok:false, canceled:true}`。
   * - 打包全部在 `packWorkspace()` 内完成（tmp + 复检 + 原子 rename，失败不留半截文件），
   *   它**不抛裸异常**，本 handler 只做路径解析与文件框。
   */
  ipcMain.handle(
    IPC.workspaceExportT2w,
    async (event, dirName: string, outPath?: string): Promise<ExportT2wResult> => {
      try {
        const r = resolveWorkspaceDir(workspaceRoot(), dirName)
        if (!r.ok || !r.dir) return { ok: false, error: r.error ?? '工作库目录名不合法' }

        let target = typeof outPath === 'string' && outPath.length > 0 ? outPath : ''
        if (!target) {
          // 默认文件名：包内书名（无书名时退回目录名）；扩展名固定 .t2w
          let bookName = dirName
          try {
            bookName = (await readIndex(r.dir)).title || dirName
          } catch {
            /* 索引读不到就用目录名，不阻断导出 */
          }
          const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
          const picked = await dialog.showSaveDialog(win as BrowserWindow, {
            title: '导出 .t2w 包',
            defaultPath: `${bookName.replace(/[\\/:*?"<>|]+/g, '_')}.t2w`,
            filters: [
              { name: 'T2W 包', extensions: ['t2w'] },
              { name: '全部文件', extensions: ['*'] }
            ]
          })
          if (picked.canceled || !picked.filePath) return { ok: false, canceled: true }
          target = picked.filePath
        }

        const res = await packWorkspace(r.dir, target)
        return { ok: res.ok, path: res.path, bytes: res.bytes, warnings: res.warnings, error: res.error }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
  )

  ipcMain.handle(IPC.workspaceReveal, async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      // 只读打开工作库文件夹（不建目录、不写盘）
      const err = await shell.openPath(workspaceRoot())
      return err ? { ok: false, error: err } : { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // —— 阅读原文 ——
  ipcMain.handle(IPC.sourceRead, async (): Promise<SourceReadResult> => {    try {
      const session = getWorkspaceSession()
      if (!session) return { ok: false, error: '尚未打开任何工作库' }
      const index = await readIndex(session.root)
      const row = index.assets.find((a) => isSourceEntry(a.path))
      if (!row) return { ok: false, error: '该包未包含原文（source/body.utf8.txt），无法在线阅读' }
      const buf = Buffer.from(await readFile(join(session.root, row.store)))
      // 原文成员恒为 UTF-8（entryPath 即 body.utf8.txt）；非 UTF-8 时明确报错，绝不隐式转码
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(buf)
      } catch {
        return { ok: false, error: '原文不是有效的 UTF-8 文本，本应用不做隐式转码' }
      }
      const manifest = await assembleManifest(session.root, index)
      const chapters = extractChapters((manifest.records ?? {}) as Record<string, unknown>)
      const { segments, skippedChapters } = buildReadingSegments(buf, chapters)
      return { ok: true, segments, chapters, skippedChapters }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // —— 生图（本地 ComfyUI）——
  ipcMain.handle(IPC.imagegenProbe, async (): Promise<ImagegenProbeResult> => {
    try {
      const s = await loadSettings()
      return await probeImagegen(s.comfyui)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // 生图目标清单：root 取法与 pipeline:tasksOverview 同源（pkgId=工作库目录名 → sanitize；
  // 不传 → 当前会话），保证「从哪个入口点进来」都定位到同一本工作库
  ipcMain.handle(
    IPC.imagegenTargets,
    async (_event, pkgId?: string): Promise<ImagegenTargetsResult> => {
      try {
        const root = pkgId ? join(workspaceRoot(), sanitizeSegment(pkgId)) : getWorkspaceSession()?.root
        if (!root) return { ok: false, error: '尚未打开任何工作库，无法读取生图目标' }
        return await imagegenTargets(root)
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
  )

  ipcMain.handle(
    IPC.imagegenGenerate,
    async (_event, pkgId: string, req: ImagegenGenerateRequest): Promise<ImagegenGenerateResult> => {
      try {
        const root = pkgId ? join(workspaceRoot(), sanitizeSegment(pkgId)) : getWorkspaceSession()?.root
        if (!root) return { ok: false, error: '尚未打开任何工作库，无法生成' }
        const s = await loadSettings()
        return await imagegenGenerate(root, s.comfyui, req)
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
  )
}

/**
 * 绑定「窗口自身全屏状态变化」→ 推送给渲染进程。
 * 必须按窗口注册：系统侧 F11 / 系统菜单 / 双击标题栏触发的全屏不经过我们的 IPC，
 * 只有监听 enter/leave-full-screen 才能让按钮文案与真实状态不脱节。
 */
export function registerWindowFullScreenEvents(win: BrowserWindow): void {
  const push = (on: boolean): void => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send(IPC.windowFullScreenChanged, on)
  }
  win.on('enter-full-screen', () => push(true))
  win.on('leave-full-screen', () => push(false))
}

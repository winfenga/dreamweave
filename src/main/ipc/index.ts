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
  ModelListResult,
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
import { readAsset, resolveStorePath } from '../workspace/assets'
import { readIndex } from '../workspace/index-store'
import {
  allocWorkspaceDirName,
  assertSafeWorkspaceDir,
  buildReadingSegments,
  isSourceEntry,
  listWorkspaces,
  inspectWorkspaceFormats,
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
import { repairShardIndex } from '../workspace/verify'
import { buildTxtWorkspace } from '../workspace/txt-import'
import { recognizeChaptersByLlm } from '../workspace/chapter-recognition-llm'
import { speak } from '../tts'
import { pickBgm, resolveBgm } from '../media'
import { saveScriptAction, type ScriptSaveResult, type ScriptSaveTarget } from '../script-edit'
import { loadCatalog } from '../effects/catalog'
import { saveEffectsAction } from '../effects-edit'
import { suggestEffects } from '../effects-suggest'
import {
  cancel as pipelineCancel,
  cancelAll as pipelineCancelAll,
  onProgress as onPipelineProgress,
  parseStatus as pipelineParseStatus,
  start as pipelineStart
} from '../pipeline/orchestrator'
import { activeProvider, listModels, listModelsOf, probeProvider, saveProviders } from '../pipeline/providers'
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
import { imagegenGenerate, imagegenTargets, listImagegenModels, probeImagegen } from '../imagegen'
import {
  defaultExportDirName,
  exportCards,
  getCard,
  listCards,
  loadTavernSettings,
  saveSession,
  saveTavernSettings,
  tavernGenerate
} from '../character-card'
import type {
  CardExportRequest,
  CardExportResult,
  CharacterCardListResult,
  CharacterCardResult,
  TavernGenerateRequest,
  TavernGenerateResult,
  TavernMessage,
  TavernParams,
  TavernSettings
} from '../../shared/character-card-types'
import type { T2wManifest } from '../../shared/t2w-types'
import {
  getProductionPage,
  invalidateDurations,
  redubPage,
  saveMusic,
  savePageVoice
} from '../manga-production/service'
import type { ProductionPageResult } from '../manga-production/service'
import type { MusicEditInput, VoiceEditInput } from '../manga-production/write'

export const IPC = {
  importPackage: 't2w:import',
  previewEntry: 't2w:preview',
  view: 't2w:view',
  /** 漫画线投影模型（独立通道：漫画包不产出 storyScript） */
  mangaView: 't2w:mangaView',

  // —— 角色卡 + 内置酒馆 ——
  /** 角色卡列表（轻量投影） */
  cardList: 'card:list',
  /** 单张角色卡详情（含世界书与已有会话） */
  cardGet: 'card:get',
  /** 导出角色卡（PNG = SillyTavern 卡片 / JSON） */
  cardExport: 'card:export',
  /** 读取酒馆设置 */
  tavernGetSettings: 'tavern:getSettings',
  /** 保存酒馆设置 */
  tavernSaveSettings: 'tavern:saveSettings',
  /** 生成一条角色回复 */
  tavernGenerate: 'tavern:generate',
  /** 保存对话会话 */
  tavernSaveSession: 'tavern:saveSession',

  // —— 漫画编排（讲述与配音 / 背景配乐 / 本页音色）——
  /** 取某一页的编排数据（段/配音状态/音色/配乐） */
  mangaProductionPage: 'mangaProduction:page',
  /** 保存本页音色档案 */
  mangaProductionSaveVoice: 'mangaProduction:saveVoice',
  /** 重新配音本页（TTS → 写回） */
  mangaProductionRedub: 'mangaProduction:redub',
  /** 换章级配乐 */
  mangaProductionSaveMusic: 'mangaProduction:saveMusic',

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
  /** M2 解析：取消**全部**运行中的解析（UI 在按钮被锁死时的兜底清场） */
  pipelineParseCancelAll: 'pipeline:parseCancelAll',
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
  /**
   * 多配置：**探测端点有哪些模型**（GET /models）。
   *
   * 与 `opsProbeProvider` 分工不同：探活验证「这组现在能跑吗」（需已填 model），
   * 探测回答「这个端点有哪些模型可选」（不需要 model）。填模型之前只能靠探测。
   * 入参可给已保存的 `id`，也可直接给表单里**还没保存**的 baseURL/apiKey。
   */
  opsListModels: 'ops:listModels',
  /** 书库：列出 <userData>/workspace 下所有工作库（损坏项跳过并单列） */
  workspaceList: 'workspace:list',
  /** 书库：按**目录名**打开已有工作库（复用索引，不再解包）→ 装配 manifest → 摘要 */
  workspaceOpen: 'workspace:open',
  /** 书库：按**目录名**真删磁盘工作库目录（越界防护 + 二次确认在渲染层） */
  workspaceDelete: 'workspace:delete',
  /** 书库：在系统文件管理器中打开工作库文件夹（只读打开，不写盘） */
  workspaceReveal: 'workspace:reveal',
  /**
   * 书库：**format 体检**（只读诊断）。
   *
   * 工作库索引的 format 采用「读时兼容新旧两值、写时升级为新值」。
   * 这个接口直接统计磁盘上每本库的原始 format 串，用来证明：
   * 历史值确实还在盘上、且**全部被接受**（没有被 format 校验挡掉的库）。
   * 不改任何文件，也不做迁移。
   */
  workspaceFormats: 'workspace:formats',
  /** 书库：一键导出 —— 把工作库反向打包成 .t2w（C2；outPath 缺省时弹保存框） */
  workspaceExportT2w: 'workspace:exportT2w',
  /** 阅读原文：按章切段返回当前工作库的全书原文 */
  sourceRead: 'source:read',
  /** 生图：探活 ComfyUI（GET /system_stats） */
  imagegenProbe: 'imagegen:probe',
  /** 生图：**列已安装的出图模型**（ckpt_name 候选，GET /object_info/CheckpointLoaderSimple） */
  imagegenModels: 'imagegen:models',
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
      guards: pkg.guards,
      workspaceDir: dirName
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
    // §5：正则切章完全失败（只切出 1 章）时用 LLM 兜底判断章节结构。
    // 兜底失败一律忽略，不阻断导入。
    const index = await buildTxtWorkspace(filePath, root, {
      chapterFallback: async (text: string) => {
        try {
          const r = await recognizeChaptersByLlm(text)
          return r ? { charStarts: r.charStarts, titles: r.titles } : null
        } catch {
          return null
        }
      }
    })

    // 记入工作库会话后，包内成员即可通过 t2w://<key>/<entryPath> 从工作库 assets/ 常驻访问
    setWorkspaceSession(makeSession(root, index))
    const manifest = await assembleManifest(root, index)
    const summary = buildSummary(manifest, {
      filePath,
      totalSize: index.origin.t2wSize,
      jsonLen: 0,
      blobStart: 0,
      verify: { total: 0, passed: 0, failed: 0 },
      guards: { sumSizeMatches: true, noTrailingBytes: true },
      workspaceDir: dirName
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
    let index = await readIndex(root)
    // 🔧 索引自愈：补齐「分片文件在、index.shards 缺行」的老工作库。
    //
    // 历史 bug：`shards.updateShard` 只写分片文件、不登记索引（已修），
    // 于是修复前跑过解析的库都是「产物在、索引缺行」→ 所有聚合型任务
    // （worldImpression / locationTree / characterAppearance）报「读不到上游产物」。
    // 在开库时自动补登记，老库直接可用，**不需要用户重新解析烧 token**。
    // 失败不阻断开库（只影响聚合任务，且下次开库会再试）。
    try {
      const rep = await repairShardIndex(root)
      if (rep.added > 0) {
        console.log(`[workspace] 索引自愈：补登记 ${rep.added} 个分片（${dirName}）`)
        index = await readIndex(root)
      }
    } catch {
      /* 自愈失败不阻断开库 */
    }
    setWorkspaceSession(makeSession(root, index))
    const manifest = await assembleManifest(root, index)
    const summary = buildSummary(manifest, {
      filePath: index.origin.t2wPath,
      totalSize: index.origin.t2wSize,
      jsonLen: 0,
      blobStart: 0,
      verify: { total: 0, passed: 0, failed: 0 },
      guards: { sumSizeMatches: true, noTrailingBytes: true },
      workspaceDir: dirName
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
        title: kind === 'txt' ? '导入文本文档' : '导入书籍或文本文档',
        properties: ['openFile'],
        filters:
          kind === 'txt'
            ? [
                { name: '文本文档', extensions: ['txt'] },
                { name: '全部文件', extensions: ['*'] }
              ]
            : [
                // 文件对话框里不再出现 t2w 字样；旧 .t2w 包仍可选（放在「全部文件」里，
                // 且 extensions 仍列出 t2w，保证用户手上的旧包照样能导入）
                { name: '书籍', extensions: ['dwe', 't2w'] },
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

  // ===========================================================================
  // 角色卡 + 内置酒馆
  // ===========================================================================
  /** 取当前工作库的 manifest（三个 card 通道共用；无书库时返回可读错误）。 */
  const currentManifest = async (): Promise<
    { ok: true; root: string; assetBase: string; manifest: T2wManifest } | { ok: false; error: string }
  > => {
    const session = getWorkspaceSession()
    if (!session) return { ok: false, error: '尚未导入任何工作库' }
    const index = await readIndex(session.root)
    const manifest = await assembleManifest(session.root, index)
    return { ok: true, root: session.root, assetBase: session.assetBase, manifest }
  }

  ipcMain.handle(IPC.cardList, async (): Promise<CharacterCardListResult> => {
    try {
      const cur = await currentManifest()
      if (!cur.ok) return { ok: false, error: cur.error }
      return listCards(cur.manifest, cur.assetBase)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle(IPC.cardGet, async (_e, cardId: string): Promise<CharacterCardResult> => {
    try {
      const cur = await currentManifest()
      if (!cur.ok) return { ok: false, error: cur.error }
      return await getCard(cur.manifest, cur.assetBase, cur.root, cardId)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle(IPC.cardExport, async (event, req: CardExportRequest): Promise<CardExportResult> => {
    try {
      const cur = await currentManifest()
      if (!cur.ok) return { ok: false, error: cur.error }

      // 目录选择：不传 outDir 时弹框，默认落在「下载」目录下的日期子目录
      let outDir = req.outDir ?? ''
      if (!outDir) {
        const win = BrowserWindow.fromWebContents(event.sender)
        const picked = await dialog.showOpenDialog(win as BrowserWindow, {
          title: '选择角色卡导出目录',
          properties: ['openDirectory', 'createDirectory'],
          defaultPath: join(app.getPath('downloads'), defaultExportDirName(cur.manifest.project?.title ?? ''))
        })
        if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true }
        outDir = picked.filePaths[0]
      }

      return await exportCards(
        cur.manifest,
        cur.assetBase,
        req,
        async (entryPath) => {
          try {
            return await readAsset(cur.root, entryPath)
          } catch {
            return null
          }
        },
        outDir
      )
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle(IPC.tavernGetSettings, async (): Promise<TavernSettings | null> => {
    try {
      const cur = await currentManifest()
      if (!cur.ok) return null
      return await loadTavernSettings(cur.root)
    } catch {
      return null
    }
  })

  ipcMain.handle(IPC.tavernSaveSettings, async (_e, settings: TavernSettings) => {
    try {
      const cur = await currentManifest()
      if (!cur.ok) return { ok: false, error: cur.error }
      return await saveTavernSettings(cur.root, settings)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle(IPC.tavernSaveSession, async (_e, cardId: string, messages: TavernMessage[], params: TavernParams) => {
    try {
      const cur = await currentManifest()
      if (!cur.ok) return { ok: false, error: cur.error }
      return await saveSession(cur.root, cardId, messages, params)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle(IPC.tavernGenerate, async (_e, req: TavernGenerateRequest): Promise<TavernGenerateResult> => {
    try {
      const cur = await currentManifest()
      if (!cur.ok) return { ok: false, error: cur.error }
      // 用当前选中的 LLM 配置（与流水线同一套 provider 设置，不另起一套）
      const provider = await activeProvider('llm')
      return await tavernGenerate(cur.manifest, cur.assetBase, cur.root, req, provider as never)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // ===========================================================================
  // 漫画编排（讲述与配音 / 背景配乐 / 本页音色）
  // ===========================================================================
  ipcMain.handle(
    IPC.mangaProductionPage,
    async (_e, chapterSeq: number, pageNo: number): Promise<ProductionPageResult> => {
      try {
        const cur = await currentManifest()
        if (!cur.ok) return { ok: false, error: cur.error }
        const view = buildMangaView(cur.manifest, cur.assetBase)
        if (!view) return { ok: false, error: EMPTY_MANGA_HINT }
        return await getProductionPage(cur.manifest, view, cur.root, chapterSeq, pageNo)
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
  )

  ipcMain.handle(IPC.mangaProductionSaveVoice, async (_e, input: VoiceEditInput) => {
    try {
      const cur = await currentManifest()
      if (!cur.ok) return { ok: false, error: cur.error }
      return await savePageVoice(cur.root, input)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle(
    IPC.mangaProductionRedub,
    async (_e, chapterSeq: number, pageNo: number, voiceMap: Record<string, string>) => {
      try {
        const cur = await currentManifest()
        if (!cur.ok) return { ok: false, error: cur.error }
        const view = buildMangaView(cur.manifest, cur.assetBase)
        if (!view) return { ok: false, error: EMPTY_MANGA_HINT }
        invalidateDurations()
        return await redubPage(cur.root, view, chapterSeq, pageNo, (cid) => voiceMap?.[cid])
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
  )

  ipcMain.handle(IPC.mangaProductionSaveMusic, async (_e, input: MusicEditInput) => {
    try {
      const cur = await currentManifest()
      if (!cur.ok) return { ok: false, error: cur.error }
      return await saveMusic(cur.root, input)
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
        // 🔴 root 必须按 pkgId（工作库**目录名**）精确定位，不能依赖「当前会话」。
        //
        // 历史 bug：这里只传 pkgId、不传 root，于是 orchestrator.start() 回落到
        // `getWorkspaceSession()?.root` —— 即**主进程当前打开的那本书**。
        // 而任务面板（tasksOverview）按 pkgId 精确读另一本，两者会指向不同工作库：
        //   · 解析产物写进了错误的书（污染用户数据）
        //   · 面板读的是目标书 → 状态永远显示「待跑 / 全 0」
        // 典型症状就是「一个说成功、一个说报错、一个说空的」。
        // 与 tasksOverview / imagegenTargets 的取法保持一致（同一路径规则）。
        const root = pkgId ? join(workspaceRoot(), sanitizeSegment(pkgId)) : undefined
        if (!root) return { ok: false, error: '未指定工作库，无法启动解析' }
        return await pipelineStart(pkgId, { root, range: range ?? 'all', force: force === true })
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
  )

  ipcMain.handle(IPC.pipelineParseStatus, async (_event, runId: string): Promise<ParseStatus> => pipelineParseStatus(runId))

  ipcMain.handle(IPC.pipelineParseCancel, async (_event, runId: string): Promise<{ ok: boolean }> => pipelineCancel(runId))

  /**
   * 取消**所有**运行中的解析（兜底）。
   *
   * 场景：渲染层的「取消」按钮只知道自己记着的 runId。页面刷新、换书、
   * 或从别的入口触发过解析后，那个 run 就失去了取消入口——而此时
   * `actionsDisabled` 会因 `running` 恒为 true 锁死全部按钮，用户看到
   * 「点什么都没反应」，只能重启应用。这个入口让 UI 能一键清场。
   */
  ipcMain.handle(IPC.pipelineParseCancelAll, async (): Promise<{ ok: boolean; cancelled: number }> => {
    try {
      return pipelineCancelAll()
    } catch (e) {
      return { ok: false, cancelled: 0 }
    }
  })

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

  /**
   * 模型探测：两种入参形态
   *   - `{ id }`        已保存的配置；
   *   - `{ baseURL, apiKey }` 表单里还没保存的（填模型之前先看看有哪些可选）。
   */
  ipcMain.handle(
    IPC.opsListModels,
    async (
      _event,
      arg: { id?: string; baseURL?: string; apiKey?: string }
    ): Promise<ModelListResult> => {
      try {
        if (arg?.id) return await listModels(arg.id)
        return await listModelsOf(arg?.baseURL ?? '', arg?.apiKey ?? '')
      } catch (e) {
        return { ok: false, error: `探测失败：${(e as Error).message}` }
      }
    }
  )

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
            title: '导出书籍',
            // 默认扩展名改用自家的 .dwe（不再暴露 t2w 字样）。
            // 导入侧对两种扩展名都接受（.dwe 与历史的 .t2w），旧包不会因此打不开。
            defaultPath: `${bookName.replace(/[\\/:*?"<>|]+/g, '_')}.dwe`,
            filters: [
              { name: '书籍', extensions: ['dwe'] },
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

  // format 体检（只读诊断）：统计磁盘上每本库的原始 format 串，
  // 用来证明「历史值仍在盘上 + 全部被接受」这件事是真的，而不是靠迁移蒙混过去。
  ipcMain.handle(IPC.workspaceFormats, async () => {
    try {
      return await inspectWorkspaceFormats(workspaceRoot())
    } catch (e) {
      return { error: (e as Error).message }
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

  // 列出 ComfyUI 已安装的出图模型（ckpt_name 候选）—— 让用户点选而不是手抄
  ipcMain.handle(IPC.imagegenModels, async (): Promise<{ ok: boolean; models?: string[]; error?: string }> => {
    try {
      const s = await loadSettings()
      return await listImagegenModels(s.comfyui)
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

import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app, BrowserWindow, protocol, shell } from 'electron'
import { registerIpc, registerWindowFullScreenEvents } from './ipc'
import { registerAssetProtocol, ASSET_PRIVILEGE } from './asset-protocol'
import { registerCacheProtocol, CACHE_PRIVILEGE } from './cache-protocol'

const isDev = !!process.env['ELECTRON_RENDERER_URL']

/**
 * 隔离数据目录（**验证脚本 / 调试专用**）。
 *
 * 设了 `FEATHER_USER_DATA` 就把整个应用的数据目录（书库 workspace、settings.json、缓存…）
 * 改到该路径，与用户真实书库（默认 `<项目根>/StageView-data/`，见下方 C3）**彻底分离** ——
 * 跑验证脚本时不再往真实书库写一个文件。
 *
 * 必须早于 `app.whenReady()`、且早于任何 `app.getPath('userData')` 调用。
 * **不设该环境变量时行为与以前完全一致**（默认 userData），日常启动不受影响。
 */
const isolatedUserData = process.env['FEATHER_USER_DATA']
if (isolatedUserData) {
  mkdirSync(isolatedUserData, { recursive: true })
  app.setPath('userData', isolatedUserData)
} else {
  // C3（2026-10-17 用户拍板）：数据目录迁出 C 盘，落到**项目根的 DreamWeave-data/**（数据跟软件走）。
  // app.getAppPath() 在 dev 下 = 项目目录，其上级即仓库根 —— 不写盘符，路径随项目位置自适应。
  // （若将来打包发布，getAppPath 会指向安装目录内的 resources，届时按发布形态微调此处即可。）
  // 旧库里 legacy 目录名保留若干历史别名，逐个探测，确保改名后老数据仍能被接续。
  const legacyCandidates = [join(app.getPath('appData'), 'feather'), join(app.getPath('appData'), 'stageview')]
  const legacyDataRoot = legacyCandidates.find((p) => existsSync(p)) ?? legacyCandidates[0]
  const dataRoot = resolve(app.getAppPath(), '..', 'DreamWeave-data')

  // 旧数据迁移：新根还没有 workspace、而旧根有 → 首次切换，整体复制。
  // 只迁「真数据」三件（书库 / settings.json / tts+bgm 缓存），Electron 自身的缓存不迁；
  // 复制而非移动 —— 旧 C 盘目录原样保留作兜底，用户验证书库正常后再自行处置。
  const legacyWorkspace = join(legacyDataRoot, 'workspace')
  if (!existsSync(join(dataRoot, 'workspace')) && existsSync(legacyWorkspace)) {
    mkdirSync(dataRoot, { recursive: true })
    for (const name of ['workspace', 'settings.json', 'tts']) {
      const from = join(legacyDataRoot, name)
      if (existsSync(from)) cpSync(from, join(dataRoot, name), { recursive: true })
    }
    console.log('[DreamWeave] 已从旧数据目录迁移:', legacyDataRoot, '->', dataRoot)
  }

  mkdirSync(dataRoot, { recursive: true })
  app.setPath('userData', dataRoot)
}

// 自定义协议必须在 app ready 之前登记权限。
// 关键：所有 scheme 用**一次** registerSchemesAsPrivileged 注册 —— 分多次调用时只有最后一次生效，
// 会导致先注册的 scheme 丢掉 supportFetchAPI（renderer 里 fetch() 直接 Failed to fetch）。
protocol.registerSchemesAsPrivileged([ASSET_PRIVILEGE, CACHE_PRIVILEGE])

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'DreamWeave · 织梦',
    backgroundColor: '#ede4d8',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())

  // 系统侧触发的全屏（F11 / 系统菜单）也要让 UI 同步，故按窗口注册推送
  registerWindowFullScreenEvents(win)

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] as string)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerAssetProtocol()
  registerCacheProtocol()
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

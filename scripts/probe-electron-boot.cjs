// 最小 Electron 启动探针：确认 GUI 主进程能否起来
// 用法：node_modules\electron\dist\electron.exe scripts\probe-electron-boot.cjs
const fs = require('node:fs')

const LOG = 'D:/galcomic/recon/electron-boot.log'
const log = (...a) => {
  try {
    fs.appendFileSync(LOG, new Date().toISOString() + ' ' + a.join(' ') + '\n')
  } catch (e) {
    /* ignore */
  }
}

try {
  fs.writeFileSync(LOG, '')
} catch (e) {
  /* ignore */
}

log('script-start')
log('electron =', process.versions.electron)
log('ELECTRON_RUN_AS_NODE =', JSON.stringify(process.env.ELECTRON_RUN_AS_NODE))
log('require(electron) type =', typeof require('electron'))

let app
try {
  const el = require('electron')
  app = el.app
  log('electron exports keys =', Object.keys(el).slice(0, 12).join(','))
  log('app type =', typeof app)
} catch (e) {
  log('require(electron) FAILED:', e.message)
  process.exit(2)
}

if (!app) {
  log('app is undefined -> 说明处于 Node 模式（ELECTRON_RUN_AS_NODE 生效）')
  process.exit(3)
}

app.disableHardwareAcceleration()

app.whenReady().then(() => {
  log('app READY')
  const { BrowserWindow } = require('electron')
  try {
    const win = new BrowserWindow({ show: false, width: 400, height: 300 })
    log('BrowserWindow created')
    win.loadURL('data:text/html,<h1>ok</h1>')
    win.webContents.once('did-finish-load', () => {
      log('did-finish-load OK')
      setTimeout(() => {
        app.quit()
      }, 300)
    })
  } catch (e) {
    log('BrowserWindow FAILED:', e.message)
    app.quit()
  }
})

app.on('window-all-closed', () => {
  log('window-all-closed')
  app.quit()
})

process.on('uncaughtException', (e) => {
  log('uncaughtException:', e && e.stack ? e.stack.slice(0, 500) : String(e))
})

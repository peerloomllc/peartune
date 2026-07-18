// PearTune desktop tray app.
//
// Wraps the PearTune HOST (the always-on daemon) in a menubar/tray app so a
// non-technical user runs it without a terminal. Unlike PearCal's Electron app,
// there is no Bare worklet here - the host is plain Node, so we require it
// directly from vendor/ (staged by scripts/prepack.js) and run it in-process.
//
// The dashboard binds LOOPBACK (127.0.0.1) and opens in this app's own window, so
// there is no password to type - the control plane is only reachable from this
// machine. The P2P host (HyperDHT) runs regardless of that bind, so phones pair
// and stream over the internet exactly as on a server install.

const { app, BrowserWindow, Tray, Menu, shell, dialog, nativeImage } = require('electron')
const path = require('path')

const { PearTuneHost } = require('../../vendor/host/server')
const { startDashboard } = require('../../vendor/host/ui/server')

const PORT = 8741
const BIND = '127.0.0.1'
const DASH_URL = `http://${BIND}:${PORT}`
const BUILD = path.join(__dirname, '..', '..', 'build')

let host = null
let dashboard = null
let win = null
let tray = null
let quitting = false

// One host per data dir / port. A second launch just surfaces the running one.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.whenReady().then(main)
}

async function main () {
  try {
    const dataDir = path.join(app.getPath('userData'), 'data')
    // Default the library to the OS Music folder; the operator can point it
    // anywhere (or at a Jellyfin/Subsonic server) from the dashboard.
    const musicDir = app.getPath('music')
    host = new PearTuneHost({
      dataDir,
      musicDir,
      libraryName: 'My Library',
      subsonic: null,
      log: (msg, data) => console.log(msg, data ? JSON.stringify(data) : '')
    })
    await host.ready()
    dashboard = await startDashboard({ host, bind: BIND, port: PORT, password: '', passwordSource: 'none' })
  } catch (e) {
    dialog.showErrorBox('PearTune could not start', String(e && e.message || e))
    app.quit()
    return
  }

  createTray()
  showWindow()

  // Run at login by default (a host that only runs when you open it is not a host).
  if (!app.isPackaged) return // don't register a login item for the dev tree
  try { app.setLoginItemSettings({ openAtLogin: true }) } catch {}
}

function showWindow () {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return }
  win = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 380,
    title: 'PearTune',
    icon: path.join(BUILD, 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#17140f',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  win.loadURL(DASH_URL)
  // Close to tray, don't quit - the host must keep running.
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide() }
  })
}

function createTray () {
  const img = nativeImage.createFromPath(path.join(BUILD, 'tray-icon.png'))
  tray = new Tray(img)
  tray.setToolTip('PearTune host')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open PearTune', click: showWindow },
    { label: 'Open dashboard in browser', click: () => shell.openExternal(DASH_URL) },
    { type: 'separator' },
    { label: 'Quit PearTune', click: () => { quitting = true; app.quit() } }
  ]))
  tray.on('click', showWindow)
  tray.on('double-click', showWindow)
}

// Keep running when the window is closed (this is a background service).
app.on('window-all-closed', (e) => { /* stay alive in the tray */ })

app.on('before-quit', async (e) => {
  quitting = true
  if (host || dashboard) {
    e.preventDefault()
    try { await dashboard?.close() } catch {}
    try { await host?.close() } catch {}
    host = dashboard = null
    app.quit()
  }
})

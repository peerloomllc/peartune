// PearTune desktop tray app.
//
// Wraps the PearTune HOST (the always-on daemon) in a tray / menu-bar app so a
// non-technical user runs it without a terminal. Like the PearCal and PearCircle
// seeders, it is a BACKGROUND SERVICE you reach through your browser - there is no
// in-app Chromium window. The tray only manages the host's lifecycle (run at login,
// stay alive, quit); "Open dashboard" opens the dashboard in your real browser.
//
// The dashboard binds LOOPBACK (127.0.0.1) with no password (passwordSource
// 'none') - the control plane is only reachable from this machine, so it needs no
// gate. The P2P host (HyperDHT) runs regardless of that bind, so phones pair and
// stream over the internet exactly as on a server install.

const { app, Tray, Menu, shell, dialog, nativeImage } = require('electron')
const path = require('path')

const { PearTuneHost } = require('../../vendor/host/server')
const { startDashboard } = require('../../vendor/host/ui/server')

const PORT = 8741
const BIND = '127.0.0.1'
const DASH_URL = `http://${BIND}:${PORT}`
const BUILD = path.join(__dirname, '..', '..', 'build')

let host = null
let dashboard = null
let tray = null

// One host per data dir / port. A second launch just re-opens the dashboard.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', openDashboard)
  app.whenReady().then(main)
}

async function main () {
  // Tray-only (menu-bar) app: no dock icon on macOS.
  if (process.platform === 'darwin') app.dock?.hide()

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

  // Run at login by default (a host that only runs when you open it is not a host).
  if (app.isPackaged) {
    // --hidden lets us tell a login auto-start from a manual launch (see openedAtLogin).
    try { app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] }) } catch {}
  }

  // On a manual launch, open the dashboard so the user sees something happened; on a
  // login auto-start, stay quiet in the tray.
  if (!openedAtLogin()) openDashboard()
}

// Was this launch the OS auto-starting us at login, rather than the user opening the
// app? macOS reports it directly; on Windows/Linux we pass --hidden in the login-item
// args (and the dev tree, unpackaged, always counts as a manual launch).
function openedAtLogin () {
  try {
    if (process.platform === 'darwin') return app.getLoginItemSettings().wasOpenedAtLogin
    return process.argv.includes('--hidden')
  } catch { return false }
}

function openDashboard () {
  shell.openExternal(DASH_URL)
}

function createTray () {
  const img = nativeImage.createFromPath(path.join(BUILD, 'tray-icon.png'))
  tray = new Tray(img)
  tray.setToolTip('PearTune host')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open dashboard', click: openDashboard },
    { type: 'separator' },
    { label: 'Quit PearTune', click: () => app.quit() }
  ]))
  tray.on('click', openDashboard)
  tray.on('double-click', openDashboard)
}

// No windows, ever: never quit just because a window closed (this is a background
// service). Only an explicit Quit / app.quit() ends it - handled by before-quit.
app.on('window-all-closed', () => { /* stay alive in the tray */ })

app.on('before-quit', async (e) => {
  if (!host && !dashboard) return // already torn down; let the quit proceed
  e.preventDefault()
  const d = dashboard, h = host
  host = dashboard = null
  try { await d?.close() } catch {}
  try { await h?.close() } catch {}
  app.quit()
})

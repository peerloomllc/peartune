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
const net = require('net')
const { installService, uninstallService, SERVICE_PLATFORMS } = require('./service')

const { PearTuneHost } = require('../../vendor/host/server')
const { startDashboard } = require('../../vendor/host/ui/server')
const { createUpdateChecker } = require('../../vendor/host/update-check')
const { UpdateApplier } = require('../../vendor/host/update-apply')

const PORT = 8741
const BIND = '127.0.0.1'
const DASH_URL = `http://${BIND}:${PORT}`
const BUILD = path.join(__dirname, '..', '..', 'build')

const RELEASES_URL = 'https://github.com/peerloomllc/peartune/releases/latest'

let host = null
let dashboard = null
let tray = null
let updateChecker = null
// True when a systemd user service already owns the host and this tray process is
// just a client. See adoptOrStart().
let serviceOwned = false

// Is something already serving the dashboard on this port? A systemd user service
// (installed by the .deb postinst or --install-service) starts at boot, and the
// login item then launches this tray app on top of it.
//
// WITHOUT THIS GUARD THAT IS NOT A COSMETIC CLASH: both processes open the SAME
// data dir, which is the library's identity. The second one currently dies with
// a modal error, which is a poor way to learn that your host was already running.
function dashboardAlreadyServing (port, timeoutMs = 800) {
  return new Promise(resolve => {
    const socket = net.createConnection({ port, host: BIND })
    const done = (v) => { socket.destroy(); resolve(v) }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(timeoutMs, () => done(false))
  })
}

// CLI actions, handled BEFORE anything asks Electron for a window or a tray.
// `--install-service` is often run over ssh or on a box with no session, and
// app.whenReady() needs a display on Linux - so these must never reach it.
if (process.argv.includes('--install-service')) {
  process.exit(installService())
} else if (process.argv.includes('--uninstall-service')) {
  process.exit(uninstallService())
}

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

  // A service already serving means this process is a CLIENT, not a host. Adopting
  // it rather than racing it is what keeps two processes off one data dir.
  if (await dashboardAlreadyServing(PORT)) {
    serviceOwned = true
    console.log('peartune: a host is already serving on', DASH_URL, '- running as a client.')
    createTray()
    if (!openedAtLogin()) openDashboard()
    return
  }

  try {
    // The Windows service reads this SAME directory - it is pointed here at install
    // time rather than given a copy. See installer/windows/installer.nsh for why a
    // copy was abandoned: the store refuses to open from a copied path.
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

    // "A new PearTune is out", notify only. The version MUST be passed in: prepack.js
    // vendors host source without its package.json, so the host cannot find its own
    // version in this layout (see hostVersion() in vendor/host/update-check.js).
    // app.getVersion() is desktop/package.json's, which rides the one release cadence.
    const upd = createUpdateChecker({
      currentVersion: app.getVersion(),
      // The menu is built before the first check answers, so rebuild it when one lands.
      // The checker's own log line is the hook for that - no polling, no timer.
      log: (msg, data) => {
        console.log(msg, data ? JSON.stringify(data) : '')
        if (msg === 'update:available') refreshMenu()
      }
    })
    updateChecker = upd.checker

    // "Update now". onRelaunch is the UNSUPERVISED path - a tray app someone
    // double-clicked, with no systemd unit and no Windows service to bring it
    // back. It is the one case where the process must re-execute a binary that was
    // just overwritten underneath it, so the host and dashboard are closed first
    // (before-quit does that) or the new instance finds 8741 held and the data dir
    // locked. Where a service IS running, none of this fires: the applier hands off
    // to the supervisor instead.
    const applier = updateChecker
      ? new UpdateApplier({
        getUpdate: () => updateChecker.get(),
        onRelaunch: () => { app.relaunch(); app.quit() },
        log: (msg, data) => console.log(msg, data ? JSON.stringify(data) : '')
      })
      : null

    dashboard = await startDashboard({
      host, bind: BIND, port: PORT, password: '', passwordSource: 'none',
      version: app.getVersion(), updateChecker, applier
    })
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
  refreshMenu()
  tray.on('click', openDashboard)
  tray.on('double-click', openDashboard)
}

// Rebuilt, never re-created. A second `new Tray()` leaves the first icon sitting in the
// menu bar forever, so the tray object is made once and only its menu is replaced.
function refreshMenu () {
  if (!tray) return
  // Notify only for now, exactly like the dashboard banner: this opens the releases page
  // in a browser. Applying in place is the intent and the seeder already does it; see
  // vendor/host/update-check.js for what PearTune's packaging needs first.
  const u = updateChecker && updateChecker.get()
  const updateItem = u && u.available && u.latest
    ? [{ label: `PearTune ${u.latest} is available…`, click: () => shell.openExternal(u.htmlUrl || RELEASES_URL) },
        { type: 'separator' }]
    : []
  // Say which process owns the host, because "Quit PearTune" means two different
  // things. Owning it, quitting stops the music; as a client of the service, it
  // only closes this tray icon and the library keeps serving. A user who cannot
  // tell those apart will eventually quit expecting one and get the other.
  const ownership = serviceOwned
    ? [{ label: 'Host: running as a background service', enabled: false },
        { label: 'Stop the background service…', click: () => { uninstallService(); app.quit() } },
        { type: 'separator' }]
    : []

  tray.setContextMenu(Menu.buildFromTemplate([
    ...updateItem,
    { label: 'Open dashboard', click: openDashboard },
    { type: 'separator' },
    ...ownership,
    { label: `PearTune ${app.getVersion()}`, enabled: false },
    { label: serviceOwned ? 'Quit (leaves the host running)' : 'Quit PearTune', click: () => app.quit() }
  ]))
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

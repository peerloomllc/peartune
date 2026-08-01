// Installing the PearTune host as a supervised systemd USER service, from the
// app itself (proposals/2026-07-31-desktop-host-as-a-service.md, slice 1).
//
// The .deb does this in its postinst for the installing user. This module is the
// same thing driven by hand - `peartune-desktop --install-service` - which is how
// an AppImage user gets it, and how a .deb user gets it when the install had no
// SUDO_USER to attribute it to (a GUI software centre, an unattended upgrade).
//
// WHY THIS EXISTS AT ALL: the tray app is a LOGIN ITEM, so the library is offline
// after a reboot or a logout, despite the README calling it an always-on daemon.
// A systemd user unit plus `loginctl enable-linger` fixes that. Linux only -
// macOS was measured and cannot do it without root (a KeepAlive LaunchAgent is
// torn down with its Aqua session), and Windows needs a real service, which is a
// later slice.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const SERVICE_PLATFORMS = ['linux']
const UNIT_NAME = 'peartune-host.service'

function unitDir () { return path.join(os.homedir(), '.config', 'systemd', 'user') }
function unitPath () { return path.join(unitDir(), UNIT_NAME) }

// Where the shipped unit template lives at runtime. electron-builder stages
// linux.extraResources into resources/, next to app.asar.
function templatePath () {
  return path.join(process.resourcesPath || '', 'peartune-host.service')
}

// The command systemd should run, which differs by package format.
//
//   installed (.deb)  the payload sits at a stable path, so name the entry
//                     script directly.
//   AppImage          the payload only exists WHILE THE IMAGE IS MOUNTED, so a
//                     path captured now would be dead by the time systemd used
//                     it. $APPDIR is set by the AppImage's own AppRun on every
//                     launch, so the unit re-derives the path at start time via
//                     `-e`. Both run under ELECTRON_RUN_AS_NODE, which turns the
//                     installed binary into plain Node - no second runtime, no
//                     bundling, and no display needed.
function execLine ({ appImage = process.env.APPIMAGE, execPath = process.execPath, resources = process.resourcesPath } = {}) {
  if (appImage) {
    return `${appImage} -e "require(process.env.APPDIR + '/resources/app.asar/vendor/host/index.js')"`
  }
  return `${execPath} ${path.join(resources || '', 'app.asar', 'vendor', 'host', 'index.js')}`
}

// Substitute the one placeholder. Kept separate and pure so the unit the user
// ends up with is testable without touching systemd.
function renderUnit (template, exec) {
  if (!template.includes('__EXEC__')) throw new Error('unit template has no __EXEC__ placeholder')
  return template.split('__EXEC__').join(exec)
}

function run (argv) {
  return execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function installService ({ log = console.log } = {}) {
  if (!SERVICE_PLATFORMS.includes(process.platform)) {
    log(`PearTune: --install-service is Linux-only for now (this is ${process.platform}).`)
    if (process.platform === 'darwin') {
      log('  macOS cannot run this without root: a LaunchAgent is torn down when you log out,')
      log('  measured 2026-07-31. The tray app remains the supported macOS setup.')
    }
    return 1
  }

  const tpl = templatePath()
  if (!fs.existsSync(tpl)) {
    log(`PearTune: could not find the unit template at ${tpl}.`)
    return 1
  }

  const exec = execLine()
  fs.mkdirSync(unitDir(), { recursive: true })
  fs.writeFileSync(unitPath(), renderUnit(fs.readFileSync(tpl, 'utf8'), exec), { mode: 0o644 })
  log(`PearTune: wrote ${unitPath()}`)

  try {
    run(['systemctl', '--user', 'daemon-reload'])
    run(['systemctl', '--user', 'enable', '--now', UNIT_NAME])
    log('PearTune: host service enabled and started. Dashboard: http://127.0.0.1:8741')
  } catch (e) {
    log(`PearTune: unit written but could not start it: ${e.message}`)
    log(`  Try:  systemctl --user enable --now ${UNIT_NAME}`)
  }

  // LINGER IS THE WHOLE POINT and it is the one step a normal user cannot do
  // alone - it needs root. Without it this is a login item with extra steps: the
  // unit dies at logout and does not come back until the next login. So say so
  // loudly rather than reporting success we have not earned.
  let lingering = false
  try {
    lingering = run(['loginctl', 'show-user', os.userInfo().username, '-p', 'Linger', '--value']).trim() === 'yes'
  } catch {}
  if (lingering) {
    log('PearTune: linger is on - the host will keep running when you log out, and start at boot.')
  } else {
    log('')
    log('  ONE MORE STEP, and without it the host still stops when you log out:')
    log(`    sudo loginctl enable-linger ${os.userInfo().username}`)
  }
  return 0
}

function uninstallService ({ log = console.log } = {}) {
  if (!SERVICE_PLATFORMS.includes(process.platform)) return 1
  try { run(['systemctl', '--user', 'disable', '--now', UNIT_NAME]) } catch {}
  try { fs.unlinkSync(unitPath()) } catch {}
  try { run(['systemctl', '--user', 'daemon-reload']) } catch {}
  log('PearTune: host service removed. Your library data is untouched.')
  log(`  Linger, if you enabled it, is still on: sudo loginctl disable-linger ${os.userInfo().username}`)
  return 0
}

module.exports = { installService, uninstallService, execLine, renderUnit, unitPath, SERVICE_PLATFORMS, UNIT_NAME }

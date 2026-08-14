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

const SERVICE_PLATFORMS = ['linux', 'darwin']
const UNIT_NAME = 'peartune-host.service'

// --- macOS ------------------------------------------------------------------
//
// A SYSTEM LaunchDaemon, not a LaunchAgent. An agent lives in gui/501, a domain
// loginwindow tears down at logout, so KeepAlive cannot save it (measured
// 2026-07-31). Proven 2026-08-08: bootstrapped into the system domain, survived
// a real reboot with nobody logged in, ran as root, read ~/Music with no Full
// Disk Access grant, and announced on the DHT.
const DAEMON_LABEL = 'com.peerloom.peartune'
const DAEMON_PLIST = `/Library/LaunchDaemons/${DAEMON_LABEL}.plist`

// WHOSE HOME IS THE LIBRARY IN? Not root's, even though this runs under sudo.
//
// This is the Windows $APPDATA trap wearing a different hat. There, a perMachine
// install made NSIS resolve $APPDATA to C:\ProgramData instead of the user's
// roaming folder, so the service was pointed at an empty directory, created a
// BRAND NEW EMPTY LIBRARY and served it - healthy, zero tracks, and the real
// library sitting untouched a few directories away. It took a hardware run to
// find. Under sudo, os.homedir() is /var/root and would do exactly the same
// thing here.
//
// SUDO_USER is who actually invoked us, and their home is where the library is.
function realUser () {
  const name = process.env.SUDO_USER || os.userInfo().username
  if (name === 'root') return null
  return name
}

function realHome (user = realUser()) {
  if (!user) return null
  // Ask the directory service rather than assuming /Users/<name>: the two differ
  // for network and mobile accounts, which is precisely the setup where guessing
  // wrong points a daemon at a path that does not exist.
  try {
    const line = run(['dscl', '.', '-read', `/Users/${user}`, 'NFSHomeDirectory']).trim()
    const home = line.replace(/^NFSHomeDirectory:\s*/, '').trim()
    if (home && home !== '/var/empty') return home
  } catch {}
  return path.join('/Users', user)
}

const DAEMON_LOG = '/var/log/peartune-host.log'

// Is this label still known to launchd? `launchctl print` exits non-zero once it is
// genuinely gone, which is the only reliable signal - bootout's own exit code says
// only that the request was accepted.
function daemonLoaded (label) {
  try {
    run(['launchctl', 'print', `system/${label}`])
    return true
  } catch {
    return false
  }
}

// Poll rather than sleep a fixed amount: a daemon holding open sockets can take a
// moment to go, and a fixed sleep is either too short (flaky) or wastes time on every
// ordinary install. execFileSync blocks, so this is a synchronous spin by design -
// installService is a CLI action that exits, not something on a UI thread.
function waitUntilGone (label, tries = 50, everyMs = 100) {
  for (let i = 0; i < tries; i++) {
    if (!daemonLoaded(label)) return true
    try { execFileSync('/bin/sleep', [String(everyMs / 1000)]) } catch {}
  }
  return !daemonLoaded(label)
}

// uid/gid for a macOS account name. dscl rather than /etc/passwd, which does not list
// directory-service accounts at all.
function userIds (user) {
  try {
    const uid = Number(run(['id', '-u', user]).trim())
    const gid = Number(run(['id', '-g', user]).trim())
    if (Number.isFinite(uid) && Number.isFinite(gid)) return { uid, gid }
  } catch {}
  return { uid: null, gid: null }
}

// Hand a tree back to its owner. Returns how many entries actually needed it, so the
// caller can say something true rather than claiming a repair that did nothing.
function chownTree (dir, user) {
  const { uid, gid } = userIds(user)
  if (uid == null) return 0
  let changed = 0
  const walk = (p) => {
    let st
    try { st = fs.lstatSync(p) } catch { return }
    if (st.uid !== uid) {
      try { fs.chownSync(p, uid, gid); changed++ } catch {}
    }
    if (st.isDirectory()) {
      let entries = []
      try { entries = fs.readdirSync(p) } catch { return }
      for (const e of entries) walk(path.join(p, e))
    }
  }
  walk(dir)
  return changed
}

function renderPlist (template, { bin, entry, data, music, user, group = 'staff' }) {
  for (const [k, v] of [
    ['__BIN__', bin], ['__ENTRY__', entry], ['__DATA__', data], ['__MUSIC__', music],
    ['__USER__', user], ['__GROUP__', group]
  ]) {
    if (!template.includes(k)) throw new Error(`plist template has no ${k} placeholder`)
    // An empty value would substitute cleanly and produce a plist that looks fine and
    // runs as the wrong thing - the exact failure mode this whole file is guarding.
    if (!v) throw new Error(`nothing to put in ${k}`)
    template = template.split(k).join(v)
  }
  return template
}

// `resources` and `template` are injectable for the same reason execLine's are: the
// hardware check has to exercise THIS function against the real installed app without
// first shipping a whole new build of it. Defaults are the production values.
function installDaemon ({
  log = console.log,
  execPath = process.execPath,
  resources = process.resourcesPath,
  template = null
} = {}) {
  if (process.getuid && process.getuid() !== 0) {
    log('PearTune: installing the host daemon needs root, because it registers a LaunchDaemon.')
    log(`  Try:  sudo "${process.execPath}" --install-service`)
    return 1
  }

  const user = realUser()
  if (!user) {
    // Refusing beats guessing. With no SUDO_USER we cannot tell whose library this
    // is, and picking wrong means serving an empty one - see the note above.
    log('PearTune: cannot tell which user\'s library to serve (no SUDO_USER).')
    log('  Run this with sudo from your own account rather than as root directly.')
    return 1
  }

  const home = realHome(user)
  const data = path.join(home, 'Library', 'Application Support', 'peartune-desktop', 'data')
  const music = path.join(home, 'Music')
  if (!fs.existsSync(data)) {
    // The tray app creates this on first run. If it is absent we would be
    // registering a daemon that mints a NEW library - the Windows failure exactly.
    log(`PearTune: no library found at ${data}.`)
    log('  Open PearTune normally once first, then install the daemon.')
    return 1
  }

  const tpl = template || path.join(resources || '', `${DAEMON_LABEL}.plist`)
  if (!fs.existsSync(tpl)) {
    log(`PearTune: could not find the daemon template at ${tpl}.`)
    return 1
  }

  const plist = renderPlist(fs.readFileSync(tpl, 'utf8'), {
    bin: execPath,
    entry: path.join(resources || '', 'app.asar', 'vendor', 'host', 'index.js'),
    data,
    music,
    user
  })

  // launchd REFUSES a system plist that is not root-owned and 0644, and the
  // refusal is silent - it simply never loads. Set both rather than inherit.
  fs.writeFileSync(DAEMON_PLIST, plist, { mode: 0o644 })
  try { fs.chownSync(DAEMON_PLIST, 0, 0) } catch {}
  log(`PearTune: wrote ${DAEMON_PLIST}`)
  log(`  serving ${user}'s library at ${data}`)

  // REPAIR ANY ROOT-OWNED FILES LEFT BY AN EARLIER INSTALL. The first cut of this
  // daemon ran as root and left root-owned CURRENT/LOG/MANIFEST inside the user's
  // own store within minutes (caught on hardware 2026-08-08). Now that the daemon
  // runs AS the user, those files would be unwritable by the very process meant to
  // own them - so hand them back rather than leaving a box that upgraded into a
  // half-broken state. Cheap, and a no-op on a machine that never ran the root one.
  const restored = chownTree(data, user)
  if (restored > 0) log(`  handed ${restored} file(s) back to ${user} from an earlier root-owned install`)

  // The daemon writes its log as the user now, so the log file has to be reachable
  // by that user. Left root-owned it simply gets no output, silently.
  try {
    fs.writeFileSync(DAEMON_LOG, '', { flag: 'a' })
    const { uid, gid } = userIds(user)
    if (uid != null) fs.chownSync(DAEMON_LOG, uid, gid)
  } catch {}

  // BOOTOUT RETURNS BEFORE THE JOB IS ACTUALLY GONE, and bootstrapping into a label
  // that is still present fails with the famously unhelpful "Bootstrap failed: 5:
  // Input/output error". Caught on hardware 2026-08-08 reinstalling over the earlier
  // root-running version. So wait for the label to really disappear rather than
  // assuming a successful bootout means unloaded.
  try { run(['launchctl', 'bootout', `system/${DAEMON_LABEL}`]) } catch {}
  if (!waitUntilGone(DAEMON_LABEL)) {
    log(`PearTune: ${DAEMON_LABEL} is still loaded after asking it to stop.`)
    log(`  Try:  sudo launchctl bootout system/${DAEMON_LABEL}`)
    return 1
  }

  try {
    run(['launchctl', 'bootstrap', 'system', DAEMON_PLIST])
    run(['launchctl', 'enable', `system/${DAEMON_LABEL}`])
    log('PearTune: host daemon loaded. Dashboard: http://127.0.0.1:8741')
  } catch (e) {
    log(`PearTune: plist written but launchd refused it: ${e.message}`)
    return 1
  }

  // SAY WHAT THIS DOES NOT DO. "Always-on" is the overclaim desktop/README.md was
  // corrected for in #306, and FileVault is where it stops being true: the machine
  // halts at the pre-boot unlock screen and NOTHING runs until a person unlocks the
  // disk. Measured on the mac-mini, 2026-08-08. Equally true of an encrypted Linux
  // root, which the Linux slice shipped without saying.
  log('')
  log('  The host now keeps running when you log out, and starts at boot.')
  log('  With FileVault on, a reboot still waits for someone to unlock the disk first.')
  return 0
}

function uninstallDaemon ({ log = console.log } = {}) {
  if (process.getuid && process.getuid() !== 0) {
    log(`PearTune: removing the host daemon needs root. Try:  sudo "${process.execPath}" --uninstall-service`)
    return 1
  }
  try { run(['launchctl', 'bootout', `system/${DAEMON_LABEL}`]) } catch {}
  waitUntilGone(DAEMON_LABEL)
  try { fs.unlinkSync(DAEMON_PLIST) } catch {}

  // Leave the library usable by the person going back to the tray app. Rollback is
  // the moment this matters most, and a rollback that hands back a store the user
  // cannot write is worse than no rollback at all.
  const user = realUser()
  if (user) {
    const home = realHome(user)
    const data = path.join(home, 'Library', 'Application Support', 'peartune-desktop', 'data')
    const restored = chownTree(data, user)
    if (restored > 0) log(`PearTune: handed ${restored} file(s) back to ${user}.`)
  }

  log('PearTune: host daemon removed. Your library data is untouched.')
  log('  Open PearTune normally and it goes back to running the host itself.')
  return 0
}

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
  if (process.platform === 'darwin') return installDaemon({ log })
  if (!SERVICE_PLATFORMS.includes(process.platform)) {
    log(`PearTune: --install-service is Linux and macOS only (this is ${process.platform}).`)
    log('  On Windows the installer registers the service for you.')
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
  if (process.platform === 'darwin') return uninstallDaemon({ log })
  if (!SERVICE_PLATFORMS.includes(process.platform)) return 1
  try { run(['systemctl', '--user', 'disable', '--now', UNIT_NAME]) } catch {}
  try { fs.unlinkSync(unitPath()) } catch {}
  try { run(['systemctl', '--user', 'daemon-reload']) } catch {}
  log('PearTune: host service removed. Your library data is untouched.')
  log(`  Linger, if you enabled it, is still on: sudo loginctl disable-linger ${os.userInfo().username}`)
  return 0
}

module.exports = {
  installService,
  uninstallService,
  execLine,
  renderUnit,
  unitPath,
  SERVICE_PLATFORMS,
  UNIT_NAME,
  // macOS
  renderPlist,
  realUser,
  realHome,
  DAEMON_LABEL,
  DAEMON_PLIST,
  installDaemon,
  uninstallDaemon
}

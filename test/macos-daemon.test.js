'use strict'

// The launchd SYSTEM daemon the macOS host installs (slice 2 of
// proposals/2026-08-08-macos-host-as-a-launchdaemon.md).
//
// The plist is the artifact that matters, and the failure that matters is the one both
// sibling platforms already shipped by accident: POINTING THE SERVICE AT THE WRONG DATA
// DIR. Windows did it on 2026-08-01 - a perMachine install made NSIS resolve $APPDATA to
// C:\ProgramData, so the service came up serving a BRAND NEW EMPTY LIBRARY, reported
// itself perfectly healthy, and the real library sat untouched a few directories away.
// It took a hardware run to catch, because everything about it looks like success.
//
// macOS has the same trap in a different hat: this installs under `sudo`, where
// os.homedir() is /var/root. Resolve the home from that and the daemon serves an empty
// library out of root's home while the user's sits there ignored. So the tests below are
// mostly about WHOSE HOME the daemon ends up pointed at.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const svc = require('../desktop/src/main/service')
const TEMPLATE = fs.readFileSync(
  path.join(__dirname, '..', 'desktop', 'installer', 'macos', 'com.peerloom.peartune.plist'), 'utf8')

function render (over = {}) {
  return svc.renderPlist(TEMPLATE, {
    bin: '/Applications/PearTune.app/Contents/MacOS/PearTune',
    entry: '/Applications/PearTune.app/Contents/Resources/app.asar/vendor/host/index.js',
    data: '/Users/tim/Library/Application Support/peartune-desktop/data',
    music: '/Users/tim/Music',
    ...over
  })
}

test('the plist points at the tray app\'s EXISTING data dir', () => {
  const out = render()
  assert.match(out, /<string>\/Users\/tim\/Library\/Application Support\/peartune-desktop\/data<\/string>/)
  // Nothing under root's home, ever. This is the assertion that would have caught the
  // Windows bug had it been written for Windows.
  assert.ok(!/\/var\/root/.test(out), 'must never point at root\'s home')
  assert.ok(!out.includes('__DATA__'), 'no placeholder left behind')
})

test('it is a SYSTEM daemon, run as node, that comes back by itself', () => {
  const out = render()
  // ELECTRON_RUN_AS_NODE is what makes this need no second runtime and no display.
  assert.match(out, /<key>ELECTRON_RUN_AS_NODE<\/key>\s*<string>1<\/string>/)
  // RunAtLoad + KeepAlive are what "starts at boot and stays up" actually means.
  assert.match(out, /<key>RunAtLoad<\/key>\s*<true\/>/)
  assert.match(out, /<key>KeepAlive<\/key>\s*<true\/>/)
  assert.match(out, /<key>Label<\/key>\s*<string>com\.peerloom\.peartune<\/string>/)
})

test('every placeholder is substituted, and a missing one is an error', () => {
  const out = render()
  assert.ok(!/__[A-Z]+__/.test(out), `unsubstituted placeholder in:\n${out.match(/__[A-Z]+__/g)}`)
  assert.throws(() => svc.renderPlist('<plist>no placeholders</plist>', {
    bin: 'a', entry: 'b', data: 'c', music: 'd'
  }), /placeholder/)
})

test('the daemon plist goes in the SYSTEM LaunchDaemons directory', () => {
  // NOT ~/Library/LaunchAgents. An agent loads into gui/501, which loginwindow tears
  // down at logout - measured 2026-07-31 with a heartbeat agent that was killed at
  // logout and came back as a different pid at login. Putting this in the wrong
  // directory would produce something that looks identical and does not survive.
  assert.strictEqual(svc.DAEMON_PLIST, '/Library/LaunchDaemons/com.peerloom.peartune.plist')
})

test('realUser prefers SUDO_USER over whoever the process is', () => {
  const prev = process.env.SUDO_USER
  try {
    process.env.SUDO_USER = 'tim'
    assert.strictEqual(svc.realUser(), 'tim')
  } finally {
    if (prev === undefined) delete process.env.SUDO_USER
    else process.env.SUDO_USER = prev
  }
})

test('realUser REFUSES rather than guessing when there is no SUDO_USER', () => {
  // Returning something plausible here is how the Windows bug happened. With no way to
  // tell whose library it is, the install must stop and say so - an empty library served
  // confidently is worse than a refusal, because it looks like it worked.
  const prevSudo = process.env.SUDO_USER
  try {
    delete process.env.SUDO_USER
    const u = svc.realUser()
    // Under a normal test run this is the developer's account, which is fine and correct.
    // What must never happen is 'root' coming back as a usable answer.
    assert.notStrictEqual(u, 'root')
    if (process.getuid && process.getuid() === 0) assert.strictEqual(u, null)
  } finally {
    if (prevSudo !== undefined) process.env.SUDO_USER = prevSudo
  }
})

test('macOS is now a supported service platform', () => {
  assert.ok(svc.SERVICE_PLATFORMS.includes('darwin'))
  assert.ok(svc.SERVICE_PLATFORMS.includes('linux'))
})

test('the plist says out loud what FileVault does to "always-on"', () => {
  // Measured on the mac-mini 2026-08-08: with FileVault on, a reboot halts at the
  // pre-boot unlock and NOTHING runs until a person unlocks the disk. desktop/README.md
  // was already corrected once (#306) for calling a login item an always-on daemon;
  // shipping the same overclaim in a new file would be that mistake repeated.
  assert.match(TEMPLATE, /reboot with NOBODY logged in/i)
})

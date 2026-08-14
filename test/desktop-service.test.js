'use strict'

// The systemd user unit the desktop host installs (slice 1 of
// proposals/2026-07-31-desktop-host-as-a-service.md).
//
// The unit is the artifact that matters here, so these tests are about the two
// things that would be silently catastrophic in it:
//
//   1. THE DATA DIR. host.seed under ~/.config/peartune-desktop/data is the
//      library's identity - the key every paired phone knows it by, which nothing
//      regenerates. A unit that points anywhere else comes up as a BRAND NEW
//      library, and every paired phone stops recognising it. That failure looks
//      like "the service works!" right up until someone tries to play something.
//
//   2. THE APPIMAGE EXEC LINE. An AppImage's payload only exists while the image
//      is mounted, so a path captured at install time is dead by the time systemd
//      uses it. The unit must re-derive it at start.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const svc = require('../desktop/src/main/service')
const TEMPLATE = fs.readFileSync(
  path.join(__dirname, '..', 'desktop', 'installer', 'linux', 'peartune-host.service'), 'utf8')

test('the unit points at the tray app\'s EXISTING data dir, not a new one', () => {
  // The whole reason this is a test and not a comment. ~/.config/peartune-desktop
  // is Electron's userData for this app (package.json name), and the tray app
  // already uses <userData>/data - verified against a real install carrying
  // host.seed. %h is systemd's home specifier.
  assert.match(TEMPLATE, /Environment=PEARTUNE_DATA=%h\/\.config\/peartune-desktop\/data/,
    'a different data dir means a new host key and every paired phone stops recognising the library')
  assert.match(TEMPLATE, /Environment=PEARTUNE_MUSIC=%h\/Music/)
})

test('the unit is supervised and survives more than a login', () => {
  assert.match(TEMPLATE, /Restart=always/, 'a host that does not come back is not a service')
  assert.match(TEMPLATE, /ELECTRON_RUN_AS_NODE=1/,
    'the host runs as plain Node off the installed binary - no second runtime, and no display needed')
  assert.match(TEMPLATE, /WantedBy=default\.target/)
})

test('the AppImage exec line re-derives its payload path at START, not install time', () => {
  // An AppImage is mounted per-launch. Bake in the mount path at install time and
  // the unit points at a directory that no longer exists on the next boot.
  const line = svc.execLine({ appImage: '/home/someone/Apps/PearTune.AppImage' })
  assert.match(line, /^\/home\/someone\/Apps\/PearTune\.AppImage /)
  assert.match(line, /process\.env\.APPDIR/,
    'must resolve $APPDIR at run time, since the mount path changes every launch')
  assert.ok(!line.includes('/tmp/.mount'), 'a captured mount path would be dead by the next boot')
})

test('the installed (.deb) exec line names the entry script directly', () => {
  const line = svc.execLine({ appImage: '', execPath: '/opt/PearTune/peartune-desktop', resources: '/opt/PearTune/resources' })
  assert.equal(line, '/opt/PearTune/peartune-desktop /opt/PearTune/resources/app.asar/vendor/host/index.js')
})

test('rendering substitutes the placeholder, and refuses a template without one', () => {
  const out = svc.renderUnit(TEMPLATE, '/opt/PearTune/peartune-desktop /entry.js')
  assert.ok(!out.includes('__EXEC__'), 'an unsubstituted placeholder is a unit systemd cannot start')
  assert.match(out, /ExecStart=\/opt\/PearTune\/peartune-desktop \/entry\.js/)
  assert.throws(() => svc.renderUnit('[Service]\nExecStart=/bin/true\n', '/x'), /__EXEC__/)
})

test('the deb maintainer scripts leave the library alone, and survive an upgrade', () => {
  const postrm = fs.readFileSync(
    path.join(__dirname, '..', 'desktop', 'installer', 'linux', 'postrm.sh'), 'utf8')
  // Tearing linger down on `upgrade` would silently demote every routine upgrade
  // back to a login item, because dpkg re-runs postinst immediately after.
  assert.match(postrm, /upgrade\|failed-upgrade[^)]*\)\s*exit 0/,
    'an upgrade must not remove the service dpkg is about to reinstall')
  // Removing the package must never cost someone their library.
  assert.ok(!/rm -rf.*peartune-desktop\/data/.test(postrm), 'postrm must never delete the data dir')

  const postinst = fs.readFileSync(
    path.join(__dirname, '..', 'desktop', 'installer', 'linux', 'postinst.sh'), 'utf8')
  assert.match(postinst, /loginctl enable-linger/,
    'without linger this is a login item with extra steps')
  assert.match(postinst, /exit 0/, 'service setup must never fail the package install')
})

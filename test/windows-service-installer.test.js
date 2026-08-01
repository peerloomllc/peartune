'use strict'

// The NSIS fragment that registers the Windows service. It cannot be executed on
// Linux, so what is tested here is the handful of things that would be silently
// wrong in it - each one produces an installer that "succeeds" and leaves the user
// worse off than before.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const NSH = fs.readFileSync(
  path.join(__dirname, '..', 'desktop', 'installer', 'windows', 'installer.nsh'), 'utf8')
const PKG = require('../desktop/package.json')

test('the service runs the Electron binary AS NODE', () => {
  // Without ELECTRON_RUN_AS_NODE, Windows launches a GUI app as a service, in
  // session 0 where it can never draw anything, and it does nothing useful. The
  // service would look "running" and serve nothing.
  assert.match(NSH, /AppEnvironmentExtra[^\n]*ELECTRON_RUN_AS_NODE=1/,
    'the service must run the binary in Node mode or it is a GUI app in session 0')
})

test('data and music are passed as ENV, because LocalSystem has no user profile', () => {
  // %USERPROFILE% inside a LocalSystem service is the SYSTEM profile, not the
  // person's - so a host relying on it looks for music in the wrong place and
  // opens the wrong data dir.
  assert.match(NSH, /PEARTUNE_DATA=\$1\\PearTune\\data/)
  assert.match(NSH, /PEARTUNE_MUSIC=\$MUSIC/)

  // ProgramData MUST be expanded at RUN time. NSIS's $%VAR% form is expanded at
  // COMPILE time, so it would bake in the build machine's environment - which on
  // our Linux cross-build is empty. That is not a subtle failure in the build (the
  // compiler rejects it), but it would be a silent one if the build ever ran on
  // Windows: the service would get a wrong or blank data path.
  assert.match(NSH, /ExpandEnvStrings \$1 "%ProgramData%"/,
    'ProgramData must be resolved on the target machine, not at build time')
  assert.ok(!/\$%ProgramData%/.test(NSH), 'the compile-time form must not come back')
})

test('the library is MIGRATED BEFORE the service is ever registered', () => {
  const migrate = NSH.indexOf('migrate-data.js')
  const install = NSH.indexOf('nssm.exe" install')
  assert.ok(migrate > 0 && install > 0, 'both steps must exist')
  assert.ok(migrate < install,
    'a service registered before the migration would start against an empty dir and become a NEW library')
})

test('a migration that does not verify ABORTS the service setup', () => {
  // The whole point of migrate-data.js exiting non-zero. Registering a service
  // against a half-migrated directory is exactly how a library gets orphaned.
  assert.match(NSH, /\$\{If\} \$0 != 0/, 'the migration exit code must be checked')
  assert.match(NSH, /Goto skip_service/, 'a failed verify must skip service registration')
})

test('UNINSTALL NEVER DELETES THE LIBRARY', () => {
  // host.seed is the identity every paired phone knows; store/ is the grant list.
  // Uninstalling PearTune must not cost someone their library and all their
  // pairings, so the uninstall macro stops the service and stops there.
  const un = NSH.slice(NSH.indexOf('!macro customUnInstall'))
  assert.match(un, /remove \$\{SVC_NAME\} confirm/, 'the service itself must go')

  // Check STATEMENTS, not prose. The first version of this test matched the comment
  // that says the library is never deleted, which is the funniest possible way for a
  // safety test to pass or fail for the wrong reason - so strip `;` comments and
  // DetailPrint strings before looking for a real RMDir/Delete.
  const statements = un.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith(';'))
    .filter(l => !/^DetailPrint\b/i.test(l))
    .join('\n')
  assert.ok(!/^\s*(RMDir|Delete)\b/im.test(statements),
    'the uninstaller must never remove the data directory')
})

test('the build config actually ships what the installer calls, and elevates', () => {
  const shipped = (PKG.build.win.extraResources || []).map(r => r.to)
  assert.ok(shipped.includes('nssm.exe'), 'nssm.exe must be packaged or the install silently does nothing')
  assert.ok(shipped.includes('migrate-data.js'), 'the migrator must be packaged')
  assert.equal(PKG.build.nsis.include, 'installer/windows/installer.nsh')
  // perMachine is not a preference: a service cannot be registered from a per-user
  // install. It also means the Windows install is now elevated, which is why the
  // update-apply proposal needed amending.
  assert.equal(PKG.build.nsis.perMachine, true, 'registering a service requires an elevated, per-machine install')
})

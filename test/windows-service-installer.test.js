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
  assert.match(NSH, /PEARTUNE_DATA=\$2/, 'the library path must be handed to the service explicitly')
  assert.match(NSH, /PEARTUNE_MUSIC=\$5/, 'the music path must be handed over explicitly too')

  // ProgramData still carries the service LOG, and MUST be expanded at RUN time.
  // NSIS's $%VAR% form is expanded at COMPILE time, so it would bake in the build
  // machine's environment - which on our Linux cross-build is empty. That is not a
  // subtle failure in the build (the compiler rejects it), but it would be a silent
  // one if the build ever ran on Windows.
  assert.match(NSH, /ExpandEnvStrings \$1 "%ProgramData%"/,
    'ProgramData must be resolved on the target machine, not at build time')
  // Statements only. A comment DESCRIBING the old bug is not the old bug - the
  // first version of this failed on exactly that, same trap as the RMDir check.
  const stmts = NSH.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith(';'))
  for (const l of stmts) {
    assert.ok(!/\$%ProgramData%/.test(l), `the compile-time form must not come back:\n    ${l}`)
  }
})

test('every PearTune.exe invocation that runs a .js sets ELECTRON_RUN_AS_NODE', () => {
  // THE BUG THIS EXISTS FOR, found by a real silent install on Windows (2026-08-01):
  // `PearTune.exe migrate-data.js` without ELECTRON_RUN_AS_NODE does not run a script.
  // It LAUNCHES THE TRAY APP with an argument it ignores, and nsExec waits for that
  // app to exit. A tray app never exits, so the installer hangs forever - no
  // migration, no service, and no error, because it hung rather than failed. /S made
  // it invisible. The service's own env was set correctly; this one call was missed.
  const lines = NSH.split('\n').filter(l => !l.trim().startsWith(';'))
  const runsScript = lines.filter(l => /PearTune\.exe"?\s+"?\$INSTDIR[^']*\.js/.test(l) && !/AppParameters/.test(l))
  for (const l of runsScript) {
    assert.match(l, /ELECTRON_RUN_AS_NODE=1/,
      `this launches the GUI app and hangs the installer forever:\n    ${l.trim()}`)
  }
})

test('dialogs have a silent-mode default, or /S hangs on them', () => {
  // Same failure shape as the bug above: something waiting for a human on a machine
  // where, by definition, nobody is looking.
  for (const l of NSH.split('\n').filter(l => /^\s*MessageBox\b/.test(l))) {
    assert.match(l, /\/SD\s+ID\w+/, `MessageBox without /SD hangs a silent install:\n    ${l.trim()}`)
  }
})

test('the service is POINTED at the existing library, never given a copy', () => {
  // Copying was built, byte-verified, and did not work - found by installing it on
  // real Windows (2026-08-01). hypercore-storage stamps store\CORESTORE via the
  // `device-file` package, which records the file's INODE and re-checks it on open;
  // any copy changes the inode, so a digest-perfect copy still refuses to open with
  // `fatal: Invalid device file, was modified`. The guard is deliberate.
  //
  // THE LESSON THIS TEST PINS DOWN: verifying by digest proves the BYTES arrived,
  // not that the STORE OPENS. So the installer must not copy the store at all.
  assert.match(NSH, /ExpandEnvStrings \$3 "%APPDATA%"/,
    'the roaming folder must come from the ENVIRONMENT at run time')
  assert.match(NSH, /StrCpy \$2 "\$3\\peartune-desktop\\data"/,
    'the service must use the tray app\'s existing library directory')
  assert.match(NSH, /PEARTUNE_DATA=\$2/)

  // NSIS's own $APPDATA IS NOT THE USER'S ROAMING FOLDER under a perMachine
  // install: electron-builder sets SetShellVarContext all, so it resolves to
  // C:\ProgramData. Using it pointed the service at C:\ProgramData\peartune-desktop
  // \data, where it created a BRAND NEW EMPTY LIBRARY and served it - running,
  // healthy, zero tracks, real library untouched elsewhere. Found on hardware
  // 2026-08-01. Nothing looked wrong; the screen just showed an empty library.
  const statements = NSH.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith(';'))
  for (const l of statements) {
    // $APPDATA -> C:\ProgramData and $MUSIC -> C:\Users\Public\Music under a
    // perMachine install. Both shipped wrong once. Neither may come back.
    assert.ok(!/\$APPDATA\b/.test(l),
      `bare $APPDATA means C:\\ProgramData in a perMachine install:\n    ${l}`)
    assert.ok(!/\$MUSIC\b/.test(l),
      `bare $MUSIC means C:\\Users\\Public\\Music in a perMachine install:\n    ${l}`)
    assert.ok(!/\b(CopyFiles|migrate-data)\b/i.test(l),
      `the installer must never copy the library:\n    ${l}`)
  }
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
  assert.equal(PKG.build.nsis.include, 'installer/windows/installer.nsh')
  // perMachine is not a preference: a service cannot be registered from a per-user
  // install. It also means the Windows install is now elevated, which is why the
  // update-apply proposal needed amending.
  assert.equal(PKG.build.nsis.perMachine, true, 'registering a service requires an elevated, per-machine install')
})

'use strict'

// Which directory holds this machine's library?
//
// It was one answer until the Windows service arrived, and is now two, which is
// exactly the kind of split that goes wrong quietly. The library lives in ONE of:
//
//   per-user     Electron's userData\data  -  what the tray app has always used,
//                                             and still uses on macOS and Linux
//   machine-wide C:\ProgramData\PearTune\data - Windows only, where a LocalSystem
//                                             service can actually read it
//
// THE BUG THIS EXISTS TO PREVENT: after the installer migrates a library to
// ProgramData, the old copy is deliberately left behind as a fallback (see
// installer/windows/migrate-data.js - it never deletes the source). If the tray
// app kept resolving to userData it would open that STALE copy and show a grant
// list that is months out of date - devices the operator revoked would appear
// live, and revoking again would write to a directory nothing is serving from.
// Nothing would error. The screen would simply be lying, which this project has
// already been bitten by twice (#268, #271).
//
// So the rule is: on Windows, a machine-wide library WINS whenever one exists.
// It only exists because an installer put it there, and an installer only does
// that when it is setting up the service that owns it.

const fs = require('fs')
const path = require('path')

const SEED = 'host.seed'

function machineWideDir (env = process.env) {
  return path.join(env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData', 'PearTune', 'data')
}

// `userDataDir` is Electron's app.getPath('userData'), passed in rather than
// required, so this module stays testable without an Electron runtime.
function resolveDataDir ({ userDataDir, platform = process.platform, env = process.env, exists = (p) => fs.existsSync(p) } = {}) {
  const perUser = path.join(userDataDir, 'data')
  if (platform !== 'win32') return { dir: perUser, scope: 'per-user' }

  const shared = machineWideDir(env)
  // A seed, not merely a directory. An empty ProgramData\PearTune\data left by a
  // failed or half-finished install must NOT win - pointing at it would come up
  // as a brand-new library while the real one sat untouched next door.
  if (exists(path.join(shared, SEED))) return { dir: shared, scope: 'machine-wide' }
  return { dir: perUser, scope: 'per-user' }
}

module.exports = { resolveDataDir, machineWideDir, SEED }

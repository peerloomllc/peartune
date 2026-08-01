'use strict'

// Which directory holds the library, once Windows has two candidate locations.
//
// THE BUG THIS GUARDS is a screen that lies rather than a crash. The Windows
// installer migrates the library to ProgramData and DELIBERATELY leaves the old
// %APPDATA% copy behind as a fallback (migrate-data.js never deletes the source).
// If the tray app kept resolving to userData it would open that stale copy and
// show a months-old grant list: devices the operator revoked would appear live,
// and revoking again would write to a directory nothing is serving from. Nothing
// errors. This project has been bitten twice by the screen lying about state
// (#268, #271), so the resolution rule gets a test.

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

const { resolveDataDir, machineWideDir } = require('../desktop/src/main/datadir')

const WIN_ENV = { ProgramData: 'C:\\ProgramData' }
const USER_DATA = 'C:\\Users\\Ben\\AppData\\Roaming\\peartune-desktop'

test('on Windows a machine-wide library WINS over the stale per-user copy', () => {
  const r = resolveDataDir({
    userDataDir: USER_DATA,
    platform: 'win32',
    env: WIN_ENV,
    exists: (p) => p === path.join(machineWideDir(WIN_ENV), 'host.seed')
  })
  assert.equal(r.scope, 'machine-wide')
  assert.equal(r.dir, path.join('C:\\ProgramData', 'PearTune', 'data'))
})

test('on Windows with no migration yet, the per-user library is used', () => {
  const r = resolveDataDir({ userDataDir: USER_DATA, platform: 'win32', env: WIN_ENV, exists: () => false })
  assert.equal(r.scope, 'per-user')
  assert.equal(r.dir, path.join(USER_DATA, 'data'))
})

test('an EMPTY ProgramData dir must not win - it would come up as a new library', () => {
  // A failed or half-finished install can leave the directory without a seed.
  // Preferring it would start a brand-new library while the real one sat untouched
  // next door, which is the silent-identity-loss failure all over again. The check
  // is for host.seed specifically, not for the directory.
  const r = resolveDataDir({
    userDataDir: USER_DATA,
    platform: 'win32',
    env: WIN_ENV,
    exists: (p) => p === machineWideDir(WIN_ENV) // the dir, but no seed in it
  })
  assert.equal(r.scope, 'per-user')
})

test('macOS and Linux are untouched by any of this', () => {
  for (const platform of ['darwin', 'linux']) {
    const r = resolveDataDir({ userDataDir: '/home/tim/.config/peartune-desktop', platform, exists: () => true })
    assert.equal(r.scope, 'per-user', `${platform} must keep using userData`)
    assert.equal(r.dir, path.join('/home/tim/.config/peartune-desktop', 'data'))
  }
})

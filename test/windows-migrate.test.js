'use strict'

// Moving a Windows library from %APPDATA% to ProgramData so a LocalSystem service
// can read it (slice 3 of proposals/2026-07-31-desktop-host-as-a-service.md).
//
// This is the most dangerous code in that slice, and the danger is entirely silent:
// host.seed is the library's identity and store/ is the grant list, nothing
// regenerates either, and a service started against an empty destination comes up
// looking perfectly healthy AS A DIFFERENT LIBRARY. Every paired phone just stops
// recognising it, with no error anywhere.
//
// So these tests are about the failure modes, not the happy path.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { migrate, verifyTree, SEED } = require('../desktop/installer/windows/migrate-data')

const quiet = () => {}

function makeLibrary (extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-lib-'))
  fs.writeFileSync(path.join(dir, SEED), 'THE-IDENTITY-KEY')
  fs.mkdirSync(path.join(dir, 'store'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'store', 'grants.db'), 'who may connect')
  for (const [rel, body] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), body)
  }
  return dir
}
const emptyDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pt-dest-'))

test('a real library is copied and VERIFIED, identity intact', () => {
  const from = makeLibrary({ 'store/nested/deep.dat': 'nested payload' })
  const to = path.join(emptyDir(), 'data')
  const r = migrate({ from, to, log: quiet })
  assert.equal(r.status, 'migrated')
  assert.equal(fs.readFileSync(path.join(to, SEED), 'utf8'), 'THE-IDENTITY-KEY')
  assert.equal(fs.readFileSync(path.join(to, 'store', 'nested', 'deep.dat'), 'utf8'), 'nested payload',
    'nested files must come too - the grant store is not flat')
})

test('THE SOURCE IS NEVER DELETED, so there is always a way back', () => {
  const from = makeLibrary()
  const to = path.join(emptyDir(), 'data')
  migrate({ from, to, log: quiet })
  assert.ok(fs.existsSync(path.join(from, SEED)),
    'the original library must survive the migration - it is the only fallback')
})

test('a destination that already has a library is LEFT ALONE', () => {
  // The installer runs this on every upgrade. Re-copying would roll the service's
  // live grant store back to whatever the stale %APPDATA% copy holds, silently
  // un-revoking devices someone had revoked.
  const from = makeLibrary()
  const to = makeLibrary()
  fs.writeFileSync(path.join(to, 'store', 'grants.db'), 'NEWER - written by the service')
  const r = migrate({ from, to, log: quiet })
  assert.equal(r.status, 'already-migrated')
  assert.equal(fs.readFileSync(path.join(to, 'store', 'grants.db'), 'utf8'), 'NEWER - written by the service')
})

test('a fresh install with no old library is a no-op, not an error', () => {
  const r = migrate({ from: path.join(emptyDir(), 'nope'), to: path.join(emptyDir(), 'data'), log: quiet })
  assert.equal(r.status, 'nothing-to-do')
})

test('a CORRUPTED copy is caught and refuses, rather than reporting success', () => {
  // The failure this whole module exists for. Verification is per-file by digest,
  // because "the copy call did not throw" is not the claim that matters.
  const from = makeLibrary()
  const to = path.join(emptyDir(), 'data')
  migrate({ from, to, log: quiet })
  fs.writeFileSync(path.join(to, SEED), 'WRONG KEY')
  const v = verifyTree(from, to)
  assert.equal(v.ok, false)
  assert.deepEqual(v.corrupt, [SEED])
})

test('a MISSING file is caught too', () => {
  const from = makeLibrary()
  const to = path.join(emptyDir(), 'data')
  migrate({ from, to, log: quiet })
  fs.unlinkSync(path.join(to, 'store', 'grants.db'))
  const v = verifyTree(from, to)
  assert.equal(v.ok, false)
  assert.deepEqual(v.missing, [path.join('store', 'grants.db')])
})

test('a failed verify reports non-ok WITHOUT having touched the original', () => {
  const from = makeLibrary()
  const to = path.join(emptyDir(), 'data')
  // Destination path exists as a FILE, so the copy cannot succeed.
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.writeFileSync(to, 'in the way')
  assert.throws(() => migrate({ from, to, log: quiet }))
  assert.ok(fs.existsSync(path.join(from, SEED)), 'the original must survive a failed migration')
})

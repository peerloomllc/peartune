// Where the music comes from - chosen by the OPERATOR, not by an env var.
//
// This exists for one scenario: somebody installs PearTune from an app store, opens
// it, and is never going to hand-edit a docker-compose file. Without a dashboard
// choice they land on the folder adapter, which has no tag reading, and get a
// library of FILENAMES. Everything good about this app lives on the other side of
// that choice, so the choice has to be data.

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')

const { resolveSource, saveSource, loadSource, publicView } = require('../host/source')

async function dir (t) {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'pt-src-'))
  t.after(() => fsp.rm(d, { recursive: true, force: true }))
  return d
}

test('with nothing configured, the source is the folder - honestly, not silently', async (t) => {
  const d = await dir(t)
  const src = resolveSource({ dataDir: d, navidrome: null, musicDir: '/music' })
  assert.equal(src.kind, 'folder')
  assert.equal(src.from, 'default')
})

test('env / CLI still works - every existing deployment depends on it', async (t) => {
  const d = await dir(t)
  const src = resolveSource({
    dataDir: d,
    navidrome: { url: 'http://localhost:4533', username: 'umbrel', password: 'pw' },
    musicDir: '/music'
  })
  assert.equal(src.kind, 'navidrome')
  assert.equal(src.from, 'env')
})

test("THE OPERATOR'S CHOICE BEATS THE CONTAINER'S", async (t) => {
  const d = await dir(t)
  saveSource(d, { kind: 'navidrome', url: 'http://nas:4533', username: 'tim', password: 'chosen' })

  // The container was started pointing somewhere else entirely. The dashboard choice
  // wins - otherwise the operator's setting would silently evaporate on every
  // restart, which is the sort of bug that takes a week to believe.
  const src = resolveSource({
    dataDir: d,
    navidrome: { url: 'http://localhost:4533', username: 'env', password: 'env' },
    musicDir: '/music'
  })
  assert.equal(src.url, 'http://nas:4533')
  assert.equal(src.username, 'tim')
  assert.equal(src.from, 'dashboard')
})

test('a saved source survives a restart', async (t) => {
  const d = await dir(t)
  saveSource(d, { kind: 'folder', root: '/mnt/music' })
  assert.deepEqual(loadSource(d), { kind: 'folder', root: '/mnt/music' })
})

test('the source file is 0600 - it holds a password', async (t) => {
  const d = await dir(t)
  saveSource(d, { kind: 'navidrome', url: 'u', username: 'n', password: 'secret' })
  const mode = fs.statSync(path.join(d, 'source.json')).mode & 0o777
  assert.equal(mode, 0o600, 'a credential must not be more readable than the identity key beside it')
})

test('THE PASSWORD NEVER LEAVES THE HOST', () => {
  const view = publicView({
    kind: 'navidrome',
    url: 'http://localhost:4533',
    username: 'umbrel',
    password: 'hunter2'
  })

  // A dashboard session is a licence to CHANGE the source, not to read back the
  // credentials of the machine it runs on.
  assert.equal(view.hasPassword, true)
  assert.equal(view.password, undefined)
  assert.ok(!JSON.stringify(view).includes('hunter2'))
})

test('garbage in source.json is ignored, not fatal', async (t) => {
  const d = await dir(t)
  fs.writeFileSync(path.join(d, 'source.json'), '{ this is not json')
  assert.equal(loadSource(d), null)

  // ...and the host still comes up on the folder rather than refusing to start,
  // because a corrupt preferences file is not a reason to lose access to the
  // dashboard that would fix it.
  const src = resolveSource({ dataDir: d, navidrome: null, musicDir: '/music' })
  assert.equal(src.kind, 'folder')
})

test('an unknown kind is ignored (a future version wrote this file)', async (t) => {
  const d = await dir(t)
  fs.writeFileSync(path.join(d, 'source.json'), JSON.stringify({ kind: 'jellyfin', url: 'x' }))
  assert.equal(loadSource(d), null)
})

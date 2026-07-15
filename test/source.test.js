// Where the music comes from - chosen by the OPERATOR, not by an env var.
//
// This exists for one scenario: somebody installs PearTune from an app store, opens
// it, and is never going to hand-edit a docker-compose file. Without a dashboard
// choice they land on the folder adapter. Everything good about this app lives on the
// other side of that choice, so the choice has to be data.
//
// ONE CONFIG PER KIND. The first cut stored a single flat config, so switching
// Navidrome -> Folder -> Navidrome threw the Navidrome credentials away and you
// retyped them. These tests pin that it no longer does.

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')

const { SourceStore, migrate, KINDS } = require('../host/source')

async function dir (t) {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'pt-src-'))
  t.after(() => fsp.rm(d, { recursive: true, force: true }))
  return d
}

const store = (d, env = null) => new SourceStore({ dataDir: d, env, musicDir: '/music' })

test('with nothing configured, the source is the folder - honestly, not silently', async (t) => {
  const s = store(await dir(t))
  assert.equal(s.active().kind, 'folder')
  assert.equal(s.active().from, 'default')
})

test('env / CLI still works - every existing deployment depends on it', async (t) => {
  const s = store(await dir(t), { navidrome: { url: 'http://localhost:4533', username: 'umbrel', password: 'pw' } })
  const a = s.active()
  assert.equal(a.kind, 'navidrome')
  assert.equal(a.from, 'env')
  assert.equal(a.url, 'http://localhost:4533')
})

test("THE OPERATOR'S CHOICE BEATS THE CONTAINER'S", async (t) => {
  const d = await dir(t)
  store(d).save({ kind: 'navidrome', url: 'http://nas:4533', username: 'tim', password: 'chosen' })

  // The container was started pointing somewhere else entirely. The dashboard choice
  // wins - otherwise the operator's setting would silently evaporate on every
  // restart, which is the sort of bug that takes a week to believe.
  const a = store(d, { navidrome: { url: 'http://localhost:4533', username: 'env', password: 'env' } }).active()
  assert.equal(a.url, 'http://nas:4533')
  assert.equal(a.username, 'tim')
  assert.equal(a.from, 'dashboard')
})

test('a saved source survives a restart', async (t) => {
  const d = await dir(t)
  store(d).save({ kind: 'folder', root: '/mnt/music' })
  assert.equal(store(d).active().root, '/mnt/music')
})

// THE BUG THIS FEATURE EXISTS FOR.
test('switching KINDS does not wipe the other kind\'s credentials', async (t) => {
  const d = await dir(t)
  const s = store(d)

  s.save({ kind: 'navidrome', url: 'http://nas:4533', username: 'tim', password: 'secret' })
  s.save({ kind: 'folder', root: '/music' }) // <- used to overwrite the whole file

  // Flip back. The Navidrome config is still there, password and all, so the
  // dashboard can prefill it and the operator does not retype anything.
  const nav = s.configFor('navidrome')
  assert.equal(nav.url, 'http://nas:4533')
  assert.equal(nav.username, 'tim')
  assert.equal(nav.password, 'secret')

  // And it survives a restart in that state.
  const nav2 = store(d).configFor('navidrome')
  assert.equal(nav2.password, 'secret')
})

test('an empty password means KEEP the existing one, not blank it', async (t) => {
  const d = await dir(t)
  const s = store(d)
  s.save({ kind: 'navidrome', url: 'http://nas:4533', username: 'tim', password: 'secret' })

  // The operator edits the URL and leaves the password box empty - which the
  // dashboard sends as no password field at all.
  const kept = s.withKeptSecrets({ kind: 'navidrome', url: 'http://nas:4533/new', username: 'tim' })
  assert.equal(kept.password, 'secret', 'blank means "leave it alone"')

  // A NEW password does replace it.
  const changed = s.withKeptSecrets({ kind: 'navidrome', url: 'http://nas:4533', username: 'tim', password: 'fresh' })
  assert.equal(changed.password, 'fresh')
})

test('THE PASSWORD NEVER LEAVES THE HOST', async (t) => {
  const d = await dir(t)
  const s = store(d)
  s.save({ kind: 'navidrome', url: 'http://localhost:4533', username: 'umbrel', password: 'hunter2' })
  s.save({ kind: 'jellyfin', url: 'http://localhost:8096', username: 'j', password: 'sesame' })

  const view = s.view()
  // A dashboard session is a licence to CHANGE the source, not to read back the
  // credentials of the machine it runs on.
  assert.equal(view.kinds.navidrome.hasPassword, true)
  assert.equal(view.kinds.navidrome.password, undefined)
  assert.equal(view.kinds.jellyfin.hasPassword, true)
  assert.ok(!JSON.stringify(view).includes('hunter2'))
  assert.ok(!JSON.stringify(view).includes('sesame'))
})

test('the view carries every kind, so the dashboard can prefill any of them', async (t) => {
  const d = await dir(t)
  const s = store(d)
  s.save({ kind: 'navidrome', url: 'http://nas:4533', username: 'tim', password: 'x' })

  const view = s.view()
  assert.equal(view.active, 'navidrome')
  assert.deepEqual(Object.keys(view.kinds).sort(), [...KINDS].sort())
  assert.equal(view.kinds.navidrome.url, 'http://nas:4533')
  assert.equal(view.kinds.jellyfin.url, '', 'never configured, but present and blank')
})

test('the source file is 0600 - it holds a password', async (t) => {
  const d = await dir(t)
  store(d).save({ kind: 'navidrome', url: 'u', username: 'n', password: 'secret' })
  const mode = fs.statSync(path.join(d, 'source.json')).mode & 0o777
  assert.equal(mode, 0o600, 'a credential must not be more readable than the identity key beside it')
})

test('garbage in source.json is ignored, not fatal', async (t) => {
  const d = await dir(t)
  fs.writeFileSync(path.join(d, 'source.json'), '{ this is not json')

  // The host still comes up on the folder rather than refusing to start, because a
  // corrupt preferences file is not a reason to lose access to the dashboard that
  // would fix it.
  assert.equal(store(d).active().kind, 'folder')
})

// --- v1 -> v2 migration -----------------------------------------------------
//
// Every host in the wild (Tim's Umbrel) has a v1 flat config on disk. Reading it as
// v2 and losing the source would take the library dark on upgrade.

test('a v1 flat config migrates to v2, keeping the source', async (t) => {
  const d = await dir(t)
  fs.writeFileSync(path.join(d, 'source.json'),
    JSON.stringify({ kind: 'navidrome', url: 'http://nas:4533', username: 'tim', password: 'secret' }))

  const a = store(d).active()
  assert.equal(a.kind, 'navidrome')
  assert.equal(a.url, 'http://nas:4533')
  assert.equal(a.password, 'secret', 'the whole point: the credential survives the upgrade')
})

test('migrate() handles the shapes it will actually meet', () => {
  // v1 flat.
  const v1 = migrate({ kind: 'folder', root: '/music' })
  assert.equal(v1.version, 2)
  assert.equal(v1.active, 'folder')
  assert.equal(v1.sources.folder.root, '/music')

  // Already v2.
  const v2 = migrate({ version: 2, active: 'navidrome', sources: { navidrome: { url: 'u', username: 'n', password: 'p' } } })
  assert.equal(v2.active, 'navidrome')
  assert.equal(v2.sources.navidrome.password, 'p')

  // Junk.
  assert.equal(migrate(null), null)
  assert.equal(migrate({ nonsense: true }), null)
})

test('jellyfin is a first-class kind now', async (t) => {
  const d = await dir(t)
  const a = store(d).save({ kind: 'jellyfin', url: 'http://localhost:8096', username: 'j', password: 'p' })
  assert.equal(a.kind, 'jellyfin')
  assert.ok(KINDS.includes('jellyfin'))
})

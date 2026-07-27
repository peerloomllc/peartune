// The paired-host LIST bookkeeping (multi-host, proposal 2026-07-19). What is worth
// pinning: the v1 single-host file upgrades cleanly, adding is idempotent per hostKey,
// the active pointer is always valid, and removing the active host re-homes it.

const test = require('node:test')
const assert = require('node:assert/strict')
const H = require('../worklet/hosts')

const A = { hostKey: 'aaa', libraryId: 'libA', libraryName: "Tim's Umbrel" }
const B = { hostKey: 'bbb', libraryId: 'libB', libraryName: 'Start9 attic' }

test('empty() is the canonical fresh shape', () => {
  assert.deepEqual(H.empty(), { version: 2, hosts: [], activeHostKey: null })
})

test('normalize() upgrades a v1 single-host file into a one-element active list', () => {
  // Exactly what everything before multi-host wrote: one bare object.
  const v1 = { hostKey: 'aaa', libraryId: 'libA', libraryName: "Tim's Umbrel" }
  const f = H.normalize(v1)
  assert.equal(f.version, 2)
  assert.equal(f.hosts.length, 1)
  assert.equal(f.activeHostKey, 'aaa')
  assert.deepEqual(f.hosts[0], { hostKey: 'aaa', libraryId: 'libA', libraryName: "Tim's Umbrel", addedAt: 0 })
})

test('normalize() coerces junk to empty rather than throwing', () => {
  assert.deepEqual(H.normalize(null), H.empty())
  assert.deepEqual(H.normalize('nope'), H.empty())
  assert.deepEqual(H.normalize({ hosts: 'not-an-array' }), H.empty())
})

test('normalize() drops keyless rows and de-dupes by hostKey (first wins)', () => {
  const f = H.normalize({
    version: 2,
    hosts: [A, { libraryId: 'x' }, { ...A, libraryName: 'dupe' }, B],
    activeHostKey: 'bbb'
  })
  assert.deepEqual(f.hosts.map((h) => h.hostKey), ['aaa', 'bbb'])
  assert.equal(f.hosts[0].libraryName, "Tim's Umbrel") // first A wins, not 'dupe'
  assert.equal(f.activeHostKey, 'bbb')
})

test('normalize() repairs an active pointer that names no held host', () => {
  const f = H.normalize({ version: 2, hosts: [A, B], activeHostKey: 'ghost' })
  assert.equal(f.activeHostKey, 'aaa') // falls back to the first
})

test('activeHost() returns the active record, or null when empty', () => {
  assert.equal(H.activeHost(H.empty()), null)
  const f = H.addHost(H.empty(), A, 100)
  assert.deepEqual(H.activeHost(f), { hostKey: 'aaa', libraryId: 'libA', libraryName: "Tim's Umbrel", addedAt: 100 })
})

test('addHost() appends, stamps addedAt, and activates', () => {
  let f = H.addHost(H.empty(), A, 111)
  f = H.addHost(f, B, 222)
  assert.deepEqual(f.hosts.map((h) => h.hostKey), ['aaa', 'bbb'])
  assert.equal(f.hosts[1].addedAt, 222)
  assert.equal(f.activeHostKey, 'bbb') // newest add is active
})

test('addHost() on a known host is idempotent: no duplicate, refreshes name, re-activates', () => {
  let f = H.addHost(H.empty(), A, 111)
  f = H.addHost(f, B, 222)
  const before = f.hosts.length
  f = H.addHost(f, { ...A, libraryName: 'Renamed Umbrel' }, 333)
  assert.equal(f.hosts.length, before, 'no new row for a re-pair')
  assert.equal(f.hosts.find((h) => h.hostKey === 'aaa').libraryName, 'Renamed Umbrel')
  assert.equal(f.hosts.find((h) => h.hostKey === 'aaa').addedAt, 111, 'addedAt is preserved on re-pair')
  assert.equal(f.activeHostKey, 'aaa', 're-pair re-activates')
})

test('setActive() switches, and throws for an unpaired host', () => {
  let f = H.addHost(H.addHost(H.empty(), A, 1), B, 2)
  f = H.setActive(f, 'aaa')
  assert.equal(f.activeHostKey, 'aaa')
  assert.throws(() => H.setActive(f, 'ccc'), /Not paired/)
})

test('removeHost() of a non-active host leaves the active pointer alone', () => {
  let f = H.addHost(H.addHost(H.empty(), A, 1), B, 2) // active = bbb
  const { file, removed } = H.removeHost(f, 'aaa')
  assert.equal(removed.hostKey, 'aaa')
  assert.deepEqual(file.hosts.map((h) => h.hostKey), ['bbb'])
  assert.equal(file.activeHostKey, 'bbb')
})

test('removeHost() of the active host re-homes active to the first remaining', () => {
  let f = H.addHost(H.addHost(H.empty(), A, 1), B, 2) // active = bbb
  const { file } = H.removeHost(f, 'bbb')
  assert.deepEqual(file.hosts.map((h) => h.hostKey), ['aaa'])
  assert.equal(file.activeHostKey, 'aaa')
})

test('removeHost() of the last host leaves an empty list with a null active', () => {
  let f = H.addHost(H.empty(), A, 1)
  const { file } = H.removeHost(f, 'aaa')
  assert.deepEqual(file.hosts, [])
  assert.equal(file.activeHostKey, null)
})

test('removeHost() of an unknown host is a no-op returning removed:null', () => {
  const f = H.addHost(H.empty(), A, 1)
  const { file, removed } = H.removeHost(f, 'zzz')
  assert.equal(removed, null)
  assert.deepEqual(file.hosts.map((h) => h.hostKey), ['aaa'])
})

test('renameHost() updates a host name (operator renamed the library), active pointer untouched', () => {
  let f = H.addHost(H.addHost(H.empty(), A, 1), B, 2) // active = bbb
  f = H.renameHost(f, 'aaa', 'Tim’s Umbrel (attic)')
  assert.equal(f.hosts.find((h) => h.hostKey === 'aaa').libraryName, 'Tim’s Umbrel (attic)')
  assert.equal(f.activeHostKey, 'bbb') // unchanged
})

test('renameHost() is a no-op for a missing host, empty name, or unchanged name', () => {
  const f = H.addHost(H.empty(), A, 1)
  assert.equal(H.renameHost(f, 'zzz', 'X').hosts[0].libraryName, "Tim's Umbrel") // missing host
  assert.equal(H.renameHost(f, 'aaa', '').hosts[0].libraryName, "Tim's Umbrel") // empty name
  assert.equal(H.renameHost(f, 'aaa', "Tim's Umbrel").hosts[0].libraryName, "Tim's Umbrel") // unchanged
})

// --- electHome: the merged session's deterministic authority (phase 3) --------

test('electHome() picks the smallest-hostKey host among the CONNECTED ones', () => {
  const f = H.addHost(H.addHost(H.empty(), A, 1), B, 2) // aaa < bbb
  assert.equal(H.electHome(f, ['libA', 'libB']), 'libA')   // both live -> aaa wins
  assert.equal(H.electHome(f, new Set(['libB'])), 'libB')  // only bbb live -> it's home
  assert.equal(H.electHome(f, []), null)                   // nothing reachable -> no home
})

test('electHome() is device-agnostic: every device computes the same home from the same list', () => {
  // Order of the host list must not change the answer (two devices may have added in either order).
  const f1 = H.addHost(H.addHost(H.empty(), B, 1), A, 2)
  const f2 = H.addHost(H.addHost(H.empty(), A, 1), B, 2)
  const live = ['libA', 'libB']
  assert.equal(H.electHome(f1, live), H.electHome(f2, live))
  assert.equal(H.electHome(f1, live), 'libA')
})

// --- same-named libraries (Tim, 2026-07-27) ---------------------------------
//
// A library is named by its HOST, and the desktop host ships with `--name "My Library"` - so two
// friends running defaults give you two identical rows, and you cannot rename someone else's
// library. Same rule the host already uses for two people called Sam: only a genuine clash earns
// a suffix, and a lone name is left completely alone.

test('two libraries with the same name are suffixed with their id', () => {
  const labels = H.libraryLabels([
    { libraryId: 'jud4pgi4zzz', libraryName: 'My Library' },
    { libraryId: 'rxtjffsraaa', libraryName: 'My Library' }
  ])
  assert.equal(labels.get('jud4pgi4zzz'), 'My Library #jud4')
  assert.equal(labels.get('rxtjffsraaa'), 'My Library #rxtj')
})

test('a lone library keeps its name exactly', () => {
  // The whole point of "only on a clash": one library must never grow a hash for no reason.
  const labels = H.libraryLabels([
    { libraryId: 'jud4pgi4zzz', libraryName: "Tim's Umbrel" },
    { libraryId: 'rxtjffsraaa', libraryName: "Tim's Mac Mini" }
  ])
  assert.equal(labels.get('jud4pgi4zzz'), "Tim's Umbrel")
  assert.equal(labels.get('rxtjffsraaa'), "Tim's Mac Mini")
})

test('the clash test ignores case and surrounding space', () => {
  // "my library" and "My Library " are the same name to a human reading a list.
  const labels = H.libraryLabels([
    { libraryId: 'aaaa1111', libraryName: 'my library' },
    { libraryId: 'bbbb2222', libraryName: 'My Library ' }
  ])
  assert.equal(labels.get('aaaa1111'), 'my library #aaaa')
  assert.equal(labels.get('bbbb2222'), 'My Library #bbbb')
})

test('a nameless library reads as Library, and two of them are still told apart', () => {
  const labels = H.libraryLabels([
    { libraryId: 'aaaa1111', libraryName: '' },
    { libraryId: 'bbbb2222', libraryName: null }
  ])
  assert.equal(labels.get('aaaa1111'), 'Library #aaaa')
  assert.equal(labels.get('bbbb2222'), 'Library #bbbb')
})

test('three of a name all get suffixed', () => {
  const labels = H.libraryLabels([
    { libraryId: 'aaaa1111', libraryName: 'Music' },
    { libraryId: 'bbbb2222', libraryName: 'Music' },
    { libraryId: 'cccc3333', libraryName: 'Music' }
  ])
  assert.deepEqual([...labels.values()], ['Music #aaaa', 'Music #bbbb', 'Music #cccc'])
})

test('junk records are skipped rather than thrown on', () => {
  const labels = H.libraryLabels([null, {}, { libraryId: 'aaaa1111', libraryName: 'Music' }])
  assert.equal(labels.size, 1)
  assert.equal(labels.get('aaaa1111'), 'Music')
})

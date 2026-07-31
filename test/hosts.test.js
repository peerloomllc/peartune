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

// --- sessionHost: the same answer whatever VIEW a device is in ----------------
//
// The property that matters is not "which host" but "the same host on both devices". A blended
// device and a focused one must agree, or the cross-scope arbitration on that host (#283) never
// sees both. Before 2026-07-30 a focused device used its FOCUSED library, so they agreed only when
// that happened to be the elected one.

test('sessionHost() is the SAME for a blended device and a focused one', () => {
  const f = H.addHost(H.addHost(H.empty(), A, 1), B, 2) // aaa < bbb, so libA is home
  const live = ['libA', 'libB']
  // The blended device passes its default (whatever it is); the focused device passes the library
  // it is focused on. Both must land on libA - THAT is the fix.
  assert.equal(H.sessionHost(f, live, 'libA'), 'libA')
  assert.equal(H.sessionHost(f, live, 'libB'), 'libA', 'a device focused on bbb still uses the elected home')
})

test('sessionHost() falls back to the device default when nothing can be elected', () => {
  const f = H.addHost(H.empty(), A, 1)
  assert.equal(H.sessionHost(f, [], 'libA'), 'libA', 'nothing connected -> the default library')
  assert.equal(H.sessionHost(H.empty(), [], null), null, 'no hosts at all -> nothing')
})

test('sessionHost() with ONE library is exactly the old behaviour', () => {
  // The overwhelming majority of installs. electHome returns the only host, which IS the default,
  // so the change is byte-for-byte invisible here.
  const f = H.addHost(H.empty(), A, 1)
  assert.equal(H.sessionHost(f, ['libA'], 'libA'), 'libA')
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

// --- a LOCAL alias for a library (proposal 2026-07-27-local-library-alias) ----
//
// The #jud4 suffix above tells two same-named libraries apart and tells a human nothing. A library
// is named by its HOST, so a friend's default "My Library" was un-relabellable: every rename path
// takes the name the server pushed. An alias is yours, local to this phone, and never sent anywhere.

test('setAlias() sets your own name for a library, leaving the host name intact', () => {
  let f = H.addHost(H.empty(), A, 1)
  f = H.setAlias(f, 'aaa', "Sam's music")
  const h = f.hosts[0]
  assert.equal(h.alias, "Sam's music")
  assert.equal(h.libraryName, "Tim's Umbrel") // what the SERVER says still tracked underneath
})

test('setAlias() with a blank value CLEARS the alias (back to the host name)', () => {
  let f = H.setAlias(H.addHost(H.empty(), A, 1), 'aaa', 'Attic box')
  for (const blank of ['', '   ', null, undefined, 42]) {
    f = H.setAlias(f, 'aaa', blank)
    assert.equal('alias' in f.hosts[0], false, `blank ${JSON.stringify(blank)} should clear`)
    f = H.setAlias(f, 'aaa', 'Attic box') // re-set for the next case
  }
})

test('setAlias() trims and caps at 40 characters', () => {
  let f = H.addHost(H.empty(), A, 1)
  f = H.setAlias(f, 'aaa', '  spaced  ')
  assert.equal(f.hosts[0].alias, 'spaced')
  f = H.setAlias(f, 'aaa', 'x'.repeat(200))
  assert.equal(f.hosts[0].alias.length, H.ALIAS_MAX)
})

test('setAlias() on a missing host is a no-op (a rename can race a remove)', () => {
  const f = H.setAlias(H.addHost(H.empty(), A, 1), 'zzz', 'Nope')
  assert.equal(f.hosts.length, 1)
  assert.equal('alias' in f.hosts[0], false)
})

test('an alias survives a host rename AND a re-pair', () => {
  // Both paths overwrite libraryName from the server. Neither may touch YOUR name for it.
  let f = H.setAlias(H.addHost(H.empty(), A, 1), 'aaa', "Sam's music")
  f = H.renameHost(f, 'aaa', 'Renamed On The Dashboard')
  assert.equal(f.hosts[0].alias, "Sam's music")
  f = H.addHost(f, { ...A, libraryName: 'Renamed Again' }, 2)
  assert.equal(f.hosts[0].alias, "Sam's music")
  assert.equal(f.hosts[0].libraryName, 'Renamed Again')
})

test('record() omits `alias` entirely when there is not one', () => {
  // The no-migration property: an un-aliased record is byte-identical to a pre-alias one, and an
  // older build reading a newer file just drops the field.
  assert.deepEqual(H.record(A), { hostKey: 'aaa', libraryId: 'libA', libraryName: "Tim's Umbrel", addedAt: 0 })
  assert.deepEqual(H.record({ ...A, alias: '  ' }), { hostKey: 'aaa', libraryId: 'libA', libraryName: "Tim's Umbrel", addedAt: 0 })
  assert.equal(H.record({ ...A, alias: ' Mine ' }).alias, 'Mine')
})

test('normalize() keeps an alias through a round-trip and sanitises a hand-edited one', () => {
  const raw = { version: 2, hosts: [{ ...A, alias: '  My name for it  ' }], activeHostKey: 'aaa' }
  assert.equal(H.normalize(raw).hosts[0].alias, 'My name for it')
  assert.equal(H.normalize(H.normalize(raw)).hosts[0].alias, 'My name for it')
})

test('libraryLabels() prefers YOUR alias over the host name, and a lone alias gets no suffix', () => {
  const labels = H.libraryLabels([
    { libraryId: 'jud4pgi4zzz', libraryName: 'My Library', alias: "Sam's music" },
    { libraryId: 'rxtjffsraaa', libraryName: 'My Library' }
  ])
  // The clash is GONE now that one of them is named something else - so neither keeps a suffix.
  assert.equal(labels.get('jud4pgi4zzz'), "Sam's music")
  assert.equal(labels.get('rxtjffsraaa'), 'My Library')
})

test('two identical ALIASES clash and are suffixed, same as two identical host names', () => {
  const labels = H.libraryLabels([
    { libraryId: 'jud4pgi4zzz', libraryName: "Tim's Umbrel", alias: 'Music' },
    { libraryId: 'rxtjffsraaa', libraryName: "Tim's Mac", alias: 'music ' }
  ])
  assert.equal(labels.get('jud4pgi4zzz'), 'Music #jud4')
  assert.equal(labels.get('rxtjffsraaa'), 'music #rxtj')
})

test('an alias that COLLIDES with a host-pushed name suffixes BOTH', () => {
  // Why the clash test has to run on the effective name rather than in front of the alias: this is
  // the case where applying the alias first and checking second would produce two identical rows.
  const labels = H.libraryLabels([
    { libraryId: 'jud4pgi4zzz', libraryName: "Sam's box", alias: 'My Library' },
    { libraryId: 'rxtjffsraaa', libraryName: 'My Library' }
  ])
  assert.equal(labels.get('jud4pgi4zzz'), 'My Library #jud4')
  assert.equal(labels.get('rxtjffsraaa'), 'My Library #rxtj')
})

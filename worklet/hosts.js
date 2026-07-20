'use strict'

// The paired-host LIST (multi-host, proposal 2026-07-19).
//
// One phone can pair to more than one host - an Umbrel AND a Start9, say - and switch
// between them from Settings. The device identity is the same for all of them (one keypair
// IS the account; each host gates it independently), and track/album ids never collide
// because every id is namespaced under libraryId = hash(hostKey). So "which hosts am I
// paired to, and which one is active" is the ONLY new persisted state - and it is pure
// list bookkeeping, kept here so it is unit-tested without a disk.
//
// bare.js owns the file I/O (read hosts.json -> normalize -> mutate -> write); this module
// never touches fs. A host record is { hostKey, libraryId, libraryName, addedAt }.

// The empty, canonical v2 shape. A fresh install has no hosts and no active one.
function empty () {
  return { version: 2, hosts: [], activeHostKey: null }
}

// Coerce ANY on-disk shape into the canonical v2 file, including the v1 single-host file.
//
// v1 (everything shipped before multi-host) wrote hosts.json as ONE bare object -
// { hostKey, libraryId, libraryName } - so a device upgrading in the field has exactly
// that. Detect it (a top-level hostKey with no hosts array) and lift it into a
// one-element list, active. Anything unrecognisable becomes empty rather than throwing:
// a corrupt host file should land you on the pairing screen, not wedge the worklet.
function normalize (raw) {
  if (!raw || typeof raw !== 'object') return empty()

  // v1 -> v2: a single host object becomes a one-element active list.
  if (raw.hostKey && !Array.isArray(raw.hosts)) {
    const h = record(raw)
    return { version: 2, hosts: [h], activeHostKey: h.hostKey }
  }

  if (!Array.isArray(raw.hosts)) return empty()

  // Drop anything without a hostKey, and de-dupe by hostKey (first wins) so a hand-edited
  // or double-written file cannot produce two rows for the same host.
  const seen = new Set()
  const hosts = []
  for (const h of raw.hosts) {
    if (!h || !h.hostKey || seen.has(h.hostKey)) continue
    seen.add(h.hostKey)
    hosts.push(record(h))
  }

  // The active pointer must name a host we actually hold; otherwise fall back to the first
  // (or null when the list is empty). This keeps loadActiveHost() total.
  const activeHostKey = hosts.some((h) => h.hostKey === raw.activeHostKey)
    ? raw.activeHostKey
    : (hosts[0] ? hosts[0].hostKey : null)

  return { version: 2, hosts, activeHostKey }
}

// One clean host record, dropping any stray fields a caller (or an old file) tacked on.
function record (h) {
  return {
    hostKey: h.hostKey,
    libraryId: h.libraryId,
    libraryName: h.libraryName,
    addedAt: Number(h.addedAt) || 0
  }
}

// The active host object, or null. Total: a missing/renamed active pointer already fell
// back to the first host in normalize().
function activeHost (raw) {
  const f = normalize(raw)
  return f.hosts.find((h) => h.hostKey === f.activeHostKey) || null
}

// Add a host (or refresh one we already hold) and make it active. Re-pairing a known host
// is idempotent on identity - the host keeps the same grant row - so here it just updates
// the library name and re-activates, never appends a duplicate. `now` is passed in (bare.js
// supplies Date.now()) so this stays pure and testable.
function addHost (raw, host, now) {
  const f = normalize(raw)
  const existing = f.hosts.find((h) => h.hostKey === host.hostKey)
  if (existing) {
    existing.libraryId = host.libraryId
    existing.libraryName = host.libraryName
  } else {
    f.hosts.push(record({ ...host, addedAt: now }))
  }
  f.activeHostKey = host.hostKey
  return f
}

// Point the active pointer at an already-paired host. Throws if it is not in the list -
// switching to a library you are not paired to is a caller bug, not a silent no-op.
function setActive (raw, hostKey) {
  const f = normalize(raw)
  if (!f.hosts.some((h) => h.hostKey === hostKey)) {
    throw new Error('Not paired with that library.')
  }
  f.activeHostKey = hostKey
  return f
}

// Remove a host from the list. If it was the active one, the active pointer falls to the
// first remaining host (or null when none are left). Returns the new file AND the removed
// record, so the caller can purge that host's local state.
function removeHost (raw, hostKey) {
  const f = normalize(raw)
  const idx = f.hosts.findIndex((h) => h.hostKey === hostKey)
  const removed = idx === -1 ? null : f.hosts.splice(idx, 1)[0]
  if (f.activeHostKey === hostKey) {
    f.activeHostKey = f.hosts[0] ? f.hosts[0].hostKey : null
  }
  return { file: f, removed }
}

// Update a host's display name - the operator renamed the library server-side, and the app learns
// the new name on connect (identity.get carries it). Idempotent: a missing host, an empty name, or
// an unchanged name leaves the file as-is. Never touches the active pointer.
function renameHost (raw, hostKey, libraryName) {
  const f = normalize(raw)
  const h = f.hosts.find((x) => x.hostKey === hostKey)
  if (h && libraryName && h.libraryName !== libraryName) h.libraryName = libraryName
  return f
}

// The elected "session home" for the merged play session (multi-host phase 3, proposal
// 2026-07-20): the CONNECTED host with the lexicographically-smallest hostKey. Pure so every
// device - and this test - computes the SAME home from the same host list, which is what gives
// the cross-host session ONE generation-CAS authority (no cross-device race). `live` is the set
// (or array) of currently-connected libraryIds; a host absent from it can't be home. Returns the
// home's libraryId, or null when nothing paired is reachable.
function electHome (raw, live) {
  const f = normalize(raw)
  const set = live instanceof Set ? live : new Set(live || [])
  const cand = f.hosts.filter((h) => h && h.hostKey && set.has(h.libraryId))
  if (!cand.length) return null
  cand.sort((a, b) => (a.hostKey < b.hostKey ? -1 : a.hostKey > b.hostKey ? 1 : 0))
  return cand[0].libraryId
}

module.exports = { empty, normalize, record, activeHost, addHost, setActive, removeHost, renameHost, electHome }

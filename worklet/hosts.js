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
// never touches fs. A host record is { hostKey, libraryId, libraryName, addedAt } plus an
// optional `alias` (proposal 2026-07-27-local-library-alias) - see setAlias below.

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
//
// `alias` is present ONLY when there is one, so an un-aliased record round-trips exactly as it
// did before the field existed - that is what makes this a no-migration change. (An older build
// reading a newer file drops the alias here and shows host names: lossy on a downgrade, never
// broken.)
function record (h) {
  const r = {
    hostKey: h.hostKey,
    libraryId: h.libraryId,
    libraryName: h.libraryName,
    addedAt: Number(h.addedAt) || 0
  }
  const alias = cleanAlias(h.alias)
  if (alias) r.alias = alias
  // Same "present only when set" rule as alias, and for the same reason: a library
  // that has never been asked round-trips exactly as it did before the field existed,
  // so this is a no-migration change and an older build just drops it.
  const relayAudio = cleanRelayAudio(h.relayAudio)
  if (relayAudio) r.relayAudio = relayAudio
  return r
}

// An alias as we are willing to store it: trimmed, capped, and '' for anything blank or
// non-string. One place, so normalize() sanitises a hand-edited file the same way setAlias()
// sanitises a typed one.
const ALIAS_MAX = 40

function cleanAlias (a) {
  return typeof a === 'string' ? a.trim().slice(0, ALIAS_MAX) : ''
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

// Set (or clear) YOUR OWN name for a library - proposal 2026-07-27-local-library-alias.
//
// A library is named by its HOST: every path above takes the name the server pushed, so you
// cannot relabel a friend's "My Library" at all, and #212's `#jud4` suffix tells a debugger
// where to look while telling a human nothing. An alias is the local answer, and it is LOCAL in
// the strong sense - it is never sent to a host. Storing it host-side would put the private name
// you gave someone else's library on their server.
//
// Blank clears it, so the row falls back to whatever the host is called RIGHT NOW: libraryName
// keeps tracking the server underneath an alias (renameHost/addHost above still run), which is
// what stops clearing an alias from revealing a stale name. A missing host is a no-op, matching
// renameHost - a rename racing a removeHost is not a caller bug.
// The per-library relay-audio consent as we are willing to store it (proposal
// 2026-07-29-relay-audio-consent). '' means "not set", i.e. 'ask', which is why the
// field is absent rather than written as 'ask' - see record().
const RELAY_AUDIO = new Set(['allow', 'deny'])

function cleanRelayAudio (v) {
  return RELAY_AUDIO.has(v) ? v : ''
}

// The stored consent for one library, as the three-way the policy fn expects.
// Absent (never asked) reads as 'ask'.
function relayAudioFor (raw, libraryId) {
  const f = normalize(raw)
  const h = f.hosts.find((x) => x.libraryId === libraryId)
  return (h && h.relayAudio) || 'ask'
}

// Set (or clear) it. Passing anything other than 'allow'/'deny' - including 'ask' -
// clears the field, which is how "ask me again" is expressed.
function setRelayAudio (raw, hostKey, value) {
  const f = normalize(raw)
  const h = f.hosts.find((x) => x.hostKey === hostKey)
  if (!h) return f
  const clean = cleanRelayAudio(value)
  if (clean) h.relayAudio = clean
  else delete h.relayAudio
  return f
}

function setAlias (raw, hostKey, alias) {
  const f = normalize(raw)
  const h = f.hosts.find((x) => x.hostKey === hostKey)
  if (!h) return f
  const clean = cleanAlias(alias)
  if (clean) h.alias = clean
  else delete h.alias
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

// Two libraries with the SAME NAME (Tim, 2026-07-27). A library is named by its HOST, and the
// desktop host ships with `--name "My Library"` - so two friends running defaults give you two
// identical rows in the switcher, the chips, Settings, the request list and the Manage picker,
// with nothing to tell them apart. You cannot even rename someone else's library: every rename
// path here is driven by the name the host pushes.
//
// Same rule the HOST already uses for two people called Sam (host/grants.js personLabels): a lone
// name is left completely alone, and only a genuine clash earns a suffix. The discriminator is the
// libraryId prefix - stable across renames and reconnects, and the same string that appears in the
// logs and on the dashboard, so a confused user and a debugging developer are looking at the same
// four characters.
//
// This lives on the PHONE, unlike personLabels: libraries span hosts, and only the phone holds the
// whole list. Computed at the boundary, never persisted - the stored libraryName stays exactly what
// the host said, so a later rename (or an alias) has something honest to compare against.
//
// YOUR alias wins over the host's name (setAlias above), and the clash test runs on the name that
// RESULTS. That ordering is the whole subtlety: an alias can collide with a name a host pushes
// ("My Library" aliased next to a host actually called "My Library"), and that pair still has to
// be tellable apart. Checking for a clash first and then applying the alias would silently produce
// two identical rows again.
const SUFFIX_LEN = 4

function effectiveName (h) {
  return String(cleanAlias(h.alias) || h.libraryName || '').trim() || 'Library'
}

function libraryLabels (hosts) {
  const byName = new Map()
  for (const h of hosts || []) {
    if (!h || !h.libraryId) continue
    const k = effectiveName(h).toLowerCase()
    byName.set(k, (byName.get(k) || 0) + 1)
  }
  const out = new Map()
  for (const h of hosts || []) {
    if (!h || !h.libraryId) continue
    const name = effectiveName(h)
    const clashes = (byName.get(name.toLowerCase()) || 0) > 1
    out.set(h.libraryId, clashes ? `${name} #${String(h.libraryId).slice(0, SUFFIX_LEN)}` : name)
  }
  return out
}

// WHICH host holds a person's play token, for a device in ANY view. The elected home when one can
// be elected, else the device's own default library (0-1 paired libraries, or nothing connected).
//
// The point is that it does NOT depend on the view: a device showing the blend and one focused on a
// single library must resolve the SAME host, or the cross-scope arbitration on that host never sees
// both of them. Before 2026-07-30 a focused device used its focused library, so the two agreed only
// when the focused library happened to be the elected one - always with one library, a coin flip
// with two (proposal 2026-07-30-session-home-regardless-of-view).
function sessionHost (raw, live, defaultLibraryId = null) {
  return electHome(raw, live) || defaultLibraryId || null
}

module.exports = { empty, normalize, record, activeHost, addHost, setActive, removeHost, renameHost, setAlias, setRelayAudio, relayAudioFor, electHome, sessionHost, libraryLabels, ALIAS_MAX }

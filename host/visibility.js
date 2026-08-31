// WHAT ONE PERSON MAY HEAR OF THE LIBRARY, and the one place that decides it.
//
// proposals/2026-08-31-per-person-folders.md (T3), ported from PearCinema's proven
// 2026-08-30 design. A grant carries `paths`: null for everything (every grant until
// now) or a list of { root, rel } prefixes chosen on the People page. This file turns
// that into a yes or no per item, and hands back a narrowed VIEW of an adapter so
// every wire method that hands out content reads the same smaller library - a hidden
// track is not listed, not found by id, not searched, not counted, has no art and
// does not stream.
//
// Three rules are deliberate and easy to get backwards:
//   - An OWNER is never filtered, whatever the row says. The owner is the library.
//   - An item whose location the adapter cannot name is HIDDEN from a narrowed grant.
//     Failing open would make "narrow" mean "narrow, except for whatever we could not
//     place", which is exactly the silent hole the proposal calls a security bug.
//   - An adapter that cannot enforce a narrowing (a proxy source with no paths) serves
//     a narrowed grant NOTHING, not everything. The dashboard refuses to create that
//     state; this is the backstop for a source swapped under an existing narrowing.
//
// Module-level functions, never methods on the host - detached callers (the cast
// token fetch) must be able to ask without holding the host.

const path = require('path')

const OWNER = 'owner'

// A prefix that stands for "the root and everything under it" is rel ''. Any other
// rel is a folder path under the root, normalised to forward slashes with no leading
// or trailing separator, so 'kids', 'kids/', '/kids/' and 'kids\\' are one prefix.
function normalRel (rel) {
  return String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

// Does a location fall under a prefix? Folder boundaries count: 'kids' covers
// 'kids/Lullabies/song.mp3' and does not cover 'kids2/...'.
function under (loc, prefix) {
  if (!loc || !prefix) return false
  if (loc.root !== prefix.root) return false
  const want = normalRel(prefix.rel)
  if (want === '') return true
  const have = normalRel(loc.rel)
  return have === want || have.startsWith(want + '/')
}

// The question. `grant` is the live grant of the connection; `loc` is what the
// adapter says about the item ({ root, rel } or null).
function visibleTo (grant, loc) {
  if (!grant) return false
  if (grant.scope === OWNER) return true
  const paths = grant.paths
  if (paths === null || paths === undefined) return true
  if (!Array.isArray(paths) || paths.length === 0) return false
  if (!loc) return false
  return paths.some((p) => under(loc, p))
}

// Is this grant narrowed at all? The fast path: an unnarrowed grant gets the real
// adapter back, so the common case costs nothing.
function narrowed (grant) {
  return !!grant && grant.scope !== OWNER && Array.isArray(grant.paths) && grant.paths.length > 0
}

// A valid stored value for grant.paths, or a throw. null means everything; a list
// must be non-empty { root, rel } rows with real roots, rels normalised on the way
// in. An empty list is refused rather than stored: it would mean "nothing", and the
// dashboard's word for everything is null - two spellings of extremes invite the
// wrong one (PearCinema: "an empty folder list is not an answer either").
function normalisePaths (paths) {
  if (paths === null || paths === undefined) return null
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('paths must be null (everything) or a non-empty list')
  const out = paths.map((p) => {
    const root = typeof p?.root === 'string' ? p.root.trim() : ''
    if (!root) throw new Error('each path needs the root it is anchored to')
    return { root, rel: normalRel(p?.rel) }
  })
  return out
}

// The adapter as ONE PERSON hears it.
//
// Not narrowed: the real adapter, untouched. Narrowed and the adapter can enforce it:
// the adapter's own narrowed view (folder.js narrowedView - it holds the catalog in
// memory, so the filtered library is real filtered pools behind the same methods).
// Narrowed and the adapter CANNOT enforce it: nothing (see the header).
function viewOf (adapter, grant) {
  if (!adapter || !narrowed(grant)) return adapter
  if (typeof adapter.narrowedView === 'function') return adapter.narrowedView(grant.paths)
  return emptyView(adapter)
}

// The nothing-library: same interface, no content. Served to a narrowed grant whose
// source cannot enforce the narrowing (proposal: fail closed, and the dashboard says
// why on the People page).
function emptyView (adapter) {
  return {
    kind: adapter.kind,
    libraryId: adapter.libraryId,
    scannedAt: adapter.scannedAt ?? null,
    async stats () {
      const base = typeof adapter.stats === 'function' ? await adapter.stats().catch(() => ({})) : {}
      return { ...base, tracks: 0, albums: 0, artists: 0, genres: 0, narrowed: true, unenforceable: true }
    },
    async list ({ type = 'tracks' } = {}) { return { type, items: [], nextCursor: null } },
    async get () { return null },
    async search () { return { artists: [], albums: [], tracks: [] } },
    async art () { return null },
    async stream () { return null }
  }
}

// Where a file sits relative to the roots an adapter was given: { root, rel } or
// null when it is under none of them.
function locate (file, roots) {
  if (!file) return null
  const at = path.resolve(String(file))
  for (const r of roots || []) {
    const rootPath = typeof r === 'string' ? r : r?.path
    if (!rootPath) continue
    if (at === rootPath) return { root: rootPath, rel: '' }
    if (at.startsWith(rootPath + path.sep)) return { root: rootPath, rel: normalRel(path.relative(rootPath, at)) }
  }
  return null
}

module.exports = { visibleTo, narrowed, normalisePaths, viewOf, emptyView, locate, under, normalRel }

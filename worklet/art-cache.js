'use strict'

// Persistent album-art store (proposal 2026-07-29-persist-album-art).
//
// WHAT CHANGED AND WHY. This began as a store for DOWNLOADED albums only: keyed by coverId
// alone, one image per cover, written solely by the pin path, no index and no LRU because
// the pinned-album list bounded it. That made the shim's disk read legal at exactly ONE
// size (DEFAULT_ART_SIZE), since one stored image cannot answer a request for another size
// - and the library grid asks for 120, 350 or 500 depending on density. So grid art came
// off the network EVERY cold start, even for an album already downloaded, and on a relayed
// connection that is bandwidth PeerLoom pays for, spent again and again on bytes that never
// change.
//
// Now: keyed by coverId AND size, written by browsing as well as pinning, with an index so
// it can be capped and attributed.
//
// THE INDEX IS THE POINT. A coverId is namespaced under libraryId (protocol/ids.js), so
// once a file is on disk there is no way back to the library it came from - which is why
// removing ONE library could never reclaim its art. Recording `library` per entry is what
// makes removeLibrary() possible, exactly as AudioCache already does for audio (see
// cache.js createSink/removeLibrary; this deliberately mirrors it, including returning
// `untagged` so a caller can be honest about what it could not claim).
//
// Blobs stay SHARED at the root rather than moving under DATA_DIR/lib/<libraryId>/, a
// deliberate carry-over from AUDIO_DIR/ART_DIR: ids already cannot collide, bytes de-dupe
// between libraries that share a cover, and nothing has to move when the active library
// changes. Ownership is an index, not a directory.
//
// Like AudioCache, this runs in TWO runtimes - the Bare worklet (bare-fs/bare-path) and
// Node (the unit tests) - so it picks the fs/path binding per runtime.
const fs = typeof Bare !== 'undefined' ? require('bare-fs') : require('fs')
const path = typeof Bare !== 'undefined' ? require('bare-path') : require('path')

// Must equal shim.js's DEFAULT_ART_SIZE. Not imported from there: shim.js pulls bare-http1
// (a native addon that only exists on the phone) and requiring it here would make this
// module unloadable in a Node unit test. test/art-cache.test.js asserts the two agree, so
// the duplication cannot drift silently.
const DEFAULT_SIZE = 300

// A generous COUNT cap rather than a byte budget, and not a user-facing setting (Tim,
// 2026-07-29): covers are small individually, nobody wants to tune an artwork budget, and
// putting art in competition with music for one storage number would cost more in confusion
// than the disk it saves. A 1358-track library is perhaps 150 albums, so this holds several
// libraries over while still bounding a huge shared one.
const DEFAULT_MAX_ENTRIES = 4000

class ArtStore {
  constructor ({ dir, maxEntries = DEFAULT_MAX_ENTRIES }) {
    this.dir = dir
    this.indexPath = path.join(dir, 'index.json')
    this.maxEntries = maxEntries
    this.index = this._load()
    // A monotonic use counter, because Date.now() is NOT enough to order this. A grid of
    // covers arrives inside the same millisecond, so lastUsed ties and the eviction sort
    // becomes arbitrary - "least recently used" would silently mean "whichever the key order
    // happened to put first". `use` breaks the tie strictly. Seeded past the highest value on
    // disk so ordering survives a restart.
    this._seq = Object.values(this.index).reduce((m, e) => Math.max(m, e.use || 0), 0) + 1
  }

  _touch (e) { e.use = this._seq++; e.lastUsed = Date.now(); return e }

  // coverIds come from a source server and can carry slashes or other path characters, so
  // encode them into a single safe filename. The '@<size>' suffix is what lets one cover
  // hold several resolutions at once, and the size is always trailing digits, so splitting
  // on the LAST '@' recovers the id unambiguously.
  _key (coverId, size) { return encodeURIComponent(String(coverId)) + '@' + Number(size) }
  _file (key) { return path.join(this.dir, key) }

  _coverOf (key) {
    const at = key.lastIndexOf('@')
    try { return decodeURIComponent(at === -1 ? key : key.slice(0, at)) } catch { return null }
  }

  _load () {
    try {
      const o = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'))
      return o && typeof o === 'object' ? o : {}
    } catch {
      return {}
    }
  }

  _save () {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(this.indexPath, JSON.stringify(this.index))
    } catch {}
  }

  has (coverId, size = DEFAULT_SIZE) {
    if (!coverId) return false
    return !!this.index[this._key(coverId, size)]
  }

  // Returns the buffer, or null. Touches lastUsed so the LRU reflects what is actually being
  // looked at rather than what was written most recently: a cover the user scrolls past
  // every day should outlive one fetched once and never seen again.
  get (coverId, size = DEFAULT_SIZE) {
    if (!coverId) return null
    const key = this._key(coverId, size)
    const e = this.index[key]
    if (!e) return null
    let buf = null
    try { buf = fs.readFileSync(this._file(key)) } catch { buf = null }
    if (!buf) {
      // Indexed but the file is gone (a manual delete, a half-finished write). Drop the row
      // so we stop claiming to have it, and re-fetch rather than serve nothing.
      delete this.index[key]
      this._save()
      return null
    }
    this._touch(e)
    this._save()
    return buf
  }

  // Returns true if the image was stored. A falsy coverId or empty buffer is a no-op -
  // caching an empty cover would just mask the placeholder with nothing.
  //
  // `library` is the libraryId these bytes came from, recorded so removing ONE library can
  // reclaim its art. Null is allowed and is what every entry written before this shipped
  // has; removeLibrary cannot claim those and the cap ages them out.
  // `pinned` marks a downloaded album's cover, which eviction must never take - the point of
  // a download is that it still works with no host to re-fetch from.
  put (coverId, buf, { size = DEFAULT_SIZE, library = null, pinned = false } = {}) {
    if (!coverId || !buf || !buf.length) return false
    const key = this._key(coverId, size)
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(this._file(key), buf)
      this.index[key] = this._touch({
        size: Number(size),
        bytes: buf.length,
        library: library || null,
        pinned: !!pinned
      })
      this._save()
      this._evict()
      return true
    } catch { return false }
  }

  // Mark every stored size of a cover pinned, or not. Called when an album is downloaded or
  // un-downloaded, so a cover already fetched by BROWSING becomes protected instead of
  // being downloaded a second time just to earn its pin.
  setPinned (coverId, on) {
    if (!coverId) return false
    let hit = false
    for (const [key, e] of Object.entries(this.index)) {
      if (this._coverOf(key) !== String(coverId)) continue
      e.pinned = !!on
      hit = true
    }
    if (hit) this._save()
    return hit
  }

  // Remove EVERY size of one cover. That is what un-pinning an album wants: the cover is no
  // longer needed at any resolution.
  remove (coverId) {
    if (!coverId) return
    let hit = false
    for (const key of Object.keys(this.index)) {
      if (this._coverOf(key) !== String(coverId)) continue
      delete this.index[key]
      try { fs.unlinkSync(this._file(key)) } catch {}
      hit = true
    }
    if (hit) this._save()
  }

  // Drop every entry that came from ONE library - what "remove this library" needs in order
  // to give the bytes back while other libraries stay cached. Mirrors
  // AudioCache.removeLibrary, including leaving untagged rows alone: guessing would delete
  // another library's art, so they are left to the cap exactly as before.
  removeLibrary (libraryId) {
    if (!libraryId) return { removed: 0, bytes: 0, untagged: 0 }
    let removed = 0
    let bytes = 0
    let untagged = 0
    for (const [key, e] of Object.entries(this.index)) {
      if (!e.library) { untagged++; continue }
      if (e.library !== libraryId) continue
      bytes += e.bytes || 0
      removed++
      delete this.index[key]
      try { fs.unlinkSync(this._file(key)) } catch {}
    }
    if (removed) this._save()
    return { removed, bytes, untagged }
  }

  // Count-based LRU. Pinned entries are never candidates, so a phone full of downloads
  // cannot evict its own offline artwork - it just stops caching new browse covers, which
  // degrades to the old behaviour rather than breaking anything.
  _evict () {
    const keys = Object.keys(this.index)
    if (keys.length <= this.maxEntries) return 0
    const candidates = keys
      .filter((k) => !this.index[k].pinned)
      .sort((a, b) => (this.index[a].use || 0) - (this.index[b].use || 0))
    let over = keys.length - this.maxEntries
    let dropped = 0
    for (const key of candidates) {
      if (over <= 0) break
      delete this.index[key]
      try { fs.unlinkSync(this._file(key)) } catch {}
      over--
      dropped++
    }
    if (dropped) this._save()
    return dropped
  }

  count () { return Object.keys(this.index).length }
  totalBytes () { return Object.values(this.index).reduce((s, e) => s + (e.bytes || 0), 0) }

  // One-time sweep of files written before art was keyed by size. They carry no '@<size>'
  // suffix, so nothing will ever read them again - they are pure dead weight. Deleting is
  // safe: the cover re-fetches on demand, and the previous build could not read the new
  // names anyway. Returns how many went, for the log.
  sweepLegacy () {
    let removed = 0
    let files = []
    try { files = fs.readdirSync(this.dir) } catch { return 0 }
    for (const f of files) {
      if (f === 'index.json') continue
      if (/@\d+$/.test(f)) continue // size-keyed, keep
      try { fs.unlinkSync(path.join(this.dir, f)); removed++ } catch {}
    }
    return removed
  }

  clear () {
    let files = []
    try { files = fs.readdirSync(this.dir) } catch { files = [] }
    for (const f of files) {
      try { fs.unlinkSync(path.join(this.dir, f)) } catch {}
    }
    this.index = {}
    this._save()
  }
}

module.exports = { ArtStore, DEFAULT_SIZE, DEFAULT_MAX_ENTRIES }

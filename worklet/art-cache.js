'use strict'

// Persistent album-art store for downloaded albums (milestone 3, phase 5C follow-up).
//
// The audio cache makes a downloaded album PLAY with no host; this makes it LOOK right
// too - without it, an offline Downloads list shows placeholder covers. Keyed by
// coverId, one image per cover. No LRU: it is bounded by the covers of pinned albums,
// which the pin registry already caps by being an explicit, human-sized list. Populated
// at download time, read by the shim as an offline fallback, and cleared on unpair.
//
// Like AudioCache, this runs in TWO runtimes - the Bare worklet (bare-fs/bare-path) and
// Node (the unit tests) - so it picks the fs/path binding per runtime.
const fs = typeof Bare !== 'undefined' ? require('bare-fs') : require('fs')
const path = typeof Bare !== 'undefined' ? require('bare-path') : require('path')

class ArtStore {
  constructor ({ dir }) {
    this.dir = dir
  }

  // coverIds come from a source server and can carry slashes or other path characters,
  // so encode them into a single safe filename.
  _file (coverId) { return path.join(this.dir, encodeURIComponent(String(coverId))) }

  has (coverId) {
    if (!coverId) return false
    // statSync, not existsSync: bare-fs does not implement existsSync everywhere.
    try { fs.statSync(this._file(coverId)); return true } catch { return false }
  }

  get (coverId) {
    if (!coverId) return null
    try { return fs.readFileSync(this._file(coverId)) } catch { return null }
  }

  // Returns true if the image was stored. A falsy coverId or empty buffer is a no-op -
  // caching an empty cover would just mask the placeholder with nothing.
  put (coverId, buf) {
    if (!coverId || !buf || !buf.length) return false
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(this._file(coverId), buf)
      return true
    } catch { return false }
  }

  remove (coverId) {
    if (!coverId) return
    try { fs.unlinkSync(this._file(coverId)) } catch {}
  }

  clear () {
    try {
      for (const f of fs.readdirSync(this.dir)) {
        try { fs.unlinkSync(path.join(this.dir, f)) } catch {}
      }
    } catch {}
  }
}

module.exports = { ArtStore }

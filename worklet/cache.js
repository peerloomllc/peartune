// The on-disk audio cache (milestone 3, phase 5B).
//
// A track played to the end is written through to disk as its bytes stream past the
// shim, so "what you just heard" plays again with no connection - and a queue of cached
// tracks survives going offline. There are two buckets in one directory:
//   - LRU (auto): cached because you played it; evicted oldest-first to stay under a cap.
//   - pinned: an explicit download (phase C); never auto-evicted, never counts to the cap.
//
// The eviction MATH is pure (evictionPlan) so it is unit-tested without touching a disk;
// AudioCache wraps a directory around it with bare-fs (which has the same API in Node, so
// the class is testable against a temp dir too).

// This module runs in TWO runtimes: the Bare worklet (where 'fs'/'path' do not exist -
// you use bare-fs/bare-path) and Node (the unit tests, where bare-path throws because
// there is no Bare global). Pick per runtime; the APIs are the same either way.
const fs = typeof Bare !== 'undefined' ? require('bare-fs') : require('fs')
const path = typeof Bare !== 'undefined' ? require('bare-path') : require('path')

// Which trackIds to drop, oldest-played first, to bring the LRU bucket under `cap`.
// Pinned entries are ignored entirely: they never count toward the cap and are never
// evicted. Returns [] when already under the cap or the cap is falsy (unlimited).
function evictionPlan (index, cap) {
  if (!cap || cap <= 0) return []
  const lru = Object.entries(index).filter(([, e]) => !e.pinned)
  let total = lru.reduce((s, [, e]) => s + (e.size || 0), 0)
  if (total <= cap) return []
  lru.sort((a, b) => (a[1].lastPlayed || 0) - (b[1].lastPlayed || 0)) // oldest first
  const plan = []
  for (const [id, e] of lru) {
    if (total <= cap) break
    plan.push(id)
    total -= e.size || 0
  }
  return plan
}

class AudioCache {
  constructor ({ dir, cap = 0, log = () => {} }) {
    this.dir = dir
    this.indexPath = path.join(dir, 'index.json')
    this.cap = cap
    this.log = log
    this.index = this._load()
  }

  _file (id) { return path.join(this.dir, id) }

  _load () {
    try {
      const o = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'))
      return o && typeof o === 'object' ? o : {}
    } catch {
      return {}
    }
  }

  _save () {
    fs.mkdirSync(this.dir, { recursive: true })
    fs.writeFileSync(this.indexPath, JSON.stringify(this.index))
  }

  has (id) { return !!this.index[id] }
  get (id) { return this.index[id] || null }
  totalBytes () { return Object.values(this.index).reduce((s, e) => s + (e.size || 0), 0) }
  count () { return Object.keys(this.index).length }

  touch (id) {
    const e = this.index[id]
    if (e) { e.lastPlayed = Date.now(); this._save() }
  }

  // Mark a cached track pinned (an explicit download, protected from LRU eviction) or
  // un-pinned (it becomes an ordinary LRU entry again). No-op if not cached.
  setPinned (id, on) {
    const e = this.index[id]
    if (!e) return false
    e.pinned = !!on
    this._save()
    return true
  }
  isPinned (id) { return !!(this.index[id] && this.index[id].pinned) }

  // A write-through sink for ONE full track. Bytes are written to a `.part` file while
  // they also stream to the player; commit() finalizes only if the whole track arrived
  // (a skip mid-download aborts, so a partial file is never marked complete).
  // `library` is the libraryId these bytes came from, recorded so removing ONE library can
  // reclaim its streamed audio. It cannot be derived later: a trackId is a HASH of the
  // libraryId (protocol/ids.js), so once written there is no way back to the library it
  // belongs to. Null is allowed (and is what every entry written before this shipped has) -
  // removeLibrary simply cannot claim those, and the LRU cap ages them out as it always did.
  createSink (id, { mime, size, library = null }) {
    fs.mkdirSync(this.dir, { recursive: true })
    const tmp = this._file(id) + '.part'
    const ws = fs.createWriteStream(tmp)
    let bytes = 0
    let dead = false
    return {
      write: (chunk) => { if (!dead) { bytes += chunk.length; ws.write(chunk) } },
      // Returns true if a complete file was committed.
      commit: () => new Promise((resolve) => {
        if (dead) return resolve(false)
        ws.end(() => {
          // Guard against a short read being stored as if whole.
          if (size && bytes < size) { try { fs.unlinkSync(tmp) } catch {}; return resolve(false) }
          try {
            fs.renameSync(tmp, this._file(id))
            this.index[id] = { size: size || bytes, mime: mime || null, lastPlayed: Date.now(), pinned: false, library: library || null }
            this._save()
            this._evict()
            resolve(true)
          } catch { resolve(false) }
        })
      }),
      abort: () => {
        dead = true
        try { ws.destroy() } catch {}
        try { fs.unlinkSync(tmp) } catch {}
      }
    }
  }

  readStream (id, start, end) {
    return fs.createReadStream(this._file(id), { start, end })
  }

  remove (id) {
    delete this.index[id]
    try { fs.unlinkSync(this._file(id)) } catch {}
  }

  // Persist the index after a batch of remove() calls. remove() deliberately does not save
  // (the eviction loop would then write the file once per entry), so a caller that removes
  // by hand MUST end with this - or the deleted rows come back on the next launch, pointing
  // at files that are no longer there.
  save () { this._save() }

  // Drop every LRU/pinned entry that came from ONE library - what "remove this library"
  // needs in order to give the bytes back while OTHER libraries stay cached.
  //
  // Entries written before `library` was recorded have it null and are NOT claimed by any
  // library: guessing would delete another library's audio, so they are left to the LRU cap
  // exactly as before. `untagged` is returned so the caller can say so honestly in the log.
  removeLibrary (libraryId) {
    if (!libraryId) return { removed: 0, bytes: 0, untagged: 0 }
    let removed = 0
    let bytes = 0
    let untagged = 0
    for (const [id, e] of Object.entries(this.index)) {
      if (!e.library) { untagged++; continue }
      if (e.library !== libraryId) continue
      bytes += e.size || 0
      removed++
      this.remove(id)
    }
    if (removed) this._save()
    return { removed, bytes, untagged }
  }

  clear () {
    for (const id of Object.keys(this.index)) { try { fs.unlinkSync(this._file(id)) } catch {} }
    this.index = {}
    this._save()
    // Sweep any orphaned .part temp files too.
    try {
      for (const f of fs.readdirSync(this.dir)) {
        if (f.endsWith('.part')) { try { fs.unlinkSync(path.join(this.dir, f)) } catch {} }
      }
    } catch {}
  }

  setCap (cap) {
    this.cap = cap
    this._evict()
  }

  // Batch eviction: drop the planned entries, then one save.
  _evict () {
    const plan = evictionPlan(this.index, this.cap)
    if (!plan.length) return
    for (const id of plan) this.remove(id)
    this._save()
    this.log('cache:evicted', { count: plan.length })
  }
}

module.exports = { AudioCache, evictionPlan }

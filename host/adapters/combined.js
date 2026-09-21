'use strict'

// ONE LIBRARY FROM TWO SOURCES: the music source (folder, Subsonic or Jellyfin) plus an
// Audiobookshelf books source beside it (proposal 2026-09-13-audiobookshelf-books-source).
//
// It presents the adapter interface the host already calls, so media.js, cast.js and the
// dashboard do not know there are two. The rules:
//
//   - The music source is the library's identity: kind, libraryId, sorts, narrowing and the
//     folder tree for Sharing all come from it.
//   - list/search with kind 'music' ask the music source only, so music pages and cursors are
//     exactly what they were before a books source existed.
//   - kind 'book' gives the Audiobookshelf books, plus the music source's own books when it
//     has any (a folder marked Audiobooks). Merged and sorted, then paged.
//   - No kind (a phone from before Books) gets the music pages first, then the books, with a
//     cursor of the form 'b:<n>' once it has moved on to the books.
//   - get/art/stream/lyrics go to whichever source owns the id.
//   - A books source that fails its scan must not take the music with it: scan() keeps the
//     music serving and records booksError for the dashboard.
//   - Narrowing (per-person folders) narrows the MUSIC only. Everyone sees every
//     Audiobookshelf book (Tim, 2026-09-13).

const { TRACK_CMP, ALBUM_CMP, ARTIST_CMP, GENRE_CMP, sortRows } = require('./sort')
const { emptyView } = require('../visibility')

const ALL = 100000 // "every row" for sources that page; a books library is far smaller
const TABLES = { albums: ALBUM_CMP, tracks: TRACK_CMP, artists: ARTIST_CMP, genres: GENRE_CMP }
const byName = (a, b) => String(a.name ?? a.title).localeCompare(String(b.name ?? b.title), undefined, { sensitivity: 'base', numeric: true })

class CombinedAdapter {
  constructor ({ music, books, log = () => {} }) {
    this.music = music
    this.booksSource = books
    this.log = log
    this.booksError = null
    this.books = true // caps.books: this library can label books
  }

  get kind () { return this.music.kind }
  get libraryId () { return this.music.libraryId }
  get scannedAt () { return this.music.scannedAt }
  get canNarrow () { return !!this.music.canNarrow }
  get roots () { return this.music.roots }

  rootsForSharing (...a) { return this.music.rootsForSharing(...a) }
  foldersUnder (...a) { return this.music.foldersUnder(...a) }

  // The music source's scan decides whether the library is up; the books scan only decides
  // whether books are there.
  async scan () {
    const n = await this.music.scan()
    let b = 0
    try {
      b = await this.booksSource.scan()
      this.booksError = null
    } catch (e) {
      this.booksError = e.message
      this.log('books:scan-failed', { source: this.booksSource.kind, err: e.message })
    }
    return n + b
  }

  probe () { return this.music.probe() }

  async stats () {
    const m = await this.music.stats()
    const b = this.booksError ? null : await this.booksSource.stats().catch(() => null)
    const add = (k) => (m[k] || 0) + ((b && b[k]) || 0)
    return {
      ...m,
      tracks: add('tracks'),
      albums: add('albums'),
      artists: add('artists'),
      genres: add('genres'),
      books: add('books'),
      booksSource: {
        name: 'Audiobookshelf',
        books: b ? b.books || 0 : 0,
        tracks: b ? b.tracks || 0 : 0,
        error: this.booksError,
        scannedAt: b ? b.scannedAt : null
      }
    }
  }

  // Which source answers for an id. Audiobookshelf ids are minted under its own kind, so
  // they cannot collide with music ids; anything it does not own is the music source's.
  _owner (id) {
    return this.booksSource.owns(id) ? this.booksSource : this.music
  }

  async _allBooks (type, sort, order) {
    const fromBooks = (await this.booksSource.list({ type, limit: ALL, cursor: 0, kind: 'book' })).items
    // Only a source that labels books can be asked for them: Subsonic and Jellyfin ignore
    // `kind` and would answer with the whole music library.
    const fromMusic = this.music.books
      ? (await this.music.list({ type, limit: ALL, cursor: 0, kind: 'book' })).items
      : []
    const rows = [...fromMusic, ...fromBooks]
    const table = TABLES[type]
    return table && table[sort] ? sortRows(rows, table, sort, order) : rows.sort(byName)
  }

  async list (params = {}) {
    const { type = 'tracks', limit = 200, cursor = 0, sort, order, kind } = params
    if (kind === 'music') return this.music.list(params)

    if (kind === 'book') {
      const rows = await this._allBooks(type, sort, order)
      if (type === 'artists' || type === 'genres') return { type, items: rows, nextCursor: null }
      const start = Math.max(0, Number(cursor) || 0)
      const next = start + limit
      return { type, items: rows.slice(start, next), nextCursor: next < rows.length ? next : null }
    }

    // An older phone: every music page, then the Audiobookshelf books.
    if (typeof cursor === 'string' && cursor.startsWith('b:')) {
      const page = await this.booksSource.list({ ...params, cursor: Number(cursor.slice(2)) || 0 })
      return { ...page, nextCursor: page.nextCursor == null ? null : `b:${page.nextCursor}` }
    }
    const page = await this.music.list(params)
    if (type === 'artists' || type === 'genres') {
      const extra = (await this.booksSource.list({ type })).items
      return { ...page, items: [...page.items, ...extra] }
    }
    if (page.nextCursor != null) return page
    return { ...page, nextCursor: this.booksSource.tracks.size ? 'b:0' : null }
  }

  async get (params = {}) {
    if (params.type === 'playlist') return this.music.get(params)
    return this._owner(params.id).get(params)
  }

  async search (params = {}) {
    if (params.kind === 'music') return this.music.search(params)
    const b = await this.booksSource.search(params)
    const m = params.kind === 'book'
      ? (this.music.books ? await this.music.search(params) : { artists: [], albums: [], tracks: [] })
      : await this.music.search(params)
    return {
      artists: [...(m.artists || []), ...b.artists],
      albums: [...(m.albums || []), ...b.albums],
      tracks: [...(m.tracks || []), ...b.tracks]
    }
  }

  art (params = {}) { return this._owner(params.coverId).art(params) }
  stream (params = {}) { return this._owner(params.trackId).stream(params) }

  // Lyrics go to whichever source owns the id, like stream - and a source that has no
  // lyrics() at all (Audiobookshelf) answers null rather than throwing, so a combined
  // library still advertises the cap for its music half.
  lyrics (params = {}) {
    const owner = this._owner(params.trackId)
    return typeof owner?.lyrics === 'function' ? owner.lyrics(params) : null
  }

  // A narrowed person hears only their music folders, and every Audiobookshelf book.
  narrowedView (paths) {
    const view = Object.create(this)
    view.music = typeof this.music.narrowedView === 'function' ? this.music.narrowedView(paths) : emptyView(this.music)
    view.scan = view.probe = () => { throw new Error('a narrowed view cannot scan; scan the adapter') }
    return view
  }
}

module.exports = { CombinedAdapter }

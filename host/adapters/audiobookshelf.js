'use strict'

// Audiobookshelf as a source of BOOKS (proposal 2026-09-13-audiobookshelf-books-source).
//
// Everything this adapter serves is a book: every album, track, author and genre carries
// kind:'book'. It is meant to sit BESIDE a music source (host/adapters/combined.js), but it
// speaks the same adapter interface as the others, so it can be tested and probed alone.
//
// The index lives in memory, like the folder adapter's, rather than asking the server per
// request like Jellyfin: a book library is small next to a music library, a book's files and
// chapters come from one detail call, and holding them lets get/art/stream find the book a
// PearTune id belongs to without a round trip.
//
// Mapping (checked against Audiobookshelf 2.36.0):
//   library item (a book)  -> album   name = title, artist = author, year = publishedYear
//   media.tracks[i]        -> track   one per audio file, in the book's order
//   media.chapters         -> chapters on each track, cut to that file's time window
//   author / genre         -> artist / genre
// Podcast libraries are skipped; every book library on the server is served (Tim, 2026-09-13).

const { trackId, groupId } = require('../../protocol/ids')
const { hasFfmpeg, spawnTranscode } = require('../transcode')
const { TRACK_CMP, ALBUM_CMP, ARTIST_CMP, GENRE_CMP, FULL_SORTS, sortRows } = require('./sort')

const PAGE = 200 // items per list call
const DETAIL_CONCURRENCY = 4 // book detail calls at once, so a scan does not flood a Pi

const clean = (s) => {
  if (s == null) return null
  const t = String(s).replace(/\0/g, '').trim().replace(/\s+/g, ' ')
  return t || null
}
const lower = (s) => String(s || '').toLowerCase()
const UNKNOWN_AUTHOR = 'Unknown Author'

// A file's chapters out of the book's: the ones that START inside [offset, offset + duration),
// shifted to the file's own clock. Half a second of slack at the front, because a chapter
// that starts exactly on a file boundary is often a few milliseconds early in the metadata.
// One chapter in a file is not a chapter list (a book in parts gets one per file), so fewer
// than two comes back as none.
function chaptersForTrack (bookChapters, offsetSec, durationSec) {
  const out = []
  for (const c of bookChapters || []) {
    const start = Number(c.start)
    if (!Number.isFinite(start)) continue
    if (start >= offsetSec - 0.5 && start < offsetSec + durationSec - 0.5) {
      out.push({ title: clean(c.title) || `Chapter ${out.length + 1}`, startMs: Math.max(0, Math.round((start - offsetSec) * 1000)) })
    }
  }
  out.sort((a, b) => a.startMs - b.startMs)
  return out.length >= 2 ? out : []
}

class AudiobookshelfAdapter {
  constructor ({ url, apiKey, username, password, libraryId, log = () => {} }) {
    this.base = String(url || '').replace(/\/+$/, '')
    this.apiKey = apiKey || null
    this.username = username || null
    this.password = password || null
    this.libraryId = libraryId
    this.kind = 'audiobookshelf'
    this.books = true
    this.log = log

    this.token = this.apiKey
    this._authing = null
    this._reset()
    this.scannedAt = null
    this.serverVersion = null
  }

  _reset () {
    this.tracks = new Map() // trackId -> track (with _abs)
    this.albums = new Map()
    this.artists = new Map()
    this.genres = new Map()
    this.covers = new Map() // coverId -> Audiobookshelf item id
    this._sorted = { albums: [], artists: [], genres: [], tracks: [] }
    this._sortCache = new Map()
  }

  // --- HTTP -------------------------------------------------------------------

  // An API key is used as it is. A username/password logs in for an access token, which
  // expires (a saved one was dead within a day), so a 401 logs in again ONCE.
  async _auth () {
    if (this.token) return this.token
    if (!this.username) throw new Error('audiobookshelf: an API key or a username and password is needed')
    if (this._authing) return this._authing
    this._authing = (async () => {
      const res = await fetch(`${this.base}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-return-tokens': 'true' },
        body: JSON.stringify({ username: this.username, password: this.password || '' })
      })
      if (res.status === 401) throw new Error('audiobookshelf: wrong username or password')
      if (!res.ok) throw new Error(`audiobookshelf: login failed (HTTP ${res.status})`)
      const body = await res.json()
      const token = body?.user?.accessToken || body?.user?.token
      if (!token) throw new Error('audiobookshelf: login returned no token')
      this.token = token
      this.serverVersion = body?.serverSettings?.version || this.serverVersion
      return token
    })().finally(() => { this._authing = null })
    return this._authing
  }

  _headers (extra = {}) {
    return { authorization: `Bearer ${this.token}`, ...extra }
  }

  _url (route, params = {}) {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')
    return `${this.base}${route}${qs ? '?' + qs : ''}`
  }

  // fetch with auth, and one re-login on 401 when we log in with a password.
  async _fetch (route, params, init = {}) {
    await this._auth()
    const go = () => fetch(this._url(route, params), { ...init, headers: this._headers(init.headers) })
    let res = await go()
    if (res.status === 401 && this.username) {
      this.token = null
      await this._auth()
      res = await go()
    }
    if (res.status === 401) throw new Error('audiobookshelf: the API key or login was refused')
    return res
  }

  async _json (route, params) {
    const res = await this._fetch(route, params, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`audiobookshelf ${route}: HTTP ${res.status}`)
    return res.json()
  }

  // --- scan -------------------------------------------------------------------

  async _bookLibraries () {
    const body = await this._json('/api/libraries')
    return (body.libraries || []).filter(l => l.mediaType === 'book')
  }

  async scan () {
    const libs = await this._bookLibraries()
    const ids = []
    for (const lib of libs) {
      let seen = 0
      for (let page = 0; ; page++) {
        const body = await this._json(`/api/libraries/${lib.id}/items`, { limit: PAGE, page })
        const results = body.results || []
        seen += results.length
        for (const r of results) if (!r.isMissing && !r.isInvalid) ids.push(r.id)
        if (results.length < PAGE || seen >= (body.total || 0)) break
      }
    }

    const items = []
    let next = 0
    const worker = async () => {
      while (next < ids.length) {
        const id = ids[next++]
        try {
          items.push(await this._json(`/api/items/${id}`, { expanded: 1 }))
        } catch (e) {
          // One unreadable book must not cost the rest of the library.
          this.log('audiobookshelf:item-failed', { id, error: e.message })
        }
      }
    }
    await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker))

    this._build(items)
    this.scannedAt = Date.now()
    this.log('audiobookshelf:scanned', { libraries: libs.length, books: this.albums.size, tracks: this.tracks.size })
    return this.tracks.size
  }

  _build (items) {
    this._reset()
    for (const item of items) {
      const media = item?.media
      if (!media || !Array.isArray(media.tracks) || !media.tracks.length) continue
      const md = media.metadata || {}
      const title = clean(md.title) || clean(item.relPath) || 'Untitled'
      const author = clean(md.authorName) || clean(md.authors?.[0]?.name) || UNKNOWN_AUTHOR
      const year = Number.parseInt(md.publishedYear, 10) || null
      const genre = clean(md.genres?.[0])

      const albumId = groupId(this.libraryId, this.kind, 'album', item.id)
      const artistId = groupId(this.libraryId, this.kind, 'artist', lower(author))
      this.covers.set(albumId, item.id)

      const album = {
        id: albumId,
        name: title,
        artist: author,
        artistId,
        year,
        addedAt: Number(item.addedAt) || null,
        coverId: albumId,
        songCount: 0,
        kind: 'book',
        trackIds: []
      }

      const ordered = [...media.tracks].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      for (const t of ordered) {
        if (t.exclude) continue
        const id = trackId(this.libraryId, this.kind, `${item.id}/${t.ino}`)
        const filename = t.metadata?.filename || t.title || ''
        const ext = String(t.metadata?.ext || (filename.includes('.') ? '.' + filename.split('.').pop() : '')).replace(/^\./, '').toLowerCase()
        const offset = Number(t.startOffset) || 0
        const duration = Number(t.duration) || 0
        const chapters = chaptersForTrack(media.chapters, offset, duration)
        const track = {
          id,
          title: clean(t.metaTags?.tagTitle) || clean(filename.replace(/\.[^.]+$/, '')) || title,
          artist: author,
          album: title,
          albumId,
          artistId,
          track: t.index ?? null,
          disc: null,
          year,
          genre,
          durationMs: duration ? Math.round(duration * 1000) : null,
          size: Number(t.metadata?.size) || null,
          coverId: albumId,
          suffix: ext || null,
          addedAt: Number(t.addedAt) || album.addedAt,
          kind: 'book',
          path: `${item.relPath || title}/${filename}`,
          ...(chapters.length ? { chapters } : {}),
          _abs: { itemId: item.id, ino: t.ino, mime: t.mimeType || null }
        }
        this.tracks.set(id, track)
        album.trackIds.push(id)
      }
      if (!album.trackIds.length) continue
      album.songCount = album.trackIds.length
      this.albums.set(albumId, album)

      let artist = this.artists.get(artistId)
      if (!artist) this.artists.set(artistId, (artist = { id: artistId, name: author, albumIds: [], albumCount: 0, coverId: albumId, kind: 'book' }))
      artist.albumIds.push(albumId)
      artist.albumCount = artist.albumIds.length

      if (genre) {
        const gid = groupId(this.libraryId, this.kind, 'genre', lower(genre))
        let g = this.genres.get(gid)
        if (!g) this.genres.set(gid, (g = { id: gid, name: genre, albumIds: [], albumCount: 0, coverId: albumId, kind: 'book' }))
        g.albumIds.push(albumId)
        g.albumCount = g.albumIds.length
      }
    }

    const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base', numeric: true })
    this._sorted.albums = [...this.albums.values()].sort(byName)
    this._sorted.artists = [...this.artists.values()].sort(byName)
    this._sorted.genres = [...this.genres.values()].sort(byName)
    this._sorted.tracks = this._sorted.albums.flatMap(a => a.trackIds.map(t => this.tracks.get(t)))
  }

  // Can we reach it, and does it have books? Strict: a wrong key or URL throws a sentence.
  async probe () {
    const libs = await this._bookLibraries()
    let total = 0
    for (const lib of libs) {
      const body = await this._json(`/api/libraries/${lib.id}/items`, { limit: 1, page: 0 })
      total += body.total || 0
    }
    return { books: total, libraries: libs.length }
  }

  async ping () {
    await this._json('/api/libraries')
    return true
  }

  async stats () {
    return {
      source: this.kind,
      sourceName: 'Audiobookshelf',
      root: this.base,
      tracks: this.tracks.size,
      albums: this.albums.size,
      artists: this.artists.size,
      genres: this.genres.size,
      books: this.albums.size,
      sorts: FULL_SORTS,
      scannedAt: this.scannedAt
    }
  }

  // --- read -------------------------------------------------------------------

  _pub (t) {
    if (!t) return null
    const { _abs, ...pub } = t
    return pub
  }

  _albumRow (a) {
    return { id: a.id, name: a.name, artist: a.artist, year: a.year, songCount: a.songCount, addedAt: a.addedAt, coverId: a.coverId, kind: 'book' }
  }

  // Everything here is a book: kind 'music' is empty, 'book' or none is everything.
  _order (type, rows, table, sort, order) {
    if (!table[sort]) return rows
    const key = `${type}|${sort}|${order === 'desc' ? 'desc' : 'asc'}`
    let out = this._sortCache.get(key)
    if (!out) this._sortCache.set(key, (out = sortRows(rows, table, sort, order)))
    return out
  }

  async list ({ type = 'tracks', limit = 200, cursor = 0, sort, order, kind } = {}) {
    const start = Math.max(0, Number(cursor) || 0)
    const none = kind === 'music'
    const page = (all, map) => {
      const rows = none ? [] : all
      const items = rows.slice(start, start + limit).map(map)
      const next = start + limit
      return { type, items, nextCursor: next < rows.length ? next : null }
    }
    if (type === 'albums') return page(this._order('albums', this._sorted.albums, ALBUM_CMP, sort, order), a => this._albumRow(a))
    if (type === 'tracks') return page(this._order('tracks', this._sorted.tracks, TRACK_CMP, sort, order), t => this._pub(t))
    if (type === 'artists') {
      const rows = none ? [] : this._order('artists', this._sorted.artists, ARTIST_CMP, sort, order)
      return { type, items: rows.map(a => ({ id: a.id, name: a.name, albumCount: a.albumCount, coverId: a.coverId, kind: 'book' })), nextCursor: null }
    }
    if (type === 'genres') {
      const rows = none ? [] : this._order('genres', this._sorted.genres, GENRE_CMP, sort, order)
      return { type, items: rows.map(g => ({ id: g.id, name: g.name, albumCount: g.albumCount, coverId: g.coverId, kind: 'book' })), nextCursor: null }
    }
    return { type, items: [], nextCursor: null }
  }

  async get ({ id, type = 'track' } = {}) {
    if (type === 'album') {
      const a = this.albums.get(id)
      if (!a) return null
      return { ...this._albumRow(a), tracks: a.trackIds.map(t => this._pub(this.tracks.get(t))).filter(Boolean) }
    }
    if (type === 'artist' || type === 'genre') {
      const g = (type === 'artist' ? this.artists : this.genres).get(id)
      if (!g) return null
      return {
        id: g.id,
        name: g.name,
        coverId: g.coverId,
        kind: 'book',
        albums: g.albumIds.map(x => this.albums.get(x)).filter(Boolean).map(a => this._albumRow(a)),
        tracks: []
      }
    }
    if (type === 'playlist') return null
    return this._pub(this.tracks.get(id))
  }

  async search ({ q = '', limit = 50, kind } = {}) {
    const needle = lower(clean(q) || '')
    if (!needle || kind === 'music') return { artists: [], albums: [], tracks: [] }
    const hit = (s) => lower(s).includes(needle)
    return {
      artists: this._sorted.artists.filter(a => hit(a.name)).slice(0, limit)
        .map(a => ({ id: a.id, name: a.name, albumCount: a.albumCount, coverId: a.coverId, kind: 'book' })),
      albums: this._sorted.albums.filter(a => hit(a.name) || hit(a.artist)).slice(0, limit).map(a => this._albumRow(a)),
      tracks: this._sorted.tracks.filter(t => hit(t.title) || hit(t.album) || hit(t.artist)).slice(0, limit).map(t => this._pub(t))
    }
  }

  // Ids this adapter owns, for the combined adapter's routing.
  owns (id) {
    return this.tracks.has(id) || this.albums.has(id) || this.artists.has(id) || this.genres.has(id) || this.covers.has(id)
  }

  async art ({ coverId, size } = {}) {
    const itemId = this.covers.get(coverId)
    if (!itemId) return null
    const res = await this._fetch(`/api/items/${itemId}/cover`, { width: size || undefined })
    if (!res.ok) return null // 404: a book with no cover, the app draws its own
    return res.body
  }

  async stream ({ trackId: id, offset = 0, length, format, bitrate, timeOffsetMs } = {}) {
    const t = this.tracks.get(id)
    if (!t) return null
    const route = `/api/items/${t._abs.itemId}/file/${t._abs.ino}`

    // A transcode reads the file's URL itself rather than a pipe: a book's index is often at
    // the END of an m4b, which ffmpeg can only reach by seeking, and a pipe cannot seek.
    if ((format || bitrate) && await hasFfmpeg()) {
      await this._auth()
      const out = spawnTranscode(this._url(route), {
        format,
        bitrate,
        timeOffsetMs,
        headers: { Authorization: `Bearer ${this.token}` },
        log: (ev, d) => this.log('audiobookshelf:' + ev, d)
      })
      if (out) return out
    }

    const headers = {}
    if (offset > 0 || length) {
      const end = length ? offset + Number(length) - 1 : ''
      headers.range = `bytes=${offset}-${end}`
    }
    const res = await this._fetch(route, undefined, { headers })
    if (!res.ok && res.status !== 206) return null
    return res.body
  }
}

module.exports = { AudiobookshelfAdapter, chaptersForTrack }

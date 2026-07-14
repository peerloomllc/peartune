// Navidrome (Subsonic API) source adapter.
//
// The point of connecting to an existing server instead of just reading the
// folder: it already did the hard part. Scanning, tags, artwork, album/artist
// grouping and ON-THE-FLY TRANSCODING all come for free, which is why we ship no
// ffmpeg. See DECISIONS 2026-07-13 (bitrate).
//
// Auth is Subsonic token auth: t = md5(password + salt), with a fresh salt per
// request. The password itself never crosses the wire, not even to localhost.
//
// This adapter satisfies the SAME interface as FolderAdapter, and the phone
// cannot tell which one is behind the media API. That is deliberate: it keeps
// the raw-folder path a first-class citizen rather than a fallback nobody tests.

const crypto = require('crypto')
const { trackId } = require('../../protocol/ids')

const API_VERSION = '1.16.1'
const CLIENT = 'peartune'

class NavidromeAdapter {
  constructor ({ url, username, password, libraryId }) {
    this.base = String(url).replace(/\/+$/, '')
    this.username = username
    this.password = password
    this.libraryId = libraryId
    this.kind = 'navidrome'
    this.scannedAt = null

    // trackId -> the Subsonic song id, so media.stream can map back. Populated as
    // we list/search; a track we have never seen is fetched on demand.
    this.songIds = new Map()
    this._counts = null
  }

  // A fresh salt per call: a captured (t, s) pair cannot be replayed against a
  // different salt, and the password is never sent.
  _auth () {
    const salt = crypto.randomBytes(8).toString('hex')
    const token = crypto.createHash('md5').update(this.password + salt).digest('hex')
    return `u=${encodeURIComponent(this.username)}&t=${token}&s=${salt}&v=${API_VERSION}&c=${CLIENT}&f=json`
  }

  _url (method, params = {}) {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&')
    return `${this.base}/rest/${method}?${this._auth()}${qs ? '&' + qs : ''}`
  }

  async _call (method, params) {
    const res = await fetch(this._url(method, params))
    if (!res.ok) throw new Error(`navidrome ${method}: HTTP ${res.status}`)
    const body = await res.json()
    const sr = body['subsonic-response']
    if (!sr) throw new Error(`navidrome ${method}: malformed response`)
    if (sr.status === 'failed') {
      throw new Error(`navidrome ${method}: ${sr.error?.message || 'failed'} (code ${sr.error?.code})`)
    }
    return sr
  }

  async ping () {
    await this._call('ping')
    return true
  }

  // Map a Subsonic song to our normalized shape. `id` is OUR trackId (stable,
  // library-scoped); `songIds` remembers the Subsonic id behind it.
  _track (song) {
    const id = trackId(this.libraryId, this.kind, song.id)
    this.songIds.set(id, song.id)
    return {
      id,
      title: song.title || song.path || 'Unknown',
      artist: song.artist || null,
      album: song.album || null,
      track: song.track ?? null,
      year: song.year ?? null,
      durationMs: song.duration ? song.duration * 1000 : null,
      size: song.size ?? 0,
      coverId: song.coverArt || song.albumId || null,
      suffix: song.suffix || null
    }
  }

  async scan () {
    // Navidrome already scanned. We just confirm we can talk to it and cache the
    // counts - failing loudly HERE, at boot, rather than on a user's first tap.
    await this.ping()
    const sr = await this._call('getScanStatus').catch(() => null)
    this.scannedAt = Date.now()
    this._counts = sr?.scanStatus?.count ?? null
    return this._counts ?? 0
  }

  async stats () {
    let tracks = this._counts ?? 0
    if (!tracks) {
      const sr = await this._call('getScanStatus').catch(() => null)
      tracks = sr?.scanStatus?.count ?? 0
    }
    return {
      source: this.kind,
      root: this.base,
      tracks,
      albums: 0,
      artists: 0,
      scannedAt: this.scannedAt
    }
  }

  async list ({ type = 'albums', limit = 100, cursor = 0 } = {}) {
    const offset = Number(cursor) || 0

    if (type === 'artists') {
      const sr = await this._call('getArtists')
      const items = (sr.artists?.index || []).flatMap(i => i.artist || []).map(a => ({
        id: a.id,
        name: a.name,
        albumCount: a.albumCount ?? null,
        coverId: a.coverArt || null
      }))
      return { type, items, nextCursor: null }
    }

    if (type === 'albums') {
      const sr = await this._call('getAlbumList2', {
        type: 'alphabeticalByName',
        size: limit,
        offset
      })
      const list = sr.albumList2?.album || []
      const items = list.map(a => ({
        id: a.id,
        name: a.name,
        artist: a.artist || null,
        year: a.year ?? null,
        songCount: a.songCount ?? null,
        coverId: a.coverArt || a.id
      }))
      return { type, items, nextCursor: list.length === limit ? offset + limit : null }
    }

    if (type === 'tracks') {
      // Subsonic has no flat "all songs" call, so a flat track list means walking
      // albums. Fine for the milestone-1 UI; the real UI browses albums.
      const sr = await this._call('getAlbumList2', {
        type: 'alphabeticalByName',
        size: Math.min(limit, 50),
        offset
      })
      const albums = sr.albumList2?.album || []
      const items = []
      for (const a of albums) {
        const full = await this._call('getAlbum', { id: a.id })
        for (const song of full.album?.song || []) {
          items.push(this._track(song))
          if (items.length >= limit) break
        }
        if (items.length >= limit) break
      }
      return { type, items, nextCursor: albums.length ? offset + albums.length : null }
    }

    if (type === 'playlists') {
      const sr = await this._call('getPlaylists')
      const items = (sr.playlists?.playlist || []).map(p => ({
        id: p.id,
        name: p.name,
        songCount: p.songCount ?? null
      }))
      return { type, items, nextCursor: null }
    }

    return { type, items: [], nextCursor: null }
  }

  async get ({ id, type = 'track' }) {
    if (type === 'album') {
      const sr = await this._call('getAlbum', { id })
      const a = sr.album
      if (!a) return null
      return {
        id: a.id,
        name: a.name,
        artist: a.artist || null,
        year: a.year ?? null,
        coverId: a.coverArt || a.id,
        tracks: (a.song || []).map(s => this._track(s))
      }
    }

    // A track, by OUR id. The shim calls this for the file size, so it must work
    // for an id we have not listed this session (e.g. after a host restart).
    const songId = await this._songId(id)
    if (!songId) return null
    const sr = await this._call('getSong', { id: songId })
    return sr.song ? this._track(sr.song) : null
  }

  async _songId (ourId) {
    const known = this.songIds.get(ourId)
    if (known) return known

    // Not in the cache. We cannot invert the hash, so walk the library once and
    // rebuild the mapping. This only happens after a restart, and only until the
    // track is seen again.
    let offset = 0
    for (;;) {
      const sr = await this._call('getAlbumList2', { type: 'alphabeticalByName', size: 50, offset })
      const albums = sr.albumList2?.album || []
      if (!albums.length) return null

      for (const a of albums) {
        const full = await this._call('getAlbum', { id: a.id })
        for (const song of full.album?.song || []) {
          const mapped = trackId(this.libraryId, this.kind, song.id)
          this.songIds.set(mapped, song.id)
          if (mapped === ourId) return song.id
        }
      }
      offset += albums.length
    }
  }

  async search ({ q = '', limit = 50 } = {}) {
    const sr = await this._call('search3', {
      query: q,
      songCount: limit,
      albumCount: limit,
      artistCount: limit
    })
    const r = sr.searchResult3 || {}
    return {
      artists: (r.artist || []).map(a => ({ id: a.id, name: a.name })),
      albums: (r.album || []).map(a => ({
        id: a.id, name: a.name, artist: a.artist || null, coverId: a.coverArt || a.id
      })),
      tracks: (r.song || []).map(s => this._track(s))
    }
  }

  async art ({ coverId, size }) {
    if (!coverId) return null
    const res = await fetch(this._url('getCoverArt', { id: coverId, size }))
    if (!res.ok) return null
    // Navidrome answers a 200 with an image body; hand the byte stream straight
    // to the media channel.
    return res.body
  }

  // Range support: for DIRECT PLAY we pass the HTTP Range straight through, so
  // seeking works exactly as it does with the folder adapter.
  //
  // For a TRANSCODED stream there are no stable byte offsets to seek to - the
  // bytes do not exist until Navidrome makes them - so a range request while
  // transcoding is best-effort. Known v1 limitation; the client only asks for
  // transcoding on cellular, where it also tends not to scrub.
  async stream ({ trackId: id, offset = 0, length, format, bitrate } = {}) {
    const songId = await this._songId(id)
    if (!songId) return null

    const transcoding = !!(format || bitrate)
    const url = this._url('stream', {
      id: songId,
      maxBitRate: bitrate,
      format,
      // Ask Navidrome NOT to transcode unless we explicitly want it, so the
      // default path is exact original bytes.
      ...(transcoding ? {} : { format: 'raw' })
    })

    const headers = {}
    if (offset > 0 || length) {
      const end = length ? offset + Number(length) - 1 : ''
      headers.range = `bytes=${offset}-${end}`
    }

    const res = await fetch(url, { headers })
    if (!res.ok && res.status !== 206) return null
    return res.body
  }
}

module.exports = { NavidromeAdapter }

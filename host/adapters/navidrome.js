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

    // HOW WE AUTHENTICATE, and it is not one-size-fits-all across Subsonic servers.
    //
    // 'token' is the salted-token scheme: t = md5(password + salt), fresh salt per
    // request, and the PASSWORD NEVER CROSSES THE WIRE. It is strictly better, so it
    // is the default and what Navidrome/Airsonic/Gonic/Ampache use.
    //
    // But it is OPTIONAL in the spec, and some servers refuse it with error 41
    // ("token authentication not supported") - Nextcloud/ownCloud Music and LMS are
    // the common ones. For those we fall back to sending the password itself,
    // hex-encoded as `p=enc:<hex>` (the spec's obfuscated form - not encryption, just
    // not plaintext in a log). We flip to it automatically on the first 41 and
    // remember, so it costs one retry, once.
    this._authMode = 'token' // 'token' | 'password'
    this.songIds = new Map()
    this._counts = null
  }

  // The credential half of the query string, in whichever scheme this server accepts.
  //
  // token:    t = md5(password + salt), fresh salt per call. A captured (t, s) pair
  //           cannot be replayed against a different salt, and the password is never
  //           sent. Preferred.
  // password: p = enc:<hex of password>. For servers that reject tokens (Nextcloud
  //           Music, LMS). The password rides along on every request; on a home LAN
  //           that is what every Subsonic client does, but it is why token is default.
  _auth () {
    const base = `u=${encodeURIComponent(this.username)}&v=${API_VERSION}&c=${CLIENT}&f=json`
    if (this._authMode === 'password') {
      const hex = Buffer.from(String(this.password), 'utf8').toString('hex')
      return `${base}&p=enc:${hex}`
    }
    const salt = crypto.randomBytes(8).toString('hex')
    const token = crypto.createHash('md5').update(this.password + salt).digest('hex')
    return `${base}&t=${token}&s=${salt}`
  }

  _url (method, params = {}) {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&')
    return `${this.base}/rest/${method}?${this._auth()}${qs ? '&' + qs : ''}`
  }

  async _call (method, params) {
    let sr = await this._fetch(method, params)

    // Error 41 is "token authentication not supported". It is the server telling us,
    // on the first call, that it is a Nextcloud/LMS-class server. Flip to sending the
    // password and retry ONCE - then remember, so every later call goes straight there.
    if (sr.status === 'failed' && sr.error?.code === 41 && this._authMode === 'token') {
      this._authMode = 'password'
      sr = await this._fetch(method, params)
    }

    if (sr.status === 'failed') {
      throw new Error(`navidrome ${method}: ${sr.error?.message || 'failed'} (code ${sr.error?.code})`)
    }
    return sr
  }

  async _fetch (method, params) {
    const res = await fetch(this._url(method, params))
    if (!res.ok) throw new Error(`navidrome ${method}: HTTP ${res.status}`)
    const body = await res.json()
    const sr = body['subsonic-response']
    if (!sr) throw new Error(`navidrome ${method}: malformed response`)
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

  // "Does this work?", for the dashboard's Test button. For Navidrome that is the
  // same work as a scan - it already did the scanning - so this is scan() by
  // another name. The FOLDER adapter is where the two genuinely differ.
  async probe () {
    return { tracks: await this.scan() }
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
      // Subsonic proper has no "all songs" call - which is why this used to walk
      // albums, and why a flat list could only ever show the first page of them.
      //
      // Navidrome (OpenSubsonic) does answer `search3` with an EMPTY query as
      // "everything", and it pages by songOffset. Measured against the real
      // library: all 1358 songs, and songOffset=1000 returns the expected rows. So
      // the Songs view is a paged list, not a 60-call album walk.
      //
      // The order is the SERVER's (roughly artist / album / track). We do not get
      // to sort by title without pulling the whole library into memory first, and
      // we are not doing that for a phone.
      try {
        const sr = await this._call('search3', {
          query: '',
          songCount: limit,
          songOffset: offset,
          albumCount: 0,
          artistCount: 0
        })
        const songs = sr.searchResult3?.song || []
        // A server that refuses an empty query answers with nothing. Only trust
        // "no songs" as an answer once we are past the first page - otherwise an
        // empty first page is indistinguishable from "not supported", and we fall
        // through to the walk below.
        if (songs.length || offset > 0) {
          return {
            type,
            items: songs.map(s => this._track(s)),
            nextCursor: songs.length === limit ? offset + limit : null
          }
        }
      } catch {
        // Not an error worth surfacing: it just means this server is stricter than
        // Navidrome. Walk the albums instead.
      }

      // Fallback for a strict Subsonic server: walk albums. Slow, and it cannot
      // page songs properly (the cursor counts ALBUMS), but it is honest.
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
    // An artist IS its albums. getArtist returns them in one call, so browsing by
    // artist costs the same round trip as browsing by album - no walking.
    if (type === 'artist') {
      const sr = await this._call('getArtist', { id })
      const a = sr.artist
      if (!a) return null

      const albums = (a.album || []).map(al => ({
        id: al.id,
        name: al.name,
        artist: al.artist || a.name,
        year: al.year ?? null,
        songCount: al.songCount ?? null,
        coverId: al.coverArt || al.id
      }))

      const out = { id: a.id, name: a.name, coverId: a.coverArt || null, albums, tracks: [] }
      if (albums.length) return out

      // AN ARTIST WITH NO ALBUMS IS NOT A BUG, AND IT IS NOT EMPTY.
      //
      // Navidrome mints an artist row for every composite tag string it meets -
      // "Thousand Foot Krutch/COFER", "Artist/Remixer" - and those rows have zero
      // albums of their own (the album belongs to the primary artist). They DO have
      // songs. Search happily returns them, so without this the artist page is a
      // dead end that says nothing, and "Add to queue" fails with "nothing to play".
      //
      // There is no getSongsByArtist in Subsonic, and getTopSongs answers empty for
      // these (tried it). search3 on the exact name is what works - filtered to an
      // EXACT artist match, because a substring search for "Thousand Foot Krutch"
      // would drag in the other artist's entire catalogue.
      const s = await this._call('search3', {
        query: a.name,
        songCount: 200,
        albumCount: 0,
        artistCount: 0
      }).catch(() => null)

      out.tracks = (s?.searchResult3?.song || [])
        .filter(song => song.artist === a.name)
        .map(song => this._track(song))

      return out
    }

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
      // REAL ARTISTS FIRST.
      //
      // Navidrome mints an artist row for every composite tag it meets, so a search
      // for "krutch" returns ONE artist with 18 albums and NINETEEN participant
      // rows ("Thousand Foot Krutch/COFER", ".../Red", ...) - and the server's order
      // buries the real one among them. Sorting by album count puts the artist you
      // were obviously looking for at the top and the featured-on entries below,
      // where they are still reachable.
      //
      // coverArt is only carried for artists that HAVE albums: Navidrome answers
      // the participant rows with its default white-star image, and a wall of those
      // looks worse than our own placeholder.
      artists: (r.artist || [])
        .map(a => ({
          id: a.id,
          name: a.name,
          albumCount: a.albumCount ?? 0,
          coverId: (a.albumCount ?? 0) > 0 ? (a.coverArt || null) : null
        }))
        .sort((x, y) => y.albumCount - x.albumCount),
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

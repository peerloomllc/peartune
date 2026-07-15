// Jellyfin source adapter.
//
// The third source, and the second SERVER one. Like Navidrome it already did the
// hard part - scanning, tags, artwork, album/artist grouping and transcoding - so
// this file is mostly mapping: Jellyfin's shapes into ours.
//
// It satisfies the SAME interface as FolderAdapter and SubsonicAdapter, and the
// phone cannot tell which is behind the media API. That is the property that makes
// a new source a day of work instead of a milestone, and it is worth defending.
//
// AUTH: username + password, exchanged ONCE for an access token that does not
// expire until it is revoked. No cloud, no refresh loop, no third party - which is
// exactly the sentence that could not be written about Plex (DECISIONS 2026-07-14).
//
// The token is held in memory only. The PASSWORD is what we persist (source.json,
// 0600), because a token we cached and could not refresh would strand the library
// on the first restart after the operator logged us out somewhere else.

const crypto = require('crypto')
const { trackId } = require('../../protocol/ids')

const CLIENT = 'PearTune'
const VERSION = '0.1.0'

// Jellyfin's clock is 100-nanosecond ticks (a .NET TimeSpan), so a three-minute
// song is 1,800,000,000 of them. Divide by 10,000 for milliseconds.
const TICKS_PER_MS = 10000

// The fields Jellyfin will not send unless asked. `MediaSources` is the load-bearing
// one: it carries the file SIZE, and the phone's loopback shim needs a content-length
// before it will let ExoPlayer seek. Without it the player can only play forward.
const TRACK_FIELDS = 'MediaSources,ParentId,ProductionYear,Path'
const ALBUM_FIELDS = 'ProductionYear,ChildCount,ParentId'

class JellyfinAdapter {
  constructor ({ url, username, password, libraryId, log = () => {} }) {
    this.base = String(url || '').replace(/\/+$/, '')
    this.username = username
    this.password = password
    this.libraryId = libraryId
    this.kind = 'jellyfin'
    this.log = log

    this.token = null
    this.userId = null
    this.scannedAt = null
    this._counts = null

    // A STABLE device id. Jellyfin lists every device that has ever authenticated
    // in its dashboard, and a fresh uuid per connection would fill that list with
    // hundreds of ghost PearTunes. Derived from the library, so it survives a
    // restart and stays unique between two hosts pointed at one Jellyfin.
    this.deviceId = 'peartune-' + crypto.createHash('sha256')
      .update(String(libraryId || 'peartune'))
      .digest('hex')
      .slice(0, 16)

    // Our trackId -> Jellyfin's item id. Populated as we list and search; a track we
    // have never seen is looked up on demand (see _itemId).
    this.itemIds = new Map()
    this._authing = null
  }

  // Jellyfin wants its client identity in the Authorization header on EVERY request,
  // authenticated or not. The token joins it once we have one.
  _authHeader () {
    const parts = [
      `Client="${CLIENT}"`,
      'Device="PearTune host"',
      `DeviceId="${this.deviceId}"`,
      `Version="${VERSION}"`
    ]
    if (this.token) parts.push(`Token="${this.token}"`)
    return 'MediaBrowser ' + parts.join(', ')
  }

  // One login, shared. A cold host answering a screen's worth of art requests would
  // otherwise fire twenty simultaneous logins at the Jellyfin and get twenty
  // sessions back.
  async _auth () {
    if (this.token) return this.token
    if (this._authing) return this._authing

    this._authing = (async () => {
      const res = await fetch(`${this.base}/Users/AuthenticateByName`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: this._authHeader()
        },
        body: JSON.stringify({ Username: this.username, Pw: this.password })
      })

      if (res.status === 401) throw new Error('jellyfin: wrong username or password')
      if (!res.ok) throw new Error(`jellyfin: login failed (HTTP ${res.status})`)

      const body = await res.json()
      if (!body.AccessToken || !body.User?.Id) throw new Error('jellyfin: login returned no token')

      this.token = body.AccessToken
      this.userId = body.User.Id
      this.log('jellyfin:authenticated', { user: body.User.Name })
      return this.token
    })().finally(() => { this._authing = null })

    return this._authing
  }

  _url (route, params = {}) {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')
    return `${this.base}${route}${qs ? '?' + qs : ''}`
  }

  async _call (route, params) {
    await this._auth()
    const res = await fetch(this._url(route, params), {
      headers: { authorization: this._authHeader(), accept: 'application/json' }
    })

    // The token was revoked (the operator logged this device out in Jellyfin's own
    // dashboard). We hold the password, so we can simply log in again - ONCE. A
    // retry loop here would hammer a server that is telling us to go away.
    if (res.status === 401) {
      this.token = null
      await this._auth()
      const again = await fetch(this._url(route, params), {
        headers: { authorization: this._authHeader(), accept: 'application/json' }
      })
      if (!again.ok) throw new Error(`jellyfin ${route}: HTTP ${again.status}`)
      return again.json()
    }

    if (!res.ok) throw new Error(`jellyfin ${route}: HTTP ${res.status}`)
    return res.json()
  }

  // --- mapping --------------------------------------------------------------

  _track (item) {
    const id = trackId(this.libraryId, this.kind, item.Id)
    this.itemIds.set(id, item.Id)

    const media = item.MediaSources?.[0] || {}

    return {
      id,
      title: item.Name || 'Unknown',
      artist: item.Artists?.[0] || item.AlbumArtist || null,
      album: item.Album || null,
      track: item.IndexNumber ?? null,
      disc: item.ParentIndexNumber ?? null,
      year: item.ProductionYear ?? null,
      durationMs: item.RunTimeTicks ? Math.round(item.RunTimeTicks / TICKS_PER_MS) : null,
      size: media.Size ?? 0,
      // The ALBUM carries the art, as it does everywhere else. A track with no album
      // (a stray single) falls back to its own image, which Jellyfin will happily
      // serve from the embedded tag.
      coverId: item.AlbumId || (item.ImageTags?.Primary ? item.Id : null),
      suffix: media.Container || item.Container || null
    }
  }

  _album (item) {
    return {
      id: item.Id,
      name: item.Name || 'Unknown Album',
      artist: item.AlbumArtist || item.AlbumArtists?.[0]?.Name || null,
      year: item.ProductionYear ?? null,
      songCount: item.ChildCount ?? null,
      coverId: item.Id
    }
  }

  _artist (item) {
    return {
      id: item.Id,
      name: item.Name || 'Unknown Artist',
      // Jellyfin does not carry an album count on an artist row without a second
      // query per artist, and the app only shows the label when it is > 0. A number
      // we would have to fetch a hundred times to render once is not worth it.
      albumCount: null,
      coverId: item.ImageTags?.Primary ? item.Id : null
    }
  }

  // --- the interface --------------------------------------------------------

  async ping () {
    await this._auth()
    return true
  }

  async scan () {
    // Jellyfin already scanned. We confirm we can talk to it and cache the count -
    // failing loudly HERE, at boot or at Save, rather than on a user's first tap.
    await this._auth()

    // The server NAMES ITSELF. System/Info/Public needs no auth and returns
    // ProductName - "Jellyfin", or "Emby Server" for an Emby box - and Version. That
    // is how the app can say which one it actually is (and it is how an eventual Emby
    // adapter will tell itself apart from Jellyfin).
    this._serverName = await fetch(`${this.base}/System/Info/Public`)
      .then(r => r.ok ? r.json() : null)
      .then(b => b?.ProductName || null)
      .catch(() => null)

    const body = await this._call('/Items', {
      userId: this.userId,
      IncludeItemTypes: 'Audio',
      Recursive: true,
      Limit: 0 // we want the count, not the library
    })
    this._counts = body.TotalRecordCount ?? 0
    this.scannedAt = Date.now()
    return this._counts
  }

  async probe () {
    return { tracks: await this.scan() }
  }

  async stats () {
    return {
      source: this.kind,
      sourceName: this._serverName || 'Jellyfin',
      root: this.base,
      tracks: this._counts ?? 0,
      albums: 0,
      artists: 0,
      scannedAt: this.scannedAt
    }
  }

  async list ({ type = 'albums', limit = 100, cursor = 0 } = {}) {
    const offset = Number(cursor) || 0
    const more = (items, total) => (offset + items.length < total ? offset + items.length : null)

    if (type === 'artists') {
      // AlbumArtists, not Artists: the second includes every featured performer, so
      // an artist grid built on it is mostly people who appear on one track of
      // somebody else's record. Navidrome has the same disease and we sort around
      // it there; here we can just ask the right question.
      const body = await this._call('/Artists/AlbumArtists', {
        userId: this.userId,
        Recursive: true,
        SortBy: 'SortName',
        SortOrder: 'Ascending'
      })
      return { type, items: (body.Items || []).map(i => this._artist(i)), nextCursor: null }
    }

    if (type === 'albums') {
      const body = await this._call('/Items', {
        userId: this.userId,
        IncludeItemTypes: 'MusicAlbum',
        Recursive: true,
        SortBy: 'SortName',
        SortOrder: 'Ascending',
        Fields: ALBUM_FIELDS,
        StartIndex: offset,
        Limit: limit
      })
      const items = (body.Items || []).map(i => this._album(i))
      return { type, items, nextCursor: more(items, body.TotalRecordCount ?? 0) }
    }

    if (type === 'tracks') {
      const body = await this._call('/Items', {
        userId: this.userId,
        IncludeItemTypes: 'Audio',
        Recursive: true,
        SortBy: 'AlbumArtist,Album,ParentIndexNumber,IndexNumber,SortName',
        SortOrder: 'Ascending',
        Fields: TRACK_FIELDS,
        StartIndex: offset,
        Limit: limit
      })
      const items = (body.Items || []).map(i => this._track(i))
      return { type, items, nextCursor: more(items, body.TotalRecordCount ?? 0) }
    }

    if (type === 'playlists') {
      const body = await this._call('/Items', {
        userId: this.userId,
        IncludeItemTypes: 'Playlist',
        Recursive: true,
        SortBy: 'SortName'
      })
      return {
        type,
        items: (body.Items || []).map(p => ({ id: p.Id, name: p.Name, songCount: p.ChildCount ?? null })),
        nextCursor: null
      }
    }

    return { type, items: [], nextCursor: null }
  }

  async get ({ id, type = 'track' } = {}) {
    if (type === 'album') {
      const [album, songs] = await Promise.all([
        this._call(`/Users/${this.userId}/Items/${id}`).catch(() => null),
        this._call('/Items', {
          userId: this.userId,
          ParentId: id,
          IncludeItemTypes: 'Audio',
          SortBy: 'ParentIndexNumber,IndexNumber,SortName',
          SortOrder: 'Ascending',
          Fields: TRACK_FIELDS
        })
      ])
      if (!album) return null
      return { ...this._album(album), tracks: (songs.Items || []).map(i => this._track(i)) }
    }

    if (type === 'artist') {
      const [artist, albums] = await Promise.all([
        this._call(`/Users/${this.userId}/Items/${id}`).catch(() => null),
        this._call('/Items', {
          userId: this.userId,
          IncludeItemTypes: 'MusicAlbum',
          Recursive: true,
          // ALBUM artist, so the artist page is the records they MADE, not every
          // record they appear on. AlbumArtistIds is the difference.
          AlbumArtistIds: id,
          SortBy: 'ProductionYear,SortName',
          SortOrder: 'Ascending',
          Fields: ALBUM_FIELDS
        })
      ])
      if (!artist) return null

      const out = {
        ...this._artist(artist),
        albums: (albums.Items || []).map(a => this._album(a)),
        tracks: []
      }

      // An artist with no albums of their own still has songs - the same
      // featured-on case that bites us on Navidrome. Fall back to their tracks so
      // the page is not a dead end and "Add to queue" has something to add.
      if (!out.albums.length) {
        const songs = await this._call('/Items', {
          userId: this.userId,
          IncludeItemTypes: 'Audio',
          Recursive: true,
          ArtistIds: id,
          SortBy: 'Album,ParentIndexNumber,IndexNumber',
          Fields: TRACK_FIELDS,
          Limit: 200
        }).catch(() => null)
        out.tracks = (songs?.Items || []).map(i => this._track(i))
      }

      return out
    }

    const itemId = await this._itemId(id)
    if (!itemId) return null
    const item = await this._call(`/Users/${this.userId}/Items/${itemId}`, { Fields: TRACK_FIELDS })
    return item ? this._track(item) : null
  }

  // Our trackId is a hash, so it cannot be inverted. After a host restart the map is
  // empty and the shim will still ask for a track by our id (a paused queue on a
  // phone outlives the host). Walk the songs once to rebuild it.
  //
  // Same shape as the Navidrome adapter's _songId, and the same tradeoff: this is
  // slow exactly once, and never again for that track.
  async _itemId (ourId) {
    const known = this.itemIds.get(ourId)
    if (known) return known

    let offset = 0
    for (;;) {
      const body = await this._call('/Items', {
        userId: this.userId,
        IncludeItemTypes: 'Audio',
        Recursive: true,
        SortBy: 'SortName',
        StartIndex: offset,
        Limit: 500
      })
      const items = body.Items || []
      if (!items.length) return null

      for (const item of items) {
        const mapped = trackId(this.libraryId, this.kind, item.Id)
        this.itemIds.set(mapped, item.Id)
        if (mapped === ourId) return item.Id
      }

      offset += items.length
      if (offset >= (body.TotalRecordCount ?? 0)) return null
    }
  }

  async search ({ q = '', limit = 50 } = {}) {
    if (!q) return { artists: [], albums: [], tracks: [] }

    // ONE call for all three kinds. /Search/Hints is the other option and it is
    // worse for us: it answers a flattened "hint" shape with no MediaSources, so
    // every track it returned would need a second fetch to become playable.
    const body = await this._call('/Items', {
      userId: this.userId,
      searchTerm: q,
      IncludeItemTypes: 'MusicArtist,MusicAlbum,Audio',
      Recursive: true,
      Fields: TRACK_FIELDS,
      Limit: limit * 3
    })

    const items = body.Items || []
    return {
      artists: items.filter(i => i.Type === 'MusicArtist').slice(0, limit).map(i => this._artist(i)),
      albums: items.filter(i => i.Type === 'MusicAlbum').slice(0, limit).map(i => this._album(i)),
      tracks: items.filter(i => i.Type === 'Audio').slice(0, limit).map(i => this._track(i))
    }
  }

  async art ({ coverId, size } = {}) {
    if (!coverId) return null
    await this._auth()

    // maxWidth, not fillWidth: fill CROPS to the box, and cropping somebody's album
    // art to fit a square tile is a thing to do to a photo, not to a record sleeve.
    const url = this._url(`/Items/${coverId}/Images/Primary`, {
      maxWidth: size || undefined,
      quality: 90
    })

    const res = await fetch(url, { headers: { authorization: this._authHeader() } })
    // 404 is the normal answer for an album with no artwork. Not an error - the app
    // draws its own placeholder.
    if (!res.ok) return null
    return res.body
  }

  // Range support: for DIRECT PLAY we pass the HTTP Range straight through, so
  // seeking works exactly as it does with the folder adapter.
  //
  // For a TRANSCODED stream there are no stable byte offsets to seek to - the bytes
  // do not exist until Jellyfin makes them - so a range request while transcoding is
  // best-effort. Same known v1 limitation as Navidrome.
  async stream ({ trackId: id, offset = 0, length, format, bitrate } = {}) {
    const itemId = await this._itemId(id)
    if (!itemId) return null

    const transcoding = !!(format || bitrate)

    const url = transcoding
      ? this._url(`/Audio/${itemId}/universal`, {
          userId: this.userId,
          deviceId: this.deviceId,
          audioCodec: format || 'mp3',
          maxStreamingBitrate: bitrate ? Number(bitrate) * 1000 : undefined,
          container: format || 'mp3',
          transcodingContainer: format || 'mp3',
          transcodingProtocol: 'http'
        })
      // static=true is the whole ballgame: without it Jellyfin decides for itself
      // whether to transcode, and the default path stops being exact original bytes.
      : this._url(`/Audio/${itemId}/stream`, { static: true })

    const headers = { authorization: this._authHeader() }
    if (offset > 0 || length) {
      const end = length ? offset + Number(length) - 1 : ''
      headers.range = `bytes=${offset}-${end}`
    }

    const res = await fetch(url, { headers })
    if (!res.ok && res.status !== 206) return null
    return res.body
  }
}

module.exports = { JellyfinAdapter }

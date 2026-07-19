// Raw-folder source adapter.
//
// Point the host at /music and it works, with no Navidrome, no Jellyfin and no
// server of any kind. This is the fallback and arguably the real product: it is
// what a stranger who installs PearTune from an app store actually gets, so it is
// the first impression of the whole app.
//
// It READS TAGS. Until 2026-07-14 it did not - it listed filenames and nothing
// else, which meant no artists, no albums, no artwork and no search worth the
// name. Everything the app is built around (an album grid, an artist page, a cover
// on the lock screen) lives on the other side of a tag reader.
//
// The reader is `music-metadata` (MIT): ID3v1/v2, Vorbis comments (FLAC/Ogg/Opus),
// MP4/M4A atoms, RIFF. We are not writing our own; a decade of other people's
// broken tags is baked into that library and none of it is baked into ours.
//
// WHAT WE INFER, AND WHAT WE DO NOT. A Navidrome library has albums and artists
// because Navidrome decided what they are. A folder has FILES. Everything above a
// file here is inferred from tags plus the directory layout, and the inference is
// the interesting part of this file - see albumKeyOf().

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const { Readable } = require('stream')
const { spawn } = require('child_process')
const { trackId, groupId } = require('../../protocol/ids')
const { TRACK_CMP, ALBUM_CMP, ARTIST_CMP, GENRE_CMP, FULL_SORTS, sortRows } = require('./sort')

// The transcoder. `PEARTUNE_FFMPEG` overrides the binary (a bundled static build,
// say); otherwise we trust PATH. Adding ffmpeg to the host image is what turns
// folder mode from "raw bytes only" into something that can cap a FLAC for cellular.
const FFMPEG = process.env.PEARTUNE_FFMPEG || 'ffmpeg'

// format -> ffmpeg codec + CONTAINER. The container is the trap: `-f aac` is not a
// thing (it is `adts`), and opus rides in an ogg container.
const TRANSCODE = {
  mp3: { codec: 'libmp3lame', container: 'mp3' },
  opus: { codec: 'libopus', container: 'ogg' },
  aac: { codec: 'aac', container: 'adts' }
}

// Is ffmpeg actually here? Checked ONCE and memoized: if it is missing, transcoding
// silently degrades to raw bytes (the pre-transcoder behavior), never an error. The
// promise is cached so a screenful of stream requests does not spawn a probe each.
let _ffmpeg = null
function hasFfmpeg () {
  if (_ffmpeg) return _ffmpeg
  _ffmpeg = new Promise((resolve) => {
    let ff
    try {
      ff = spawn(FFMPEG, ['-hide_banner', '-version'])
    } catch {
      return resolve(false)
    }
    ff.on('error', () => resolve(false))
    ff.on('close', (code) => resolve(code === 0))
  })
  return _ffmpeg
}

const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.wma', '.aiff', '.aif'])

// An image sitting next to the music beats an embedded one: it is usually the
// bigger, better scan, and reading it costs one open() instead of parsing a 40MB
// FLAC to find the picture frame inside it.
const COVER_EXT = ['.jpg', '.jpeg', '.png', '.webp']
const COVER_STEMS = ['cover', 'folder', 'front', 'album', 'albumart', 'albumartsmall', 'art', 'thumb']

const UNKNOWN_ARTIST = 'Unknown Artist'
const UNKNOWN_ALBUM = 'Unknown Album'
const VARIOUS = 'Various Artists'

// How many files we parse at once. Tag parsing is IO-bound (a header read), and a
// Pi-class Umbrel with a spinning USB disk is the machine we must not thrash.
const PARSE_CONCURRENCY = 8

// Covers are held in memory only while somebody is looking at them. A grid of 60
// albums at ~500KB an embedded JPEG is 30MB if we keep them all, on a box whose
// whole job is to also be a Bitcoin node.
const ART_CACHE_MAX = 24
const ART_CACHE_MAX_BYTES = 4 * 1024 * 1024 // do not cache a cover bigger than this

// music-metadata is ESM-only from v8. The host is CommonJS, so it is imported
// dynamically and memoized. This is NOT a lazy-loading optimization - it is the
// only way a `require`-based module can use it at all.
let _mm = null
function metadata () {
  if (!_mm) _mm = import('music-metadata')
  return _mm
}

const clean = (s) => {
  if (s == null) return null
  const t = String(s).replace(/\0/g, '').trim().replace(/\s+/g, ' ')
  return t || null
}
const lower = (s) => String(s || '').toLowerCase()
const cmp = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base', numeric: true })

// A folder source can point at SEVERAL directories (e.g. /music AND /audiobooks).
// Normalise the list: resolve, drop exact duplicates, and drop any root nested
// inside another kept root - otherwise the nested tree is walked twice and the same
// file lands under two ids. INPUT ORDER IS PRESERVED, on purpose: the first root is
// the "primary" and keeps bare, un-prefixed ids (see rootTags), so an existing
// single-/music install does not re-key its whole library when a second folder is
// added later.
function normalizeRoots (roots) {
  const seen = new Set()
  const kept = []
  for (const raw of roots) {
    if (raw == null || raw === '') continue
    const r = path.resolve(String(raw))
    if (seen.has(r)) continue
    seen.add(r)
    kept.push(r)
  }
  return kept.filter(r => !kept.some(other => other !== r && r.startsWith(other + path.sep)))
}

class FolderAdapter {
  constructor ({ roots, root, libraryId, log = () => {} }) {
    // Accept either `roots` (a list) or the legacy single `root`. Always at least one.
    const list = (roots && roots.length ? roots : [root || '/music'])
    this.roots = normalizeRoots(list)
    if (!this.roots.length) this.roots = [path.resolve('/music')]
    // The primary root (index 0) gets NO tag, so its files keep the exact trackIds a
    // single-root library had (relPath alone). Additional roots get a short, stable,
    // path-derived tag prefixed onto their relPaths so ids stay unique across roots
    // even when two roots share a directory layout. Path-derived (not index-derived)
    // so a root keeps its ids when others are added/removed around it - as long as it
    // stays the primary, index 0 keeps the empty tag.
    this.rootTags = this.roots.map((r, i) =>
      i === 0 ? '' : crypto.createHash('sha256').update(r).digest('hex').slice(0, 12))
    // Kept for the many call sites + tests that still speak of a single root; it is
    // just the primary now.
    this.root = this.roots[0]
    this.libraryId = libraryId
    this.kind = 'folder'
    this.log = log

    this.tracks = new Map() // trackId  -> track
    this.albums = new Map() // albumId  -> album
    this.artists = new Map() // artistId -> artist
    this.genres = new Map() // genreId  -> genre

    // Sorted ONCE, at scan. Every list() page and every search re-derived these,
    // which is a full sort of the library per request - invisible at 8 tracks and
    // not at 100,000.
    this._sortedAlbums = []
    this._sortedArtists = []
    this._sortedTracks = []

    // Sorted permutations of the above, memoized per (type|sort|order). The library
    // is sorted once at scan into its default (shelf) order; a request for a
    // different order sorts it once more and keeps the result, so scrolling a
    // title-sorted Songs list does not re-sort 100,000 rows on every page. Cleared
    // on every rebuild.
    this._sortCache = new Map()

    this.artCache = new Map() // coverId -> Buffer | null  (null = looked, found nothing)
    this.scannedAt = null
    this.scanning = null
  }

  // THROWS if the folder is not there, and that is the whole point.
  //
  // The old adapter swallowed a missing directory and reported zero tracks, so
  // typing a path that does not exist INSIDE THE CONTAINER - which is the normal
  // mistake, because the operator is looking at their host's filesystem - looked
  // exactly like an empty library. It cost a real evening. The dashboard's Test
  // button now gets a sentence it can show a human.
  async _checkRoot (root) {
    let st
    try {
      st = await fsp.stat(root)
    } catch {
      const visible = await visibleMounts()
      throw new Error(
        `${root} does not exist inside the PearTune container. Only folders MOUNTED into the container are visible` +
        (visible.length ? `. I can see: ${visible.join(', ')}` : '') + '.'
      )
    }
    if (!st.isDirectory()) throw new Error(`${root} is a file, not a folder.`)
  }

  async scan () {
    // A rescan triggered from the dashboard while the boot scan is still running
    // would walk the tree twice and interleave two builds into one Map. Share the
    // in-flight scan instead.
    if (this.scanning) return this.scanning
    this.scanning = this._scan().finally(() => { this.scanning = null })
    return this.scanning
  }

  async _scan () {
    // Resilient across roots: a single missing/unreadable root (an unplugged drive)
    // must not take the whole library down, so we skip it with a log rather than
    // throwing. If NONE of the roots are usable, that IS an error - _checkRoot on the
    // first gives the operator a sentence to act on.
    const files = []
    let usable = 0
    for (let i = 0; i < this.roots.length; i++) {
      const root = this.roots[i]
      try {
        await this._checkRoot(root)
      } catch (e) {
        this.log('folder:root-skipped', { root, err: e.message })
        continue
      }
      usable++
      const found = []
      await this._walk(root, found)
      for (const abs of found) files.push({ abs, root, tag: this.rootTags[i] })
    }
    if (!usable) await this._checkRoot(this.roots[0]) // throws with the helpful message
    this.log('folder:walked', { files: files.length, roots: this.roots.length })

    const parsed = await this._parseAll(files)
    this._build(parsed)

    this.artCache.clear() // a rescan may have replaced the cover art
    this.scannedAt = Date.now()
    this.log('folder:scanned', {
      tracks: this.tracks.size,
      albums: this.albums.size,
      artists: this.artists.size
    })
    return this.tracks.size
  }

  // The cheapest honest answer to "does this work?", for the dashboard's Test
  // button. Counts the audio files; does NOT read their tags. Testing a folder
  // should not parse ten thousand files to tell you the folder is there.
  async probe () {
    // Test is strict, unlike scan: every configured folder is checked, so a bad one
    // is named while the operator is looking, not silently skipped.
    let count = 0
    for (const root of this.roots) {
      await this._checkRoot(root) // throws, with a sentence a human can act on
      const found = []
      await this._walk(root, found)
      count += found.length
    }
    return { tracks: count }
  }

  async _walk (dir, out) {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return // an unreadable subdirectory is not a reason to abandon the library
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue // .git, .Trash-1000, macOS ._ resource forks
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        await this._walk(abs, out)
        continue
      }
      if (!e.isFile()) continue
      if (!AUDIO_EXT.has(path.extname(e.name).toLowerCase())) continue
      out.push(abs)
    }
  }

  async _parseAll (files) {
    const out = []
    let next = 0
    let failed = 0

    const worker = async () => {
      for (;;) {
        const i = next++
        if (i >= files.length) return
        const row = await this._parseOne(files[i])
        if (row) {
          if (row.unreadable) failed++
          out.push(row)
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(PARSE_CONCURRENCY, files.length || 1) }, worker)
    )

    if (failed) this.log('folder:unreadable-tags', { files: failed })
    return out
  }

  async _parseOne (file) {
    const { abs, root, tag } = file
    const stat = await fsp.stat(abs).catch(() => null)
    if (!stat) return null

    const relPath = path.relative(root, abs)
    // The sourceKey is what trackId hashes: the primary root's files use relPath
    // alone (unchanged from single-root), additional roots prefix a stable per-root
    // tag so two files with the same relPath under different roots do not collide.
    const sourceKey = tag ? `${tag}/${relPath}` : relPath
    const ext = path.extname(abs)
    const base = { relPath, sourceKey, root, absPath: abs, size: stat.size, suffix: ext.slice(1).toLowerCase() }

    let md = null
    try {
      const { parseFile } = await metadata()
      // skipCovers, and it is load-bearing: the picture frames are the bulk of a
      // tag, and holding 1358 of them in memory to build a track list would cost
      // hundreds of megabytes for artwork nobody has asked to look at. Art is
      // fetched per album, on demand, in art().
      //
      // duration:false means "do not read the whole file just to time it". FLAC,
      // MP4, Ogg and any MP3 with a VBR header answer from the header for free;
      // a headerless CBR MP3 is estimated below from bitrate and size. Reading
      // every byte of a 200GB library at boot to be exact about a number we show
      // in small grey text is not a trade worth making.
      md = await parseFile(abs, { duration: false, skipCovers: true })
    } catch (e) {
      // A corrupt or exotic file still EXISTS and still plays. Losing a track
      // because we could not read its tags would be the tag reader making the
      // library worse than no tag reader at all.
      return { ...base, unreadable: true, title: path.basename(abs, ext) }
    }

    const c = md.common || {}
    const f = md.format || {}

    let durationMs = f.duration ? Math.round(f.duration * 1000) : null
    if (!durationMs && f.bitrate && stat.size) {
      durationMs = Math.round((stat.size * 8 / f.bitrate) * 1000) // estimate; see above
    }

    return {
      ...base,
      title: clean(c.title) || path.basename(abs, ext),
      artist: clean(c.artist),
      albumArtist: clean(c.albumartist),
      album: clean(c.album),
      track: c.track?.no ?? null,
      disc: c.disk?.no ?? null,
      year: c.year ?? null,
      genre: clean(c.genre?.[0]),
      durationMs
    }
  }

  // WHAT IS AN ALBUM, IN A FOLDER?
  //
  // Three cases, and getting them wrong is how a library ends up with 400 albums
  // called "Greatest Hits" or one album per track:
  //
  // 1. There is an ALBUMARTIST tag. Trust it completely: (albumartist, album) is
  //    the album, wherever the files sit. This is what merges Disc 1/ and Disc 2/
  //    subfolders back into one album, and it is the only signal that survives a
  //    library organised by year or by genre.
  //
  // 2. There is an album tag but NO albumartist - very common, and the trap. Group
  //    by (directory, album): if we grouped by (track artist, album) instead, every
  //    compilation and every album with a guest verse would splinter into one album
  //    per performer. A directory is the strongest statement a folder library makes
  //    about what belongs together.
  //
  // 3. No album tag at all. The directory IS the album. Untagged rips live in a
  //    folder named after the album roughly always.
  _albumKeyOf (t) {
    const dir = path.dirname(t.relPath)
    // Case 1 (albumartist) stays root-agnostic: the SAME album split across two of
    // the configured folders should merge into one. The directory-based cases include
    // the root, so an "Album X" folder in /music and another in /audiobooks are two
    // albums, not one merged mess.
    if (t.album && t.albumArtist) return `t|${lower(t.albumArtist)}|${lower(t.album)}`
    if (t.album) return `d|${t.root}|${dir}|${lower(t.album)}`
    return `f|${t.root}|${dir}`
  }

  _build (rows) {
    this.tracks.clear()
    this.albums.clear()
    this.artists.clear()
    this.genres.clear()
    this._sortCache = new Map() // the library changed; old sorted permutations are stale

    // Pass 1: bucket the files into albums.
    const buckets = new Map() // albumKey -> { rows, dir, root }
    for (const r of rows) {
      const key = this._albumKeyOf(r)
      let b = buckets.get(key)
      if (!b) buckets.set(key, (b = { key, rows: [], dir: path.dirname(r.relPath), root: r.root }))
      b.rows.push(r)
    }

    // Pass 2: resolve each album's name and artist, and mint stable ids.
    for (const b of buckets.values()) {
      const id = groupId(this.libraryId, this.kind, 'album', b.key)

      const named = b.rows.find(r => r.album)
      const name = named
        ? named.album
        : (b.dir === '.' ? UNKNOWN_ALBUM : path.basename(b.dir))

      // One albumartist for the whole album, or - if the tags never said and the
      // performers differ - it is a compilation and we say so, rather than picking
      // whichever track happened to be first off the disk.
      const artists = new Set(b.rows.map(r => r.albumArtist || r.artist).filter(Boolean))
      let artist
      if (b.rows.some(r => r.albumArtist)) artist = b.rows.find(r => r.albumArtist).albumArtist
      else if (artists.size === 1) artist = [...artists][0]
      else if (artists.size > 1) artist = VARIOUS
      else artist = UNKNOWN_ARTIST

      const artistId = groupId(this.libraryId, this.kind, 'artist', lower(artist))

      const album = {
        id,
        name,
        artist,
        artistId,
        year: b.rows.find(r => r.year)?.year ?? null,
        coverId: id, // an album IS the unit of artwork here; art() resolves it lazily
        songCount: b.rows.length,
        dir: b.dir,
        // The ABSOLUTE cover directory, resolved against this album's own root - a
        // relative dir alone is ambiguous once there is more than one root.
        absDir: path.resolve(b.root, b.dir),
        trackIds: []
      }
      this.albums.set(id, album)

      let artistRow = this.artists.get(artistId)
      if (!artistRow) {
        this.artists.set(artistId, (artistRow = {
          id: artistId, name: artist, albumIds: [], trackIds: [], albumCount: 0, coverId: null
        }))
      }
      artistRow.albumIds.push(id)
      artistRow.albumCount = artistRow.albumIds.length

      // Pass 3: the tracks themselves.
      const sorted = b.rows.sort(
        (x, y) => (x.disc ?? 1) - (y.disc ?? 1) || (x.track ?? 9999) - (y.track ?? 9999) || cmp(x.title, y.title)
      )
      for (const r of sorted) {
        // sourceKey (the relPath, plus a per-root tag for non-primary roots) is what
        // makes an id stable across rescans and restarts as long as the file does not
        // move, and unique across roots. NOT the tags: a library whose track ids
        // changed when someone fixed a typo in a title would orphan that track's play
        // count and resume position.
        const tid = trackId(this.libraryId, this.kind, r.sourceKey)
        const track = {
          id: tid,
          title: r.title,
          artist: r.artist || album.artist,
          album: album.name,
          albumId: album.id,
          artistId: album.artistId,
          track: r.track,
          disc: r.disc,
          year: r.year ?? album.year,
          genre: r.genre || null,
          durationMs: r.durationMs,
          size: r.size,
          coverId: album.coverId,
          suffix: r.suffix,
          path: r.relPath,
          absPath: r.absPath
        }
        this.tracks.set(tid, track)
        album.trackIds.push(tid)
        artistRow.trackIds.push(tid)
      }
    }

    // An artist's picture is their first album's cover. There is nowhere else for
    // one to come from in a folder - and a wall of grey placeholders on the artist
    // grid is exactly the "library of filenames" impression we are here to kill.
    for (const a of this.artists.values()) {
      a.albumIds.sort((x, y) => cmp(this.albums.get(x)?.name, this.albums.get(y)?.name))
      a.coverId = a.albumIds[0] || null
    }

    // Genres, the broadest way in: a genre is the set of albums (and their tracks)
    // tagged with it. A track carries one genre; an album shows under every genre
    // its tracks name (usually just the one). The id is derived from the lowercased
    // name, so "Rock" and "rock" merge; the cover is the genre's first album, like
    // an artist's - so the genre grid is real artwork, not a wall of grey.
    for (const t of this.tracks.values()) {
      if (!t.genre) continue
      const gid = groupId(this.libraryId, this.kind, 'genre', lower(t.genre))
      let g = this.genres.get(gid)
      if (!g) this.genres.set(gid, (g = { id: gid, name: t.genre, albumIds: [], _albumSet: new Set(), trackIds: [], albumCount: 0, coverId: null }))
      if (!g._albumSet.has(t.albumId)) { g._albumSet.add(t.albumId); g.albumIds.push(t.albumId) }
      g.trackIds.push(t.id)
    }
    for (const g of this.genres.values()) {
      g.albumIds.sort((x, y) => cmp(this.albums.get(x)?.name, this.albums.get(y)?.name))
      g.albumCount = g.albumIds.length
      g.coverId = g.albumIds[0] || null
      delete g._albumSet
    }

    this._sortedAlbums = [...this.albums.values()].sort((a, b) => cmp(a.name, b.name))
    this._sortedArtists = [...this.artists.values()].sort((a, b) => cmp(a.name, b.name))
    this._sortedGenres = [...this.genres.values()].sort((a, b) => cmp(a.name, b.name))

    // The library in the order a person would shelve it: by artist, then album,
    // then disc and track. The old adapter answered in readdir order, which is to
    // say in whatever order the filesystem felt like.
    this._sortedTracks = []
    for (const artist of this._sortedArtists) {
      for (const albumId of artist.albumIds) {
        for (const tid of this.albums.get(albumId)?.trackIds || []) {
          const t = this.tracks.get(tid)
          if (t) this._sortedTracks.push(t)
        }
      }
    }
  }

  // The wire shape. `absPath` is ours alone: handing every phone the host's
  // filesystem layout would be a needless little information leak.
  _pub (t) {
    if (!t) return null
    const { absPath, ...pub } = t
    return pub
  }

  async stats () {
    return {
      source: this.kind,
      sourceName: 'Folder',
      root: this.root, // the primary, for anything still expecting a single root
      roots: this.roots,
      tracks: this.tracks.size,
      albums: this.albums.size,
      artists: this.artists.size,
      genres: this.genres.size,
      // The whole library is in memory, so every field sorts for free, both ways.
      sorts: FULL_SORTS,
      scannedAt: this.scannedAt
    }
  }

  // Sorted-and-memoized view of one of the _sorted* arrays. An unknown/absent `sort`
  // returns the default (shelf) order untouched.
  _order (type, all, table, sort, order) {
    if (!table[sort]) return all
    const key = `${type}|${sort}|${order === 'desc' ? 'desc' : 'asc'}`
    let rows = this._sortCache.get(key)
    if (!rows) {
      rows = sortRows(all, table, sort, order)
      this._sortCache.set(key, rows)
    }
    return rows
  }

  async list ({ type = 'tracks', limit = 200, cursor = 0, sort, order } = {}) {
    const start = Math.max(0, Number(cursor) || 0)
    const page = (all, map) => {
      const items = all.slice(start, start + limit).map(map)
      const next = start + limit
      return { type, items, nextCursor: next < all.length ? next : null }
    }

    if (type === 'albums') {
      return page(this._order('albums', this._sortedAlbums, ALBUM_CMP, sort, order), a => ({
        id: a.id, name: a.name, artist: a.artist, year: a.year, songCount: a.songCount, coverId: a.coverId
      }))
    }

    if (type === 'artists') {
      // Not paged, to match the Navidrome adapter (getArtists answers in one shot,
      // and the app's artist grid asks for the lot).
      const items = this._order('artists', this._sortedArtists, ARTIST_CMP, sort, order).map(a => ({
        id: a.id, name: a.name, albumCount: a.albumCount, coverId: a.coverId
      }))
      return { type, items, nextCursor: null }
    }

    if (type === 'genres') {
      // One shot, like artists - the genre grid asks for the lot.
      const items = this._order('genres', this._sortedGenres, GENRE_CMP, sort, order).map(g => ({
        id: g.id, name: g.name, albumCount: g.albumCount, coverId: g.coverId
      }))
      return { type, items, nextCursor: null }
    }

    if (type === 'tracks') {
      return page(this._order('tracks', this._sortedTracks, TRACK_CMP, sort, order), t => this._pub(t))
    }

    // No playlists in a folder. An .m3u reader is a fine idea and it is not this.
    return { type, items: [], nextCursor: null }
  }

  async get ({ id, type = 'track' } = {}) {
    if (type === 'album') {
      const a = this.albums.get(id)
      if (!a) return null
      return {
        id: a.id,
        name: a.name,
        artist: a.artist,
        year: a.year,
        coverId: a.coverId,
        tracks: a.trackIds.map(t => this._pub(this.tracks.get(t))).filter(Boolean)
      }
    }

    if (type === 'artist') {
      const a = this.artists.get(id)
      if (!a) return null
      return {
        id: a.id,
        name: a.name,
        coverId: a.coverId,
        albums: a.albumIds.map(x => {
          const al = this.albums.get(x)
          return al && {
            id: al.id, name: al.name, artist: al.artist, year: al.year, songCount: al.songCount, coverId: al.coverId
          }
        }).filter(Boolean),
        // Only ever populated for an artist with no albums, which cannot happen
        // here (every album mints its artist) - but the app reads this field for
        // Navidrome's composite-tag artists, so answer it rather than leaving it
        // undefined and making the client guess.
        tracks: []
      }
    }

    if (type === 'genre') {
      const g = this.genres.get(id)
      if (!g) return null
      return {
        id: g.id,
        name: g.name,
        coverId: g.coverId,
        albums: g.albumIds.map(x => {
          const al = this.albums.get(x)
          return al && {
            id: al.id, name: al.name, artist: al.artist, year: al.year, songCount: al.songCount, coverId: al.coverId
          }
        }).filter(Boolean),
        tracks: [] // every genre track has an album here, so the album grid is enough
      }
    }

    // A folder has no server-side playlists (an .m3u reader is a fine idea, and it is
    // not this), so a playlist lookup is a clean null rather than a track miss.
    if (type === 'playlist') return null

    return this._pub(this.tracks.get(id))
  }

  async search ({ q = '', limit = 50 } = {}) {
    const needle = lower(clean(q) || '')
    if (!needle) return { artists: [], albums: [], tracks: [] }

    const hit = (s) => lower(s).includes(needle)

    return {
      artists: this._sortedArtists
        .filter(a => hit(a.name))
        .slice(0, limit)
        .map(a => ({ id: a.id, name: a.name, albumCount: a.albumCount, coverId: a.coverId })),
      albums: this._sortedAlbums
        .filter(a => hit(a.name) || hit(a.artist))
        .slice(0, limit)
        .map(a => ({ id: a.id, name: a.name, artist: a.artist, year: a.year, coverId: a.coverId })),
      // The path stays searchable. It is the only thing an untagged library has,
      // and dropping it the day we learned to read tags would make search WORSE
      // for exactly the people this adapter exists for.
      tracks: this._sortedTracks
        .filter(t => hit(t.title) || hit(t.artist) || hit(t.album) || hit(t.path))
        .slice(0, limit)
        .map(t => this._pub(t))
    }
  }

  // --- artwork --------------------------------------------------------------
  //
  // Resolved LAZILY, per album, and cached. The scan deliberately skips covers
  // (see _parseOne), so the first request for an album's art is the first time
  // anyone reads its picture - which is the right moment, because the art of an
  // album nobody scrolls to is bytes nobody needs.
  //
  // `size` is IGNORED. We have no image resizer: every one is either a native
  // dependency (sharp - a second arch matrix in the build) or slow pure JS, and
  // both are a lot of machinery to make a cover smaller on a LAN. Navidrome does
  // resize, so this is the one place the two sources visibly differ. If the album
  // grid feels heavy on a phone, THIS is the thing to fix - measure first.
  async art ({ coverId } = {}) {
    if (!coverId) return null
    const buf = await this._cover(coverId)
    if (!buf) return null
    return Readable.from(buf)
  }

  async _cover (coverId) {
    if (this.artCache.has(coverId)) return this.artCache.get(coverId)

    const buf = await this._findCover(coverId)

    // The negative answer is cached TOO. Without it, an album with no art would
    // re-parse its FLAC on every scroll past its tile, forever.
    if (this.artCache.size >= ART_CACHE_MAX) {
      this.artCache.delete(this.artCache.keys().next().value)
    }
    this.artCache.set(coverId, buf && buf.length <= ART_CACHE_MAX_BYTES ? buf : null)

    return buf
  }

  async _findCover (coverId) {
    const album = this.albums.get(coverId)
    if (!album) return null

    // 1. An image file next to the music (resolved against this album's own root).
    const file = await this._coverFile(album.absDir || path.resolve(this.root, album.dir))
    if (file) {
      const buf = await fsp.readFile(file).catch(() => null)
      if (buf) return buf
    }

    // 2. Embedded. Not only the first track: a rip where track 1 lost its picture
    // frame but the rest kept theirs is common enough to be worth two more reads.
    for (const tid of album.trackIds.slice(0, 3)) {
      const t = this.tracks.get(tid)
      if (!t) continue
      try {
        const { parseFile } = await metadata()
        const md = await parseFile(t.absPath, { duration: false })
        const pic = md.common?.picture?.[0]
        if (pic?.data?.length) return Buffer.from(pic.data)
      } catch {}
    }

    return null
  }

  async _coverFile (dir) {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return null
    }
    const images = entries.filter(e => e.isFile() && COVER_EXT.includes(path.extname(e.name).toLowerCase()))
    if (!images.length) return null

    for (const stem of COVER_STEMS) {
      const m = images.find(e => path.basename(e.name, path.extname(e.name)).toLowerCase() === stem)
      if (m) return path.join(dir, m.name)
    }
    // A folder with exactly one image in it and no conventional name: that is the
    // cover. More than one and we are guessing, so we do not.
    return images.length === 1 ? path.join(dir, images[0].name) : null
  }

  // Range support is load-bearing and belongs here from day one: `offset` serves
  // BOTH seeking and resuming a half-finished pinned download. Bolting it on
  // later would mean reworking the client's whole fetch path.
  //
  // TRANSCODING (spike, 2026-07-14). The folder adapter USED to ignore
  // `format`/`bitrate` because it had no transcoder - so a raw-FLAC library over
  // cellular was the one case that burned real data (DECISIONS 2026-07-13). If ffmpeg
  // is available it now transcodes on the fly, which is the single biggest thing a
  // server connector had over a folder. Measured: FLAC -> mp3@128k is ~7x smaller at
  // ~50x realtime, so a 300MB album becomes ~40MB and keeps up with playback easily.
  //
  // If ffmpeg is NOT present we fall back to raw bytes - the pre-spike behavior. The
  // client still warns about raw-over-cellular, so this degrades to exactly what it
  // was, never worse.
  async stream ({ trackId: id, offset = 0, length, format, bitrate } = {}) {
    const t = this.tracks.get(id)
    if (!t) return null

    if ((format || bitrate) && await hasFfmpeg()) {
      const stream = this._transcode(t, { format, bitrate })
      if (stream) return stream
      // fall through to raw if the transcode could not start
    }

    const start = Math.max(0, Number(offset) || 0)
    if (start >= t.size) return null

    const end = length ? Math.min(t.size - 1, start + Number(length) - 1) : t.size - 1
    return fs.createReadStream(t.absPath, { start, end })
  }

  // Spawn ffmpeg and hand back its stdout as the audio stream.
  //
  // Byte offsets do NOT survive a transcode - the bytes do not exist until ffmpeg
  // makes them - so this ignores `offset`/`length` and streams from the start, the
  // same best-effort-range limitation Navidrome and Jellyfin have while transcoding.
  // The client only asks for a transcode on cellular, where it also tends not to scrub.
  _transcode (t, { format = 'mp3', bitrate }) {
    const spec = TRANSCODE[format] || TRANSCODE.mp3
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', t.absPath,
      '-vn', '-map', '0:a:0', // audio only - drop any embedded cover art
      '-c:a', spec.codec
    ]
    if (bitrate) args.push('-b:a', `${Number(bitrate)}k`)
    args.push('-f', spec.container, 'pipe:1')

    let ff
    try {
      ff = spawn(FFMPEG, args)
    } catch {
      return null // ffmpeg vanished between the check and here
    }

    // A transcode nobody finishes reading (the phone paused, the link dropped) must
    // not leave ffmpeg chewing CPU on a Pi. Kill it when the reader is done or breaks.
    const kill = () => { try { ff.kill('SIGKILL') } catch {} }
    ff.stdout.on('close', kill)
    ff.stdout.on('error', kill)
    ff.on('error', (e) => { this.log('folder:transcode-failed', { err: e?.message }); kill() })
    ff.stderr.on('data', (d) => this.log('folder:transcode-stderr', { msg: String(d).slice(0, 200) }))

    return ff.stdout
  }
}

// What CAN this container see? Used to turn "0 tracks" - the least helpful thing a
// music server can say - into a sentence naming the folders that actually exist.
//
// Only the top level, only directories, and none of the ones every Linux has: an
// operator hunting for their music does not need to be told about /proc.
//
// /mnt, /media, /srv, /home and /opt STAY, deliberately. They look like system
// directories and they are exactly where a person mounts a music disk.
const SYSTEM_DIRS = new Set([
  'proc', 'sys', 'dev', 'etc', 'bin', 'sbin', 'lib', 'lib32', 'lib64', 'libx32',
  'usr', 'var', 'run', 'tmp', 'boot', 'root', 'app'
])

async function visibleMounts () {
  try {
    const entries = await fsp.readdir('/', { withFileTypes: true })
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !SYSTEM_DIRS.has(e.name))
      .map(e => '/' + e.name)
      .sort()
  } catch {
    return []
  }
}

module.exports = { FolderAdapter, AUDIO_EXT, visibleMounts, normalizeRoots }

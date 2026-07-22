// The audio shim: a localhost HTTP server inside the Bare worklet that fronts
// the P2P connection.
//
// WHY. Android's media stack (ExoPlayer, via expo-av or track-player) wants a
// URL. It knows how to buffer, seek, decode, run in the background and drive the
// lock-screen controls - all of which we would otherwise reimplement badly. So
// the worklet serves `http://127.0.0.1:<port>/t/<trackId>` and answers HTTP Range
// requests by pulling the same range over the P2P stream. The player thinks it is
// streaming from a web server; it is actually streaming from your house.
//
// This is ALSO what makes the headline demo honest. If the phone downloaded a
// track to a file and played that, revoking the device mid-song would do nothing:
// the bytes are already local. Because playback flows through the live
// connection, killing the connection kills the music - which is the entire point
// of the product.
//
// It binds 127.0.0.1 only, so nothing outside the phone can reach it.
//
// NOTE: no sibling app in the suite uses bare-http1. This is new ground; the
// Bare-side behavior is validated by scripts/spike-shim.js before any UI is built
// on top of it.

// Required lazily inside createAudioShim (below), NOT at module load: bare-http1 pulls a native
// addon that only exists on the phone, so a top-level require would make this whole module
// unloadable in a Node unit test - and the pure URL router (parseUrl) is exactly what we want to
// test there. createAudioShim only runs on-device, where the addon is present.
let http = null

const RANGE = /^bytes=(\d*)-(\d*)$/
// URL forms, single-host and merged (multi-host step 2, proposal 2026-07-19 §5):
//   /t/<trackId>            /t/<libraryId>/<trackId>
//   /art/<coverId>          /art/<libraryId>/<coverId>
// libraryId + trackId are z32 (lowercase alnum); a coverId can be a server's own id, so it's the
// permissive tail. The MERGED (2-segment) form carries the OWNING host in the URL itself, so the
// player's held URLs keep routing to the right host even if the merged index is later rebuilt
// mid-session (a host dropping out of the blend can't misroute a URL the player already holds).
// Artwork rides the same loopback server, so the WebView can just use a plain
// <img src="http://127.0.0.1:PORT/art/...">. The bytes still travel over P2P; the
// browser never knows. The alternative (pipe every cover through IPC as base64)
// would be slower, fatter, and would make a grid of 50 covers miserable.
const TRACK_PATH2 = /^\/t\/([a-z0-9]+)\/([a-z0-9]+)/i
const TRACK_PATH1 = /^\/t\/([a-z0-9]+)/i
const ART_PATH2 = /^\/art\/([a-z0-9]+)\/([^/?#]+)/i
const ART_PATH1 = /^\/art\/([^/?#]+)/
// ?s=<px>. A grid of 50 covers wants small ones; the full-screen viewer wants a
// big one. Same cover id, two very different requests, so the size is part of the
// URL - and therefore part of the cache key.
const ART_SIZE = /[?&]s=(\d+)/
const DEFAULT_ART_SIZE = 300
const MAX_ART_SIZE = 1200

function artSize (url) {
  const s = ART_SIZE.exec(String(url))
  return Math.min(MAX_ART_SIZE, Number(s && s[1]) || DEFAULT_ART_SIZE)
}

// Pure URL router (exported for tests). Returns { kind:'track'|'art', libraryId, id, size? } or
// null. The merged 2-segment form is matched first; libraryId is null for the single-host form -
// which is exactly what routes the request to the single active client, unchanged. A track path
// can't be mistaken for art and vice-versa; a 1-segment cover (no interior '/') can't match the
// 2-segment form (coverIds are always encodeURIComponent'd, so any '/' is a real separator).
function parseUrl (url = '') {
  const u = String(url)
  let m = ART_PATH2.exec(u)
  if (m) return { kind: 'art', libraryId: m[1], id: decodeURIComponent(m[2]), size: artSize(u) }
  m = ART_PATH1.exec(u)
  if (m) return { kind: 'art', libraryId: null, id: decodeURIComponent(m[1]), size: artSize(u) }
  m = TRACK_PATH2.exec(u)
  if (m) return { kind: 'track', libraryId: m[1], id: m[2] }
  m = TRACK_PATH1.exec(u)
  if (m) return { kind: 'track', libraryId: null, id: m[1] }
  return null
}

// ExoPlayer sniffs the container anyway, but a correct type saves it a probe and
// avoids it refusing an unknown stream outright.
const MIME = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  wav: 'audio/wav'
}

function mimeFor (name = '') {
  const ext = String(name).split('.').pop().toLowerCase()
  return MIME[ext] || 'application/octet-stream'
}

// Parse a Range header against a known total size. Returns { start, end, partial }, or
// null for a 416 (unsatisfiable). No header = the whole thing (start 0, partial false).
function parseRange (header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false }
  const r = RANGE.exec(String(header).trim())
  if (!r) return { start: 0, end: size - 1, partial: false }
  let start = r[1] ? Number(r[1]) : 0
  let end = r[2] ? Number(r[2]) : size - 1
  if (end >= size) end = size - 1
  if (start >= size || start > end) return null
  return { start, end, partial: true }
}

// `quality()` decides, per request, whether to stream the original bytes or ask the
// host for a smaller transcode. It returns null for direct play, or { format, bitrate }
// to transcode. The worklet owns the policy (a Settings choice, and later the network
// type); the shim just asks it at the moment a track is requested, so a change takes
// effect on the next track without rebuilding anything.
function createAudioShim ({ client, log = () => {}, ensure = async () => {}, quality = () => null, cache = null, artStore = null, leaseOk = () => true, hostClient = null, libForTrack = null, libForCover = null }) {
  if (!http) http = require('bare-http1') // on-device only; see the note at the top of this file
  const meta = new Map() // trackId -> { size, mime }

  // The client is REPLACEABLE, and the indirection is the point. On a reconnect
  // the PearTuneClient is a new object, but this server must keep its port: the
  // player was handed http://127.0.0.1:<port>/track/<id> URLs for the whole queue,
  // and they are only still valid if the port is. Tear the shim down with the
  // client and a paused queue silently plays into a dead socket on resume.
  let current = client

  // Which client serves THIS request (multi-host step 2, proposal 2026-07-19 §5). A merged URL
  // names its owning host (libraryId, from the URL); a single-host URL names none, and a resolver
  // (libForTrack/libForCover) is the fallback that maps a bare id to its host in merged mode. When
  // a host is named we route to its pool client (hostClient, which revives it); otherwise the
  // single active client - reviving it via ensure() - exactly as before, so single-host is
  // unchanged. A cache HIT never gets here: it's served by id alone, host-agnostic.
  async function connFor (libraryId, id, resolver) {
    const lib = libraryId || (resolver ? resolver(id) : null)
    if (lib && hostClient) return await hostClient(lib)
    await ensure()
    return current
  }

  async function metaFor (trackId, conn) {
    if (meta.has(trackId)) return meta.get(trackId)
    const t = await (conn || current).get({ id: trackId })
    if (!t) return null
    const m = { size: t.size, mime: mimeFor(t.path || t.title) }
    meta.set(trackId, m)
    return m
  }

  const server = http.createServer(async (req, res) => {
    const parsed = parseUrl(req.url || '')
    if (!parsed) {
      res.writeHead(404)
      return res.end()
    }
    if (parsed.kind === 'art') return serveArt(parsed.id, parsed.size, parsed.libraryId, req, res)

    const trackId = parsed.id
    const trackLib = parsed.libraryId

    try {
      // CACHE FIRST. A complete local copy is served straight from disk - no connection
      // needed, which is the whole point of offline playback. Gated by the LEASE: once
      // authorization has gone stale (a revoked or long-offline device), we stop serving
      // from disk and fall through to the live path, which offline simply fails - so the
      // downloads go dark until the device authorizes again.
      if (cache && cache.has(trackId) && leaseOk()) {
        return serveFromCache(trackId, req, res)
      }

      // The link may have died while the app sat in the background. This request
      // is often the FIRST thing that knows the user is back (they pressed play on
      // the lock screen), so it revives the connection rather than failing. In merged
      // mode connFor picks (and revives) the track's OWNING host; single-host mode
      // revives the one active client, unchanged.
      const conn = await connFor(trackLib, trackId, libForTrack)

      const m = await metaFor(trackId, conn)
      if (!m) {
        res.writeHead(404)
        return res.end()
      }

      // TRANSCODE PATH. When the policy says cap the bitrate (cellular, or a manual
      // quality override), the host makes the bytes on the fly - so there is no known
      // size and no stable byte offsets to seek to. We serve it PROGRESSIVELY: a plain
      // 200 with no content-length, and `accept-ranges: none` so the player does not
      // try to seek into bytes that do not exist yet. This is what Subsonic and
      // Jellyfin do with their own transcodes; direct play below keeps full seeking.
      const tc = quality(trackId)
      if (tc) {
        res.writeHead(200, {
          'content-type': MIME[tc.format] || 'audio/mpeg',
          'accept-ranges': 'none'
        })
        await conn.streamTo(
          { trackId, format: tc.format, bitrate: tc.bitrate },
          (chunk) => res.write(chunk)
        )
        res.end()
        log('shim:transcoded', { track: trackId.slice(0, 8), format: tc.format, bitrate: tc.bitrate })
        return
      }

      // ExoPlayer ALWAYS range-requests, and it seeks by asking for a byte
      // offset. Answering 200-with-everything would work for playback but break
      // seeking, so this path is not optional.
      const rng = parseRange(req.headers.range || req.headers.Range, m.size)
      if (!rng) {
        res.writeHead(416, { 'content-range': `bytes */${m.size}` })
        return res.end()
      }
      const { start, end, partial } = rng
      const length = end - start + 1

      // WRITE-THROUGH. Only when this request is the WHOLE track (the common first,
      // open-ended read) do we tee the bytes to disk; a seek (a bounded/offset range)
      // is not a full copy and is never cached. The sink commits only if every byte
      // arrives - a skip or a dropped connection aborts it, so a partial is never
      // stored as complete. Transcodes (above) are never cached: they have no stable
      // bytes to seek back into.
      const full = start === 0 && end === m.size - 1
      // Tag the bytes with the library they came from (conn.libraryId - set by connect(), so
      // it is right in merged mode AND single-host, where the URL carries no library). It is
      // the only chance to record it: a trackId is a hash of the libraryId, so nothing can
      // work it out afterwards - which is why removing a library used to strand its streamed
      // audio until the LRU cap ate it.
      const sink = (cache && full && !cache.has(trackId))
        ? cache.createSink(trackId, { mime: m.mime, size: m.size, library: trackLib || conn.libraryId || null })
        : null

      res.writeHead(partial ? 206 : 200, {
        'content-type': m.mime,
        'accept-ranges': 'bytes',
        'content-length': String(length),
        ...(partial ? { 'content-range': `bytes ${start}-${end}/${m.size}` } : {})
      })

      // streamTo, NOT stream: accumulate nothing. The player asked for a window
      // of audio, not the whole album in RAM.
      try {
        await conn.streamTo({ trackId, offset: start, length }, (chunk) => {
          res.write(chunk)
          if (sink) sink.write(chunk)
        })
      } catch (e) {
        if (sink) sink.abort()
        throw e
      }

      res.end()
      if (sink) {
        const stored = await sink.commit()
        if (stored) log('cache:stored', { track: trackId.slice(0, 8), size: m.size })
      }
      log('shim:served', { track: trackId.slice(0, 8), start, length })
    } catch (e) {
      // The usual cause is the host destroying the connection - i.e. this device
      // was just revoked. Tear the HTTP response down hard so the player sees a
      // broken stream and stops, rather than stalling on a half-written body.
      log('shim:stream-failed', { track: trackId.slice(0, 8), err: e?.message })
      try {
        res.destroy()
      } catch {}
    }
  })

  // Covers are small and re-requested constantly as the user scrolls a grid, so
  // they are worth caching in the worklet. Bounded, because a big library has a
  // lot of covers and a phone does not have a lot of memory.
  const artCache = new Map()
  const ART_CACHE_MAX = 120

  async function serveArt (coverId, size, libraryId, req, res) {
    // Keyed by size as well as id, or the first request for a cover would decide
    // the resolution of every later one - a thumbnail blown up across a phone
    // screen, or a 1200px image behind every tile in the grid.
    const key = coverId + ':' + size
    try {
      // DISK FIRST for a downloaded cover, at the size the Downloads views request
      // (DEFAULT_ART_SIZE). Serves offline with NO wait - the live path below blocks on
      // ensure(), which offline hangs until a connect timeout, so a fallback there loads
      // the cover minutes late or never. Skips a P2P round-trip online too. Gated by the
      // lease exactly like cached audio, so a revoked/long-offline device goes dark. Only
      // this one size hits disk, so the library grid (120/350/500) keeps its exact-size,
      // freshly-fetched art.
      if (artStore && size === DEFAULT_ART_SIZE && leaseOk()) {
        const disk = artStore.get(coverId)
        if (disk && disk.length) {
          res.writeHead(200, {
            'content-type': 'image/jpeg',
            'content-length': String(disk.length),
            'cache-control': 'max-age=86400'
          })
          log('art:hit', { cover: String(coverId).slice(0, 12) })
          return res.end(disk)
        }
      }

      let buf = artCache.get(key)

      if (!buf) {
        // Route the live cover fetch to its owning host (the URL's libraryId, or the resolver in
        // merged mode); single-host mode names none and revives the one active client, unchanged.
        const conn = await connFor(libraryId, coverId, libForCover)
        buf = await conn.art({ coverId, size })
        if (!buf || !buf.length) {
          res.writeHead(404)
          return res.end()
        }
        if (artCache.size >= ART_CACHE_MAX) {
          artCache.delete(artCache.keys().next().value) // oldest out
        }
        artCache.set(key, buf)
      }

      res.writeHead(200, {
        'content-type': 'image/jpeg',
        'content-length': String(buf.length),
        'cache-control': 'max-age=86400'
      })
      res.end(buf)
    } catch (e) {
      log('shim:art-failed', { cover: String(coverId).slice(0, 12), err: e?.message })
      // A missing cover is not an error worth breaking the page over: answer 404
      // and let the UI show its placeholder.
      try {
        res.writeHead(404)
        res.end()
      } catch {}
    }
  }

  // Serve a track straight from the disk cache. Same Range semantics as the live path,
  // but from a local file - so it works with no connection. Backpressure: pause the file
  // read when the player is not draining, or a 50 MB FLAC read faster than it is consumed
  // would balloon memory on the phone.
  function serveFromCache (trackId, req, res) {
    const e = cache.get(trackId)
    const size = e.size
    const rng = parseRange(req.headers.range || req.headers.Range, size)
    if (!rng) {
      res.writeHead(416, { 'content-range': `bytes */${size}` })
      return res.end()
    }
    const { start, end, partial } = rng
    const length = end - start + 1

    res.writeHead(partial ? 206 : 200, {
      'content-type': e.mime || 'application/octet-stream',
      'accept-ranges': 'bytes',
      'content-length': String(length),
      ...(partial ? { 'content-range': `bytes ${start}-${end}/${size}` } : {})
    })
    cache.touch(trackId)

    const rs = cache.readStream(trackId, start, end)
    rs.on('data', (c) => { if (res.write(c) === false) { rs.pause(); res.once('drain', () => rs.resume()) } })
    rs.on('end', () => { res.end(); log('cache:hit', { track: trackId.slice(0, 8), start, length }) })
    rs.on('error', (err) => {
      log('cache:read-failed', { track: trackId.slice(0, 8), err: err?.message })
      try { res.destroy() } catch {}
    })
  }

  return {
    server,

    // Point the shim at a fresh client after a reconnect, keeping the port (and
    // therefore every URL already handed to the player) valid.
    setClient (c) {
      current = c
    },

    // The UI composes its own art URLs when the SIZE depends on something only it
    // knows - the grid density. 3-up wants a 350px cover where 2-up wants 500, and
    // re-fetching the whole album list just to change a number in a URL would be
    // silly.
    artBase () {
      const { port } = server.address()
      return `http://127.0.0.1:${port}/art/`
    },

    artUrlFor (coverId, size) {
      const { port } = server.address()
      const q = size ? `?s=${Math.min(MAX_ART_SIZE, Number(size) || DEFAULT_ART_SIZE)}` : ''
      return `http://127.0.0.1:${port}/art/${encodeURIComponent(coverId)}${q}`
    },

    async listen () {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        // Port 0 = let the OS pick. Never a fixed port: two PearTune processes,
        // or any other app squatting the port, would otherwise collide.
        server.listen(0, '127.0.0.1', resolve)
      })
      const { port } = server.address()
      log('shim:listening', { port })
      return port
    },

    urlFor (trackId) {
      const { port } = server.address()
      return `http://127.0.0.1:${port}/t/${trackId}`
    },

    // The merged form: the owning host is baked into the URL so the player's held URL routes to the
    // right host for the life of the queue, even across an index rebuild (proposal §5).
    urlForLib (libraryId, trackId) {
      const { port } = server.address()
      return `http://127.0.0.1:${port}/t/${libraryId}/${trackId}`
    },

    close () {
      return new Promise(resolve => server.close(resolve))
    }
  }
}

module.exports = { createAudioShim, mimeFor, parseUrl, DEFAULT_ART_SIZE }

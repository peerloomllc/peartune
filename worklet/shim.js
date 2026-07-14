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

const http = require('bare-http1')

const RANGE = /^bytes=(\d*)-(\d*)$/
const TRACK_PATH = /^\/t\/([a-z0-9]+)/i
// Artwork rides the same loopback server, so the WebView can just use a plain
// <img src="http://127.0.0.1:PORT/art/...">. The bytes still travel over P2P; the
// browser never knows. The alternative (pipe every cover through IPC as base64)
// would be slower, fatter, and would make a grid of 50 covers miserable.
const ART_PATH = /^\/art\/([^/?#]+)/

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

function createAudioShim ({ client, log = () => {} }) {
  const meta = new Map() // trackId -> { size, mime }

  async function metaFor (trackId) {
    if (meta.has(trackId)) return meta.get(trackId)
    const t = await client.get({ id: trackId })
    if (!t) return null
    const m = { size: t.size, mime: mimeFor(t.path || t.title) }
    meta.set(trackId, m)
    return m
  }

  const server = http.createServer(async (req, res) => {
    const art = ART_PATH.exec(req.url || '')
    if (art) return serveArt(decodeURIComponent(art[1]), req, res)

    const match = TRACK_PATH.exec(req.url || '')
    if (!match) {
      res.writeHead(404)
      return res.end()
    }

    const trackId = match[1]

    try {
      const m = await metaFor(trackId)
      if (!m) {
        res.writeHead(404)
        return res.end()
      }

      let start = 0
      let end = m.size - 1
      let partial = false

      // ExoPlayer ALWAYS range-requests, and it seeks by asking for a byte
      // offset. Answering 200-with-everything would work for playback but break
      // seeking, so this path is not optional.
      const header = req.headers.range || req.headers.Range
      if (header) {
        const r = RANGE.exec(String(header).trim())
        if (r) {
          partial = true
          if (r[1]) start = Number(r[1])
          if (r[2]) end = Number(r[2])
          if (end >= m.size) end = m.size - 1
          if (start >= m.size || start > end) {
            res.writeHead(416, { 'content-range': `bytes */${m.size}` })
            return res.end()
          }
        }
      }

      const length = end - start + 1

      res.writeHead(partial ? 206 : 200, {
        'content-type': m.mime,
        'accept-ranges': 'bytes',
        'content-length': String(length),
        ...(partial ? { 'content-range': `bytes ${start}-${end}/${m.size}` } : {})
      })

      // streamTo, NOT stream: accumulate nothing. The player asked for a window
      // of audio, not the whole album in RAM.
      await client.streamTo({ trackId, offset: start, length }, (chunk) => {
        res.write(chunk)
      })

      res.end()
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

  async function serveArt (coverId, req, res) {
    try {
      let buf = artCache.get(coverId)

      if (!buf) {
        buf = await client.art({ coverId, size: 300 })
        if (!buf || !buf.length) {
          res.writeHead(404)
          return res.end()
        }
        if (artCache.size >= ART_CACHE_MAX) {
          artCache.delete(artCache.keys().next().value) // oldest out
        }
        artCache.set(coverId, buf)
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

  return {
    server,

    artUrlFor (coverId) {
      const { port } = server.address()
      return `http://127.0.0.1:${port}/art/${encodeURIComponent(coverId)}`
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

    close () {
      return new Promise(resolve => server.close(resolve))
    }
  }
}

module.exports = { createAudioShim, mimeFor }

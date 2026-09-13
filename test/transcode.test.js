// The shared transcoder (proposal 2026-08-16 slice 4): one ffmpeg wrapper serving
// three adapters. The piped-input path is what the Subsonic/Jellyfin adapters use to
// start an upstream ORIGINAL mid-song - the part their servers cannot be trusted to
// do. Skips cleanly where ffmpeg is not installed, so the gate stays green on a bare
// CI box.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const { spawnTranscode, hasFfmpeg } = require('../host/transcode')

let HAS_FFMPEG = false
try { require('child_process').execSync('ffmpeg -hide_banner -version', { stdio: 'ignore' }); HAS_FFMPEG = true } catch {}

const FIXTURE = path.join(__dirname, 'fixtures', 'music', 'Led Zeppelin', 'IV')

function firstAudioFile () {
  const dir = fs.readdirSync(FIXTURE)
  const f = dir.find(n => /\.(flac|mp3|m4a|ogg)$/.test(n))
  return path.join(FIXTURE, f)
}

async function drain (stream) {
  const chunks = []
  for await (const c of stream) chunks.push(c)
  return Buffer.concat(chunks)
}

test('hasFfmpeg answers a boolean and memoizes', async () => {
  assert.equal(await hasFfmpeg(), HAS_FFMPEG)
  assert.equal(await hasFfmpeg(), HAS_FFMPEG)
})

test('a PIPED input transcodes, and an offset shortens it', { skip: !HAS_FFMPEG && 'ffmpeg not installed' }, async () => {
  const file = firstAudioFile()
  const full = await drain(spawnTranscode(fs.createReadStream(file), { format: 'mp3', bitrate: 128 }))
  const tail = await drain(spawnTranscode(fs.createReadStream(file), { format: 'mp3', bitrate: 128, timeOffsetMs: 500 }))
  assert.ok(full.length > 0, 'piped transcode produced audio')
  assert.ok(tail.length > 0, 'offset piped transcode produced audio')
  assert.ok(tail.length < full.length, `offset (${tail.length}b) shorter than full (${full.length}b)`)
  const head = tail.subarray(0, 3).toString('hex')
  assert.ok(head === '494433' || (tail[0] === 0xff && (tail[1] & 0xe0) === 0xe0), 'still a real MP3')
})

test('a FILE input with an offset matches the folder adapter contract', { skip: !HAS_FFMPEG && 'ffmpeg not installed' }, async () => {
  const file = firstAudioFile()
  const full = await drain(spawnTranscode(file, { format: 'mp3', bitrate: 128 }))
  const tail = await drain(spawnTranscode(file, { format: 'mp3', bitrate: 128, timeOffsetMs: 500 }))
  assert.ok(tail.length > 0 && tail.length < full.length)
})

// An Audiobookshelf file is behind a Bearer token, and a book's index is often at the END of
// its m4b, which ffmpeg can only reach by seeking. So the transcode reads the URL itself (not a
// pipe) and sends the header (proposal 2026-09-13-audiobookshelf-books-source).
test('an HTTP input with headers transcodes an index-at-the-end m4b, and seeks', { skip: !HAS_FFMPEG && 'ffmpeg not installed' }, async (t) => {
  const http = require('http')
  const m4b = fs.readFileSync(path.join(__dirname, 'fixtures', 'chapters', 'end-index.m4b'))
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer secret') { res.writeHead(401); return res.end() }
    const r = (req.headers.range || '').match(/bytes=(\d+)-(\d*)/)
    if (!r) { res.writeHead(200, { 'content-type': 'audio/mp4', 'content-length': m4b.length, 'accept-ranges': 'bytes' }); return res.end(m4b) }
    const start = Number(r[1]); const end = r[2] ? Number(r[2]) : m4b.length - 1
    res.writeHead(206, { 'content-type': 'audio/mp4', 'content-range': `bytes ${start}-${end}/${m4b.length}`, 'content-length': end - start + 1, 'accept-ranges': 'bytes' })
    res.end(m4b.subarray(start, end + 1))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/api/items/x/file/1`
  const headers = { Authorization: 'Bearer secret' }

  const full = await drain(spawnTranscode(url, { format: 'mp3', bitrate: 64, headers }))
  const tail = await drain(spawnTranscode(url, { format: 'mp3', bitrate: 64, headers, timeOffsetMs: 2000 }))
  assert.ok(full.length > 0, 'nothing came out with the header')
  assert.ok(tail.length > 0 && tail.length < full.length, `seek did not shorten it: ${tail.length} vs ${full.length}`)
  const refused = await drain(spawnTranscode(url, { format: 'mp3', bitrate: 64 }))
  assert.equal(refused.length, 0, 'without the header the server refuses and nothing plays')
})

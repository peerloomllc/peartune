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

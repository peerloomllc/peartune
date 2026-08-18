'use strict'

// The one transcoder, shared by every adapter (proposal 2026-08-16-seekable-transcodes,
// slice 4). The folder adapter always transcoded locally; the Subsonic and Jellyfin
// adapters let the UPSTREAM server transcode - which is fine until a time offset is
// asked for, because upstream offset support is patchy (Subsonic documents timeOffset
// for video only). So a seek into a server-backed transcode runs through HERE: fetch
// the upstream ORIGINAL, decode locally, start at the target.
//
// WHERE THE BINARY COMES FROM lives in ./ffmpeg-bin.js, because there are three
// deployments and only two of them have ffmpeg on PATH. `PEARTUNE_FFMPEG` still
// overrides everything; otherwise a binary bundled into a desktop install is used
// before falling back to PATH. Read once at load, so the require-cache dance in
// test/folder.test.js still swaps it.

const { spawn } = require('child_process')
const { resolveFfmpeg } = require('./ffmpeg-bin')

const FFMPEG = resolveFfmpeg()

const TRANSCODE = {
  mp3: { codec: 'libmp3lame', container: 'mp3' },
  opus: { codec: 'libopus', container: 'ogg' },
  aac: { codec: 'aac', container: 'adts' }
}

// Is ffmpeg actually here? Checked ONCE and memoized: if it is missing, transcoding
// silently degrades to what each adapter did before - raw bytes from the folder,
// upstream transcodes for servers - never an error. Also what ping's caps.timeOffset
// answers with: a host that cannot run ffmpeg must not invite ?t= requests it would
// serve from second 0.
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

// Spawn ffmpeg and hand back its stdout as the audio stream, or null if it could not
// start. `input` is a file path (folder adapter) or a readable stream (an upstream
// original being decoded locally).
//
// -ss placement: BEFORE -i for a file (input seeking - keyframe-fast and exact enough
// for audio). A piped input cannot be seeked, so ffmpeg decodes and discards up to the
// target - audio decodes far faster than realtime, so even minutes of prefix cost well
// under a second.
//
// A transcode nobody finishes reading (the phone paused, the link dropped) must not
// leave ffmpeg chewing CPU on a Pi. Kill it when the reader is done or breaks; killing
// also unblocks the upstream pipe, whose own error is swallowed - a dead consumer is
// the expected way these end.
function spawnTranscode (input, { format = 'mp3', bitrate, timeOffsetMs, log = () => {} } = {}) {
  const spec = TRANSCODE[format] || TRANSCODE.mp3
  const ss = Math.max(0, Number(timeOffsetMs) || 0)
  const piped = typeof input !== 'string'
  const args = ['-hide_banner', '-loglevel', 'error']
  if (ss > 0 && !piped) args.push('-ss', String(ss / 1000))
  args.push('-i', piped ? 'pipe:0' : input)
  if (ss > 0 && piped) args.push('-ss', String(ss / 1000))
  args.push('-vn', '-map', '0:a:0', '-c:a', spec.codec)
  if (bitrate) args.push('-b:a', `${Number(bitrate)}k`)
  args.push('-f', spec.container, 'pipe:1')

  let ff
  try {
    ff = spawn(FFMPEG, args, { stdio: [piped ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
  } catch {
    return null // ffmpeg vanished between the check and here
  }

  const kill = () => { try { ff.kill('SIGKILL') } catch {} }
  ff.stdout.on('close', kill)
  ff.stdout.on('error', kill)
  ff.on('error', (e) => { log('transcode:failed', { err: e?.message }); kill() })
  ff.stderr.on('data', (d) => log('transcode:stderr', { msg: String(d).slice(0, 200) }))

  if (piped) {
    input.on('error', () => kill())
    ff.stdin.on('error', () => {}) // EPIPE when we kill ffmpeg first - expected, not news
    input.pipe(ff.stdin)
  }

  return ff.stdout
}

module.exports = { FFMPEG, TRANSCODE, hasFfmpeg, spawnTranscode }

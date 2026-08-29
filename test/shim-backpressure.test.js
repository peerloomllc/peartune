// A slow player must not pull the whole track into memory.
//
// The shim used to make ONE wire request for the range the player asked for and write every
// chunk into the response with the return value of res.write() dropped, so a player draining
// slower than the host sent accumulated the difference in memory. Bounded by the range, so for
// audio it was about one track resident and nobody noticed; the identical shape took PearCinema
// from 363 MB to 2.2 GB on a 2.5 GB film and Android killed the app (2026-08-28).
//
// The fix is windowed reads with a drain gate between them, asked through worklet/backpressure
// so it works on Bare's streamx response and not only on Node's. These tests drive the shim's
// real request handler with a fake connection that serves from a buffer and a fake response
// with Bare's SHAPE: no writableNeedDrain, isBackpressured on the constructor.

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('module')
const { Writable } = require('streamx')

// createAudioShim requires bare-http1 lazily; hand it a server that just exposes the handler.
const realLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'bare-http1') {
    return {
      createServer (handler) {
        return { handler, once () {}, listen (_p, _h, cb) { if (cb) setImmediate(cb) }, address () { return { port: 1 } }, close (cb) { if (cb) cb() } }
      }
    }
  }
  return realLoad.call(this, request, ...rest)
}
const { createAudioShim, STREAM_WINDOW } = require('../worklet/shim')
const { needsDrain } = require('../worklet/backpressure')

const TRACK = Buffer.from(Array.from({ length: 5 * STREAM_WINDOW }, (_, i) => i % 251))
const ID = 'deadbeefcafe'

// A connection that serves TRACK from memory in 64 KB pieces, the way the wire hands chunks
// to onchunk: synchronously, with no way to pause mid-request. Every window it is asked for
// is recorded, because "how much did the shim ASK for" is the thing under test.
function fakeConn (buf = TRACK) {
  const windows = []
  return {
    windows,
    libraryId: 'lib1',
    async get ({ id }) { return id === ID ? { id, title: 'song.flac', path: '/m/song.flac', size: buf.length, suffix: 'flac' } : null },
    async streamTo ({ offset, length }, onchunk) {
      windows.push({ offset, length })
      await new Promise(setImmediate) // a round trip
      for (let o = offset; o < offset + length; o += 65536) {
        onchunk(buf.subarray(o, Math.min(offset + length, o + 65536)))
      }
      return { total: length }
    }
  }
}

// A response shaped like Bare's: a streamx Writable whose write completes only when the
// "player" reads, and which does NOT carry Node's writableNeedDrain. `release()` lets the
// player catch up; until then everything written piles up in the queue the gate watches.
function fakeRes () {
  const chunks = []
  let pending = []
  let reading = false
  const res = new Writable({
    highWaterMark: 16384,
    write (data, cb) {
      chunks.push(Buffer.from(data))
      if (reading) cb(null); else pending.push(cb)
    },
    // bare-http1 releases its pending write when the response is destroyed
    // (HTTPServerResponse._predestroy), which is what lets `close` fire under a stuck
    // write. Without this the fake would hang where the phone does not.
    predestroy () { const p = pending; pending = []; for (const cb of p) cb(null) }
  })
  res.statusCode = 0
  res.headers = null
  res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers }
  res.chunks = chunks
  res.release = () => { reading = true; const p = pending; pending = []; for (const cb of p) cb(null) }
  res.body = () => Buffer.concat(chunks)
  Object.defineProperty(res, 'writableNeedDrain', { value: undefined, configurable: true })
  return res
}

function serve (conn, range) {
  const shim = createAudioShim({ defaultClient: async () => conn })
  const res = fakeRes()
  const req = { url: '/t/' + ID, method: 'GET', headers: range ? { range } : {} }
  const done = shim.server.handler(req, res)
  return { res, done }
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms))

test('THE FAKE ASKS THE QUESTION THE PHONE ASKS: no writableNeedDrain, isBackpressured instead', () => {
  const res = fakeRes()
  assert.equal(res.writableNeedDrain, undefined)
  assert.equal(needsDrain(res), false)
  for (let i = 0; i < 4; i++) res.write(Buffer.alloc(8192))
  assert.equal(needsDrain(res), true, 'a stuck response must read as needing drain on Bare\'s shape')
})

test('A STUCK PLAYER BOUNDS THE READ-AHEAD: about one window, not the whole track', async () => {
  const conn = fakeConn()
  const { res, done } = serve(conn, 'bytes=0-')
  // Long enough that an ungated loop would have fetched all five windows: each is one
  // setImmediate round trip.
  await settle(200)
  const asked = conn.windows.reduce((n, w) => n + w.length, 0)
  assert.ok(conn.windows.length < 5, `the gate must stop asking while the player holds what it has, saw ${conn.windows.length} windows`)
  assert.ok(asked <= 2 * STREAM_WINDOW, `read-ahead must stay near one window, saw ${asked}`)
  // Let the player catch up: every byte arrives, byte-identical, in bounded windows.
  res.release()
  await done
  assert.equal(res.statusCode, 206)
  assert.equal(res.headers['content-length'], String(TRACK.length))
  assert.ok(res.body().equals(TRACK), 'the windowed read must be byte-identical to the file')
  assert.equal(conn.windows.length, 5)
  assert.ok(conn.windows.every((w) => w.length <= STREAM_WINDOW), 'no request may exceed a window')
  assert.deepEqual(conn.windows[0], { offset: 0, length: STREAM_WINDOW })
})

test('A SEEK IS EXACTLY ITS BYTES, WINDOWED THE SAME WAY', async () => {
  const conn = fakeConn()
  const start = 1000; const end = 3 * STREAM_WINDOW + 999
  const { res, done } = serve(conn, `bytes=${start}-${end}`)
  res.release()
  await done
  assert.equal(res.statusCode, 206)
  assert.equal(res.headers['content-range'], `bytes ${start}-${end}/${TRACK.length}`)
  assert.ok(res.body().equals(TRACK.subarray(start, end + 1)))
  const asked = conn.windows.reduce((n, w) => n + w.length, 0)
  assert.equal(asked, end - start + 1, 'the windows must add up to the range and nothing more')
  assert.equal(conn.windows[0].offset, start)
})

test('A HANGUP MID-STREAM STOPS THE LOOP instead of fetching the rest into a dead response', async () => {
  const conn = fakeConn()
  const { res, done } = serve(conn, 'bytes=0-')
  await settle(50)
  const before = conn.windows.length
  res.destroy() // the player skipped
  await done
  await settle(50)
  assert.ok(conn.windows.length <= before + 1, `after a hangup the shim must not keep asking, saw ${conn.windows.length - before} more windows`)
})

test('A WINDOW THAT MOVES NOTHING IS A FAILURE, NOT A SPIN', async () => {
  const conn = fakeConn()
  conn.streamTo = async ({ offset, length }) => { conn.windows.push({ offset, length }); return { total: 0 } }
  const { res, done } = serve(conn, 'bytes=0-')
  res.release()
  await done
  assert.equal(conn.windows.length, 1, 'one empty window and the shim must give up')
  assert.ok(res.destroyed, 'the response is torn down so the player sees a broken stream, not a stall')
})

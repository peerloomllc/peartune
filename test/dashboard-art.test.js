// The dashboard's /api/art endpoint vs the two kinds of stream an adapter returns.
//
// The folder adapter hands back a Node fs stream, which has .pipe. The Subsonic and
// Jellyfin adapters hand back fetch()'s WEB ReadableStream, which does not. The
// handler wrote its 200, called stream.pipe(res), threw TypeError, and the json(500)
// in the outer catch then threw ERR_HTTP_HEADERS_SENT out of the request handler -
// an unhandled rejection that took down the ENTIRE host process, mid-song, the
// moment the dashboard rendered a now-playing thumbnail (found 2026-08-17 on the
// Umbrel with the Jellyfin source: the phone sat on "buffering" until it
// reconnected to the restarted host).

const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('stream')

const { startDashboard } = require('../host/ui/server')

const ART_BYTES = Buffer.from('not-really-a-jpeg-but-bytes-are-bytes')

function webStreamOf (buf) {
  return new ReadableStream({
    start (controller) {
      controller.enqueue(buf)
      controller.close()
    }
  })
}

test('/api/art serves a WEB stream (what Subsonic and Jellyfin return) without crashing', async (t) => {
  const host = { adapter: { art: async () => webStreamOf(ART_BYTES) } }
  const dash = await startDashboard({ host, bind: '127.0.0.1', port: 0, password: '' })
  t.after(() => dash.close())
  const port = dash.server.address().port

  const res = await fetch(`http://127.0.0.1:${port}/api/art?id=abc`)
  assert.equal(res.status, 200)
  assert.equal(Buffer.compare(Buffer.from(await res.arrayBuffer()), ART_BYTES), 0, 'the bytes arrive intact')

  // And the process is still standing: the same server answers the next request.
  const again = await fetch(`http://127.0.0.1:${port}/api/art?id=abc`)
  assert.equal(again.status, 200)
})

test('/api/art still serves a NODE stream (what the folder adapter returns)', async (t) => {
  const host = { adapter: { art: async () => Readable.from([ART_BYTES]) } }
  const dash = await startDashboard({ host, bind: '127.0.0.1', port: 0, password: '' })
  t.after(() => dash.close())
  const port = dash.server.address().port

  const res = await fetch(`http://127.0.0.1:${port}/api/art?id=abc`)
  assert.equal(res.status, 200)
  assert.equal(Buffer.compare(Buffer.from(await res.arrayBuffer()), ART_BYTES), 0)
})

test('a handler that dies AFTER writing headers kills that response, not the process', async (t) => {
  // A stream whose .pipe throws is exactly the old failure shape: the 200 is
  // already written when the handler blows up. The catch must not answer with
  // json(500) - writeHead on a sent response is the ERR_HTTP_HEADERS_SENT that
  // used to escape the handler and crash the host.
  const bomb = { pipe: () => { throw new Error('boom after headers') } }
  const host = { adapter: { art: async () => bomb } }
  const dash = await startDashboard({ host, bind: '127.0.0.1', port: 0, password: '' })
  t.after(() => dash.close())
  const port = dash.server.address().port

  // The response dies mid-flight; fetch surfaces that as a rejection or an
  // early-terminated body. Either is fine - what matters is what comes next.
  await fetch(`http://127.0.0.1:${port}/api/art?id=abc`)
    .then(r => r.arrayBuffer())
    .catch(() => null)

  // The server survived and still answers (on a route that does not blow up).
  const alive = await fetch(`http://127.0.0.1:${port}/api/nope`).catch(() => null)
  assert.ok(alive, 'the server is still accepting connections after a mid-response failure')
  assert.equal(alive.status, 404, 'and it is the dashboard answering, not a reset socket')
})

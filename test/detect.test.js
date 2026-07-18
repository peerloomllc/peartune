// Source autodetection: recognise a co-located Jellyfin/Subsonic from its public,
// no-auth endpoint by a server-specific marker, so the dashboard can pre-fill the
// internal address the operator would otherwise have to know.

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')

const { probe } = require('../host/detect')

async function fakeServer (routes) {
  const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0]
    const body = routes[path]
    if (body == null) { res.writeHead(404); return res.end('nope') }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(body)
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

test('a Jellyfin server is detected from /System/Info/Public', async (t) => {
  const { server, base } = await fakeServer({
    '/System/Info/Public': JSON.stringify({ ProductName: 'Jellyfin Server', ServerName: 'Living Room' })
  })
  t.after(() => server.close())
  const r = await probe('jellyfin', base)
  assert.ok(r, 'should detect')
  assert.equal(r.kind, 'jellyfin')
  assert.equal(r.name, 'Living Room')
  assert.equal(r.server, 'Jellyfin')
})

test('an Emby server is recognised (rides the jellyfin kind)', async (t) => {
  const { server, base } = await fakeServer({
    '/System/Info/Public': JSON.stringify({ ProductName: 'Emby Server', ServerName: 'Basement' })
  })
  t.after(() => server.close())
  const r = await probe('jellyfin', base)
  assert.equal(r.kind, 'jellyfin')
  assert.equal(r.server, 'Emby')
})

test('a Subsonic server is detected from a ping envelope (no auth needed)', async (t) => {
  const { server, base } = await fakeServer({
    // What a real Subsonic server returns for an unauthenticated ping.
    '/rest/ping.view': JSON.stringify({ 'subsonic-response': { status: 'failed', error: { code: 10 } } })
  })
  t.after(() => server.close())
  const r = await probe('subsonic', base)
  assert.ok(r, 'should detect')
  assert.equal(r.kind, 'subsonic')
})

test('an unrelated HTTP server is NOT a false positive', async (t) => {
  const { server, base } = await fakeServer({ '/': 'hello', '/System/Info/Public': 'not json' })
  t.after(() => server.close())
  assert.equal(await probe('jellyfin', base), null)
  assert.equal(await probe('subsonic', base), null)
})

test('a dead address resolves to null, not a throw', async () => {
  // Nothing listening here; must fail fast and quietly.
  assert.equal(await probe('jellyfin', 'http://127.0.0.1:1'), null)
})

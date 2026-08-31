// WHO MAY DRIVE THE DASHBOARD when there is no password to ask for.
//
// The desktop tray app starts this dashboard with no password on a loopback bind
// (desktop/src/main/index.js), and with no password there is no session cookie - so
// SameSite=Strict, which is what protects the Umbrel install, protects nothing here.
// A page the user visits could blind-POST to /api/pair/start, and with DNS rebinding
// could read the answer back: a pairing link is full library access.
//
// Found 2026-08-31 by an audit of PearCinema and verified present here before fixing.
// Two headers, two different attacks, and the Umbrel case must not be broken by the
// fix - the last test is the one pinning that.

const test = require('node:test')
const assert = require('node:assert/strict')

const { startDashboard } = require('../host/ui/server')

// Enough of a host for the dashboard to answer /api/state.
function fakeHost () {
  return {
    log: () => {},
    libraryName: 'Test',
    libraryId: 'lib',
    publicKey: Buffer.alloc(32),
    pairing: false,
    sourceView: null,
    sourceError: null,
    adapter: { kind: 'folder', stats: async () => ({ source: 'folder', tracks: 0, albums: 0, artists: 0, scannedAt: null }) },
    grants: {
      list: async () => [], listPersons: async () => [], personLabels: async () => new Map()
    },
    userState: { listRequests: async () => [] },
    listDevices: async () => [],
    getRescanIntervalMin: () => 0,
    speakers: { enabled: false },
    connections: { size: 0 }
  }
}

async function dashboard (t, { password = '' } = {}) {
  const dash = await startDashboard({ host: fakeHost(), bind: '127.0.0.1', port: 0, password })
  t.after(() => dash.close())
  return dash.server.address().port
}

// A raw request with headers fetch() will not let us forge (Host is one of them).
function raw (port, { host, origin, method = 'GET', path = '/api/state' } = {}) {
  const net = require('net')
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      const lines = [`${method} ${path} HTTP/1.1`, `Host: ${host}`]
      if (origin !== undefined) lines.push(`Origin: ${origin}`)
      lines.push('Connection: close', '', '')
      sock.write(lines.join('\r\n'))
    })
    let out = ''
    sock.on('data', (c) => { out += c })
    sock.on('end', () => resolve({ status: Number(out.slice(9, 12)), body: out }))
    sock.on('error', reject)
  })
}

test('a loopback request with no Origin is allowed - that is the dashboard itself', async (t) => {
  const port = await dashboard(t)
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `127.0.0.2:${port}`]) {
    const res = await raw(port, { host })
    assert.equal(res.status, 200, `Host: ${host} is us`)
  }
})

test('DNS REBINDING is refused: the Host header still carries the attacker name', async (t) => {
  const port = await dashboard(t)
  // evil.example re-resolved to 127.0.0.1, so the browser thinks it is same-origin and
  // will hand the answers over - but it still sends the name it dialled.
  const res = await raw(port, { host: `evil.example:${port}`, origin: 'http://evil.example' })
  assert.equal(res.status, 403)
  assert.match(res.body, /127\.0\.0\.1/, 'and it says where the dashboard actually is')
})

test('PLAIN CSRF is refused: our Host, somebody else\'s Origin', async (t) => {
  const port = await dashboard(t)
  // A page the user visits POSTs here. readBody accepts any content-type, so this is a
  // CORS simple request with no preflight, and the Host header is honestly ours - only
  // Origin gives it away. It cannot read the reply, but pairing does its damage inbound.
  const res = await raw(port, {
    host: `127.0.0.1:${port}`, origin: 'https://evil.example', method: 'POST', path: '/api/pair/start'
  })
  assert.equal(res.status, 403, 'a cross-site pair/start must never open a window')
})

test('an opaque Origin (a sandboxed iframe, a file:// page) is refused', async (t) => {
  const port = await dashboard(t)
  assert.equal((await raw(port, { host: `127.0.0.1:${port}`, origin: 'null' })).status, 403)
  assert.equal((await raw(port, { host: `127.0.0.1:${port}`, origin: 'not a url' })).status, 403)
})

test('our own Origin is allowed, so the dashboard\'s own fetches still work', async (t) => {
  const port = await dashboard(t)
  for (const origin of [`http://127.0.0.1:${port}`, `http://localhost:${port}`]) {
    assert.equal((await raw(port, { host: `127.0.0.1:${port}`, origin })).status, 200, origin)
  }
})

test('A PASSWORD-PROTECTED DASHBOARD IS UNTOUCHED: 401, never 403, to a LAN name', async (t) => {
  // The Umbrel install is reached at umbrel.local or a bare LAN IP, and nothing here
  // can know the legitimate name. Refusing those would break the Umbrel to fix the
  // desktop. With a password the session cookie is SameSite=Strict, which is the real
  // control for both attacks above - so the guard must not run at all.
  const port = await dashboard(t, { password: 'hunter2' })
  const res = await raw(port, { host: 'umbrel.local', origin: 'http://umbrel.local' })
  assert.equal(res.status, 401, 'the password gate answers, not the host guard')
})

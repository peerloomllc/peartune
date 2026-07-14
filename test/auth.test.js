// The lock on the control plane. Proposal 2026-07-14-dashboard-auth (T3).
//
// The dashboard can revoke every device and open a pairing window onto the whole
// library. It had no auth at all, which was defensible only while it was bound to
// loopback behind Umbrel's app_proxy - and that stopped being true the moment we
// measured that the host needs network_mode: host to holepunch (the proxy cannot
// front a host-networked service).
//
// The most important test in this file is the one that asserts the host REFUSES TO
// START rather than serving an unauthenticated LAN port. A warning is not a control.

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')

const { createAuth, requireSafeBind, MAX_FAILURES } = require('../host/ui/auth')

// --- fail closed -------------------------------------------------------------

test('THE HOST REFUSES TO START on a non-loopback bind with no password', () => {
  assert.throws(
    () => requireSafeBind('0.0.0.0', ''),
    /refusing to start/,
    'serving the revoke button on a LAN with no password must be impossible, not merely discouraged'
  )
  assert.throws(() => requireSafeBind('192.168.1.50', ''), /refusing to start/)
})

test('loopback with no password is fine (today, and after an SSH tunnel)', () => {
  assert.doesNotThrow(() => requireSafeBind('127.0.0.1', ''))
  assert.doesNotThrow(() => requireSafeBind('localhost', ''))
})

test('a non-loopback bind WITH a password is allowed - that is the Umbrel app', () => {
  assert.doesNotThrow(() => requireSafeBind('0.0.0.0', 'hunter2'))
})

// --- the gate ----------------------------------------------------------------

const reqOf = (cookie) => ({
  headers: cookie ? { cookie } : {},
  socket: { remoteAddress: '10.0.0.7' }
})

test('no password configured means no gate at all (unchanged behaviour)', () => {
  const auth = createAuth('')
  assert.equal(auth.enabled, false)
  assert.equal(auth.guard(reqOf()), true)
})

test('with a password, a request with no session is NOT allowed', () => {
  const auth = createAuth('hunter2')
  assert.equal(auth.enabled, true)
  assert.equal(auth.guard(reqOf()), false)
  assert.equal(auth.guard(reqOf('peartune_session=made-up')), false)
})

// The login flow, driven through a real server so the cookie round-trips the way a
// browser would do it.
async function serverWith (password) {
  const auth = createAuth(password)
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (auth.handle(req, res, url)) return
    res.writeHead(auth.guard(req) ? 200 : 401)
    res.end(auth.guard(req) ? 'dashboard' : 'no')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  return { server, base }
}

test('the right password mints a session; the session opens the dashboard', async (t) => {
  const { server, base } = await serverWith('hunter2')
  t.after(() => server.close())

  const login = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'hunter2' })
  })
  assert.equal(login.status, 200)

  const cookie = login.headers.get('set-cookie')
  assert.match(cookie, /HttpOnly/, 'the page never needs to read this cookie; script we are defending against would')
  assert.match(cookie, /SameSite=Strict/)

  const page = await fetch(base + '/', { headers: { cookie: cookie.split(';')[0] } })
  assert.equal(page.status, 200)
  assert.equal(await page.text(), 'dashboard')
})

test('the WRONG password does not authenticate', async (t) => {
  const { server, base } = await serverWith('hunter2')
  t.after(() => server.close())

  const r = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'hunter3' })
  })
  assert.equal(r.status, 401)
  assert.equal(r.headers.get('set-cookie'), null, 'a failed login must not hand out a session')
})

test('the API is 401 without a session (not a redirect, not a 200)', async (t) => {
  const { server, base } = await serverWith('hunter2')
  t.after(() => server.close())

  const r = await fetch(base + '/api/state')
  assert.equal(r.status, 401)
})

test('brute force is rate limited', async (t) => {
  const { server, base } = await serverWith('hunter2')
  t.after(() => server.close())

  for (let i = 0; i < MAX_FAILURES; i++) {
    const r = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'nope' })
    })
    assert.equal(r.status, 401)
  }

  // Even the RIGHT password is refused while locked out - otherwise the limit only
  // slows down an attacker who happens to guess late.
  const after = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'hunter2' })
  })
  assert.equal(after.status, 429)
})

test('logout destroys the session', async (t) => {
  const { server, base } = await serverWith('hunter2')
  t.after(() => server.close())

  const login = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'hunter2' })
  })
  const cookie = login.headers.get('set-cookie').split(';')[0]

  await fetch(base + '/api/logout', { method: 'POST', headers: { cookie } })

  const after = await fetch(base + '/', { headers: { cookie } })
  assert.equal(after.status, 401, 'the old cookie must be worthless after logout')
})

test('the login page parses (it is a template literal, like the dashboard)', () => {
  const page = require('../host/ui/login')
  const script = page.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(script)
  assert.doesNotThrow(() => new Function(script[1])) // eslint-disable-line no-new-func
})

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
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  createAuth, requireSafeBind, resolveDashboardPassword, generatePassword,
  MAX_FAILURES, PASSWORD_FILE, COOKIE
} = require('../host/ui/auth')

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

// --- generate-and-print (proposal 2026-07-18 host-platform-expansion) ---------
//
// A bare non-loopback install (a NAS `docker run`, systemd) has no platform to
// mint ${APP_PASSWORD}, so instead of requireSafeBind refusing to start, the host
// mints a password. The invariant that must survive: whatever this returns for a
// non-loopback bind, requireSafeBind then ACCEPTS - a LAN dashboard is never open.

const freshDataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'peartune-auth-'))

test('an explicitly-set password always wins (never generates), on any bind', () => {
  const dataDir = freshDataDir()
  const r = resolveDashboardPassword({ password: 'chosen', bind: '0.0.0.0', dataDir })
  assert.deepEqual(r, { password: 'chosen', source: 'explicit' })
  assert.equal(fs.existsSync(path.join(dataDir, PASSWORD_FILE)), false, 'must not write a file when one is set')
})

test('loopback with no password stays password-free (the no-gate path)', () => {
  const dataDir = freshDataDir()
  const r = resolveDashboardPassword({ password: '', bind: '127.0.0.1', dataDir })
  assert.deepEqual(r, { password: '', source: 'none' })
  assert.equal(fs.existsSync(path.join(dataDir, PASSWORD_FILE)), false)
})

test('a non-loopback bind with no password GENERATES one, and requireSafeBind then accepts it', () => {
  const dataDir = freshDataDir()
  const r = resolveDashboardPassword({ password: '', bind: '0.0.0.0', dataDir })
  assert.equal(r.source, 'generated')
  assert.ok(r.password.length >= 16, 'a generated password should carry real entropy')
  // The whole point: the fail-closed guard must now PASS with the minted password.
  assert.doesNotThrow(() => requireSafeBind('0.0.0.0', r.password))
})

test('the generated password is persisted 0600 and STABLE across restarts', () => {
  const dataDir = freshDataDir()
  const first = resolveDashboardPassword({ password: '', bind: '0.0.0.0', dataDir })
  const file = path.join(dataDir, PASSWORD_FILE)

  const mode = fs.statSync(file).mode & 0o777
  assert.equal(mode, 0o600, 'a dashboard credential must not sit world-readable')

  // A restart reads the SAME password back (source: file), not a new one - otherwise
  // every restart would silently lock out every browser.
  const second = resolveDashboardPassword({ password: '', bind: '0.0.0.0', dataDir })
  assert.equal(second.source, 'file')
  assert.equal(second.password, first.password)
})

test('generatePassword is grouped and uses only unambiguous z32 characters', () => {
  const pw = generatePassword()
  assert.match(pw, /^[ybndrfg8ejkmcpqxot1uwisza345h769]{4}(-[ybndrfg8ejkmcpqxot1uwisza345h769]{4})+$/)
  assert.notEqual(generatePassword(), generatePassword(), 'each call is random')
})

// --- live password change (dashboard change/reset) ---------------------------

test('setPassword swaps the live secret; the old password stops working', () => {
  const auth = createAuth('hunter2')
  assert.equal(auth.verify('hunter2'), true)
  assert.equal(auth.verify('nope'), false)

  auth.setPassword('new-secret-1')
  assert.equal(auth.verify('hunter2'), false, 'the old password must not still work')
  assert.equal(auth.verify('new-secret-1'), true, 'the new password takes effect immediately')
})

test('a live-changed password logs in through the real server flow', async (t) => {
  // Drive login before and after a setPassword on the SAME auth the server uses.
  const auth = createAuth('hunter2')
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/api/setpw') { auth.setPassword('rotated-pw'); res.end('ok'); return }
    if (auth.handle(req, res, url)) return
    res.writeHead(auth.guard(req) ? 200 : 401); res.end('x')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const login = (pw) => fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw }) })

  assert.equal((await login('hunter2')).status, 200)
  await fetch(base + '/api/setpw')
  assert.equal((await login('hunter2')).status, 401, 'old password rejected after change')
  assert.equal((await login('rotated-pw')).status, 200, 'new password accepted after change')
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

// --- session hygiene (2026-08-31) -------------------------------------------
//
// A session lives a week and SURVIVES a password change on purpose, so changing the
// password is not how you end one - which is exactly why "sign out every other
// browser" had to exist. The last test pins that assumption, because if it ever
// flips, this control's reason for existing goes with it.

// Sign in N browsers against one auth and hand back their session cookies.
async function signedIn (auth, base, n) {
  const out = []
  for (let i = 0; i < n; i++) {
    const r = await fetch(base + '/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'hunter2' })
    })
    assert.equal(r.status, 200)
    out.push(r.headers.get('set-cookie').split(';')[0])
  }
  return out
}

// The same auth object the server uses, so a test can call logoutEverywhere on it.
async function serverExposingAuth (password) {
  const auth = createAuth(password)
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (auth.handle(req, res, url)) return
    res.writeHead(auth.guard(req) ? 200 : 401)
    res.end('x')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { auth, server, base: `http://127.0.0.1:${server.address().port}` }
}

const reach = (base, cookie) => fetch(base, { headers: cookie ? { cookie } : {} }).then(r => r.status)

test('logoutEverywhere ends every OTHER browser and spares the one it was pressed in', async (t) => {
  const { auth, server, base } = await serverExposingAuth('hunter2')
  t.after(() => server.close())
  const [mine, laptop, phone] = await signedIn(auth, base, 3)
  for (const c of [mine, laptop, phone]) assert.equal(await reach(base, c), 200, 'all three are in')

  const dropped = auth.logoutEverywhere(auth.sessionIdOf({ headers: { cookie: mine } }))
  assert.equal(dropped, 2, 'it says how many browsers it signed out')
  assert.equal(await reach(base, mine), 200, 'the browser it was pressed in stays signed in')
  assert.equal(await reach(base, laptop), 401, 'the laptop handed back is out')
  assert.equal(await reach(base, phone), 401)
})

test('logoutEverywhere with nothing to keep ends them all, and is safe when empty', async (t) => {
  const { auth, server, base } = await serverExposingAuth('hunter2')
  t.after(() => server.close())
  const [only] = await signedIn(auth, base, 1)

  assert.equal(auth.logoutEverywhere(null), 1)
  assert.equal(await reach(base, only), 401)
  // Idempotent, and an unknown "keep" cannot resurrect a session.
  assert.equal(auth.logoutEverywhere('not-a-real-session'), 0)
  assert.equal(await reach(base, 'peartune_session=not-a-real-session'), 401)
})

test('sessionIdOf reads exactly the cookie the guard reads', async (t) => {
  const { auth, server, base } = await serverExposingAuth('hunter2')
  t.after(() => server.close())
  const [cookie] = await signedIn(auth, base, 1)
  const sid = auth.sessionIdOf({ headers: { cookie } })
  assert.ok(sid)
  assert.equal(cookie, COOKIE + '=' + sid, 'the id is the cookie value, nothing else')
  assert.equal(auth.sessionIdOf({ headers: {} }), null)
})

test('A PASSWORD CHANGE STILL SIGNS NOBODY OUT - the reason this control exists', async (t) => {
  const { auth, server, base } = await serverExposingAuth('hunter2')
  t.after(() => server.close())
  const [cookie] = await signedIn(auth, base, 1)

  auth.setPassword('a-new-password')
  assert.equal(await reach(base, cookie), 200, 'still signed in after the password change')
  assert.equal(auth.logoutEverywhere(null), 1, 'and THIS is what ends it')
  assert.equal(await reach(base, cookie), 401)
})

// --- secret files are owner-only, on READ as well as write (2026-08-31) ------

test('a seed file restored world-readable is tightened when it is read', () => {
  const { loadOrCreateSeed } = require('../host/identity')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-seed-'))
  try {
    // A seed as a backup restore, a scp, or an older build would leave it. The 0600
    // on the WRITE path never saw this file.
    const seedFile = path.join(dir, 'host.seed')
    fs.writeFileSync(seedFile, 'a'.repeat(64), { mode: 0o644 })
    assert.equal(fs.statSync(seedFile).mode & 0o777, 0o644, 'the fixture really is world-readable')

    loadOrCreateSeed(dir)
    assert.equal(fs.statSync(seedFile).mode & 0o777, 0o600, 'reading it is what tightens it')

    // And it still returns the seed, unchanged.
    assert.equal(loadOrCreateSeed(dir).toString('hex'), 'a'.repeat(64))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a dashboard-password file restored world-readable is tightened when it is read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-pw-'))
  try {
    const pwFile = path.join(dir, PASSWORD_FILE)
    fs.writeFileSync(pwFile, 'restored-from-a-backup\n', { mode: 0o644 })

    const out = resolveDashboardPassword({ password: '', bind: '0.0.0.0', dataDir: dir })
    assert.equal(out.source, 'file')
    assert.equal(out.password, 'restored-from-a-backup', 'the password is still usable')
    assert.equal(fs.statSync(pwFile).mode & 0o777, 0o600, 'and the file that opens the revoke button is owner-only now')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('tighten never throws on a filesystem that cannot express the mode', () => {
  // A Windows volume, a FAT USB drive, some bind mounts. Refusing to run there to
  // enforce a mode the platform does not have would be the worse failure.
  const { tighten } = require('../host/identity')
  assert.equal(tighten(path.join(os.tmpdir(), 'peartune-no-such-file-' + Date.now())), false)
})

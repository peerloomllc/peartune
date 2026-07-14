// The lock on the control plane.
//
// Proposal 2026-07-14-dashboard-auth (T3). Read that first; the short version is
// the chain of facts that forces this to exist:
//
//   the host needs network_mode: host (bridge NAT kills holepunching - measured,
//   twice) -> Umbrel's app_proxy cannot front a host-networked service -> the
//   proxy was the only thing standing in for our missing auth -> so the dashboard
//   needs its own.
//
// What this page can do, and therefore what this file is guarding: revoke any
// device instantly, mid-song; open a pairing window that grants a stranger the
// whole library; rename people. "Unauthenticated status page" is the wrong mental
// model. "Anyone on your wifi can take your music library" is the right one.

const crypto = require('crypto')

const COOKIE = 'peartune_session'
const MAX_FAILURES = 5
const LOCKOUT_MS = 60_000

function createAuth (password) {
  // No password: no gate. That is today's behaviour, and it is only safe because
  // the server refuses to bind anything but loopback in that state (see
  // requireSafeBind below). The two rules are one rule.
  if (!password) {
    return {
      enabled: false,
      guard: () => true,
      handle: () => false
    }
  }

  const sessions = new Set()
  const failures = new Map() // ip -> { count, until }

  // Hash both sides to a fixed width before comparing. timingSafeEqual THROWS on a
  // length mismatch, which would itself leak the password's length - hashing makes
  // every comparison the same shape.
  const secret = crypto.createHash('sha256').update(String(password)).digest()
  const matches = (given) => {
    const got = crypto.createHash('sha256').update(String(given ?? '')).digest()
    return crypto.timingSafeEqual(secret, got)
  }

  const ipOf = (req) => req.socket.remoteAddress || 'unknown'

  const lockedOut = (ip) => {
    const f = failures.get(ip)
    return !!f && f.count >= MAX_FAILURES && Date.now() < f.until
  }

  const noteFailure = (ip) => {
    const f = failures.get(ip) || { count: 0, until: 0 }
    f.count += 1
    f.until = Date.now() + LOCKOUT_MS
    failures.set(ip, f)
  }

  const sessionOf = (req) => {
    const raw = req.headers.cookie || ''
    const hit = raw.split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='))
    return hit ? hit.slice(COOKIE.length + 1) : null
  }

  return {
    enabled: true,

    // Is this request allowed to touch the dashboard or its API?
    guard (req) {
      const sid = sessionOf(req)
      return !!sid && sessions.has(sid)
    },

    // Returns true if it handled the request itself (login, logout, or a 401).
    // The caller does nothing further in that case.
    handle (req, res, url) {
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const ip = ipOf(req)

        // A four-character password on a LAN is guessable in seconds without this.
        if (lockedOut(ip)) {
          res.writeHead(429, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'too many attempts, wait a minute' }))
          return true
        }

        let body = ''
        req.on('data', (c) => { body += c })
        req.on('end', () => {
          let given = ''
          try {
            given = JSON.parse(body || '{}').password || ''
          } catch {}

          if (!matches(given)) {
            noteFailure(ip)
            res.writeHead(401, { 'content-type': 'application/json' })
            return res.end(JSON.stringify({ error: 'wrong password' }))
          }

          failures.delete(ip)
          const sid = crypto.randomBytes(24).toString('hex')
          sessions.add(sid)

          res.writeHead(200, {
            'content-type': 'application/json',
            // HttpOnly: the page's own JS never needs to read this, and script that
            // does want to read it is exactly what we are defending against.
            'set-cookie': `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`
          })
          res.end(JSON.stringify({ ok: true }))
        })
        return true
      }

      if (req.method === 'POST' && url.pathname === '/api/logout') {
        const sid = sessionOf(req)
        if (sid) sessions.delete(sid)
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
        })
        res.end(JSON.stringify({ ok: true }))
        return true
      }

      // Everything else needs a session.
      if (!this.guard(req)) {
        // The page itself answers 200 with a login form (see LOGIN_PAGE); the API
        // answers 401 so the dashboard's own fetches can tell "logged out" from
        // "broken".
        if (req.method === 'GET' && url.pathname === '/') return false // caller serves the login page
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return true
      }

      return false
    }
  }
}

// FAIL CLOSED, AND LOUDLY.
//
// A warning in a log nobody reads is not a control. If the host is told to serve
// the control plane on anything but loopback without a password, it does not start.
// Every "just expose it for a minute" is how a revoke button ends up on an open
// port forever.
function requireSafeBind (bind, password) {
  const loopback = bind === '127.0.0.1' || bind === 'localhost' || bind === '::1'
  if (loopback || password) return

  throw new Error(
    `refusing to start: the dashboard would listen on ${bind} with NO password.\n` +
    '  That port can revoke every device and open a pairing window for your whole library.\n' +
    '  Set PEARTUNE_PASSWORD (Umbrel passes ${APP_PASSWORD}), or bind 127.0.0.1.'
  )
}

module.exports = { createAuth, requireSafeBind, COOKIE, MAX_FAILURES }

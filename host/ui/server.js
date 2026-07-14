// The operator dashboard.
//
// Deliberately small: one HTML page, a handful of JSON endpoints, no build step
// and no framework. Its whole job in milestone 1 is to show a pairing QR and put
// a revoke button next to every device.
//
// AUTH: off by default, REQUIRED the moment this is not on loopback.
//
// It used to have none at all, on the theory that Umbrel's app_proxy gated it. That
// theory died when we measured (twice) that the host needs network_mode: host to
// holepunch at all - and a host-networked service cannot be fronted by the proxy.
// So the dashboard now owns its own lock, and the server REFUSES TO START if it
// would serve this page on anything but loopback without one. See
// proposals/2026-07-14-dashboard-auth.md.
//
// What is behind the lock: revoke any device instantly, mid-song; open a pairing
// window that grants a stranger the whole library; rename people.

const http = require('http')
const QRCode = require('qrcode')
const z32 = require('z32')

const PAGE = require('./page')
const LOGIN_PAGE = require('./login')
const { createAuth, requireSafeBind } = require('./auth')

function json (res, code, body) {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': buf.length,
    'cache-control': 'no-store'
  })
  res.end(buf)
}

async function readBody (req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    return {}
  }
}

async function startDashboard ({ host, bind = '127.0.0.1', port = 8741, password = '' }) {
  // Before anything listens. A control plane on a LAN with no password is not a
  // configuration we are willing to run, so this throws rather than warns.
  requireSafeBind(bind, password)

  const auth = createAuth(password)

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')

    try {
      // Login, logout, and the 401 for everything else. Returns true if it dealt
      // with the request itself.
      if (auth.enabled && auth.handle(req, res, url)) return

      // --- page ---
      if (req.method === 'GET' && url.pathname === '/') {
        // Logged out (or no session yet): the login form, not the control plane.
        const html = auth.enabled && !auth.guard(req) ? LOGIN_PAGE : PAGE
        const body = Buffer.from(html)
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length })
        return res.end(body)
      }

      // --- state ---
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const stats = await host.adapter.stats()
        const devices = await host.listDevices()
        const persons = await host.grants.listPersons()
        return json(res, 200, {
          persons,
          source: host.sourceView,
          sourceError: host.sourceError || null,
          libraryName: host.libraryName,
          libraryId: host.libraryId,
          hostKey: z32.encode(host.publicKey),
          stats,
          pairing: host.pairing,
          devices: devices.map(d => ({
            deviceKey: d.deviceKey,
            label: d.label,
            personId: d.personId,
            // What the DEVICE says it is. Cosmetic until the operator confirms it
            // (proposal 2026-07-14) - the dashboard shows it with a Confirm button.
            claimedUser: d.claimedUser || null,
            claimedAt: d.claimedAt || null,
            platform: d.platform,
            scope: d.scope,
            grantedAt: d.grantedAt,
            lastSeenAt: d.lastSeenAt,
            revokedAt: d.revokedAt,
            online: d.online
          }))
        })
      }

      // --- where the music comes from -------------------------------------
      //
      // The operator picks the source in the dashboard, not by editing a compose
      // file. See host/source.js: without this, an app-store install lands on the
      // folder adapter, which has no tag reading, and the user gets a library of
      // filenames.
      if (req.method === 'POST' && url.pathname === '/api/source/test') {
        const cfg = await readBody(req)
        try {
          return json(res, 200, await host.testSource(cfg))
        } catch (e) {
          // The whole point of a Test button: fail HERE, with the reason, instead of
          // saving a broken source and wondering why the library went dark.
          return json(res, 400, { ok: false, error: e.message })
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/source') {
        const cfg = await readBody(req)
        try {
          const r = await host.setSource(cfg)
          return json(res, 200, { ok: true, ...r })
        } catch (e) {
          return json(res, 400, { ok: false, error: e.message })
        }
      }

      // --- open a pairing window, and hand back a QR ---
      if (req.method === 'POST' && url.pathname === '/api/pair/start') {
        const link = host.startPairing()
        const svg = await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
        return json(res, 200, { link, svg, ttlMs: host.pairSession.ttl })
      }

      if (req.method === 'POST' && url.pathname === '/api/pair/stop') {
        host.stopPairing()
        return json(res, 200, { ok: true })
      }

      // --- people ---
      if (req.method === 'POST' && url.pathname === '/api/person') {
        const { name } = await readBody(req)
        if (!name || !String(name).trim()) return json(res, 400, { error: 'name required' })
        return json(res, 200, await host.grants.addPerson(String(name).trim()))
      }

      // Attach a device to a person, so revocation has a subject a human
      // recognises instead of a 52-character key.
      // The operator confirming a device's self-declared user. The ONLY path from
      // "claims to be Tim" to "is Tim" - see proposal 2026-07-14.
      if (req.method === 'POST' && url.pathname === '/api/person/confirm') {
        const { deviceKey } = await readBody(req)
        if (!deviceKey) return json(res, 400, { error: 'deviceKey required' })
        const row = await host.grants.confirmClaim(deviceKey)
        if (!row) return json(res, 400, { error: 'no claim to confirm' })
        const person = await host.grants.getPerson(row.personId)
        return json(res, 200, { ok: true, person })
      }

      if (req.method === 'POST' && url.pathname === '/api/assign') {
        const { deviceKey, personId } = await readBody(req)
        if (!deviceKey) return json(res, 400, { error: 'deviceKey required' })
        const row = await host.grants.assign(deviceKey, personId || null)
        if (!row) return json(res, 404, { error: 'no such device' })
        return json(res, 200, row)
      }

      // Revoke a PERSON: every device they hold, in one action, with every live
      // connection destroyed. This is the case holesail structurally cannot
      // serve, and the reason we built the host ourselves.
      if (req.method === 'POST' && url.pathname === '/api/person/revoke') {
        const { personId } = await readBody(req)
        if (!personId) return json(res, 400, { error: 'personId required' })
        const { revoked, killed } = await host.revokePerson(personId)
        return json(res, 200, { ok: true, devices: revoked.length, killed })
      }

      // --- the teeth ---
      if (req.method === 'POST' && url.pathname === '/api/revoke') {
        const { deviceKey } = await readBody(req)
        if (!deviceKey) return json(res, 400, { error: 'deviceKey required' })
        const { grant, killed } = await host.revokeDevice(deviceKey)
        if (!grant) return json(res, 404, { error: 'no such device, or already revoked' })
        // `killed` is the number of live connections destroyed. The UI surfaces
        // it, because "revoked" and "revoked AND the music stopped" are different
        // claims and the operator deserves to know which one happened.
        return json(res, 200, { ok: true, killed })
      }

      json(res, 404, { error: 'not found' })
    } catch (e) {
      json(res, 500, { error: e.message })
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, bind, resolve)
  })

  return {
    server,
    port,
    close: () => new Promise(resolve => server.close(resolve))
  }
}

module.exports = { startDashboard }

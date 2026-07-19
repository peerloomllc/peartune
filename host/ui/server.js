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
const fs = require('fs')
const path = require('path')
const QRCode = require('qrcode')
const z32 = require('z32')

// The dashboard is a BUILT React app (host/ui/app/, bundled by
// scripts/build-dashboard.mjs into one self-contained HTML string). It replaced
// host/ui/page.js, a 700-line hand-written template literal that was the control
// plane and had produced a stored XSS and two syntax-in-a-string bugs. React
// escapes by default, so that class of bug is gone. Read once at startup - the
// file is committed and copied into the image, so this never touches disk per
// request. The login page is still a small hand-written string (host/ui/login.js).
const PAGE = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8')
const LOGIN_PAGE = require('./login')
const { createAuth, requireSafeBind, PASSWORD_FILE } = require('./auth')
const { browse } = require('../browse')
const { detectSources } = require('../detect')
const { writeStartosStats } = require('../startos-stats')

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

// Raw request body as a Buffer, capped - for the avatar image upload. The host caps
// again at 512KB; this is a first fence so a huge upload never buffers fully.
async function readRaw (req, max = 768 * 1024) {
  const chunks = []
  let n = 0
  for await (const c of req) {
    n += c.length
    if (n > max) throw new Error('image too large')
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

async function startDashboard ({ host, bind = '127.0.0.1', port = 8741, password = '', passwordSource = 'none' }) {
  // Before anything listens. A control plane on a LAN with no password is not a
  // configuration we are willing to run, so this throws rather than warns.
  requireSafeBind(bind, password)

  const auth = createAuth(password)
  // Where the current password came from: 'explicit' (env/flag - the operator
  // cannot change it here, the platform owns it), 'generated'/'file' (a
  // dashboard-password file WE own - changeable), or 'none' (loopback, no gate).
  // A successful change makes it file-backed.
  let pwSource = passwordSource

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

      // --- album art (the now-playing thumbnails on People & devices) ---
      // Behind the same auth as everything else (auth.handle 401s the unauthenticated
      // above); an <img> carries the session cookie. Covers only - no track data.
      if (req.method === 'GET' && url.pathname === '/api/art') {
        const coverId = url.searchParams.get('id')
        const stream = coverId && host.adapter ? await host.adapter.art({ coverId }).catch(() => null) : null
        if (!stream) { res.writeHead(404); return res.end() }
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=300' })
        return stream.pipe(res)
      }

      // --- state ---
      if (req.method === 'GET' && url.pathname === '/api/state') {
        // A BROKEN SOURCE MUST NOT BREAK THE DASHBOARD. stats() talks to the source,
        // so an unreachable Navidrome makes it throw - and a 500 here would blank the
        // one page the operator needs in order to fix the source. Answer zeroes and
        // let sourceError carry the news.
        const stats = await host.adapter.stats().catch(() => ({
          source: host.adapter.kind, tracks: 0, albums: 0, artists: 0, scannedAt: null
        }))
        const devices = await host.listDevices()
        const persons = await host.grants.listPersons()
        return json(res, 200, {
          persons: persons.map(p => ({ ...p, hasAvatar: host.hasPersonAvatar(p.id) })),
          source: host.sourceView,
          sourceError: host.sourceError || null,
          libraryName: host.libraryName,
          libraryId: host.libraryId,
          hostKey: z32.encode(host.publicKey),
          // Scheduled auto-rescan cadence in minutes (0 = off). Drives the source
          // panel's Auto-rescan control.
          rescanIntervalMin: host.getRescanIntervalMin(),
          stats,
          pairing: host.pairing,
          // Drives the dashboard's password controls: 'generated'/'file' = the
          // operator can change it here; 'explicit' = set via PEARTUNE_PASSWORD, so
          // the UI tells them to change it there instead; 'none' = no gate (loopback).
          passwordSource: pwSource,
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
            grantedBy: d.grantedBy || null,
            // A time-limited GUEST grant (null = permanent). The dashboard shows the
            // countdown and an "expired" state off this.
            expiresAt: d.expiresAt || null,
            lastSeenAt: d.lastSeenAt,
            revokedAt: d.revokedAt,
            online: d.online,
            // What this device is playing RIGHT NOW, or null. Only ever set on the one
            // device that holds its owner's session (see listDevices) - { title, artist,
            // playing, coverId }; coverId loads via /api/art.
            nowPlaying: d.nowPlaying || null
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

      // Change/reset the dashboard password. This handler only runs for an already-
      // authenticated request (auth.handle 401s everyone else), so the session is the
      // authorization - we do NOT re-ask for the current password, which would be
      // friction exactly in the case this exists for: a GENERATED password the
      // operator never memorised. Only for a password WE own (a dashboard-password
      // file); if PEARTUNE_PASSWORD is set the platform owns it and a change here would
      // be overwritten on the next restart (env wins in resolveDashboardPassword), so
      // we refuse and say where to change it.
      if (req.method === 'POST' && url.pathname === '/api/password') {
        if (!auth.enabled) return json(res, 400, { error: 'no dashboard password is set (loopback bind)' })
        if (pwSource === 'explicit') {
          return json(res, 400, { error: 'this password is set by PEARTUNE_PASSWORD; change it there' })
        }
        const { next } = await readBody(req)
        const clean = String(next || '')
        if (clean.length < 6) return json(res, 400, { error: 'new password must be at least 6 characters' })
        try {
          fs.mkdirSync(host.dataDir, { recursive: true })
          fs.writeFileSync(path.join(host.dataDir, PASSWORD_FILE), clean + '\n', { mode: 0o600 })
        } catch (e) {
          return json(res, 500, { error: 'could not save the new password: ' + e.message })
        }
        auth.setPassword(clean)
        pwSource = 'file'
        // Keep StartOS's Properties display in step with the change (else it shows
        // the startup password until a restart). Best-effort, gated the same way the
        // startup write is (PEARTUNE_STATS, set by the s9pk entrypoint).
        if (process.env.PEARTUNE_STATS) writeStartosStats(process.env.PEARTUNE_STATS, clean, 'file')
        return json(res, 200, { ok: true })
      }

      // Rename the library. Persisted host-side (library.json); shown on the dashboard
      // and sent to a pairing device. The host sanitizes the name.
      if (req.method === 'POST' && url.pathname === '/api/library') {
        const { name } = await readBody(req)
        try {
          return json(res, 200, { ok: true, libraryName: host.setLibraryName(name) })
        } catch (e) {
          return json(res, 400, { ok: false, error: e.message })
        }
      }

      // Set the scheduled auto-rescan cadence (minutes; 0 = off). Persisted host-side;
      // the host clamps and re-arms its timer.
      if (req.method === 'POST' && url.pathname === '/api/rescan-interval') {
        const { minutes } = await readBody(req)
        try {
          return json(res, 200, { ok: true, rescanIntervalMin: host.setRescanIntervalMin(minutes) })
        } catch (e) {
          return json(res, 400, { ok: false, error: e.message })
        }
      }

      // Autodetect a music server running alongside the host (Jellyfin/Nextcloud/
      // Subsonic on this Start9 or Umbrel), so the operator does not have to know its
      // internal address (jellyfin.embassy:8096 etc.). Returns the reachable ones for
      // the dashboard to pre-fill. Behind the dashboard password like everything here.
      if (req.method === 'GET' && url.pathname === '/api/source/detect') {
        try {
          return json(res, 200, { sources: await detectSources() })
        } catch (e) {
          return json(res, 200, { sources: [], error: e.message })
        }
      }

      // A folder has no scanner watching it: copy an album onto the NAS and the host
      // does not know until somebody says so.
      if (req.method === 'POST' && url.pathname === '/api/source/rescan') {
        try {
          return json(res, 200, { ok: true, ...(await host.rescan()) })
        } catch (e) {
          return json(res, 400, { ok: false, error: e.message })
        }
      }

      // WHAT CAN THIS CONTAINER SEE?
      //
      // The folder path is a path INSIDE the container, and a text box the host
      // cannot verify is how an operator ends up typing their NAS's path, getting
      // zero tracks, and concluding the app is broken. So the dashboard offers the
      // directories that actually exist and lets them pick one.
      //
      // Directory NAMES only, never file contents, and behind the dashboard password
      // like everything else here. The operator owns this box; they are allowed to
      // see where their disks are mounted.
      if (req.method === 'GET' && url.pathname === '/api/source/folders') {
        try {
          return json(res, 200, await browse(url.searchParams.get('path') || '/'))
        } catch (e) {
          return json(res, 400, { error: e.message })
        }
      }

      // --- open a pairing window, and hand back a QR ---
      if (req.method === 'POST' && url.pathname === '/api/pair/start') {
        // expiresMs > 0 opens a GUEST window (time-limited access); absent = a normal
        // permanent window. The operator sets the duration here, host-side.
        const body = await readBody(req)
        const expiresMs = Number(body.expiresMs) > 0 ? Number(body.expiresMs) : null
        const link = host.startPairing({ expiresMs })
        const svg = await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
        return json(res, 200, {
          link, svg, ttlMs: host.pairSession.ttl,
          guest: !!host.pairSession.expiresMs,
          expiresMs: host.pairSession.expiresMs || null
        })
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

      // Delete an EMPTY person (one holding no un-revoked device) from the store, so
      // the People list does not fill with dead rows. Refused for a person who still
      // holds a live device - revoke them first.
      // Person avatar: GET serves the photo (an <img> carries the session cookie, so
      // it is behind the same auth); POST sets it from raw image bytes (the dashboard
      // resizes to ~200px JPEG first).
      if (url.pathname === '/api/person/avatar') {
        const id = url.searchParams.get('id')
        if (req.method === 'GET') {
          const buf = id ? host.getPersonAvatar(id) : null
          if (!buf) { res.writeHead(404); return res.end() }
          res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, no-cache' })
          return res.end(buf)
        }
        if (req.method === 'POST') {
          try {
            return json(res, 200, await host.setPersonAvatar(id, await readRaw(req)))
          } catch (e) {
            return json(res, 400, { ok: false, error: e.message })
          }
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/person/delete') {
        const { personId } = await readBody(req)
        if (!personId) return json(res, 400, { error: 'personId required' })
        const { deleted } = await host.deletePerson(personId)
        if (!deleted) return json(res, 400, { error: 'can only delete a person with no active devices' })
        return json(res, 200, { ok: true })
      }

      // Rename a person directly (the dashboard used to only reach a rename by
      // re-confirming a device's new claim). The host sanitizes the name, refuses a
      // collision with another live person, and keeps assigned devices' claims in step.
      if (req.method === 'POST' && url.pathname === '/api/person/rename') {
        const { personId, name } = await readBody(req)
        if (!personId) return json(res, 400, { error: 'personId required' })
        try {
          const person = await host.grants.renamePerson(personId, name)
          if (!person) return json(res, 404, { error: 'no such person' })
          return json(res, 200, { ok: true, person })
        } catch (e) {
          return json(res, 400, { error: e.message })
        }
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

      // Cleanup for the teeth: remove a REVOKED device's tombstone row from the store,
      // so the Devices list does not grow forever. Refused for a live device (revoke
      // it first); deleting never re-admits - a deleted device must pair again to
      // return (see host.deleteDevice, gate.js fail-closed).
      if (req.method === 'POST' && url.pathname === '/api/device/delete') {
        const { deviceKey } = await readBody(req)
        if (!deviceKey) return json(res, 400, { error: 'deviceKey required' })
        const { deleted } = await host.deleteDevice(deviceKey)
        if (!deleted) return json(res, 400, { error: 'can only delete a revoked device' })
        return json(res, 200, { ok: true })
      }

      // Edit a device's guest expiry: expiresAt = a timestamp to (re)limit it, or null to
      // make it permanent. expiresMs (a duration) is accepted as a convenience and turned
      // into an absolute time here, on the host clock (the authority on expiry).
      if (req.method === 'POST' && url.pathname === '/api/device/expiry') {
        const { deviceKey, expiresAt, expiresMs } = await readBody(req)
        if (!deviceKey) return json(res, 400, { error: 'deviceKey required' })
        const at = Number(expiresMs) > 0 ? Date.now() + Number(expiresMs)
          : (Number(expiresAt) > 0 ? Number(expiresAt) : null)
        const { grant } = await host.setDeviceExpiry(deviceKey, at)
        if (!grant) return json(res, 400, { error: 'no such device, or it is revoked' })
        return json(res, 200, { ok: true, expiresAt: grant.expiresAt })
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

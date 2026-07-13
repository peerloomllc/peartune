// The operator dashboard.
//
// Deliberately small: one HTML page, a handful of JSON endpoints, no build step
// and no framework. Its whole job in milestone 1 is to show a pairing QR and put
// a revoke button next to every device.
//
// NO AUTH HERE, on purpose. On Umbrel this sits behind app_proxy, which already
// gates it behind the Umbrel login - the same posture as the PearCircle seeder.
// It therefore binds to 127.0.0.1 by DEFAULT, and only binds 0.0.0.0 when the
// container tells it to. Exposing this port straight to a LAN would hand anyone
// on it a revoke button and a pairing QR.

const http = require('http')
const QRCode = require('qrcode')
const z32 = require('z32')

const PAGE = require('./page')

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

async function startDashboard ({ host, bind = '127.0.0.1', port = 8731 }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')

    try {
      // --- page ---
      if (req.method === 'GET' && url.pathname === '/') {
        const body = Buffer.from(PAGE)
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length })
        return res.end(body)
      }

      // --- state ---
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const stats = await host.adapter.stats()
        const devices = await host.listDevices()
        return json(res, 200, {
          libraryName: host.libraryName,
          libraryId: host.libraryId,
          hostKey: z32.encode(host.publicKey),
          stats,
          pairing: host.pairing,
          devices: devices.map(d => ({
            deviceKey: d.deviceKey,
            label: d.label,
            platform: d.platform,
            scope: d.scope,
            grantedAt: d.grantedAt,
            lastSeenAt: d.lastSeenAt,
            revokedAt: d.revokedAt,
            online: d.online
          }))
        })
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

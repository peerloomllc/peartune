// Autodetect a music source running alongside the host.
//
// The single hardest thing about setting up PearTune on Start9/Umbrel is knowing
// the INTERNAL address of the Jellyfin/Nextcloud you already run - jellyfin.embassy
// :8096 on Start9, localhost:8096 on an Umbrel (network_mode: host). This probes the
// addresses a co-located server is reachable at and reports the ones that answer as
// a recognised music server, so the dashboard can pre-fill them.
//
// No platform flag needed: we try BOTH the Start9 `<pkg-id>.embassy:<port>` form and
// the localhost:<port> form (Umbrel host-networking / a bare box). The wrong ones
// fail fast - `.embassy` names don't resolve off StartOS, localhost ports refuse.
// Detection reads a PUBLIC, no-auth endpoint and matches a server-specific marker,
// so a false positive from some unrelated service on the same port is very unlikely.

const http = require('http')

function fetchText (url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let u
    try { u = new URL(url) } catch { return resolve(null) }
    if (u.protocol !== 'http:') return resolve(null) // internal service links are http
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let d = ''
      res.on('data', (c) => { d += c; if (d.length > 20000) req.destroy() })
      res.on('end', () => resolve({ status: res.statusCode, body: d }))
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

// Known music servers, each as { pkg (Start9 id), port, probe }. Emby rides the
// jellyfin kind; Nextcloud Music / Gonic / Airsonic-Advanced ride subsonic.
const SERVERS = [
  { pkg: 'jellyfin', port: 8096, probe: 'jellyfin' },
  { pkg: 'emby', port: 8096, probe: 'jellyfin' },
  { pkg: 'navidrome', port: 4533, probe: 'subsonic' },
  { pkg: 'gonic', port: 4747, probe: 'subsonic' },
  { pkg: 'airsonic-advanced', port: 4040, probe: 'subsonic' },
  { pkg: 'nextcloud', port: 80, probe: 'subsonic' } // Nextcloud Music's Subsonic API
]

function urlsFor (s) {
  // Both forms; deduped later by the resolved URL that actually answered.
  return [`http://${s.pkg}.embassy:${s.port}`, `http://localhost:${s.port}`]
}

async function probe (kind, base) {
  if (kind === 'jellyfin') {
    const r = await fetchText(base + '/System/Info/Public')
    if (r && r.status === 200 && /"ProductName"\s*:\s*"(Jellyfin|Emby)/i.test(r.body)) {
      const m = r.body.match(/"ServerName"\s*:\s*"([^"]+)"/i)
      const prod = /Emby/i.test(r.body) && !/Jellyfin/i.test(r.body) ? 'Emby' : 'Jellyfin'
      return { kind: 'jellyfin', url: base, name: (m && m[1]) ? m[1] : prod, server: prod }
    }
  } else if (kind === 'subsonic') {
    const r = await fetchText(base + '/rest/ping.view?c=peartune&v=1.16.1&f=json')
    // A Subsonic server answers ping with a subsonic-response envelope even without
    // credentials (it reports the auth error inside it) - that envelope IS the tell.
    if (r && /subsonic-response/i.test(r.body)) {
      let host = base
      try { host = new URL(base).host } catch {}
      return { kind: 'subsonic', url: base, name: host, server: 'Subsonic' }
    }
  }
  return null
}

// Returns [{ kind, url, name, server }], one per reachable server, deduped.
async function detectSources () {
  const jobs = []
  for (const s of SERVERS) for (const base of urlsFor(s)) jobs.push(probe(s.probe, base))
  const found = (await Promise.all(jobs)).filter(Boolean)
  // Prefer the first hit per (kind + server name); drop later duplicates (e.g. the
  // same Jellyfin answering on both the .embassy and localhost address).
  const seen = new Set()
  const out = []
  for (const f of found) {
    const key = f.kind + '|' + f.name
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
  }
  return out
}

module.exports = { detectSources, probe }

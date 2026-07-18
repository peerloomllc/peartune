#!/usr/bin/env node
//
// PearTune host CLI.
//
// Runs the daemon and serves the operator dashboard. On an Umbrel this is the
// container entrypoint; on a desktop it is what the tray app wraps.
//
//   peartune-host --music /music --data /data
//
// The dashboard binds to localhost by default. In a container it must bind
// 0.0.0.0 so Umbrel's app_proxy can reach it on the Docker network - the proxy
// is what gates access behind the Umbrel login, which is why there is no
// separate auth here (same posture as the PearCircle seeder).

const fs = require('fs')
const path = require('path')
const qrcode = require('qrcode-terminal')
const z32 = require('z32')

// StartOS (0.3.x compat) reads a service's Properties from <volume>/start9/stats.yaml
// (version 2 format). We write just the dashboard password, masked + copyable, so it
// shows in the Properties page. Best-effort: a failure here must never stop the host.
function writeStartosStats (file, password, source) {
  try {
    const note = source === 'generated' || source === 'file'
      ? 'Generated on first run. Change it in the PearTune dashboard (Maintenance).'
      : 'Log in to the PearTune dashboard with this.'
    const yaml = [
      'version: 2',
      'data:',
      '  Dashboard Password:',
      '    type: string',
      '    value: ' + JSON.stringify(String(password)),
      '    description: ' + JSON.stringify(note),
      '    copyable: true',
      '    qr: false',
      '    masked: true',
      ''
    ].join('\n')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, yaml, { mode: 0o600 })
  } catch (e) {
    console.error('warning: could not write StartOS stats:', e.message)
  }
}

const { PearTuneHost } = require('./server')
const { startDashboard } = require('./ui/server')
const { requireSafeBind, resolveDashboardPassword, PASSWORD_FILE } = require('./ui/auth')

function parseArgs (argv) {
  const args = {
    music: process.env.PEARTUNE_MUSIC || '/music',
    data: process.env.PEARTUNE_DATA || '/data',
    name: process.env.PEARTUNE_NAME || 'My Library',
    host: process.env.PEARTUNE_HTTP_HOST || '127.0.0.1',
    // The lock on the control plane. Umbrel passes ${APP_PASSWORD}; unset means no
    // gate, which is why the server refuses to bind anything but loopback without
    // it (host/ui/auth.js, proposal 2026-07-14-dashboard-auth).
    password: process.env.PEARTUNE_PASSWORD || '',
    port: Number(process.env.PEARTUNE_HTTP_PORT || 8741),
    quiet: false,
    // Point at an existing Navidrome (or any Subsonic server) instead of a raw
    // folder. When set, it brings its own scan, tags, artwork and transcoding.
    navidromeUrl: process.env.PEARTUNE_NAVIDROME_URL || null,
    navidromeUser: process.env.PEARTUNE_NAVIDROME_USER || null,
    navidromePass: process.env.PEARTUNE_NAVIDROME_PASS || null
  }

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--music' || a === '-m') args.music = argv[++i]
    else if (a === '--data' || a === '-d') args.data = argv[++i]
    else if (a === '--name' || a === '-n') args.name = argv[++i]
    else if (a === '--http-host') args.host = argv[++i]
    else if (a === '--password') args.password = argv[++i]
    else if (a === '--port' || a === '-p') args.port = Number(argv[++i])
    else if (a === '--quiet' || a === '-q') args.quiet = true
    else if (a === '--navidrome') args.navidromeUrl = argv[++i]
    else if (a === '--navidrome-user') args.navidromeUser = argv[++i]
    else if (a === '--navidrome-pass') args.navidromePass = argv[++i]
    else if (a === '--help' || a === '-h') {
      console.log(`
PearTune host - serve a self-hosted music library over P2P.

  --music, -m <dir>   music directory            (default: /music)
  --data,  -d <dir>   identity + grants          (default: /data)
  --name,  -n <name>  library name shown on pair (default: My Library)
  --http-host <addr>  dashboard bind address     (default: 127.0.0.1)
  --password <pw>     dashboard password         (env: PEARTUNE_PASSWORD)
                      Any non-loopback bind needs one. If you do not set it, the
                      host GENERATES one on first run, prints it, and saves it to
                      <data>/dashboard-password. Set this to choose your own.
  --port,  -p <port>  dashboard port             (default: 8741)
  --quiet, -q         suppress the event log
`)
      process.exit(0)
    }
  }
  return args
}

async function main () {
  const args = parseArgs(process.argv)

  // BEFORE ANYTHING LISTENS OR ANNOUNCES.
  //
  // This used to run inside startDashboard, which meant the DHT server was already
  // up and announcing on the network before the process refused to start. Nothing
  // was exposed (the P2P gate is separate), but a refusal that happens after you
  // have joined the DHT is a refusal that happened too late. Check the config
  // first, then build things.
  //
  // Resolve the password first: on a bare non-loopback install with nothing set,
  // this MINTS one (persisted to the data dir) rather than letting requireSafeBind
  // refuse to start - an Umbrel/Start9 has ${APP_PASSWORD}, a NAS `docker run` does
  // not. An explicit password still wins; loopback stays password-free. See the
  // proposal 2026-07-18 host-platform-expansion.
  const dataDir = path.resolve(args.data)
  const pw = resolveDashboardPassword({ password: args.password, bind: args.host, dataDir })
  args.password = pw.password
  requireSafeBind(args.host, args.password)

  if (pw.source === 'generated') {
    console.log(`
  ┌─ DASHBOARD PASSWORD ──────────────────────────────────────
  │  No password was set for a non-loopback bind (${args.host}),
  │  so one was generated for you:
  │
  │      ${args.password}
  │
  │  Saved to ${path.join(dataDir, PASSWORD_FILE)} (0600).
  │  Set PEARTUNE_PASSWORD (or --password) to choose your own.
  └───────────────────────────────────────────────────────────
`)
  } else if (pw.source === 'file') {
    console.log(`  dashboard password: using the generated one in ${path.join(dataDir, PASSWORD_FILE)}`)
  }

  const log = args.quiet
    ? () => {}
    : (msg, data) => console.log(`[${new Date().toISOString()}] ${msg}`, data ? JSON.stringify(data) : '')

  // The --navidrome / PEARTUNE_NAVIDROME_* credential blob. It builds a 'subsonic'
  // source now (our adapter speaks to any Subsonic server); the flag/env names are
  // kept because existing deployments set them.
  const subsonic = args.navidromeUrl
    ? { url: args.navidromeUrl, username: args.navidromeUser, password: args.navidromePass }
    : null

  if (subsonic && (!subsonic.username || !subsonic.password)) {
    console.error('fatal: --navidrome needs --navidrome-user and --navidrome-pass')
    process.exit(1)
  }

  const host = new PearTuneHost({
    dataDir,
    musicDir: path.resolve(args.music),
    libraryName: args.name,
    subsonic,
    log
  })

  await host.ready()

  const stats = await host.adapter.stats().catch(() => ({ source: host.adapter.kind, tracks: 0 }))
  const dashboard = await startDashboard({
    host, bind: args.host, port: args.port, password: args.password, passwordSource: pw.source
  })

  // StartOS Properties: surface the generated dashboard password in the service's
  // Properties page so a Start9 user is not digging through service logs for it.
  // Gated on PEARTUNE_STATS (the s9pk entrypoint sets it) so we only write StartOS's
  // stats.yaml on StartOS. Written once at startup with the CURRENT password; a
  // later in-dashboard change updates the file the operator already knows, not this.
  if (process.env.PEARTUNE_STATS && args.password) {
    writeStartosStats(process.env.PEARTUNE_STATS, args.password, pw.source)
  }

  const where = host.source.url || host.source.root || args.music

  console.log(`
  PearTune host

  library    ${args.name}
  source     ${stats.source} @ ${where}  (${stats.tracks} tracks)${host.sourceError ? '\n  PROBLEM    ' + host.sourceError : ''}
  host key   ${z32.encode(host.publicKey)}
  dashboard  http://${args.host === '0.0.0.0' ? 'localhost' : args.host}:${args.port}

  Open the dashboard to pair a device.
`)

  // A pairing QR in the terminal, for the headless / SSH case where nobody has a
  // browser pointed at the box.
  if (process.env.PEARTUNE_PAIR_ON_START === '1') {
    const link = host.startPairing()
    console.log('  Scan to pair (valid 5 minutes):\n')
    qrcode.generate(link, { small: true })
    console.log(`\n  ${link}\n`)
  }

  const shutdown = async (sig) => {
    console.log(`\n${sig}, shutting down...`)
    await dashboard.close()
    await host.close()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((e) => {
  console.error('fatal:', e.message)
  process.exit(1)
})

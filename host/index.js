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

const path = require('path')
const qrcode = require('qrcode-terminal')
const z32 = require('z32')

const { PearTuneHost } = require('./server')
const { startDashboard } = require('./ui/server')

function parseArgs (argv) {
  const args = {
    music: process.env.PEARTUNE_MUSIC || '/music',
    data: process.env.PEARTUNE_DATA || '/data',
    name: process.env.PEARTUNE_NAME || 'My Library',
    host: process.env.PEARTUNE_HTTP_HOST || '127.0.0.1',
    port: Number(process.env.PEARTUNE_HTTP_PORT || 8741),
    quiet: false
  }

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--music' || a === '-m') args.music = argv[++i]
    else if (a === '--data' || a === '-d') args.data = argv[++i]
    else if (a === '--name' || a === '-n') args.name = argv[++i]
    else if (a === '--http-host') args.host = argv[++i]
    else if (a === '--port' || a === '-p') args.port = Number(argv[++i])
    else if (a === '--quiet' || a === '-q') args.quiet = true
    else if (a === '--help' || a === '-h') {
      console.log(`
PearTune host - serve a self-hosted music library over P2P.

  --music, -m <dir>   music directory            (default: /music)
  --data,  -d <dir>   identity + grants          (default: /data)
  --name,  -n <name>  library name shown on pair (default: My Library)
  --http-host <addr>  dashboard bind address     (default: 127.0.0.1)
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

  const log = args.quiet
    ? () => {}
    : (msg, data) => console.log(`[${new Date().toISOString()}] ${msg}`, data ? JSON.stringify(data) : '')

  const host = new PearTuneHost({
    dataDir: path.resolve(args.data),
    musicDir: path.resolve(args.music),
    libraryName: args.name,
    log
  })

  await host.ready()

  const stats = await host.adapter.stats()
  const dashboard = await startDashboard({ host, bind: args.host, port: args.port })

  console.log(`
  PearTune host

  library    ${args.name}
  music      ${args.music}  (${stats.tracks} tracks)
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

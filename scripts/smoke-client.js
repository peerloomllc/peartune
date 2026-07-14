// Manual smoke client: pair against a RUNNING host over the real DHT, stream a
// track, and hold the connection open so the operator can revoke from the
// dashboard and watch the music die.
//
//   node scripts/smoke-client.js "<pairing link>"      # pair, stream, then idle
//
// This is the same PearTuneClient the Bare worklet will use, so a green run here
// means the phone's job is UI, not protocol.

const fs = require('fs')
const hcrypto = require('hypercore-crypto')
const { PearTuneClient } = require('../client')

async function main () {
  const args = process.argv.slice(2)
  const hold = args.includes('--hold')
  const linkArg = args.find(a => !a.startsWith('--'))
  const link = linkArg || fs.readFileSync('/tmp/pt-live/link.txt', 'utf8').trim()

  const client = new PearTuneClient({
    keyPair: hcrypto.keyPair(),
    log: (m, d) => console.log('  [client]', m, d ? JSON.stringify(d) : '')
  })

  console.log('pairing over the public DHT...')
  const t0 = Date.now()
  const paired = await client.pair(link, { label: 'smoke-client', platform: 'node' })
  console.log(`paired in ${Date.now() - t0}ms:`, paired.libraryName, paired.libraryId.slice(0, 12) + '...')

  console.log('connecting...')
  const t1 = Date.now()
  await client.connect({ hostKey: paired.hostKey, libraryId: paired.libraryId })
  console.log(`connected in ${Date.now() - t1}ms`)

  console.log('ping:', await client.ping())
  const stats = await client.stats()
  console.log('stats:', stats)

  const { items } = await client.list({ type: 'tracks' })
  console.log('tracks:', items.map(i => `${i.title} (${i.size}b)`))

  const t2 = Date.now()
  const body = await client.stream({ trackId: items[0].id })
  const ms = Date.now() - t2
  console.log(`streamed ${body.length} bytes in ${ms}ms (${(body.length / 1024 / (ms / 1000) / 1024).toFixed(1)} MB/s)`)

  // Range read, the seek path.
  const slice = await client.stream({ trackId: items[0].id, offset: 1000, length: 256 })
  console.log('range read (offset 1000, len 256):', slice.length, 'bytes')

  if (!hold) {
    await client.close()
    console.log('\nOK')
    process.exit(0)
  }

  // Loop a stream so there is always something in flight to cut off.
  console.log('\nHOLDING. Revoke "smoke-client" in the dashboard now.\n')
  let n = 0
  for (;;) {
    try {
      await client.stream({ trackId: items[n++ % items.length].id })
      process.stdout.write('.')
    } catch (e) {
      console.log(`\n\nSTREAM DIED: ${e.message}`)
      console.log('(this is what a revoked phone experiences mid-song)')
      process.exit(0)
    }
  }
}

main().catch(e => {
  console.error('FAILED:', e.message)
  process.exit(1)
})

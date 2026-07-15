// Spike: run the client + audio shim under the REAL Bare runtime (not Node), and
// prove the localhost HTTP surface behaves the way ExoPlayer needs.
//
//   node host/index.js --music ... &        # start a host
//   curl -X POST localhost:8731/api/pair/start | jq -r .link > /tmp/pt-live/link.txt
//   ./node_modules/bare/bin/bare scripts/spike-shim.js
//
// Why a spike: no other app in the suite uses bare-http1, so "does a Bare HTTP
// server bind a localhost port and answer range requests" is an unknown. Better
// to find out here than inside a React Native worklet with no debugger.

const fs = require('bare-fs')
const hcrypto = require('hypercore-crypto')
const b4a = require('b4a')
const http = require('bare-http1')

const { PearTuneClient } = require('../client')
const { createAudioShim } = require('../worklet/shim')

// Minimal fetch-with-range, since we are testing an HTTP surface from inside Bare.
function get (port, path, range) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', headers: range ? { range } : {} },
      (res) => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: b4a.concat(chunks)
        }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

async function main () {
  const link = fs.readFileSync('/tmp/pt-live/link.txt', 'utf8').trim()

  console.log('running under Bare:', typeof Bare !== 'undefined' ? Bare.versions.bare : '(not bare!)')

  const client = new PearTuneClient({
    keyPair: hcrypto.keyPair(),
    log: (m, d) => console.log('  [client]', m, d ? JSON.stringify(d) : '')
  })

  console.log('\n1. pair over the public DHT...')
  const paired = await client.pair(link, { label: 'bare-spike', platform: 'bare' })
  console.log('   paired:', paired.libraryName)

  console.log('2. connect...')
  await client.connect({ hostKey: paired.hostKey, libraryId: paired.libraryId })

  const { items } = await client.list({ type: 'tracks' })
  const track = items[0]
  console.log('3. track:', track.title, `(${track.size} bytes)`)

  console.log('4. start the audio shim (bare-http1)...')
  const shim = createAudioShim({ client, log: (m, d) => console.log('  [shim]', m, JSON.stringify(d)) })
  const port = await shim.listen()
  console.log('   url:', shim.urlFor(track.id))

  // --- what ExoPlayer actually does ---------------------------------------

  console.log('\n5. HEAD-ish probe: open-ended range (what a player asks first)')
  const probe = await get(port, `/t/${track.id}`, 'bytes=0-')
  console.log('   status:', probe.status, '(expect 206)')
  console.log('   content-type:', probe.headers['content-type'])
  console.log('   accept-ranges:', probe.headers['accept-ranges'])
  console.log('   content-range:', probe.headers['content-range'])
  console.log('   got bytes:', probe.body.length, '(expect', track.size + ')')

  console.log('\n6. SEEK: mid-file range (this is what scrubbing does)')
  const mid = Math.floor(track.size / 2)
  const seek = await get(port, `/t/${track.id}`, `bytes=${mid}-${mid + 999}`)
  console.log('   status:', seek.status, '(expect 206)')
  console.log('   content-range:', seek.headers['content-range'])
  console.log('   got bytes:', seek.body.length, '(expect 1000)')

  // Ground truth: the same window fetched directly over P2P.
  const truth = await client.stream({ trackId: track.id, offset: mid, length: 1000 })
  const same = b4a.equals(seek.body, truth)
  console.log('   bytes match direct P2P read:', same ? 'YES' : 'NO *** MISMATCH ***')

  console.log('\n7. past-EOF range (expect 416)')
  const bad = await get(port, `/t/${track.id}`, `bytes=${track.size + 10}-`)
  console.log('   status:', bad.status, '(expect 416)')

  console.log('\n8. unknown track (expect 404)')
  const missing = await get(port, '/t/deadbeef')
  console.log('   status:', missing.status, '(expect 404)')

  await shim.close()

  // --- transcode path (cellular) ------------------------------------------
  //
  // A separate shim whose policy always transcodes. The response must be a
  // PROGRESSIVE 200 - no content-length, accept-ranges: none - because a transcode
  // has no stable byte offsets. This is the bare-http1 behavior we most need to prove
  // (chunked/EOF-delimited body without a content-length), since it is new ground.
  console.log('\n9. TRANSCODE: progressive stream (expect 200, no ranges)')
  const tshim = createAudioShim({
    client,
    log: (m, d) => console.log('  [tshim]', m, JSON.stringify(d)),
    quality: () => ({ format: 'mp3', bitrate: 128 })
  })
  const tport = await tshim.listen()
  const tc = await get(tport, `/t/${track.id}`, 'bytes=0-')
  console.log('   status:', tc.status, '(expect 200)')
  console.log('   accept-ranges:', tc.headers['accept-ranges'], '(expect none)')
  console.log('   content-length:', tc.headers['content-length'], '(expect undefined)')
  console.log('   content-type:', tc.headers['content-type'], '(expect audio/mpeg)')
  console.log('   got bytes:', tc.body.length, '| magic', tc.body.subarray(0, 4).toString('hex'))
  const validMp3 = tc.body.length > 0 &&
    (tc.body.subarray(0, 3).toString('hex') === '494433' || (tc.body[0] === 0xff && (tc.body[1] & 0xe0) === 0xe0))
  console.log('   looks like an mp3:', validMp3 ? 'YES' : 'NO', '| smaller than original:', tc.body.length < track.size ? 'YES' : 'no (host may not transcode this source)')
  await tshim.close()

  const ok = probe.status === 206 &&
    probe.body.length === track.size &&
    seek.status === 206 &&
    seek.body.length === 1000 &&
    same &&
    bad.status === 416 &&
    missing.status === 404 &&
    tc.status === 200 &&
    tc.headers['accept-ranges'] === 'none' &&
    !tc.headers['content-length'] &&
    validMp3

  await client.close()

  console.log(ok ? '\nSPIKE PASSED - the shim behaves as ExoPlayer needs' : '\nSPIKE FAILED')
  // Bare.exit, NOT process.exit: `process` DOES NOT EXIST in Bare. This is the
  // classic Node-ism that compiles fine and then explodes inside the worklet.
  Bare.exit(ok ? 0 : 1)
}

main().catch(e => {
  console.error('FAILED:', e.message, e.stack)
  Bare.exit(1)
})

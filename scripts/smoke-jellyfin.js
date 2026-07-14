// Point the Jellyfin adapter at a REAL Jellyfin and watch it work.
//
//   node scripts/smoke-jellyfin.js http://umbrel.local:8096 <user> <pass>
//
// The adapter is unit-tested against the public demo (demo.jellyfin.org), but a
// real library has more than four albums and possibly a different Jellyfin version,
// so this exists to run it against yours before we trust it. It reads only; it
// streams a few bytes and stops.

const hcrypto = require('hypercore-crypto')
const { JellyfinAdapter } = require('../host/adapters/jellyfin')
const { libraryId } = require('../protocol/ids')

async function drain (stream, cap = Infinity) {
  const chunks = []
  let n = 0
  for await (const c of stream) {
    chunks.push(c)
    n += c.length
    if (n >= cap) break
  }
  return Buffer.concat(chunks)
}

async function main () {
  const [url, username, password] = process.argv.slice(2)
  if (!url) {
    console.error('usage: node scripts/smoke-jellyfin.js <url> <username> <password>')
    process.exit(1)
  }

  const lib = libraryId(hcrypto.randomBytes(32))
  const jf = new JellyfinAdapter({ url, username, password: password || '', libraryId: lib, log: (m, d) => console.log('  ·', m, d ? JSON.stringify(d) : '') })

  console.log('\nscanning', url, 'as', username, '...')
  const n = await jf.scan()
  console.log('  ' + n + ' tracks\n')

  const albums = await jf.list({ type: 'albums', limit: 8 })
  console.log('ALBUMS (' + albums.items.length + ' of the first page):')
  for (const a of albums.items) console.log('  ' + a.name + ' — ' + a.artist + ' (' + a.songCount + ' songs, ' + a.year + ')')

  const artists = await jf.list({ type: 'artists', limit: 8 })
  console.log('\nARTISTS: ' + artists.items.map(a => a.name).join(', '))

  const tracks = await jf.list({ type: 'tracks', limit: 3 })
  console.log('\nTRACKS:')
  for (const t of tracks.items) {
    console.log('  ' + t.title + ' — ' + t.artist + ' · disc ' + t.disc + ' track ' + t.track +
      ' · ' + Math.round((t.durationMs || 0) / 1000) + 's · ' + t.size + 'b · ' + t.suffix)
  }

  if (tracks.items[0]) {
    const t = tracks.items[0]
    console.log('\nstreaming "' + t.title + '"...')
    const head = await drain(await jf.stream({ trackId: t.id }), 65536)
    console.log('  first ' + head.length + ' bytes OK')
    const part = await drain(await jf.stream({ trackId: t.id, offset: 1000, length: 256 }))
    console.log('  range read (offset 1000, len 256): ' + part.length + ' bytes ' + (part.length === 256 ? 'OK' : 'FAIL'))
  }

  const first = albums.items[0]
  if (first?.coverId) {
    const art = await jf.art({ coverId: first.coverId, size: 300 })
    if (art) {
      const buf = await drain(art)
      console.log('\nart for "' + first.name + '": ' + buf.length + ' bytes')
    } else {
      console.log('\nart for "' + first.name + '": none')
    }
  }

  console.log('\nOK')
  process.exit(0)
}

main().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1) })

'use strict'

// A fake Audiobookshelf for tests, serving real 2.36.0 responses captured from the Umbrel
// (the JSON files next to this one): a single-file m4b with three chapters and a book in five
// mp3 parts, plus a podcast library that must never be listed.

const http = require('http')
const path = require('path')
const fs = require('fs')

const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'))
const SHORT = '8dc29fa1-016d-4141-ad9f-6576a2fcaee5'
const PARTS = '31d47626-3c69-4de0-9324-8e1c777f86f4'
const FILE_BYTES = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256))

// A fake server. `tokens` are what it accepts; `/login` mints `fresh-N`. Every request is
// recorded so tests can see what was asked for.
async function fakeAbs (t, { apiKey = 'key-1', password = 'pw' } = {}) {
  const libraries = read('libraries.json')
  const page0 = read('items-page0.json')
  const items = { [SHORT]: read('item-8dc29fa1.json'), [PARTS]: read('item-31d47626.json') }
  const tokens = new Set([apiKey])
  const seen = []
  let logins = 0
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    seen.push({ path: url.pathname, query: url.search, auth: req.headers.authorization || null, range: req.headers.range || null })
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (url.pathname === '/login' && req.method === 'POST') {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        const { password: pw } = JSON.parse(body || '{}')
        if (pw !== password) return json(401, {})
        const tok = `fresh-${++logins}`
        tokens.add(tok)
        json(200, { user: { accessToken: tok, refreshToken: 'r' }, serverSettings: { version: '2.36.0' } })
      })
      return
    }
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '')
    if (!tokens.has(bearer)) return json(401, {})
    if (url.pathname === '/api/libraries') return json(200, libraries)
    if (url.pathname === '/api/libraries/pod-lib-1/items') throw new Error('podcast library was listed')
    if (/^\/api\/libraries\/[^/]+\/items$/.test(url.pathname)) return json(200, page0)
    let m = url.pathname.match(/^\/api\/items\/([^/]+)$/)
    if (m) return items[m[1]] ? json(200, items[m[1]]) : json(404, {})
    m = url.pathname.match(/^\/api\/items\/([^/]+)\/cover$/)
    if (m) { res.writeHead(200, { 'content-type': 'image/webp' }); return res.end(Buffer.from('RIFFcover')) }
    m = url.pathname.match(/^\/api\/items\/([^/]+)\/file\/([^/]+)$/)
    if (m) {
      const r = (req.headers.range || '').match(/bytes=(\d+)-(\d*)/)
      if (!r) { res.writeHead(200, { 'content-type': 'audio/mp4' }); return res.end(FILE_BYTES) }
      const start = Number(r[1]); const end = r[2] ? Number(r[2]) : FILE_BYTES.length - 1
      res.writeHead(206, { 'content-type': 'audio/mp4', 'content-range': `bytes ${start}-${end}/${FILE_BYTES.length}` })
      return res.end(FILE_BYTES.subarray(start, end + 1))
    }
    json(404, {})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    revoke: (tok) => tokens.delete(tok),
    logins: () => logins
  }
}

module.exports = { fakeAbs, SHORT, PARTS, FILE_BYTES }

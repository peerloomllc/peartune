// Pairing-link parsing.
//
// The cross-rejection tests are the point of this file. A loose parser here
// means a scanned QR from another app could aim a device at the wrong topic,
// and PearCircle already shipped a test like this for the same reason.

const test = require('node:test')
const assert = require('node:assert/strict')
const b4a = require('b4a')
const z32 = require('z32')
const hcrypto = require('hypercore-crypto')

const { encodeLink, parseLink, isPairLink } = require('../protocol/link')

const rv = hcrypto.randomBytes(32)
const hostKey = hcrypto.keyPair().publicKey

test('encode -> parse round-trips', () => {
  const link = encodeLink({ rv, hostKey, name: 'Tim\'s Library' })
  const parsed = parseLink(link)

  assert.equal(parsed.version, 1)
  assert.ok(b4a.equals(parsed.rv, rv))
  assert.ok(b4a.equals(parsed.hostKey, hostKey))
  assert.equal(parsed.name, 'Tim\'s Library')
})

test('name is optional', () => {
  const parsed = parseLink(encodeLink({ rv, hostKey }))
  assert.equal(parsed.name, null)
})

test('a name with & and = survives (url-encoded)', () => {
  const nasty = 'Rock & Roll = Life'
  const parsed = parseLink(encodeLink({ rv, hostKey, name: nasty }))
  assert.equal(parsed.name, nasty)
})

test('carries no secret material: only rv and a public key', () => {
  const link = encodeLink({ rv, hostKey, name: 'x' })
  // The seed must never appear in a link. This is a canary: if someone ever adds
  // it "for convenience", this fails.
  assert.ok(!link.includes('seed'))
  assert.ok(!link.includes('secret'))
  const parsed = parseLink(link)
  assert.deepEqual(Object.keys(parsed).sort(), ['hostKey', 'name', 'rv', 'version'])
})

test('CROSS-REJECT: other apps\' links must not parse as PearTune pairing links', () => {
  const foreign = [
    'pear://pearcircle/join?circle=abc&key=def',
    'pear://pearcircle/seeder-pair?rv=' + z32.encode(rv),
    'pear://pearcal/join?cal=abc',
    'https://peerloomllc.com/circle/join?circle=abc',
    'pear://peartune/join?rv=' + z32.encode(rv), // right app, WRONG path
    'pear://peartunes/pair?rv=' + z32.encode(rv), // lookalike host
    'https://peerloomllc.com/peartune/pair?rv=' + z32.encode(rv)
  ]

  for (const link of foreign) {
    assert.throws(() => parseLink(link), /invalid PearTune pairing link/, `should reject: ${link}`)
    assert.equal(isPairLink(link), false, `isPairLink should be false: ${link}`)
  }
})

test('rejects an unsupported version', () => {
  const link = encodeLink({ rv, hostKey }).replace('v=1', 'v=2')
  assert.throws(() => parseLink(link), /unsupported pairing link version/)
})

test('rejects malformed or wrong-length keys', () => {
  assert.throws(() => parseLink('pear://peartune/pair?v=1&rv=notz32!!&host=' + z32.encode(hostKey)), /malformed z32/)

  const shortRv = z32.encode(hcrypto.randomBytes(16))
  assert.throws(
    () => parseLink(`pear://peartune/pair?v=1&rv=${shortRv}&host=${z32.encode(hostKey)}`),
    /rv must be 32 bytes/
  )

  const shortHost = z32.encode(hcrypto.randomBytes(16))
  assert.throws(
    () => parseLink(`pear://peartune/pair?v=1&rv=${z32.encode(rv)}&host=${shortHost}`),
    /host key must be 32 bytes/
  )
})

test('rejects a link missing rv or host', () => {
  assert.throws(() => parseLink('pear://peartune/pair?v=1'), /missing rv or host/)
  assert.throws(() => parseLink(`pear://peartune/pair?v=1&rv=${z32.encode(rv)}`), /missing rv or host/)
})

test('rejects non-strings and junk', () => {
  assert.throws(() => parseLink(null), /must be a string/)
  assert.throws(() => parseLink(''), /invalid PearTune pairing link/)
  assert.throws(() => parseLink('pear://peartune/pair'), /invalid PearTune pairing link/)
})

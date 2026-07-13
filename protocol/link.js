// The pairing link, encoded into the QR the host dashboard shows.
//
// It carries NO secret material. `rv` only names a rendezvous topic that is
// open for 5 minutes, and `host` is a public key. A photographed QR is useless
// once the window closes, and even inside the window it does not by itself let
// anyone reach the library: the phone still has to be admitted by the operator's
// open session, and the host still writes a grant keyed to the phone's real,
// Noise-proven public key.
//
// The `hostKey` in the link exists so the PHONE can verify it is talking to the
// right host (guard 1 from PearCircle's seeder review): topic knowledge alone
// must never be enough to impersonate the host and harvest a device.

const z32 = require('z32')
const b4a = require('b4a')
const { LINK_SCHEME, LINK_VERSION } = require('./constants')

function encodeLink ({ rv, hostKey, name }) {
  const rvStr = typeof rv === 'string' ? rv : z32.encode(rv)
  const hostStr = typeof hostKey === 'string' ? hostKey : z32.encode(hostKey)
  const q = [
    `v=${LINK_VERSION}`,
    `rv=${rvStr}`,
    `host=${hostStr}`
  ]
  if (name) q.push(`name=${encodeURIComponent(name)}`)
  return `${LINK_SCHEME}?${q.join('&')}`
}

// Strict. Anything that is not exactly a PearTune v1 pairing link throws.
//
// This MUST cross-reject the other apps' links: a PearCircle circle invite, a
// PearCircle seeder-pair link, or a PearCal join URL must never parse as a
// PearTune pairing link (and vice versa). A parser that is loose here is a
// vector for pointing a user's device at the wrong app's topic.
function parseLink (link) {
  if (typeof link !== 'string') throw new Error('link must be a string')

  const trimmed = link.trim()
  const qIndex = trimmed.indexOf('?')
  if (qIndex === -1) throw new Error('invalid PearTune pairing link')

  const base = trimmed.slice(0, qIndex)
  if (base !== LINK_SCHEME) throw new Error('invalid PearTune pairing link')

  const params = new Map()
  for (const pair of trimmed.slice(qIndex + 1).split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    params.set(pair.slice(0, eq), pair.slice(eq + 1))
  }

  const v = Number(params.get('v'))
  if (v !== LINK_VERSION) throw new Error(`unsupported pairing link version: ${params.get('v')}`)

  const rvStr = params.get('rv')
  const hostStr = params.get('host')
  if (!rvStr || !hostStr) throw new Error('pairing link missing rv or host')

  let rv, hostKey
  try {
    rv = z32.decode(rvStr)
    hostKey = z32.decode(hostStr)
  } catch {
    throw new Error('pairing link has malformed z32')
  }

  if (rv.byteLength !== 32) throw new Error('rv must be 32 bytes')
  if (hostKey.byteLength !== 32) throw new Error('host key must be 32 bytes')

  const name = params.has('name') ? decodeURIComponent(params.get('name')) : null

  return { version: v, rv, hostKey, name }
}

// Convenience for the phone: does this look like ours at all? Used to route a
// scanned QR to the right handler without throwing.
function isPairLink (link) {
  return typeof link === 'string' && link.trim().startsWith(LINK_SCHEME + '?')
}

module.exports = { encodeLink, parseLink, isPairLink, b4a }

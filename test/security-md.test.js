// SECURITY.md, held against the code it describes.
//
// A security page is a set of PROMISES to somebody deciding whether to run this on
// their own machine. The two guards written earlier today (review-notes, claude-md)
// both caught real drift on their first run, and a stale promise here is worse than a
// stale one there: it is the document an auditor reads instead of the code.
//
// Only the mechanically checkable claims. The prose is not the subject.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const security = read('SECURITY.md')

test('"ffmpeg is never handed to a shell" is still true of the host', () => {
  assert.match(security, /never handed to a shell/)
  // Every host file, not only the transcoder: the claim is about the whole host.
  const hostFiles = [
    ...fs.readdirSync(path.join(root, 'host')).filter(f => f.endsWith('.js')).map(f => `host/${f}`),
    ...fs.readdirSync(path.join(root, 'host', 'adapters')).filter(f => f.endsWith('.js')).map(f => `host/adapters/${f}`)
  ]
  for (const f of hostFiles) {
    const src = read(f)
    assert.ok(!/shell\s*:\s*true/.test(src), `${f} spawns through a shell, and SECURITY.md says nothing does`)
    assert.ok(!/\bchild_process\.exec\b|\bexecSync\s*\(|require\(['"]child_process['"]\)\.exec\b/.test(src),
      `${f} uses exec, and SECURITY.md says every run is spawn(binary, [args])`)
  }
})

test('"there are no passwords or tokens" holds: no bearer credential on the wire', () => {
  // The design rule from CLAUDE.md and DECISIONS 2026-07-13. Noise identifies the
  // caller, so a token would be a second, weaker answer to a solved question.
  assert.match(security, /no passwords, tokens or connection strings/i)
  for (const f of ['protocol/framing.js', 'protocol/channels.js', 'host/media.js', 'client/index.js']) {
    assert.ok(!/\bbearer\b|authorization:\s*['"`]/i.test(read(f)),
      `${f} carries a bearer credential, which SECURITY.md swears does not exist`)
  }
})

test('"the allow-list is never replicated" is still how the grant store is built', () => {
  assert.match(security, /host-local and never replicated/i)
  const grants = read('host/grants.js')
  assert.match(grants, /NEVER REPLICATED/i, 'the rule should still be stated at the store itself')
  assert.ok(!/replicate\s*\(/.test(grants), 'host/grants.js must not replicate anything')
})

test('"it refuses to start unauthenticated on a network" is a throw, not a warning', () => {
  assert.match(security, /refuses to start unauthenticated/i)
  const { requireSafeBind } = require('../host/ui/auth')
  assert.throws(() => requireSafeBind('0.0.0.0', ''), /refusing to start/)
  // ...and the loopback + password cases still start.
  assert.doesNotThrow(() => requireSafeBind('127.0.0.1', ''))
  assert.doesNotThrow(() => requireSafeBind('0.0.0.0', 'a-password'))
})

test('the dashboard Host/Origin check named here actually exists', () => {
  assert.match(security, /Host` and `Origin/)
  const ui = read('host/ui/server.js')
  assert.match(ui, /sameHostRequest/, 'the guard SECURITY.md describes is gone from the dashboard')
  assert.match(ui, /!auth\.enabled && !sameHostRequest\(req\)/,
    'and it must stay gated on there being no password, or the Umbrel install breaks')
})

test('the phone\'s URL allowlist matches what SECURITY.md promises', () => {
  const { OPENABLE_SCHEMES } = require('../app/openable')
  assert.deepEqual(OPENABLE_SCHEMES, ['https:', 'mailto:', 'lightning:', 'bitcoin:'])
  for (const scheme of OPENABLE_SCHEMES) {
    assert.ok(security.includes('`' + scheme + '`'), `SECURITY.md should name ${scheme} as openable`)
  }
  // The two it promises to refuse, by name.
  assert.match(security, /intent:\/\//)
  assert.match(security, /file:\/\//)
  // And the shell must actually consult it.
  assert.match(read('app/index.tsx'), /openableUrl\(msg\.args\.url\)/)
})

test('the camera-only permission claim matches the shell', () => {
  assert.match(security, /only capture permission granted is the camera/i)
  const shell = read('app/index.tsx')
  assert.match(shell, /VIDEO_CAPTURE/, 'the permission handler must still filter to video capture')
  assert.ok(!/ev\?\.grant\?\.\(ev\.resources\)/.test(shell),
    'granting whatever was asked is exactly what this claim says does not happen')
})

test('the relay description matches a relay that actually ships', () => {
  assert.match(security, /falls back to a relay/i)
  // The z-base32 literal is the source of truth; RELAY_PUBLIC_KEY is its decoded form
  // (null when the literal is empty), so read the literal rather than the buffer.
  const declared = read('protocol/relay.js').match(/RELAY_PUBLIC_KEY_Z\s*=\s*'([^']*)'/)
  assert.ok(declared, 'protocol/relay.js no longer declares RELAY_PUBLIC_KEY_Z - this guard needs rewriting')
  const { RELAY_PUBLIC_KEY } = require('../protocol/relay')
  if (declared[1].length) {
    assert.ok(RELAY_PUBLIC_KEY, 'a declared relay key must decode to something the client can dial')
  } else {
    // Emptied: the page must stop describing a relay rather than keep a paragraph
    // about something that is not there.
    assert.doesNotMatch(security, /falls back to a relay/i)
  }
})

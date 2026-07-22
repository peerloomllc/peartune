// What a failure says to the person holding the phone.
//
// This exists because a raw `undefined is not a function` was shipped to the user as
// a red bar across the library - a stack trace with the stack cut off, telling them
// nothing except that PearTune is broken. The rules worth pinning are: an internal
// error must be classified as a BUG (so it offers to be reported) and never as a
// network blip, our own human copy must pass through untouched, and nothing that
// leaves the phone in a bug report may carry a key.

const test = require('node:test')
const assert = require('node:assert/strict')

const load = () => import('../src/ui/errors.mjs')

test('an internal JS error is a BUG, in plain language, with the original kept', async () => {
  const { friendlyError } = await load()
  const r = friendlyError('undefined is not a function')
  assert.equal(r.kind, 'bug')
  assert.match(r.title, /went wrong inside PearTune/)
  assert.ok(r.hint.includes('not something you did'), 'it does not blame the user')
  assert.equal(r.technical, 'undefined is not a function', 'the original survives for the report')
})

test('internal errors are classified BEFORE the network patterns', async () => {
  const { friendlyError } = await load()
  // The trap: this mentions "connection", so a naive order files a real crash as a
  // network blip and the bug stays invisible.
  const r = friendlyError("Cannot read property 'connection' of undefined")
  assert.equal(r.kind, 'bug')
})

test('recognised causes get an action, not a diagnosis', async () => {
  const { friendlyError } = await load()

  const revoked = friendlyError('host refused: grant revoked')
  assert.equal(revoked.kind, 'known')
  assert.match(revoked.title, /stopped this device's access/)

  const net = friendlyError('ECONNREFUSED connecting to host')
  assert.equal(net.kind, 'known')
  assert.match(net.title, /Can't reach your library/)

  const gone = friendlyError('track not found')
  assert.equal(gone.kind, 'known')
  assert.match(gone.title, /isn't in your library/)

  // A known cause is not a bug, so it must NOT beg to be reported...
  assert.ok(net.technical, '...but the original is still there under Details')
})

test('a message we already wrote for a human passes through as-is', async () => {
  const { friendlyError } = await load()
  const human = 'That pairing code has expired. Show a fresh one on your server and try again.'
  const r = friendlyError(human)
  assert.equal(r.kind, 'plain')
  assert.equal(r.title, human)
  assert.equal(r.technical, undefined, 'no Details drawer for a sentence we wrote')
})

test('an unrecognised message is a bug, not a shrug', async () => {
  const { friendlyError } = await load()
  const r = friendlyError('weird thing happened')
  assert.equal(r.kind, 'bug')
  assert.equal(r.technical, 'weird thing happened')
})

test('empty / missing errors render nothing at all', async () => {
  const { friendlyError } = await load()
  assert.equal(friendlyError(''), null)
  assert.equal(friendlyError(null), null)
  assert.equal(friendlyError(undefined), null)
  assert.equal(friendlyError('   '), null)
})

test('redact strips keys and loopback stream URLs', async () => {
  const { redact } = await load()
  const key = 'fgndhydp8p4gpx51pifhf83g9h7d7ymd3myp7kz3orx4o45znfco'
  const out = redact(`failed for ${key} at http://127.0.0.1:39695/t/${key}/abc`)
  assert.ok(!out.includes(key), 'no key survives: ' + out)
  assert.ok(!out.includes('39695'), 'no loopback port survives: ' + out)
  assert.match(out, /<id>/)
  assert.match(out, /<local stream url>/)
})

test('a bug report URL carries the message, the version and no keys', async () => {
  const { reportUrl } = await load()
  const key = 'fgndhydp8p4gpx51pifhf83g9h7d7ymd3myp7kz3orx4o45znfco'
  const url = reportUrl(`boom ${key}`, { version: '0.1.0', platform: 'android', repo: 'https://example.test/repo' })

  assert.ok(url.startsWith('https://example.test/repo/issues/new?labels=bug&'))
  const decoded = decodeURIComponent(url)
  assert.ok(decoded.includes('boom <id>'), 'the message is in the body, redacted')
  assert.ok(decoded.includes('App 0.1.0'), 'and the version, so a report says which build')
  assert.ok(decoded.includes('android'))
  assert.ok(!decoded.includes(key), 'and never the key')
})

test('the same report is available as an email, because GitHub demands a login first', async () => {
  const { reportMailto } = await load()
  const key = 'fgndhydp8p4gpx51pifhf83g9h7d7ymd3myp7kz3orx4o45znfco'
  const url = reportMailto(`boom ${key}`, { version: '0.1.0', platform: 'ios', to: 'help@example.test' })

  assert.ok(url.startsWith('mailto:help@example.test?subject='))
  const decoded = decodeURIComponent(url)
  assert.ok(decoded.includes('[PearTune] [bug]'), 'the subject says what it is')
  assert.ok(decoded.includes('boom <id>'), 'same redacted body as the GitHub route')
  assert.ok(!decoded.includes('**'), 'but no markdown: a mail client shows it raw')
  assert.ok(!decoded.includes('```'))
  assert.ok(decoded.includes('App 0.1.0'))
  assert.ok(!decoded.includes(key))
})

test('a failed dial reads as a network problem, not as an app bug', async () => {
  const { friendlyError } = await load()
  // The exact string client/index.js produces for a dial that never opened. It reached the
  // user verbatim once - "could not reach the host" - which is developer wording for the one
  // thing this classifier exists to translate.
  const r = friendlyError('could not reach the host')
  assert.equal(r.kind, 'known', 'not a bug report - the network is the story')
  assert.match(r.title, /Can't reach your library/)
  assert.ok(r.hint.includes('network'), 'and it says what to check')
})

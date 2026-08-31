// The shell's URL allowlist: what PearTune will hand to the operating system.
//
// `shell:openUrl` passed its argument straight to Linking.openURL, so a compromised
// bundled page could launch an arbitrary Android component (`intent://`) or point a
// viewer at local storage (`file://`). Found 2026-08-31 by an audit of PearCinema and
// verified present here before fixing.

const test = require('node:test')
const assert = require('node:assert/strict')

const { openableUrl, OPENABLE_SCHEMES } = require('../app/openable')

test('every scheme the UI actually opens is allowed', () => {
  for (const url of [
    'https://github.com/peerloomllc/peartune',
    'https://peerloomllc.com/',
    'mailto:peerloomllc@proton.me?subject=PearTune',
    'lightning:lnurl1dp68gurn8ghj7',
    'bitcoin:bc1qexample'
  ]) {
    assert.equal(openableUrl(url), true, url)
  }
})

test('the schemes that launch OTHER THINGS are refused', () => {
  for (const url of [
    'intent://scan/#Intent;scheme=zxing;package=com.evil;end',   // arbitrary Android component
    'file:///data/data/com.peartune/files/peartune/identity.json', // the device's own key
    'content://com.android.contacts/data/1',
    'javascript:fetch("https://evil.example")',
    'data:text/html,<script>alert(1)</script>',
    'app-settings:',
    'tel:911',
    'sms:911'
  ]) {
    assert.equal(openableUrl(url), false, url)
  }
})

test('the scheme match is case-insensitive and not fooled by leading whitespace', () => {
  assert.equal(openableUrl('HTTPS://example.com'), true, 'RFC 3986 says schemes are case-insensitive')
  assert.equal(openableUrl('Intent://evil'), false)
  assert.equal(openableUrl('  intent://evil'), false, 'a parser that skips leading space must not be handed this')
  assert.equal(openableUrl('\n\tintent://evil'), false)
})

test('nothing degenerate slips through', () => {
  for (const url of ['', null, undefined, 'no-scheme-at-all', '://evil', ':', 'https', 42]) {
    assert.equal(openableUrl(url), false, String(url))
  }
})

test('http is NOT on the list, deliberately', () => {
  // Every link the app opens is https. Allowing plain http would let a compromised
  // page downgrade one, and there is nothing here that needs it.
  assert.equal(openableUrl('http://example.com'), false)
  assert.ok(!OPENABLE_SCHEMES.includes('http:'))
})

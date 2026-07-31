// iOS Info.plist config that the JS depends on but cannot enforce.
//
// On iOS, `Linking.canOpenURL` answers NO for any CUSTOM scheme the app has not declared in
// `LSApplicationQueriesSchemes` - regardless of whether a handler is installed - and logs
// "This app is not allowed to query for scheme x". There is no error and no crash: the call simply
// returns false forever, so the feature gated on it silently never appears. Android has no such
// rule, so this is invisible from the platform we develop and test on most.
//
// Found 2026-07-30 while testing the shell services on iOS: the donation sheet asks
// canOpenURL('lightning:test') to decide whether to offer "open in your wallet", and the key was
// missing from app.json, the config plugins and the built Info.plist alike. So every iOS user with
// a Lightning wallet installed was told they had none.
//
// This test ties the two together: every custom scheme the UI QUERIES must be DECLARED. Adding a
// new canOpenURL without the plist entry now fails here rather than shipping as a feature that
// quietly does nothing on one platform.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')

// Schemes iOS lets any app query without declaring them. Everything else needs the key.
const ALWAYS_ALLOWED = new Set(['http', 'https', 'mailto', 'tel', 'sms', 'facetime'])

test('every custom scheme the UI queries with canOpenURL is declared for iOS', () => {
  const ui = fs.readFileSync(path.join(ROOT, 'src/ui/App.jsx'), 'utf8')
  const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
  const declared = new Set(app?.expo?.ios?.infoPlist?.LSApplicationQueriesSchemes || [])

  // `call('shell:canOpenURL', { url: 'lightning:test' })` and any future sibling.
  const queried = new Set()
  const re = /shell:canOpenURL['"]\s*,\s*\{\s*url:\s*['"]([a-zA-Z][a-zA-Z0-9+.\-]*):/g
  let m
  while ((m = re.exec(ui))) {
    const scheme = m[1].toLowerCase()
    if (!ALWAYS_ALLOWED.has(scheme)) queried.add(scheme)
  }

  // The test is only meaningful while the app actually queries something - if this ever drops to
  // zero, the regex has drifted away from the call site rather than the calls having gone away.
  assert.ok(queried.size > 0, 'found no canOpenURL call to check - has the call shape changed?')

  for (const scheme of queried) {
    assert.ok(
      declared.has(scheme),
      `app.json must list "${scheme}" under expo.ios.infoPlist.LSApplicationQueriesSchemes - ` +
      'without it iOS answers canOpenURL false forever and the feature gated on it never appears'
    )
  }
})

test('the iOS infoPlist block still carries the settings the app depends on', () => {
  const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
  const plist = app?.expo?.ios?.infoPlist || {}
  // Background audio is the one that silently ruins the product if it is dropped: playback stops
  // the moment the screen locks, which is most of how anyone listens to music.
  assert.ok((plist.UIBackgroundModes || []).includes('audio'), 'UIBackgroundModes must include audio')
})

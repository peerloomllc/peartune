// THE NOTES SENT TO APP REVIEW, HELD AGAINST THE APP THEY DESCRIBE.
//
// PearTune's own scar: it sent a reviewer to a button that had since moved, which is
// itself a Guideline 2.1 rejection - the reviewer follows the steps, the step is not
// there, and the app "does not work". A tap path written once and never re-checked is
// a rejection waiting for a UI tidy-up. (PearCinema wrote this guard first, naming
// that rejection as the reason; this is the same guard coming home.)
//
// Every screen name and button label the notes name is checked against the strings
// actually in src/ui/App.jsx. What this CANNOT prove is that the ORDER is still right
// or that a step is not missing - that needs somebody walking the build being
// submitted.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const notes = fs.readFileSync(path.join(root, 'metadata', 'ios', 'review-notes.md'), 'utf8')
// Typographic apostrophes normalised on both sides: the UI renders don't as don’t,
// the notes type it plain, and the claim is about the words rather than the codepoint.
const plain = (s) => s.replace(/’/g, "'").replace(/\\'/g, "'")
const app = plain(fs.readFileSync(path.join(root, 'src', 'ui', 'App.jsx'), 'utf8'))

// The note itself is everything after the marker line; the header above it is for us.
const body = plain(notes.split(/^---$/m).slice(1).join('---').trim())

test('the note has its marker and fits the box Apple gives it', () => {
  assert.ok(body.length > 0, 'no --- marker line, so nothing would be pushed')
  assert.ok(body.length <= 4000, `the note is ${body.length} chars and Apple caps the field at 4000`)
})

test('EVERY BUTTON THE NOTES TELL A REVIEWER TO TAP IS IN THE APP', () => {
  // 'Where is your music?' is deliberately NOT here: the notes used to name it and the
  // app never shows that heading - the first run of this guard caught it (2026-08-31).
  for (const label of ['Get started', 'Continue', "I don't have one yet", 'Who is this?']) {
    assert.ok(app.includes(label), `the notes tell a reviewer to tap "${label}", and App.jsx does not contain it`)
    assert.ok(body.includes(label), `"${label}" should be quoted in the notes`)
  }
})

test('the notes promise the demo this build actually has', () => {
  const tracks = fs.readdirSync(path.join(root, 'assets', 'demo-music')).filter(f => /\.(mp3|flac|ogg|m4a)$/i.test(f))
  // Said as a number in the notes, so the number has to be the truth.
  assert.match(body, new RegExp(`\\b${['zero', 'one', 'two', 'three', 'four', 'five', 'six'][tracks.length] || tracks.length}\\b`),
    `the notes should say the demo has ${tracks.length} tracks`)
  // The credit the notes point the reviewer at ("credited in the app's About tab")
  // has to be in the app, and the licence claim in both places.
  assert.match(body, /Loyalty Freak Music/)
  assert.match(body, /CC0/)
  assert.match(app, /Loyalty Freak Music/)
  assert.match(app, /CC0/)
})

test('the notes do not claim a sign-in, and do not offer an account', () => {
  // "Sign-In Required: NO" is a field in App Store Connect, and the note has to agree
  // with it. Saying there is no test account is right and useful; HANDING ONE OVER is
  // the thing that cannot happen, so the check is for credentials, not the words.
  assert.match(body, /no account/i)
  assert.ok(!/username and password|password:|log in with|sign in with/i.test(body),
    'the notes must not offer credentials for an app that has none')
})

test('the NO VPN clarification stands, and stays true', () => {
  // Apple's automated analysis rejected PearCinema 1.1.1 claiming VPN functionality -
  // almost certainly the Hyperswarm hole-punching stack, which PearTune shares. The
  // section pre-empts the same flag here; a note that quietly lost it re-arms the
  // rejection (see the file's own header, and DONE 2026-08-31).
  assert.match(body, /NO VPN FUNCTIONALITY/)
  assert.match(body, /NetworkExtension/)

  // And the claim must remain TRUE: the day a NetworkExtension entitlement appears in
  // the tree, this note becomes a lie told directly to App Review.
  const appJson = fs.readFileSync(path.join(root, 'app.json'), 'utf8')
  assert.ok(!/packet-tunnel|NEVPN|networking\.vpn/i.test(appJson),
    'app.json declares VPN capability while the review notes swear there is none')
  const entDir = path.join(root, 'ios', 'PearTune')
  for (const f of fs.readdirSync(entDir).filter(f => f.endsWith('.entitlements'))) {
    const ent = fs.readFileSync(path.join(entDir, f), 'utf8')
    assert.ok(!/packet-tunnel|networking\.vpn/i.test(ent),
      `${f} declares VPN capability while the review notes swear there is none`)
  }
})

test('the file has a push path, so the ASC copy cannot silently drift', () => {
  // The 1.0.x notes lived only on App Store Connect, invisible to review and to a
  // fresh clone. This file is the source of truth BECAUSE something pushes it; if the
  // pusher goes, the file is decoration again.
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'asc-review-notes.mjs')),
    'scripts/asc-review-notes.mjs pushes this file to App Store Connect')
  const release = fs.readFileSync(path.join(root, 'scripts', 'release.sh'), 'utf8')
  assert.match(release, /asc-review-notes\.mjs/,
    'release.sh must offer the push during the App Store publish (step 3b)')
})

// The iOS version has THREE sources of truth and only one of them ships.
//
// app.json is what the release script bumps. ios/PearTune.xcodeproj/project.pbxproj
// carries MARKETING_VERSION / CURRENT_PROJECT_VERSION. And ios/PearTune/Info.plist
// carries CFBundleShortVersionString / CFBundleVersion as LITERAL values, because
// that is what `expo prebuild` writes - not $(MARKETING_VERSION) references.
//
// Info.plist is the one that ends up in the IPA. So it can disagree with both of the
// others and the build will happily archive, sign, export and upload something no
// other file in the tree describes.
//
// WHICH IS EXACTLY WHAT HAPPENED, 2026-08-17. The 1.0.2 release had app.json at
// 1.0.2 build 5 and project.pbxproj at MARKETING_VERSION 1.0.2 /
// CURRENT_PROJECT_VERSION 5 on BOTH the Linux box and the Mac mini - and still
// produced an IPA stamped 1.0.1 build 3, because Info.plist was a snapshot from the
// last prebuild and step 0 only ever sed'd the pbxproj. App Store Connect already
// held build 3 in the 1.0.1 train and rejected it:
//
//   The bundle version must be higher than the previously uploaded version.
//
// The archive, the signing and the export all "succeeded". Nothing between the bump
// and Apple's own uniqueness check looked at what was actually in the bundle.
//
// Step 0 now syncs Info.plist as well, so this guard has something that satisfies it
// rather than being a wall across the release path.
//
// SKIPS when ios/ is absent: unlike android/, ios/ is NOT committed here - expo
// prebuild generates it - so a fresh clone legitimately has no plist to check.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const plist = path.join(__dirname, '..', 'ios', 'PearTune', 'Info.plist')
const pbxproj = path.join(__dirname, '..', 'ios', 'PearTune.xcodeproj', 'project.pbxproj')
const app = require(path.join(__dirname, '..', 'app.json')).expo

// Read a <key>NAME</key> followed by its <string>VALUE</string>. Deliberately the
// same shape the release script's sed targets, so the test fails if that sed ever
// stops matching the file it is meant to edit.
function plistString (text, key) {
  const m = text.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))
  return m ? m[1] : null
}

test('ios Info.plist version matches app.json (it is the one that ships)', { skip: !fs.existsSync(plist) && 'ios/ not prebuilt here' }, () => {
  const text = fs.readFileSync(plist, 'utf8')

  assert.equal(
    plistString(text, 'CFBundleShortVersionString'), app.version,
    'Info.plist CFBundleShortVersionString disagrees with app.json. This is the value that ' +
    'ends up in the IPA, so the upload would carry a version nothing else in the tree claims. ' +
    'Release step 0 syncs this; if it drifted, that sync did not run or stopped matching.'
  )
  assert.equal(
    plistString(text, 'CFBundleVersion'), String(app.ios.buildNumber),
    'Info.plist CFBundleVersion disagrees with app.json.expo.ios.buildNumber. App Store Connect ' +
    'rejects a build number it has already seen for a version train, which is how this last ' +
    'surfaced - after a full archive, sign and export.'
  )
})

test('ios project.pbxproj version matches app.json', { skip: !fs.existsSync(pbxproj) && 'ios/ not prebuilt here' }, () => {
  const text = fs.readFileSync(pbxproj, 'utf8')
  const marketing = [...text.matchAll(/MARKETING_VERSION = ([0-9][0-9.]*);/g)].map(m => m[1])
  const current = [...text.matchAll(/CURRENT_PROJECT_VERSION = ([0-9]+)/g)].map(m => m[1])

  assert.ok(marketing.length > 0, 'no MARKETING_VERSION found - the step 0 sed would be a no-op')
  assert.ok(current.length > 0, 'no CURRENT_PROJECT_VERSION found - the step 0 sed would be a no-op')

  // Every occurrence, not just the first: the sed uses /g and a target left behind
  // would be the one an archive picks up.
  for (const v of marketing) assert.equal(v, app.version, 'a MARKETING_VERSION disagrees with app.json')
  for (const v of current) assert.equal(v, String(app.ios.buildNumber), 'a CURRENT_PROJECT_VERSION disagrees with app.json')
})

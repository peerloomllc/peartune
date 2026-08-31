// THE FIRST FILE EVERY SESSION READS, guarded against going stale.
//
// Found stale for real on 2026-08-31: the Status section still promised "milestone 3
// (offline + Autobase ledger)" as NEXT and the architecture diagram drew an Autobase
// ledger on both the phone and the host - against a tree with zero Autobase anywhere,
// user state long since shipped host-as-hub (host/state.js) and the app released on
// five channels. A stale instruction file is worse than no instruction file: it is
// read as authority. (PearCinema wrote this guard first, after its own CLAUDE.md said
// "NO APP CODE YET" over a shipping app.)
//
// These are drift guards, not prose review. Each pairs a sentence in the document
// with the code that would make it a lie, so the pair cannot separate silently.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')

test('CLAUDE.md does not promise an Autobase ledger the tree does not contain', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const hasAutobase = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some(d => /autobase/i.test(d))
  if (!hasAutobase) {
    // No Autobase ships, so the document may only mention it as history (superseded /
    // "there is no Autobase"), never as architecture or plan. The diagram and the
    // milestone line are where it actually went stale.
    assert.doesNotMatch(claude, /Autobase (ledger|writer)/,
      'the architecture diagram claims an Autobase component that does not exist')
    assert.match(claude, /host-as-hub/i, 'the design that replaced it should be named')
    assert.ok(fs.existsSync(path.join(root, 'host', 'state.js')), 'host/state.js is the host-as-hub store CLAUDE.md points at')
  }
})

test('the committed-native-trees claim is true in .gitignore, both directions', () => {
  // CLAUDE.md: "Both android/ and ios/ are committed ... .gitignore has no entry for
  // either". The suite default is the opposite, so this repo's exception has to stay
  // written down AND stay true - ios/ being half-tracked is how a rejected upload's
  // cause stayed invisible until 2026-08-18.
  assert.match(claude, /`android\/` and `ios\/` are \*\*committed\*\*/)
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
  assert.ok(!/^\/?android\/?\s*$/m.test(ignore), '.gitignore ignores android/ while CLAUDE.md says it is committed')
  assert.ok(!/^\/?ios\/?\s*$/m.test(ignore), '.gitignore ignores ios/ while CLAUDE.md says it is committed')
  assert.ok(fs.existsSync(path.join(root, 'android', 'app', 'build.gradle')))
  assert.ok(fs.existsSync(path.join(root, 'ios', 'PearTune', 'Info.plist')))
})

test('the licensing rule is kept: no holesail packages anywhere in the manifest', () => {
  // CLAUDE.md bans them by name - AGPL/GPL would drag copyleft across the MIT app.
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies })
  for (const banned of ['holesail', 'holesail-server', 'holesail-client', '@holesail/invite', '@holesail/protocol']) {
    assert.ok(!deps.includes(banned), `${banned} is a dependency, and CLAUDE.md's licensing note forbids it`)
  }
})

test('the canonical verify gate CLAUDE.md names actually exists', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.match(claude, /npm run verify/)
  assert.ok(pkg.scripts && pkg.scripts.verify, 'package.json has no verify script')
})

test('the paths CLAUDE.md sends a reader to are really there', () => {
  // A tour of a tree that has moved on is the same failure in a smaller way.
  for (const rel of [
    'proposals/2026-07-13-wire-protocol.md',
    'plugins/webview-recovery-source.js',
    'test/prebuild.test.js',
    'test/ios-version.test.js',
    'host/state.js',
    'src/ui',
    'worklet'
  ]) {
    assert.ok(claude.includes(rel) || claude.includes(rel.split('/').pop()), `CLAUDE.md should mention ${rel}`)
    assert.ok(fs.existsSync(path.join(root, rel)), `${rel} is named in CLAUDE.md and is not in the tree`)
  }
})

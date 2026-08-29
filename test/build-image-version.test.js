// build-image.sh must refuse to sync a store listing whose version is not GREATER than
// the live one, because umbrelOS offers an update only on a greater `version:`.
//
// The old check caught EQUAL only. Host-only releases bumped the store listing by hand to
// 1.0.4 and then 1.0.5 while app.json stayed at 1.0.3, so the next app release (1.0.4)
// would have synced a listing BELOW the live one, and the warning would have stayed silent
// because 1.0.4 != 1.0.5. Found 2026-08-21, fixed 2026-08-29.
//
// The script builds and pushes a container, so it cannot run here. The comparison is a
// function of its own, `_ver_gt`; this test lifts that function's text out of the script
// and runs it in bash, so the thing under test is the shipped code, not a copy.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'host', 'build-image.sh'), 'utf8')

function fnText () {
  const m = SCRIPT.match(/\n_ver_gt\(\) \{[\s\S]*?\n\}\n/)
  assert.ok(m, 'build-image.sh no longer defines _ver_gt - has the check been rewritten?')
  return m[0]
}

function gt (a, b) {
  const r = spawnSync('bash', ['-c', `${fnText()}\n_ver_gt "$1" "$2"`, '_', a, b])
  return r.status === 0
}

test('a greater listing version is accepted', () => {
  assert.equal(gt('1.0.6', '1.0.5'), true)
  assert.equal(gt('1.1.0', '1.0.9'), true)
  assert.equal(gt('1.0.10', '1.0.9'), true, 'numeric, not lexical: 1.0.10 is above 1.0.9')
  assert.equal(gt('2.0.0', '1.9.9'), true)
})

test('an equal listing version is refused (ships to nobody)', () => {
  assert.equal(gt('1.0.5', '1.0.5'), false)
})

test('THE 2026-08-21 CASE: an app version behind the live listing is refused', () => {
  assert.equal(gt('1.0.4', '1.0.5'), false)
  assert.equal(gt('1.0.3', '1.0.5'), false)
  assert.equal(gt('1.0.9', '1.0.10'), false)
})

test('the script uses the function as a hard stop, not a warning', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf('_ver_gt "$APP_VER" "$PREV_STORE_VER"'))
  assert.ok(block.length > 0, 'the store sync no longer compares APP_VER against PREV_STORE_VER')
  assert.ok(/\n\s*exit 1\s*$/.test(block.slice(0, block.indexOf('\n  fi\n'))), 'a listing that is not greater must exit 1')
})

test('the source manifest is not below the live store it syncs to', () => {
  // The literal in umbrel/umbrel-app.yml is overwritten by the stamp, but a value below the
  // live store is how the drift hid for a month: anyone reading the file believed it.
  const yml = fs.readFileSync(path.join(__dirname, '..', 'umbrel', 'umbrel-app.yml'), 'utf8')
  const v = yml.match(/^version: "([^"]+)"/m)[1]
  assert.equal(gt(v, '1.0.4'), true, `umbrel/umbrel-app.yml says ${v}, below the live store's 1.0.5`)
})

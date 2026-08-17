// The Umbrel compose file vs umbreld's compose patcher.
//
// umbreld patches an app's compose on install AND update, and its patcher calls
// .replace() on every volume entry - so a long-form (object) volume crashes both
// with "volume?.replace is not a function". That is exactly how store listing
// 1.0.4 wedged mid-update at 1% with the container already removed (2026-08-17):
// the update dies half-done and umbreld leaves the app in "updating" forever.
//
// So for umbrel/docker-compose.yml, short-syntax strings are a hard rule. rslave
// propagation for the external-drive mount rides in the short-form mode flags.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const FILE = path.join(__dirname, '..', 'umbrel', 'docker-compose.yml')

// No YAML dep in the host tree; the shape we must pin is narrow enough for a
// line-level check: every entry of the volumes: list must be "- <string>", and
// long-form keys must not appear anywhere.
test('every volume in the Umbrel compose is a SHORT-syntax string (umbreld patcher requirement)', () => {
  const text = fs.readFileSync(FILE, 'utf8')

  for (const key of ['type: bind', 'source:', 'target:', 'propagation:']) {
    assert.ok(!text.includes(key), `long-form volume key "${key}" found - umbreld's patcher crashes on object volumes`)
  }

  // And the external-drive mount is present, with the propagation flag that makes
  // a drive plugged in after start appear inside the running container.
  assert.ok(
    text.includes('${UMBREL_ROOT}/external:/external:ro,rslave'),
    'the external-drive mount must stay short-syntax with ro,rslave'
  )
})

// Writing Home Assistant's config for the operator (opt-in).
//
// This is the ONE place PearTune writes a file outside its own data directory, so the tests
// here are about refusing to: a path that is not a Home Assistant config folder, a path that
// does not exist, one it cannot write. Getting this wrong means scattering YAML into
// somebody's filesystem.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { canWriteHaConfig } = require('../host/speakers')

function haDir () {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-ha-'))
  fs.writeFileSync(path.join(d, 'configuration.yaml'), 'default_config:\n')
  return d
}

test('an empty path is "off", not an error', () => {
  const r = canWriteHaConfig('')
  assert.equal(r.ok, false)
  assert.equal(r.why, null, 'not opted in is not a problem to report')
})

test('a real Home Assistant config folder is accepted', () => {
  assert.equal(canWriteHaConfig(haDir()).ok, true)
})

test('a folder with no configuration.yaml is REFUSED', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-notha-'))
  const r = canWriteHaConfig(d)
  assert.equal(r.ok, false)
  // The whole point: prove it is Home Assistant's before writing into it.
  assert.match(r.why, /not a Home Assistant config folder/)
})

test('a path that does not exist is refused, with a reason', () => {
  const r = canWriteHaConfig('/definitely/not/here/at/all')
  assert.equal(r.ok, false)
  assert.match(r.why, /does not exist|cannot see/)
})

test('PEARTUNE_HA_CONFIG pre-fills the path, and a typed one still wins', () => {
  const { Speakers } = require('../host/speakers')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-data-'))
  const envDir = haDir()

  process.env.PEARTUNE_HA_CONFIG = envDir
  const s = new Speakers({ dataDir: dir })
  // How the Umbrel listing hands over /ha-config without anyone typing it.
  assert.equal(s.haConfigDir, envDir)

  const typed = haDir()
  s.save({ haConfigDir: typed })
  assert.equal(s.haConfigDir, typed, 'what the operator typed beats the platform default')
  delete process.env.PEARTUNE_HA_CONFIG
})

test('with no env and nothing typed, it is simply off', () => {
  const { Speakers } = require('../host/speakers')
  delete process.env.PEARTUNE_HA_CONFIG
  const s = new Speakers({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-data-')) })
  assert.equal(s.haConfigDir, '')
  assert.equal(s.publicConfig().haConfigWritable, false)
})

test('a file rather than a folder is refused', () => {
  const d = haDir()
  const r = canWriteHaConfig(path.join(d, 'configuration.yaml'))
  assert.equal(r.ok, false)
  assert.match(r.why, /not a folder/)
})

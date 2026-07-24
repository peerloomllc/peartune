'use strict'

// The first-run wizard opens on needsSetup() alone, so that rule is the one part of
// the dashboard worth a unit test: get it wrong in one direction and an operator who
// has been running for a year gets a setup wizard, in the other and the fresh install
// this exists for never sees it.

const test = require('node:test')
const assert = require('node:assert')

const load = () => import('../host/ui/app/setup.js')

const state = (over = {}) => ({
  stats: { tracks: 0 },
  devices: [],
  source: { active: 'folder', from: 'default', kinds: {} },
  passwordSource: 'generated',
  ...over
})

test('a fresh host - no devices, no chosen source - needs setup', async () => {
  const { needsSetup } = await load()
  assert.strictEqual(needsSetup(state()), true)
})

test('a host with a paired device does not, even with a default source', async () => {
  const { needsSetup } = await load()
  assert.strictEqual(needsSetup(state({ devices: [{ deviceKey: 'a' }] })), false)
})

test('a REVOKED device still counts as configured (it was set up once)', async () => {
  const { needsSetup } = await load()
  assert.strictEqual(needsSetup(state({ devices: [{ deviceKey: 'a', revokedAt: 1 }] })), false)
})

test('an operator-chosen source does not, even with no devices', async () => {
  const { needsSetup } = await load()
  assert.strictEqual(needsSetup(state({ source: { active: 'subsonic', from: 'dashboard' } })), false)
})

test('an env-configured source still needs setup - nobody has paired yet', async () => {
  const { needsSetup } = await load()
  assert.strictEqual(needsSetup(state({ source: { active: 'subsonic', from: 'env' } })), true)
})

test('no state at all is not a fresh host - it is a dashboard that has not loaded', async () => {
  const { needsSetup } = await load()
  assert.strictEqual(needsSetup(null), false)
  assert.strictEqual(needsSetup({}), false)
})

test('the password step is dropped when the password is not ours to change', async () => {
  const { setupSteps } = await load()
  assert.deepStrictEqual(setupSteps(state({ passwordSource: 'generated' })),
    ['welcome', 'name', 'source', 'password', 'pair', 'done'])
  assert.deepStrictEqual(setupSteps(state({ passwordSource: 'file' })),
    ['welcome', 'name', 'source', 'password', 'pair', 'done'])
  // PEARTUNE_PASSWORD owns it, or there is no gate at all (loopback).
  assert.deepStrictEqual(setupSteps(state({ passwordSource: 'explicit' })),
    ['welcome', 'name', 'source', 'pair', 'done'])
  assert.deepStrictEqual(setupSteps(state({ passwordSource: 'none' })),
    ['welcome', 'name', 'source', 'pair', 'done'])
})

test('dismissal degrades to "not dismissed" with no localStorage (SSR / a test runner)', async () => {
  const { setupDismissed, dismissSetup, undismissSetup } = await load()
  assert.strictEqual(setupDismissed(), false)
  assert.doesNotThrow(() => { dismissSetup(); undismissSetup() })
})

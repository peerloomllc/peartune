'use strict'

// Whether the dashboard SHOWS the "a new PearTune is out" banner. The host half is
// tested in update-check.test.js; this is the last gate in front of the operator's
// eyes, and every one of its interesting cases is a case where it must stay quiet.

const test = require('node:test')
const assert = require('node:assert')

const load = () => import('../host/ui/app/update.js')

test('the banner shows only for a real, undismissed release', async () => {
  const { shouldShowUpdate } = await load()
  const info = { available: true, latest: '1.1.0', current: '1.0.0', htmlUrl: 'https://x/y' }
  assert.equal(shouldShowUpdate(info, null), true)
  assert.equal(shouldShowUpdate(info, '1.1.0'), false, 'already waved away')
})

test('a dismissal is per version, so the NEXT release still speaks up', async () => {
  const { shouldShowUpdate } = await load()
  // The failure this guards: one dismissal becoming a permanent mute, which turns a
  // notifier into a thing that never notifies again.
  assert.equal(shouldShowUpdate({ available: true, latest: '1.2.0' }, '1.1.0'), true)
})

test('nothing uncertain ever renders a banner', async () => {
  const { shouldShowUpdate } = await load()
  assert.equal(shouldShowUpdate(null), false, 'before the first /api/update answers')
  assert.equal(shouldShowUpdate({ disabled: true, current: '1.0.0' }), false, 'a container install')
  assert.equal(shouldShowUpdate({ available: false, current: '1.0.0' }), false, 'up to date')
  assert.equal(shouldShowUpdate({ error: 'github 403', available: false }), false, 'GitHub down')
  assert.equal(shouldShowUpdate({ available: true }), false, 'available but no version to name')
})

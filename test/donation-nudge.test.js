'use strict'

// The two-week donation nudge fires on shouldShowNudge() alone, so that timing rule
// is the part worth pinning: fire it early and it nags a day-one user; miss the
// gate and it never shows; forget the iOS guard and it dead-ends against a hidden
// donation surface (and risks an App Store rejection).

const test = require('node:test')
const assert = require('node:assert')

const load = () => import('../src/ui/donation.js')

const DAY = 24 * 60 * 60 * 1000
const now = 1_800_000_000_000 // a fixed "now"; the rule is relative, so the value is arbitrary
const base = (over = {}) => ({
  settings: { firstRunAt: now - 20 * DAY, donationNudgeShown: false, ...(over.settings || {}) },
  host: { hostKey: 'h' },
  ios: false,
  now,
  ...over
})

test('fires once first run is at least two weeks old', async () => {
  const { shouldShowNudge } = await load()
  assert.strictEqual(shouldShowNudge(base()), true)
})

test('does NOT fire before two weeks', async () => {
  const { shouldShowNudge } = await load()
  assert.strictEqual(shouldShowNudge(base({ settings: { firstRunAt: now - 10 * DAY } })), false)
})

test('the boundary is inclusive at exactly two weeks', async () => {
  const { shouldShowNudge, NUDGE_AFTER_MS } = await load()
  assert.strictEqual(shouldShowNudge(base({ settings: { firstRunAt: now - NUDGE_AFTER_MS } })), true)
  assert.strictEqual(shouldShowNudge(base({ settings: { firstRunAt: now - NUDGE_AFTER_MS + 1 } })), false)
})

test('never fires on iOS (App Store forbids external donation links)', async () => {
  const { shouldShowNudge } = await load()
  assert.strictEqual(shouldShowNudge(base({ ios: true })), false)
})

test('never fires twice - donationNudgeShown gates it', async () => {
  const { shouldShowNudge } = await load()
  assert.strictEqual(shouldShowNudge(base({ settings: { firstRunAt: now - 20 * DAY, donationNudgeShown: true } })), false)
})

test('never fires with no host paired - it would land on the pairing wall', async () => {
  const { shouldShowNudge } = await load()
  assert.strictEqual(shouldShowNudge(base({ host: null })), false)
})

test('a missing or zero firstRunAt never fires (no anchor = not a real install age)', async () => {
  const { shouldShowNudge } = await load()
  assert.strictEqual(shouldShowNudge(base({ settings: { firstRunAt: 0 } })), false)
  assert.strictEqual(shouldShowNudge(base({ settings: {} })), false)
})

test('missing settings entirely does not throw', async () => {
  const { shouldShowNudge } = await load()
  assert.strictEqual(shouldShowNudge({ settings: null, host: { hostKey: 'h' }, ios: false, now }), false)
})

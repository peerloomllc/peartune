// The media notification only exists if the app asks for POST_NOTIFICATIONS.
//
// Android 13 made it a runtime permission. PearTune never requested it, so the
// now-playing card expo-audio builds for the foreground service was never shown:
// no play/pause, no skip, nothing to tap. Reported 2026-09-18 as issue #438 by a
// user on a Pixel. Two halves, and both are guarded here: the permission is
// declared in the manifest, and the shell actually asks for it.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const { shouldAskForNotifications, POST_NOTIFICATIONS_SDK } = require('../app/notify-permission')

const PERM = 'android.permission.POST_NOTIFICATIONS'

test('Android 13 and up gets the ask', () => {
  assert.equal(shouldAskForNotifications({
    os: 'android', apiLevel: POST_NOTIFICATIONS_SDK, asked: false, permission: PERM
  }), true)
  assert.equal(shouldAskForNotifications({
    os: 'android', apiLevel: 36, asked: false, permission: PERM
  }), true)
})

test('below 13 there is nothing to ask - the permission is granted at install', () => {
  assert.equal(shouldAskForNotifications({
    os: 'android', apiLevel: 32, asked: false, permission: PERM
  }), false)
})

test('one dialog per launch, and none on iOS', () => {
  assert.equal(shouldAskForNotifications({
    os: 'android', apiLevel: 35, asked: true, permission: PERM
  }), false)
  assert.equal(shouldAskForNotifications({
    os: 'ios', apiLevel: 18, asked: false, permission: PERM
  }), false)
})

test('a React Native without the constant cannot be asked', () => {
  // PermissionsAndroid.request(undefined) throws, which would take the play
  // tap down with it.
  assert.equal(shouldAskForNotifications({
    os: 'android', apiLevel: 35, asked: false, permission: undefined
  }), false)
  assert.equal(shouldAskForNotifications(), false)
})

// --- the declaration half ------------------------------------------------------
//
// app.json is the source and android/ is its committed output (see prebuild.test.js).
// A permission added to one and not the other builds green and ships a phone that
// cannot show the notification, which is the bug this file exists for.

const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
const manifest = fs.readFileSync(
  path.join(ROOT, 'android/app/src/main/AndroidManifest.xml'), 'utf8'
)

test('app.json declares POST_NOTIFICATIONS', () => {
  assert.ok(
    appJson.expo.android.permissions.includes('POST_NOTIFICATIONS'),
    'expo.android.permissions must list POST_NOTIFICATIONS, or the media notification is invisible on Android 13+'
  )
})

test('every permission app.json declares reached the committed manifest', () => {
  for (const p of appJson.expo.android.permissions) {
    const full = p.includes('.') ? p : 'android.permission.' + p
    assert.ok(
      manifest.includes(`android:name="${full}"`),
      `${full} is in app.json but not in the committed AndroidManifest.xml. ` +
      'Run `npx expo prebuild -p android` and commit the result.'
    )
  }
})

test('the shell asks before it builds the notification', () => {
  const shell = fs.readFileSync(path.join(ROOT, 'app/index.tsx'), 'utf8')
  assert.match(shell, /ensureNotificationPermission\s*\(\)/,
    'app/index.tsx no longer calls ensureNotificationPermission')
  const ask = shell.indexOf('await ensureNotificationPermission()')
  const player = shell.indexOf('createAudioPlayer(')
  assert.ok(ask !== -1 && ask < player,
    'the permission ask must run before the player is created, so the first ' +
    'notification post happens after the dialog is answered')
})

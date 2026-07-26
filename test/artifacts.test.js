// The committed build artifacts must agree with the source they are generated from.
//
// Most generated files here are gitignored and rebuilt on the way to the device, so they
// cannot go stale: assets/index.html (the phone's whole WebView UI, CSS inlined) and
// assets/bare-universal.bundle are both in .gitignore, and app/index.tsx `require`s
// index.html, so a build without it fails loudly rather than shipping yesterday's UI.
//
// host/ui/dashboard.html is the exception, and it is deliberate: the host image's Dockerfile
// copies host/ with NO build step (React, esbuild and Phosphor are root devDependencies that
// never enter the image), so the SERVED dashboard is literally the committed HTML string.
// That buys a small image and costs the one silent failure mode this file exists to catch -
// edit host/ui/app/*.jsx, forget `npm run build:dashboard`, and the operator keeps being
// served the OLD dashboard while the source says otherwise. Green build, wrong page: the same
// shape as the drift prebuild.test.js guards on the Android side.
//
// So rebuild it and assert it did not change. On failure the fresh build is left in place, so
// the fix is `git add host/ui/dashboard.html`.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const DASHBOARD = path.join(ROOT, 'host/ui/dashboard.html')

test('the committed host/ui/dashboard.html is what scripts/build-dashboard.mjs produces', () => {
  const committed = fs.readFileSync(DASHBOARD, 'utf8')

  execFileSync(process.execPath, ['scripts/build-dashboard.mjs'], { cwd: ROOT, stdio: 'pipe' })

  const rebuilt = fs.readFileSync(DASHBOARD, 'utf8')
  assert.equal(
    rebuilt,
    committed,
    'host/ui/dashboard.html has drifted from host/ui/app/. The image serves this file verbatim ' +
    '(no build step in the Dockerfile), so a stale copy ships the WRONG dashboard. A fresh build ' +
    'has already been written - run `npm run build:dashboard` and commit the result.'
  )
})

// The dashboard is only served from git because the image has no build step. Anything the
// PHONE ships must stay out of git, so it can never be stale - assert the ignore rules that
// make the guard above the only one needed.
test('the phone-side build outputs stay gitignored, so a stale copy cannot ship', () => {
  const ignored = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
    .split('\n').map((l) => l.trim())

  for (const f of ['assets/index.html', 'assets/app-ui.bundle', 'assets/app-ui.css', 'assets/bare-universal.bundle']) {
    assert.ok(
      ignored.includes(f),
      f + ' is a generated build output and must be gitignored. Tracking it invites a committed ' +
      'copy that disagrees with source (assets/app-ui.css was tracked by oversight until 2026-07-26).'
    )
  }
})

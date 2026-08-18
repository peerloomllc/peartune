// Where the host looks for ffmpeg, and why the answer is not just "PATH".
//
// The desktop installs are the reason this module exists: a user who double-clicked a
// .dmg has no ffmpeg and no reason to get one, so the binary ships inside the app.
// Until 2026-08-18 the host read `PEARTUNE_FFMPEG || 'ffmpeg'`, which meant every
// desktop host transcoded nothing and every unplayable format fell back to raw bytes
// the phone cannot decode - silently, as "paused forever".
//
// The packaged path arithmetic is the fragile part and is pinned below: the binary is
// staged OUTSIDE app.asar (a binary inside an asar cannot be spawned), so resolution
// has to walk out of the archive to reach it. Get that wrong by one level and it
// degrades quietly to PATH, which on a user's Mac means back to silence.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { resolveFfmpeg, candidates, bundleDir, EXE } = require('../host/ffmpeg-bin')

const none = () => false

test('an explicit PEARTUNE_FFMPEG outranks everything, unchecked', () => {
  // Unchecked on purpose: an operator pointing at their own build is trusted, and
  // transcode.js probes whatever it is handed before using it.
  assert.equal(
    resolveFfmpeg({ env: { PEARTUNE_FFMPEG: '/opt/mine/ffmpeg' }, exists: () => true }),
    '/opt/mine/ffmpeg'
  )
  assert.equal(
    resolveFfmpeg({ env: { PEARTUNE_FFMPEG: '/nope/ffmpeg' }, exists: none }),
    '/nope/ffmpeg',
    'not validated here - a bad explicit setting must not silently fall back'
  )
})

test('with nothing bundled and no env, it is PATH', () => {
  assert.equal(resolveFfmpeg({ env: {}, exists: none }), 'ffmpeg',
    'the container image and any machine with its own ffmpeg land here')
})

test('the PACKAGED layout resolves to resources/ffmpeg, outside app.asar', () => {
  // This is the layout that actually ships. electron-builder puts our code at
  // <resources>/app.asar/vendor/host and stages the binary at <resources>/ffmpeg/...
  const hostDir = path.join('/Applications/PearTune.app/Contents/Resources', 'app.asar', 'vendor', 'host')
  const want = path.join('/Applications/PearTune.app/Contents/Resources', 'ffmpeg', bundleDir(), EXE)

  assert.ok(candidates(hostDir).includes(want),
    'the packaged candidate must land in <resources>/ffmpeg - one level out is app.asar, ' +
    'where a binary cannot be spawned, and it would degrade to PATH without a word')
  assert.equal(resolveFfmpeg({ env: {}, dir: hostDir, exists: (p) => p === want }), want)
})

test('the VENDOR layout resolves to desktop/vendor/ffmpeg', () => {
  // The unpackaged tree: desktop/vendor/host is the vendored host, and the binaries
  // sit beside it under desktop/vendor/ffmpeg.
  const hostDir = path.join('/repo/desktop/vendor', 'host')
  const want = path.join('/repo/desktop/vendor', 'ffmpeg', bundleDir(), EXE)

  assert.ok(candidates(hostDir).includes(want))
  assert.equal(resolveFfmpeg({ env: {}, dir: hostDir, exists: (p) => p === want }), want)
})

test('the bundle directory is named for the RUNTIME platform and arch', () => {
  assert.equal(bundleDir(), `${process.platform}-${process.arch}`)
  assert.equal(EXE, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
})

// Cross-file drift guard. The resolver looks for `ffmpeg/<platform>-<arch>`; electron-
// builder decides what that directory is actually called on disk. Those two live in
// different files and nothing else connects them, so a rename in one is a silent
// fallback to PATH in the other - the exact failure this whole change is fixing.
test('electron-builder stages the binaries where the resolver looks for them', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'desktop', 'package.json'), 'utf8'))
  const staged = []
  for (const platform of ['mac', 'win', 'linux']) {
    for (const r of pkg.build?.[platform]?.extraResources || []) {
      if (String(r.to).startsWith('ffmpeg/')) staged.push(r)
    }
  }

  assert.ok(staged.length > 0, 'no ffmpeg extraResources at all - desktop installs would ship none')

  for (const r of staged) {
    assert.equal(r.to, `ffmpeg/${path.basename(r.from)}`,
      `staged "${r.from}" as "${r.to}"; the resolver joins <resources>/ffmpeg/<platform>-<arch>, ` +
      'so the destination must keep the source directory name')
    assert.match(path.basename(r.from), /^(darwin|win32|linux)-(x64|arm64)$/,
      `"${r.from}" is not named <platform>-<arch> the way process.platform/process.arch report them`)
    assert.equal(path.dirname(r.from), 'vendor/ffmpeg',
      'the build script writes desktop/vendor/ffmpeg/<platform>-<arch>')
  }

  // Every platform we ship a desktop installer for needs a binary, or that platform
  // keeps the silent-transcode bug.
  const names = staged.map((r) => path.basename(r.from))
  for (const need of ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64']) {
    assert.ok(names.includes(need), `nothing staged for ${need} - that platform still cannot transcode`)
  }
})

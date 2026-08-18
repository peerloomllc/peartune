// The desktop packaging contract for the bundled ffmpeg.
//
// Three separate things have to line up for a desktop install to be able to transcode,
// they live in three different files, and every one of them fails SILENTLY:
//
//   1. prepack.js must not delete vendor/ffmpeg while re-vendoring vendor/host
//   2. build-mac.sh must actually send vendor/ffmpeg to the Mac that packs the .dmg
//   3. package.json must stage a binary for every desktop platform we ship
//
// Miss any one and electron-builder still succeeds, the installer still installs, and
// the host falls back to a bare `ffmpeg` on PATH that a normal Mac or Windows machine
// does not have. The user sees a track that plays as silence. That is the 2026-08-14
// bug, and it is why these are tests rather than comments.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

// Match CODE, not prose. Every one of these files explains in its own comments exactly
// what it must not do, so a naive search finds the warning rather than the mistake -
// which is how the first cut of this file failed against correct code.
const code = (p) => read(p)
  .split('\n')
  .filter((l) => !/^\s*(#|\/\/)/.test(l))
  .join('\n')

test('prepack wipes only the directories it vendors, never all of vendor/', () => {
  const src = code('desktop/scripts/prepack.js')

  assert.ok(
    !/rmSync\(vendorDir/.test(src),
    'prepack.js wipes vendorDir wholesale again. vendor/ffmpeg is BUILT, not copied, ' +
    'so a blanket wipe deletes it on every build - locally right after building it, and ' +
    'on the Mac between the rsync and the pack.'
  )
  assert.match(
    src, /VENDORED\s*=\s*\[/,
    'prepack.js should wipe a named list of vendored directories'
  )
})

test('the Mac build sends vendor/ffmpeg to the machine that packs the .dmg', () => {
  const src = code('desktop/scripts/build-mac.sh')
  const inc = src.indexOf("--include='desktop/vendor/ffmpeg/***'")
  const exc = src.indexOf("--exclude='desktop/vendor'")

  assert.ok(inc !== -1,
    'build-mac.sh does not include desktop/vendor/ffmpeg in the rsync, so the Mac would ' +
    'pack a .dmg with no ffmpeg in it')
  assert.ok(exc !== -1, 'the desktop/vendor exclude went missing - prepack regenerates the rest')
  assert.ok(inc < exc,
    'the --include must come BEFORE the --exclude: rsync takes the first rule that ' +
    'matches, so an include after the exclude never fires')
})

test('every desktop build refuses to package without the binaries', () => {
  for (const [script, platform] of [
    ['desktop/scripts/build-linux.sh', 'linux'],
    ['desktop/scripts/build-windows.sh', 'win'],
    ['desktop/scripts/build-mac.sh', 'mac']
  ]) {
    const src = code(script)
    assert.match(
      src, new RegExp(`require-binaries\\.js ${platform}\\b`),
      `${script} does not run the ffmpeg guard. electron-builder treats a missing ` +
      'extraResources source as a WARNING, so without the guard the installer ships ' +
      'and simply cannot transcode.'
    )
  }
})

test('the guard runs before electron-builder, not after', () => {
  for (const script of ['desktop/scripts/build-linux.sh', 'desktop/scripts/build-windows.sh']) {
    const src = code(script)
    assert.ok(
      src.indexOf('require-binaries.js') < src.indexOf('electron-builder'),
      `${script} checks after packing, which is too late to stop a bad installer`
    )
  }
})

test('a binary is staged for every desktop platform that ships an installer', () => {
  const pkg = JSON.parse(read('desktop/package.json'))
  const staged = []
  for (const p of ['mac', 'win', 'linux']) {
    for (const r of pkg.build?.[p]?.extraResources || []) {
      if (String(r.to).startsWith('ffmpeg/')) staged.push(path.basename(r.from))
    }
  }
  // Both Mac slices: an arm64-only .dmg on an Intel Mac falls back to PATH and is
  // silent all over again.
  for (const need of ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64']) {
    assert.ok(staged.includes(need), `nothing staged for ${need}`)
  }
})

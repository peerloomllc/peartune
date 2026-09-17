// Every way the host ships has to carry @peerloom/host, which lives in a sibling repo
// (file:../../peerloom-host) and so outside anything a build rooted here sees. Each
// path below failed or could fail SILENTLY without its fix: the image built and
// crash-looped (PearCinema, 2026-08-13), npm ci refused the lock at /app (2026-09-17),
// the Mac packed a stale copy, electron-builder may drop a symlink. These pin the
// fixes so a tidy-up cannot quietly undo one.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

test('every manifest that needs the package points at a directory that is really there', () => {
  for (const [manifest, dir] of [['package.json', '.'], ['host/package.json', 'host'], ['desktop/package.json', 'desktop']]) {
    const spec = JSON.parse(read(manifest)).dependencies['@peerloom/host']
    assert.match(spec || '', /^file:/, `${manifest} depends on @peerloom/host by file:`)
    const target = path.resolve(root, dir, spec.slice('file:'.length))
    assert.ok(fs.existsSync(path.join(target, 'src', 'index.js')), `${manifest}: ${spec} does not resolve to the package`)
  }
})

test('the image build stages the package beside the repo and smoke-tests the image before pinning', () => {
  const sh = read('host/build-image.sh')
  assert.match(sh, /peerloom-host/)
  assert.match(sh, /mktemp -d/, 'builds from a staged context')
  assert.match(sh, /cd "\$REPO"/, 'the repo-relative sed pins run from the repo root')
  const smoke = sh.indexOf('require(\'/app/host/server\')')
  assert.ok(smoke > 0, 'loads the host inside the image')
  assert.ok(smoke < sh.indexOf('podman manifest push'), 'before anything is pushed or pinned')
})

test('the Dockerfile installs one level below /, copies the package for real, and keeps /app', () => {
  const df = read('host/Dockerfile')
  assert.match(df, /COPY peerloom-host\/src\/ \/peerloom-host\/src\//)
  assert.match(df, /cd \/build\/app/, 'npm ci cannot run in /app: the lock\'s ../../ clamps at /')
  assert.match(df, /rm node_modules\/@peerloom\/host/, 'the symlink is replaced')
  assert.match(df, /cp -r \/peerloom-host\/package\.json \/peerloom-host\/src node_modules\/@peerloom\/host\//)
  assert.match(df, /mv node_modules package\.json package-lock\.json \/app\//)
  assert.match(df, /CMD \["node", "\/app\/host\/index\.js"\]/)
})

test('the desktop prepack replaces the package symlink with a real copy', () => {
  const js = read('desktop/scripts/prepack.js')
  assert.match(js, /derefPeerloomHost\(\)/)
  assert.match(js, /node_modules', '@peerloom', 'host'/)
})

test('the Mac desktop build syncs the package every time, with --delete', () => {
  const sh = read('desktop/scripts/build-mac.sh')
  assert.match(sh, /rsync -az --checksum --delete [^\n]*\\\n\s+\.\.\/\.\.\/peerloom-host\/ "\$MAC_HOST:~\/peerloomllc\/peerloom-host\/"/)
})

test('the Mac dev host and the Umbrel dev copy both carry the package', () => {
  assert.match(read('host/redeploy-mac.sh'), /node_modules\/@peerloom\/host/)
  const dev = read('host/deploy/dev-files-to-umbrel.sh')
  assert.match(dev, /peerloom-host\/src/)
  assert.match(dev, /test -f \/app\/node_modules\/@peerloom\/host\/package\.json/, 'refuses an image without the package')
})

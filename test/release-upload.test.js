// The GitHub upload's result files must be readable under `set -e`.
//
// Each parallel upload worker writes "<http code> <speed> <name>" to a .meta file and the
// parent reads them back with `read -r`. `read` returns 1 at end-of-file when the line has
// no trailing newline - it still fills the variables, but under set -e the script dies on the
// spot. That is how the 1.0.6 run (2026-08-29) ended right after "done: PearTune-1.0.6.dmg":
// the release was complete on GitHub and every step after it (Zapstore, Play, App Store,
// the community-store gate, the announcement) silently never ran. Both halves are pinned:
// the writer emits the newline, and the reader tolerates its absence anyway.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'release.sh'), 'utf8')

test('the upload worker writes its result WITH a trailing newline', () => {
  assert.match(SCRIPT, /printf '%s %s\\n' "\$_res" "\$_n" > "\$\{_UPLOAD_DIR\}\/\$\{_slot\}\.meta"/)
})

test('the result reader survives a line with no newline', () => {
  assert.match(SCRIPT, /read -r _code _spd _name < "\$_m" \|\| true/)
})

test('the shape itself: read on a newline-less line exits 1, which set -e turns into a dead run', () => {
  // The reason the guard exists, demonstrated with bash rather than asserted from memory.
  const r = spawnSync('bash', ['-c', 'set -e; f=$(mktemp); printf "201 5.0 x.apk" > "$f"; read -r a b c < "$f"; echo "unreachable"'])
  assert.notEqual(r.status, 0, 'bash must have died on the read')
  assert.doesNotMatch(String(r.stdout), /unreachable/)
  const ok = spawnSync('bash', ['-c', 'set -e; f=$(mktemp); printf "201 5.0 x.apk" > "$f"; read -r a b c < "$f" || true; echo "$a $c"'])
  assert.equal(String(ok.stdout).trim(), '201 x.apk', 'the guarded read still fills the variables')
})

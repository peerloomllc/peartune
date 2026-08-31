// The community app store publishes itself now, and the gate still refuses to call a
// run clean until it did.
//
// Step 13c used to be a gate and nothing else: build-image.sh synced the listing into the
// store clone, the gate failed the release while that clone was dirty, and a human had to
// commit, push, PR and merge. It worked exactly as designed on 1.0.7 (2026-08-31) - and
// the store still served 1.0.6 afterwards, because refusing a run is not the same as
// finishing it. 13c now offers to do the publish, and gained a third trap for the case the
// dirty check cannot see: committed to a branch or an open PR, so the clone is clean while
// origin's default branch - the thing every umbrelOS actually reads - still names the old
// version.
//
// Answering no to the offer must NOT end the run cleanly. That is why the prompt is a bare
// read and not _confirm, which exits 0 on "n".

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const SCRIPT = fs.readFileSync(path.join(ROOT, 'scripts', 'release.sh'), 'utf8')
const BUILD_IMAGE = fs.readFileSync(path.join(ROOT, 'host', 'build-image.sh'), 'utf8')

// The 13c section, from its header to end of file.
const STEP_13C = SCRIPT.slice(SCRIPT.indexOf('# 13c. Community app store'))

test('step 13c is still a numbered step and still the last thing that runs', () => {
  assert.match(SCRIPT, /^# 13c\. Community app store/m)
  assert.ok(STEP_13C.length > 0, '13c header not found')
})

test('13c offers the publish and calls the helper that does it', () => {
  assert.match(SCRIPT, /^_publish_umbrel_store\(\) \{/m, 'helper must be defined')
  assert.match(STEP_13C, /_publish_umbrel_store "\$UMBREL_STORE_DIR" "\$_store_default"/)
  assert.match(STEP_13C, /Publish the community app store listing for \$RELEASE_TAG\? \[y\/N\]/)
})

test('the offer is not _confirm, which would exit 0 on a no', () => {
  // _confirm's "n" branch is `exit 0`. Used here, declining the publish would end the
  // release as a success with the store unpublished - the failure 13c exists to prevent.
  assert.doesNotMatch(STEP_13C, /^\s*_confirm /m, "no _confirm call in 13c")
  assert.match(STEP_13C, /read -rp ".*Publish the community app store listing/)
})

test('the helper branches from the branch the store actually serves', () => {
  // Not the clone's current branch: it has been found sitting on a feature branch, where
  // committing in place publishes nothing.
  assert.match(SCRIPT, /git -C "\$dir" checkout -q -b "\$branch" "origin\/\$base"/)
  assert.match(SCRIPT, /gh pr merge "\$branch" --squash --delete-branch/)
})

test('the publish is skipped, not attempted, without a terminal or gh', () => {
  assert.match(STEP_13C, /\[ -t 0 \] && command -v gh > \/dev\/null 2>&1/)
})

test('trap 3: a clean clone whose bump never reached origin fails the release', () => {
  assert.match(STEP_13C, /git -C "\$UMBREL_STORE_DIR" show "origin\/\$\{_store_default\}:peerloom-peartune\/umbrel-app\.yml"/)
  assert.match(STEP_13C, /\[ "\$_store_live_ver" != "\$APP_VERSION" \]/)
  // Scoped to runs that synced the listing, so a release that never touched the store
  // cannot trip it.
  assert.match(STEP_13C, /\[ "\$_store_local_ver" = "\$APP_VERSION" \]/)
})

test('all three traps exit non-zero rather than warning', () => {
  const incomplete = STEP_13C.match(/RELEASE INCOMPLETE/g) || []
  assert.equal(incomplete.length, 2, 'the dirty trap and the unmerged trap each announce it')
  assert.equal((STEP_13C.match(/^\s+exit 1$/gm) || []).length, 2)
})

test('build-image.sh no longer tells the reader that publishing is manual', () => {
  assert.doesNotMatch(BUILD_IMAGE, /stays manual/)
  assert.match(BUILD_IMAGE, /release\.sh's step 13c/)
})

// --- the helper, actually run -----------------------------------------------------
//
// Extracted and executed against throwaway repos with a fake `gh` on PATH, because the
// assertions above only prove the text says the right thing.

function extractHelper () {
  const start = SCRIPT.indexOf('_publish_umbrel_store() {')
  const end = SCRIPT.indexOf('\n}\n', start)
  assert.ok(start > 0 && end > start, 'could not extract _publish_umbrel_store')
  return SCRIPT.slice(start, end + 3)
}

function scaffold () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peartune-store-'))
  const env = 'GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t'
  spawnSync('bash', ['-c', `set -e
    cd "${dir}"
    git init -q --bare origin.git
    git clone -q origin.git clone
    cd clone
    mkdir -p peerloom-peartune
    printf 'version: "1.0.6"\\n' > peerloom-peartune/umbrel-app.yml
    ${env} git add -A && ${env} git commit -qm seed && git push -q origin HEAD:master
    git branch -q --set-upstream-to=origin/master master 2>/dev/null || true
    printf 'version: "1.0.7"\\n' > peerloom-peartune/umbrel-app.yml`])
  return dir
}

// A stand-in for gh: `pr create` is a no-op, `pr merge` does what merging the PR does,
// which is put the branch on the base the store serves.
function fakeGh (dir, { failMerge = false } = {}) {
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env bash
if [ "$2" = "merge" ]; then
  ${failMerge ? 'exit 1' : 'git push -q origin HEAD:master'}
fi
exit 0
`)
  fs.chmodSync(path.join(bin, 'gh'), 0o755)
  return bin
}

function runHelper (dir, bin) {
  return spawnSync('bash', ['-c', `${extractHelper()}
    export PATH="${bin}:$PATH"
    export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
    _publish_umbrel_store "${dir}/clone" master peartune-1.0.7 "peartune: 1.0.7" "body"`])
}

test('the helper publishes: origin/master ends up serving the new version', () => {
  const dir = scaffold()
  const r = runHelper(dir, fakeGh(dir))
  assert.equal(r.status, 0, `helper failed: ${r.stderr}`)

  const served = spawnSync('git', ['-C', path.join(dir, 'clone'), 'show', 'origin/master:peerloom-peartune/umbrel-app.yml'])
  assert.match(String(served.stdout), /1\.0\.7/, 'the branch the store serves must carry the bump')

  const dirty = spawnSync('git', ['-C', path.join(dir, 'clone'), 'status', '--porcelain'])
  assert.equal(String(dirty.stdout).trim(), '', 'the clone is left clean, so the gate passes')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('a failed merge returns non-zero, so the gate below still fails the release', () => {
  const dir = scaffold()
  const r = runHelper(dir, fakeGh(dir, { failMerge: true }))
  assert.notEqual(r.status, 0, 'a PR that did not merge is not a publish')

  const served = spawnSync('git', ['-C', path.join(dir, 'clone'), 'show', 'origin/master:peerloom-peartune/umbrel-app.yml'])
  assert.match(String(served.stdout), /1\.0\.6/, 'the store keeps serving the old version')

  fs.rmSync(dir, { recursive: true, force: true })
})

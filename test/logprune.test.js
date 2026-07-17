// Pruning RocksDB's rotated info logs (store/db/LOG.old.*). The danger here is deleting the
// wrong thing, so the "never touches data/WAL/current LOG" test carries the weight.

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')

const { pruneRocksLogs } = require('../host/logprune')

async function tmpDir (t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pt-logprune-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  return dir
}

// A file with a deterministic mtime (epoch seconds), so "newest" is not a timing race.
function touch (dir, name, mtimeSec) {
  const p = path.join(dir, name)
  fs.writeFileSync(p, 'x')
  if (mtimeSec !== undefined) fs.utimesSync(p, mtimeSec, mtimeSec)
  return p
}

const oldsIn = dir => fs.readdirSync(dir).filter(n => n.startsWith('LOG.old.')).sort()

test('keeps the N most-recent LOG.old.* and deletes the older ones', async (t) => {
  const dir = await tmpDir(t)
  for (let i = 1; i <= 5; i++) touch(dir, `LOG.old.100000${i}`, 1000 + i) // ascending mtime

  assert.equal(pruneRocksLogs(dir, 3), 2)
  assert.deepEqual(oldsIn(dir), ['LOG.old.1000003', 'LOG.old.1000004', 'LOG.old.1000005'])
})

test('NEVER touches non-LOG.old files (data, WAL, current LOG, manifest, lock)', async (t) => {
  const dir = await tmpDir(t)
  const sacred = ['LOG', '000340.log', '000323.sst', 'MANIFEST-000341', 'CURRENT', 'IDENTITY', 'LOCK', 'OPTIONS-000012']
  for (const n of sacred) touch(dir, n)
  for (let i = 1; i <= 4; i++) touch(dir, `LOG.old.${i}`, 100 + i)

  pruneRocksLogs(dir, 1)
  const names = fs.readdirSync(dir)
  for (const n of sacred) assert.ok(names.includes(n), `${n} must survive`)
  assert.equal(oldsIn(dir).length, 1) // only LOG.old.* was thinned, down to keep=1
})

test('fewer than keep deletes nothing; a missing dir is 0, not a throw', async (t) => {
  const dir = await tmpDir(t)
  touch(dir, 'LOG.old.1', 10)
  touch(dir, 'LOG.old.2', 20)

  assert.equal(pruneRocksLogs(dir, 3), 0)
  assert.equal(oldsIn(dir).length, 2)
  assert.equal(pruneRocksLogs(path.join(dir, 'nope'), 3), 0) // missing dir, no throw
})

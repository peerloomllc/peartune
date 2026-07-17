// Prune RocksDB's own info-log copies.
//
// The host's Corestore is backed by rocksdb-native, and RocksDB writes a human-readable
// info log to `store/db/LOG`, rotating old copies to `LOG.old.<micros>` on every DB reopen
// (i.e. every host restart). By default it keeps ALL of them, forever - pure operational
// logging, NOT data. On a box that had been restarted ~30 times there were ~3.5 MB of
// `LOG.old.*` (see docs/user-state-storage.md); harmless but unbounded.
//
// We cannot cap this the RocksDB way: rocksdb-native's binding.init exposes no
// keep_log_file_num / max_log_file_size option (verified against rocksdb-native's State), and
// Corestore only forwards id/allowBackup/readOnly/wait. So we prune the rotated copies
// ourselves. Because RocksDB rotates only on reopen, pruning once at startup keeps the count
// permanently bounded (a periodic pass is cheap insurance if a future version rotates mid-run).
//
// SAFETY: this only ever matches `LOG.old.*`. It never touches the current `LOG`, the WAL
// (`*.log`, e.g. 000340.log), the SSTs (`*.sst`), `MANIFEST*`, `CURRENT`, `IDENTITY`, `LOCK`,
// or `OPTIONS*` - i.e. it cannot delete any data or anything RocksDB needs to open.

const fs = require('fs')
const path = require('path')

// Delete all but the `keep` most-recent LOG.old.* files in a RocksDB directory. Returns the
// number deleted. Never throws: a missing/unreadable dir or an unlink race is just "0 pruned".
function pruneRocksLogs (dbDir, keep = 3) {
  let names
  try {
    names = fs.readdirSync(dbDir)
  } catch {
    return 0 // no store yet, or unreadable - nothing to prune
  }

  const olds = []
  for (const name of names) {
    if (!name.startsWith('LOG.old.')) continue // the ONLY thing we ever touch
    const file = path.join(dbDir, name)
    let mtimeMs = 0
    try { mtimeMs = fs.statSync(file).mtimeMs } catch { continue }
    olds.push({ file, mtimeMs })
  }

  olds.sort((a, b) => b.mtimeMs - a.mtimeMs) // newest first

  let deleted = 0
  for (const { file } of olds.slice(keep)) {
    try { fs.unlinkSync(file); deleted++ } catch { /* raced with RocksDB; skip */ }
  }
  return deleted
}

module.exports = { pruneRocksLogs }

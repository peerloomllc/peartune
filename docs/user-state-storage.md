# User-state storage: design, footprint & host burden

**Status:** measured 2026-07-17 on Tim's Umbrel (N100/16 GB) after ~4 days of real
multi-device testing.
**Question this answers:** "Where does the shared user/device state (favorites, playlists,
resume, counts) live, how much disk/RAM does it cost, and will it ever burden the host?"

## TL;DR

- All shared state is a few small JSON rows in a **Hyperbee** on Corestore/Hypercore, stored
  by a **RocksDB** engine. It is host-as-hub (proposal 2026-07-15) — one always-on host is the
  single writer, so there is no CRDT/merge overhead.
- **Measured live data: ~0.7 MB** for *all* favorites + resume + counts + playlists + grants +
  identity across several devices/people. **Host RSS: 59 MB total** (the whole process).
- **RAM does not scale with the data.** RocksDB keeps a bounded working set in memory and
  flushes the rest to disk; Hyperbee reads tree nodes on demand. Adding thousands of favorites
  adds ~0 steady RAM.
- The only thing that generates churn is the resume-position write every ~8 s during playback;
  it overwrites the same keys and RocksDB **compacts** it away, so steady-state disk stays tiny.
- Net: there is no realistic scale (dozens of users, huge libraries) where this store burdens
  the host. You are bound by the music library and streaming limits long before this matters.

## Design

Shared state lives in a **Hyperbee** named `state`, deliberately separate from the `grants`
bee, both in the host's one **Corestore** (`host/server.js`). The store is Corestore 7.11 /
Hypercore 11 over **rocksdb-native 3.17** — on disk that's `~/peartune-data/store/db/` with
RocksDB `.sst` (data), `.log` (WAL), `MANIFEST`, and `LOG*` (debug) files.

Every row is a small JSON value keyed by a **host-derived owner** (`p:{personId}` for a device
assigned to a person, else `d:{deviceKey}`) — never client-asserted, which is what makes
host-as-hub safe. Four row families (`host/state.js`):

| Row | Key | Value | ~size | Row count scales with |
|---|---|---|---|---|
| Favorite | `fav:{owner}:{kind}:{id}` | `{kind,id,on,updatedAt}` | ~120–180 B | # favorited tracks/albums/artists |
| Resume | `resume:{owner}:{trackId}` | `{positionMs,durationMs,updatedAt}` | ~120 B | # *in-progress* tracks (deleted on finish) |
| Play count | `count:{owner}:{trackId}` | `{count,updatedAt}` | ~100 B | # distinct tracks ever played |
| Playlist | `playlist:{owner}:{id}` | `{name,trackIds:[…],…}` | ~40 B + ~30 B/track | # playlists × their length |

Single writer (the host serializes every write and stamps `updatedAt`), so a playlist reorder
or a favorite toggle is just one row rewrite — no conflict resolution, no per-writer accounting.

## Measured footprint (Umbrel, ~4 days multi-device testing)

| | Size | Note |
|---|---|---|
| **Live data (.sst)** | **0.7 MB** | *all* state + grants + identity combined |
| WAL (.log) | 0.3 MB | transient write buffer |
| RocksDB debug logs (`LOG.old.*`) | 3.5 MB | operational logging, prunable (see below) |
| **Total store** | **~4.5 MB** | |
| **Host container RSS** | **59 MB** | the entire process, all subsystems |

**The transient WAL, explained:** the first `du` reading showed the store at **79 MB**, almost
all of it a 71 MB un-compacted WAL. A minute later it had collapsed to the 0.7 MB above. That
71 MB was **write churn, not data** — the resume position is written every ~8 s during playback
(the same few keys overwritten thousands of times over days), and RocksDB compacts all those
overwrites down to just the latest values. A large transient WAL is normal and self-healing.

## RAM: constant, not proportional to data

RocksDB keeps a bounded working set in memory (memtable + block cache) and flushes cold data to
`.sst` on disk; Hyperbee reads B-tree nodes on demand rather than loading the whole tree. So RAM
stays flat as state accumulates. The measured **59 MB** is the *whole* host — Bare runtime,
hypercore/hyperbee, RocksDB buffers, the source adapter's in-memory index of the 1357-track
folder scan, and the dashboard. The user-state store is a small slice of that and does not grow
the process's memory as favorites/playlists pile up.

## Growth over time

- **Live data** scales only with content: a power user with thousands of favorites + a
  fully-played 10k-track library + big playlists lands around **a few MB per person**. Twenty
  such people ≈ tens of MB — trivial next to the music (tens–hundreds of GB).
- **Write volume** (resume every ~8 s) is the churn source, but it overwrites the same keys and
  RocksDB compacts it — steady-state disk stays tiny, at the cost of negligible compaction
  CPU/IO. The underlying Hypercore is append-only, so over *years* of daily listening the raw
  history could reach the low hundreds of MB per heavy listener — still nothing against the
  library, and throttleable (widen the resume interval) if it ever mattered.
- **RocksDB debug logs** (`LOG.old.*`, ~3.5 MB here) are the one thing that accumulates without
  bound by default — pure operational logging, not data. Capping them is a small housekeeping
  item (see TODO / below).

## Housekeeping note: RocksDB info-log pruning

RocksDB rotates its own info log (`LOG` → `LOG.old.<ts>`) and, by default, keeps a large number
of old copies. On this box that's ~3.5 MB of `LOG.old.*` — harmless but unbounded. If
`rocksdb-native`/Corestore exposes RocksDB open options, set `keep_log_file_num` (e.g. 3–5) and
optionally `max_log_file_size` when opening the store; otherwise a periodic prune of
`store/db/LOG.old.*` achieves the same. Tracked in TODO.

## Reproduce it

On the host (or over SSH):

```bash
D=~/peartune-data/store/db
echo "live data (.sst): $(find $D -name '*.sst' -printf '%s\n' | awk '{s+=$1} END{printf "%.1f MB\n", s/1048576}')"
echo "WAL (.log):       $(find $D -name '*.log' -printf '%s\n' | awk '{s+=$1} END{printf "%.1f MB\n", s/1048576}')"
echo "debug LOGs:       $(find $D -name 'LOG*'  -printf '%s\n' | awk '{s+=$1} END{printf "%.1f MB\n", s/1048576}')"
docker stats --no-stream --format '{{.Name}} MEM={{.MemUsage}}' peartune-host   # actual host RAM
```

Note: a large `.log` (WAL) reading is transient — it compacts to the `.sst` size within minutes.
The `.sst` total is the real live-data footprint.

# Mid-song failover to another library that has the same track

**Goal** — when the library you are streaming from goes away mid-song (a revoke, a
host reboot, a dropped link) and ANOTHER paired library holds the same track, keep
the music playing instead of stopping.

**Tier** — **T2.** No wire change, no host change, no persisted field. It earns T2
on the second half only: telling the shell to re-open a track on a different host
is a new IPC event shape. The first half (continuing the same HTTP response from
another host) is invisible to everything above the shim.

---

## Why

Tim, 2026-07-26: *"if the same song exists on more than one library and one host
revokes access, the song should continue playing from a host that has not revoked
access, right?"* Reading the code says he is half-right today:

- **The NEXT track already fails over.** `trackUrl` → `routeTrack` →
  `merge.bestCopy(copies, connectedLibs())` picks a copy on a still-granted host
  the instant the dead library leaves `connectedLibs()`, and queue items carry
  every copy, so it works even after the blend has dropped that library.
- **The CURRENT track does not.** Its URL was already resolved to the dead host
  (`shim.urlForLib`), and the shim tears the response down on a mid-stream error
  (`worklet/shim.js`, "so the player sees a broken stream and stops, rather than
  stalling on a half-written body"). You hear the player's buffer drain, then
  silence, then the next track arrives from the good host.

That was the right behaviour when a phone had exactly one library. With two, it
throws away a copy we can reach.

**This does not weaken revoke.** Host A cut us off and stays cut off - every new
read from A is denied, which is the T3 guarantee and is unchanged. The bytes come
from host B, whose grant is independent and still valid. A friend revoking their
library must not reach into a library you own; that it currently does (by stopping
your music) is the bug.

---

## Scope

### In

**1. Byte-splice, when the copies are identical.** On a mid-stream failure the shim
asks for another copy of the same track on a connected library. If that copy is
byte-identical - same `size` and same `suffix`, both already carried in
`copies[]` - it re-issues `streamTo` against the other host at
`offset + bytesWritten` and keeps writing into the SAME HTTP response. The player
never learns anything happened: same URL, same content-length, same socket.

**2. Re-resolve, when they are not.** The merge deliberately prefers a lossless
primary, so FLAC-on-one-host / MP3-on-the-other is normal and byte offsets do not
line up. The shim cannot restart a player, so the worklet emits `play:rehost` and
the shell re-resolves the track URL for the other copy and seeks to the same
TIMESTAMP. A brief gap, but the music continues.

**3. The cache sink aborts on a splice.** A write-through cache entry must never be
assembled from two sources: equal size is strong evidence, not proof, of equal
bytes, and a corrupt "complete" download is worse than no download.

### Out

- **Any change to revoke, the firewall, or the grant store.** Untouched.
- **Seeking across the splice.** A seek issues a fresh range request, which routes
  normally through `routeTrack` - already correct.
- **Choosing a copy for QUALITY.** This picks the first *reachable* alternative,
  the same order `bestCopy` uses. Preferring a better encode mid-song is a
  different feature.
- **Failing over a cache-hit read.** A cached track needs no host at all.
- **Transcoded streams** (cellular "Auto"). They are length-unknown, non-seekable
  200s with no stable byte offsets, so a splice has nothing to line up. They take
  the re-resolve path.

---

## Compat

Client-only and self-contained: an unmodified host serves both halves, because
both are ordinary reads on a connection we already hold. `play:rehost` is additive;
a shell that ignores it behaves exactly as today (the track stops). Rolling back is
reverting the commit - nothing on disk or on the wire changes shape.

---

## Risks

- **A size collision.** Two different encodes that happen to be the same byte
  length would splice into garbage. Vanishingly unlikely, and the mitigation is to
  compare `suffix` too and to abort the cache write, so the damage is bounded to
  one playback rather than a stored file.
- **Failover storms.** If the alternative host is also unreachable, the second
  `streamTo` fails and we destroy the response exactly as today - one extra
  attempt, not a loop. The alternative must already be in `connectedLibs()`.
- **A revoked library reappearing in copies[].** `connectedLibs()` is live link
  state, so a revoked library is excluded the moment its connection dies. It can
  never be chosen as the alternative.

---

## Verify

- **Gate:** `npm run verify`.
- **Unit:** `worklet/failover.js` (pure) - picks a connected non-failed copy;
  reports `identical` only when size AND suffix match; returns null when the only
  other copy is on a disconnected library; never returns the library that just
  failed.
- **Hardware, the real scenario:** two libraries holding the same album, play a
  track from library A, revoke this device on A mid-song from its dashboard.
  Expect: the music continues, `shim:failover` in the log naming both libraries,
  and every subsequent read denied on A. Then re-pair A.
- **Hardware, the differing-encode case:** same, with a track whose copies differ
  in size - expect `play:rehost`, a short gap, and playback resuming at the same
  position.
- **Regression:** revoke with only ONE library holding the track - the current
  behaviour (buffer drains, playback stops) must be unchanged.

# Transcoded streams should be seekable, and survive a stall

**Goal** - off-LAN playback behaves like on-LAN playback: the scrub bar jumps where you
put it, fast-forward moves forward, and a network wobble in the background is a hiccup
rather than the end of the music.

**Tier** - T2. It adds an optional time-offset to an existing stream parameter set,
changes who recovers from a stalled source (the shell, deliberately) and touches no
grant, identity or revocation path. Wire message shape gains one optional field.

## Why

Tim, playing off LAN on 2026-08-16: song lengths blank (fixed separately, PR #354),
scrubbing resets the song to the beginning, and background playback dies a few seconds
into the next queued song. All three reproduced on an emulator with wifi off and the
fake cellular link throttled to EDGE:

- scrub tap at 50%: position 0:20 -> 0:00
- under throttle: BUFFERING -> ExoPlayer "Source error" (SocketException: Socket
  closed) -> playback ends, position frozen at 0

One root: **off LAN the phone plays a transcode, and a transcode is served as a
non-seekable 200 with no content-length** (`accept-ranges: none`). That was a
deliberate deferral in the 2026-07-14 ffmpeg decision ("the client only asks for a
transcode on cellular, where it also tends not to scrub") - now disproven by use. Two
consequences:

1. **Seek**: ExoPlayer cannot seek a non-seekable progressive source, so a seek
   restarts the load from byte 0. The scrub bar lies, then snaps to 0:00.
2. **Stall death**: ExoPlayer's recovery for a broken source is a ranged re-request
   from the byte it needs. With no ranges, every retry gets a fresh transcode from
   second 0 - bytes it cannot splice - so it errors out and playback stops. Off LAN
   this bites hardest at track transitions (a NEW stream must holepunch + spin up
   ffmpeg while the phone dozes), which is exactly "stops a few seconds into the next
   song". The prefetched prefix is the few seconds.

The .wma work (#351/#352) widens exposure: unplayable formats now transcode on wifi
too, so seek-brokenness is no longer a cellular-only quirk.

## Design

Seek by TIME, not bytes. Bytes of a transcode do not exist until ffmpeg makes them;
time offsets are the one coordinate every layer already understands.

### 1. Wire: `timeOffsetMs` on the existing stream call

`media.stream` gains an optional `timeOffsetMs`, honoured only for transcodes
(`format`/`bitrate` present). Optional field, old hosts ignore it - a phone that sends
it to an old host gets second-0 audio, which is today's behaviour, so mixed versions
degrade gracefully rather than break. No new message, no protocol version bump.

### 2. Host: ffmpeg starts where asked

- **Folder adapter**: `-ss <s>` BEFORE `-i` (input seeking - keyframe-fast, and exact
  enough for audio).
- **Subsonic / Jellyfin adapters**: the upstream server transcodes, but their APIs'
  time-offset support is patchy (Subsonic documents `timeOffset` for video only). So
  the HOST re-transcodes with `-ss` from the upstream ORIGINAL stream - it has ffmpeg
  as of 0.2.45, and the transcode-capacity doc shows a single stream is nowhere near
  the ceiling. Upstream keeps doing what it already did; the host adds the seek.

### 3. Shim: the URL carries the offset

`/t/<id>?t=<ms>` -> shim passes `timeOffsetMs` through. Response stays a non-seekable
200 - the point is not to fake ranges (bytes that do not exist yet must never be
promised), it is to make "start at 1:07" expressible.

### 4. Shell: seek = swap the source, and a stall = retry at position

The shell already owns the player and per-item URLs. For a transcoded item it keeps
`baseOffsetMs`:

- **Seek**: replace the current source with `?t=<target>`, set `baseOffsetMs =
  target`, keep playing. Reported position = `baseOffsetMs + player position` -
  one addition, applied where status is read.
- **Stall/idle recovery**: where the starve watchdog today concludes "end playback",
  a transcoded item first retries ONCE at `baseOffsetMs + position`. A revoked device
  stays revoked: the retry is a fresh stream request, the host's gate denies it, and
  the watchdog's existing deny path ends playback exactly as before. Only the
  network-wobble case changes outcome.

### What this does NOT do

- No ranges on transcodes, real or faked.
- No change to direct-play (original quality) - already seekable, already resumable.
- Cast keeps requiring original quality (documented constraint, unchanged).
- The lock screen's own seek bar for transcodes stays position-only until expo-audio
  exposes a duration hint - the in-app bar is the fix here.

## Slices

1. **Wire + folder + shim** (`timeOffsetMs` end to end, folder only) - provable with
   curl against a local host: request `?t=60000`, get audio that decodes to ~30s for a
   90s track.
2. **Shell seek-by-swap** + position bookkeeping - the scrub bar works off LAN.
3. **Stall retry-at-position** in the starve path - the background death becomes a
   hiccup. Revoke acceptance test MUST still pass (retry denied = stop).
4. **Server sources** (Subsonic/Jellyfin host-side `-ss`) - same behaviour on every
   source.

## Verification

The emulator rig from 2026-08-16 reproduces all of it: wifi off, `emu network speed
edge`, 3-track album on a local folder host. Acceptance:

- scrub to 50% lands at ~45s of 90s (position display agrees, audio continues)
- EDGE throttle + screen off: the queue survives a track transition; no Source error
- revoke mid-song under throttle: playback stops and stays stopped
- `npm run verify` green; new unit tests for the offset math and the retry decision
  (starve.js is already a pure module with tests)

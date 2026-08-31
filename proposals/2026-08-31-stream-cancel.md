# Stream cancel: the requester's way of hanging up

**Goal** - when the player abandons a range request (a scrub, a skip, a track change),
the host stops READING as well as sending, so a transcode dies at the scrub instead of
running to the end of a window nobody will hear.

**Tier** - T2. A new wire message, but strictly appended (cancel = type 6 on
peartune/media/1, after push(5)) with no reply, no auth change and no stored shape:
an old peer that never registered it drops the frame and streams to completion, which
is exactly today's behaviour - old and new peers talk fine in both directions. Ported
from the shared host/client packages (peerloom-host #7, peerloom-client #4), where
PearCinema shipped and verified it.

## What is wrong

The shim pulls audio in 2 MB windows (worklet/shim.js). When the player hangs up
mid-window - every scrub and every skip does this - the shim sets `dead` and drops the
chunks, but the HOST has no idea: it keeps reading the file, keeps transcoding, keeps
sending up to the full window into a connection whose bytes go straight to the floor.
For a transcoded format that is an ffmpeg run serving nobody; on cellular it is paid-for
data nobody hears; and it is bytes a revoked device's buffered socket may still drain.

## The shape, append-only

- `protocol/framing.js` + `protocol/channels.js`: `cancel` carries just the request id,
  registered LAST so every existing type id is unchanged (the same rule push followed).
  No reply, no end frame for a cancelled id; both ends already tolerate frames for ids
  they no longer know, so a cancel racing the stream's natural end is harmless in
  either order.
- Host (`host/media.js`): a `liveStreams` map (id -> { source, cancelled }); on cancel,
  destroy the source - closing a file read, EPIPEing a transcoding ffmpeg so the engine
  slot frees at the scrub - and flag the pipe. A bounded `preCancelled` set (128)
  catches a cancel racing `openStream`, so a stream still opening dies at birth, and a
  peer minting cancels for ids that will never exist cannot grow the set.
- Client (`client/index.js`): stream promises gain `.cancel()`, which sends the frame,
  forgets the pending entry (late chunks for the id are dropped on arrival - already
  today's contract) and RESOLVES with `{ cancelled: true }` rather than rejecting:
  the shim's mid-song failover keys on stream FAILURE, and a player hanging up is the
  opposite of a host dying.
- Shim (`worklet/shim.js`): the hangup handler cancels the in-flight window instead of
  only flagging `dead`, so the host hears about the hangup at once.

## What does NOT ride along

PearCinema paired this with a time-governed player buffer
(`preferredForwardBufferDuration`). That knob is expo-video's; PearTune plays through
expo-audio, which exposes no buffer option, and audio tracks are two orders of
magnitude smaller than films, so ExoPlayer's size-governed audio buffering is not the
memory hazard it was for video. If expo-audio ever grows the knob, it is one line in
the shell; nothing here depends on it.

## Compat and rollback

Old host + new phone: the cancel frame is dropped unread; the window streams to
completion and the phone discards it - today's behaviour. New host + old phone: nothing
sends cancel; the host path without a cancel is byte-for-byte today's. Rollback is a
revert; no migration, nothing stored.

## Verify

Unit/integration over the DHT testnet: a cancelled stream stops delivering chunks and
never emits end or err for that id; the host's live-stream entry is gone and the source
destroyed; a cancel for an unknown id is remembered (bounded) and kills a
just-opening stream at birth; a cancel AFTER natural completion is harmless; an
uncancelled sibling stream on the same channel is unaffected; `.cancel()` resolves with
the marker instead of rejecting so failover does not fire. Emulator: scrub repeatedly
mid-track and watch the host log `media:cancelled` instead of streaming dead windows.

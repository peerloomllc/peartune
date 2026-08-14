# Casting is a mode of the player, not a second player beside it

**Goal** - while a Home Assistant speaker is playing, the player's own controls drive
THAT speaker: play, pause, next, previous, stop, shuffle and repeat all behave the way they
do on the phone, and a track ending moves to the next one.

**Tier** - T2. A new shell IPC message (`castMode`) and two new media methods
(`speaker.pause`, `speaker.resume`). No wire-protocol break and nothing new persisted.

## Why

Phase 1 (PR #317) shipped casting as a thing the app could START but not CONTROL. A UI
review the morning after found five faults, and they are all one fault wearing five hats:
**the app does not know it is casting, so the transport still talks to the phone.**

1. **Tapping play starts the phone playing as well** - two copies of the same song a room
   apart. `castTo` guards this once, at the moment casting begins, and nowhere after.
2. **Next and Previous move the phone's queue** and start audio there while the speaker
   carries on with the old track.
3. **The player's X stops the phone and leaves the speaker playing**, with nothing left in
   the app that would ever stop it.
4. **"This phone" gives you silence.** `castHere()` stops the speaker and never resumes
   local playback.
5. **A stale cast indicator.** `loadSpeakers()` adopts an active cast on reconnect but
   never clears one that ended, so the icon can stay lit over nothing.

Shuffle and repeat are the same fault again. Phase 1 walked the queue with its own integer
cursor (`castIndexRef`), which is a second, worse copy of an ordering ExoPlayer already
owns - so a shuffled queue cast in file order.

**None of this was caught by 815 green tests**, and it could not have been: every one of
these is about WHICH player a button talks to, and the transport lives in the native shell
while the cast lives on the host. Nothing in the suite spans both.

### The insight that makes this small

`app/index.tsx` already delegates ordering to ExoPlayer: `setShuffle()` calls
`px().setShuffle(on)` with the comment that shuffling our own array "would mean re-handing
the playlist to the player, which restarts buffering and breaks gapless". `next()` is
`skipToNext()`. Track changes already announce themselves to the UI as `play:started`,
carrying the track and its index.

So ExoPlayer is ALREADY the single source of truth for queue, order, shuffle and repeat.
We do not need to reimplement any of it for the speaker. We need to stop ExoPlayer making
sound, and send whatever track it lands on to the speaker instead.

## Scope

### The shape

**Cast mode leaves ExoPlayer as the brain and takes away its voice.**

- Entering: mute ExoPlayer and hold it paused. The queue stays loaded, so `skipToNext`,
  `skipToPrevious`, the shuffle order, the repeat mode, queue jumps and the lock-screen
  buttons all keep working exactly as they do today.
- `play:started` becomes the trigger. Whenever ExoPlayer lands on a track, the UI sends
  THAT track to the speaker. Next, Previous, a queue tap and an automatic advance all
  arrive through this one path, so none of them needs its own case.
- `speaker:ended` (already shipped) calls the shell's `next()`, which advances **in
  ExoPlayer's order** - honouring shuffle and repeat without knowing anything about them.
- Leaving: unmute, and resume playback on the phone from the track the speaker was on.

This **deletes** `castIndexRef` and the index-walking in `castTrackAt`, which is finding 5
and the shuffle bug at once. Less code than phase 1 has now.

### Shell (`app/index.tsx`)

- **New IPC `castMode { on }`.** On: `setVolume(0)` and hold `playWhenReady` false. Off:
  restore the previous volume and resume. It is a mode flag, not a queue operation, so it
  never re-hands the playlist and never restarts buffering.
- `next()` / `prev()` / `playIndex()` are untouched. They already do the right thing; they
  simply make no sound while muted.

### App

- `castingTo` gates the transport. `toggle` maps to `speaker.pause` / `speaker.resume`,
  the X maps to stopping the cast, and next/prev keep calling the shell (whose
  `play:started` then carries the new track to the speaker).
- A `play:started` handler sends the track to the speaker while `castingTo` is set. This
  replaces `castTrackAt`.
- `castHere()` resumes on the phone rather than leaving silence.
- `loadSpeakers()` CLEARS `castingTo` when the host reports no active cast, instead of only
  ever setting it.

### Host

- `speaker.pause` and `speaker.resume`, owner-gated and in `MUTATING` like the rest.
  `host/speakers.js` already has `pause()` and `resume()`; they are simply not reachable.

### Not in scope

- A progress bar while casting. ExoPlayer is paused so its position is frozen, and the
  Voice PE reports no position of its own. There is nothing honest to draw.
- Gapless on the speaker. Still impossible: no `MEDIA_ENQUEUE` on either platform.
- Seek while casting. The Voice PE has no `SEEK`.

## Compat

- **Old app, new host.** Never calls `speaker.pause` / `speaker.resume`.
- **New app, old host.** Both return typed `NO_METHOD` and the channel survives
  (`host/media.js` default case). Casting is already feature-detected behind
  `speaker.list`, so an old host means no cast and none of this runs.
- **New app, old shell.** Cannot happen: the shell and the WebView bundle ship in the same
  APK.
- Nothing persisted, so nothing to migrate.

## Verify

1. `npm run verify` green.
2. Unit: the new media methods refuse a non-owner and a readonly grant, same as the rest.
3. **On hardware, casting to the Nabu Casa speaker, the thing the review found:**
   - Play/pause controls the SPEAKER and the phone stays silent.
   - Next and Previous move the speaker, one track per press.
   - The X stops the speaker.
   - "This phone" moves the music back to the phone rather than to silence.
   - **Shuffle on, then next several times: the speaker follows the shuffled order.**
   - **A track played to its end advances by itself** - never yet observed, because the
     phase-1 hardware run cut the track short with a revoke.
4. Revoke still silences the speaker (the phase-1 acceptance test, re-run unchanged).

## Rollback

The mode flag is additive and defaults off; with `castMode` never sent, the shell behaves
exactly as it does today. Reverting the commit restores phase-1 behaviour, which is
functional if flawed. Nothing persisted outlives it.

## Open questions

1. **Does a muted, paused ExoPlayer still buffer the track over P2P?** If it does, casting
   costs data for audio nobody hears, which matters on cellular. Worth measuring; the fix
   (do not prepare the item at all) is more invasive and would be its own change.
2. **What should the lock screen say while casting?** It currently shows the phone as the
   player. Saying "playing on Man Cave" would be honest but the MediaSession is also what
   the hardware buttons drive, and tearing it down mid-session is documented in
   `app/index.tsx` as risking audio focus.
3. **Should the phone resume at the speaker's position when you tap "This phone"?** We do
   not know the speaker's position (the Voice PE reports none), so the proposal restarts
   the track. Restarting is the honest option; ask whether it is the wanted one.

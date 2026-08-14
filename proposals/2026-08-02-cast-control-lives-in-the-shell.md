# Casting should be driven by the shell, not by a WebView that is asleep

**Goal** - a cast keeps working while the phone is locked: next and previous from the lock
screen move the speaker, a finished track advances by itself, and the lock screen and the
host dashboard show what the SPEAKER is doing rather than what the muted phone is doing.

**Tier** - T2. It moves who owns a behaviour across the shell/WebView boundary and adds a
worklet event the shell handles itself. No wire-protocol change, nothing new persisted.

## Why

Four things Tim reported after the last round, all with the phone locked:

1. Next and back "change the song in the player's display, but it doesn't actually change
   songs on the speaker".
2. **"When I unlocked the phone and re-opened the app, it then goes to the next/previous
   song"** - the action completing late, on wake.
3. The lock screen shows the Play button whether or not music is playing.
4. The host dashboard shows "Paused" for the whole cast.

The second is the diagnosis. They are one fault:

**CAST CONTROL LIVES IN THE WEBVIEW, AND THE WEBVIEW IS SUSPENDED EXACTLY WHEN THE LOCK
SCREEN IS IN USE.**

The chain today is: ExoPlayer changes index -> `announce()` -> `play:started` to the WebView
-> the UI's handler calls `speakerPlay`. Every link but the last runs in the shell, which
stays alive under the foreground service. The last one runs in a renderer Android freezes
with the screen. So the message queues, and delivers on wake - which is exactly what Tim saw.

Confirmed independently while reproducing it: a CDP connection to the WebView **dies the
moment the screen sleeps**, and comes back when it wakes. Same suspension, seen from outside.

### My own testing was wrong, and that is the reason to write this down

I verified the previous lock-screen fix by sending media keys with **the app in the
foreground**, which is the one situation a lock screen never occurs in. It passed, and it
told me nothing. Three successive patches to this surface each revealed the previous one was
aimed wrong. **Anything about the lock screen must be tested with the screen off**, and that
belongs in the Verify section below rather than in my memory.

## Scope

### Move the two decisions into the shell

- **Track changes.** `app/index.tsx` already knows the index changed (it is the thing that
  announces it) and already has `call()` into the worklet. While `castMode.current` is set,
  it calls `speakerPlay` itself. The UI's `play:started` handler stops doing so, or every
  change would be sent twice.
- **End of track.** The host pushes `speaker:ended`, which the worklet currently forwards to
  the UI. The shell already intercepts worklet events it needs (`host:disconnected`,
  `play:rehost`), so it handles this one too and calls `next()`. That is the whole of
  auto-advance while locked.

Nothing here needs the WebView, so nothing here stops when the screen does.

### Tell the truth about who is playing

- **The lock screen** currently mirrors the phone's player, which is deliberately muted and
  paused, so it offers Play forever. While casting it should show the speaker's state. How
  far this can go depends on what expo-audio exposes; if the state cannot be overridden, the
  honest fallback is to say so here rather than leave a button that lies.
- **The dashboard** shows "Paused" because `nowplaying.set` reports the phone. While casting
  the phone should report the SPEAKER's state, which it knows.

### Not in scope

- Casting when the app is **killed**, as opposed to backgrounded. The shell dies with it;
  only a host-held queue survives that, which voice already has and the app does not.
- Making the app's cast use the host-held queue. It would fix the killed-app case and is the
  obvious next thought, but it moves shuffle and repeat ownership to the host and deserves
  its own proposal.

## Compat

- Entirely inside the app. No host change, no wire change, no persisted field.
- The `speaker:ended` push already exists; this changes only who acts on it.
- An older shell with a newer UI cannot happen: they ship in the same APK.

## Verify

1. `npm run verify` green.
2. **Every check below with the screen OFF.** This is the point of the proposal, and the
   trap I fell into twice:
   - lock-screen next moves the speaker within a second or two, not on wake
   - lock-screen previous likewise
   - a track playing to its end advances by itself
   - unlocking afterwards causes NO extra jump, which is what "it was queued" looked like
3. Lock screen shows Pause while the speaker plays, Play while it is paused.
4. The dashboard's now-playing shows playing, not Paused, for the duration of a cast.
5. The revoke acceptance test again, screen off: the room goes quiet.

## Rollback

Additive and confined to the shell. Reverting restores today's behaviour, which is a cast
that works while the app is open and stalls while it is not. Nothing persisted outlives it.

## Open questions

1. **Can the lock screen's state be overridden at all** while the underlying player is
   paused, or does honest reporting require keeping the phone's player nominally "playing"
   on a silent loop? The second is uglier and risks the racing behaviour that cast mode's
   silent queue was built to avoid.
2. **Should the shell own casting outright**, rather than the UI starting it and the shell
   continuing it? Split ownership is how this bug happened in the first place.
3. What should the lock screen show as the TITLE while casting - the track, or the track and
   the speaker's name, so it is obvious the sound is coming from elsewhere?

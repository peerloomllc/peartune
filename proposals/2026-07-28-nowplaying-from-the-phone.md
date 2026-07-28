# Now-playing comes from the phone, to the library that owns the track

**Goal** - a library's dashboard can answer "is anyone listening to my music right
now?", truthfully, without depending on which host happens to hold the play
session.

**Tier** - **T2.** One new IPC method (`nowplaying.set`). No persisted field, no
Hyperbee key, no wire-format change. Additive and self-degrading: a host that does
not know the method answers NO_METHOD once and is never asked again.

---

## Why

Now-playing on the dashboard hangs off the play SESSION, and a merged session lives
on ONE elected host (`sessionHomeLib` - the connected host with the smallest
hostKey). Proved on hardware 2026-07-28: the TCL playing, and the Mac's dashboard
showing the track while the Umbrel, the Debian VM and the Windows VM all showed
`null` at the same moment. Adding two libraries earlier that day did not break it;
it changed which host won the election.

The dashboard an operator actually opens is the one for THEIR library. Under the
old rule that dashboard is silent unless their host happened to win an election
they never knew about.

**And the obvious host-side fix does not work.** The first attempt (same day) had
each host report the last track it had SERVED. It is wrong in the worst way: a
phone fetches a track in one request and then plays it for minutes without asking
again, so once playback moves to a track another library serves - or to a cached
one - the previous host goes on reporting its last. Tim saw two dashboards
claiming two different songs, both "now playing". A host sees requests, not
playback. Only the phone knows.

---

## Scope

### In

**1. `nowplaying.set`, phone to host.** `{ trackId, title, artist, playing }`. The
host keeps it in memory against the deviceKey of the connection's own
Noise-authenticated grant, so a device can only ever speak about itself. Nothing
is persisted: it describes this instant.

**2. Sent to exactly ONE host - the owner of the track in hand.** That is the only
library the statement is true of. It rides the existing ~4s queue heartbeat
(`saveQueueState`), so it costs no new timer, and it fires whether or not this
device holds the session token.

**3. Expiry is the stop signal.** The host drops a report older than 20 seconds
(a few missed beats). Stopping, pausing into silence, closing the app, losing the
network - all of them simply stop the refresh, and the row clears itself. There is
no "stopped" message that can go missing. On a track change to a different
library, the phone also sends `{ trackId: null }` to the previous owner so its row
clears at once rather than lingering for the timeout.

**4. The session row still wins where a session exists.** It is the same fact from
the host that holds the queue, and it carries a real play/pause state. The
reported row is marked `reported: true` so the two are distinguishable.

### Out

- **No persistence, and no history.** "Who listened to what" is a different feature
  with a retention policy attached; this is a live indicator and nothing else.
- **Not sent to every connected host.** Only the owner of the current track. A
  library that holds none of what you are playing has no business displaying it.
- **No new timer on the phone.** If the heartbeat is not running, nothing is
  playing worth reporting.

---

## Compat

- **Old host, new phone:** `nowplaying.set` returns NO_METHOD; the phone records
  that library as unsupported and stops asking. Dashboard behaviour there is
  exactly what it is today.
- **New host, old phone:** no reports arrive, the map stays empty, rows read
  `null` - again exactly today's behaviour.
- No stored state on either side, so there is nothing to migrate and nothing to
  roll back but the code.

---

## Risks

**A phone lying about what it plays.** It can only speak about itself (the
deviceKey comes from the connection's grant, not from the payload) and the worst
it can claim is a wrong title on its own row on one dashboard. Strings are capped
at 300 characters. Nothing here grants access to anything.

**Chattiness.** One small request per ~4s while playing, to one host. That is the
same cadence as the existing session heartbeat, which already sends the whole
queue; this is strictly smaller.

**Metadata exposure.** A library learns which of ITS tracks a device is playing.
That is the point of the feature, it is already visible to any operator watching
their own logs, and it does not extend to what you play from anyone else's library.

---

## Verify

Unit / integration:

- a device that reports appears on the owning host's row, marked `reported`
- the row EXPIRES on its own with no stop message
- an explicit `{ trackId: null }` clears it at once
- a host that does not know the method is asked once and then left alone

Hardware, four libraries paired: play a track only the Umbrel has and confirm the
UMBREL's dashboard shows it (this is the case that was silent before); confirm no
OTHER library shows it; skip to a track another library owns and confirm the row
moves rather than appearing in both places; stop, and confirm it clears within
~20s.

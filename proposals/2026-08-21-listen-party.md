# Listening together, in two phases

**Goal** - several people can listen to one library at the same time, first as a shared queue
playing out of one speaker in a room, later as the same track at the same position on each
person's own headphones, without a party ever becoming a way to hear music you were not granted.

**Tier** - T3. New wire methods, a new multi-person trust surface and a second thing revoke has
to kill. The security shape is the reason this is not T2, exactly as with the speaker work.

## Why

Tim asked for it (2026-08-21). The research he asked for is below, and it turned up a
competitive gap worth acting on.

### What everyone else built

Three different features share the name, and they are barely the same product:

- **(a) Synced playback, own headphones.** Spotify Jam, Apple Music SharePlay over FaceTime,
  Jellyfin SyncPlay.
- **(b) Shared queue, one output.** Apple's speaker SharePlay, Subsonic and Navidrome jukebox
  mode, Snapcast, Music Assistant, Sonos.
- **(c) Rooms and DJs.** Turntable.fm (shut 2013, revived), JQBX (bought by Turntable, 2023),
  Stationhead (still shipping). A social product, not a playback feature. Out of scope.

The findings that changed the design:

- **Apple draws our line for us.** Over FaceTime every participant needs their own Apple Music
  subscription. To a HomePod, Apple TV, car or Bluetooth speaker on iOS 18+, participants need
  **no subscription at all**: they scan a QR on the host's screen, the host approves and they
  queue into audio coming out of the host's speaker. Rights follow who receives the bytes. Ours
  is a grant rather than a subscription, but the rule is identical.
- **Jellyfin refuses the shortcut.** Every member of a SyncPlay group must already have access
  to the library, and "SyncPlay user without library access" is a standing feature request they
  have not granted. Access is a per-user permission with three values (create-and-join, join
  only, none).
- **Jellyfin's sync algorithm is copyable and worth copying.** Commands carry a server timestamp
  saying when to act. Time sync is NTP-like: four timestamps per ping, a sliding window of 8,
  taking the measurement with the **lowest round trip** rather than an average. Three pings a
  second apart at the start, then one a minute. Drift under 400ms is corrected by nudging the
  playback **rate** (0.2x to 2.0x, smoothed over about a second); past that it seeks. Their
  transcoding clients still sit roughly 2s behind, which is a direct warning to us.
- **The enemy is Bluetooth, not the network.** SBC adds roughly 150-200ms, classic aptX 100-120ms
  and aptX Low Latency 32-40ms. Two phones on different headphones can sit over 100ms apart with
  a perfect network, and no server can see that offset. Spotify's own users are asking for a
  manual sync-offset slider for precisely this. Any shape (a) work ships that slider on day one.
- **Spotify's rules are the sane defaults.** Join by QR, link or proximity. Guests can play,
  pause, skip, reorder and add, unless the host flips one switch that drops them to add-only.
  The host can remove people, and the party ends for everyone when the host leaves.
- **Plexamp does not have this.** "Listen Together for Music" is a long-running Plex forum
  request explicitly asking for Jam in Plexamp, and Plex went the other way: Watch Together was
  dropped from the new Plex apps in early 2025 and survives only on the web app. The incumbent
  this repo names as the thing to beat has an open, popular, unmet request here.

### Why we are unusually well placed

The queue already lives on the host, and the host already speaks first:

- `host/cast.js` **already holds a queue and advances it itself.** `this.queues` is
  `deviceKey -> { items, index }`, built for voice casts that have no phone behind them, advanced
  on `speaker:ended` by the poller at `host/cast.js:677` onwards. A room party is that queue with
  more than one person allowed to append.
- `host/speakers.js` plus `speaker.play` / `pause` / `resume` / `stop` / `volume` already drive a
  Home Assistant `media_player`, and `stopFor()` already makes the room go quiet on revoke.
- `host/state.js` play-session rows already model a queue with index, shuffle and repeat, one
  `activeDeviceKey`, a compare-and-set on a `generation` and a `session-superseded` push. The CAS
  is already the answer to "two people hit skip at the same moment".
- `host/presence.js` `notify` / `notifyOwner` / `notifyAll` already push to live devices over
  channels the firewall admitted. A party group is one more keyed fan-out.
- `expo-audio` exposes `playbackRate` with pitch correction, so the rate-nudge half of Jellyfin's
  drift correction is available to us and not just the ugly seek.

## Scope

Two phases, and **phase 1 is worth shipping alone**. Phase 2 is a separate decision made after
phase 1 exists.

### Phase 1: the room party (shape b)

A party is bound to **one library and one speaker entity**. The host owns the queue. Members
append to it and see it. Audio never touches a member's phone.

New media methods, all namespaced `party.*`:

- `party.start { entityId, name }` - OWNER only in phase 1, matching the existing `speaker.*`
  gate. Mints `partyId`, seeds the queue from the caller's current queue if asked.
- `party.get { partyId }` - the queue, the index, who is in it, who added each track.
- `party.join { partyId }` / `party.leave { partyId }`
- `party.add { partyId, trackIds }` - appends, tagged with the caller's person id.
- `party.control { partyId, action }` - play, pause, skip, seek, volume. Gated on the party's
  guest-control switch (see below).
- `party.remove { partyId, deviceKey }` and `party.end { partyId }` - starter only.

State lives in new keys, `party:{partyId}`, deleted on end. No migration of any existing row.

Pushes over `presence`, all best effort exactly like the existing ones: `party:changed` (queue or
membership moved), `party:ended`.

**Who may be in one, in phase 1: people who already hold a FULL or OWNER grant on that library.**
No new scope, no new token, no new trust surface. `party.add` and `party.control` join `MUTATING`
in `host/media.js` so a `readonly` grant is refused at the same chokepoint as everything else.

**Phase 1b, deliberately separate: the ungranted guest.** This is the Apple move and it is the
whole charm of the feature in a kitchen, but it is a genuinely new trust surface and it should
not ride along inside phase 1. It would need a `SCOPE.PARTY` grant, minted by the starter for one
party, dying with it, permitted to call `party.*` and `library.search` and **nothing else** - no
`media.stream`, no `art.get`, no `fav.*`. That is a real design with real questions (does search
leak a library listing to someone who was never let in?) and it deserves its own proposal.

### Phase 2: synced playback (shape a)

Only if phase 1 proves people want this at all.

- `party.ping` carrying Jellyfin's four timestamps, the host as the reference clock, sliding
  window of 8, minimum round trip wins. Three pings a second apart on join, then one a minute.
- Every `party.control` reply and `party:changed` push carries a host-clock `when`, so members act
  at a shared instant rather than on arrival.
- Drift correction on the phone: nudge `playbackRate` for drift between 50ms and 3s, seek past
  400ms. Snap on join.
- **A per-device manual offset slider in Settings**, in milliseconds, applied to `when`. This is
  the Bluetooth fix and it is not optional.
- Audio still comes from each member's own connection under their own grant.

### What does not change

Grants, revoke, the firewall, the `media.stream` gate, the protocol string. Nothing about
how audio is gated moves. A party coordinates **what to play and when**, never **who may
fetch**.

## The security shape

The two rules in `CLAUDE.md` decide the design here, so stating it plainly:

1. **A party never grants access.** Every member fetches audio over their own connection under
   their own grant, so revoking a member mid-party cuts them off within a second exactly as
   today, and the rest of the party carries on. Jellyfin has the "let a party member in without
   library access" request open and has not granted it. We refuse it too. The only sanctioned way
   an ungranted person hears anything is phase 1b's room case, where the bytes flow from the
   **starter's** grant to the **starter's** speaker and the guest receives nothing.
2. **Revoke still kills the room.** A speaker is not a HyperDHT connection, which is why
   `host/cast.js` already re-reads the live grant on every audio fetch and calls `stopFor()` on
   revoke. A party queue must be wired into the same two mechanisms, or revoking the person whose
   grant is serving the room leaves the music playing. `party.end` on the starter's revoke, and
   the queue dropped, alongside the existing `this.queues.delete(deviceKey)`.

A third, smaller one: a party tells other people what you are listening to, in an app whose pitch
is that nobody is watching. It is opt-in per party and it should stay obvious that it is on.

## Compat

Same path the session work already uses. A host that does not know `party.*` answers `ENOMETHOD`,
and the app hides the party UI for that library, mirroring `sessionUnsupported` in `src/bare.js`
(`host/media.js` degrades unknown methods rather than dropping the channel, by design). No
protocol string change, so no v2 and no dual-serving. An old app against a new host is unaffected,
because nothing existing changes shape.

## Verify

`npm run verify` green, plus unit tests for: the queue CAS under two simultaneous appends, guest
controls off refusing `party.control`, a `readonly` grant refused at the `MUTATING` gate, and
`party.end` firing on the starter's revoke.

Hardware, on the TCL plus the Umbrel plus the real speaker, because a speaker is the feature:

1. Start a party from one phone, join from a second, both append, the room plays in order.
2. Guest controls off: the second phone can add but cannot skip. Turn it on: it can.
3. **Revoke the second phone mid-party. Within a second its `party.*` calls and its browse are
   denied, and the room keeps playing.**
4. **Revoke the STARTER mid-party. The room goes quiet and the party ends for everyone.**
5. Kill the starter's app (not a revoke). Decide and then verify whatever we chose for a starter
   who simply walks out of range.

Phase 2 adds: two phones, wired headphones on both, measure the gap by ear and by a recording;
then repeat with Bluetooth on one and confirm the offset slider closes it.

## Rollback

Purely additive. Drop the `party.*` cases, delete `party:*` keys, hide the UI. No schema
migration to unwind and no existing row shape touched.

## Open questions

- One library per party, or can it span the merged view? Recommend one library: a blended queue
  can hold tracks living on a host a member has no grant on, and silently skipping them is worse
  than refusing to mix.
- Who may start one? Phase 1 says OWNER, to match `speaker.*`. Is that too tight for a house
  where a partner holds a FULL grant?
- What happens when the starter disconnects? Spotify ends the party. We could hand off instead,
  since the state lives on the host machine and not on the starter's phone.
- Guest control: one switch like Spotify, or per person?
- Party size cap. Off-LAN with 0% punch, every member of a phase 2 party is a separate stream
  through the relay with no fan-out saving, so ten remote listeners is ten times the bandwidth on
  a $4 per 500GB tier.
- Does phase 1b's guest get `library.search`, and is that an acceptable leak?

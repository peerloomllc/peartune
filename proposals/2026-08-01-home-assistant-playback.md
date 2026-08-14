# Play your library on a Home Assistant speaker, driven from the phone

**Goal** - a person can send a track from their PearTune library to a Home Assistant
`media_player` in their house and control it from the app, with no new network surface and
with revoke still cutting them off within a second.

**Tier** - T3. Three reasons, any one of which would be enough: a new outbound control path
from the host to a third-party service, a new HTTP surface serving library audio and a
change to what revoke has to do. Revoke is the reason this cannot be T2 - see Why.

## Why

Tim asked for it (2026-08-01) and has the hardware: Home Assistant runs on his Umbrel and he
owns a Home Assistant Voice Preview Edition speaker ("Man Cave Nabu"). It also fits the
product thesis better than Chromecast does - a speaker in a house someone owns, reached
without a cloud account.

The July casting analysis (TODO.md, "CASTING - scoped 2026-07-26") assumed any cast button
forces `worklet/shim.js` off `127.0.0.1` and turns the PHONE into an unauthenticated LAN
media server. **For the Home Assistant path that is not true**, and the difference is what
makes this feature affordable.

### What was actually measured, 2026-08-01

A spike on the Umbrel served one mp3 from a plain `http.server` **bound to `127.0.0.1`
only** and pushed that URL to the speaker via `POST /api/services/media_player/play_media`.
The speaker played it, audibly, confirmed by Tim.

The request log is the finding: **exactly one fetch, from `127.0.0.1`**. The ESP32 never
touched the URL. HA's ESPHome integration builds a proxy URL
(`async_create_proxy_url` from `esphome/ffmpeg_proxy.py`), fetches the source itself,
transcodes it and hands the DEVICE an HA-hosted URL. `curl` to the Umbrel's LAN address on
the same port failed while loopback returned 200.

Two honest caveats on that spike, because it is easy to over-read:

1. **No PearTune code ran.** It was `http.server` plus `curl`. It proves a fact about Home
   Assistant, not a working integration, and nothing was checking grants.
2. **Co-location did the work.** PearTune's container runs `network_mode: host` and so does
   HA, so on that box they share a loopback interface. That is a property of Tim's
   deployment, not of the feature.

### Why revoke makes this T3

`Connections.kill()` (`host/gate.js:106`) is the entirety of the revoke teeth: it walks
`byDevice` and `conn.destroy()`s the device's HyperDHT connections. **A speaker is not one
of those.** Under this feature the bytes reaching the speaker flow from the host's own
process to HA, on a path with no relationship to the revoked phone's connection.

So without deliberate work, revoking a phone mid-song leaves the music playing in the room.
That is a direct breach of the second of the two rules in `CLAUDE.md`. Designing for it is
not a detail of this proposal, it is the point of it.

## Scope

### Phase 1 requires the host and Home Assistant on the same machine

Because HA is the party that fetches, the audio URL must be reachable **from HA**. When they
share a box that means loopback and nothing is exposed. When they do not, the host would
have to publish a LAN-readable endpoint - the full expensive path, and out of scope here.

Phase 1 therefore **requires a loopback `baseUrl`** and refuses to enable otherwise, with a
dashboard message saying why. Tim chose this scoping (2026-08-01) over doing the general
case up front.

### Host

- **`host/speakers.js`** (new). A thin HA REST client: `list()`, `play()`, `stop()`,
  `setVolume()`, `getState()`. `list()` reads `GET /api/states`, keeps `media_player.*`, and
  returns `{ entityId, name, state, supportedFeatures }`.
- **`speakers.json`** in the data dir, modelled exactly on `source.json`
  (`host/source.js`): `{ version, enabled, baseUrl, token }`, with `token` in the `SECRETS`
  list so it is never sent to the browser and an empty field on save means "leave it alone".
  Absent file = disabled, which is what every existing host has.
- **`host/cast-audio.js`** (new). A dedicated HTTP listener **bound to `127.0.0.1` only**,
  separate from the dashboard. This separation is required, not stylistic: the dashboard
  binds `0.0.0.0` in a container (`PEARTUNE_HTTP_HOST` in the Umbrel compose), so hanging
  audio off it would publish the library to the LAN behind only a dashboard password.
  One route, `GET /a/<token>`, which streams `getAdapter().stream({ trackId })`.
- **Capability tokens**, in memory only, never persisted - a host restart should invalidate
  every cast, and that falls out for free. Each holds
  `{ deviceKey, personId, trackId, entityId, expiresAt }`. **Validated on every fetch, not
  just at mint**, and the check re-reads the live grant:
  - token exists and has not expired,
  - `grants.get(deviceKey)` still returns a grant with no `revokedAt`, and its person is not
    revoked,
  - the grant's scope still permits playback.

  The live re-read is what makes a revoked device fail its NEXT fetch. It is necessary and
  not sufficient - see below.
- **Revoke integration.** Wherever `Connections.kill()` fires today (operator revoke, person
  revoke, the expiry sweep), also: drop every token belonging to that device, AND call
  `media_player.media_stop` on every entity that device currently has playing. **Both.** The
  token check alone only stops the next fetch, and HA plus ffmpeg may already be buffered
  well ahead of the speaker. Stopping the entity is what makes the room go quiet.
- **New media-channel methods**: `speaker.list`, `speaker.play { entityId, trackId }`,
  `speaker.stop { entityId }`, `speaker.volume { entityId, level }`, `speaker.state
  { entityId }`. All derive the acting device from the Noise-authenticated grant, never from
  a parameter, exactly as the existing methods do (`ownerOf(grant)`).
- **Scope gate: `SCOPE.OWNER` only, in phase 1.** Casting makes noise in someone's house.
  A guest or a `readonly` grant streaming to their own headphones is one thing; a guest
  making the kitchen speaker play is another. Added to `MUTATING` as well, so a readonly
  grant is refused at the same chokepoint every other mutating method uses.
- **End of track.** While a cast session is live the host polls `getState()` for that entity
  (~2s) and pushes `speaker:ended` to the controlling device over the existing presence
  channel. The phone then sends the next `speaker.play`. The phone stays the queue.

### App

- A speaker button in the player opens a sheet: "This phone" plus the HA speakers, mirroring
  the existing "Play here" / "Play there" language.
- The phone **remains the active session device** while casting. It is the controller, so
  `session.claim` semantics (`host/media.js:585`) need no change - the speaker is an output
  rather than a peer, and it has no grant of its own.
- Feature-detect: `speaker.list` returning `ERR.NO_METHOD` from an older host hides the
  button. That is the existing degradation contract and needs no version bump.
- A cast session always requests **original quality**. The phone is not carrying the bytes,
  so the "Auto" cellular path (`worklet/shim.js:180-187`, a length-unknown non-seekable 200)
  is both unnecessary and actively harmful here.

### Dashboard

A Speakers panel: enable, base URL, token, "Test connection" and the detected speaker list.
Refuses a non-loopback base URL in phase 1 and says why.

### Not in scope

- **Google Cast / Chromecast.** Its own TODO item at Tim's request (2026-08-01). Cast
  devices fetch the URL themselves, so they need the LAN-readable endpoint and the whole
  expensive bill. Do not fold them back in.
- Host and HA on different machines. Phase 2, and it is the same bill as Cast.
- Seek and a progress bar on the speaker. Not a choice: the Voice PE reports
  `feature_flags: 1200653`, which lacks `SEEK`, `NEXT_TRACK`, `PREVIOUS_TRACK` and
  `MEDIA_ENQUEUE`, and its `media_duration` / `media_position` come back `None`.
- Gapless on the speaker. Impossible for the same reason: no enqueue means no device queue,
  so every track is a fresh `play_media` and that is a gap by construction.
- Auto-discovery of Home Assistant. Operator types the URL.

## Compat

- **Old app, new host.** Nothing changes. The app never calls `speaker.*`.
- **New app, old host.** `speaker.*` hits the `default` case in `dispatch()` and returns a
  typed `NO_METHOD` while the channel survives (`host/media.js:654`). The app hides the
  button. No wire-protocol version bump.
- **On-disk.** One new file, `speakers.json`. Absent means disabled, so every host in the
  wild is unaffected and there is no migration. No change to `source.json`, grants or state.
- **New push kind** `speaker:ended` on the media channel. Unknown push kinds are already
  ignored by clients that do not know them.

## Verify

1. `npm run verify` green. (It takes ~30s; do not wrap it in a short timeout.)
2. Unit tests on the token check, which is the security-load-bearing part: a fetch is refused
   when the token is expired, when the grant is revoked, when the person is revoked, when the
   scope is wrong and when the token belongs to a different device.
3. **Loopback invariant, on the Umbrel:** `curl` the audio port on the box's LAN address and
   get a connection failure, while `127.0.0.1` returns 200 and the speaker plays. This is the
   claim the whole design rests on, so it is a test, not an observation.
4. **The revoke acceptance test, on hardware.** Pair the TCL, cast a track to "Man Cave
   Nabu", confirm it is audible, then revoke the TCL from the dashboard mid-song. Within a
   second: the speaker stops, a re-fetch of the token is denied and browse / next track /
   art all fail. Nothing NEW may be served after the cut.
5. Restart the host mid-cast and confirm every token is invalidated and the speaker stops or
   fails its next fetch.

## Rollback

Additive and off by default. Setting `enabled: false` (or deleting `speakers.json`) returns
the host to current behaviour with no data to migrate back; the audio listener does not bind
when disabled. Reverting the commit removes the methods, and an app that feature-detects
handles their disappearance the same way it handles an old host. Nothing persisted by this
feature outlives it.

## Open questions

1. **`OWNER` only, or `FULL` too?** Proposed as OWNER-only because casting has a
   physical-world effect in someone else's house. Easy to relax later, painful to tighten.
   Tim's call.
2. **Polling vs the HA websocket API** for end-of-track. Polling one entity every 2s is
   simple and needs nothing new; the websocket is instant and cheaper at rest but is a real
   client to write and keep connected.
3. **Two people, one speaker.** Second `speaker.play` presumably just wins. Should the first
   person be told, the way `session-superseded` tells a phone it lost the token?
4. **HA restarts mid-cast.** The entity goes `unavailable`; the host should probably treat it
   as end-of-cast rather than retry forever.
5. **Does a cast session hold the play token?** Proposed no - the phone stays the active
   device. Worth a sanity check against `2026-07-30-one-device-plays`.
6. **Where does `speakers.json` live on a desktop host** relative to the tray app's data dir.

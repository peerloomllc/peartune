# PearTune Decisions

Append-only, newest on top. See Constitution §4.

## 2026-07-14 - The queue is a TAB, and playIndex must not announce
Tier: T2 (native patch + player)
Context: Tim asked for a way to play or queue an album/artist without drilling into
its track list, and then asked whether the queue indicator belonged somewhere more
persistent than the player.
Choice: a fourth navbar tab (Library / Queue / Settings / About) carrying a COUNT
BADGE, plus Play / Shuffle / Add-to-queue on the album and artist screens and on a
long-press of any tile. The mini-player's own queue pill was REMOVED once the tab
existed - two copies of the same number, inches apart, is noise.
Honest caveat, and it is the interesting one: **stopping playback still throws the
queue away.** The queue IS the playlist inside ExoPlayer; there is no persisted
queue that outlives it. So the Queue tab is empty whenever nothing is playing. If
that becomes annoying, the fix is queue PERSISTENCE in the worklet (restore on
launch), not a different place to put the button.

ADD TO QUEUE required a new native method: `addQueueSources` in the expo-audio
patch. It is addMediaSources, NOT setMediaSources - re-handing ExoPlayer the whole
playlist would reset the current item and restart buffering, i.e. interrupt the
song the user is listening to, which is the exact opposite of what "queue this for
later" means. No prepare() either, unless the player is IDLE (the "nothing is
playing, queue an album" case), because prepare() on a live player stutters.
Verified in the dex (`strings | grep QueueSources`) and on the phone: queued an
album mid-song, the track kept playing, the counter went 1 -> 2.

THE BUG THAT COST THE MOST, and it is worth writing down because it looks like it
should work: **playIndex (tap a queued track to jump to it) must NOT call
announce().** setActiveForLockScreen tears the MediaSession down and builds a new
one, and doing that in the same breath as a seek loses the AUDIO FOCUS with it. The
jump appeared to work - the right track loaded, the UI updated - and it landed
PAUSED, silently. The status listener already announces when it sees the index move
(that is how gapless advance updates the lock screen), so the correct code is: seek,
play, and let it notice.

## 2026-07-14 - Navidrome DOES have an all-songs endpoint. The Songs view is back
Tier: T1 (host adapter)
Context: this repo has said since milestone 2 that "Subsonic has no all-songs
endpoint", which is why the flat track list was abandoned (it could only ever show
the first page of albums walked) and albums became the way in. Tim asked for a
Songs view anyway, so I went and asked the actual server.
Finding: **Navidrome (OpenSubsonic) answers `search3` with an EMPTY query as
"everything", and it pages by `songOffset`.** Measured against the real library:
all 1358 songs, and songOffset=1000 returns the expected rows. So a Songs view is
a paged list, not a 60-call album walk. The old claim was true of strict Subsonic
and false of the server we actually target.
Choice: `list({type:'tracks'})` uses the empty-query search3, and FALLS BACK to the
album walk if the server refuses. The fallback matters: an empty first page is
indistinguishable from "not supported", so an empty first page is treated as
unsupported rather than as "this library has no music". Past the first page, empty
means the end - do not re-walk.
What we still do NOT get: sorting. The order is the server's (roughly artist /
album / track). Sort-by-title would mean pulling all 1358 rows into the phone
first, and we are not doing that for a scroll.

## 2026-07-14 - Grid density is ONE control, and 4-up is not on it
Tier: T1 (UI)
Context: Tim proposed a grid/list toggle AND a 2/3/4-per-row picker.
Choice: one control, cycling List -> 2-up -> 3-up. No 4-up.
Why: "grid or list" and "how many per row" are the same axis - density - and
splitting them gives four states to explain and test for one decision. 4-up on a
phone is an ~85px cover, too small to recognise the art, which is the only reason
a grid exists at all; a list serves that density better and shows the full title.
Consequence worth having: the ART SIZE now follows the density (list 120px, 2-up
500px, 3-up 350px). Covers were being fetched at a flat 300px into a ~500px 2-up
tile, so they were already slightly soft, and a 500px cover behind a 52px list row
is bytes crossing a P2P link for nobody. The UI composes the art URL itself (the
worklet hands it a base URL) so changing density does not re-list the library.

## 2026-07-14 - Predictive back is OFF. It breaks the back button
Tier: T1 (Android)
Context: Android 14+ predictive back (`android:enableOnBackInvokedCallback="true"`)
animates a peek of what is behind the app during a back gesture. Expo scaffolds it
as "false"; I turned it on and tested it on the TCL.
Result: **it broke the back button.** With the flag on, the first back press from
the About tab CLOSED THE APP instead of popping back to Library. React Native
0.81's BackHandler is not routed to the platform's new OnBackInvokedCallback here,
so the system takes the press and finishes the Activity - and our entire nav
contract (shell:navState + a 'back' event, with the shell only swallowing the
press when the UI has something to pop) is bypassed.
Choice: reverted. The flag stays "false" until React Native routes the new callback
to BackHandler.
Worth being clear about what we are NOT missing: predictive back could never have
animated OUR screens anyway. PearTune is one Activity hosting a WebView, and the
nav stack (album, artist, sheets) is React state the system knows nothing about.
Animating those needs OnBackAnimationCallback, which RN does not expose. The only
thing the flag buys is a nicer animation when back CLOSES the app - and it charged
a broken back button for it.

## 2026-07-14 - The background disconnect is EXPECTED. Reconnect on demand
Tier: T1 (client behavior)
Context: Tim noticed the app loses its connection to the host about a minute after
going to the background while idle. Measured on the TCL: the host logs
`media:channel-closed` roughly 20 seconds after the app is backgrounded.
Why it happens: Android suspends a backgrounded app that is not holding a
foreground service. It stops sending keepalives, and the link times out. This is
not a PearTune bug and cannot be "fixed" at our layer.
What is NOT broken, and this is the important measurement: **while a queue is
loaded - playing OR PAUSED - the link survives.** The media session keeps the
process alive. Verified: paused with a queue, backgrounded 75 seconds, pressed
PLAY on the media keys, audio resumed over the still-live connection. The case
that actually matters for a music player already works.
Choice: let the idle link die, and reconnect ON DEMAND rather than holding it open.
1. A permanent foreground service WOULD keep the socket alive, and we are not doing
   that: a permanent notification and a battery cost, so an idle app can hold a
   connection nobody is using.
2. `ensureConnected()` in the worklet revives the link for ANY caller that needs
   it, behind a single-flight promise (a screen coming back fires albums + artists
   + a dozen art requests in one tick; they must share one dial, not race).
3. The shell fires `app:active` on resume, so the reconnect starts before the user
   asks. In practice they never see it.
4. The shim's request handler ALSO calls it. That is the path nothing else can
   cover: phone asleep, queue paused, link dead, user presses play on the LOCK
   SCREEN. No UI is awake to help; the loopback request itself has to heal the
   connection.
The trap this exposed: **the shim must survive a reconnect and KEEP ITS PORT.** It
listens on port 0, and the player is holding `http://127.0.0.1:<port>/t/<id>` URLs
for the whole queue. The first version of `reconnect` tore the shim down and built
a new one - a new port - so a paused queue would have resumed into a dead socket.
The shim now takes a replaceable client (`setClient`) instead.
Also: we no longer tell the user their access "may have been revoked" when the
link drops. From the phone, a revoke and an Android suspend look identical, and
that sentence is alarming when the true answer is "you locked your phone". It is
now only said after a reconnect has actually failed.

## 2026-07-14 - Shuffle and repeat are INDEPENDENT, and both may be on
Tier: T1 (UI)
Context: Tim noticed both can be enabled at once on an album and asked whether
that is expected. It is - this is a NOTE, not a bug, and it is written down so
nobody "fixes" it later.
Choice: they stay orthogonal. Confirmed with Tim 2026-07-14.
Why: they answer different questions. Shuffle decides the ORDER; repeat decides
what happens at the END. Every mainstream player (Spotify, Apple Music, YouTube
Music) allows the combination, and shuffle + repeat-all - shuffle the album and
loop it forever - is one of the most common ways people actually listen. Making
them exclusive would also mean fighting the platform: ExoPlayer exposes
`shuffleModeEnabled` and `repeatMode` as two independent properties, so we would
be writing code to take a feature away.
The four states, all coherent:
  shuffle off + repeat off -> album in order, stops at the end
  shuffle on  + repeat off -> album shuffled, stops at the end
  shuffle on  + repeat all -> shuffled, loops forever
  shuffle on  + repeat one -> loops this track; shuffle picks what comes next
                              whenever the listener does skip

## 2026-07-14 - The theme preference lives in the WORKLET, not localStorage
Tier: T1 (local state)
Context: every sibling app (PearPetal, PearList, PearCircle) keeps the theme
preference in the WebView's localStorage and reads it synchronously in main.jsx
before the first paint.
Choice: PearTune keeps it in the worklet, in `settings.json`, next to the device
identity and the paired host. A deliberate deviation from the suite.
Why: it is the only way to get a FLASH-FREE cold start here. The shell boots the
worklet BEFORE it loads the WebView, so it can read the preference, resolve
'system' against `Appearance`, paint its own chrome (status bar + the strip under
the WebView) correctly, and hand the WebView a document that already carries the
right `data-theme`. With localStorage the shell cannot see the preference at all
(it is inside the WebView it has not created yet), which is exactly why PearPetal
needs a separate AsyncStorage cache of the resolved theme to avoid the flash - two
stores for one fact. One store, read once, at the only moment that matters.
Cost: settings are gone if the app's data is cleared - the same wipe that already
takes the device identity and forces a re-pair, so nothing new is at risk.
Verified on the TCL: preference Light, force-stop, relaunch - the FIRST painted
frame (the "Starting…" screen, before the library loads) is already light.

## 2026-07-14 - The navbar stays visible during a drill-down
Tier: T1 (UI)
Context: PearList hides its tab bar when a list is open, treating a drill-down as
a full-screen takeover.
Choice: PearTune keeps the navbar visible inside an album or an artist.
Why: the dock is one fixed object - the player sits ON the navbar. Hiding the
navbar under an album would drop the player ~64px down the screen mid-song, and
raise it again on the way back. A music app's transport does not move.

## 2026-07-14 - Gradle must never cache the JS bundle task
Tier: T1 (build)
Context: PearTune's whole UI is an ASSET (`assets/index.html`, built by esbuild),
not a JS source file - and so is the Bare worklet bundle.
Choice: `outputs.upToDateWhen { false }` on `createBundle*JsAndAssets` in
`android/app/build.gradle`.
Why: gradle's up-to-date check does not notice when only those assets change. It
skips the bundle task, repackages the PREVIOUS bundle, and the APK silently ships
a STALE UI - you rebuild, install, screenshot, and are looking at old code with no
error anywhere. Found the honest way: a CSS fix that would not apply, twice.
Cost: ~30s per debug build. Cheaper than shipping the wrong bundle.

## 2026-07-13 - NOT WebRTC. HyperDHT for transport, loopback HTTP for the player
Tier: T3 (transport)
Context: WebRTC comes up a lot in the Pear/Holepunch space around streaming
media, so: should PearTune use it instead of "HTTP"?
First, a category error worth naming: **the HTTP in PearTune never touches the
network.** The shim runs on 127.0.0.1 between our Bare worklet and Android's
media player - both on the same phone. The phone-to-host transport is already
P2P (HyperDHT + UDX + Noise). So WebRTC would not replace the HTTP; it would
replace HyperDHT.
Choice: keep HyperDHT for transport and the loopback HTTP shim for the player.
Why WebRTC is a downgrade HERE (it is a fine technology, wrong fit):
1. **It reintroduces servers.** WebRTC needs signaling to exchange offers/ICE
   candidates, plus STUN, plus TURN when holepunching fails. TURN is a relay -
   a server you run and pay for, carrying user traffic. "No servers" is the
   whole pitch. Holepunch's DHT does discovery + holepunching with zero infra.
2. **Its media path is the wrong shape.** WebRTC media channels are RTP: built
   for realtime conversation, and they DROP PACKETS to protect latency. Correct
   for a video call, wrong for a FLAC, where we want exact bytes. You would end
   up on DataChannels instead - a reliable ordered byte stream, i.e. exactly
   what UDX already gives us, with more overhead and a signaling dependency.
3. **It would destroy the auth model.** Everything here rests on Noise
   authenticating the far end AS A PUBLIC KEY, which is what lets the host
   allow-list device pubkeys with no bearer token anywhere. WebRTC identity is
   DTLS fingerprints exchanged over whatever signaling you built, so pairing,
   grants and revocation would have to be rebuilt on a weaker foundation.
When WebRTC WOULD be right, and we should revisit then: (a) a BROWSER client -
browsers cannot open raw UDP sockets, so WebRTC is the only P2P transport
available there; (b) genuinely realtime audio (listen-together, broadcast,
calls), which is what RTP is actually for. Neither is v1.
Alternatives to the loopback shim (the real competitor, not WebRTC): a custom
ExoPlayer DataSource in Kotlin reading straight from the worklet - no socket, no
cleartext exemption, less copying. Rejected for now: real native code per
platform plus a Kotlin-to-Bare bridge, to replace a shim that is already proven.
Revisit if on-device profiling shows the HTTP hop actually costs battery or CPU.

## 2026-07-13 - Protomux message order lives in ONE shared file
Tier: T3 (wire format)
Context: Protomux assigns each message a type id by REGISTRATION ORDER - first
`addMessage()` is type 0, next is type 1. Host and client each registered their
own, in different orders (host: `paired` then `deviceHello`; client the reverse).
Both ends decoded every frame as the wrong type. It fails SILENTLY: the frames
arrive, decode into garbage, and the handler you expected simply never fires, so
pairing hung with no error on either side. The media channel had the same latent
mismatch.
Choice: `protocol/channels.js` owns the registration order and both sides build
channels through its factories. Hand-rolling `mux.createChannel` + `addMessage`
for a PearTune channel is now a bug by definition. New message types append to
the END of the list; inserting in the middle silently renumbers the wire.
Consequences: the ordering can no longer drift between host and app, which are
in different runtimes (Node and Bare) and will be updated on different schedules.

## 2026-07-13 - Pairing dials the host by key; there is no rendezvous topic
Tier: T3 (pairing flow - SUPERSEDES §2 of proposal 2026-07-13-wire-protocol)
Context: the proposal copied PearCircle's seeder QR pairing, where phone and host
meet on a Hyperswarm rendezvous topic derived from a one-time `rv`. That did not
survive contact with the code: Hyperswarm creates its OWN HyperDHT server and
listens on its keypair, so a host running both a Hyperswarm (for pairing) and its
own `dht.createServer` (for media) under one identity had two servers fighting
over the same keypair, and deadlocked.
Choice: drop the rendezvous entirely. The QR already carries the host's public
key, so the phone DIALS THE HOST DIRECTLY by key. `rv` survives as a one-time
pairing TOKEN, presented in the hello to prove the device actually saw the QR.
The firewall gains a narrow exemption: while a pairing window is open it admits
an ungranted device, and `_onconnection` then offers it the pair channel ONLY,
never the media API.
Alternatives: give the pairing swarm a separate keypair (then the phone cannot
verify the host against the QR); keep Hyperswarm and drop our own server (loses
the `firewall` hook, which is the entire auth design).
Consequences: STRICTLY STRONGER than what it replaces. Dialing a HyperDHT key
means Noise authenticates the far end AS that key, so an impostor who
photographed the QR cannot answer the call at all. The seeder's "verify the
remote pubkey matches the QR" guard stops being a check we must remember to
write and becomes a property of the transport. Also simpler: no Hyperswarm in
the host at all until the ledger needs one in milestone 3.
Why the seeder differs: there the PHONE held the secrets and the seeder was
anonymous, so a rendezvous was the only way to meet. Here the host has the
stable public identity. Do not cargo-cult the seeder's flow into a third app
without checking which side is anonymous.

## 2026-07-13 - Bitrate adapts to the network, with a user override
Tier: T1 (client policy; the wire already carries the params)
Context: a FLAC library over cellular is roughly 300MB an album and will stutter,
but always transcoding wastes fidelity on the wifi where most listening happens.
Choice: original quality on wifi, capped bitrate on cellular, overridable in
settings. `media.stream` carries `format` / `bitrate`, which the Navidrome
adapter passes straight through to Navidrome's own transcoder.
Alternatives: always-original (burns data), one fixed user setting (wastes
either data or fidelity, since it cannot know the network).
Consequences: free for Navidrome sources. The **folder adapter has no transcoder
to delegate to**, so a raw FLAC library over cellular is the one case that still
costs real data - the client must warn on that combination.

## 2026-07-13 - Revoke is an access control, not a history eraser
Tier: T2 (ledger semantics)
Context: when a device is revoked, do its `count:` play-count rows leave the
ledger with it?
Choice: they stay, and keep contributing to totals. Play history belongs to the
user and should not evaporate because they retired an old phone.
Alternatives: purge on revoke (means removing an Autobase writer, a much bigger
hammer, and it makes revoke irreversibly destructive); purge only for people and
not devices (the ledger would have to know which grants were "you" vs "a guest").
Consequences: a revoked device cannot reach the library, but its historical
contribution to play counts persists. Say so in the revoke UI so it is not a
surprise.

## 2026-07-13 - The host is a full Autobase writer, not a blind seeder
Tier: T3 (trust model)
Context: PearCircle's seeder is deliberately blind - it stores encrypted blocks
it cannot read. Should PearTune's host be the same?
Choice: full writer. It never writes state rows, but it participates in the
ledger so that (a) your resume position is reachable when every phone is off,
and (b) a new device can be admitted as a writer without another phone awake.
Alternatives: blind seeder (cannot admit writers, so pairing a second device
while the first phone is off leaves it stuck read-only); blind seeder plus a
narrow admission side channel (new protocol surface in the most
security-critical part of the design, which is exactly where not to be clever).
Consequences: the host can read listening history. Acceptable: it is a machine
you own that already holds the music in the clear, and listening history is far
less sensitive than the location trail that motivated blind seeding in
PearCircle. This asymmetry is deliberate and must not be cargo-culted back.

## 2026-07-13 - Track ids are source-scoped; a source switch orphans state
Tier: T2 (key derivation)
Context: `trackId = z32(blake2b('peartune/track/1' || libraryId || sourceKey))`,
where sourceKey is the Navidrome id or the library-relative path. So the same
file reached two ways hashes two ways.
Choice: accept it for v1 and warn in the UI **before** a source switch, not
after. A tag-matching remap tool is the escape hatch if it bites.
Alternatives: content-hash the audio (bulletproof, but a full read of a large
FLAC library on a Pi-class Umbrel is slow and disk-punishing); tag-derived ids
(no rescan cost, but they collide on compilations and live albums, and break
when you fix a typo in a tag).
Consequences: switching a library from raw folder to Navidrome loses resume
positions, favorites and play counts. TODO for the remap tool.

## 2026-07-13 - Build our own host on hyperdht; do NOT depend on holesail
Tier: T3 (auth gate + wire protocol)
Context: holesail.io is a P2P TCP/UDP proxy on the same Holepunch stack, and
looked like it might save us the entire host transport.
Choice: build our own host daemon directly on MIT `hyperdht`, using
`dht.createServer({ firewall(remotePublicKey) })` against a host-local
allow-list. Borrow holesail's *shape* (invite encoding, mode header) clean-room,
take none of its code.
Alternatives: depend on / vendor / fork holesail.
Consequences: rejected on two independent grounds, either of which suffices.
(1) **It cannot do what we need.** Its "private" mode admits only a client whose
keypair IS the server's own keypair, derived from a shared seed; its newer
`@holesail/invite` capability is still one bearer token shared by every client.
No per-device identity, and the only revocation is rotating the seed, which
kicks everyone. We require per-device and per-person grant/revoke.
(2) **Licensing.** holesail and `@holesail/*` are AGPL-3.0, holesail-server /
-client are GPL-3.0. The suite is MIT.
The wheel we would be "reinventing" does not exist: what holesail offers is a
shared-password tunnel, and what we need is authorization. Noise already
authenticates every HyperDHT connection, so the host learns the client's real
device pubkey for free and there is no bearer token anywhere in our design.

## 2026-07-13 - Normalized host API, not a raw port tunnel
Tier: T3 (wire protocol)
Context: the cheap path is holesail-style - tunnel Navidrome's port and let the
phone speak HTTP to it.
Choice: the host exposes a normalized `peartune/media/1` API over the
authenticated stream. Two source adapters (Navidrome/Subsonic, raw folder) sit
behind it, and the app cannot tell them apart.
Alternatives: raw port tunnel.
Consequences: a scoped guest never gets handed Navidrome's whole surface and its
credentials; scopes are enforceable per request; and the app never learns to
speak Subsonic, which keeps the raw-folder adapter a first-class citizen instead
of an afterthought. Costs us an API surface we would not otherwise have written.

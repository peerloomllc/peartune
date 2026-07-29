# Relay consent at first relayed playback, per library

## Goal

Ask before PeerLoom's relay carries a library's AUDIO, once per library, instead of
relying on a global default that silently covers both the kilobytes of browsing and
the megabytes of listening.

## Tier

T3. It changes the auth/consent boundary around the one centralized piece of the
system, and it changes what the privacy page and both store listings claim. No wire
change and no host change, but "when does PeerLoom's infrastructure carry your music"
is a security-critical question, not a UI question.

## Context: what the default actually does today

Worth stating precisely, because "relay on by default" sounds worse than it is and
the mechanism matters for where the consent gate belongs.

`protocol/relay.js:relayThroughFor` returns the relay key only when
`(force || randomized) && useRelay && relayKey`. `force` is what Hyperswarm sets
after a `HOLEPUNCH_ABORTED`, so the normal attempt passes no `relayThrough` at all.
It is direct-FIRST, and that is hardware-verified: DECISIONS 2026-07-23 phase 3, Pixel
over cellular, both hosts connected via consistent punches with `random:0` and **the
relay stayed out**. Reproducing the relay path at all needed a throwaway force-relay
build.

So the status quo is not "your music goes through PeerLoom unless you opt out". It is
"if the direct punch fails, fall back rather than die". The live relay has carried
**163 MB total** since deploy (~6 days), against a 500 GB/month tier.

## Why change it anyway

Two reasons, one of which is specific to PearTune and does not apply to any sibling app.

1. **PearTune relays AUDIO.** PearCal relays calendar events, PearCircle location
   pings: kilobytes. A relayed PearTune session is ~100% of the audio bytes, ~144
   MB/hour at 320kbps and ~5x that for FLAC. That is an unbounded cost that scales
   with adoption, and it is PeerLoom's bill.
2. **The current control cannot express the actual decision.** `useRelay` is one
   global switch. "Relay to my own Umbrel" and "relay to a friend's library" are
   different trust decisions, and a user cannot say yes to one and no to the other.

## Why NOT at pairing (the rejected alternative)

The obvious version is: default `useRelay` off, and when a pairing attempt times out,
offer the relay with a link to Settings. Rejected, for two reasons that are not
matters of taste:

- **It gates the cheap moment and misses the expensive one.** A pairing handshake is
  a few KB. A user who pairs at home on wifi (direct, no prompt) and later plays a
  three-hour album on cellular through the relay is never asked, and that is the path
  that costs money.
- **It asks for a decision the user cannot yet make.** The prompt lands in the first
  minute, before anything has worked, and it has to explain carrier NAT to somebody
  who wanted to hear an album. Consent obtained there is worse than a documented
  default, not better.

Note also that off-by-default is not "less private, still works": on a
double-randomized NAT there is no direct path at all, so `useRelay:false` means the
app does not work, full stop. That makes the prompt load-bearing rather than
informational.

## The load-bearing question, resolved against the source

**Can the phone tell WHICH library's connection is riding the relay?** Everything
here depends on it, and the answer is not obvious.

What does not work:

- `dht.stats.relaying` on the phone read **0 while actually relaying** (DECISIONS
  2026-07-23 phase 3). It tracks a different relay role. The relay node's own
  `journalctl` stats were the ground truth.
- The `relayThrough` callback we install is
  `(force, s) => relayThroughFor(...)` (`src/bare.js:1671`). It receives **no peer
  identity**, so we cannot attribute a decision to a library from inside it.
- Correlating by timing is unsafe *here specifically*: Tim runs two hosts (Mac mini
  and Umbrel), so concurrent connects are the normal case, not an edge case.
- `hyperdht` does compute this, but privately. `lib/connect.js:102` holds
  `relaySocket: null` on the internal connection state and
  `lib/connect.js:489` sets `c.connect.relayed`, but `connect()` returns only
  `encryptedSocket` (`lib/connect.js:129`) and Hyperswarm's `connection` event
  surfaces neither. Sniffing `socket.rawStream`'s remote host against the relay
  address would work but depends on an internal with no contract.
  Note `relayed` at `lib/connect.js:225` is `diffAddress(serverAddress, relayAddress)`
  and means something different (address discovery), so it is not the signal either.

**What does work.** `hyperswarm/index.js:210`:

```js
const relayThrough = this._maybeRelayConnection(peerInfo.forceRelaying)
```

Hyperswarm resolves the relay decision **per peer connect, with `peerInfo` in scope**,
then drops it: `_maybeRelayConnection(force)` calls `this.relayThrough(force, this)`
(`index.js:108-109`). So the peer identity exists at exactly the right moment and is
simply not forwarded.

Fix: a one-line patch passing it through, `this.relayThrough(force, this, peerInfo)`,
so our callback becomes `(force, s, peerInfo) => ...` and can record
`peerInfo.publicKey -> "we offered the relay for this peer"`. This repo already uses
patch-package (`patches/expo-audio+1.1.1.patch`, `postinstall: patch-package`), so the
mechanism is established. It is small and generic enough to upstream, and we should
offer it upstream rather than carry it forever.

This records **what we decided**, not what the wire did, which is the honest thing to
gate on: if we handed Hyperswarm the relay key and the connection then succeeded after
a punch abort, the relay is why the user has a connection.

## Scope

Changes:

- `patches/hyperswarm+<v>.patch` - forward `peerInfo` to the `relayThrough` callback.
- `protocol/relay.js` - add a pure `relayAudioAllowed({ relayed, consent })` policy fn
  beside `relayThroughFor`, so the decision is unit-testable away from the transport.
- `src/bare.js` - capture the per-peer relay decision at the `relayThrough` call site
  (`:1671`) and keep it on the per-library connection state. Proposal
  2026-07-26-one-connection-per-library means "is this library relayed" is a single
  well-defined fact per library.
- Media path - before opening `peartune/media/1` for a track, if the library's
  connection is relayed and its consent is not `allow`, do not start: emit an IPC
  event and let the UI ask. Pinned/cached tracks still play (they need no connection).
- Per-library persisted `relayAudio: 'ask' | 'allow' | 'deny'`, default `'ask'`.
  Declining writes `'deny'` and it STAYS (decision 3).
- UI - a two-button prompt (`Stream via relay` / `Not now`) with a
  `Remember for this library` checkbox, NOT a third button (decision 2). Plus a row in
  the library's own settings showing the current state, so a standing `'deny'` is
  findable and reversible rather than an app that mysteriously will not play
  (decision 3). The existing global `useRelay` stays as the master kill switch and
  keeps its meaning: off = never relay anything, current behavior.
- Disclosure, which decision 1 makes part of this change rather than a follow-up:
  `website/peartune/privacy.html` and both store listings must say that a library
  reachable only via the relay has its BROWSING metadata cross the relay too, not just
  its audio. Shipping the code without this would make the privacy page inaccurate.

Does NOT change:

- The wire protocol, the host, the grant model, revoke semantics.
- `relayThroughFor`'s direct-first behavior, or the global toggle's default.
- Browse, search and artwork over the relay: allowed without a prompt (decision 1).

## Compat

Phone-side only, so nothing an old peer does changes. The host never knew whether a
connection was relayed (blind-relay phase 1 finding: the host needs no code change)
and still does not.

- Existing installs: `useRelay` stays `true`; the new per-library `relayAudio` defaults
  to `'ask'`. A user on a 0%-punch network sees one prompt per library, once.
- Downgrade: an older build ignores the unknown per-library field and behaves as it
  does today. No migration, additive field.
- The patch is a build-time dependency change; a build without it must fail loudly
  rather than silently treat every library as non-relayed. A test asserts the callback
  receives a third argument.

## Verify

Unit:

- `test/relay-policy.test.js` - extend for `relayAudioAllowed`: allow/deny/ask x
  relayed/direct, plus master-switch-off short-circuits everything. Per decision 1,
  also assert a NON-audio request over a relayed connection is allowed with consent
  still `'ask'` - that is the case a later "tighten it up" refactor would silently
  break.
- A test asserting the patched `relayThrough` callback is invoked with a `peerInfo`
  carrying a `publicKey`. This is the guard that fails loudly if a hyperswarm bump
  drops the patch.

Hardware, and this is the part that cannot be faked. A normal build on cellular
punches directly and never relays, so reproducing the gate needs the same method
phase 3 used: a **throwaway force-relay build** (`relayThroughFor` returns the key
always, reverted after), Pixel over cellular, both hosts.

1. Decline the prompt: no audio starts, and the relay node's `bytes.relayed` does not
   move for that library.
2. Accept: audio plays and the relay node's `sessions/streams/bytes` climb.
3. Re-enter the library: no second prompt.
4. A pinned album still plays with the prompt declined.

Two traps to respect, both already paid for:

- **The relay node's `journalctl` stats are ground truth, not the phone's counters.**
  The phone's `dht.stats.relaying` reads 0 while relaying.
- **A flat byte counter means nothing until the sampling window has elapsed.** Read it
  twice, spaced, before concluding "nothing relayed" - a mid-window read once nearly
  produced the opposite conclusion.

## Rollback

Revert the branch. The per-library field is additive and ignored by the previous
build, the patch is removed by dropping the file, and `relayThroughFor` is untouched,
so the fallback returns to today's behavior with no persisted state to unwind. Nothing
here is published or irreversible.

## Decisions (Tim, 2026-07-29)

1. **Browse, search and artwork over the relay: ALLOWED without a prompt, and
   disclosed.** Only audio is gated. The reasoning that won: gating browse too means a
   hard-NAT user opens a library to an empty screen and a dialog, which is the
   pairing-prompt problem moved one step later rather than solved. Kilobytes against
   the audio's megabytes. **The disclosure is not optional** and is in scope above -
   the privacy page's relay section is currently about reaching a library, and it now
   has to say browsing crosses the relay too.
2. **Two buttons plus a `Remember for this library` checkbox.** No third button. A
   session-only choice is arguably more honest for a friend's library, but three-button
   dialogs are worse to use one-handed, and the checkbox makes the stickiness explicit
   rather than implied.
3. **Declining is sticky (`'deny'`), with the state shown in that library's settings.**
   Sticky avoids nagging the user who already said no; the settings row is what stops
   it becoming an app that inexplicably will not play. Rejected: return-to-ask (nags
   exactly the wrong person) and session-only (the user cannot tell what state they
   are in).
4. **The hyperswarm patch: carry it locally, decide about upstreaming AFTER it works.**
   We patch locally either way, so nothing is blocked, and offering it to Holepunch is
   a separate decision that costs nothing to delay. The loud-failure test for the patch
   is required regardless, since it is what stops a dependency bump silently disabling
   the consent gate.

## Open questions

1. **Should the host be able to refuse relayed connections?** An owner might want "my
   library is LAN-only, never via PeerLoom". Deliberately OUT OF SCOPE here: it is a
   host-side grant-policy change, not a phone-side consent change, and it needs its own
   proposal. Named so nothing here is designed in a way that makes it awkward later. In
   particular the per-library consent field lives on the PHONE, so a future host-side
   policy would be a separate independent gate rather than a migration of this one.

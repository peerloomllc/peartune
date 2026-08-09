# Casting to a Chromecast or Sonos, driven by the HOST rather than the phone

## Goal
Play the library on a speaker someone already owns - a Chromecast, a Sonos, a DLNA renderer -
without the phone becoming an origin server on the LAN.

## Tier
T3. It makes library audio reachable from the LAN, which is a new access surface, so it needs
this proposal, a rollback and RCA readiness per the Constitution. It changes no wire protocol
and no pairing or grant semantics.

## The finding that makes this worth writing

`TODO.md` prices this as `[large] [low]` and lists a long bill: the phone's shim invariant dies,
graceful-reconnect is undone, it collides with cellular transcoding, gapless is lost, and it
drags Google Play Services into an MIT app. **Every one of those costs comes from the same
assumption - that the PHONE is the origin server.** That assumption was correct when it was
written. It stopped being correct when the Home Assistant work shipped.

`host/cast.js` already is the thing this needs:

- an HTTP audio route, `GET /a/<token>`, serving library tracks;
- a **capability token**, 32 random bytes, base64url, 1-hour TTL;
- **every fetch re-reads the live grant**, so a revoked device fails its next fetch;
- **revoke actively stops playback** on every entity that device has playing (`stopFor()`),
  which is what makes the room go quiet rather than merely denying the next byte.

That last pair IS the T3 acceptance test for this project, already built, already
hardware-verified against a real speaker on 2026-08-02. The only thing that route does not do
is answer anyone other than `127.0.0.1`.

So the delta is not "build a LAN media server". It is "let the existing, capability-scoped,
grant-checked one answer a specific device on the LAN, and drive the speaker from the host".

## What that deletes from the bill

| the cost TODO lists | what happens under host-as-origin |
| --- | --- |
| `worklet/shim.js:17`'s invariant dies | **Untouched.** The phone's shim stays loopback-only. This never involves it. |
| Undoes graceful-reconnect | **No.** The host is the origin and it does not leave the LAN. The phone is a remote control, exactly as it is for Home Assistant. |
| Collides with cellular transcoding | **Not applicable.** That is the phone's shim serving a length-unknown non-seekable body. The host serves a real file with a real length. |
| Google Play Services + `react-native-google-cast` + a receiver app id | **Gone.** That is the phone-side SDK. A host speaks the **open Cast v2 protocol** directly (MIT clients exist), or DLNA, which has no SDK and no fee. **This removes the proprietary dependency that mattered for Zapstore.** |
| Gapless is lost | Still true, and still true on Home Assistant. A receiver queue we do not control does not hand us ExoPlayer's patched behaviour. Accept and document, as we did for the Voice PE. |
| Codecs | Still real. HA solved this by transcoding with **its** ffmpeg; the host has none of its own, so this is the one genuinely new cost and it is shared with the open cellular-transcoding item. |

## What is actually left to build

1. **A LAN-bound audio listener**, separate from both the loopback one and the dashboard - the
   comment at `host/cast.js:21` is emphatic that hanging library audio off the dashboard's
   `0.0.0.0` server would publish it behind nothing but a dashboard password, and that judgement
   stands.
2. **A tighter capability than the loopback one deserves.** On loopback, a 1-hour TTL is fine
   because the only readers are co-resident processes. On the LAN it should be scoped to the
   active cast session, bound to the receiver's IP, and dropped the moment the session ends.
3. **Discovery** - mDNS for Chromecast (`_googlecast._tcp`) and SSDP for DLNA, on the host.
4. **A Cast v2 / DLNA client** on the host, and the receiver's own quirks.
5. **ffmpeg on the host**, shared with the cellular-transcoding item.

## The security question this turns on, stated plainly

After this, library audio is fetchable over plain HTTP from the LAN by anything that has the
token. Three things bound that, and they should be argued before any code:

- The token is unguessable, short-lived, session-scoped and IP-bound.
- **Cleartext on the LAN is unavoidable** - a Chromecast speaks plain HTTP to an IP. Audio that
  arrived over Noise crosses the LAN in the clear. State it in the UI; do not let someone
  discover it.
- A **guest's** grant can cast too, and a guest casting means their token is on the owner's LAN.
  The grant check on every fetch already covers revocation; what needs deciding is whether a
  guest should be allowed to open a LAN endpoint on someone else's network at all.

## Slices

1. **DLNA first, not Chromecast.** No SDK, no fee, no Google, and it reaches Sonos, Volumio,
   moOde and Kodi - a broader set than Chromecast, with a simpler protocol. It also proves the
   LAN-bound capability without the Cast protocol as a second variable.
2. **Chromecast**, once slice 1 has settled the security shape.
3. **Guest policy and the UI disclosure**, which slice 1 must not ship without.

## Open questions for Tim

1. **DLNA first, or Chromecast first?** DLNA is cheaper and covers Sonos; Chromecast is the
   thing people say out loud.
2. **May a GUEST cast?** It puts a token for your library on your LAN, at the request of someone
   you only gave listening rights to.
3. Is **audio in the clear on your own LAN** acceptable, given it arrived encrypted? There is no
   version of this where it is not.

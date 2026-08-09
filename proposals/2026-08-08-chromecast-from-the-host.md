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

## MEASURED ON TIM'S OWN SPEAKERS, 2026-08-08, and it is why this proposal is needed

I nearly talked Tim out of this one. His speakers are all Google Cast - three Nest/Home Minis
and a group - and Home Assistant already drives them, and PearTune's speaker list already offers
them (`host/speakers.js` `list()` filters by nothing but `media_player.`). So the obvious
conclusion was "you already have this, through Home Assistant, for free". **I said so, and then
tested it, and it is wrong.** Casting a track to the Kitchen speaker:

```
host:   cast:play {"entityId":"media_player.kitchen_speaker","trackId":"45qjdeg3..."}
HA:     ERROR [homeassistant.components.cast.media_player] Failed to cast media
        http://127.0.0.1:8742/a/8BT19Zmo... Please make sure the URL is: Reachable from the
        cast device and either a publicly resolvable hostname or an IP address
```

Speaker went to `idle`, not `playing`. **This is the push-a-URL / proxy split from TODO.md,
confirmed on hardware:**

- **ESPHome (the Voice PE)** works because HA's ffmpeg proxy **fetches the URL itself** and
  re-serves it to the device. HA runs on the host, so `127.0.0.1` is reachable to it.
- **Google Cast does not proxy.** HA hands the URL **straight to the Chromecast**, which fetches
  it itself - and `127.0.0.1` means the Chromecast. It cannot work, by construction, and no
  amount of Home Assistant configuration changes that.

**One thing this measurement makes far cheaper than the design below assumed.** HA is already
doing the Cast protocol, the discovery and the device quirks. If the host's audio route is
LAN-reachable, Google Cast works through the integration Tim already has - **no Cast v2 client
on the host, no mDNS discovery, no DLNA stack**. Items 3 and 4 of "what is left to build" drop
out entirely for anyone running Home Assistant, and slice 1 shrinks to "LAN-bind the existing
capability-scoped route, and hand out a LAN URL". The host-side Cast/DLNA client only earns its
keep for people with no Home Assistant at all, which is a later slice and not the first one.

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

## Slices - REVISED after the hardware measurement above

The first draft led with DLNA, on the grounds that it avoided Google's SDK. The measurement
makes that the wrong order: Tim owns no DLNA renderer to test against, and Home Assistant is
already doing the Cast protocol for the speakers he does own. The expensive part was never the
protocol - it is the LAN-reachable endpoint, and that is shared by every one of these paths.

1. **LAN-bind the existing capability route, and hand out a LAN URL instead of a loopback one.**
   That is the whole of it for a Home Assistant user: HA does the discovery, the Cast protocol
   and the device quirks. Testable immediately on the Kitchen speaker, against the exact error
   above. Ships with the guest policy and the cleartext disclosure below - not after them.
2. **A host-side Cast v2 / DLNA client**, for people with no Home Assistant. This is the only
   part that needs a protocol implementation, and it is worth far less than slice 1, so it
   should not gate it.

**Guest policy, DECIDED by Tim 2026-08-08 before any code: OWNERS ONLY.** A guest casting puts
a token for the owner's library on the owner's LAN, at the request of someone who was given
listening rights and nothing else. Loosening this later is easy; discovering it was wrong is
not.

## Open questions for Tim

1. ~~**DLNA first, or Chromecast first?**~~ **ANSWERED by hardware, not preference.** Tim owns no
   DLNA renderer, and his Google speakers fail with a specific, reproducible error that slice 1
   fixes. Chromecast-through-Home-Assistant first.
2. ~~**May a GUEST cast?**~~ **ANSWERED 2026-08-08: owners only.**
3. **STILL OPEN: is audio in the clear on your own LAN acceptable, given it arrived encrypted?**
   There is no version of this where it is not - a Chromecast speaks plain HTTP to an IP. This is
   the one that genuinely decides whether slice 1 ships.

# The play token goes to one elected host, whatever view a device is in

**Goal** - two of a person's devices paired to the same libraries always put their play token on
the SAME host, so the cross-scope arbitration shipped in #283 actually applies instead of applying
by luck.

**Tier** - T1. No schema change, no new methods, no wire change. What moves is WHICH host a session
row is written to.

## Why

#283 made a claim in one session scope take the other scope's token, so a blended device and a
focused one can no longer both be "the active player". That fix only bites when both devices'
session rows live on the SAME host - and they often do not:

```
sessionTarget()  // src/bare.js, before this change
  merged  -> sessionHomeLib()      = electHome(connected)  : the smallest connected hostKey
  single  -> defaultLibraryId                              : whichever host you focused
```

With one paired library those always coincide, which is why every hardware test so far passed.
With two, they coincide only if the library you happen to be focused on is also the elected one -
about a coin flip. The rig that proved #283 passed because the focused phone was pointed at the
elected host; pointing it at the other one would have reproduced the bug with the fix in place.

So #283 is correct but narrower than its own PR text implied, and that is recorded as a correction
rather than quietly fixed here.

## Scope

`sessionTarget()` returns the elected home in BOTH modes. `merged` stays exactly what it was - the
SCOPE, i.e. which row (`session:` or `session:merged:`) - and only the HOST changes:

```
sessionTarget()  // after
  lib     -> sessionHomeLib() ?? defaultLibraryId   : the same host on every device
  merged  -> mergedMode()                           : unchanged, still selects the row
```

`sessionReady()` follows: it must ensure the ELECTED host is connected, not merely the focused one,
so it uses the same all-hosts path in both modes when more than one library is paired.

One consequence to state: a focused device's queue is written to the elected host rather than the
one it is focused on. That is already what the merged row does - a session queue is opaque to the
host, which never dereferences a trackId - so no host-side change is needed.

**Also fixed here, because it falls out of the move:** `sessionTakeover`'s resume fallback used the
SESSION client to look up a track's position when not merged. With the token on a different host
than the track, that would ask the wrong host and quietly get 0. It now routes by the track's
owning library, as merged mode already did, falling back to the default client.

**Not in scope.** Devices with DIFFERENT pairing sets still elect different hosts and remain
unarbitrated, as do devices that can reach different subsets. That is the cross-host problem, which
needs a person identity spanning hosts - `personId` is minted per host and means nothing elsewhere -
and stays logged in TODO.md as a decision not yet taken.

## Compat

- ONE paired library: `electHome` returns that library, which is also `defaultLibraryId`. Byte for
  byte the same behavior. This is the overwhelming majority of installs.
- Host side unchanged - no new fields, no new methods. An old host is claimed against exactly as
  before, just possibly a different one of the person's hosts.
- A device that upgrades mid-session may move its row from host A to host B, leaving a stale row on
  A. It is inert: nothing reads a session row except a device targeting that host, which will now
  target B, and the row is overwritten on the next claim there.

## Verify

- Unit on the pure part: with two hosts, a focused device and a blended device resolve the SAME
  target host, and the `merged` flag still differs so they still take different rows.
- Unit: with one host, the target is unchanged from `defaultLibraryId`.
- On hardware, the case that fails today: TCL blended, Pixel focused on the NON-elected library,
  both playing. Before this change both keep playing despite #283; after, one stops.

## Rollback

Revert. The token goes back to following the focused library, and #283 goes back to applying only
when the two happen to coincide.

## Open questions

- `electHome` elects among CONNECTED libraries, so two devices that can reach different subsets
  still diverge. Electing among ALL PAIRED would be stable but could send the token at a host that
  is offline, which is worse. Left as is deliberately.

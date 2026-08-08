# The macOS host becomes a root LaunchDaemon

## Goal
A Mac running PearTune keeps serving music when nobody is logged in, closing the one platform
gap left by `2026-07-31-desktop-host-as-a-service.md`, which shipped Linux and Windows and
deliberately left macOS as a tray app.

## Tier
T2. It moves the data dir - and a data dir that moves without a migration destroys the library
identity every paired phone knows it by - and it changes who the host runs as. No wire-protocol,
pairing, grant or crypto change. Same tier, and for the same reason, as the Linux/Windows
proposal it follows.

It is worth saying plainly why this is not T3 even though "runs as root" appears in it: the
privilege change is in the LAUNCHER, not in the security model. The firewall, the grant store
and the revoke path are untouched, and the host's authority over who gets in is exactly what it
was. What root buys is a domain that survives logout, and nothing else.

## Background

macOS was scoped out on 2026-07-31 with a measurement, not a shrug. A LaunchAgent in
`~/Library/LaunchAgents` loads into `gui/501`, a domain `loginwindow` builds at login and tears
down at logout, so `KeepAlive` cannot save it - proven with a heartbeat agent across one real
logout/login (killed at 21:58:04, a DIFFERENT pid at 21:58:52). macOS also refuses to bootstrap
an arbitrary job into `user/501` (error 5), so there is no middle ground. It is the GUI session
or a root LaunchDaemon.

Tim's call at the time was "macOS stays a tray app". This proposal revisits that, because the
single biggest reason it was unattractive has since been disproven.

## What was measured, not assumed

**The hardened-runtime scar is gone, and that is what unblocks this.** The 2026-07-31 proposal
listed "runs the LAN code with no user session - the exact area where PearTune already has a
scar, since hardened runtime silently blocks HyperDHT's raw UDP" as a reason to stay away. That
inherited claim was **disproven end to end on 2026-08-01**: hardened and unhardened hosts had
identical socket profiles (18 UDP sockets, 10 established outbound peers), and the TCL paired
successfully with a hardened, current-code PearTune.app against the real 209-track library.

**The launch mechanism works on macOS, off the installed app, headless.** Measured on the
mac-mini (macOS 26.2) on 2026-08-08, against the shipped `/Applications/PearTune.app`, which is
signed with the hardened runtime already (`flags=0x10000(runtime)`, `TeamIdentifier=G79ALD29NA`):

```
ELECTRON_RUN_AS_NODE=1 PEARTUNE_DATA=... PEARTUNE_HTTP_PORT=8752 \
  /Applications/PearTune.app/Contents/MacOS/PearTune \
  /Applications/PearTune.app/Contents/Resources/app.asar/vendor/host/index.js

[..] folder:scanned {"tracks":209,"albums":26,"artists":6}
[..] host:announced {"topic":"b6i8ftod"}
[..] host:listening {"hostKey":"qzz316anf4wpf8mhr8bzbn5epd4owuoosfipjti8fk716ampmeio"}
```

It scanned, it listened and **it announced on the DHT** - so the same
`ELECTRON_RUN_AS_NODE` trick that made Linux and Windows cheap works here too. No second
runtime, no bundling of sodium-native / rocksdb-native / hyperdht, no display. Run as the
logged-in user with a scratch data dir on a spare port, so the live host was untouched
(confirmed still answering 200 afterwards).

**Still NOT measured, and each one can sink a slice.** These are the actual risks and none of
them should be guessed at:

1. **The system domain itself.** Everything above ran as `tim` in a GUI session. That the same
   command works under `launchd`'s `system` domain as root, with nobody logged in, is the whole
   premise and is untested. Needs an admin password on the mac-mini.
2. **TCC and the music folder.** The library lives in `/Users/tim/Music`. `~/Music` is not in
   the default TCC-protected set the way Desktop/Documents/Downloads are, but a root daemon
   reading another user's home is exactly the shape macOS has been tightening for years. If it
   needs Full Disk Access, that is a checkbox in System Settings that no installer can tick, and
   it changes the setup story enough to be worth knowing before any code is written.
3. **Whether a daemon can be signed and still load.** `launchd` in the system domain is fussier
   than a user agent about ownership and permissions of the plist and the executable.

## Design

Mirror the Windows slice, which is the closer sibling: it already solved "the service runs as a
system account, so the data dir must leave the user's profile", and it solved it with a verified
migration rather than a copy-and-hope.

- **The daemon.** `/Library/LaunchDaemons/com.peerloom.peartune.plist`, root-owned, mode 0644,
  `RunAtLoad` + `KeepAlive`, running the `ELECTRON_RUN_AS_NODE` line measured above.
- **The data dir moves** from `~/Library/Application Support/peartune-desktop` to
  `/Library/Application Support/PearTune`. Reuse the Windows migration wholesale: per-file
  digest verification, the source never deleted, idempotent so an upgrade cannot roll a live
  grant store back to a stale snapshot. That migration already exists and is already proven on
  hardware.
- **The tray app becomes a CLIENT**, exactly as Linux slice 1 had to absorb slice 2. A daemon at
  boot plus the existing login item would put two hosts on one data dir, which is the one
  outcome worse than no daemon at all.
- **The music folder stays where it is.** Do not move a user's music. If TCC blocks the read,
  that is a documented Full Disk Access step, not a reason to relocate their library.

## Slices

1. **Prove the premise.** A hand-installed LaunchDaemon on the mac-mini, real library, real
   reboot with nobody logging in. Answers risks 1-3 above. **No product code.** If this fails,
   the proposal dies here having cost one afternoon, and macOS stays a tray app with a better
   footnote than it has now.
2. **The daemon + the tray-as-client change**, together, for the two-hosts-on-one-data-dir
   reason above.
3. **The data-dir migration**, ported from Windows.
4. **Docs**, and an amendment to the 2026-07-31 proposal recording that macOS came back into
   scope and why.

## Rollback

Uninstalling the daemon is `launchctl bootout system/com.peerloom.peartune` plus deleting the
plist; the tray app then works exactly as it does today. The migration never deletes its source,
so the previous data dir is still sitting there and pointing the tray app back at it restores
the old world without touching the grant store.

## Open questions for Tim - ANSWERED 2026-08-08, before any measurement

Both were put to Tim before slice 1 ran, deliberately, so neither answer could be shaped by
having already done the work.

1. **Is an admin password prompt at install acceptable on macOS?** **YES.** Windows already went
   this way (`perMachine`, elevated) on 2026-08-01, so the two platforms end up consistent.
2. **If TCC blocks the read, is "open System Settings and grant Full Disk Access" an acceptable
   setup step?** **YES, provided it is documented clearly** - and only if the measurement shows
   macOS actually blocks it, which it may not.

So slice 1 is unblocked on both counts, and neither possible outcome kills the proposal. What
slice 1 can still kill it on is the premise itself: a daemon that will not load or will not
survive a reboot.

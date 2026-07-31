# The desktop host becomes a supervised service on Linux and Windows

## Goal
A machine running PearTune keeps serving music when nobody is logged in, on the two platforms where that is achievable, so the desktop host is the always-on daemon its own README already claims it is.

## Tier
T2. It changes how the host is launched and, on Windows, where its data dir lives - and a data dir that moves without a migration destroys the library's identity, which every paired phone knows it by. No wire-protocol, pairing, grant or crypto change. Same tier as the original desktop tray decision (DECISIONS 2026-07-18).

## Background

`desktop/README.md` calls the desktop app "the always-on daemon" and "a background service". It is neither. It is a login item (`app.setLoginItemSettings`, `desktop/src/main/index.js`), so the library is offline whenever nobody is logged in - after a reboot, after a logout, on a machine sitting at its login screen. For a product whose pitch is "your music collection, playable anywhere", that is a product gap, not a packaging detail. It was found while asking a different question (whether to port the seeder's in-place updater), and it is worth fixing on its own terms.

The PearCircle seeder is supervised on all three platforms: a `Restart=always` systemd **user** unit with `loginctl enable-linger`, an NSSM `LocalSystem` service, and a launchd LaunchAgent.

## What was measured, not assumed

**macOS cannot do this without root, and is therefore out of scope.** The seeder's own `installer/macos/com.pearcircle.seeder.plist` claims "the daemon survives logout via KeepAlive". It does not. Measured on the mac-mini (macOS 26.2), with a KeepAlive agent logging a timestamp every 10s across one real logout/login:

```
21:58:04Z pid=12235   <- last beat before logout
          (48 seconds, nothing logged)
21:58:52Z pid=13652   <- a DIFFERENT process, at login
```

Killed at logout; re-launched at login as a new process. A crash plus KeepAlive would have resumed in seconds and would not have waited for the login. Supporting evidence: agents in `~/Library/LaunchAgents` load into `gui/501`, whose domain header reads `type = login`, `session = Aqua`, `creator = loginwindow`; `com.peerloom.blind-peer` holds a PID there and is absent from `user/501`; no agent in that directory sets `LimitLoadToSessionType`. And macOS **refuses** to bootstrap an arbitrary job into `user/501` at all (error 5), so the Background user domain is not an escape hatch either.

So on macOS it is the GUI login session or a root LaunchDaemon, with nothing between. A root daemon would move the data dir out of `~/Library/Application Support`, put the music folder (in the user's home) behind permissions, and run the LAN code with no user session - the exact area where PearTune already has a scar, since hardened runtime silently blocks HyperDHT's raw UDP. **macOS stays a tray app** (Tim, 2026-07-31), and the README stops overclaiming.

This is suite-wide, not PearTune-only: the PearCircle seeder and the blind-peer are configured the same way and have the same gap on macOS.

**The service does not need a new runtime.** The seeder stages a pinned Node binary plus an esbuild bundle plus a wrapper script (`scripts/build-host-sea.sh`, because Node 25 + postject fails the SEA sentinel check). PearTune would have had it worse, because its host pulls real native addons - sodium-native, rocksdb-native, hyperdht - which do not bundle.

It needs none of that. Verified on this box:

```
ELECTRON_RUN_AS_NODE=1 electron vendor/host/index.js --music … --data … --port 8797
  -> host:listening {"hostKey":"b6y5rutz…"}   dashboard http://127.0.0.1:8797
```

The **already-installed** Electron binary runs the host headless as plain Node, with every native module resolving, and no display required. The service is that one command. This is the finding that makes the whole proposal cheap.

## Scope

### In scope

1. **Linux: a systemd user unit plus linger.** `Restart=always`, `ExecStart` pointing at the installed binary in `ELECTRON_RUN_AS_NODE` mode. The `.deb` `postinst` installs the unit and runs `loginctl enable-linger`; `prerm` drops both on removal. The AppImage grows an `--install-service` action, as the seeder's does. The data dir stays under `$HOME`, unchanged, so existing installs keep their identity.
2. **Windows: a real service.** Registering one needs admin, so the NSIS installer gains an elevation step - a one-time UAC at install, which is normal.
3. **The tray app becomes a client, not a host.** When a service owns the host, the tray must not start a second one. It detects the running service, and its menu becomes Open dashboard / service status / Quit. On Linux and Windows the tray becomes optional; on macOS it stays exactly as it is today.
4. **Honest docs.** `desktop/README.md` says what each platform actually does, including that macOS requires a logged-in session.

### Does not change
- The wire protocol, pairing, grants, the relay, the phone apps, the Umbrel/Docker host.
- **macOS**, which keeps today's login-item tray app.
- The Linux data dir.

### The Windows problem, stated rather than buried
A `LocalSystem` service has no user profile, so it sees neither `%USERPROFILE%\Music` nor the Electron `userData` directory the tray app uses today. Two ways out, and this proposal does not pick one yet:

- **Run the service as the installing user** (NSSM supports a named account). Keeps both paths and needs no migration, but the installer must capture and store credentials, which is real friction and a security surface of its own.
- **Run as LocalSystem, move the data dir to `ProgramData`, and make the music folder an explicit setting.** No credentials, but **the data dir moves - and `host.seed` IS the library's identity.** Without a migration, an upgraded install comes up as a brand-new library and every paired phone stops recognising it. Any move must copy the existing data dir first and verify `host.seed` arrived, the way `host/deploy/`'s Umbrel retirement script already does for the same reason.

This is the one genuinely open design question, and it is why Windows is a later slice than Linux.

## Effect on the in-place update proposal

`proposals/2026-07-31-desktop-update-apply.md` assumes nothing supervises the host and has it relaunch itself with `app.relaunch()`. Once a supervisor exists, slices 2 and 4 get **simpler and more robust** - swap the payload and let systemd or the SCM bring it back, which is the seeder's own path and survives the swapped-binary-relaunching-itself question that proposal lists as open. That proposal should be amended when this one lands, not rewritten: macOS still relaunches itself, because macOS stays a tray app.

## Compat
- **Existing Linux installs** keep their data dir and identity; the unit is added and the login item removed.
- **Existing Windows installs** must not lose `host.seed`. If the LocalSystem route is chosen, the installer migrates the data dir and verifies the seed before removing anything; if it cannot, it leaves the old dir in place and refuses rather than starting fresh.
- **Existing macOS installs** are untouched.
- **Old phones need no change.** Nothing here is peer-visible: the same host key, the same topics.

## Verify
- `npm run verify` green.
- **Linux, on the Debian VM:** install the `.deb`, confirm the unit is enabled and linger set, `reboot without logging in`, and confirm a phone still browses and plays. That last clause is the whole point of the proposal and the only real proof.
- **Windows, on the test VM:** install, confirm the service is registered and starts at boot, log out, confirm the library is still reachable - and confirm the host key is **unchanged** from before the upgrade, with a previously paired phone connecting without re-pairing.
- **macOS, on the mac-mini:** confirm nothing changed, and that the README now matches observed behaviour.
- Negative: stop the service and confirm the tray app reports it as stopped rather than silently starting a second host on the same data dir.

## Rollback
Per platform and independent. Removing the unit or deregistering the service returns that platform to the login-item tray app, which is what ships today. The data dir is the only thing that cannot be casually rolled back, which is exactly why the Windows slice is gated on a migration that verifies `host.seed` before it removes anything.

## Slice plan
- **Slice 1 - Linux.** systemd user unit, linger, `.deb` maintainer scripts, AppImage `--install-service`. The cheapest clean win, no data-dir question, no elevation.
- **Slice 2 - the tray becomes a client.** Detect a running service instead of starting a host. Needed before Windows, and it is what stops two hosts sharing one data dir.
- **Slice 3 - Windows**, after the LocalSystem-vs-user-account question is decided and a data-dir migration is written and tested.
- **Slice 4 - docs**, and amend the update-apply proposal's slices 2 and 4 to hand off to the supervisor.

## Open questions
1. **Windows: LocalSystem plus a data-dir migration, or a service running as the installing user?** The security and UX trade-off above. Needs a call before slice 3.
2. **Should the Linux tray app remain at all**, or is "service plus open the dashboard in a browser" enough, as it is for the seeder? Keeping it is friendlier; dropping it removes a whole class of two-hosts-one-data-dir bugs.
3. **What starts the host on a Linux box with no desktop session at all** - a headless NAS or home server? A systemd *system* unit would suit that better than a user unit, which is a third packaging shape and probably its own proposal.

# Desktop host: apply the update in place, not just announce it

## Goal
An operator who sees "PearTune 1.0.1 is out" clicks one button and is running 1.0.1 a minute later, with the library's identity and grants untouched - the same one-click apply the PearCircle and PearCal seeders already have.

## Tier
T3. The desktop host would download a payload from the internet and execute it, on three platforms, two of which need root. That is a privileged code-execution path with a trust anchor, so it needs the boundary written down before the code, plus a rollback and a per-platform verify. Nothing about the wire protocol, pairing or grants changes.

## Background

PR #302 shipped the check and the notification: an hourly poll of the GitHub Releases API, `GET /api/update`, a dashboard banner and a tray menu item. Both surfaces currently open the releases page in a browser. This proposal is the button.

The reference implementation is `pearcircle/seeder-launcher/host/updateApply.js` plus `installer/{linux,macos,windows}/`, designed in `pearcircle/proposals/2026-06-05-seeder-update.md` (slices 3a/3b/3c). It downloads the platform asset and its `.sha256` sidecar, verifies the digest, and dispatches:

| platform | seeder's path | privilege |
| --- | --- | --- |
| Linux AppImage | swap the payload, `systemctl --user restart --no-block` | none |
| Windows | run the NSIS installer `/S`, detached via WMI | none needed - the NSSM service is already LocalSystem |
| macOS `.pkg` | drop a request for a root LaunchDaemon, which re-verifies sha256 **+ Developer ID team + notarization** | root, via an install-once helper |
| Linux `.deb` | `pkexec` a root-owned helper that re-verifies sha256 then `dpkg -i` | root, via a polkit rule scoped to one user and one absolute path |

**I originally scoped PR #302 as notify-only on the false premise that those helpers were unwritten.** They are written and shipping. Tim's call (2026-07-31): PearTune gets the button too.

## The four ways PearTune's packaging differs, and why this is not a copy

This is the whole reason the proposal exists. Each row changes the design, not just the file paths.

**1. There is no service manager.** The seeder runs as a supervised background service on all three platforms - a `Restart=always` systemd user unit, an NSSM `LocalSystem` service, a launchd `KeepAlive` agent - so its appliers can hand off to "the supervisor will bring me back". PearTune's desktop host is an **Electron login-item tray app** (`app.setLoginItemSettings`, `desktop/src/main/index.js`), supervised by nothing. After a swap, nothing restarts it.

Electron answers this directly with `app.relaunch()` + `app.exit(0)`, which is simpler than the seeder's route, not harder. But it must be deliberate: `app.relaunch()` on a payload that was swapped underneath the running process needs the new path, and the tray app must first close the host and the dashboard cleanly (the `before-quit` handler already does exactly that) or the next launch finds port 8741 held and the data dir locked.

**2. macOS ships a `.dmg`, and CANNOT be notarized.** `desktop/scripts/build-mac.sh` is explicit: signed with the Developer ID, `notarize: false`, `hardenedRuntime: false`, because **macOS silently blocks LAN connections from hardened-runtime apps using raw sockets, and HyperDHT needs raw UDP**. A notarized build would break same-network pairing - the app's core function.

So the seeder's macOS trust anchor is unavailable to us. Its root daemon requires a notarized `.pkg` signed by team `G79ALD29NA`; PearTune has the same team but cannot notarize without breaking pairing. Two honest options, and this proposal picks one below.

**3. The release script publishes no `.sha256` sidecars for desktop artifacts.** `scripts/release.sh` step 4e generates sidecars for the **mobile** artifacts only; the desktop artifacts (step 5b) are uploaded bare. The seeder's entire integrity boundary is "HTTPS to GitHub plus the release's own `.sha256`". Today PearTune has nothing to verify a download against. **This is the first thing to fix and it is small.**

**4. There is no `desktop/installer/` at all.** No AppRun, no `.deb` `postinst`, no NSIS custom script, no updater LaunchDaemon plist, no polkit rule. The seeder's helpers are installed by its own packages at first install; PearTune's packages install nothing but the app.

## Decisions

- **Channel: the GitHub Releases API**, already in use by PR #302. No new infrastructure, and GitHub is not PeerLoom-operated, which fits the "no servers" principle.
- **Trust boundary: HTTPS to the official repo's releases + the published `.sha256`, re-verified by any privileged helper before it acts.** Not notarization, because PearTune cannot notarize (difference 2). On macOS we additionally check the **Developer ID signing team** via `codesign`/`pkgutil`, which is available un-notarized and is a real check: it proves PeerLoom signed the bundle. Windows and Linux artifacts are unsigned today, exactly as the seeder's are. Signing them is future hardening and is **required before any non-operator-gated automation**.
- **Operator-gated, always.** One button, one machine, one click. Never a silent auto-apply, so a bad release cannot propagate unattended.
- **macOS: swap the `.app` bundle from the mounted `.dmg`, do not add a `.pkg` target.** A `.pkg` buys a root install path whose trust anchor we cannot satisfy anyway, and adds a second macOS artifact to build, sign and test. A bundle swap needs no root when PearTune lives in `/Applications` on a machine whose user is an admin (the normal single-user Mac) or anywhere under `~`. When the swap is not permitted, the applier reports `needs-privilege` and the banner falls back to the verified download - the same graceful degradation the seeder uses for a missing helper.
- **Windows: per-user install, so no UAC.** `nsis.perMachine` is unset today, so electron-builder installs per-user under `%LOCALAPPDATA%`; running the new installer `/S` therefore needs no elevation and no privileged service. This is the one place PearTune is *easier* than the seeder, whose LocalSystem service exists partly to solve this. The installer must still be launched detached, or it will be killed mid-swap when it stops the app that spawned it.
- **Linux `.deb`: port the seeder's pkexec helper more or less verbatim**, adapted to relaunch the tray app rather than restart a systemd unit. It is the one path where PearTune and the seeder genuinely match.

## Scope

### In scope
1. **`.sha256` sidecars for every desktop artifact** in `scripts/release.sh`, uploaded to the release alongside the artifact. Nothing else can be built until this exists.
2. **`host/update-apply.js`** - the pure core: `planApply(update, platform)`, `downloadAndVerify()` (rejects and deletes on digest mismatch), and a per-platform `APPLIERS` table. Ported from the seeder, with its injectable `exec`/`fetchImpl`/`fsImpl` seams kept, because they are what make it testable without a machine per platform.
3. **`POST /api/update/apply`** on the dashboard, authenticated by the existing gate, plus apply state on `GET /api/update`.
4. **An "Update now" button in the banner** (`host/ui/app/App.jsx` - the `UpdateBanner` element PR #302 added is where it goes) with `running` / `restarting` / `error` states and a "Download instead" fallback link on any failure.
5. **A tray menu item** that does the same, since the tray is where a desktop operator actually looks.
6. **Per-platform appliers**, in the order below.
7. **`desktop/installer/`** with what each platform's helper needs.

### Does not change
- The wire protocol, pairing, grants, the relay. Nothing peer-visible.
- The **Umbrel / Docker** host, which stays notify-disabled: the image and the app store own updates there (PR #302), and that is still right.
- The **phone apps**, which update through the App Store, Play and Zapstore.
- The data dir. Identity (`host.seed`) and the grant store live in the OS data dir and are untouched by every path here. **This is the property the verify below has to prove**, because losing it means every paired phone stops recognising the library.

## Slice plan

- **Slice 0 - sidecars.** `release.sh` emits and uploads `.sha256` for every desktop artifact. Independently useful (anyone can verify a manual download today) and blocks everything else. Small.
- **Slice 1 - the verifiable core, no platform.** `host/update-apply.js` + tests: plan selection per platform, digest mismatch rejects and installs nothing, a missing or unparseable sidecar is a refusal rather than a skip. No privileged code runs in this slice.
- **Slice 2 - Linux AppImage + Windows.** The two no-root paths. AppImage: `install -m 0755` the new payload over `$APPIMAGE`, then **let systemd restart it** (see the amendment below). Windows: run the verified installer `/S`, detached, then exit.
- **Slice 3 - macOS `.app` swap.** Mount the verified `.dmg`, check the Developer ID team with `codesign -dv`, swap the bundle, relaunch. Degrade to `needs-privilege` when the destination is not writable.
- **Slice 4 - Linux `.deb` via pkexec.** The root-owned helper plus a polkit rule scoped to one user and one absolute path, installed by the `.deb`'s `postinst`, re-verifying the digest before `dpkg -i`.

Slices 2, 3 and 4 are independent; each degrades to the current download link until it lands.

## Compat
- **Old hosts have no apply route.** The dashboard asks `GET /api/update`; a host that does not advertise apply support shows the download link exactly as PR #302 does. The operator updates that one by hand, once, and it self-updates from then on.
- **Old packages have no helper.** The `.deb` path throws `NeedsHelperError` when the helper is absent and the UI offers the verified download instead, which is the seeder's own behaviour for the same case.
- Every failure is operator-visible and non-fatal. The check and the apply are both fail-open: nothing here may stop a host serving music.

## Verify
- `npm run verify` green, with new tests: plan selection across the four platforms; a tampered asset is rejected and nothing is installed; a missing, unparseable or wrong-file sidecar refuses; `needs-privilege` / `needs-helper` degrade to the download rather than reporting success.
- **Per platform, on real hardware, the same smoke each time:** click Update now on a host running the previous version; it comes back on the new one; **the library's host key is unchanged and a previously paired phone still connects without re-pairing**. Linux on this box and the Debian VM, Windows on the test VM, macOS on the mac-mini (see `[[peartune-test-vms]]`, `[[peartune-macmini-second-host]]`).
- Negative, per platform: corrupt the downloaded asset before the applier runs and confirm the running host is untouched and still serving.

## Rollback
Additive throughout. `PEARTUNE_NO_UPDATE_CHECK` already disables the check entirely; the apply route is operator-gated, so nothing self-applies. Reverting a slice restores the download link for that platform with no peer-visible change. A bad release cannot cascade, because every apply is one operator clicking one button on one machine.

## AMENDMENT, 2026-07-31: Linux now has a supervisor

`proposals/2026-07-31-desktop-host-as-a-service.md` slice 1 shipped and is proven on hardware, so the assumption underneath this proposal - "nothing supervises the host, therefore it must relaunch itself" - is **no longer true on Linux**.

- **Slice 2 (Linux) gets simpler and more robust.** Swap the payload, then `systemctl --user restart --no-block peartune-host.service` and let systemd bring it back on the new binary, exactly as the seeder does. `--no-block` for the seeder's own reason: a plain restart tears down the calling process's cgroup, killing the `systemctl` child before it returns, which surfaces as a bogus error on a *successful* update.
- **This also answers open question 1 below**, which is why it is worth writing down rather than just doing. The awkward case was an Electron app relaunching itself from a file it had just overwritten. Under a supervisor that case does not arise: the process that swaps the payload exits, and a *fresh* process is started from the new file by systemd.
- **The applier must therefore detect a supervisor** rather than assume one, because the same AppImage runs both ways: `systemctl --user is-active peartune-host.service`. Supervised, hand off; unsupervised, fall back to `app.relaunch()`.
- **macOS is unchanged** and still relaunches itself, because macOS stays a tray app - a LaunchAgent cannot survive logout, measured 2026-07-31.
- **Windows is unchanged until its own slice lands.** If it becomes a real service, the same hand-off applies via the SCM.

## Open questions
1. **Does the AppImage swap survive the app that is running from it?** The seeder swaps the payload while the service runs and lets systemd re-exec. An Electron app relaunching itself from a file that was just overwritten needs checking on a real AppImage, not reasoning. **Largely answered by the amendment above** - under systemd the swapping process exits and a fresh one starts from the new file, so this only remains open for the unsupervised fallback path.
2. **Should the tray offer "check now"?** The check is hourly; an operator who has just read a release announcement will want it sooner. Cheap, but it is a new surface and can wait.
3. **Windows per-user install is an assumption worth confirming** against a real installed instance before slice 2 is built. If any install is per-machine, that path needs UAC and the design changes.

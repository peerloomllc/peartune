# iOS client — the app on iPhone (simulator-first)

## Goal
Run the PearTune app on iOS. The app is React Native + a WebView UI + a BareKit-hosted Bare
worklet; today only Android is wired up. iOS is the natural second client — same worklet, same
UI, same identity/auth — and the immediate driver is a **second device for the cross-host "Play
here" handoff test** (proposal 2026-07-20, PR #99), which is stuck because the Pixel can't pair
off-LAN and the Android emulator segfaults on the Linux bench. An iOS Simulator on the Mac mini
(on the LAN, arm64, Xcode 26.6) is a clean second client — and iOS support is worth having on its
own merits.

**Simulator-first.** v1 targets the iOS Simulator (the test client + the dev loop). A signed
build on a physical iPhone and anything App-Store-shaped are explicitly out of this proposal.

## Tier
**T2.** A new *build target* for the existing client — no new wire protocol, no host change, no
grant/revoke change, no new identity or crypto. It reuses the same `src/bare.js` worklet, the same
`client/` RPC library, the same WebView UI bundle, and the same Noise-authenticated
`peartune/pair/1` + `peartune/media/1` channels. The security invariants (host-local grants,
revoke-kills-live, no bearer tokens) are untouched because the iOS client speaks the identical
protocol the Android client already does. Not T1: it's a real platform bring-up with a native
project and build system. Not T3: it adds no access surface and changes no security-relevant path.

## Feasibility — the spike (2026-07-20), and why this is viable
The one thing that could have killed this is a native addon with no iOS build. It was checked
before proposing:

- **Every runtime native addon the worklet loads has an `ios-arm64-simulator` prebuild** in
  `node_modules`: the whole `hyperdht` stack (`udx-native`, `sodium-native`, `rocksdb-native`,
  `quickbit-native`, `simdle-native`, `fs-native-extensions`), plus `bare-fs`, `bare-path`,
  `bare-tcp`, `bare-pipe`, and the rest of the Bare builtins. Holepunch ships iOS support.
- **`bare-http1`** — the local audio shim that feeds the player, and the addon I most feared — is
  **pure JS**; it rides `bare-tcp` (which has the iOS-sim prebuild). No native gap.
- **`react-native-bare-kit` ships a complete iOS integration**: an `ios/` pod
  (`BareKitModuleProvider.mm`), a prebuilt `BareKit.xcframework` (the Bare runtime for iOS), and a
  `link.mjs` autolinker symmetric to the Android path that already works.
- The one addon without an iOS-sim prebuild, `bare-lief`, is a **build-time** binary-analysis tool
  inside `bare-pack`, never loaded at runtime.
- **Mac mini is ready**: arm64, macOS 26.2, Xcode 26.6, the iOS 26.5 Simulator runtime installed,
  and the repo already checked out at `~/peerloomllc/peartune` (it runs the desktop tray host).

Conclusion: no fundamental blocker. What remains is routine RN iOS bring-up.

## Scope
**In:**
- **The `ios/` project** for the app (RN 0.81 iOS template), with `react-native-bare-kit`,
  `react-native-webview`, and the same JS/UI/worklet bundles the Android build embeds. The worklet
  bundle (`assets/bare-universal.bundle`) is already `--linked`; the iOS build compiles/links the
  addons via the BareKit pod, exactly as gradle does on Android.
- **Native host wiring** mirroring `android/`: mount the WebView UI, start the Bare worklet, bridge
  the same IPC the Android shell uses (the RN/JS shell code is shared; only the native project and
  any platform shims differ). Reuse the Android shell's TS/JS where it's platform-agnostic.
- **Mac bring-up prep** (one-time): install CocoaPods, put node on the non-interactive PATH, create
  an iOS 26.5 Simulator device.
- **A booting Simulator build** that pairs to a host and plays — enough to serve as the phase-3
  handoff second client.

**Out (v1):**
- **Physical-device builds + code signing + provisioning** — Simulator only.
- **App Store / TestFlight / distribution** — none.
- **iOS-specific UX polish** (haptics, native now-playing/CarPlay, share sheets) — later.
- **CI for iOS** — the Android CI is untouched; iOS builds are manual on the Mac for now.
- **Background audio entitlements tuning** beyond what a Simulator smoke needs.

## Compat / migration
- **Additive and isolated.** A new `ios/` directory; `android/`, `src/`, `worklet/`, `client/`,
  `host/`, and the wire protocol are untouched. The Android build and `npm run verify` are
  unaffected. No dependency bumps beyond what the iOS pods pull on the Mac.
- **Shared code stays shared.** The worklet, UI, and RPC client are the same files; only the native
  container is new. A worklet change ships to both platforms from one bundle.

## Verify
- `npm run verify` stays green (this adds no JS/test changes to the shared code; it's project +
  native wiring).
- **Simulator smoke on the Mac**: the app boots in the iOS 26.5 Simulator, completes onboarding,
  pairs to a host on the LAN, browses the library, and plays a track (audio via the bare-http1
  shim).
- **The payoff — phase-3 handoff**: pair the Simulator as a second device under the same person as
  the TCL, then run the cross-host "Play here" both directions and watch the merged session's
  `generation`/`activeDeviceKey` change on the home host (closes PR #99's pending live test).
- The **security invariants are inherited, not re-tested**: same protocol, same channels; a revoke
  on the host cuts the iOS client off exactly as it does Android (worth one confirming pass).

## Rollback
Delete `ios/`. Nothing else references it; the Android app, the worklet, the host, and the wire
protocol are unchanged. No migration to reverse.

## Open questions
1. **Shared-shell factoring.** How much of the Android RN shell (`app/`) is already
   platform-agnostic vs. Android-specific? If it's cleanly shared, iOS is mostly a new native
   project; if not, a small refactor to share the JS shell is worth doing as part of this.
2. **WebView audio + background.** The player streams from the worklet's loopback HTTP shim; confirm
   iOS WKWebView + the Simulator play it without needing background-audio entitlements that only
   matter on device (deferred).
3. **Whether to keep iOS Simulator-only** past the handoff test, or fold a signed physical-device
   build into a follow-up once the Simulator path proves out.

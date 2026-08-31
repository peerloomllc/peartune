<!--
THE NOTES THAT GO IN THE "Notes" BOX OF App Review Information, pasted as plain text.
Everything below the marker line is the note itself; this comment is not part of it.

WHY IT IS A FILE. The 1.0.x notes lived only on App Store Connect, invisible to review
and to a fresh clone - the same failure that hid Info.plist until 2026-08-18. This file
is the source of truth; scripts/asc-review-notes.mjs pushes it to the editable App Store
version (release.sh offers that push during the App Store publish step).

WHY THE NO VPN SECTION. On 2026-08-31 Apple's automated analysis rejected PearCinema
1.1.1 claiming it "contains VPN functionality". It has none; the scanner almost
certainly saw the Hyperswarm/HyperDHT hole-punching stack, which PearTune shares. The
rejection text itself says the fix is to put the clarification in App Review
Information, so PearTune carries it before being flagged.

Sign-In Required: NO. There is no account in this app and nothing to sign in to.
-->

---

There is no account to sign in to. That is the design, not an omission - PearTune has no servers, no user accounts and no cloud storage of any kind.

  PearTune plays a music library that lives on a computer the user owns and runs (an Umbrel, a NAS, an old desktop, a laptop) running the free PearTune host. The phone connects straight to that machine over an encrypted peer-to-peer connection. Because you will not have such a machine, the app ships with a small built-in demo library so you can use it fully without one.

  NO VPN FUNCTIONALITY

  PearTune contains no VPN. It streams music from the user's own machine over a direct, end-to-end encrypted peer-to-peer connection (the open-source Hyperswarm/HyperDHT stack, using UDP hole punching), which automated analysis can mistake for VPN functionality. The app uses no NetworkExtension API (no NEVPNManager, no NEPacketTunnelProvider), declares no VPN entitlements, never installs a VPN configuration and never carries any traffic except its own music streaming. It collects no user information: no accounts, no analytics, nothing shared with anyone.

  HOW TO USE THE APP WITHOUT A SERVER

  1. Open the app. On the first card, tap "Get started".
  2. "Who is this?" - type anything into both fields, for example "Alex" and "iPhone". The Continue button stays disabled until both are filled. Tap "Continue".
  3. "Where is your music?" - tap the third option, "I don't have one yet".
  4. It says "Setting up..." for a few seconds while it copies the bundled audio out of the app, then opens the library.

  You will then have five real tracks and can browse by album, artist and genre, search, play, pause, seek, use gapless playback, shuffle, repeat, the sleep timer, the lock screen controls and background audio. This works with no network at all - it has been tested in airplane mode on a device that has never been paired to anything.

  The bundled music is five tracks by Loyalty Freak Music, released under CC0 1.0 (public domain). The licence and its provenance are credited in the app's About tab.

  WHAT THE DEMO CANNOT SHOW YOU
  
  Pairing with a real library, which needs a second machine running the host. The attached video shows that end to end: the dashboard on the computer, the QR code, the scan, browsing a real library, and the owner revoking the phone mid-song.

  We cannot put a working pairing link in these notes, and it is worth saying why rather than leaving it looking like an oversight. A pairing window is open for five minutes and closes the moment one device uses it. A link pasted here would be dead long before you opened it, and dead for the second reviewer even if it were not. Making it long-lived and reusable would remove the only thing protecting a first pair, so the demo library exists instead.

  ABOUT THE NETWORK

  Connections are made directly between the phone and the user's own machine. When a network refuses a direct connection, the app can fall back to a relay we run, which forwards already-encrypted data it cannot read and keeps no copy. The app tries direct first, asks before streaming a library's music over the relay, and Settings has a switch to disable it entirely.

  The app is open source under the MIT licence: https://github.com/peerloomllc/peartune

  Happy to answer anything at peerloomllc@proton.me

# PearTune

Your self-hosted music, playable anywhere. No port forwarding, no VPN, no dynamic DNS, no account, no cloud copy of your files.

PearTune is a peer-to-peer music player. Your library stays on a machine you own - an Umbrel, a NAS, an old desktop - and your phone reaches it directly over an encrypted peer-to-peer connection. Nothing is exposed to the internet, and your files are never copied to anyone else's server.

## Why

Self-hosted music servers (Navidrome, Jellyfin, Plex) are good at playback. The part people actually struggle with is **remote access**: reverse proxies, port forwarding, VPNs, dynamic DNS, or paying for someone's remote-access tier. PearTune makes that part disappear.

## How it works

Two pieces:

- **The host** runs on the machine with the music. It serves your library and holds the list of devices allowed to reach it.
- **The app** runs on your phone. It pairs with the host by scanning a QR code, once.

Every connection is end-to-end encrypted and mutually authenticated. The host knows exactly which device is calling, because the connection itself proves it. There are no passwords or connection strings to leak.

### When the phone can't reach the host directly

Most of the time your phone connects straight to your host. But some mobile carriers and locked-down wifi refuse a direct peer-to-peer connection, and when that happens PearTune can fall back to a relay run by PeerLoom. The relay only forwards traffic that is already encrypted: it can see that your device is talking to your host and how much data moves, but never the contents, and it never keeps a copy of anything. It is on by default and you can turn it off in **Settings > Connection**. Full explanation at [peerloomllc.com/relay](https://peerloomllc.com/relay).

## Library sources

Pick a source in the dashboard - no compose file to edit. Point the host at:

- an existing **Navidrome** (or any Subsonic-API) server, and PearTune uses its library, artwork and transcoding, or
- an existing **Jellyfin** server, likewise, or
- a **plain folder of music files**, and PearTune reads the tags itself - artist, album, track number, year and embedded cover art (ID3, Vorbis, MP4, FLAC), so a folder is a real library, not a list of filenames.

The app cannot tell the difference. Switching sources keeps each one's settings, so you can flip between them freely.

**Plex** is intentionally not supported. Not for legal reasons - Plex publishes an official API and exempts music from its remote-playback paywall - but because a Plex server can only be read through a plex.tv **cloud** account whose token expires every seven days. A daemon that must phone a cloud service every week just to read a disk it is sitting next to is the exact problem PearTune exists to remove. (See `DECISIONS.md`, 2026-07-14.)

## Access control

Grant access per device and per person. Your phone, your tablet, your partner's phone, a friend you lend the library to. Revoke any one of them without disturbing the others, and revocation takes effect immediately - mid-song, if need be.

## Status

**Alpha. Working, but not yet publicly released.**

The wire protocol (`proposals/2026-07-13-wire-protocol.md`) is implemented and the whole path runs: scan the QR, browse the library, play. The host is packaged as a Docker image and runs on an Umbrel, and both the Android and the iOS clients are built. Pairing, gapless playback, per-person grants, live revocation and multiple hosts in one merged library have all been exercised on real devices against real hosts, including off-LAN over cellular.

What is missing is something you can install: there is no published release yet. Open work is tracked in `TODO.md` and design decisions in `DECISIONS.md`.

## License

MIT. See `LICENSE`.

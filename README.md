# PearTune

Your self-hosted music, playable anywhere. No port forwarding, no VPN, no dynamic DNS, no account, no cloud copy of your files.

PearTune is a peer-to-peer music player. Your library stays on a machine you own - an Umbrel, a NAS, an old desktop - and your phone reaches it directly over an encrypted peer-to-peer connection. Nothing is exposed to the internet, and nothing routes through anyone else's server.

## Why

Self-hosted music servers (Navidrome, Jellyfin, Plex) are good at playback. The part people actually struggle with is **remote access**: reverse proxies, port forwarding, VPNs, dynamic DNS, or paying for someone's remote-access tier. PearTune makes that part disappear.

## How it works

Two pieces:

- **The host** runs on the machine with the music. It serves your library and holds the list of devices allowed to reach it.
- **The app** runs on your phone. It pairs with the host by scanning a QR code, once.

Every connection is end-to-end encrypted and mutually authenticated. The host knows exactly which device is calling, because the connection itself proves it. There are no passwords or connection strings to leak.

## Library sources

Point the host at either:

- an existing **Navidrome** (or any Subsonic-API) server, and PearTune uses its library, artwork and transcoding, or
- a **plain folder of music files**, and PearTune scans the tags itself.

The app cannot tell the difference.

## Access control

Grant access per device and per person. Your phone, your tablet, your partner's phone, a friend you lend the library to. Revoke any one of them without disturbing the others, and revocation takes effect immediately - mid-song, if need be.

## Status

Pre-alpha. Wire protocol proposed 2026-07-13 (`proposals/2026-07-13-wire-protocol.md`), implementation not started.

## License

MIT. See `LICENSE`.

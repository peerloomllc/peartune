# PearTune

This service runs the **PearTune host** - the always-on daemon that serves your
self-hosted music library to your phone over an encrypted peer-to-peer
connection, with no port forwarding, VPN, or account.

## First run

1. Open this service's **logs** (from its page in StartOS). On first start the
   host prints a generated **dashboard password** - copy it. (It is also saved
   inside the service, so it stays the same across restarts.)
2. Open the **PearTune Dashboard** (Tor or LAN) and log in with that password.

## Point it at your music

PearTune does not hold your files - it serves a library you already run. In the
dashboard's **Music source** panel, choose one and enter its address:

- **Jellyfin** or **Nextcloud Music** running on this same server, or
- any **Subsonic-compatible** server (Navidrome, Gonic, Airsonic, …).

Test, save, and the dashboard shows your albums.

## Pair your phone

1. In the dashboard, open **Pair a device** to show a QR code.
2. In the PearTune app on your phone, scan it. Confirm the device on the
   dashboard, and it is in.

> **If pairing (or playback) times out:** turn **off WiFi** on your phone and use
> **cellular**, then try again. StartOS runs the service in an isolated container,
> so a phone on the **same WiFi as your server** often can't reach it locally
> (local discovery does not cross the container network, and most home routers do
> not hairpin). Away from home - on cellular or another network - your phone
> reaches the host over the internet and it works in seconds. This is the pitch
> working as designed: your library, playable **anywhere**.

## The one rule that matters

The dashboard is a **revoke button**. Revoke a phone there and its access is cut
within a second, mid-song - the host is the sole authority on who gets in, and
your allow-list never leaves this server. Keep the dashboard password private.

## Notes

- **Backups** cover the host's identity and grant store, so a restore keeps your
  phones paired without re-pairing.
- **The grant store is local to this server and is never replicated** - a revoked
  phone cannot write itself back in.

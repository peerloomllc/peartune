# PeerLoom blind relay

A public-IP HyperDHT node that forwards **Noise-encrypted** UDX streams between two
peers that cannot hole-punch each other. It is the off-LAN backstop for a
genuinely-0%-punch host (proposal `../proposals/2026-07-23-blind-relay.md`, T3).

It is **blind**: the phone<->host stream is encrypted end to end, so the relay only
ever sees ciphertext plus metadata (which two keys talk, byte volume). It holds no
session key and carries no copy of any library - only transient encrypted transit.
The host's firewall still gates admission over the relayed connection, so the relay
weakens neither the grant model nor revoke.

It is **app-agnostic**: one relay key can back PearTune, PearCal, and PearCircle. It
lives in the PearTune repo because PearTune is its first user.

## Hard requirement: a routable public IP

The relay must accept **inbound** connections directly - it is the one box both the
phone and the host reach outbound with ~100% reliability. A box behind home NAT (an
Umbrel/Start9) is only as reachable as the host you are trying to rescue, so it
cannot be the relay. Use a small VPS. A relay is light (it forwards bytes, no CPU
work); the constraint is bandwidth, not compute.

## Run it

```
cd relay && npm install && RELAY_DATA_DIR=/var/lib/peartune-relay node index.js
```

On first start it generates `relay.seed` in the data dir and prints the relay's
**public key** (z-base32). That string is stable across restarts and is the constant
you bake into the app + host in phase 2. Copy it.

### As a systemd service

1. Put this repo's `relay/` at `/opt/peartune-relay`, `npm install --omit=dev`.
2. `useradd --system --home /var/lib/peartune-relay peartune` and `mkdir -p /var/lib/peartune-relay && chown peartune: /var/lib/peartune-relay`.
3. Copy `deploy/peartune-relay.service` to `/etc/systemd/system/`, then
   `sudo systemctl daemon-reload && sudo systemctl enable --now peartune-relay`.
4. `journalctl -u peartune-relay -f` - the public key prints on first start.

### As a container

```
docker build -t peartune-relay ./relay && docker run -d --name peartune-relay --network host -v peartune-relay-data:/data -e RELAY_DATA_DIR=/data peartune-relay
```

`--network host` gives the DHT node direct access to the public interface. If you
cannot use host networking, forward the UDP port the node binds and confirm it is
not itself behind NAT.

## What it is not

- Not a proxy for the whole DHT - it only pairs peers that explicitly dial it via
  `relayThrough` with a matching token.
- Not a store - it keeps no data; a restart loses only in-flight pairings, which the
  peers re-establish.
- Not authenticated per-user in v1 - it forwards for anyone with the key. v1 leans on
  the end-to-end encryption + the host firewall; a per-key allow-list / accounting is
  the named next step if abuse appears (see the proposal's RCA-readiness).

## Health

The process logs `relay:stats` every `RELAY_STATUS_MS` (default 60s) with
`sessions`, `pairings`, and `streams` counters from `blind-relay`. `pairings.matched`
climbing means the relay is doing its job.

# Deploying the PeerLoom blind relay (runbook)

The relay needs a **routable public IP** and a bit of bandwidth; it needs almost no
CPU or RAM (it forwards encrypted bytes, it does not transcode). So the smallest box
at a provider with generous traffic is the right buy.

## 1. Pick a box

| | Recommended | Why |
|---|---|---|
| Provider | **Hetzner Cloud** | Cheapest bandwidth by far - 20 TB/mo included on the smallest box. A relay is bandwidth-bound, so this matters more than cores. |
| Plan | **CX22** (2 vCPU, 4 GB, ~€4/mo) | Smallest current shared-vCPU plan; a relay will never touch these limits. CPX11 or a $5-6 DigitalOcean/Vultr box works too. |
| OS | **Ubuntu 24.04 LTS** (or Debian 12) | The bootstrap script targets apt/systemd. |
| Region | Nearest your listeners | The relay adds one hop; keeping it close keeps latency low. For personal use, near you. |
| Firewall | **Allow all inbound** (or at least inbound UDP) | HyperDHT is UDP. If you enable a cloud firewall, do NOT block inbound UDP or the relay becomes unreachable and useless. Most VPSes allow all inbound by default - leave it. |

There is nothing PearTune-specific about the box. One relay can back the whole
PeerLoom suite.

## 2. Stand it up

SSH in as root (or a sudo user), get this repo onto the box, then run the bootstrap
script - it installs Node, creates the service user, wires systemd, starts the relay,
and prints the public key.

```
git clone https://github.com/peerloomllc/peartune.git && sudo bash peartune/relay/deploy/bootstrap.sh
```

(Private repo - use a token or deploy key, or `scp -r` just the `relay/` dir up and run
`sudo bash relay/deploy/bootstrap.sh` from there.)

The script ends by printing a line like:

```
relay:public-key {"key":"yjikcym8k6eqotzu5bo5t6q6w5sexjg44cztczxkujxfsjuiroby"}
```

That z-base32 string is the relay's stable identity. It survives restarts (it is
derived from `relay.seed`, written 0600 in `/var/lib/peartune-relay`). **Back up that
seed** if you want the key to survive a box rebuild.

## 3. Bake the key + ship phase 2

Put the printed key into `protocol/relay.js`:

```
const RELAY_PUBLIC_KEY_Z = 'yjikcym8k6eqotzu5bo5t6q6w5sexjg44cztczxkujxfsjuiroby'
```

Update `test/relay-policy.test.js`'s "no key baked yet" case to assert the decoded key
is a 32-byte buffer, then `npm run verify`. That is phase 2 shipping: the phone now
offers this relay when a direct punch fails, gated by the Settings toggle (default on).
No host change.

## 4. Operate it

- **Logs / key / health:** `journalctl -u peartune-relay -f`. It logs `relay:stats`
  every minute; `pairings.matched` climbing means real relaying is happening.
- **Update code:** re-run the bootstrap script (idempotent - it re-copies, reinstalls,
  restarts).
- **Restart / stop:** `sudo systemctl restart peartune-relay` / `stop`.

## Cost & abuse note

v1 is an open relay: it forwards for anyone who presents a valid pairing token, so its
cost is bandwidth. On a 20 TB/mo box that is a lot of headroom, but watch `relay:stats`
- if `streams.active` or throughput climbs unexpectedly, that is the signal to add a
per-key allow-list (the named next step in the proposal's RCA-readiness). Nothing on
the relay is ever readable: it only ever holds ciphertext in transit.

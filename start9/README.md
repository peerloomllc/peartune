# PearTune host - StartOS (Start9) app

Packages the PearTune host ([`../host/`](../host/)) as a StartOS service. Same
host code, image, and on-disk state as the Umbrel app ([`../umbrel/`](../umbrel/));
this wraps it for StartOS's `.s9pk` format. Modeled on the proven
[`pearcircle-seeder`](../../pearcircle/seeder-launcher/start9/) package - the
reason to reuse it is its **networking**, which is already validated on StartOS.

> # TABLED 2026-07-29 (Tim). Do not plan a Start9 release from this file.
>
> A PearTune host runs on StartOS and works - it pairs, browses and plays. **But every
> byte goes through the PeerLoom relay**, because StartOS runs each service behind a
> container NAT that holepunching cannot get through, on home WiFi and on cellular
> alike. That is ~5 MB per track across a $4 / 500 GB droplet whose binding constraint
> is already bandwidth, for audio that usually never leaves the listener's house - and
> the cost grows with how much people listen, not with how many people there are.
>
> `bindPortRange` was the one candidate fix and it was **built and measured** (a native
> 0.4 package, SDK 2.0.9). It does not work: see [P0 RESULT](#p0-result-2026-07-29-the-forward-does-not-fix-the-punch)
> in `proposals/2026-07-29-start9-bindportrange.md` and `start9/probe-04/`. No third
> path has been found, so the honest options are ship-relayed or do not ship, and the
> call is: **not now**.
>
> Nothing here is broken and nothing needs urgent work. Revisit only if StartOS gains
> host networking or a symmetric port forward, or if the relay's economics change.

**What is built today targets StartOS 0.3.5.x**, and the release target had been
**StartOS 0.4.0 from the PeerLoom community registry** (Tim, 2026-07-29), matching what
PearCal and PearCircle proved. That plan is now tabled per the box above; the sections
below are kept as the record of what was learned, not as a plan to execute.

The 0.3.5.x package that exists: a service is a `manifest.yaml`, one Docker image tar
per arch, and deno-bundled TypeScript procedures, packed with `start-sdk pack`.
Distribution for it is **sideload**.

## Layout

- `manifest.yaml` - metadata, entrypoint, interface (Tor + LAN), health check,
  backup, migrations.
- `Dockerfile` - `FROM` the same digest-pinned `ghcr.io/peerloomllc/peartune-host:0.2.53`
  image the Umbrel app runs, plus `tini` and the StartOS entrypoint. Reuses the
  published multi-arch image instead of rebuilding. (0.2.1 is the first image to
  carry generate-and-print, which this package relies on for its dashboard
  password - see `docker_entrypoint.sh`.)
- `docker_entrypoint.sh` - binds `0.0.0.0:8741` and points `PEARTUNE_DATA` at the
  mounted volume.
- `scripts/` - deno-bundled TS procedures (config, health, migrations,
  properties) using `embassyd_sdk@v0.3.3.0.11`.

## Two ways this differs from the seeder package

1. **Auth is kept, not disabled.** The seeder sets `SEEDER_NO_AUTH=1` and trusts
   the StartOS interface to gate access. PearTune's dashboard is a **revoke
   button**, so it keeps its own password: the entrypoint leaves `PEARTUNE_PASSWORD`
   unset, and on a non-loopback bind the host **generates** one on first run,
   prints it to the service logs, and persists it to the data volume
   (`dashboard-password`, 0600). See `host/ui/auth.js` `resolveDashboardPassword`.
2. **No config form.** The music source, library name, and pairing are all done
   in PearTune's own dashboard (as on Umbrel), so `config: ~`. On Start9 the
   source is typically a **Jellyfin or Nextcloud Music** library already running
   on the box (the only music servers in the Start9 registry) - the Subsonic and
   Jellyfin adapters cover both.

State persists in the `main` data volume (mounted at `/data`): identity seed,
grant store (host-local, **never** replicated), the generated password, and
source config.

## Build

Requires `deno`, `yq`, the StartOS SDK (`start-sdk` / `start-cli`), and either
`docker` (buildx) or `podman` (+ `qemu-user-static` for the arm64 tar on an x86
host). See <https://docs.start9.com/0.3.5.x/developer-docs/packaging>.

```bash
cd peartune/start9
make            # build + verify a universal peartune.s9pk (x86_64 + aarch64)
```

## Install on a server (sideload)

Point the SDK at your server, then install:

```bash
# ~/.embassy/config.yaml
# host: https://returned-feline.local

make install    # or: start-cli package install peartune.s9pk
```

Or upload the `.s9pk` through the StartOS UI (**System > Sideload Service**).

## Networking & the same-WiFi pairing caveat

The whole pitch is "no port forwarding": the host reaches HyperDHT by outbound
UDP holepunching. On StartOS the service runs on an isolated podman bridge, and -
unlike Umbrel's Docker bridge, which killed inbound holepunching and forced
`network_mode: host` there - the seeder package proved the StartOS bridge gives
the container an endpoint-independent **"cone" NAT mapping** that DHT holepunching
survives from **cellular / remote**. So the primary pitch (pair + stream from
anywhere) is expected to work on Start9 with standard networking; that is why this
package uses the seeder's net config rather than reaching for host networking.

The known caveat, inherited from the seeder: a phone on the **same WiFi as the
server** often can't reach the service (local discovery does not cross the bridge;
home routers rarely NAT-hairpin). Documented in `instructions.md` as "turn off
WiFi to pair." A same-LAN fix would need **host networking**, which the 0.3.5.x
manifest does not expose (a possible 0.4.x-SDK follow-up). For a music player this
caveat bites more than it does for a seeder - home listening on the same WiFi is a
common case - so it is called out prominently for the user.

## Status

**HARDWARE-VALIDATED end to end on returned-feline.local** (StartOS 0.3.5.1,
2026-07-18). The full acceptance passed:

1. ✅ Sideloaded (0.2.1 s9pk); service runs; dashboard reachable; the dashboard
   password is generated on first run and printed to the service logs (the 0.2.0
   image crash-looped here because it predated generate-and-print - see the
   0.2.1 bump in DECISIONS).
2. ✅ Source set to the box's **Jellyfin** at `http://jellyfin.embassy:8096`
   (the StartOS `<pkg-id>.embassy` internal address) - 2 albums, art, track lists.
3. ✅ Paired the TCL **from cellular** (`host:pairing-connection` → `pair:granted`
   → `host:connected`); browsed and streamed a track from Jellyfin over the DHT.
4. ✅ Revoked mid-song: `killedConnections:1` + `gate:deny device-revoked`; the
   buffered track played out, the next (un-buffered) track was refused - the
   CLAUDE.md revoke gate, on Start9.

**Same-WiFi caveat CONFIRMED, not theoretical:** a phone on the same WiFi as the
box could not complete a pair or hold a connection (the firewall admitted it -
`gate:allow-for-pairing` - then the connection died before the pair channel
opened, the classic bridge-NAT symptom). Cellular worked every time. On a phone
that keeps auto-rejoining the home WiFi this means dropping out whenever it does.
For a music player, home-WiFi listening is a core case, so this limitation is the
main open question for a Start9 release (host networking would fix it but 0.3.5.x
does not expose it; revisit on the 0.4.x SDK).

## Architectures

Universal s9pk carrying **x86_64 + aarch64**. The pinned base image is a
multi-arch manifest list, so each arch tar pulls its own layer. Building the
arm64 tar on an x86 host runs a tiny apt step under qemu (`qemu-user-static`
binfmt). Real arm-hardware P2P is unverified for lack of an arm Start9 box.

## Retargeting to 0.4 (NOT DONE YET)

The release target is **StartOS 0.4.0, installed by adding the PeerLoom community
registry URL** rather than sideloading a `.s9pk`. None of it is built for PearTune yet.
The pattern to copy lives in the PearCal repo at
`seeder-launcher/start9/registry/README.md` (a different repo, hence a path rather than
a link), which documents each of the following as something learned by driving a real
0.4 client:

- **0.4 is a different protocol, not a newer version of the same one.** 0.3.5.x serves
  static files under `GET /package/v0/...`; 0.4 answers JSON-RPC at `POST /rpc/v0` from a
  single document. A 0.4 box ignores the static tree completely - which is exactly how
  PearCal stayed invisible on 0.4 while looking perfectly healthy on 0.3.5.
- **The package format differs too.** 0.4 wants a **v2** s9pk (`start-cli s9pk convert`),
  served from `/package/v1/...`. The two are not interchangeable: the 0.4 entry carries a
  `commitment` hash computed over the v2 file, so handing a 0.4 client the v1 s9pk fails
  the hash.
- **Three fields 0.3.5 did not need:** `commitment` is mandatory, `signatures` must be
  non-empty or install fails with "Signer(s) not accepted" even though browsing works
  (self-signing is sufficient), and `icon` must be a real base64 data URL, not null.
- **The generator must be merge-aware.** PeerLoom serves ONE registry listing several
  packages from a single 0.4 document, so a generator that wrote it wholesale would
  delist every other app in one line.
- Needs the 0.4-era `start-cli` (1.x); the 0.3.5 SDK's `start-cli` has no `s9pk`
  subcommand at all.

## Does 0.4 fix the same-WiFi caveat? Investigated 2026-07-29

The honest answer is **not by itself, but it finally provides the primitive that could**.
The earlier framing in this file - "host networking would fix it, check whether 0.4
exposes it" - was **wrong on both halves**, so do not re-derive it.

Measured against `returned-feline.local`, which is now on **StartOS 0.4.0**
(`/etc/os-release` VERSION="0.4.0", `startd` running, `start-cli 1.1.0`):

**1. 0.4 does NOT expose host networking, and did not change the architecture.** Every
package runs in an unprivileged **LXC** container on `lxcbr0`, `10.0.3.0/24`, with a
startd-generated config of `lxc.net.0.type = veth` / `lxc.net.0.link = lxcbr0`. Checked
inside all eight running containers: each has **only `eth0` on 10.0.3.x and no LAN
interface**. The host's LAN is `wlp1s0` at `192.168.50.253`; no container can see it. So
a service still cannot observe or announce a LAN address - the same trap as 0.3.5's
podman bridge, in a new container runtime. There is no `hostNetwork`, `networkMode` or
`macvlan` concept anywhere in `@start9labs/start-sdk` (2.0.9).

**2. But 0.4 adds a raw UDP port forward, which 0.3.5 had no equivalent of.**
`MultiHost.bindPortRange` / `Effects.bindRange` binds *"a contiguous range of **UDP+TCP**
ports"*, documented for **coturn, RTP and SIP** - real NAT-traversal workloads - and
`externalStartPort` may differ from `internalStartPort`, the forward mapping external
onto internal by offset.

That distinction matters, because the single-port API is no use to us: `bindPort` is
protocol-typed over `http`/`https`/`ws`/`wss`/`ssh`/`dns` with `addSsl` / `secure`
options, i.e. TCP and TLS. **`bindRange` is the only raw-UDP door in the SDK**, and it
requires `numberOfPorts >= 2` (the docs push single ports at `bindPort`), so a PearTune
package would request a small range and use the first port.

**3. The same-WiFi caveat DID NOT REPRODUCE (2026-07-29), and the analysis that
predicted it was wrong.** Recorded in full because two wrong conclusions were written
earlier the same day and both are easy to re-derive.

THE PREDICTION, which was wrong as a *sufficient* cause: hyperdht announces LAN addresses
from the socket's own interfaces (`lib/server.js:214` -> `lib/holepuncher.js:337`), and
the phone filters them with `matchAddress` (`lib/holepuncher.js:356`), which requires the
FIRST OCTET to match. A `192.168.50.x` phone therefore discards a container's `10.x`, and
`shareLocalAddress` (`lib/server.js:41`) is a boolean that can only turn the local path
off, never redirect it. All of that is TRUE. The error was concluding that losing the LAN
path breaks the connection.

TWO EXPERIMENTS, TCL on WiFi only (SIM absent) at `192.168.50.242`:

| | Setup | Result |
|---|---|---|
| B | Host on the dev box, forced to announce `10.99.0.5` (no container) | **paired in ~8s** |
| D | Host in a real container: only `10.88.0.2`, private bridge, double NAT, announcing its own 10.x | **paired in ~28s** |

D models the StartOS condition faithfully - private bridge, 10.x only, a second NAT layer
- and it paired and connected anyway. The phone does discard the announced address
exactly as predicted, then falls back to holepunching, and that fallback works. The 8s vs
28s gap is the cost of losing the LAN shortcut, not a failure.

So **`bindRange` may not be needed at all**, and neither is a hyperdht patch. Do not
build either on the strength of the octet analysis.

WHY THE ORIGINAL CAVEAT PROBABLY NO LONGER APPLIES: it was recorded **2026-07-18**. The
whole off-LAN transport saga - persistent Hyperswarm transport, NAT classification and the
blind-relay backstop - shipped **22-24 July, after it**. Tim's read, and it fits the
evidence: the relay backstop resolved it. A 0%-punch backstop is exactly the right shape
for a same-LAN punch failure.

**STILL UNVERIFIED ON THE ACTUAL BOX**, and one caveat is being replaced by a question:
the committed `peartune.s9pk` predates the relay work, so testing it would test the
pre-fix code. A real answer needs a fresh s9pk built from image 0.2.36, converted to v2,
sideloaded onto the 0.4.0 box, and paired from a phone on the home WiFi.

**A COST TO WATCH IF IT PASSES VIA THE RELAY.** If same-WiFi listening on Start9 works
only *because* traffic is relayed, then every song a user plays at home crosses the VPS.
The relay is the $4 / 500 GB tier and bandwidth is already its binding constraint, so
home listening on relay would burn quota for traffic that never leaves the house. Check
HOW it connects, not just THAT it connects.

## HARDWARE VERDICT 2026-07-29: it works, and EVERYTHING goes through the relay

Tested against `returned-feline.local` on **StartOS 0.4.0** with a fresh s9pk (image 0.2.36,
demo tracks baked in), Tim's Pixel doing the pairing and playback.

**Both network conditions relay. The punch fails in both directions.**

| Condition | Relay bytes in the playback minute | Idle baseline |
|---|---|---|
| Phone on home WiFi | **+5,409,600** | ~60 KB/min |
| Phone on cellular, WiFi off | **+2,126,169** (+346,747 tail) | ~40 KB/min |

The WiFi figure is 90x baseline and 5.4 MB is `01 Drowning in your smile.mp3` (5,004,158 B)
plus overhead. Host-side control in both runs: `session:claim` then `resume:set` advancing in
real time, so the audio genuinely came from this host and not from cache or another library.

**This is worse than the old caveat, not better.** The 2026-07-18 note said cellular punched
reliably and only same-WiFi failed. On 0.4 neither punches. Something about 0.4's LXC +
nftables NAT is harder to holepunch than 0.3.5's podman bridge was - the service still sees
only `10.0.3.x` on `lxcbr0` with no LAN interface, but now the outbound mapping does not
survive either.

So the honest summary of a Start9 install today: **it works, and PeerLoom pays for it.** Every
byte a Start9 user streams crosses the relay droplet - the $4 / 500 GB tier whose binding
constraint is already bandwidth - at roughly 5 MB per track, scaling with how much people
listen rather than how many people there are.

**Two things this DISPROVES, so nobody re-derives them:**

- *"The relay cannot carry music bitrates"* (open question, TODO 2026-07-28, from a 1.4 kB/s
  peak). It can: **~90 kB/s** measured on WiFi and **~35 kB/s** on cellular, both sustaining
  real playback. The old figure was a sample of other people's idle sessions, not a ceiling.
- *"Playback starved on the relay."* It did not. A frozen `resume:set` position during the
  cellular run looked like a stall and was not - the app was backgrounded, and the WebView
  that computes the position is throttled by Android while the native player keeps going.
  Tim confirmed the audio never stopped. Do not read a flat position as a stall.

**What would fix it:** `bindPortRange` (see above) forwarding a fixed UDP port so the phone has
a real port to reach, which is now back on the table for a reason that has nothing to do with
the local-address analysis that was disproved earlier the same day. Until then a Start9
release is functional but costs PeerLoom bandwidth for every user.

## Open items

- **Prove the `bindRange` theory** with a minimal 0.4 package that pins the DHT port.
  Do this FIRST - it decides whether a Start9 release is good or merely installable.
- **Retarget to 0.4 + publish to the community registry** (above). Engineering, not a
  docs change.

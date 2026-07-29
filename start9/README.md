# PearTune host - StartOS (Start9) app

Packages the PearTune host ([`../host/`](../host/)) as a StartOS service. Same
host code, image, and on-disk state as the Umbrel app ([`../umbrel/`](../umbrel/));
this wraps it for StartOS's `.s9pk` format. Modeled on the proven
[`pearcircle-seeder`](../../pearcircle/seeder-launcher/start9/) package - the
reason to reuse it is its **networking**, which is already validated on StartOS.

**What is built today targets StartOS 0.3.5.x**, and **the target for release is
StartOS 0.4.0 installed from the PeerLoom community registry** (Tim, 2026-07-29),
matching what PearCal and PearCircle have already proven. The 0.4 work is NOT done -
see [Retargeting to 0.4](#retargeting-to-04-not-done-yet) before relying on anything
in this file.

The 0.3.5.x package that exists: a service is a `manifest.yaml`, one Docker image tar
per arch, and deno-bundled TypeScript procedures, packed with `start-sdk pack`.
Distribution for it is **sideload**.

## Layout

- `manifest.yaml` - metadata, entrypoint, interface (Tor + LAN), health check,
  backup, migrations.
- `Dockerfile` - `FROM` the same digest-pinned `ghcr.io/peerloomllc/peartune-host:0.2.36`
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

**Why that plausibly fixes it.** The caveat is that a same-LAN phone cannot reach the
box: the container's UDP is NAT'd behind the bridge, the DHT advertises the router's
external mapping, and home routers rarely hairpin. A `bindRange` forward gives a
**stable, known UDP port on the host itself**, which is exactly what a phone on the same
LAN can dial directly.

**Why it is not free.** The host would have to bind a FIXED UDP port for the DHT and
announce the box's LAN address. Today `host/server.js` constructs `new HyperDHT()` with
no keypair and no fixed port, so the port is ephemeral per process and there is nothing
stable to forward. So the work is: pin the DHT port, declare it via `bindRange`, and then
prove a same-LAN phone connects.

**NOT YET PROVEN.** Everything above is the SDK contract plus the box's actual container
config. Whether it genuinely fixes same-WiFi needs a built 0.4 package and a phone, and
it should be proven on a throwaway package before the registry work is done.

## Open items

- **Prove the `bindRange` theory** with a minimal 0.4 package that pins the DHT port.
  Do this FIRST - it decides whether a Start9 release is good or merely installable.
- **Retarget to 0.4 + publish to the community registry** (above). Engineering, not a
  docs change.

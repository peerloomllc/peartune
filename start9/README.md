# PearTune host - StartOS (Start9) app

Packages the PearTune host ([`../host/`](../host/)) as a StartOS service. Same
host code, image, and on-disk state as the Umbrel app ([`../umbrel/`](../umbrel/));
this wraps it for StartOS's `.s9pk` format. Modeled on the proven
[`pearcircle-seeder`](../../pearcircle/seeder-launcher/start9/) package - the
reason to reuse it is its **networking**, which is already validated on StartOS.

Targets **StartOS 0.3.5.x** (the stable channel): a service is a `manifest.yaml`,
one Docker image tar per arch, and deno-bundled TypeScript procedures, packed
with `start-sdk pack`. Distribution for v1 is **sideload** (not a registry
publish - see Open items).

## Layout

- `manifest.yaml` - metadata, entrypoint, interface (Tor + LAN), health check,
  backup, migrations.
- `Dockerfile` - `FROM` the same digest-pinned `ghcr.io/peerloomllc/peartune-host:0.2.2`
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

## Open items

- **Hardware smoke on returned-feline.local** (the acceptance above).
- **Distribution**: publish to a PeerLoom community registry (analogous to the
  Umbrel community store) so users can add it by URL, instead of sideloading.

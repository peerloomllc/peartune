# Host capacity: concurrent streams & folder transcoding

**Status:** measured 2026-07-17 on two of Tim's boxes; extrapolations are rough (±30–50%).
**Question this answers:** "How many devices can stream from a PearTune host at once, and
what's the limit — CPU, memory, or bandwidth?"

## TL;DR

- For the **folder + transcoding** path (the CPU-heaviest case), transcode CPU is **almost
  never the bottleneck** on any x86 self-hosting box with a modern ffmpeg. Both 4-core x86
  boxes we tested paced **200+ concurrent mp3@128 streams** while staying realtime.
- The real limits, in order: **(1) home upload bandwidth**, **(2) the host's single Node
  event loop** (low hundreds), **(3) memory** (only with a heavy ffmpeg build).
- The single biggest variable is the **ffmpeg build**, not the hardware: a modern static
  ffmpeg was ~3.7× faster and ~3.4× leaner in RAM than the distro build on the *same* CPU.
  PearTune's host image bundles a per-arch **static** ffmpeg (see DECISIONS 2026-07-14 ffmpeg
  spike), i.e. the fast path — so the optimistic numbers here are the relevant ones.
- Nothing in the code imposes a cap: no `maxConnections`, no per-device connection limit, no
  stream/rate limit. Under overload the failure mode is **degradation** (stutter), not refusal.

## How streaming works (why these are the limits)

One HyperDHT server accepts all device connections; each granted connection gets its own
`serveMedia` handler and streams over its own Protomux channel with per-stream backpressure
(`host/media.js` `pipeStream` waits for `drain`). A folder-source stream is either a raw
`fs.createReadStream` (no transcode — cheap) or, when the client requests a capped bitrate on
cellular, a spawned **ffmpeg** process per stream (`host/adapters/folder.js`). Server sources
(Subsonic/Jellyfin) are proxied — the host pipes the upstream's bytes and inherits *its*
limits. Everything runs on one Node event loop.

Because `pipeStream` backpressures, an ffmpeg transcode does **not** run flat-out: it fills the
pipe, then blocks until the client consumes at playback speed. So each active stream's steady
CPU cost ≈ `playback_rate / encode_rate` of one core — tiny when the encoder runs at 50–180×
realtime. The benchmark below models this by throttling each ffmpeg to realtime with `-re`.

## Measured results

Test: `ffmpeg -re -t 20 -i src.mp3 -c:a libmp3lame -b:a 128k -f null -`, N in parallel, each
throttled to realtime. "Kept realtime" = the batch finished in ~20 s (no underrun/stutter).
Metric that matters is wall-time keep-up; `top` CPU% under-samples bursty sub-second work and
gets noisy at high N.

### Box A — Umbrel Home: Intel N100 (4c/4t Gracemont, 16 GB), x86_64

Runs Navidrome/Jellyfin/Emby/Nextcloud alongside (~14% baseline CPU, ~9 GB RAM used).

| ffmpeg build | Single mp3@128 encode | RAM/proc | N=100 | N=200 |
|---|---|---|---|---|
| distro (system) | 48× realtime | ~54 MB | ❌ fell behind (~91% CPU, 5.4 GB) | — |
| **static 7.0.2** | **179× realtime** | **~16 MB** | ✅ kept (~55% CPU, 1.6 GB) | ✅ kept (~78% CPU, 3.3 GB) |

The distro-vs-static gap on **identical hardware** is the key finding: the original "N100
tops out ~80 streams" was an artifact of a slow, memory-heavy distro ffmpeg on a loaded box,
not the silicon. With a current static build the N100 paces 200+.

### Box B — Start9: Intel Core i5-7500T (4c/4t Kaby Lake, 16 GB), x86_64

Idle box (~3% baseline). Static ffmpeg 7.0.2, mp3@128 throttled:

| N | Kept realtime? | CPU busy | ffmpeg RAM |
|---|---|---|---|
| 10 | ✅ | ~11% | 0.15 GB |
| 25 | ✅ | ~34% | 0.37 GB |
| 50 | ✅ | ~49% | 0.74 GB |
| 100 | ✅ | ~75% | 1.5 GB |
| 150 | ✅ | ~65%* | 2.2 GB |
| 200 | ✅ | ~57%* | 3.0 GB |

Held 200 realtime, bounded by neither CPU nor RAM there → true ceiling is higher.
(*noisy high-N sampling.)

Per-stream steady cost with the static build: **~1.1–1.3% of one core**, **~16 MB RAM**.

## The real limit: uplink bandwidth

mp3@128 = 0.128 Mbps per stream. This is architecture-independent and usually bites first:

| Home upload | Max mp3@128 streams |
|---|---|
| 10 Mbps | ~75 |
| 25 Mbps | ~190 |
| 40 Mbps | ~310 |
| 100 Mbps (fiber) | ~780 |

Non-transcoded original-quality streams (raw file reads, ~256–320 kbps for a typical mp3
library) cost ~0 CPU but ~2× the bandwidth per stream — so for those the box is *even less* of
a factor and uplink is the whole story.

## Platform extrapolation (modern ffmpeg, mp3@128)

Rough, scaled from the measured boxes by relative CPU. "Box CPU ceiling" = streams the
hardware can pace; in practice uplink or the Node loop bites first for everything above Pi-4.

| Platform | Box CPU ceiling | Bites first in practice |
|---|---|---|
| Raspberry Pi 4 (A72×4 @1.5) | ~30–50 | **CPU** — the one class where box ≈ a modest home uplink |
| Raspberry Pi 5 (A76×4 @2.4) | ~100–150 | uplink |
| Intel N100 (Umbrel Home) | **200+** (measured) | uplink / Node loop |
| Intel i5-7500T (Start9) | **200+** (measured) | uplink / Node loop |
| 8-core x86 / modern i5–i7 | 400+ | Node loop, then uplink |
| Synology entry (Realtek ARM) | ~20–40 | CPU + low RAM |
| Synology mid (Celeron J4125) | ~80–120 | uplink |

From Pi-5 up, **your internet upload is the limit, not the box.** Only weak ARM (Pi 4, entry
NAS) has a CPU ceiling in the range of a typical home uplink.

## Caveats

- **Codec cost is build-dependent — don't assume.** On the same box, the distro ffmpeg did
  Opus *faster* than mp3 (112× vs 48×), but static 7.0.2 did Opus *slower* (~47× vs 179×,
  ~4× more expensive). Measure the specific build; "Opus is cheaper" is not a safe general
  claim. All are cheap in absolute terms (47× realtime is ample).
- Single-run measurements with headroom to spare; treat as order-of-magnitude, not exact.
- CPU/memory only — bandwidth measured separately (output went to `/dev/null`).
- Server sources (Subsonic/Jellyfin) proxy through the host, so their concurrency is bounded
  by the *upstream* server + Node's connection pool, not the folder-transcode numbers here.
- No connection/rate cap exists in code; a flapping device can briefly hold several
  connections (deliberate, for graceful-reconnect). If many-user scale ever matters, the
  missing levers are: a concurrent-transcode cap, an uplink-aware bitrate policy, and a
  max-connections guard.

## Reproduce it

On any Linux host with a static ffmpeg (no root needed):

```bash
# fetch a static ffmpeg to a temp dir
W=$(mktemp -d); cd "$W"
curl -sL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz | tar xJ
FF=$(find "$W" -name ffmpeg -type f | head -1)
# a 170s source (or point at a real track)
"$FF" -f lavfi -i "sine=frequency=220:duration=170" -c:a libmp3lame -b:a 320k src.mp3

# single-stream realtime factor
S=$(date +%s%N); "$FF" -loglevel error -threads 1 -i src.mp3 -c:a libmp3lame -b:a 128k -f null -; E=$(date +%s%N)
awk -v s=$S -v e=$E 'BEGIN{printf "%.0fx realtime\n", 170/((e-s)/1e9)}'

# N-parallel throttled load test (each stream paced to realtime, like production)
N=100; for i in $(seq 1 $N); do "$FF" -loglevel error -re -t 20 -i src.mp3 -c:a libmp3lame -b:a 128k -f null - & done; wait
# wall ~20s = all kept realtime; watch `top` / `free -h` during the run

rm -rf "$W"   # clean up
```

# StartOS 0.4 DHT probe - ANSWERED, KEPT AS EVIDENCE

A throwaway native StartOS 0.4 package built on 2026-07-29 to answer one question:

> Does `bindPortRange` let a phone reach a PearTune host on Start9 **directly**, instead of
> through the PeerLoom relay?

**The answer is no.** See `proposals/2026-07-29-start9-bindportrange.md` for the full result.
This package is kept because the negative is load-bearing - it is the reason not to spend
weeks on a native port and a registry publish - and because rebuilding it to re-test would
cost another afternoon of the toolchain fights recorded below.

## What it proved

Every precondition was met and the audio relayed anyway:

- the DHT port was pinned (`49737` bound inside the container, read from `/proc/net/udp`)
- StartOS installed **real** forwards, including on the LAN interface -
  `ip daddr 192.168.50.253 ... th dport 49737-49738 dnat to 10.0.3.213` - which the converted
  0.3.5 package never had
- outbound used the standard port-preserving masquerade
- and relay bytes still spiked **+5,395,189** in the minute playback started, against a
  ~30-95 KB/min idle baseline

Inbound reachability was never the blocker. Holepunching needs the container's **outbound** UDP
to leave from the same external port inbound arrives on, and `lxcbr0` does not provide that.

## Building it (if it is ever needed again)

```bash
cd start9/probe-04 && make image && make    # run make twice after any manifest change
```

Five things bite, none of them documented upstream:

1. **`dockerBuild` requires real Docker.** It shells out to a buildx-style
   `-o type=docker,dest=-`, which podman rejects. On a podman box use `dockerTag` fed from a
   throwaway local registry (`make image`); the s9pk embeds the image, so the registry only has
   to exist at build time.
2. **`dockerfile` resolves relative to the PACKAGE dir**, not `workdir`, so a repo-root context
   with a nested Dockerfile is never found as an ingredient. `make stage` copies the inputs in.
3. **`INGREDIENTS` is computed at Makefile parse time** from the *compiled* `javascript/`, so the
   first build after a manifest change uses the stale list and fails. Run `make` twice.
4. **`pack` needs a workspace in the PARENT dir** (`start9/.startos`, gitignored - it holds a
   signing key), and the SDK Makefile hardcodes `start-cli`, which collides with the 0.3.5 binary
   of the same name. Shim the 0.4 one onto PATH.
5. **`RangeOrigin.export` returns `Promise<void>`**, not a receipt, so it must not appear in the
   array `setupInterfaces` returns. And the i18n dictionary is typed - every string has to be
   registered in `startos/i18n/dictionaries/default.ts`.

## Layout

- `Dockerfile` - FROMs the published host image and overwrites only the two files carrying
  `PEARTUNE_DHT_PORT`, which 0.2.36 predates. Nothing is rebuilt from source.
- `startos/interfaces.ts` - the experiment: the dashboard on 8741, and the DHT's UDP port via
  `bindPortRange`. Read the comment there before changing anything.
- `startos/main.ts` - the host daemon with its DHT port pinned to match the forward.

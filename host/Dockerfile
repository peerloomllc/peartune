# PearTune host as a container, for Umbrel (and any Docker host).
#
# Port 8741, NOT 8731: the PearCircle seeder already publishes 8731 on Umbrel,
# and two PeerLoom apps on one box cannot share a port.
#
# Build from the REPO ROOT:
#   docker build -f host/Dockerfile -t ghcr.io/peerloomllc/peartune-host:0.2.5 .
#
# Multi-arch (Umbrel Home is x86_64; a Pi-class Umbrel is arm64):
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -f host/Dockerfile -t ghcr.io/peerloomllc/peartune-host:0.2.5 --push .
#
# No Docker on hand? podman + qemu-user-static builds the same manifest list:
#   podman build --platform linux/amd64,linux/arm64 --manifest \
#     ghcr.io/peerloomllc/peartune-host:0.2.5 -f host/Dockerfile .
#   podman manifest push --all ghcr.io/peerloomllc/peartune-host:0.2.5
#
# Simpler than PearCircle's seeder image on purpose: the seeder has to stage a
# Bare runtime + a bare-pack'd worklet bundle because it runs the APP's worklet.
# The PearTune host is plain Node - it is a server, not a peer of the app - so
# there is no Bare payload to stage and no cross-arch prebuild dance.

FROM node:20-bookworm-slim

# Runtime libs the slim image lacks but the hypercore stack's native addons need:
#   libatomic1      - rocksdb-native links libatomic.so.1
#   ca-certificates - TLS for anything we fetch later (Navidrome adapter, m2)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libatomic1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# THE HOST'S OWN MANIFEST, not the repo root's. The root package.json is the
# PHONE APP (React Native, Expo, expo-audio), and building from it:
#   1. FAILED OUTRIGHT - the root runs `postinstall: patch-package` for the app's
#      expo-audio patch, patch-package is a devDependency, and `--omit=dev` then
#      installs no patch-package and tries to run it anyway. Exit 127.
#   2. dragged React Native and Expo into a server image with no use for either.
#
# NEVER "fix" that with --ignore-scripts. It also skips the native postinstalls
# the hypercore stack needs, and you get a runtime that half-works and then
# aborts - the long PearCal debug detour, in a container this time.
#
# Deps first, so a code change does not re-resolve the tree. package.json lands
# at /app so host/, client/ and protocol/ all resolve up into /app/node_modules.
COPY host/package.json host/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY protocol/ ./protocol/
COPY client/ ./client/
COPY host/ ./host/

# Containerized defaults. Bind the dashboard on all interfaces so Umbrel's
# app_proxy can reach it on the Docker network - the proxy is what gates access
# behind the Umbrel login, which is why the dashboard has no auth of its own
# (same posture as the PearCircle seeder). Outside a proxy, do NOT expose this
# port to a LAN: it is a revoke button and a pairing QR.
ENV PEARTUNE_HTTP_HOST=0.0.0.0 \
    PEARTUNE_HTTP_PORT=8741 \
    PEARTUNE_DATA=/data \
    PEARTUNE_MUSIC=/music \
    PEARTUNE_NAME="My Library"

# /data holds the host identity seed (0600) and the grant store. Losing it means
# every device must re-pair, and leaking it means someone can impersonate the
# library. /music is mounted read-only by the compose file.
VOLUME /data
VOLUME /music
EXPOSE 8741

CMD ["node", "/app/host/index.js"]

# PearTune host as a container, for Umbrel (and any Docker host).
#
# Build from the REPO ROOT:
#   docker build -f host/Dockerfile -t ghcr.io/peerloomllc/peartune-host:0.1.0 .
#
# Multi-arch (Umbrel Home is x86_64; a Pi-class Umbrel is arm64):
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -f host/Dockerfile -t ghcr.io/peerloomllc/peartune-host:0.1.0 --push .
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

# Deps first, so a code change does not re-resolve the whole tree.
#
# NEVER add --ignore-scripts here. It skips the native postinstall for the
# hypercore stack and you get a runtime that half-works and then aborts. This
# cost a long debug detour on PearCal; see the suite-wide note in memory.
COPY package.json package-lock.json ./
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
    PEARTUNE_HTTP_PORT=8731 \
    PEARTUNE_DATA=/data \
    PEARTUNE_MUSIC=/music \
    PEARTUNE_NAME="My Library"

# /data holds the host identity seed (0600) and the grant store. Losing it means
# every device must re-pair, and leaking it means someone can impersonate the
# library. /music is mounted read-only by the compose file.
VOLUME /data
VOLUME /music
EXPOSE 8731

CMD ["node", "/app/host/index.js"]

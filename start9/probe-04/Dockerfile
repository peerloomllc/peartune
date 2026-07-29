# Runtime image for the P0 probe (proposals/2026-07-29-start9-bindportrange.md).
#
# FROM the published host image and overwrite only the two files that changed, rather
# than rebuilding the host: node, the native deps and /app/host are already in 0.2.36,
# and this probe is about NETWORKING, not about the host build.
#
# Those two files carry PEARTUNE_DHT_PORT, which 0.2.36 predates. Without it the DHT
# binds a random port per process and bindPortRange has nothing stable to forward -
# which is why the probe cannot just use the published image as-is.
FROM ghcr.io/peerloomllc/peartune-host:0.2.36@sha256:0534c63d1e110e0d6e9cb0da655ef0a5cedb8b4694489f77694ce042a5b2bc9c

# Everything below comes from ./stage/, populated by `make stage`. The build context is
# THIS directory: the SDK resolves the dockerfile path relative to the package dir, so a
# repo-root context with a nested Dockerfile does not resolve as an ingredient.
COPY stage/host/ /app/host/

# The five CC0 demo tracks at /music, the host's default library dir. A Start9 box has no
# music server to point at (the 0.4.0 upgrade removed Jellyfin), so without these there is
# nothing to stream and the whole measurement is impossible.
COPY stage/music/ /music/

ENV PEARTUNE_HTTP_HOST=0.0.0.0 \
    PEARTUNE_HTTP_PORT=8741 \
    PEARTUNE_DATA=/data \
    PEARTUNE_MUSIC=/music

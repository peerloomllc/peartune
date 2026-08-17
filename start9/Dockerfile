# StartOS runtime image for the PearTune host.
#
# Rather than rebuild the host, this reuses the exact published, digest-pinned
# image the Umbrel app runs (see ../umbrel/docker-compose.yml). We only add a
# proper init (tini) and the StartOS entrypoint. `docker buildx` / `podman`
# selects the right arch layer from the base image's multi-arch manifest; the
# s9pk packer expects the built tar tagged start9/<id>/main:<version> (see
# scripts/build-image-tar.sh).
FROM ghcr.io/peerloomllc/peartune-host:0.2.50@sha256:893ff8bccdfa297b919584c93fbf8831f8555dc9f6fbd2216b2e94d84b7b9db0

# The published image is node:20-bookworm-slim (Debian), which has no init. tini
# reaps children and propagates signals so `systemctl`/StartOS stop is clean.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

ADD ./docker_entrypoint.sh /usr/local/bin/docker_entrypoint.sh
RUN chmod a+x /usr/local/bin/docker_entrypoint.sh

# Bake the five CC0 demo tracks at /music, which is the host's default music dir
# (host/index.js: PEARTUNE_MUSIC || '/music'), so the service has something to
# play the moment it starts.
#
# This matters more on StartOS than anywhere else: the Start9 registry has no
# music server left on a stock box - Jellyfin and Nextcloud Music are the only
# two it ever had - so without this a fresh install is an empty library with no
# obvious way to fill it. The tracks are CC0 1.0 (see assets/demo-music/LICENSE.md),
# i.e. safe to redistribute inside a shipped package.
#
# Staged into this build context by the Makefile's `demo-music` target, because
# the context is start9/ and the source of truth is ../assets/demo-music.
COPY ./demo-music /music

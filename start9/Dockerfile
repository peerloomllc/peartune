# StartOS runtime image for the PearTune host.
#
# Rather than rebuild the host, this reuses the exact published, digest-pinned
# image the Umbrel app runs (see ../umbrel/docker-compose.yml). We only add a
# proper init (tini) and the StartOS entrypoint. `docker buildx` / `podman`
# selects the right arch layer from the base image's multi-arch manifest; the
# s9pk packer expects the built tar tagged start9/<id>/main:<version> (see
# scripts/build-image-tar.sh).
FROM ghcr.io/peerloomllc/peartune-host:0.2.3@sha256:a6b92bcc820607f46eee083935b4e06bb98063da13285fdcf1bd31c9a1280fa0

# The published image is node:20-bookworm-slim (Debian), which has no init. tini
# reaps children and propagates signals so `systemctl`/StartOS stop is clean.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

ADD ./docker_entrypoint.sh /usr/local/bin/docker_entrypoint.sh
RUN chmod a+x /usr/local/bin/docker_entrypoint.sh

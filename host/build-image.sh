#!/usr/bin/env bash
# Build + push a multi-arch PearTune host image to GHCR, then print the REGISTRY
# manifest digest to pin in host/redeploy-umbrel.sh.
#
# Runs on the dev box (podman + qemu-user-static for the arm64 leg; already logged
# in to ghcr.io). Umbrel Home is x86_64 and a Pi-class Umbrel is arm64, so we ship
# the manifest list, not a single arch.
#
# Usage from the repo root:
#   bash host/build-image.sh 0.2.10
set -euo pipefail

VER="${1:?usage: build-image.sh <version>   e.g. 0.2.10}"
IMG="ghcr.io/peerloomllc/peartune-host:${VER}"

echo "== building $IMG (linux/amd64,linux/arm64) =="
podman manifest rm "$IMG" 2>/dev/null || true
podman build --platform linux/amd64,linux/arm64 --manifest "$IMG" -f host/Dockerfile .

echo "== pushing $IMG =="
podman manifest push --all "$IMG"

echo "== registry digest =="
DIGEST="$(skopeo inspect "docker://$IMG" --format '{{.Digest}}')"
PINNED="${IMG}@${DIGEST}"
echo "$PINNED"

# Pin it straight into the committed redeploy script (the on-box copy is scp'd from this).
sed -i "s|^IMG=.*|IMG='${PINNED}'|" host/redeploy-umbrel.sh

# ...and into every OTHER place that names the image. This used to pin redeploy-umbrel.sh
# alone, so the compose files, the Start9 Dockerfile and the install docs sat at 0.2.6
# while the Umbrel ran 0.2.36 - thirty versions of drift that nothing detected, because
# nothing was looking. Anyone following the docs got a year-old host.
REF='ghcr.io/peerloomllc/peartune-host'
for f in host/deploy/docker-compose.yml umbrel/docker-compose.yml start9/Dockerfile; do
  sed -i -E "s|${REF}:[0-9]+\.[0-9]+\.[0-9]+@sha256:[0-9a-f]+|${REF}:${VER}@${DIGEST}|g" "$f"
done
# The docs and the Start9 README name the TAG without a digest (a reader types it).
for f in docs/host-linux.md start9/README.md; do
  sed -i -E "s|${REF}:[0-9]+\.[0-9]+\.[0-9]+|${REF}:${VER}|g" "$f"
done

# ---------------------------------------------------------------------------
# The PeerLoom community app store (STORE_DIR), if a clone is pointed at us.
#
# SYNCED, NOT BUMPED, and that difference is the whole point. PearCircle's builder
# surgically edits `version:` and `image:` in the store's copy, which is fine while the
# two copies are otherwise identical - and silently wrong the moment they are not. On
# 2026-07-31 PearTune's store copy turned out to be an old SNAPSHOT: image 0.1.0, and a
# music volume of ${UMBREL_ROOT}/data/storage/downloads, the path that is EMPTY on a real
# Umbrel and made a folder install look broken. A version bump would have published that
# with a fresh digest on top.
#
# So the in-repo umbrel/ is the source of truth and the store copy is overwritten from it
# wholesale. Anything stale in the store cannot survive a release.
#
# Committing + pushing that repo stays manual (it publishes to real users); release.sh's
# step 13c refuses to call the run clean until it is done.
# ---------------------------------------------------------------------------
if [ -n "${STORE_DIR:-}" ] && [ -d "${STORE_DIR}" ]; then
  DEST="${STORE_DIR}/peerloom-peartune"
  mkdir -p "$DEST"
  cp umbrel/umbrel-app.yml umbrel/docker-compose.yml umbrel/icon.svg "$DEST/"
  # The store listing's own version line - umbrelOS keys "update available" off it.
  sed -i -E "s|^version: \".*\"|version: \"${VER}\"|" "$DEST/umbrel-app.yml"
  echo
  echo "== community store synced from umbrel/ =="
  echo "   $DEST  (version: ${VER}, image pinned to ${VER}@${DIGEST})"
  git -C "$STORE_DIR" status --porcelain -- '*peartune*' | sed 's/^/   /'
  echo "   commit + push that repo to publish - release.sh step 13c checks it"
else
  echo
  echo "== community store NOT synced (set STORE_DIR to a local clone to auto-sync) =="
fi

echo
echo "== pinned to $VER =="
grep -rn "${REF}:" host/redeploy-umbrel.sh host/deploy/docker-compose.yml umbrel/docker-compose.yml \
  start9/Dockerfile docs/host-linux.md start9/README.md
echo
echo "Next:"
echo "  git add -u && git commit -m 'chore(host): pin image $VER'"
echo "  scp host/redeploy-umbrel.sh umbrel@umbrel.local:~/peartune-redeploy-${VER//./}.sh   # then: sudo bash it on the box"
echo "  bash host/redeploy-mac.sh                                                            # sync + restart the Mac node host"

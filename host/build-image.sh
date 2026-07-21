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
echo
echo "== host/redeploy-umbrel.sh pinned to $VER =="
grep -n '^IMG=' host/redeploy-umbrel.sh
echo
echo "Next:"
echo "  git add host/redeploy-umbrel.sh && git commit -m 'chore(host): pin image $VER'"
echo "  scp host/redeploy-umbrel.sh umbrel@umbrel.local:~/peartune-redeploy-${VER//./}.sh   # then: sudo bash it on the box"
echo "  bash host/redeploy-mac.sh                                                            # sync + restart the Mac node host"

#!/usr/bin/env bash
# Redeploy the PearTune host container on the Umbrel to a PINNED image build.
#
# Non-destructive: reuses /home/umbrel/peartune-data (identity + grants + library
# name), so paired devices need no re-pair. Music is mounted read-only.
#
# Usage on the Umbrel:
#   bash host/redeploy-umbrel.sh          # uses sudo for docker; prompts once
#   sudo bash host/redeploy-umbrel.sh     # if you prefer to elevate up front
#
# To move to a new build: bump IMG to the new tag@digest and re-run.
set -euo pipefail

# Pinned image (tag + digest = reproducible; the digest is what actually deploys).
# NB: this is the REGISTRY manifest digest (skopeo inspect docker://… .Digest, or the first
# RepoDigest after a pull) - NOT `podman inspect --format {{.Digest}}`, which is the local digest
# and yields "manifest unknown" on pull.
IMG='ghcr.io/peerloomllc/peartune-host:0.2.12@sha256:a3c5dea446216ec2a92c56009d1ec81ccedca75ed72d77ba89aee44f8d5c87de'

DATA='/home/umbrel/peartune-data'                     # identity + grants (persisted)
MUSIC_HOST='/home/umbrel/umbrel/home/Downloads'       # mounted at /library (ro); roots = /library/music,/library/downtify

# sudo passthrough (no-op if already root)
SUDO=''; [ "$(id -u)" -ne 0 ] && SUDO='sudo'

echo "== pulling $IMG =="
$SUDO docker pull "$IMG"

echo "== replacing the running peartune-host =="
$SUDO docker rm -f peartune-host >/dev/null 2>&1 || true

$SUDO docker run -d \
  --name peartune-host \
  --restart unless-stopped \
  --network host \
  --security-opt no-new-privileges:true \
  -e PEARTUNE_HTTP_HOST=0.0.0.0 \
  -e PEARTUNE_HTTP_PORT=8741 \
  -e PEARTUNE_PASSWORD=peartune \
  -e PEARTUNE_DATA=/data \
  -e PEARTUNE_MUSIC=/library/music \
  -v "$DATA:/data" \
  -v "$MUSIC_HOST:/library:ro" \
  "$IMG"

echo "== verifying =="
sleep 7
curl -s -o /dev/null -w "dashboard -> %{http_code}\n" http://127.0.0.1:8741/ || true
$SUDO docker logs --tail 10 peartune-host 2>&1 || true
echo "== done. /data reused, so no re-pair needed. =="

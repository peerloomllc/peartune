#!/usr/bin/env bash
# Redeploy the PearTune host container on the Umbrel to a PINNED image build.
#
# Non-destructive by default: reuses /home/umbrel/peartune-data (identity + grants +
# library name), so paired devices need no re-pair. Music is mounted read-only.
#
# Usage on the Umbrel:
#   bash host/redeploy-umbrel.sh          # uses sudo for docker; prompts once
#   sudo bash host/redeploy-umbrel.sh     # if you prefer to elevate up front
#   WIPE=1 bash host/redeploy-umbrel.sh   # FULL host wipe: clears the data dir first
#                                         # (pairings, user state AND the source config) for a
#                                         # from-scratch test. Everything must be re-paired and
#                                         # the music source reconfigured on the dashboard after.
#
# To move to a new build: bump IMG to the new tag@digest and re-run.
set -euo pipefail

WIPE="${WIPE:-0}"   # 1 = clear the host data dir before starting (see header). Default off.

# Pinned image (tag + digest = reproducible; the digest is what actually deploys).
# NB: this is the REGISTRY manifest digest (skopeo inspect docker://… .Digest, or the first
# RepoDigest after a pull) - NOT `podman inspect --format {{.Digest}}`, which is the local digest
# and yields "manifest unknown" on pull.
IMG='ghcr.io/peerloomllc/peartune-host:0.2.37@sha256:d8866c6811917d4c1fc29b7d54b94112c9d2368e7b6845b3c959ee760384fdb7'

DATA='/home/umbrel/peartune-data'                     # identity + grants (persisted)
MUSIC_HOST='/home/umbrel/umbrel/home/Downloads'       # mounted at /library (ro); roots = /library/music,/library/downtify

# sudo passthrough (no-op if already root)
SUDO=''; [ "$(id -u)" -ne 0 ] && SUDO='sudo'

echo "== pulling $IMG =="
$SUDO docker pull "$IMG"

echo "== replacing the running peartune-host =="
$SUDO docker rm -f peartune-host >/dev/null 2>&1 || true

if [ "$WIPE" = "1" ]; then
  echo "== WIPE=1: clearing $DATA (full host wipe - pairings, user state AND source config) =="
  $SUDO rm -rf "$DATA"
  $SUDO mkdir -p "$DATA"
fi

# THE DASHBOARD PASSWORD IS NO LONGER BAKED IN (2026-07-28). It used to be
# `-e PEARTUNE_PASSWORD=peartune`, a placeholder, and that had two consequences nobody
# had connected: the host reported passwordSource 'explicit', so the dashboard's own
# "change password" endpoint REFUSED with "set by PEARTUNE_PASSWORD; change it there" -
# and every redeploy silently reset it anyway. The placeholder was not in the dashboard,
# it was in this file.
#
# Unset, the host GENERATES a strong password on first run, prints it, and saves it to
# <data>/dashboard-password (0600), stable across restarts - and the dashboard can then
# change it. Export PEARTUNE_PASSWORD before running this to pin one deliberately, which
# is what the Umbrel app store listing does with umbrelOS's ${APP_PASSWORD}.
$SUDO docker run -d \
  --name peartune-host \
  --restart unless-stopped \
  --network host \
  --security-opt no-new-privileges:true \
  -e PEARTUNE_HTTP_HOST=0.0.0.0 \
  -e PEARTUNE_HTTP_PORT=8741 \
  ${PEARTUNE_PASSWORD:+-e PEARTUNE_PASSWORD="$PEARTUNE_PASSWORD"} \
  -e PEARTUNE_DATA=/data \
  -e PEARTUNE_MUSIC=/library/music \
  -v "$DATA:/data" \
  -v "$MUSIC_HOST:/library:ro" \
  "$IMG"

echo "== verifying =="
sleep 7
curl -s -o /dev/null -w "dashboard -> %{http_code}\n" http://127.0.0.1:8741/ || true
$SUDO docker logs --tail 10 peartune-host 2>&1 || true
if [ "$WIPE" = "1" ]; then
  echo "== done. FULL WIPE: re-pair every device and set the music source on the dashboard. =="
else
  echo "== done. /data reused, so no re-pair needed. =="
fi

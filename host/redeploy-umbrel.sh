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
IMG='ghcr.io/peerloomllc/peartune-host:0.2.52@sha256:503b37e95948c906adedecaa1ba66fa459fb07955feff0fca33a4457f2210e0b'

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

# Did a password file exist BEFORE we started? Asked here, not after, because the container
# creates one within seconds and then the answer is always yes.
#
# THIS IS A SILENT CREDENTIAL ROTATION AND IT HAS TO BE ANNOUNCED. On a host whose previous
# container had PEARTUNE_PASSWORD baked in (every deploy before 2026-07-28), no file was ever
# written - the password came from the env. Dropping the placeholder was right, but the FIRST
# redeploy after it mints a fresh random password and says nothing, so the operator is locked out
# of a dashboard that worked ten minutes earlier with no clue where to look. Cost Tim an hour on
# 2026-07-30. The container logs the minted password once, at a point the `docker logs --tail 10`
# below may well have scrolled past.
HAD_PASSWORD=0
$SUDO test -s "$DATA/dashboard-password" && HAD_PASSWORD=1

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
# Say it LAST, after the log tail, so it is the thing still on screen when the run ends.
if [ -z "${PEARTUNE_PASSWORD:-}" ] && [ "$HAD_PASSWORD" = "0" ] && $SUDO test -s "$DATA/dashboard-password"; then
  echo
  echo "== !! THE DASHBOARD PASSWORD IS NEW !! =="
  echo "   This host had no saved password, so it generated one. Any password you used before"
  echo "   this deploy will NOT work. It is saved and stable - later redeploys reuse it."
  echo
  echo "   $($SUDO cat "$DATA/dashboard-password")"
  echo
  echo "   Read it again any time with:  sudo cat $DATA/dashboard-password"
  echo "   Change it to something memorable from the dashboard once you are in."
fi

if [ "$WIPE" = "1" ]; then
  echo "== done. FULL WIPE: re-pair every device and set the music source on the dashboard. =="
else
  echo "== done. /data reused, so no re-pair needed. =="
fi

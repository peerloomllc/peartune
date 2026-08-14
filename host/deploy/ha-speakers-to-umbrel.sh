#!/usr/bin/env bash
# Put the Home Assistant speaker code (PR #317) into the RUNNING PearTune container
# on the Umbrel, without building or pulling an image.
#
# WHY A FILE COPY RATHER THAN A NEW IMAGE. This is a test deploy for the hardware
# run in proposals/2026-08-01-home-assistant-playback.md. Building and pushing a
# GHCR image for a branch that has not merged is a lot of ceremony to prove a UI
# path. The next ORDINARY deploy (host/redeploy-umbrel.sh, pinned image) overwrites
# everything this touches, which is exactly the property we want from a test deploy.
#
# NOT FOR PRODUCTION. It leaves the container's files ahead of its image tag, so
# `docker inspect` will lie about what is running until the next real redeploy.
#
# Usage on the Umbrel:
#   bash ha-speakers-to-umbrel.sh
set -euo pipefail

STAGE="${STAGE:-/tmp/pt-ha}"          # where the files were scp'd to
CONTAINER="${CONTAINER:-}"            # auto-detected below if empty

# What this actually needs is DOCKER, not root. On this Umbrel the umbrel user is in the
# docker group, so the sudo was pure friction - and friction on a deploy step is how a
# deploy gets skipped. Ask docker directly and only complain if it says no.
if ! docker info >/dev/null 2>&1; then
  echo "cannot talk to docker. If this box needs root for it: sudo bash $0" >&2
  exit 1
fi

# Find the PearTune container whichever way it was started - the app-store install
# names it peerloom-peartune_app_1, host/redeploy-umbrel.sh names it peartune-host.
if [ -z "$CONTAINER" ]; then
  for c in peartune-host peerloom-peartune_app_1; do
    if docker inspect "$c" >/dev/null 2>&1; then CONTAINER="$c"; break; fi
  done
fi
if [ -z "$CONTAINER" ]; then
  echo "could not find a PearTune container. Running containers:" >&2
  docker ps --format '  {{.Names}}' >&2
  exit 1
fi
echo "== target container: $CONTAINER =="

for f in host/cast.js host/speakers.js host/media.js host/server.js host/ui/server.js host/ui/dashboard.html; do
  if [ ! -f "$STAGE/$f" ]; then
    echo "missing $STAGE/$f - re-run the scp step" >&2
    exit 1
  fi
done

echo "== backing up what is there now (so this is reversible without a redeploy) =="
BACKUP="/home/umbrel/peartune-ha-backup-$(date +%s)"
mkdir -p "$BACKUP"
for f in host/media.js host/server.js host/ui/server.js host/ui/dashboard.html; do
  mkdir -p "$BACKUP/$(dirname "$f")"
  docker cp "$CONTAINER:/app/$f" "$BACKUP/$f" 2>/dev/null || echo "  (no existing $f)"
done
echo "   backup at $BACKUP"

echo "== copying in =="
for f in host/cast.js host/speakers.js host/media.js host/server.js host/ui/server.js host/ui/dashboard.html; do
  docker cp "$STAGE/$f" "$CONTAINER:/app/$f"
  echo "   $f"
done

echo "== restarting =="
docker restart "$CONTAINER" >/dev/null
sleep 6

echo "== checking it came up =="
docker logs --tail 15 "$CONTAINER" 2>&1 | sed 's/^/   /'
echo
if docker exec "$CONTAINER" test -f /app/host/cast.js; then
  echo "OK: host/cast.js is in place."
else
  echo "PROBLEM: host/cast.js is missing after the copy." >&2
  exit 1
fi
echo
echo "To undo without a full redeploy:"
echo "  sudo docker cp $BACKUP/host/. $CONTAINER:/app/host/ && sudo docker restart $CONTAINER"
echo "Or just run host/redeploy-umbrel.sh, which replaces the container outright."

#!/usr/bin/env bash
# Copy staged host files into the RUNNING PearTune app on the Umbrel, for development.
#
# Runs ON the Umbrel. Copies every file under $STAGE (paths relative to /app, e.g.
# host/media.js, client/index.js) into the container, backs up what it replaces first,
# checks each copy by md5 inside the container, then restarts the app. The next ordinary
# image update overwrites these files, which is fine for a dev deploy.
#
# Stage from the dev box, then run it there:
#   scp <files> umbrel@umbrel:/tmp/pt-dev/<same relative paths>
#   ssh umbrel@umbrel 'bash /tmp/pt-dev/dev-files-to-umbrel.sh'
#
# @peerloom/host files go in too: stage them under peerloom-host/src/ and they land in
# /app/node_modules/@peerloom/host/src/ (where the image keeps its copy of the package).
# The host code needs the package, so this refuses to run against an image built before
# the host moved onto it - pushing new host files into one would crash-loop the app.
#
# docker works as the umbrel user, so no sudo. Never docker compose by hand against an
# Umbrel app (see umbrel-recreate-app.sh for why); a plain restart keeps its mounts.
set -euo pipefail

STAGE="${STAGE:-$(cd "$(dirname "$0")" && pwd)}"
CONTAINER="${CONTAINER:-peerloom-peartune_app_1}"

docker inspect "$CONTAINER" >/dev/null 2>&1 || { echo "no container $CONTAINER" >&2; exit 1; }

docker exec "$CONTAINER" test -f /app/node_modules/@peerloom/host/package.json || {
  echo "$CONTAINER runs an image without @peerloom/host; deploy a new image instead" >&2; exit 1; }
mapfile -t FILES < <(cd "$STAGE" && find host client protocol peerloom-host/src -type f 2>/dev/null | sort)
[ "${#FILES[@]}" -gt 0 ] || { echo "nothing staged under $STAGE/{host,client,protocol,peerloom-host/src}" >&2; exit 1; }
# Where a staged file lives inside the container.
dest () { case "$1" in peerloom-host/*) echo "/app/node_modules/@peerloom/host/${1#peerloom-host/}" ;; *) echo "/app/$1" ;; esac; }

BACKUP="/home/umbrel/peartune-dev-backup-$(date +%s)"
echo "== backing up to $BACKUP =="
for f in "${FILES[@]}"; do
  mkdir -p "$BACKUP/$(dirname "$f")"
  docker cp "$CONTAINER:$(dest "$f")" "$BACKUP/$f" 2>/dev/null || echo "   (new file) $f"
done

echo "== copying in =="
fail=0
for f in "${FILES[@]}"; do
  docker cp "$STAGE/$f" "$CONTAINER:$(dest "$f")"
  a=$(md5sum "$STAGE/$f" | cut -d' ' -f1)
  b=$(docker exec "$CONTAINER" md5sum "$(dest "$f")" | cut -d' ' -f1)
  if [ "$a" = "$b" ]; then echo "   ok    $f"; else echo "   WRONG $f" >&2; fail=1; fi
done
[ "$fail" -eq 0 ] || { echo "a copy did not match; not restarting. Backup: $BACKUP" >&2; exit 1; }

echo "== restarting $CONTAINER =="
docker restart "$CONTAINER" >/dev/null
sleep 15
docker logs --since 30s "$CONTAINER" 2>&1 | grep -E "listening|fatal|Error" | tail -5 || true
echo "done. To undo: copy $BACKUP back the same way and restart."

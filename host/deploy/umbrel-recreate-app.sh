#!/usr/bin/env bash
# Recreate the PearTune app container on an Umbrel, THROUGH umbreld, after installing a
# new docker-compose.yml into its app-data directory.
#
# NEVER RUN `docker compose` BY HAND AGAINST AN UMBREL APP. That is what broke this box on
# 2026-08-02. An Umbrel app's compose file is full of ${APP_DATA_DIR}, ${UMBREL_ROOT} and
# ${APP_PASSWORD}, which only Umbrel's own wrapper sources. Run it yourself and every one of
# those expands to the empty string, so the container comes back bound to "/data" and
# "/library" at the filesystem root - and the recreate silently detaches the app from all of
# its real data. Home Assistant's config and PearTune's host identity were both lost that way.
#
# umbreld's apps.restart does `compose rm --force --stop` then `start_app`, both via
# ~/umbrel/scripts/app, which sources the app env first. So the container is genuinely
# recreated - it picks up mount and env changes - with the paths pointing where they should.
#
# It also fixes the OTHER failure this box hit: a container can outlive the directories it
# was bound to. If an app's data directory is deleted and recreated (an uninstall/reinstall,
# a restore, a rescue), the running container keeps the ORIGINAL inode. It looks healthy,
# reads and writes succeed, and every byte goes to an orphan nobody can see. Recreating is
# the only cure, and the verify step below is what proves the cure took.
#
# Usage, on the Umbrel, as the umbrel user (no sudo - umbreld is already root):
#   bash umbrel-recreate-app.sh [/path/to/new/docker-compose.yml]
#
# With no argument it recreates against the compose file already installed, which is the
# right call when the goal is only to re-attach a stale container to its real directories.
set -euo pipefail

APP="${APP:-peerloom-peartune}"
CONTAINER="${CONTAINER:-${APP}_app_1}"
UMBREL_ROOT="${UMBREL_ROOT:-$HOME/umbrel}"
APP_DIR="$UMBREL_ROOT/app-data/$APP"
NEW_COMPOSE="${1:-}"

step () { echo; echo "== $* =="; }
die  () { echo "FAILED: $*" >&2; exit 1; }

[ -d "$APP_DIR" ] || die "no app-data for $APP at $APP_DIR - is it installed?"
command -v umbreld >/dev/null || die "umbreld is not on PATH - am I on the Umbrel?"

step "before"
docker inspect "$CONTAINER" --format '   image  {{.Config.Image}}' 2>/dev/null || echo "   (not running)"
docker inspect "$CONTAINER" --format '{{range .Mounts}}   mount  {{.Source}} -> {{.Destination}}{{println}}{{end}}' 2>/dev/null || true

# A bind mount whose source no longer exists on disk is the stale-inode case. Docker reports
# the path it was created with, so the path can look perfectly sensible while pointing at a
# directory that was deleted out from under it.
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  while read -r type src; do
    [ "$type" = "bind" ] || continue
    [ -e "$src" ] || echo "   STALE  $src no longer exists on disk"
  done < <(docker inspect "$CONTAINER" --format '{{range .Mounts}}{{.Type}} {{.Source}}{{println}}{{end}}')
fi

if [ -n "$NEW_COMPOSE" ]; then
  [ -f "$NEW_COMPOSE" ] || die "no such file: $NEW_COMPOSE"
  # Refuse anything that is not a compose file for this app rather than installing rubbish.
  grep -q '^services:' "$NEW_COMPOSE" || die "$NEW_COMPOSE has no services: block"
  grep -q 'peartune-host' "$NEW_COMPOSE" || die "$NEW_COMPOSE does not reference the peartune-host image"

  step "installing the new compose"
  BACKUP="$APP_DIR/docker-compose.yml.bak-$(date +%s)"
  cp "$APP_DIR/docker-compose.yml" "$BACKUP"
  echo "   old one saved to $BACKUP"
  cp "$NEW_COMPOSE" "$APP_DIR/docker-compose.yml"
  echo "   installed $(md5sum "$APP_DIR/docker-compose.yml" | cut -d' ' -f1)"

  # umbreld PATCHES an app's compose on install (patchComposeFile in
  # /opt/umbreld/source/modules/apps/app.ts) and one of the patches is the container name:
  # every service without an explicit one gets <app>_<service>_1, the compose-v1 spelling.
  # Umbrel refers to containers by name all over the place, so it forces the old scheme.
  # Restart does NOT re-patch, so a compose installed by hand like this one comes up as
  # peerloom-peartune-app-1 with dashes, and anything looking for the underscore name - our
  # own deploy scripts included - just says "no such container". Do what the installer does.
  for svc in $(yq '.services | keys | .[]' "$APP_DIR/docker-compose.yml"); do
    have=$(yq ".services.${svc}.container_name // \"\"" "$APP_DIR/docker-compose.yml")
    if [ -z "$have" ] || [ "$have" = "null" ]; then
      yq -i ".services.${svc}.container_name = \"${APP}_${svc}_1\"" "$APP_DIR/docker-compose.yml"
      echo "   named ${APP}_${svc}_1 (the way umbreld would have)"
    fi
  done
fi

# Docker would create a missing bind source as a root-owned directory. Make it ourselves so
# it belongs to the umbrel user, the way every other app-data directory on the box does.
step "making sure the data directory exists"
mkdir -p "$APP_DIR/data"
echo "   $APP_DIR/data"

step "recreating through umbreld (rm --force --stop, then start)"
umbreld client apps.restart.mutate --appId "$APP"

step "waiting for the dashboard"
ok=0
for _ in $(seq 1 30); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8741/ || true)" = "200" ]; then ok=1; break; fi
  sleep 2
done
[ "$ok" -eq 1 ] || die "the dashboard never answered on 8741 - check: docker logs $CONTAINER"
echo "   answering 200"

step "verifying the mounts point at real, shared directories"
# Guard first. Without this the loop below reads nothing, finds no bad mount and reports
# success for a container that does not exist - which is exactly what it did the first time
# this ran, when the recreate produced a dash-named container instead.
docker inspect "$CONTAINER" >/dev/null 2>&1 || die "no container named $CONTAINER. Running: $(docker ps --format '{{.Names}}' | tr '\n' ' ')"
fail=0
while read -r type src dst; do
  [ -n "$type" ] || continue
  # Only BIND mounts. host/Dockerfile declares VOLUME /data and VOLUME /music, so any
  # destination the compose does not bind gets a docker-managed anonymous volume under
  # /var/lib/docker - which is root-only, so the umbrel user cannot stat it and a naive
  # existence check calls a perfectly healthy volume missing. Nothing we care about lives
  # in one: every directory that matters here is bound from the host.
  [ "$type" = "bind" ] || { echo "   skip $dst   (docker-managed volume, nothing of ours in it)"; continue; }
  if [ ! -e "$src" ]; then
    echo "   BAD  $src -> $dst   (source does not exist)"; fail=1; continue
  fi
  # Same directory on both sides, or it is another orphan. Write a marker outside and look
  # for it inside - inode numbers differ across the mount namespace, a file does not.
  marker=".pt-mount-check-$$"
  if touch "$src/$marker" 2>/dev/null; then
    if docker exec "$CONTAINER" test -e "$dst/$marker" 2>/dev/null; then
      echo "   ok   $src -> $dst"
    else
      echo "   BAD  $src -> $dst   (container sees a DIFFERENT directory)"; fail=1
    fi
    rm -f "$src/$marker"
  else
    # Read-only or not ours to write in. Fall back to comparing what is listed.
    if [ "$(ls -A "$src" 2>/dev/null | head -5 | md5sum)" = "$(docker exec "$CONTAINER" ls -A "$dst" 2>/dev/null | head -5 | md5sum)" ]; then
      echo "   ok   $src -> $dst   (read-only, contents match)"
    else
      echo "   BAD  $src -> $dst   (read-only, contents DIFFER)"; fail=1
    fi
  fi
done < <(docker inspect "$CONTAINER" --format '{{range .Mounts}}{{.Type}} {{.Source}} {{.Destination}}{{println}}{{end}}')
[ "$fail" -eq 0 ] || die "at least one mount is not what it claims to be - do NOT pair anything yet"

step "what the container can see"
echo "   image        $(docker inspect "$CONTAINER" --format '{{.Config.Image}}')"
echo "   PEARTUNE_HA_CONFIG=$(docker exec "$CONTAINER" printenv PEARTUNE_HA_CONFIG 2>/dev/null || echo '(unset)')"
if docker exec "$CONTAINER" test -f /ha-config/configuration.yaml 2>/dev/null; then
  echo "   /ha-config   has configuration.yaml - PearTune can set voice up itself"
else
  echo "   /ha-config   NO configuration.yaml (Home Assistant not mounted, or not installed)"
fi
echo "   /library     $(docker exec "$CONTAINER" ls /library 2>/dev/null | tr '\n' ' ')"

step "logs"
docker logs --tail 12 "$CONTAINER" 2>&1 | sed 's/^/   /'

echo
echo "Recreated. The container is back on its published image, so the Home Assistant"
echo "speaker code has to be copied in again: run stage-ha-speakers.sh from the repo,"
echo "then sudo bash /tmp/pt-ha/ha-speakers-to-umbrel.sh here."

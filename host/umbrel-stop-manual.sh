#!/usr/bin/env bash
# Stop and remove the MANUALLY-launched PearTune host on an Umbrel, so the app-store
# install can have port 8741. Run as root ON the Umbrel:
#
#   sudo bash ~/peartune-stop-manual.sh
#
# WHY THIS EXISTS. The Umbrel has been running PearTune as a hand-started container
# (`docker run --network host --restart unless-stopped`, data in ~/peartune-data) since
# long before there was a store listing. That container and a store install both bind
# 8741 and both use host networking, so the second one to start simply fails.
#
# WHAT IT PROTECTS. ~/peartune-data/host.seed IS THE LIBRARY'S IDENTITY - the key every
# paired phone knows this library by - and store/ is the grant list of who may connect.
# Lose them and every device has to pair again. So this backs the directory up to a
# tarball you own BEFORE touching anything, and it never deletes the original.
#
# WHAT IT DOES NOT DO. It does not migrate that identity into the store app. A store
# install therefore comes up as a NEW host and your existing phones will not recognise
# it. That is the honest first-run experience and the right thing to test; if you would
# rather keep the pairings, see MIGRATING below.
#
# MIGRATING (only if you want existing phones to keep working):
#   1. install the app from the store, then stop it in the Umbrel UI
#   2. sudo cp -a ~/peartune-data/host.seed ~/peartune-data/store \
#        ~/umbrel/app-data/peerloom-peartune/data/
#   3. sudo chown -R 1000:1000 ~/umbrel/app-data/peerloom-peartune/data
#   4. start it again
# The dashboard password is Umbrel's own after that, not the file in the old directory.

set -euo pipefail

[ "$(id -u)" = "0" ] || { echo "Run as root: sudo bash $0" >&2; exit 1; }

DATA="${PEARTUNE_DATA_DIR:-/home/umbrel/peartune-data}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/home/umbrel/peartune-data-backup-${STAMP}.tar.gz"

echo "==> Looking for a hand-started PearTune container"
# By IMAGE, not by name: the container has been recreated by hand more than once and the
# name has not always been the same. Matches both the GHCR image and the locally-loaded
# one used before the image was published.
CIDS=$(docker ps -a --filter "ancestor=ghcr.io/peerloomllc/peartune-host" --format '{{.ID}} {{.Names}} {{.Image}}' 2>/dev/null || true)
CIDS="$CIDS
$(docker ps -a --format '{{.ID}} {{.Names}} {{.Image}}' 2>/dev/null | grep -i 'peartune-host' || true)"
CIDS=$(printf '%s\n' "$CIDS" | grep -v '^$' | sort -u || true)

# Anything Umbrel manages is named after its app and must not be touched here.
CIDS=$(printf '%s\n' "$CIDS" | grep -v 'peerloom-peartune' || true)

if [ -z "$CIDS" ]; then
  echo "    none running or stopped - nothing to remove."
else
  printf '%s\n' "$CIDS" | sed 's/^/    /'
fi

if [ -d "$DATA" ]; then
  echo "==> Backing up $DATA -> $BACKUP"
  tar czf "$BACKUP" -C "$(dirname "$DATA")" "$(basename "$DATA")"
  chown umbrel:umbrel "$BACKUP"
  echo "    $(du -h "$BACKUP" | cut -f1), owned by umbrel"
  echo "    host.seed inside: $(tar tzf "$BACKUP" | grep -c 'host.seed' || echo 0)"
else
  echo "==> No $DATA to back up (already moved?)"
fi

if [ -n "$CIDS" ]; then
  echo "==> Stopping and removing"
  printf '%s\n' "$CIDS" | awk '{print $1}' | while read -r id; do
    docker stop "$id" >/dev/null 2>&1 || true
    docker rm "$id"   >/dev/null 2>&1 || true
    echo "    removed $id"
  done
fi

echo "==> Is 8741 free now?"
if ss -ltnp 2>/dev/null | grep -q ':8741 '; then
  echo "    STILL IN USE:"
  ss -ltnp 2>/dev/null | grep ':8741 ' | sed 's/^/      /'
  echo "    The store install will fail while something holds it. Find it above."
  exit 1
fi
echo "    free."

echo ""
echo "Done. $DATA is untouched and backed up at $BACKUP."
echo "Install PearTune from the PeerLoom community store now; it will come up as a NEW"
echo "host with its own identity, so pair a phone to it fresh. See MIGRATING in this"
echo "script's header if you want the old identity carried over instead."

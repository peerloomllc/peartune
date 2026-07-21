#!/usr/bin/env bash
# Redeploy the Mac mini's node-source PearTune host with the current tree.
#
# The Mac host is the swapped `node host/index.js` (session-capable), run by
# ~/machost.sh from ~/peartune-ios (an rsync'd tree, NOT a git checkout). It's plain
# Node - no image, no bare-pack - so a host update is just: sync the host + protocol
# source over, then re-run machost.sh (which stops the old process and restarts from
# source against the SAME data dir, so pairings/identity survive).
#
# Runs on the dev box (passwordless ssh to the Mac). Usage from the repo root:
#   bash host/redeploy-mac.sh
set -euo pipefail

MAC="${MAC:-tims-mac-mini.local}"
DEST="${DEST:-peartune-ios}"

echo "== syncing host/ + protocol/ -> $MAC:$DEST =="
rsync -az --delete host/ "$MAC:$DEST/host/"
rsync -az --delete protocol/ "$MAC:$DEST/protocol/"

# machost.sh only stops the TRAY app, not an already-running node host - so if the current
# :8741 listener is a previous node host/index.js, kill it first or the restart collides on the
# port. Scope the match to the peartune data dir so the co-located PearCircle SEEDER (also a
# host/index.js, but --data /Users/tim/.pearcal-seed on :8731) is never touched.
echo "== stopping the existing PearTune node host (if any) =="
ssh "$MAC" "pkill -f 'peartune-desktop/data' || true; sleep 2"

echo "== restarting the Mac node host (machost.sh) =="
ssh "$MAC" 'bash ~/machost.sh'

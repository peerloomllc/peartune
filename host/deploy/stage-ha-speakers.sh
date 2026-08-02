#!/usr/bin/env bash
# Stage the Home Assistant speaker files onto the Umbrel, ready for
# ha-speakers-to-umbrel.sh to copy into the running container.
#
# WHY THIS EXISTS. The deploy script runs ON the Umbrel and cannot see this repo, so it
# copies whatever happens to be sitting in /tmp/pt-ha. Twice now a later commit was
# invisible to it and we debugged a "bug" that was really an old file: the Test/Save
# centring looked broken on mobile for an hour because dashboard.html had been staged
# before the fix existed. So staging is scripted, copies the WHOLE list every time, and
# verifies by checksum rather than trusting that the scp did what was asked.
#
# Run from the repo root:
#   bash host/deploy/stage-ha-speakers.sh
set -euo pipefail

TARGET="${TARGET:-umbrel@umbrel.local}"
STAGE="${STAGE:-/tmp/pt-ha}"

# Every file the deploy script copies. Keep in step with the loop in
# ha-speakers-to-umbrel.sh - if one grows a file, so must the other.
FILES=(
  host/cast.js
  host/speakers.js
  host/media.js
  host/server.js
  host/ui/server.js
  host/ui/dashboard.html
)

for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "missing $f - run me from the repo root" >&2; exit 1; }
done

# dashboard.html is BUILT from host/ui/app/. Staging a stale build is the exact failure
# this script exists to prevent, so rebuild rather than hope.
echo "== rebuilding the dashboard =="
npm run build:dashboard >/dev/null

echo "== staging to $TARGET:$STAGE =="
ssh "$TARGET" "mkdir -p $STAGE/host/ui"
scp -q "${FILES[@]:0:4}" "$TARGET:$STAGE/host/"
scp -q host/ui/server.js host/ui/dashboard.html "$TARGET:$STAGE/host/ui/"
scp -q host/deploy/ha-speakers-to-umbrel.sh "$TARGET:$STAGE/"

echo "== verifying by checksum =="
fail=0
for f in "${FILES[@]}"; do
  l=$(md5sum "$f" | cut -d' ' -f1)
  r=$(ssh "$TARGET" "md5sum $STAGE/$f 2>/dev/null | cut -d' ' -f1")
  if [ "$l" = "$r" ]; then echo "   ok    $f"; else echo "   STALE $f" >&2; fail=1; fi
done
[ "$fail" -eq 0 ] || { echo "staging did not match - do NOT deploy" >&2; exit 1; }

echo
echo "Staged. Now run this on the Umbrel (needs sudo for docker):"
echo "  ssh -t $TARGET 'sudo bash $STAGE/ha-speakers-to-umbrel.sh'"

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

# ...and into every OTHER place that names the image. This used to pin redeploy-umbrel.sh
# alone, so the compose files, the Start9 Dockerfile and the install docs sat at 0.2.6
# while the Umbrel ran 0.2.36 - thirty versions of drift that nothing detected, because
# nothing was looking. Anyone following the docs got a year-old host.
REF='ghcr.io/peerloomllc/peartune-host'
for f in host/deploy/docker-compose.yml umbrel/docker-compose.yml start9/Dockerfile; do
  sed -i -E "s|${REF}:[0-9]+\.[0-9]+\.[0-9]+@sha256:[0-9a-f]+|${REF}:${VER}@${DIGEST}|g" "$f"
done
# The docs and the Start9 README name the TAG without a digest (a reader types it).
for f in docs/host-linux.md start9/README.md; do
  sed -i -E "s|${REF}:[0-9]+\.[0-9]+\.[0-9]+|${REF}:${VER}|g" "$f"
done

# Dotted-version compare: is $1 strictly greater than $2? Numeric per component, so
# 1.0.10 > 1.0.9, and equal is NOT greater. Extracted to a function so
# test/build-image-version.test.js can run it without the build.
_ver_gt() {
  [ "$1" = "$2" ] && return 1
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n1)" = "$1" ]
}

# ---------------------------------------------------------------------------
# The PeerLoom community app store (STORE_DIR), if a clone is pointed at us.
#
# SYNCED, NOT BUMPED, and that difference is the whole point. PearCircle's builder
# surgically edits `version:` and `image:` in the store's copy, which is fine while the
# two copies are otherwise identical - and silently wrong the moment they are not. On
# 2026-07-31 PearTune's store copy turned out to be an old SNAPSHOT: image 0.1.0, and a
# music volume of ${UMBREL_ROOT}/data/storage/downloads, the path that is EMPTY on a real
# Umbrel and made a folder install look broken. A version bump would have published that
# with a fresh digest on top.
#
# So the in-repo umbrel/ is the source of truth and the store copy is overwritten from it
# wholesale. Anything stale in the store cannot survive a release.
#
# Publishing that repo is release.sh's step 13c: it asks once, then commits, pushes, opens
# the PR and merges it, and refuses to call the run clean until origin's default branch
# actually serves this version. Committing here by hand still works and 13c will see it.
# ---------------------------------------------------------------------------
if [ -n "${STORE_DIR:-}" ] && [ -d "${STORE_DIR}" ]; then
  DEST="${STORE_DIR}/peerloom-peartune"
  # Read BEFORE the copy overwrites it, so the no-update warning below has something to compare.
  PREV_STORE_VER=$(grep -m1 -E '^version:' "$DEST/umbrel-app.yml" 2>/dev/null | sed -E 's|^version: "?([^"]*)"?|\1|')
  mkdir -p "$DEST"
  cp umbrel/umbrel-app.yml umbrel/docker-compose.yml umbrel/icon.svg "$DEST/"
  # THE LISTING ADVERTISES THE PRODUCT VERSION, NOT THE IMAGE VERSION (Tim, 2026-07-31).
  # One number across the App Store, Play and Umbrel. The image tag + digest above still
  # move independently; this field is what a user sees and what umbrelOS compares.
  APP_VER=$(node -p "require('./app.json').expo.version")
  sed -i -E "s|^version: \".*\"|version: \"${APP_VER}\"|" "$DEST/umbrel-app.yml"
  # ...AND THE COST OF THAT CHOICE, enforced rather than discovered by a user who never
  # got an update. umbrelOS keys "update available" off `version:` alone, and offers one
  # only when the listing is GREATER than what is installed. A host-only fix - new image,
  # unchanged app version - therefore ships to nobody. So did an app version BEHIND the
  # store: the listing was bumped by hand to 1.0.4 and 1.0.5 for host-only releases while
  # app.json sat at 1.0.3, and this check only caught EQUAL, so a 1.0.4 app release would
  # have synced a listing below the live one without a word (found 2026-08-21). Not greater
  # is a hard stop: the copy above has already happened, so the store clone is left dirty
  # for inspection, and nothing is published until the version is right.
  if [ -n "$PREV_STORE_VER" ] && ! _ver_gt "$APP_VER" "$PREV_STORE_VER"; then
    echo
    echo "   !! STORE LISTING VERSION $APP_VER IS NOT GREATER THAN THE LIVE $PREV_STORE_VER (image moved to $VER)."
    echo "      umbrelOS compares \`version:\` only, so INSTALLED USERS WOULD NOT BE OFFERED THIS UPDATE."
    echo "      Bump the app version past $PREV_STORE_VER before publishing. The store clone is left"
    echo "      dirty so you can see what would have shipped; nothing has been committed or pushed."
    exit 1
  fi
  echo
  echo "== community store synced from umbrel/ =="
  echo "   $DEST  (version: ${VER}, image pinned to ${VER}@${DIGEST})"
  git -C "$STORE_DIR" status --porcelain -- '*peartune*' | sed 's/^/   /'
  echo "   release.sh step 13c publishes that repo (asks first) and gates on it"
else
  echo
  echo "== community store NOT synced (set STORE_DIR to a local clone to auto-sync) =="
fi

echo
echo "== pinned to $VER =="
grep -rn "${REF}:" host/redeploy-umbrel.sh host/deploy/docker-compose.yml umbrel/docker-compose.yml \
  start9/Dockerfile docs/host-linux.md start9/README.md
echo
echo "Next:"
echo "  git add -u && git commit -m 'chore(host): pin image $VER'"
echo "  scp host/redeploy-umbrel.sh umbrel@umbrel.local:~/peartune-redeploy-${VER//./}.sh   # then: sudo bash it on the box"
echo "  bash host/redeploy-mac.sh                                                            # sync + restart the Mac node host"

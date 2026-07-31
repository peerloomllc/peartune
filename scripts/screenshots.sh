#!/usr/bin/env bash
# Orchestrator for iOS App Store screenshots - run from Linux. Bundles the UI,
# syncs the repo to the Mac mini, runs the simulator screenshot driver there and
# pulls the PNGs back into metadata/ios/screenshots/.
#
# Usage:
#   ./scripts/screenshots.sh                 # full rebuild
#   SKIP_BUILD=1 ./scripts/screenshots.sh    # skip xcodebuild (fixtures-only changes)
#
# THE FIXTURE IS NOT OPTIONAL. The six scenes render from metadata/screenshot-fixtures/
# pack.json (scripts/screenshot-fixture.sh, then screenshot-fixture-pack.js), which is
# gitignored - it holds real album art. Without it the app falls through to whatever the
# capture device actually has, which on a fresh install is the pairing wall. Build it
# first, or the run produces six frames of nothing.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -f "$REPO_ROOT/scripts/app.conf" ]; then
  set -a; source "$REPO_ROOT/scripts/app.conf"; set +a
fi
MAC_MINI="${MAC_MINI_HOST:-Tims-Mac-mini.local}"
# MAC_MINI_REPO_PATH is $HOME-relative here (peartune-ios) and it is an rsync
# TARGET, not a git clone - nothing in this script may `git pull` over there.
MAC_REPO="${MAC_MINI_REPO_PATH:-peartune-ios}"
OUT_DIR="$REPO_ROOT/metadata/ios/screenshots"

echo "==> Bundling UI"
cd "$REPO_ROOT"
npm run build:ui 2>&1 | tail -2

echo "==> Syncing to $MAC_MINI:$MAC_REPO"
# NO --delete: ios/Pods and node_modules live over there too.
rsync -az --checksum \
  --exclude='.git' --exclude='node_modules' --exclude='android' \
  --exclude='ios/build' --exclude='ios/Pods' \
  --exclude='desktop/dist' --exclude='desktop/node_modules' \
  --exclude='host/node_modules' \
  "$REPO_ROOT/" "$MAC_MINI:$MAC_REPO/"

# The rsync just overwrote the Mac's bundles with the LINUX ones. `bare-pack
# --linked` bakes the host addon suffix into the bundle (.so on Linux, .dylib on
# macOS/iOS), so the app would crash at launch on require.addon. Rebuild on macOS.
echo "==> Rebuilding the UI + macOS-flavoured Bare bundle on $MAC_MINI"
ssh "$MAC_MINI" "export PATH=/opt/homebrew/bin:\$PATH LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8; cd $MAC_REPO && npm run build:ui && npm run build:bare"

echo "==> Running driver on $MAC_MINI"
ssh "$MAC_MINI" "cd $MAC_REPO && ${SKIP_BUILD:+SKIP_BUILD=1 }./scripts/ios-screenshots.sh"

echo "==> Pulling PNGs into $OUT_DIR"
mkdir -p "$OUT_DIR"
rsync -az --delete "$MAC_MINI:$MAC_REPO/metadata/ios/screenshots/" "$OUT_DIR/"

# STRIP THE ALPHA CHANNEL. `simctl io screenshot` writes sRGBA even though every pixel is
# opaque, and App Store Connect refuses a screenshot carrying an alpha channel. The frames
# look identical either way, so this is invisible right up until an upload is rejected.
# Done here rather than on the Mac because ImageMagick lives on this side.
if command -v magick >/dev/null 2>&1; then
  echo "==> Stripping alpha (App Store Connect rejects RGBA)"
  find "$OUT_DIR" -name '*.png' -exec magick mogrify -alpha off {} +
fi

echo ""
echo "==> Done. Screenshots in $OUT_DIR"
# PRINT THE DIMENSIONS, because a capture at the wrong SIZE looks exactly like a good one.
# App Store Connect's iPhone slots are 6.9" (1320x2868) and 6.7" (1290x2796); the standing
# PearTune-Test simulator is a 6.3" iPhone 16 Pro and quietly produces 1206x2622, which has no
# slot at all. Cost a full capture cycle on 2026-07-31 before anyone looked at a pixel count.
if command -v magick >/dev/null 2>&1; then
  magick identify -format '%f  %wx%h  %[channels]\n' "$OUT_DIR"/*/*/*.png 2>/dev/null | sort
  echo ""
  echo "    Upload slots: 6.9in = 1320x2868, 6.7in = 1290x2796. Anything else has nowhere to go."
else
  find "$OUT_DIR" -name "*.png" | sort
fi

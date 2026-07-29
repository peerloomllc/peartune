#!/usr/bin/env bash
# Orchestrator for iOS App Store screenshots - run from Linux. Bundles the UI,
# syncs the repo to the Mac mini, runs the simulator screenshot driver there and
# pulls the PNGs back into metadata/ios/screenshots/.
#
# Usage:
#   ./scripts/screenshots.sh                 # full rebuild
#   SKIP_BUILD=1 ./scripts/screenshots.sh    # skip xcodebuild (fixtures-only changes)
#
# READ THIS FIRST. This is the capture harness, and it works. What does NOT exist
# yet is the SCENES it captures: the app has no -screenshotScene handling, so every
# frame this produces today is the same screen the app opens on. See TODO.md ("store
# screenshot scenes") for what the app side needs - a native module plus fixture
# data, the shape of pearguard/android/.../ScreenshotModule.kt and its src/ui/main.jsx
# handling. Until then treat the output as a smoke test of the pipeline, not as
# store assets.

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

echo ""
echo "==> Done. Screenshots in $OUT_DIR"
find "$OUT_DIR" -name "*.png" | sort

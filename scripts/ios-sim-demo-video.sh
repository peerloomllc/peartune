#!/usr/bin/env bash
# Build PearTune for the iPhone Simulator, drive the demo path with XCUITest, and record it.
#
# Produces the App Review demo video (proposal 2026-07-28-app-review-demo) and doubles as the
# only automated iOS UI check we have. Run from the repo root on the dev box:
#
#   bash scripts/ios-sim-demo-video.sh                  # sync, build, record
#   SKIP_BUILD=1 bash scripts/ios-sim-demo-video.sh     # reuse the app already built on the Mac
#
# WHY XCUITEST AND NOT A SHELL SCRIPT. Driving the Simulator from OUTSIDE needs macOS
# Accessibility permission, which an ssh session cannot be granted without someone sitting at
# the machine. XCUITest runs INSIDE the simulator via testmanagerd and needs no such grant.
set -euo pipefail

MAC="${MAC:-tims-mac-mini.local}"
DEST="${DEST:-peartune-ios}"
DRIVER="${DRIVER:-peartune-uitest}"
SIM="${SIM:-47B1C10A-A764-493D-A12A-5FCB1A53695B}"   # "PearTune-Test"; xcrun simctl list devices
OUT="${OUT:-peartune-demo-ios.mp4}"

REMOTE_ENV='export PATH=/opt/homebrew/bin:$PATH LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8;'
APP="~/$DEST/ios/build/sim/Build/Products/Release-iphonesimulator/PearTune.app"

say () { printf '\n== %s ==\n' "$1"; }

if [ -z "${SKIP_BUILD:-}" ]; then
  say "syncing the tree to $MAC"
  rsync -az --exclude '.git' --exclude 'node_modules' --exclude 'android' \
    --exclude 'ios/build' --exclude 'ios/Pods' --exclude 'desktop/dist' \
    --exclude 'desktop/node_modules' --exclude 'host/node_modules' \
    ./ "$MAC:$DEST/"

  # THE ONE THAT COSTS A BUILD. The rsync above just overwrote the Mac's bare bundle with the
  # LINUX one, and `bare-pack --linked` bakes the host addon suffix into it (.so on Linux,
  # .dylib on macOS/iOS). Skipping this rebuild gets you a crash-at-launch inside require.addon
  # that looks nothing like its cause. Same trap ios-device-build.sh documents.
  say "rebuilding the UI + the macOS-flavoured bare bundle ON the Mac"
  ssh -o BatchMode=yes "$MAC" "$REMOTE_ENV cd ~/$DEST && npm run build:ui && npm run build:bare"

  # RELEASE, not Debug: Release embeds the JS and the demo media in the .app, so nothing depends
  # on a Metro server. Simulator builds are ad-hoc signed, so no signing identity is needed.
  say "building PearTune for the simulator"
  ssh -o BatchMode=yes "$MAC" "$REMOTE_ENV cd ~/$DEST/ios && xcodebuild -workspace PearTune.xcworkspace -scheme PearTune -configuration Release -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath build/sim CODE_SIGNING_ALLOWED=NO" | tail -3
fi

say "syncing the UI driver"
rsync -az ios-uitest/ "$MAC:$DRIVER/"

# A CLEAN INSTALL EVERY TIME. The flow starts at the onboarding wall, so a leftover paired (or
# already-demoed) container films the wrong thing entirely.
say "recording"
ssh -o BatchMode=yes "$MAC" "$REMOTE_ENV
  set -e
  rm -f ~/peartune-demo-raw.mp4
  xcrun simctl bootstatus $SIM -b >/dev/null 2>&1 || true
  xcrun simctl uninstall $SIM com.peartune >/dev/null 2>&1 || true
  xcrun simctl install $SIM $APP
  xcrun simctl io $SIM recordVideo --codec h264 --force ~/peartune-demo-raw.mp4 &
  REC=\$!
  sleep 3
  cd ~/$DRIVER
  xcodebuild test -project PearTuneUIDriver.xcodeproj -scheme PearTuneUIDriver \
    -destination 'platform=iOS Simulator,id=$SIM' -derivedDataPath build \
    -only-testing:PearTuneUIDriver/DemoFlow/testRecordDemoFlow > /tmp/peartune-flow.log 2>&1 || true
  sleep 3
  kill -INT \$REC 2>/dev/null || true
  wait \$REC 2>/dev/null || true
  grep -q 'FLOW COMPLETE' /tmp/peartune-flow.log || { echo 'the flow did not finish - see /tmp/peartune-flow.log on the Mac'; exit 1; }
"

say "fetching + trimming"
scp -q "$MAC:peartune-demo-raw.mp4" /tmp/peartune-demo-raw.mp4
# Trim the cold-launch dead time (the worklet boots for ~17s against a blank screen) and halve
# the frame rate - 60fps of a mostly-static UI is bytes nobody watches.
ffmpeg -v error -ss 17 -i /tmp/peartune-demo-raw.mp4 \
  -vf "scale=606:-2,fps=30" -c:v libx264 -preset slow -crf 22 -pix_fmt yuv420p \
  -movflags +faststart "$OUT" -y
rm -f /tmp/peartune-demo-raw.mp4

say "wrote $OUT"
ls -lh "$OUT"

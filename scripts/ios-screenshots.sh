#!/usr/bin/env bash
# iOS App Store screenshot capture - runs ON the Mac mini.
#
# Builds PearTune for the iOS Simulator, then loops scenes x appearances on each
# configured device, launching with -screenshotScene N and capturing PNGs via
# `xcrun simctl io screenshot`. scripts/screenshots.sh drives this from Linux;
# this half is also runnable by hand on the Mac.
#
# Usage (on the Mac mini):
#   cd ~/peartune-ios && ./scripts/ios-screenshots.sh
#   SKIP_BUILD=1 ./scripts/ios-screenshots.sh    # skip xcodebuild, iterate on fixtures
#
# Output: metadata/ios/screenshots/<device-name>/<appearance>/scene-N.png
#
# The app does NOT implement -screenshotScene yet, so every frame is currently the
# same screen. See the header of scripts/screenshots.sh and TODO.md.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Load app config (APP_NAME / BUNDLE_ID / XCODE_WORKSPACE / XCODE_SCHEME /
# IOS_SCREENSHOT_DEVICES)
if [ -f "$REPO_ROOT/scripts/app.conf" ]; then
  set -a; source "$REPO_ROOT/scripts/app.conf"; set +a
fi
: "${APP_NAME:?APP_NAME is not set - check scripts/app.conf}"
: "${BUNDLE_ID:?BUNDLE_ID is not set - check scripts/app.conf}"
XCODE_WORKSPACE="${XCODE_WORKSPACE:-ios/${APP_NAME}.xcworkspace}"
XCODE_SCHEME="${XCODE_SCHEME:-$APP_NAME}"

OUT_DIR="${OUT_DIR:-$REPO_ROOT/metadata/ios/screenshots}"
SCENES=(1 2 3 4 5 6)
# PearTune's UI is dark by design (see the #17140f splash and adaptive icon
# background), so dark is the appearance that represents the app. Add light here
# if the App Store listing ever wants both.
APPEARANCES=(dark)

# Devices from IOS_SCREENSHOT_DEVICES: space-separated "DeviceName|UDID" pairs,
# set in scripts/app.conf. PearTune-Test is the standing simulator on the Mac.
if [ -z "${IOS_SCREENSHOT_DEVICES:-}" ]; then
  echo "Error: IOS_SCREENSHOT_DEVICES is not set - check scripts/app.conf" >&2
  echo "  Format: \"DeviceName|UDID\", space separated. See \`xcrun simctl list devices\`." >&2
  exit 1
fi
read -ra DEVICES <<<"$IOS_SCREENSHOT_DEVICES"

# ── Build ──
# CODE_SIGNING_ALLOWED=NO: a simulator build needs no identity, and asking for
# one over ssh is the errSecInternalComponent trap for no benefit.
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "==> Building for iOS Simulator..."
  cd "$REPO_ROOT"
  xcodebuild -workspace "$XCODE_WORKSPACE" -scheme "$XCODE_SCHEME" \
    -configuration Release \
    -destination "generic/platform=iOS Simulator" \
    -sdk iphonesimulator \
    CODE_SIGNING_ALLOWED=NO 2>&1 | tail -3
fi

APP_PATH=$(ls -d ~/Library/Developer/Xcode/DerivedData/${APP_NAME}-*/Build/Products/Release-iphonesimulator/${APP_NAME}.app 2>/dev/null | head -1)
if [ -z "$APP_PATH" ]; then
  echo "Error: ${APP_NAME}.app not found in DerivedData" >&2
  echo "  If this is the first run, drop SKIP_BUILD=1 so xcodebuild actually builds it." >&2
  exit 1
fi
echo "    App: $APP_PATH"

# The Simulator needs its OWN Bare addon slice. bare-ios.bundle is device arm64;
# a simulator build resolving it dies at launch with ADDON_NOT_FOUND, which reads
# like an app bug and is not one. Warn rather than fail: whether the sim slice is
# needed depends on how the worklet was packed.
if [ ! -f "$REPO_ROOT/assets/bare-ios-sim.bundle" ] && [ -f "$REPO_ROOT/assets/bare-ios.bundle" ]; then
  echo "    Note: no assets/bare-ios-sim.bundle. If the app crashes at launch with"
  echo "          ADDON_NOT_FOUND, that is the missing simulator slice, not an app bug."
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

for dev in "${DEVICES[@]}"; do
  NAME="${dev%%|*}"
  UDID="${dev##*|}"
  echo ""
  echo "==> Device: $NAME ($UDID)"

  # Boot (idempotent)
  xcrun simctl boot "$UDID" 2>/dev/null || true
  xcrun simctl bootstatus "$UDID" -b >/dev/null
  xcrun simctl install "$UDID" "$APP_PATH"

  # Pretty status bar: 9:41, full signal + battery
  xcrun simctl status_bar "$UDID" override \
    --time "9:41" \
    --dataNetwork wifi \
    --wifiMode active --wifiBars 3 \
    --cellularMode active --cellularBars 4 \
    --batteryState charged --batteryLevel 100

  for appearance in "${APPEARANCES[@]}"; do
    xcrun simctl ui "$UDID" appearance "$appearance"
    DARK=0; [ "$appearance" = "dark" ] && DARK=1
    mkdir -p "$OUT_DIR/$NAME/$appearance"
    for scene in "${SCENES[@]}"; do
      echo "    -> $appearance scene $scene"
      xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
      xcrun simctl launch "$UDID" "$BUNDLE_ID" -screenshotScene "$scene" -screenshotDark "$DARK" >/dev/null
      # The first paint waits on the Bare worklet bundle load, which is slow on a
      # cold simulator. 5s is what the sibling apps settled on.
      sleep 5
      xcrun simctl io "$UDID" screenshot "$OUT_DIR/$NAME/$appearance/scene-$scene.png" >/dev/null 2>&1
    done
  done

  xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
  xcrun simctl status_bar "$UDID" clear
done

echo ""
echo "==> Done. PNGs in $OUT_DIR"
find "$OUT_DIR" -name "*.png" | sort

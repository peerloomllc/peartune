#!/usr/bin/env bash
# Build a SIGNED PearTune for a physical iPhone, and install it over USB.
#
# Run from the repo root on the dev box (passwordless ssh to the Mac):
#   bash scripts/ios-device-build.sh            # build + install
#   SKIP_SYNC=1 bash scripts/ios-device-build.sh   # reuse the tree already on the Mac
#
# Everything here was hand-assembled once (2026-07-28) and every step below exists
# because something failed without it. Read the comments before "simplifying" one away.
set -euo pipefail

MAC="${MAC:-tims-mac-mini.local}"
DEST="${DEST:-peartune-ios}"
TEAM="${TEAM:-G79ALD29NA}"          # Apple Distribution: Timothy Hudgins
CONFIG="${CONFIG:-Release}"

# Node is a HOMEBREW install and a non-interactive ssh shell does not get it on PATH,
# so every remote command that touches npm has to prepend this. LANG matters too:
# CocoaPods dies with "Unicode Normalization not appropriate for ASCII-8BIT" when the
# ssh session has no UTF-8 locale, which is the default over ssh.
REMOTE_ENV='export PATH=/opt/homebrew/bin:$PATH LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8;'

say () { printf '\n== %s ==\n' "$1"; }

# THE ONE THAT WILL BITE YOU. codesign needs the login keychain's PRIVATE KEY, and an
# ssh session cannot get at it even while Tim is logged in at the console - the cert
# LISTS fine (find-identity is public info) and then signing dies deep in the build with
# `errSecInternalComponent`, after ~10 minutes of compilation. Fail here instead, with
# the fix, rather than there with a cryptic code.
say "checking the Mac's keychain is usable from ssh"
if ! ssh -o BatchMode=yes "$MAC" 'security show-keychain-info ~/Library/Keychains/login.keychain-db' >/dev/null 2>&1; then
  cat >&2 <<'EOF'
The login keychain on the Mac will not talk to a non-GUI session, so codesign will fail
with errSecInternalComponent late in the build. Run this ON THE MAC (or over your own
ssh), then re-run this script:

  security unlock-keychain -p 'PASSWORD' ~/Library/Keychains/login.keychain-db && security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k 'PASSWORD' ~/Library/Keychains/login.keychain-db

The second command is the one that matters: unlocking alone leaves an ACL that still
demands a UI prompt. set-key-partition-list is what grants codesign non-interactive use.
EOF
  exit 1
fi

if [ -z "${SKIP_SYNC:-}" ]; then
  say "syncing source -> $MAC:$DEST"
  # NO --delete: ios/Pods, node_modules and the running host's data live there too.
  rsync -az \
    --exclude '.git' --exclude 'node_modules' --exclude 'android' \
    --exclude 'ios/build' --exclude 'ios/Pods' --exclude 'desktop/dist' \
    --exclude 'desktop/node_modules' --exclude 'host/node_modules' \
    ./ "$MAC:$DEST/"
fi

# build:bare MUST run on macOS. bare-pack --linked bakes the host addon suffix into the
# bundle (.so on Linux, .dylib on macOS/iOS), so the committed bundle built on the dev
# box is Android-flavoured and an iOS build using it would not resolve its addons.
say "building the UI + the macOS-flavoured bare bundle ON the Mac"
ssh -o BatchMode=yes "$MAC" "$REMOTE_ENV cd ~/$DEST && npm run build:ui && npm run build:bare"

say "pod install"
ssh -o BatchMode=yes "$MAC" "$REMOTE_ENV cd ~/$DEST/ios && pod install"

# Automatic signing + -allowProvisioningUpdates lets Xcode mint the App ID and profile
# for com.peartune on demand, so there is no profile to check in or keep fresh.
say "xcodebuild ($CONFIG, device arm64) - this takes a while"
ssh -o BatchMode=yes "$MAC" "$REMOTE_ENV cd ~/$DEST/ios && xcodebuild -workspace PearTune.xcworkspace -scheme PearTune -configuration $CONFIG -destination 'generic/platform=iOS' -derivedDataPath build/dd -allowProvisioningUpdates DEVELOPMENT_TEAM=$TEAM CODE_SIGN_STYLE=Automatic" \
  > /tmp/peartune-ios-build.log 2>&1 || {
    echo "BUILD FAILED. Errors:" >&2
    grep -oE "error: .{0,160}" /tmp/peartune-ios-build.log | sort -u | head -10 >&2
    echo "(full log: /tmp/peartune-ios-build.log, and on the Mac under ios/build/dd)" >&2
    exit 1
  }
echo "build ok"

# devicectl, not ideviceinstaller: libimobiledevice is not installed on this Mac and
# devicectl ships with Xcode. The device has to be paired and unlocked.
say "installing to the iPhone"
UDID=$(ssh -o BatchMode=yes "$MAC" "xcrun devicectl list devices 2>/dev/null | awk '/iPhone/ {print \$(NF-3); exit}'")
[ -n "$UDID" ] || { echo "no iPhone found by devicectl - is it plugged in, unlocked and trusted?" >&2; exit 1; }
ssh -o BatchMode=yes "$MAC" "$REMOTE_ENV xcrun devicectl device install app --device $UDID ~/$DEST/ios/build/dd/Build/Products/$CONFIG-iphoneos/PearTune.app"

say "done - PearTune is on the iPhone"

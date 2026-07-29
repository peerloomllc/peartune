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

# THE ONE THAT COSTS AN AFTERNOON, so read this before changing anything below it.
#
# codesign over ssh dies with `errSecInternalComponent` at the embed-frameworks phase -
# AFTER all of arm64 has compiled, ~10 minutes in - unless the keychain holding the
# private key is unlocked AND that key's ACL grants codesign non-interactive use.
#
# THE PART THAT WASTED THREE ATTEMPTS (2026-07-28): it is NOT the login keychain. This
# Mac has a dedicated `buildkey.keychain-db` that comes FIRST in the search list, and it
# is the one codesign resolves the identity from. Unlocking login.keychain-db therefore
# changes nothing and fails identically every time. The tell was in plain sight:
# `find-identity -v` lists every identity TWICE, once per keychain.
#
# It has an EMPTY password by convention, shared with pearguard / pearcal / pearcircle /
# SatScream, whose ios-dev-install.sh scripts do exactly this. No secret is needed, and
# nothing here should ever ask Tim for one.
#
# AND the unlock must run in THE SAME ssh invocation as xcodebuild: unlocking is
# session-scoped, so doing it by hand in another terminal does nothing for this script's
# session. That is why $UNLOCK is welded onto the build command rather than run up here.
KEYCHAIN="${KEYCHAIN:-~/Library/Keychains/buildkey.keychain-db}"
UNLOCK="security unlock-keychain -p '' $KEYCHAIN; security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k '' $KEYCHAIN >/dev/null 2>&1 || true;"

say "checking codesign can actually USE the signing key over ssh"
# The only honest test is to SIGN something. `security show-keychain-info` reports "User
# interaction is not allowed" over ssh whether or not the key is reachable, and
# `find-identity` lists certificates, which is public data - both say "fine" right up
# until the build dies. So: sign a throwaway binary, in the same shape as the real thing.
if ! ssh -o BatchMode=yes "$MAC" "$UNLOCK T=\$(mktemp -d); cp /bin/echo \"\$T/probe\"; codesign -f -s 'Apple Development: Timothy Hudgins' \"\$T/probe\" >/dev/null 2>&1; rc=\$?; rm -rf \"\$T\"; exit \$rc"; then
  cat >&2 <<EOF
codesign still cannot use the signing key, so this build would fail at the
embed-frameworks phase after all of arm64 has compiled. Check, in this order:

  1. Does $KEYCHAIN exist, and is the identity in it?
       security find-identity -v -p codesigning $KEYCHAIN
  2. Is it still first in the search list? codesign uses the FIRST match.
       security list-keychains
  3. Has its password stopped being empty? If so, pass KEYCHAIN= or fix the convention
     the sibling apps' scripts share.
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
# NOTE the $UNLOCK prefix: it must run in THIS ssh invocation, not a previous one. See
# the long comment above.
say "xcodebuild ($CONFIG, device arm64) - this takes a while"
ssh -o BatchMode=yes "$MAC" "$REMOTE_ENV $UNLOCK cd ~/$DEST/ios && xcodebuild -workspace PearTune.xcworkspace -scheme PearTune -configuration $CONFIG -destination 'generic/platform=iOS' -derivedDataPath build/dd -allowProvisioningUpdates DEVELOPMENT_TEAM=$TEAM CODE_SIGN_STYLE=Automatic" \
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
# Match the UUID by SHAPE, not by column position. The table is space-aligned with no
# delimiter, so a column index depends on how many words the device NAME and MODEL happen
# to be - "Timothy's iPhone" / "iPhone SE (iPhone12,8)" made $(NF-3) resolve to "(paired)",
# which is non-empty and therefore sails past the guard below and fails at install.
UDID=$(ssh -o BatchMode=yes "$MAC" "xcrun devicectl list devices 2>/dev/null | grep -i iPhone | grep -oE '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}' | head -1")
[ -n "$UDID" ] || { echo "no iPhone found by devicectl - is it plugged in, unlocked and trusted?" >&2; exit 1; }
ssh -o BatchMode=yes "$MAC" "$REMOTE_ENV xcrun devicectl device install app --device $UDID ~/$DEST/ios/build/dd/Build/Products/$CONFIG-iphoneos/PearTune.app"

say "done - PearTune is on the iPhone"

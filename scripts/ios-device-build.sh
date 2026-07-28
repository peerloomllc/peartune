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

# THE ONE THAT WILL BITE YOU, and the part that is easy to get subtly wrong.
#
# codesign needs the login keychain's PRIVATE KEY. An ssh session cannot get at it even
# while Tim is logged in at the console: the cert LISTS fine (find-identity is public
# info) and then signing dies at the embed-frameworks phase with errSecInternalComponent,
# ~10 minutes into the build.
#
# THE SUBTLETY (learned the hard way, 2026-07-28): `security unlock-keychain` only
# unlocks for THE SESSION THAT RUNS IT. Running it by hand in a Terminal on the Mac, or
# in your own separate ssh, does NOTHING for the session this script opens - it gets its
# own security session and finds the keychain locked all over again. The unlock has to
# happen INSIDE the same ssh invocation that runs xcodebuild, which is why it is welded
# to the build command below rather than checked separately up here.
#
# (`set-key-partition-list` IS persistent - it edits the key's ACL in the keychain file -
# so that half only ever needs doing once, and is not repeated here.)
say "checking codesign can actually USE the signing key over ssh"
UNLOCK=''
if [ -n "${KEYCHAIN_PASSWORD:-}" ]; then
  UNLOCK="security unlock-keychain -p '$KEYCHAIN_PASSWORD' ~/Library/Keychains/login.keychain-db &&"
fi
# The only honest test is to sign something. show-keychain-info reports "User interaction
# is not allowed" over ssh whether or not the key is reachable, so it proves nothing.
if ! ssh -o BatchMode=yes "$MAC" "$UNLOCK T=\$(mktemp -d); cp /bin/echo \"\$T/probe\"; codesign -f -s 'Apple Development: Timothy Hudgins' \"\$T/probe\" >/dev/null 2>&1; rc=\$?; rm -rf \"\$T\"; exit \$rc"; then
  cat >&2 <<'EOF'
codesign cannot use the signing key from an ssh session, so this build would fail at the
embed-frameworks phase after all of arm64 has compiled. Two ways forward:

1. Set KEYCHAIN_PASSWORD and re-run this script, so the unlock happens in the same
   session as the build:

     KEYCHAIN_PASSWORD='...' bash scripts/ios-device-build.sh

2. Or run the build ON THE MAC, in a session you unlock yourself, so no password goes
   anywhere near this box. Everything up to the build is already staged there, so it is
   the xcodebuild + devicectl pair joined with &&.

If neither has been done before, the key's ACL also needs opening ONCE (persistent, so
only once ever), from a session that can prompt:

  security set-key-partition-list -S apple-tool:,apple:,codesign: -s ~/Library/Keychains/login.keychain-db
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
UDID=$(ssh -o BatchMode=yes "$MAC" "xcrun devicectl list devices 2>/dev/null | awk '/iPhone/ {print \$(NF-3); exit}'")
[ -n "$UDID" ] || { echo "no iPhone found by devicectl - is it plugged in, unlocked and trusted?" >&2; exit 1; }
ssh -o BatchMode=yes "$MAC" "$REMOTE_ENV xcrun devicectl device install app --device $UDID ~/$DEST/ios/build/dd/Build/Products/$CONFIG-iphoneos/PearTune.app"

say "done - PearTune is on the iPhone"

#!/usr/bin/env bash
# Build PearTune Desktop for macOS (.dmg, arm64 + x64) by driving the mac-mini
# from this Linux box - electron-builder cannot target macOS from Linux. Mirrors
# pearcal-native/electron/scripts/build-mac.sh:
#   1. rsync the repo to the mac-mini
#   2. ssh there: npm install (postinstall re-vendors host/), unlock keychain,
#      electron-builder --mac (SIGNS with the Developer ID; NO notarization)
#   3. rsync the .dmg back to desktop/dist/
#
# SIGNED, HARDENED AND NOTARIZED as of 2026-08-01.
#
# THIS COMMENT USED TO SAY THE OPPOSITE, and it was wrong: "hardenedRuntime is OFF
# because macOS silently blocks LAN connections from hardened-runtime apps that use
# raw sockets (HyperDHT's UDP), so a notarized build would break same-network
# pairing." That claim was inherited from PearCal, repeated into DECISIONS and
# TODO, and steered the desktop release for weeks. It is FALSE, measured twice:
#
#   1. hardened and unhardened hosts side by side - identical, 18 UDP sockets and
#      10 established outbound peers each, dashboard 200 on both;
#   2. an Android phone PAIRED with a hardened, current-code PearTune.app over the
#      LAN - device online, granted by qr-pair, full scope, against a real
#      209-track library.
#
# And build/entitlements.mac.plist already carried everything hardened runtime
# needs (allow-jit, allow-unsigned-executable-memory,
# allow-dyld-environment-variables, network.client, network.server). The flag had
# simply never been flipped. Notarization removes the "unidentified developer"
# prompt permanently, instead of every Mac user right-clicking to open forever.
#
# Usage:  cd desktop && npm run build:mac
# Requires: SSH access to the mac-mini; its buildkey keychain provisioned.

set -euo pipefail
cd "$(dirname "$0")/.."

MAC_HOST="${MAC_MINI_HOST:-Tims-Mac-mini.local}"
REMOTE_DIR="~/peerloomllc/peartune"

echo ">> Syncing repo to $MAC_HOST:$REMOTE_DIR"
# --checksum guards against mtime skips of files we just edited. Exclude
# node_modules/build-output everywhere and the phone-app trees the desktop
# build does not need; vendor/ is regenerated on the Mac by npm's postinstall.
rsync -az --checksum \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='desktop/node_modules' \
  --exclude='desktop/vendor' \
  --exclude='desktop/dist' \
  --exclude='android' \
  --exclude='ios' \
  --exclude='.expo' \
  --exclude='*.bundle' \
  ../ \
  "$MAC_HOST:$REMOTE_DIR/"

# Stage the App Store Connect API key on the Mac so notarytool can run there.
# scripts/.env is the same place release.sh reads these from.
_ENV="$(cd "$(dirname "$0")/../.." && pwd)/scripts/.env"
if [ -f "$_ENV" ]; then set -a; . "$_ENV"; set +a; fi
ASC_TEAM_ID="${ASC_TEAM_ID:-G79ALD29NA}"
_KEY="${ASC_PRIVATE_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8}"
if [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ] && [ -f "$_KEY" ]; then
  echo ">> Staging the notarization key on $MAC_HOST"
  ssh "$MAC_HOST" 'mkdir -p ~/.appstoreconnect/private_keys && chmod 700 ~/.appstoreconnect/private_keys'
  scp -q "$_KEY" "$MAC_HOST:~/.appstoreconnect/private_keys/notarize.p8"
  ssh "$MAC_HOST" 'chmod 600 ~/.appstoreconnect/private_keys/notarize.p8'
else
  echo ">> No App Store Connect key found - the build will be SIGNED BUT NOT NOTARIZED."
  echo "   Set ASC_KEY_ID / ASC_ISSUER_ID / ASC_PRIVATE_KEY_PATH in scripts/.env."
fi

echo ">> Building signed .dmg on $MAC_HOST"
ASC_KEY_ID="${ASC_KEY_ID:-}" ASC_ISSUER_ID="${ASC_ISSUER_ID:-}" ASC_TEAM_ID="${ASC_TEAM_ID:-G79ALD29NA}" ssh "$MAC_HOST" '
  set -euo pipefail
  export PATH="/opt/homebrew/bin:$PATH"
  export LANG=en_US.UTF-8
  # electron-builder dmg-builder shells out to "python"/"python3" (dmgbuild).
  # Apple /usr/bin/python3 has a working pyexpat; Homebrew python can ship one
  # linked against a newer libexpat that dies on "import plistlib" and cascades
  # into a misleading "unable to execute hdiutil" loop. Shim both to the system
  # python for this build session only. (No apostrophes in this remote script -
  # it is single-quoted by the ssh call above.)
  PY3="/usr/bin/python3"
  [ -x "$PY3" ] || PY3="$(command -v python3 || true)"
  if [ -n "$PY3" ]; then
    SHIM_DIR="$(mktemp -d)"
    ln -sf "$PY3" "$SHIM_DIR/python"
    ln -sf "$PY3" "$SHIM_DIR/python3"
    export PATH="$SHIM_DIR:$PATH"
  fi
  security unlock-keychain -p "" ~/Library/Keychains/buildkey.keychain
  # Notarization runs HERE (notarytool is macOS-only), so the App Store Connect API
  # key has to be on this machine. Staged by the caller below into a 0600 file.
  if [ -f ~/.appstoreconnect/private_keys/notarize.p8 ]; then
    export APPLE_API_KEY=~/.appstoreconnect/private_keys/notarize.p8
    export APPLE_API_KEY_ID="'"$ASC_KEY_ID"'"
    export APPLE_API_ISSUER="'"$ASC_ISSUER_ID"'"
    # electron-builder 25 REFUSES notarize.teamId in package.json and wants it here:
    # "Please specify notarization Team ID in the APPLE_TEAM_ID env var instead".
    export APPLE_TEAM_ID="'"$ASC_TEAM_ID"'"
  else
    echo "WARNING: no notarization key staged - the build will be signed but NOT notarized."
  fi
  cd ~/peerloomllc/peartune/desktop
  # Always npm install: near-instant when satisfied, and a guard would silently
  # ship a stale tree when a dep is added. postinstall re-vendors host/.
  npm install --no-audit --no-fund
  ./node_modules/.bin/electron-builder --mac --arm64 --x64 --publish never 2>&1 | tail -60
  setopt nullglob 2>/dev/null || true
  dmgs=(dist/*.dmg)
  [ ${#dmgs[@]} -gt 0 ] || { echo "ERROR: electron-builder produced no .dmg"; exit 1; }
  ls -lh dist/*.dmg
'

echo ">> Pulling the .dmg back to desktop/dist/"
mkdir -p dist
rsync -az "$MAC_HOST:$REMOTE_DIR/desktop/dist/*.dmg" dist/
echo; echo "Done. Artifacts in desktop/dist/:"; ls -lh dist/*.dmg 2>&1

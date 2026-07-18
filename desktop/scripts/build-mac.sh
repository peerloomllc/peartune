#!/usr/bin/env bash
# Build PearTune Desktop for macOS (.dmg, arm64 + x64) by driving the mac-mini
# from this Linux box - electron-builder cannot target macOS from Linux. Mirrors
# pearcal-native/electron/scripts/build-mac.sh:
#   1. rsync the repo to the mac-mini
#   2. ssh there: npm install (postinstall re-vendors host/), unlock keychain,
#      electron-builder --mac (SIGNS with the Developer ID; NO notarization)
#   3. rsync the .dmg back to desktop/dist/
#
# SIGNED with the existing Developer ID, NOT notarized, and hardenedRuntime is
# OFF (package.json#build.mac): macOS silently blocks LAN connections from
# hardened-runtime apps that use raw sockets (HyperDHT's UDP), so a notarized
# build would break same-network pairing. First launch shows the mild
# "unidentified developer" prompt; right-click -> Open once. (Same trade-off as
# PearCal - see its build-mac.sh + feedback_macos_lan_gate_hardened_runtime.)
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

echo ">> Building signed .dmg on $MAC_HOST"
ssh "$MAC_HOST" '
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

#!/usr/bin/env bash
# Build PearTune Desktop for macOS (.dmg, arm64 + x64). MUST run on a Mac -
# electron-builder cannot produce a macOS target from Linux. Run on the mac-mini
# the other PeerLoom apps use. UNSIGNED for v1 (identity: null, notarize: false in
# package.json#build.mac), so the .dmg is Gatekeeper-blocked until signing is wired.
#   Usage (on the Mac): cd desktop && npm install && npm run build:mac
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/prepack.js
./node_modules/.bin/electron-builder --mac --publish never
if ! ls dist/*.dmg >/dev/null 2>&1; then
  echo "ERROR: no .dmg was produced - macOS build failed" >&2; exit 1
fi
echo; echo "Built artifacts in desktop/dist/:"; ls -lh dist/ | grep -E '\.dmg$' || true

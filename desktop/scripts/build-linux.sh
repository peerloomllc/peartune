#!/usr/bin/env bash
# Build PearTune Desktop for Linux (AppImage + .deb) on this box natively.
# Output goes to desktop/dist/.  Usage: cd desktop && npm run build:linux
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/prepack.js
./node_modules/.bin/electron-builder --linux --x64 --publish never
if ! ls dist/*.AppImage >/dev/null 2>&1; then
  echo "ERROR: no AppImage was produced - Linux build failed" >&2; exit 1
fi
echo; echo "Built artifacts in desktop/dist/:"; ls -lh dist/ | grep -E '\.(AppImage|deb)$' || true

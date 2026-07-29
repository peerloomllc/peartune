#!/usr/bin/env bash
# Composite raw Android screenshots into a Pixel 5 Just Black device frame.
# Reads  metadata/android/screenshots/<avd>/<light|dark>/scene-N.png
# writes metadata/android/screenshots/<avd>_Framed/<light|dark>/scene-N.png
#
# scripts/android-screenshots.sh calls this at the end; it is also fine to run on
# its own after re-capturing by hand.
#
# Usage: ./scripts/frame-android-screenshots.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Sourced so this works standalone, not only when android-screenshots.sh exports
# ANDROID_SCREENSHOT_AVDS for us.
if [ -f "$REPO_ROOT/scripts/app.conf" ]; then
  set -a; source "$REPO_ROOT/scripts/app.conf"; set +a
fi

FRAME="$REPO_ROOT/scripts/assets/pixel5-frame.png"
SRC_ROOT="$REPO_ROOT/metadata/android/screenshots"

command -v magick >/dev/null || { echo "ImageMagick 'magick' not found" >&2; exit 1; }
[ -f "$FRAME" ] || { echo "Frame PNG missing: $FRAME" >&2; exit 1; }

read -ra AVDS <<<"${ANDROID_SCREENSHOT_AVDS:?ANDROID_SCREENSHOT_AVDS is not set - check scripts/app.conf}"

for avd in "${AVDS[@]}"; do
  src_dir="$SRC_ROOT/$avd"
  dst_dir="$SRC_ROOT/${avd}_Framed"
  [ -d "$src_dir" ] || { echo "skip $avd (no source)"; continue; }
  for mode in light dark; do
    [ -d "$src_dir/$mode" ] || continue
    mkdir -p "$dst_dir/$mode"
    for src in "$src_dir/$mode"/scene-*.png; do
      [ -f "$src" ] || continue
      dst="$dst_dir/$mode/$(basename "$src")"
      # Resize the capture to the frame's screen aperture, then draw it UNDER the
      # frame (DstOver) so the frame's bezel and rounded corners stay on top. The
      # -7+6 offset is where the aperture sits in this particular frame PNG.
      magick "$FRAME" \
        \( "$src" -resize 1080x -gravity center -crop 1080x2340+0+0 +repage \) \
        -geometry -7+6 -compose DstOver -composite \
        "$dst"
      echo "  framed $dst"
    done
  done
done

#!/usr/bin/env bash
# Build the ffmpeg binaries that ship inside the PearTune desktop installers.
#
# WHY THE DESKTOP NEEDS ITS OWN. The container image has carried a static ffmpeg since
# 0.2.45 (host/Dockerfile), but a desktop install never got one: nothing in
# desktop/package.json bundled a binary and nothing set PEARTUNE_FFMPEG, so
# host/transcode.js fell through to a bare `ffmpeg` on PATH that a normal Mac or Windows
# machine does not have. Every transcode from a desktop host therefore did nothing, and
# an unplayable format degraded to raw bytes the phone cannot decode - silently, as
# "paused forever". That is the 2026-08-14 .wma bug, on every desktop library there is,
# and PR #380 widened it to .ogg on iOS as well.
#
# WHAT COMES OUT: desktop/vendor/ffmpeg/<platform>-<arch>/ffmpeg[.exe], about 4-5MB each,
# audio-only and LGPL-clean. electron-builder stages them into resources/ffmpeg/... and
# host/ffmpeg-bin.js finds them there.
#
# NOT COMMITTED, deliberately - see desktop/vendor/ffmpeg/README.md. They are rebuilt
# when the pinned ffmpeg version changes, which is rarely, and they persist on disk
# between releases. The release build REFUSES to package without them rather than
# quietly shipping the bug back.
#
# Usage: desktop/scripts/ffmpeg/build.sh [all|linux|windows|macos]     (default: all)
#
# Needs podman for linux+windows (rootless, no sudo) and ssh to the Mac for macos.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DESKTOP="$(cd "$HERE/../.." && pwd)"
DEST="$DESKTOP/vendor/ffmpeg"
CACHE="${FFMPEG_SRC_CACHE:-$HOME/.cache/peartune-ffmpeg-src}"
IMAGE=peartune-ffbuild:1
MAC="${MAC_MINI_HOST:-Tims-Mac-mini.local}"
PICK="${1:-all}"

# shellcheck source=sources.env
. "$HERE/sources.env"

fetch () { # url sha filename
  local url="$1" sha="$2" name="$3"
  mkdir -p "$CACHE"
  if [ -f "$CACHE/$name" ] && echo "$sha  $CACHE/$name" | sha256sum -c --status -; then
    return 0
  fi
  echo ">> fetching $name"
  curl -fL --retry 3 -o "$CACHE/$name" "$url"
  # Verified BEFORE anything unpacks it. A moved or replaced tarball must fail here,
  # not silently change what we ship into an installer.
  echo "$sha  $CACHE/$name" | sha256sum -c --status - \
    || { echo "CHECKSUM MISMATCH for $name - refusing" >&2; exit 1; }
}

sources () {
  fetch "$FFMPEG_URL"  "$FFMPEG_SHA"  "ffmpeg-$FFMPEG_VER.tar.xz"
  fetch "$LAME_URL"    "$LAME_SHA"    "lame-$LAME_VER.tar.gz"
  fetch "$OPUS_URL"    "$OPUS_SHA"    "opus-$OPUS_VER.tar.gz"
  fetch "$PKGCONF_URL" "$PKGCONF_SHA" "pkgconf-$PKGCONF_VER.tar.xz"
}

image () {
  if ! podman image exists "$IMAGE" 2>/dev/null; then
    echo ">> building the toolchain image (one time, mingw-w64 is the slow part)"
    podman build -t "$IMAGE" -f "$HERE/Containerfile" "$HERE"
  fi
}

container_target () { # linux-x64 | win32-x64
  image
  mkdir -p "$DEST"
  podman run --rm \
    -v "$CACHE:/src:z" -v "$HERE:/scripts:z" -v "$DEST:/out:z" \
    "$IMAGE" bash /scripts/build-in-container.sh "$1"
}

macos_target () {
  local remote=peartune-ffbuild
  echo ">> macOS slices on $MAC"
  ssh "$MAC" "mkdir -p ~/$remote/src ~/$remote/out"
  scp -q "$CACHE"/ffmpeg-"$FFMPEG_VER".tar.xz "$CACHE"/lame-"$LAME_VER".tar.gz \
         "$CACHE"/opus-"$OPUS_VER".tar.gz "$CACHE"/pkgconf-"$PKGCONF_VER".tar.xz \
         "$MAC:$remote/src/"
  scp -q "$HERE/build-macos.sh" "$MAC:$remote/"
  # Both slices: an arm64-only .dmg installed on an Intel Mac would fall back to PATH
  # and be silent all over again.
  ssh "$MAC" "export PATH=/opt/homebrew/bin:\$PATH; cd $remote && bash build-macos.sh arm64 darwin-arm64"
  ssh "$MAC" "export PATH=/opt/homebrew/bin:\$PATH; cd $remote && bash build-macos.sh x86_64 darwin-x64"
  mkdir -p "$DEST/darwin-arm64" "$DEST/darwin-x64"
  scp -q "$MAC:$remote/out/darwin-arm64/ffmpeg" "$DEST/darwin-arm64/ffmpeg"
  scp -q "$MAC:$remote/out/darwin-x64/ffmpeg"   "$DEST/darwin-x64/ffmpeg"
  chmod +x "$DEST/darwin-arm64/ffmpeg" "$DEST/darwin-x64/ffmpeg"
}

sources
case "$PICK" in
  all)     container_target linux-x64; container_target win32-x64; macos_target ;;
  linux)   container_target linux-x64 ;;
  windows) container_target win32-x64 ;;
  macos)   macos_target ;;
  *) echo "usage: $0 [all|linux|windows|macos]" >&2; exit 1 ;;
esac

echo ""
echo "Built into $DEST:"
find "$DEST" -type f \( -name ffmpeg -o -name ffmpeg.exe \) -printf "  %-46p %s bytes\n" 2>/dev/null \
  || find "$DEST" -type f \( -name ffmpeg -o -name ffmpeg.exe \) -exec ls -la {} \;
echo ""
echo "Verify them with: desktop/scripts/ffmpeg/check.sh"

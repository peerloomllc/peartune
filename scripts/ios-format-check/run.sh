#!/usr/bin/env bash
# Which audio formats does iOS ACTUALLY decode?
#
# This is the tool behind the UNPLAYABLE.ios list in worklet/quality.js. Re-run it when
# iOS majors, when the folder adapter learns a new extension, or whenever someone is
# about to argue from memory about what AVPlayer supports.
#
# WHY IT DECODES RATHER THAN ASKS. A format the player cannot decode does not raise an
# error: the bytes arrive, nothing comes out, and the UI shows "paused" forever. That is
# how the .wma case reached users on 2026-08-14. AVURLAsset.isPlayable is a readback and
# has been wrong here, so decodecheck.swift runs every file through AVAssetReader and
# counts the PCM frames that emerge. One second of audio is ~44100 frames. Zero is the
# answer that matters.
#
# HOW IT RUNS. A command-line binary built against the iphonesimulator SDK and spawned
# INSIDE a booted Simulator, so it resolves codecs against iOS's AudioToolbox rather
# than the Mac's. It needs no app, no host and no pairing.
#
# THE TRAP, and it cost a wrong conclusion the first time: `simctl spawn` does not keep
# the caller's working directory, so a relative path fails for EVERY format identically
# and reads exactly like "iOS decodes nothing". Absolute paths only, which is why the
# loop below builds them. If every row fails, suspect this before suspecting iOS.
#
# Usage: scripts/ios-format-check/run.sh [simulator-name]
set -euo pipefail

SIM="${1:-PearTune-Test}"
MAC="${MAC_MINI_HOST:-Tims-Mac-mini.local}"
REMOTE=fmtcheck
HERE="$(cd "$(dirname "$0")" && pwd)"

# One second of a 440Hz sine in each container the folder adapter indexes
# (host/adapters/folder.js AUDIO_EXT). Built here because the Mac has no ffmpeg.
command -v ffmpeg >/dev/null || { echo "ffmpeg required on this machine" >&2; exit 1; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
gen () { ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=440:duration=1" -ac 2 "$@"; }
gen -ar 44100 -c:a libmp3lame -b:a 192k "$TMP/t.mp3"
gen -ar 44100 -c:a flac              "$TMP/t.flac"
gen -ar 44100 -c:a aac -b:a 192k     "$TMP/t.m4a"
gen -ar 44100 -c:a libvorbis -b:a 192k "$TMP/t.ogg"
gen -ar 48000 -c:a libopus -b:a 128k "$TMP/t.opus"   # libopus takes 48k only
gen -ar 44100 -c:a pcm_s16le         "$TMP/t.wav"
gen -ar 44100 -c:a pcm_s16be         "$TMP/t.aiff"
gen -ar 44100 -c:a wmav2 -b:a 192k   "$TMP/t.wma"

ssh "$MAC" "rm -rf ~/$REMOTE && mkdir -p ~/$REMOTE"
scp -q "$TMP"/* "$HERE/decodecheck.swift" "$MAC:~/$REMOTE/"

ssh "$MAC" "export PATH=/opt/homebrew/bin:\$PATH
  cd ~/$REMOTE
  SDK=\$(xcrun --sdk iphonesimulator --show-sdk-path)
  xcrun -sdk iphonesimulator swiftc -target arm64-apple-ios17.0-simulator -sdk \"\$SDK\" decodecheck.swift -o decodecheck
  xcrun simctl boot '$SIM' 2>/dev/null || true
  xcrun simctl bootstatus '$SIM' -b >/dev/null 2>&1 || true
  D=\$(pwd)
  xcrun simctl spawn '$SIM' ./decodecheck \$D/t.mp3 \$D/t.m4a \$D/t.flac \$D/t.wav \$D/t.aiff \$D/t.ogg \$D/t.opus \$D/t.wma"

echo ""
echo "A row with 0 tracks and 0 frames has NO DECODER on iOS and belongs in"
echo "UNPLAYABLE.ios in worklet/quality.js. Sanity-check mp3 decoded before trusting"
echo "any other row - see the simctl working-directory trap above."

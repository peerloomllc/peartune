#!/usr/bin/env bash
# Prove the bundled ffmpeg binaries actually work, on the platforms they are for.
#
# The failure this guards against is silent by construction: a binary that cannot
# decode a container does not error, the transcode just produces nothing and the host
# degrades to raw bytes the phone cannot play. So do not check that the file exists and
# call it verified - RUN it, on every format host/adapters/folder.js indexes, and look
# at the bytes that come out.
#
# Each binary is exercised on its own platform, never emulated-and-assumed:
#   linux-x64    here
#   darwin-*     on the Mac over ssh (the x64 slice runs under Rosetta there)
#   win32-x64    on a real Windows box if WINDOWS_HOST is reachable, else wine, else
#                SKIPPED LOUDLY - never silently passed
#
# Needs a system ffmpeg HERE to make the fixtures. The bundled binaries cannot make
# their own: they are built --disable-everything, so they have no sine generator.
#
# Usage: desktop/scripts/ffmpeg/check.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$(cd "$HERE/../.." && pwd)/vendor/ffmpeg"
MAC="${MAC_MINI_HOST:-Tims-Mac-mini.local}"
WIN="${WINDOWS_HOST:-}"
FORMATS=(mp3 flac m4a ogg opus wav aiff wma)
FAILED=0

command -v ffmpeg >/dev/null || { echo "need a system ffmpeg here to build the fixtures" >&2; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
gen () { ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=440:duration=1" -ac 2 "$@"; }
gen -ar 44100 -c:a libmp3lame -b:a 192k "$TMP/t.mp3"
gen -ar 44100 -c:a flac                 "$TMP/t.flac"
gen -ar 44100 -c:a aac -b:a 192k        "$TMP/t.m4a"
gen -ar 44100 -c:a libvorbis -b:a 192k  "$TMP/t.ogg"
gen -ar 48000 -c:a libopus -b:a 128k    "$TMP/t.opus"   # libopus takes 48k only
gen -ar 44100 -c:a pcm_s16le            "$TMP/t.wav"
gen -ar 44100 -c:a pcm_s16be            "$TMP/t.aiff"
gen -ar 44100 -c:a wmav2 -b:a 192k      "$TMP/t.wma"

note_fail () { echo "  FAIL: $1"; FAILED=1; }

# Every shipped binary must be LGPL. PearTune is MIT and this ships inside the
# installer, so a GPL build would drag copyleft across the app. Asserted on the binary's
# own banner - the flags used to build it are a readback, the banner is the artifact.
check_licence () { # banner-text label
  if grep -qi -- "--enable-gpl" <<<"$1"; then note_fail "$2 reports --enable-gpl"; return; fi
  if grep -qi -- "--enable-nonfree" <<<"$1"; then note_fail "$2 reports --enable-nonfree"; return; fi
  echo "  licence: LGPL clean"
}

echo "== linux-x64 =="
BIN="$DEST/linux-x64/ffmpeg"
if [ ! -x "$BIN" ]; then note_fail "missing $BIN"; else
  check_licence "$("$BIN" -version 2>&1)" linux-x64
  for f in "${FORMATS[@]}"; do
    n=$("$BIN" -hide_banner -loglevel error -i "$TMP/t.$f" -c:a libmp3lame -b:a 192k -f mp3 - 2>/dev/null | wc -c)
    [ "$n" -gt 1000 ] && printf "  %-5s ok (%d bytes)\n" "$f" "$n" || note_fail "linux-x64 produced $n bytes for .$f"
  done
fi

echo "== darwin-arm64 / darwin-x64 (on $MAC) =="
if ! ssh -o BatchMode=yes -o ConnectTimeout=8 "$MAC" true 2>/dev/null; then
  echo "  SKIPPED - $MAC unreachable. The macOS binaries are NOT verified."
  FAILED=1
else
  ssh "$MAC" 'rm -rf ~/.peartune-ffcheck && mkdir -p ~/.peartune-ffcheck'
  scp -q "$TMP"/t.* "$MAC:.peartune-ffcheck/"
  for arch in darwin-arm64 darwin-x64; do
    [ -x "$DEST/$arch/ffmpeg" ] || { note_fail "missing $DEST/$arch/ffmpeg"; continue; }
    scp -q "$DEST/$arch/ffmpeg" "$MAC:.peartune-ffcheck/ffmpeg-$arch"
    out=$(ssh "$MAC" "cd .peartune-ffcheck && chmod +x ffmpeg-$arch && ./ffmpeg-$arch -version 2>&1 | head -3")
    check_licence "$out" "$arch"
    for f in "${FORMATS[@]}"; do
      n=$(ssh "$MAC" "cd .peartune-ffcheck && ./ffmpeg-$arch -hide_banner -loglevel error -i t.$f -c:a libmp3lame -b:a 192k -f mp3 - 2>/dev/null | wc -c" | tr -d ' ')
      [ "${n:-0}" -gt 1000 ] && printf "  %-14s %-5s ok (%s bytes)\n" "$arch" "$f" "$n" || note_fail "$arch produced ${n:-0} bytes for .$f"
    done
  done
  ssh "$MAC" 'rm -rf ~/.peartune-ffcheck'
fi

echo "== win32-x64 =="
BIN="$DEST/win32-x64/ffmpeg.exe"
if [ ! -f "$BIN" ]; then note_fail "missing $BIN"
elif [ -n "$WIN" ] && ssh -o BatchMode=yes -o ConnectTimeout=8 "$WIN" ver >/dev/null 2>&1; then
  echo "  on real Windows ($WIN)"
  ssh "$WIN" 'if exist %USERPROFILE%\.ffcheck rmdir /s /q %USERPROFILE%\.ffcheck' >/dev/null 2>&1
  ssh "$WIN" 'mkdir %USERPROFILE%\.ffcheck' >/dev/null 2>&1
  scp -q "$BIN" "$TMP"/t.* "$WIN:.ffcheck/"
  check_licence "$(ssh "$WIN" 'cd %USERPROFILE%\.ffcheck && ffmpeg.exe -version' 2>&1 | head -3)" win32-x64
  for f in "${FORMATS[@]}"; do
    ssh "$WIN" "cd %USERPROFILE%\\.ffcheck && ffmpeg.exe -hide_banner -loglevel error -i t.$f -c:a libmp3lame -b:a 192k -y o.mp3" >/dev/null 2>&1
    n=$(ssh "$WIN" 'cd %USERPROFILE%\.ffcheck && for %z in (o.mp3) do @echo %~zz' 2>/dev/null | tr -dc '0-9')
    [ "${n:-0}" -gt 1000 ] && printf "  %-5s ok (%s bytes)\n" "$f" "$n" || note_fail "win32-x64 produced ${n:-0} bytes for .$f"
  done
  ssh "$WIN" 'rmdir /s /q %USERPROFILE%\.ffcheck' >/dev/null 2>&1
elif command -v wine >/dev/null; then
  echo "  no WINDOWS_HOST reachable - falling back to wine (weaker, but real execution)"
  export WINEDEBUG=-all
  check_licence "$(wine "$BIN" -version 2>/dev/null | head -3)" win32-x64
  for f in "${FORMATS[@]}"; do
    n=$(wine "$BIN" -hide_banner -loglevel error -i "$TMP/t.$f" -c:a libmp3lame -b:a 192k -f mp3 - 2>/dev/null | wc -c)
    [ "$n" -gt 1000 ] && printf "  %-5s ok (%d bytes)\n" "$f" "$n" || note_fail "win32-x64 produced $n bytes for .$f"
  done
else
  echo "  SKIPPED - no Windows host and no wine. The Windows binary is NOT verified."
  FAILED=1
fi

echo ""
[ "$FAILED" = 0 ] && echo "ALL CHECKS PASSED" || echo "SOMETHING FAILED OR WAS SKIPPED - see above"
exit "$FAILED"

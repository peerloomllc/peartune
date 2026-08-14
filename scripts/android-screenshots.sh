#!/usr/bin/env bash
# Android Play Store screenshot capture - runs on Linux, on an EMULATOR.
#
# Boots each configured AVD, installs the debug APK, loops scenes x appearances
# launching MainActivity with intent extras, and captures PNGs via
# `adb exec-out screencap`. Finishes by compositing each PNG into a device frame.
#
# Usage:
#   ./scripts/android-screenshots.sh                 # full rebuild
#   SKIP_BUILD=1 ./scripts/android-screenshots.sh    # skip gradle (fixtures-only)
#
# Output: metadata/android/screenshots/<avd>/<light|dark>/scene-N.png
#         metadata/android/screenshots/<avd>_Framed/<light|dark>/scene-N.png
#
# The app reads the screenshotScene extra and routes to that scene's screen
# (src/ui/screenshot.js). It needs the fixture too - see scripts/screenshots.sh.
#
# Emulator, not a phone, per the suite-wide rule 15 - and it must stay that way
# for this script: it wipes data and drives taps, which is exactly what must never
# touch the Pixel.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -f "$REPO_ROOT/scripts/app.conf" ]; then
  set -a; source "$REPO_ROOT/scripts/app.conf"; set +a
fi
: "${ANDROID_APP_ID:?ANDROID_APP_ID is not set - check scripts/app.conf}"
APP_ID="$ANDROID_APP_ID"
MAIN_ACTIVITY="${ANDROID_MAIN_ACTIVITY:?ANDROID_MAIN_ACTIVITY is not set - check scripts/app.conf}"
APK_PATH="${APK_PATH:-$REPO_ROOT/android/app/build/outputs/apk/debug/app-debug.apk}"

OUT_DIR="${OUT_DIR:-$REPO_ROOT/metadata/android/screenshots}"
# The album data + inlined covers every scene renders from. Gitignored (real album art), built by
# scripts/screenshot-fixture.sh then scripts/screenshot-fixture-pack.js.
FIXTURE="${FIXTURE:-$REPO_ROOT/metadata/screenshot-fixtures/pack.json}"
SCENES=(1 2 3 4 5 6)
# Dark only: PearTune's UI is dark by design. Add light here if the Play listing
# ever wants both.
APPEARANCES=(dark)

# AVDs from ANDROID_SCREENSHOT_AVDS (space-separated, set in scripts/app.conf).
# Play requires at least one phone form factor.
read -ra AVDS <<<"${ANDROID_SCREENSHOT_AVDS:?ANDROID_SCREENSHOT_AVDS is not set - check scripts/app.conf}"

# The emulator is x86_64 while the phones are arm64. A debug APK built for arm64
# alone installs but has no native slice the emulator can run, and a
# bare-universal.bundle without the x64 slice is the ADDON_NOT_FOUND
# crash-at-launch - not an app bug. So build x86_64 here, explicitly.
#
# This leaves android/app/build/ holding an x86_64 APK. Rebuild before touching a
# phone: `cd android && ./gradlew assembleDebug -PreactNativeArchitectures=arm64-v8a`.
EMULATOR_ABI="${EMULATOR_ABI:-x86_64}"

SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Android/Sdk}}"
EMULATOR="$SDK_ROOT/emulator/emulator"
ADB="$SDK_ROOT/platform-tools/adb"
[ -x "$EMULATOR" ] || { echo "Error: emulator not found at $EMULATOR" >&2; exit 1; }
[ -x "$ADB" ] || { echo "Error: adb not found at $ADB" >&2; exit 1; }

# ── Build ──
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "==> Bundling UI"
  cd "$REPO_ROOT"
  npm run build:ui 2>&1 | tail -2

  echo "==> Building debug APK (ABI: $EMULATOR_ABI)"
  (cd android && ./gradlew assembleDebug -PreactNativeArchitectures="$EMULATOR_ABI") 2>&1 | tail -3
fi

[ -f "$APK_PATH" ] || { echo "Error: APK not found at $APK_PATH" >&2; exit 1; }
echo "    APK: $APK_PATH"

# FAIL HERE, not at the end. Without the fixture the app does not error - it falls through to its
# real self, which on a wiped emulator is the pairing wall, and the run completes with six
# perfectly good screenshots of the wrong thing.
if [ ! -f "$FIXTURE" ]; then
  echo "Error: no fixture at $FIXTURE" >&2
  echo "  Build one: ./scripts/screenshot-fixture.sh <genre> && node scripts/screenshot-fixture-pack.js" >&2
  exit 1
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

wait_for_boot() {
  local serial="$1"
  "$ADB" -s "$serial" wait-for-device
  local i=0
  until [ "$("$ADB" -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
    sleep 2; i=$((i+1)); [ $i -gt 90 ] && { echo "boot timeout" >&2; return 1; }
  done
  # Unlock and dismiss keyguard
  "$ADB" -s "$serial" shell input keyevent 82 >/dev/null 2>&1 || true
  "$ADB" -s "$serial" shell wm dismiss-keyguard >/dev/null 2>&1 || true
}

enable_demo_mode() {
  local serial="$1"
  "$ADB" -s "$serial" shell settings put global sysui_demo_allowed 1 >/dev/null
  "$ADB" -s "$serial" shell am broadcast -a com.android.systemui.demo -e command enter >/dev/null
  "$ADB" -s "$serial" shell am broadcast -a com.android.systemui.demo -e command clock -e hhmm 0941 >/dev/null
  "$ADB" -s "$serial" shell am broadcast -a com.android.systemui.demo -e command battery -e level 100 -e plugged false >/dev/null
  "$ADB" -s "$serial" shell am broadcast -a com.android.systemui.demo -e command network -e wifi show -e level 4 >/dev/null
  # `-e datatype none` is meant to drop the data-type letters and this system image prints "3G"
  # anyway - a poor look on a 2026 listing. Left as-is deliberately: `-e mobile hide` was tried and
  # is WORSE (two wifi glyphs, both with the no-internet "!"). Needs a proper pass over the demo
  # broadcasts, not a one-word swap. See TODO.md.
  "$ADB" -s "$serial" shell am broadcast -a com.android.systemui.demo -e command network -e mobile show -e datatype none -e level 4 >/dev/null
  "$ADB" -s "$serial" shell am broadcast -a com.android.systemui.demo -e command notifications -e visible false >/dev/null
}

disable_demo_mode() {
  local serial="$1"
  "$ADB" -s "$serial" shell am broadcast -a com.android.systemui.demo -e command exit >/dev/null 2>&1 || true
}

for avd in "${AVDS[@]}"; do
  echo ""
  echo "==> AVD: $avd"

  # Kill existing emulator instances to avoid AVD-in-use conflicts. Matches only
  # emulator-* serials, so a USB-attached phone is never touched.
  for s in $("$ADB" devices | awk '/^emulator-[0-9]+/ {print $1}'); do
    "$ADB" -s "$s" emu kill >/dev/null 2>&1 || true
  done
  sleep 3
  existing_serials=$("$ADB" devices | awk '/^emulator-[0-9]+/ {print $1}')
  "$EMULATOR" -avd "$avd" -no-snapshot -no-audio -no-boot-anim \
    -wipe-data -partition-size 4096 \
    -netdelay none -netspeed full >/tmp/emu-$avd.log 2>&1 &
  EMU_PID=$!

  # Find the new serial
  SERIAL=""
  for i in $(seq 1 60); do
    sleep 2
    current=$("$ADB" devices | awk '/^emulator-[0-9]+/ {print $1}')
    for s in $current; do
      if ! grep -qx "$s" <<<"$existing_serials"; then SERIAL="$s"; break; fi
    done
    [ -n "$SERIAL" ] && break
  done
  [ -n "$SERIAL" ] || { echo "emulator did not appear (see /tmp/emu-$avd.log)" >&2; kill $EMU_PID 2>/dev/null || true; exit 1; }
  echo "    Serial: $SERIAL"

  wait_for_boot "$SERIAL"
  sleep 3
  # CHECK THE INSTALL, and never send it to /dev/null. `adb install` prints "Failure ..." and
  # still EXITS ZERO, so `set -e` does not catch it and the run continues against WHATEVER APK
  # was already on that emulator. Cost on 2026-08-12: five capture runs, ~40 minutes, all six
  # frames identical every time while three separate code fixes were "not working" - because
  # none of them was ever on the device. The same failure (INSTALL_FAILED_INSUFFICIENT_STORAGE,
  # behind a Java stack trace) had already been seen once that morning.
  _install_out=$("$ADB" -s "$SERIAL" install -r "$APK_PATH" 2>&1 || true)
  if ! printf '%s' "$_install_out" | grep -q "Success"; then
    echo "Error: APK install failed - the run would have captured a STALE app" >&2
    printf '%s\n' "$_install_out" | tail -5 >&2
    exit 1
  fi
  echo "    Installed: $(basename "$APK_PATH")"
  # Pre-grant runtime permissions so the app shows no system dialogs. CAMERA is
  # the pairing QR scanner; POST_NOTIFICATIONS is the playback notification.
  for perm in \
    android.permission.POST_NOTIFICATIONS \
    android.permission.CAMERA; do
    "$ADB" -s "$SERIAL" shell pm grant "$APP_ID" "$perm" >/dev/null 2>&1 || true
  done
  enable_demo_mode "$SERIAL"

  # Warm up: the first cold launch is slow (Bare worklet bundle load). Run once
  # and wait so subsequent scene launches start from a warm filesystem cache.
  "$ADB" -s "$SERIAL" shell am start -n "$MAIN_ACTIVITY" >/dev/null
  sleep 20
  "$ADB" -s "$SERIAL" shell am force-stop "$APP_ID" >/dev/null

  # Hand the app its fixture, into the private dir expo-file-system calls documentDirectory. AFTER
  # the warm-up launch, which is what creates files/. Base64 over stdin rather than a push through
  # /sdcard: scoped storage means run-as cannot read /sdcard back, and a binary pipe through
  # `adb shell` mangles bytes - this arrives byte-identical.
  base64 -w0 "$FIXTURE" | "$ADB" -s "$SERIAL" shell \
    "run-as $APP_ID sh -c 'mkdir -p files && base64 -d > files/screenshot-fixture.json'"
  # Positive control. A silent truncation here reads downstream as "the app has no library", which
  # looks exactly like a scene that failed to route - so prove the bytes landed before capturing.
  want=$(wc -c <"$FIXTURE" | tr -d ' ')
  # sh -c, or the redirect is resolved by the DEVICE shell (cwd /) instead of inside run-as.
  got=$("$ADB" -s "$SERIAL" shell "run-as $APP_ID sh -c 'wc -c < files/screenshot-fixture.json'" | tr -d ' \r')
  [ "$got" = "$want" ] || { echo "Error: fixture landed as $got bytes, expected $want" >&2; exit 1; }
  echo "    Fixture: $want bytes -> $APP_ID files/screenshot-fixture.json"

  for appearance in "${APPEARANCES[@]}"; do
    DARK_BOOL=false; DARK=0
    [ "$appearance" = "dark" ] && { DARK_BOOL=true; DARK=1; }
    if [ "$appearance" = "dark" ]; then
      "$ADB" -s "$SERIAL" shell cmd uimode night yes >/dev/null
    else
      "$ADB" -s "$SERIAL" shell cmd uimode night no >/dev/null
    fi
    # Let the uimode change settle, then warm-up launch in the new mode so the
    # first real capture below is not racing an activity recreate.
    sleep 3
    "$ADB" -s "$SERIAL" shell am force-stop "$APP_ID" >/dev/null
    "$ADB" -s "$SERIAL" shell am start -n "$MAIN_ACTIVITY" >/dev/null
    sleep 15
    "$ADB" -s "$SERIAL" shell am force-stop "$APP_ID" >/dev/null
    mkdir -p "$OUT_DIR/$avd/$appearance"
    for scene in "${SCENES[@]}"; do
      echo "    -> $appearance scene $scene"
      attempt=0
      while :; do
        attempt=$((attempt+1))
        "$ADB" -s "$SERIAL" shell am force-stop "$APP_ID" >/dev/null
        sleep 1
        "$ADB" -s "$SERIAL" shell am start -n "$MAIN_ACTIVITY" \
          --ei screenshotScene "$scene" --ez screenshotDark "$DARK_BOOL" >/dev/null
        sleep 20
        # Verify our activity is actually in the foreground. Launcher-home
        # instead of the app means a crash or a race, so retry.
        top=$("$ADB" -s "$SERIAL" shell dumpsys activity activities \
              | tr -d '\r' | grep -E "ResumedActivity|mResumedActivity" | head -1)
        if echo "$top" | grep -q "$APP_ID/"; then break; fi
        if [ $attempt -ge 3 ]; then
          echo "      ! foreground check failed after $attempt attempts; capturing anyway"
          break
        fi
        echo "      ! not foreground (got: $top) - retrying"
      done
      "$ADB" -s "$SERIAL" exec-out screencap -p > "$OUT_DIR/$avd/$appearance/scene-$scene.png"
    done
  done

  "$ADB" -s "$SERIAL" shell am force-stop "$APP_ID" >/dev/null || true
  disable_demo_mode "$SERIAL"
  "$ADB" -s "$SERIAL" emu kill >/dev/null 2>&1 || true
  wait $EMU_PID 2>/dev/null || true
done

# ── Make them uploadable ────────────────────────────────────────────────────
#
# TWO THINGS PLAY REJECTS THAT LOOK PERFECTLY FINE ON SCREEN, both found 2026-07-31 with six
# good captures already in hand:
#
#   1. ASPECT RATIO. Play requires the long side to be at most TWICE the short side. A modern
#      phone screenshot is 1080x2424, i.e. 2.24 - so every frame a real device produces is out
#      of spec. Padded rather than cropped: cropping 264px off the bottom would eat the app's
#      own navbar, and the pad colour is #17140f, which IS the app's background (sampled from
#      the frame edge), so the bars are invisible.
#   2. ALPHA. screencap writes RGBA even though every pixel is opaque. Play takes 24-bit PNG
#      with no alpha, the same trap as App Store Connect.
if command -v magick >/dev/null 2>&1; then
  echo ""
  echo "==> Making the captures uploadable (pad to <=2:1, strip alpha)"
  find "$OUT_DIR" -path '*_Framed*' -prune -o -name '*.png' -print | while read -r f; do
    W=$(magick identify -format '%w' "$f"); H=$(magick identify -format '%h' "$f")
    # Widen (or heighten) just enough to reach 2:1, keeping the capture untouched in the middle.
    MINW=$(( (H + 1) / 2 )); [ "$W" -ge "$MINW" ] && MINW=$W
    magick "$f" -background '#17140f' -gravity center -extent "${MINW}x${H}" -alpha off -colorspace sRGB "PNG24:$f"
  done
  magick identify -format '    %f  %wx%h  %[channels]\n' "$OUT_DIR"/*/*/*.png 2>/dev/null | grep -v _Framed | sort
  echo "    Play limits: each side 320-3840px, long side <= 2x short side, 24-bit PNG, no alpha."
fi

echo ""
echo "==> Framing screenshots"
ANDROID_SCREENSHOT_AVDS="$ANDROID_SCREENSHOT_AVDS" "$REPO_ROOT/scripts/frame-android-screenshots.sh"

echo ""
echo "==> Done. PNGs in $OUT_DIR"
find "$OUT_DIR" -name "*.png" | sort

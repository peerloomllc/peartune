#!/bin/bash
# PearTune Desktop - macOS uninstaller.
#
# macOS was the one platform with no uninstall path at all. Linux has the .deb's
# postrm plus `peartune-desktop --uninstall-service`; Windows has the NSIS
# uninstaller. On a Mac, "uninstalling" meant dragging the app to the Trash and
# silently leaving four things behind:
#
#   app             /Applications/PearTune.app
#   login item      "PearTune" (the app registers one on first launch)
#   Electron cache  ~/Library/Application Support/peartune-desktop/{Cache,GPUCache,…}
#   THE LIBRARY     ~/Library/Application Support/peartune-desktop/data
#
# THE LAST ONE IS THE WHOLE REASON THIS ASKS BEFORE ACTING. `data/host.seed` is the
# library's identity - the key every paired phone knows it by - and `data/store` is
# the grant list of who may connect. Nothing regenerates either. Deleting them does
# not "reset" PearTune; it makes this machine a DIFFERENT library that none of your
# phones recognise, with no error and no way back short of a backup.
#
# So the library is KEPT by default, and a reinstall stays the same library with the
# same pairings. --purge wipes it (after taking a verified backup), --keep forces the
# default, and with neither on an interactive terminal you are asked.
#
# Needs no root: everything it touches is in the user's own home or /Applications.
#
#   bash uninstall.sh              # remove the app, keep the library
#   bash uninstall.sh --purge      # remove everything, backing the library up first
#   bash uninstall.sh --keep       # never prompt, always keep

set -uo pipefail

APP="/Applications/PearTune.app"

# RE-EXEC FROM /tmp IF WE LIVE INSIDE THE APP WE ARE ABOUT TO DELETE. This script
# ships in PearTune.app/Contents/Resources, and bash re-reads the script file as it
# executes - so removing the bundle mid-run would truncate the rest of this file and
# leave the login item and caches behind, having already deleted the app. Copy out
# and hand over before touching anything.
case "$0" in
  "$APP"/*)
    TMP=$(mktemp /tmp/peartune-uninstall.XXXXXX) || exit 1
    cp "$0" "$TMP" && chmod +x "$TMP"
    exec /bin/bash "$TMP" "$@"
    ;;
esac
SUPPORT="$HOME/Library/Application Support/peartune-desktop"
DATA="$SUPPORT/data"
SEED="$DATA/host.seed"

PURGE=""
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    --keep)  PURGE=0 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
  esac
done

say () { echo "==> $*"; }

# ---------------------------------------------------------------------------
# 1. Stop it. A running app holds its files open, and on a reinstall the old one
#    would still be serving on 8741 while the new one fails to bind.
# ---------------------------------------------------------------------------
say "Stopping PearTune"
osascript -e 'quit app "PearTune"' 2>/dev/null
sleep 3
pkill -f "/Applications/PearTune.app" 2>/dev/null
sleep 1
if lsof -nP -iTCP:8741 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "    WARNING: something is still listening on 8741."
  echo "    If you also run the host from source or a terminal, stop that too."
fi

# ---------------------------------------------------------------------------
# 2. The login item. The app registers one on first launch (setLoginItemSettings),
#    so removing only the .app leaves macOS trying to start something that is gone.
# ---------------------------------------------------------------------------
say "Removing the login item"
osascript -e 'tell application "System Events" to delete login item "PearTune"' 2>/dev/null \
  && echo "    removed" || echo "    (none found)"

# ---------------------------------------------------------------------------
# 3. The app itself.
# ---------------------------------------------------------------------------
if [ -d "$APP" ]; then
  say "Removing $APP"
  rm -rf "$APP"
else
  say "No app at $APP (already removed?)"
fi

# ---------------------------------------------------------------------------
# 4. The library. Everything above is replaceable; this is not.
# ---------------------------------------------------------------------------
if [ ! -e "$SUPPORT" ]; then
  say "No PearTune data to consider - done."
  exit 0
fi

if [ -z "$PURGE" ]; then
  if [ -t 0 ]; then
    echo
    echo "  Your library lives in:"
    echo "    $DATA"
    echo "  It holds host.seed - the identity every paired phone knows this library by -"
    echo "  and the list of who has access. Deleting it does NOT reset PearTune: it makes"
    echo "  this machine a different library that none of your phones recognise."
    echo
    read -r -p "  Delete the library too? [y/N] " reply
    case "$reply" in [yY]*) PURGE=1 ;; *) PURGE=0 ;; esac
  else
    PURGE=0   # non-interactive: never destroy data nobody confirmed
  fi
fi

if [ "$PURGE" = "1" ]; then
  if [ -f "$SEED" ]; then
    ARCHIVE="$HOME/peartune-library-backup-$(date -u +%Y%m%d-%H%M%S).tar.gz"
    say "Backing the library up first"
    tar -czf "$ARCHIVE" -C "$(dirname "$SUPPORT")" "$(basename "$SUPPORT")" 2>/dev/null
    # Count the seed INSIDE the archive. tar exiting 0 is not the same claim as
    # "the identity is in the backup", and this is the last moment it exists.
    if [ "$(tar -tzf "$ARCHIVE" 2>/dev/null | grep -c 'host\.seed$')" -lt 1 ]; then
      echo "    REFUSING to delete: host.seed is not in the backup. Your library is untouched."
      exit 1
    fi
    echo "    $ARCHIVE"
    echo "    restore with: tar -xzf \"$ARCHIVE\" -C ~/Library/Application\\ Support/"
  fi
  say "Removing $SUPPORT"
  rm -rf "$SUPPORT"
else
  # Keep the library, but the Electron caches are pure junk on a reinstall.
  say "Keeping your library; clearing caches only"
  for c in Cache GPUCache "Code Cache" DawnGraphiteCache DawnWebGPUCache blob_storage Crashpad; do
    rm -rf "$SUPPORT/$c"
  done
  echo "    library kept at $DATA"
fi

echo
say "Done. PearTune is uninstalled."
[ "$PURGE" = "1" ] || echo "    Reinstalling will pick up the same library and its pairings."

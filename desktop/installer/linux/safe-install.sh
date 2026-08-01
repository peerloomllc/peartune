#!/bin/bash
# Install (or upgrade to) the PearTune desktop .deb on a Linux box, without ever
# risking the library's identity.
#
#   sudo ./safe-install.sh /path/to/peartune-desktop_<version>_amd64.deb
#
# WHY THIS IS A SCRIPT AND NOT TWO COMMANDS. ~/.config/peartune-desktop/data holds
# host.seed - the key every paired phone knows this library by - and store/, the
# grant list of who may connect. NOTHING REGENERATES EITHER. A box that comes back
# with a fresh seed looks perfectly healthy and is, to every phone that ever paired
# with it, a different library. So the data dir is archived BEFORE anything stops,
# the archive is checked for host.seed rather than trusting that tar exited 0, and
# the seed's digest is compared again at the end. Same discipline as
# host/deploy/retire-umbrel-container.sh, for the same reason.
#
# It also handles the case this was written for: a box already running PearTune
# some other way (a hand-rolled unit, a login item, a bare AppImage). That process
# holds port 8741 AND the data dir, so it has to stop before the packaged service
# starts - and a stopped unit and a free port are different claims, so both get
# checked.

set -euo pipefail

DEB="${1:-}"
UNIT=peartune-host.service

if [ -z "$DEB" ] || [ ! -f "$DEB" ]; then
  echo "usage: sudo $0 /path/to/peartune-desktop_<version>_amd64.deb" >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "This needs root to install the package: sudo $0 $DEB" >&2
  exit 1
fi

TARGET_USER="${SUDO_USER:-}"
if [ -z "$TARGET_USER" ] || [ "$TARGET_USER" = "root" ]; then
  echo "Run this with sudo from your normal login, not as root directly -" >&2
  echo "the service is a systemd USER unit and needs to know whose." >&2
  exit 1
fi

HOME_DIR=$(getent passwd "$TARGET_USER" | cut -d: -f6)
UID_N=$(id -u "$TARGET_USER")
DATA="$HOME_DIR/.config/peartune-desktop/data"
STAMP=$(date -u +%Y%m%d-%H%M%S)
ARCHIVE="$HOME_DIR/peartune-data-backup-$STAMP.tar.gz"
RUN="runuser -u $TARGET_USER --"

say () { echo "==> $*"; }

# ---------------------------------------------------------------------------
# 1. Archive the library BEFORE anything is stopped or replaced.
# ---------------------------------------------------------------------------
SEED_BEFORE=""
if [ -d "$DATA" ]; then
  say "Archiving the existing library to $ARCHIVE"
  tar -czf "$ARCHIVE" -C "$(dirname "$DATA")" "$(basename "$DATA")"
  chown "$TARGET_USER:$TARGET_USER" "$ARCHIVE"

  # Count host.seed INSIDE the archive. `tar` exiting 0 is not the same claim as
  # "the identity is in the backup".
  if [ "$(tar -tzf "$ARCHIVE" | grep -c 'host\.seed$')" -lt 1 ]; then
    echo "REFUSING: host.seed is not in the archive. Nothing has been changed." >&2
    exit 1
  fi
  SEED_BEFORE=$(sha256sum "$DATA/host.seed" | cut -d' ' -f1)
  say "Backup verified: host.seed present (sha ${SEED_BEFORE:0:12}), $(du -sh "$ARCHIVE" | cut -f1)"
else
  say "No existing library at $DATA - this is a fresh install."
fi

# ---------------------------------------------------------------------------
# 2. Stop whatever is serving now. It holds both the port and the data dir.
# ---------------------------------------------------------------------------
if [ -f "$HOME_DIR/.config/systemd/user/$UNIT" ]; then
  cp -a "$HOME_DIR/.config/systemd/user/$UNIT" "$HOME_DIR/$UNIT.before-$STAMP"
  chown "$TARGET_USER:$TARGET_USER" "$HOME_DIR/$UNIT.before-$STAMP"
  say "Existing unit saved to ~/$UNIT.before-$STAMP"
fi

export XDG_RUNTIME_DIR="/run/user/$UID_N"
$RUN systemctl --user stop "$UNIT" 2>/dev/null || true

# A tray app or a bare AppImage is not a unit and will not have stopped above.
pkill -u "$TARGET_USER" -f 'peartune-desktop' 2>/dev/null || true
sleep 2

# A stopped unit and a free port are different claims. Only the second one
# predicts whether the packaged service can actually start.
for _ in 1 2 3 4 5; do
  ss -ltn 2>/dev/null | grep -q '127.0.0.1:8741' || break
  sleep 1
done
if ss -ltn 2>/dev/null | grep -q '127.0.0.1:8741'; then
  echo "REFUSING: something is still listening on 8741. Your backup is at $ARCHIVE." >&2
  exit 1
fi
say "Port 8741 is free."

# ---------------------------------------------------------------------------
# 3. Install. The package's postinst writes the user unit, enables linger and
#    starts the service, all for $SUDO_USER - which is why this runs under sudo
#    from a normal login rather than as root directly.
# ---------------------------------------------------------------------------
say "Installing $(basename "$DEB")"
dpkg -i "$DEB" || { echo "dpkg failed. Your backup is at $ARCHIVE." >&2; exit 1; }

# ---------------------------------------------------------------------------
# 4. Report what is actually true, not what we hope is true.
# ---------------------------------------------------------------------------
sleep 5
echo
say "RESULT"
echo "  unit enabled : $($RUN systemctl --user is-enabled $UNIT 2>&1 || true)"
echo "  unit active  : $($RUN systemctl --user is-active $UNIT 2>&1 || true)"
echo "  linger       : $(loginctl show-user "$TARGET_USER" -p Linger --value 2>/dev/null || echo unknown)"
echo "  dashboard    : HTTP $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8741/ || echo 'no answer')"

if [ -n "$SEED_BEFORE" ]; then
  SEED_AFTER=$(sha256sum "$DATA/host.seed" 2>/dev/null | cut -d' ' -f1 || echo missing)
  if [ "$SEED_AFTER" = "$SEED_BEFORE" ]; then
    echo "  identity     : UNCHANGED (sha ${SEED_AFTER:0:12}) - paired phones still know this library"
  else
    echo "  identity     : *** CHANGED *** was ${SEED_BEFORE:0:12}, now ${SEED_AFTER:0:12}"
    echo "                 restore with: tar -xzf $ARCHIVE -C $(dirname "$DATA")"
  fi
fi
echo "  backup       : $ARCHIVE"
echo
say "Now reboot WITHOUT logging in. That is the only real proof it is always-on."

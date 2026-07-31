#!/bin/bash
# Debian postinst fragment - installs and starts the PearTune host as a systemd
# USER service for the person who ran the install. dpkg runs this as root, and
# $SUDO_USER names the human behind `sudo apt install` / `sudo dpkg -i`.
#
# Modelled on pearcircle/seeder-launcher/installer/linux/deb/postinst, minus the
# privileged auto-updater and the open-the-dashboard step (neither exists yet
# here - see proposals/2026-07-31-desktop-update-apply.md).
#
# NOTHING IN HERE MAY FAIL THE INSTALL. A headless box, an unusual init, a user
# whose session has not materialised yet - none of that is a reason to leave the
# package half-configured, so every step that can fail is best-effort and the
# script exits 0. The app still works as a tray/login-item exactly as before; it
# just is not supervised.

set -e

INSTALL_ROOT=/opt/PearTune
BIN="$INSTALL_ROOT/peartune-desktop"
HOST_ENTRY="$INSTALL_ROOT/resources/app.asar/vendor/host/index.js"
UNIT_SRC="$INSTALL_ROOT/resources/peartune-host.service"
UNIT_NAME=peartune-host.service

# Resolve the human install user. A GUI software centre goes through PackageKit
# and sets no SUDO_USER; so does an unattended upgrade. In that case we install
# nothing and say how to do it by hand, rather than guessing at a user.
TARGET_USER="${SUDO_USER:-}"
if [ -z "$TARGET_USER" ] || [ "$TARGET_USER" = "root" ]; then
  echo "peartune: no non-root install user detected; skipping service setup."
  echo "  To run PearTune as an always-on service, as your normal user:"
  echo "    peartune-desktop --install-service"
  exit 0
fi

if [ ! -f "$UNIT_SRC" ] || [ ! -x "$BIN" ]; then
  echo "peartune: install layout not as expected; skipping service setup."
  exit 0
fi

TARGET_HOME=$(getent passwd "$TARGET_USER" | cut -d: -f6)
TARGET_UID=$(id -u "$TARGET_USER")
UNIT_DIR="$TARGET_HOME/.config/systemd/user"

# Remember who we set this up for. prerm/postrm need it, and a removal through a
# GUI software centre will not have SUDO_USER either. Not in the dpkg manifest,
# so dpkg leaves it alone.
echo "$TARGET_USER" > "$INSTALL_ROOT/.install-user" 2>/dev/null || true

install -d -o "$TARGET_USER" -g "$TARGET_USER" "$UNIT_DIR"
sed "s|__EXEC__|$BIN $HOST_ENTRY|g" "$UNIT_SRC" > "$UNIT_DIR/$UNIT_NAME"
chmod 0644 "$UNIT_DIR/$UNIT_NAME"
chown "$TARGET_USER:$TARGET_USER" "$UNIT_DIR/$UNIT_NAME"

# Linger FIRST: it is what gives the user a systemd instance with no login
# session, and therefore what makes this an always-on service rather than a
# login item with extra steps. Enabling the unit before linger would start it
# now and still lose it at logout.
loginctl enable-linger "$TARGET_USER" 2>/dev/null || true

export XDG_RUNTIME_DIR="/run/user/$TARGET_UID"
for _ in 1 2 3 4 5 6; do
  [ -d "$XDG_RUNTIME_DIR" ] && break
  sleep 0.5
done

runuser -u "$TARGET_USER" -- systemctl --user daemon-reload 2>/dev/null || true
if runuser -u "$TARGET_USER" -- systemctl --user enable --now "$UNIT_NAME" 2>/dev/null; then
  echo "peartune: host service enabled and started for $TARGET_USER."
  echo "  Dashboard: http://127.0.0.1:8741"
else
  echo "peartune: unit installed but could not be started right now."
  echo "  Start it yourself with:  systemctl --user enable --now $UNIT_NAME"
fi

exit 0

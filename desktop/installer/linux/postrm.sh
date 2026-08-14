#!/bin/bash
# Debian postrm fragment - stops and removes the systemd USER service.
#
# THIS RUNS AS postrm, NOT prerm, because electron-builder's `afterRemove` maps
# to fpm's --after-remove. Two consequences that shape everything below:
#
#   * /opt/PearTune IS ALREADY GONE by the time this runs, so the .install-user
#     marker postinst wrote cannot be read here. The user has to be found another
#     way, and "scan for the unit we installed" is the only method that works for
#     every removal path.
#   * $1 is remove / purge / upgrade / failed-upgrade, same vocabulary as prerm.
#
# ON UPGRADE, DO NOTHING. dpkg unpacks the new version and re-runs postinst right
# after, so tearing linger down here would turn every routine upgrade into a
# silent demotion back to a login item.
#
# THE DATA DIR IS NEVER TOUCHED. host.seed under ~/.config/peartune-desktop/data
# is the library's identity - the key every paired phone knows it by, and nothing
# regenerates it. Uninstalling the package must not cost someone their library.

set -e

UNIT_NAME=peartune-host.service

case "${1:-}" in
  upgrade|failed-upgrade|abort-install|abort-upgrade|disappear) exit 0 ;;
esac

# Who did we install this for? SUDO_USER covers `sudo apt remove`. A GUI software
# centre goes through PackageKit and sets nothing, so fall back to finding whose
# home actually holds the unit file - which is exact, because postinst is the only
# thing that puts it there.
cleanup_user () {
  local user="$1" home uid
  id "$user" >/dev/null 2>&1 || return 0
  home=$(getent passwd "$user" | cut -d: -f6)
  [ -n "$home" ] && [ -f "$home/.config/systemd/user/$UNIT_NAME" ] || return 0
  uid=$(id -u "$user")

  XDG_RUNTIME_DIR="/run/user/$uid" runuser -u "$user" -- \
    systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true
  rm -f "$home/.config/systemd/user/$UNIT_NAME"
  XDG_RUNTIME_DIR="/run/user/$uid" runuser -u "$user" -- \
    systemctl --user daemon-reload 2>/dev/null || true

  # Drop the linger this package enabled. Harmless left behind, but it keeps a
  # user manager running for someone who no longer has PearTune installed.
  loginctl disable-linger "$user" 2>/dev/null || true

  # The polkit rule names this user and a program that is now gone. Leaving it
  # would be inert but untidy, and a stale passwordless-exec rule is exactly the
  # kind of thing that should not outlive the thing it was for.
  rm -f /etc/polkit-1/rules.d/49-peartune-updater.rules

  echo "peartune: host service removed for $user."
  echo "  Your library data is untouched in $home/.config/peartune-desktop/data"
}

if [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ]; then
  cleanup_user "$SUDO_USER"
else
  for _unit in /home/*/.config/systemd/user/"$UNIT_NAME" /root/.config/systemd/user/"$UNIT_NAME"; do
    [ -f "$_unit" ] || continue
    _home=${_unit%/.config/systemd/user/$UNIT_NAME}
    cleanup_user "$(basename "$_home")"
  done
fi

exit 0

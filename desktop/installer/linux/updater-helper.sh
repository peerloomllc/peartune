#!/bin/bash
# Privileged .deb updater for the PearTune desktop host (apply slice 4 of
# proposals/2026-07-31-desktop-update-apply.md).
#
# Runs as ROOT via pkexec. The .deb postinst installs this root-owned (0755) plus a
# polkit rule letting exactly this user run exactly this program with no password.
#
# WHY IT RE-VERIFIES SOMETHING THE HOST ALREADY VERIFIED. pkexec authorises RUNNING
# this script - it says nothing about the argument it is handed. Without the check
# below, anything able to invoke it could pass an arbitrary .deb and have root
# install it. So the digest is checked again, here, as root, against the value the
# unprivileged host computed. That is what keeps this from being a general root
# escalation: the rule grants one user the ability to run one absolute, root-owned
# program, and that program installs only a payload matching a digest it was told.
#
# Trust anchor: HTTPS to GitHub plus the release .sha256 - Linux .debs are unsigned,
# so this is the same boundary the host enforced, re-checked on the other side of
# the privilege line.
#
# Usage (from the host's deb applier):
#   pkexec /opt/PearTune/updater-helper.sh <debPath> <wantSha256> <user> <version>

set -euo pipefail

DEB="${1:-}"
WANT_SHA="${2:-}"
TARGET_USER="${3:-}"
VERSION="${4:-}"

log () { echo "$(date -u +%FT%TZ) [peartune-updater] $*"; }

# pkexec records the calling uid; fall back to it so the unit gets restarted for the
# right person even if the caller did not say who they were.
if [ -z "$TARGET_USER" ] && [ -n "${PKEXEC_UID:-}" ]; then
  TARGET_USER="$(getent passwd "$PKEXEC_UID" | cut -d: -f1)"
fi

if [ -z "$DEB" ] || [ ! -f "$DEB" ]; then
  log "no .deb at '$DEB'; REFUSING"
  exit 1
fi

# 1. Integrity, as root, before anything is installed.
GOT_SHA="$(sha256sum "$DEB" | awk '{print $1}')"
if [ -z "$WANT_SHA" ] || [ "$GOT_SHA" != "$WANT_SHA" ]; then
  log "sha256 mismatch (want ${WANT_SHA:0:12}, got ${GOT_SHA:0:12}); REFUSING"
  exit 1
fi
log "verified v$VERSION (sha ${GOT_SHA:0:12}); installing for '${TARGET_USER:-unknown}'"

# 2. Install. The systemd unit's ExecStart is a stable /opt path, so an upgrade
#    needs no unit re-template. dpkg refuses a downgrade by default and real updates
#    only ever go up, so there are no --force flags here.
if dpkg -i "$DEB"; then
  log "dpkg installed v$VERSION"
else
  log "dpkg -i FAILED for v$VERSION"
  exit 1
fi

# 3. Restart LAST. Restarting the unit tears down its cgroup - which contains the
#    host that called us AND this helper - so doing it any earlier could interrupt
#    an in-flight dpkg. --no-block enqueues the restart and returns immediately, so
#    systemd is free to kill us on the way down while still bringing the unit back
#    on the new version.
if [ -n "$TARGET_USER" ] && [ "$TARGET_USER" != "root" ]; then
  TARGET_UID="$(id -u "$TARGET_USER" 2>/dev/null || true)"
  if [ -n "$TARGET_UID" ]; then
    log "restarting peartune-host for $TARGET_USER (uid $TARGET_UID)"
    runuser -u "$TARGET_USER" -- env "XDG_RUNTIME_DIR=/run/user/$TARGET_UID" \
      systemctl --user restart --no-block peartune-host.service 2>/dev/null || true
  fi
else
  log "no target user to restart; the new version starts on the next service restart"
fi

log "update to v$VERSION complete"

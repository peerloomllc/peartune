#!/usr/bin/env bash
# SLICE 2 hardware check for proposals/2026-08-08-macos-host-as-a-launchdaemon.md.
#
# It runs the REAL installDaemon() from desktop/src/main/service.js - not a copy of its
# logic - against the REAL installed /Applications/PearTune.app, without having to ship a
# whole new build of the app first. That is what the injectable `resources` / `template`
# parameters on installDaemon are for; they mirror the ones execLine already had, for
# exactly this reason.
#
# WHAT IT PROVES, and each of these is a way the sibling platforms failed:
#   1. it points at the USER's library, not root's        (the Windows $APPDATA bug)
#   2. launchd in the system domain accepts the plist     (silent refusal if not 0644 root)
#   3. the daemon serves the REAL library, with tracks    ("healthy, zero tracks" on Windows)
#   4. the tray app steps aside instead of racing it      (two hosts, one data dir)
#
# Usage on the mac-mini, with the probe from slice 1 already removed:
#   sudo bash macos-daemon-verify.sh install
#   sudo bash macos-daemon-verify.sh check      # again after a reboot
#   sudo bash macos-daemon-verify.sh remove
set -uo pipefail

APP="${APP:-/Applications/PearTune.app}"
SRC="${SRC:-/tmp/pt-macos-daemon}"
LABEL="com.peerloom.peartune"
PLIST="/Library/LaunchDaemons/${LABEL}.plist"

step () { echo; echo "== $* =="; }
die  () { echo "FAILED: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run me with sudo: sudo bash $0 ${1:-install}"
[ -d "$APP" ] || die "no app at $APP"
[ -n "${SUDO_USER:-}" ] || die "no SUDO_USER - run this with sudo from your own account, not as root"

check () {
  step "what launchd has"
  local pid
  pid=$(launchctl print "system/$LABEL" 2>/dev/null | awk '/^\tpid = /{print $3}')
  if [ -z "$pid" ]; then
    echo "   NOT RUNNING"
  else
    echo "   running, pid $pid, as $(ps -o user= -p "$pid" | tr -d ' ')"
    echo "   console sessions: $(who | grep -c console)   <- 0 means nobody is logged in"
  fi

  step "which library is it actually serving"
  # THE CLAIM THAT MATTERS. Windows shipped a service that was running, healthy and
  # serving a brand new EMPTY library while the real one sat untouched - so "is it up"
  # is not the question. "Does it have the tracks and the identity" is.
  echo -n "   dashboard 8741: "
  curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8741/ || echo "no answer"

  local data
  data=$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:PEARTUNE_DATA" "$PLIST" 2>/dev/null)
  echo "   PEARTUNE_DATA = ${data:-<none>}"
  case "$data" in
    /var/root/*) echo "   *** POINTING AT ROOT'S HOME - this is the Windows bug ***" ;;
  esac
  if [ -n "$data" ] && [ -f "$data/host.seed" ]; then
    echo "   host.seed sha  $(shasum -a 256 "$data/host.seed" | cut -c1-16)   <- must not change across installs"
  else
    echo "   *** NO host.seed at that path - it would mint a NEW library ***"
  fi
  grep -m1 -E 'folder:scanned|host:listening' /var/log/peartune-host.log 2>/dev/null | sed 's/^/   /'
  grep -m1 'host:announced' /var/log/peartune-host.log 2>/dev/null | sed 's/^/   /' || echo "   (no announce yet)"
}

case "${1:-install}" in
install)
  step "staging the current service.js + plist template"
  [ -f "$SRC/service.js" ] || die "stage them first: scp desktop/src/main/service.js and installer/macos/com.peerloom.peartune.plist to $SRC/"
  [ -f "$SRC/com.peerloom.peartune.plist" ] || die "missing template in $SRC"

  # The library's identity BEFORE we touch anything, so "unchanged" is a measurement
  # rather than a hope.
  HOME_DIR=$(dscl . -read "/Users/$SUDO_USER" NFSHomeDirectory | sed 's/^NFSHomeDirectory: *//')
  DATA="$HOME_DIR/Library/Application Support/peartune-desktop/data"
  step "before"
  echo "   user     $SUDO_USER"
  echo "   home     $HOME_DIR"
  echo "   data     $DATA"
  [ -f "$DATA/host.seed" ] && echo "   seed sha $(shasum -a 256 "$DATA/host.seed" | cut -c1-16)" \
                           || echo "   *** no host.seed - open PearTune once first ***"

  step "running the REAL installDaemon()"
  node -e "
    const svc = require('$SRC/service.js')
    process.exit(svc.installDaemon({
      execPath: '$APP/Contents/MacOS/PearTune',
      resources: '$APP/Contents/Resources',
      template: '$SRC/com.peerloom.peartune.plist'
    }))
  " || die "installDaemon returned non-zero (see above)"

  echo "   waiting for it to scan and announce..."
  for _ in $(seq 1 20); do
    grep -q 'host:announced' /var/log/peartune-host.log 2>/dev/null && break
    sleep 2
  done
  check
  echo
  echo "NEXT: reboot and do NOT log in, then:  sudo bash $0 check"
  ;;

check)
  check
  ;;

remove)
  step "running the REAL uninstallDaemon()"
  node -e "
    const svc = require('$SRC/service.js')
    process.exit(svc.uninstallDaemon({}))
  "
  step "after"
  launchctl print "system/$LABEL" >/dev/null 2>&1 && echo "   STILL LOADED - that is wrong" || echo "   gone from launchd"
  [ -f "$PLIST" ] && echo "   plist STILL THERE - that is wrong" || echo "   plist removed"
  ;;

*)
  die "unknown command '${1}' - use install, check or remove"
  ;;
esac

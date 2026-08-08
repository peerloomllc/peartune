#!/usr/bin/env bash
# SLICE 1 of proposals/2026-08-08-macos-host-as-a-launchdaemon.md: prove the premise, with NO
# product code and NOTHING touched that the real host depends on.
#
# The question is whether the macOS host can run as a root LaunchDaemon in the SYSTEM domain -
# the only domain on macOS that survives a logout, measured 2026-07-31 - and whether TCC lets a
# root daemon read a library that lives in a user's home. Both were listed as unmeasured risks
# in the proposal and both can sink it.
#
# WHAT IT WILL NOT DO. It never touches the real host, its data dir, or its port. The probe is a
# SEPARATE daemon, with a different label, its own scratch data dir under /var/tmp and its own
# port, pointed at the real music folder READ-ONLY (a scan reads; it never writes there). The
# real tray host keeps running throughout, and `verify` at the end re-checks that it does.
#
# Usage on the mac-mini:
#   sudo bash macos-daemon-probe.sh install    # load it, then report what happened
#   sudo bash macos-daemon-probe.sh verify     # check it again (use this after a reboot)
#   sudo bash macos-daemon-probe.sh remove     # bootout + delete, leaving no trace
#
# The reboot test is the real premise and it is deliberately a SEPARATE step: install, then
# reboot with nobody logging in, then verify. A daemon that works right now but dies on reboot
# would answer the easy question and miss the one that matters.
set -uo pipefail

LABEL="com.peerloom.peartune.probe"
PLIST="/Library/LaunchDaemons/${LABEL}.plist"
DATA="/var/tmp/peartune-daemon-probe"
PORT="${PORT:-8752}"
APP="${APP:-/Applications/PearTune.app}"
MUSIC="${MUSIC:-}"

step () { echo; echo "== $* =="; }
die  () { echo "FAILED: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run me with sudo: sudo bash $0 ${1:-install}"
[ -d "$APP" ] || die "no app at $APP"

BIN="$APP/Contents/MacOS/PearTune"
ENTRY="$APP/Contents/Resources/app.asar/vendor/host/index.js"
[ -x "$BIN" ] || die "no executable at $BIN"

# The library the REAL host is serving, so the TCC question is asked about the actual folder
# rather than a decoy in /tmp that no protection would ever apply to. Falls back to the
# console user's ~/Music.
if [ -z "$MUSIC" ]; then
  owner=$(stat -f '%Su' /dev/console)
  MUSIC="/Users/$owner/Music"
fi

report () {
  step "what happened"
  echo "   plist        $PLIST"
  echo "   music        $MUSIC"

  local pid state
  pid=$(launchctl print "system/$LABEL" 2>/dev/null | awk '/^\tpid = /{print $3}')
  state=$(launchctl print "system/$LABEL" 2>/dev/null | awk '/^\tstate = /{print $3}')
  if [ -z "$pid" ]; then
    echo "   DAEMON       not running (state=${state:-absent})"
  else
    echo "   DAEMON       running, pid $pid, state ${state:-?}"
    echo "   RUNNING AS   $(ps -o user= -p "$pid" | tr -d ' ')   <- must be root"
    echo "   GUI SESSION  $(who | grep -c console) console session(s)   <- 0 means nobody is logged in"
  fi

  # DID IT REACH THE DHT. This is the claim that matters: a daemon that starts but cannot
  # announce is a daemon that serves nobody.
  if [ -f "$DATA/probe.log" ]; then
    if grep -q 'host:announced' "$DATA/probe.log"; then
      echo "   DHT          ANNOUNCED - the daemon is reachable"
    else
      echo "   DHT          no host:announced line yet"
    fi
    if grep -q 'folder:scanned' "$DATA/probe.log"; then
      echo "   TCC/MUSIC    READ OK - $(grep -o '"tracks":[0-9]*' "$DATA/probe.log" | tail -1) from $MUSIC"
    else
      echo "   TCC/MUSIC    NO SCAN LINE - this is the Full Disk Access case, look at the log"
    fi
    echo
    echo "   last lines of $DATA/probe.log:"
    tail -12 "$DATA/probe.log" | sed 's/^/     /'
  else
    echo "   (no log at $DATA/probe.log)"
  fi

  step "the REAL host is still fine"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8741/" || true)
  [ "$code" = "200" ] && echo "   real host on 8741 answering 200" \
                      || echo "   WARNING: real host on 8741 answered '$code' - check it"
}

case "${1:-install}" in
install)
  step "writing the probe daemon"
  mkdir -p "$DATA"
  # launchd in the system domain refuses a plist that is not root-owned and not 0644, and the
  # refusal is quiet - it just never loads. Set both rather than inherit whatever umask gave us.
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${BIN}</string>
    <string>${ENTRY}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key><string>1</string>
    <key>PEARTUNE_DATA</key><string>${DATA}</string>
    <key>PEARTUNE_HTTP_HOST</key><string>127.0.0.1</string>
    <key>PEARTUNE_HTTP_PORT</key><string>${PORT}</string>
    <key>PEARTUNE_MUSIC</key><string>${MUSIC}</string>
    <key>PEARTUNE_NAME</key><string>Daemon probe</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${DATA}/probe.log</string>
  <key>StandardErrorPath</key><string>${DATA}/probe.log</string>
</dict>
</plist>
PLIST_EOF
  chown root:wheel "$PLIST"
  chmod 0644 "$PLIST"
  echo "   wrote $PLIST"

  step "loading it into the SYSTEM domain"
  launchctl bootout "system/$LABEL" 2>/dev/null
  launchctl bootstrap system "$PLIST" || die "bootstrap refused - that is the premise failing, and it is a real answer"
  launchctl enable "system/$LABEL" 2>/dev/null
  echo "   bootstrapped"

  echo "   waiting for it to scan and announce..."
  for _ in $(seq 1 20); do
    grep -q 'host:announced' "$DATA/probe.log" 2>/dev/null && break
    sleep 2
  done

  report
  echo
  echo "NEXT, for the question that actually matters: reboot this Mac and do NOT log in."
  echo "Then from another machine:  ssh tims-mac-mini.local 'sudo bash $0 verify'"
  ;;

verify)
  report
  ;;

remove)
  step "removing the probe"
  launchctl bootout "system/$LABEL" 2>/dev/null
  rm -f "$PLIST"
  rm -rf "$DATA"
  echo "   gone: $PLIST and $DATA"
  step "the REAL host is still fine"
  curl -s -o /dev/null -w '   real host on 8741: %{http_code}\n' "http://127.0.0.1:8741/" || true
  ;;

*)
  die "unknown command '${1}' - use install, verify or remove"
  ;;
esac

#!/usr/bin/env bash
# Measure, per host, whether PearTune connects DIRECTLY or through the relay - across
# relay-on/relay-off and whatever network the phone is on. Appends one CSV row per
# (run, host, relay setting) so results accumulate over days instead of being two
# contradictory anecdotes.
#
# WHY THIS EXISTS. Two runs on the same phone and the same carrier gave OPPOSITE answers:
# 2026-07-23 (DECISIONS, phase 3) saw consistent punches on cellular with the relay
# staying out; 2026-07-29 saw the direct dial fail four times and BOTH hosts fall back to
# the relay. Relay usage drives PeerLoom's bandwidth bill, so "how often" needs to be data.
#
# WHAT IT SEPARATES. Tim's two hosts differ in TWO ways at once, which is why a single
# comparison between them proves nothing:
#   Umbrel    - runs in a container (node /app/host/index.js), and has tailscale0 up
#   Mac mini  - native process, no Tailscale at all
# Container-ness and Tailscale are therefore confounded. Toggling Tailscale while holding
# the host fixed is what tells them apart.
#
# WHAT IT CANNOT DO ITSELF, so you pass it as a LABEL and the script verifies what it can:
#   - Tailscale on the PHONE is a VPN service; adb cannot switch it on. Tap it.
#   - Tailscale on the UMBREL needs `sudo tailscale down/up`, and sudo there wants a
#     password this script does not have. Run it yourself between passes.
# The script records the phone's actual network type and whether a tun interface is up, so
# a mislabelled run is visible in the data rather than silently wrong.
#
# Usage:
#   bash scripts/relay-matrix.sh <device-serial> <label>
#
#   bash scripts/relay-matrix.sh 53071FDAP00038 cell-ts-off
#   bash scripts/relay-matrix.sh 53071FDAP00038 cell-ts-on      # after tapping Tailscale on
#
# Output: appends to scripts/relay-matrix.csv and prints the rows it added.
#
# It NEVER taps or sends key events - it only force-stops, launches, and reads. That is
# what makes it safe to run on the Pixel (suite CLAUDE.md rule 6).

set -euo pipefail

SERIAL="${1:?usage: relay-matrix.sh <device-serial> <label>}"
LABEL="${2:?usage: relay-matrix.sh <device-serial> <label>  e.g. cell-ts-off}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CSV="$REPO_ROOT/scripts/relay-matrix.csv"
APP=com.peartune.debug
ACTIVITY="$APP/com.peartune.MainActivity"
DIR="files/peartune"
# How long to let the app settle before reading the log. The 2026-07-29 cellular run took
# ~9s from launch to the relayed connection (four failed dials first), so 45s is generous
# without being a coffee break.
SETTLE="${SETTLE:-45}"

a () { adb -s "$SERIAL" "$@"; }
say () { printf '\n== %s ==\n' "$1"; }

a shell true >/dev/null 2>&1 || { echo "device $SERIAL not reachable over adb" >&2; exit 1; }

# --- observed conditions, so the label can be checked against reality ----------
WIFI=$(a shell settings get global wifi_on 2>/dev/null | tr -d '\r')
# A tun/tailscale interface on the phone means its traffic may be taking a different path.
# `grep -c` exits 1 on a count of zero, and under `set -e` a command substitution that
# fails takes the whole script with it - so both counters below swallow that explicitly.
TUN=$(a shell "ip -o link show 2>/dev/null | grep -cE ' (tun[0-9]*|tailscale[0-9]*):' || true" 2>/dev/null | tr -d '\r')
TUN=${TUN:-0}
NET=$([ "$WIFI" = "1" ] && echo wifi || echo cellular)
echo "device   : $SERIAL"
echo "label    : $LABEL"
echo "observed : network=$NET  wifi_on=$WIFI  tun-ifaces=$TUN"
[ "$NET" = "wifi" ] && echo "NOTE: on wifi the LAN punch wins every time - expect 'direct' everywhere. The interesting passes are on cellular."

[ -f "$CSV" ] || echo "utc,label,network,tun_ifaces,use_relay,host,library,outcome,dial_failures" > "$CSV"

# The names hosts.json knows, so a hostKey in the log can be reported as a library name
# rather than eight characters of z32.
mapfile -t HOSTROWS < <(a shell "run-as $APP cat $DIR/hosts.json" 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
for h in d.get('hosts',[]): print('%s|%s' % (h['hostKey'][:8], h.get('libraryName','?')))
")
libname () { for r in "${HOSTROWS[@]:-}"; do [ "${r%%|*}" = "$1" ] && { echo "${r#*|}"; return; }; done; echo "?"; }

# --- one pass: set useRelay, cold-launch, read what happened -------------------
pass () {
  local want="$1"   # true | false
  say "useRelay=$want"

  a shell am force-stop "$APP" >/dev/null 2>&1 || true
  sleep 2

  # Patch settings.json in place. The worklet reads useRelay LIVE per connect
  # (loadSettings() inside the relayThrough fn), so this needs no special ordering - but
  # the app is stopped anyway, which keeps it honest.
  a shell "run-as $APP cat $DIR/settings.json" 2>/dev/null > /tmp/.rm-settings.$$ || echo '{}' > /tmp/.rm-settings.$$
  WANT="$want" python3 -c "
import json,os,sys
try: s=json.load(open('/tmp/.rm-settings.$$'))
except Exception: s={}
s['useRelay'] = (os.environ['WANT']=='true')
open('/tmp/.rm-settings.$$','w').write(json.dumps(s))
"
  a push /tmp/.rm-settings.$$ /data/local/tmp/rm-settings.json >/dev/null 2>&1
  a shell "run-as $APP sh -c 'cat /data/local/tmp/rm-settings.json > $DIR/settings.json'"
  a shell rm -f /data/local/tmp/rm-settings.json >/dev/null 2>&1 || true
  rm -f /tmp/.rm-settings.$$

  a logcat -c >/dev/null 2>&1 || true
  a shell am start -n "$ACTIVITY" >/dev/null 2>&1
  sleep "$SETTLE"

  local log; log=$(a logcat -d 2>/dev/null | grep '\[worklet\]' || true)
  local dials; dials=$( { printf '%s' "$log" | grep -c 'connect:dial-failed'; } || true ); dials=${dials:-0}

  # Every host the swarm actually connected to, with the relay decision we recorded.
  local seen=0
  while IFS='|' read -r hk rel; do
    [ -z "$hk" ] && continue
    seen=1
    local outcome; outcome=$([ "$rel" = "true" ] && echo relayed || echo direct)
    printf '%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$LABEL" "$NET" "$TUN" "$want" "$hk" "$(libname "$hk")" "$outcome" "$dials" >> "$CSV"
    printf '   %-10s %-16s %-8s (dial-failures before connect: %s)\n' "$hk" "$(libname "$hk")" "$outcome" "$dials"
  done < <(printf '%s' "$log" | grep -oE 'swarm:connection \{"host":"[a-z0-9]+","relayed":(true|false)' \
            | sed -E 's/.*"host":"([a-z0-9]+)","relayed":(true|false)/\1|\2/' | sort -u)

  if [ "$seen" = 0 ]; then
    # No connection at all. With useRelay=false that is the POINT of the measurement: it
    # means the direct punch could not be made and there was no fallback allowed.
    printf '%s,%s,%s,%s,%s,,,%s,%s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$LABEL" "$NET" "$TUN" "$want" "no-connection" "$dials" >> "$CSV"
    printf '   %-10s %-16s %-8s (dial-failures: %s)\n' "-" "-" "no-connection" "$dials"
  fi
}

pass true
pass false

# Leave the phone as we found it: the shipped default is relay ON.
say "restoring useRelay=true"
a shell am force-stop "$APP" >/dev/null 2>&1 || true
a shell "run-as $APP cat $DIR/settings.json" 2>/dev/null > /tmp/.rm-restore.$$ || echo '{}' > /tmp/.rm-restore.$$
python3 -c "
import json
try: s=json.load(open('/tmp/.rm-restore.$$'))
except Exception: s={}
s['useRelay']=True
open('/tmp/.rm-restore.$$','w').write(json.dumps(s))
"
a push /tmp/.rm-restore.$$ /data/local/tmp/rm-restore.json >/dev/null 2>&1
a shell "run-as $APP sh -c 'cat /data/local/tmp/rm-restore.json > $DIR/settings.json'"
a shell rm -f /data/local/tmp/rm-restore.json >/dev/null 2>&1 || true
rm -f /tmp/.rm-restore.$$

say "totals so far, all runs"
python3 - "$CSV" <<'PY'
import csv, sys, collections
rows = list(csv.DictReader(open(sys.argv[1])))
t = collections.Counter((r['label'], r['network'], r['use_relay'], r['library'] or '-', r['outcome']) for r in rows)
w = max([len(k[0]) for k in t] + [5])
for k in sorted(t):
    print('   %-*s %-9s relay=%-5s %-16s %-13s x%d' % (w, k[0], k[1], k[2], k[3], k[4], t[k]))
print('   (%d rows in %s)' % (len(rows), sys.argv[1]))
PY

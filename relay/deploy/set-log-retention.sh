#!/usr/bin/env bash
# Make the relay box store no logs on disk. Run as root ON the relay droplet.
#
#   sudo bash relay/deploy/set-log-retention.sh
#
# WHY THIS EXISTS. PearTune's published privacy policy says of the relay: "The relay keeps no
# record of it and stores nothing." The relay process itself genuinely writes nothing - it logs
# to stdout, and relay.js says so in its own comment - but on a systemd box stdout is journald,
# and journald's default is persistent. Checked on the live droplet 2026-07-31: 2,659 relay:pair
# and 5,286 relay:unpair lines going back to 23 July, 35.8 MB, no retention limit set. Each line
# holds two random 8-character keys, a duration and a byte count.
#
# NOTHING IN THOSE LINES IDENTIFIES A DEVICE OR A PERSON - the keys are per-process HyperDHT node
# keys, not device or host keys, proved live on 2026-07-28 when a host relayed for an evening and
# its real key appeared zero times. So this was never a data-collection problem. It is that the
# claim on the policy page was stronger than the deployment, and the claim is the product.
#
# WHAT IT DOES. Storage=volatile keeps the journal in /run/log/journal, which is a tmpfs: RAM
# only, never written to disk, gone on reboot, and rotated inside RuntimeMaxUse. `journalctl -u
# peartune-relay -f` still works exactly as before for live operating.
#
# THE TRADE, stated because it is real: this is box-wide, not relay-only. After a reboot there
# are no logs from before it - including whatever caused the reboot, and including the
# relay:stats history that bandwidth is read from. That is an acceptable price on a
# single-purpose $4 relay and would NOT be on a box doing anything else. Pull anything you want
# to keep BEFORE rebooting:
#
#   journalctl -u peartune-relay -o cat | grep relay:stats > stats-$(date +%F).log
#
# The surgical alternative, if the box ever grows a second job, is a journald namespace
# (LogNamespace= in the unit plus /etc/systemd/journald@peartune-relay.conf). It costs a changed
# journalctl invocation everywhere, which is why it is not what this does today.

set -euo pipefail

CONF=/etc/systemd/journald.conf.d/10-peartune-relay-retention.conf
UNIT=peartune-relay

[ "$(id -u)" = "0" ] || { echo "Run as root (sudo bash $0)" >&2; exit 1; }

echo "==> Before"
journalctl --disk-usage || true

mkdir -p "$(dirname "$CONF")"
cat > "$CONF" <<'EOF'
# Written by relay/deploy/set-log-retention.sh - see that script for the reasoning.
#
# The relay's privacy claim is that it keeps no record. Volatile storage is what makes that
# true of the machine and not merely of the process: the journal lives in /run/log/journal
# (tmpfs), so nothing reaches the disk and nothing survives a reboot.
[Journal]
Storage=volatile
RuntimeMaxUse=32M
MaxRetentionSec=1day
EOF

echo "==> Wrote $CONF"
cat "$CONF"

# Drop what is already on disk. Without this the eight days that prompted all of
# this would sit in /var/log/journal forever - the setting only governs new writes.
echo "==> Flushing the persistent journal"
systemctl restart systemd-journald
rm -rf /var/log/journal
systemctl restart systemd-journald

echo "==> After"
journalctl --disk-usage || true
echo "    /var/log/journal: $([ -d /var/log/journal ] && echo 'STILL PRESENT - investigate' || echo 'gone')"
echo "    /run/log/journal: $([ -d /run/log/journal ] && du -sh /run/log/journal | cut -f1 || echo 'absent')"

# The relay keeps running throughout - restarting journald does not touch it - but its
# backlog is gone, so prove it is still talking to the new journal.
echo "==> Relay still logging?"
systemctl is-active "$UNIT" || true
sleep 2
journalctl -u "$UNIT" -n 3 -o cat --no-pager 2>/dev/null || echo "    (no lines yet - stats tick is periodic)"

echo ""
echo "Done. Live logs: journalctl -u $UNIT -f"

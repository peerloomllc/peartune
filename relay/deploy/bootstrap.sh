#!/usr/bin/env bash
# Provision (or update) the PeerLoom blind relay on a fresh Debian/Ubuntu VPS.
# Idempotent: safe to re-run to pick up new code. Run as root (or via sudo).
#
#   sudo bash relay/deploy/bootstrap.sh
#
# It installs Node if missing, creates a service user + data dir, copies the relay
# app to /opt/peartune-relay, installs prod deps, wires the systemd unit, starts it,
# and prints the relay's public key (which you bake into protocol/relay.js).
set -euo pipefail

REPO_RELAY_DIR="$(cd "$(dirname "$0")/.." && pwd)" # the relay/ dir this script lives under
APP_DIR=/opt/peartune-relay
DATA_DIR=/var/lib/peartune-relay
SVC=peartune-relay

echo "==> Node.js"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node --version

echo "==> service user + dirs"
id -u peartune >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin peartune
mkdir -p "$APP_DIR" "$DATA_DIR"

echo "==> copy app + install prod deps"
# --exclude keeps a local node_modules/data/seed from clobbering the target.
cp -r "$REPO_RELAY_DIR"/index.js "$REPO_RELAY_DIR"/relay.js "$REPO_RELAY_DIR"/identity.js \
      "$REPO_RELAY_DIR"/package.json "$REPO_RELAY_DIR"/README.md "$REPO_RELAY_DIR"/deploy "$APP_DIR"/
( cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund )
chown -R peartune: "$APP_DIR" "$DATA_DIR"

echo "==> systemd"
cp "$APP_DIR/deploy/peartune-relay.service" /etc/systemd/system/$SVC.service
systemctl daemon-reload
systemctl enable "$SVC"
systemctl restart "$SVC"

echo "==> waiting for the relay to announce its public key"
sleep 3
echo "----------------------------------------------------------------------"
journalctl -u "$SVC" -n 80 --no-pager | grep -m1 "relay:public-key" \
  || echo "(not yet - watch it with: journalctl -u $SVC -f)"
echo "----------------------------------------------------------------------"
echo "Bake that key into protocol/relay.js -> RELAY_PUBLIC_KEY_Z, then ship phase 2."

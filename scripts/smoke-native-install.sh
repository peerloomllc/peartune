#!/usr/bin/env bash
# Follow docs/host-linux.md Option D in a clean node:20 container and see the host start.
#
#   bash scripts/smoke-native-install.sh
#
# The documented source install never started until 2026-09-17: protocol/ could not find
# its packages, and nothing tested the docs, so nobody knew. This runs the steps against
# THIS checkout's committed host/, protocol/ and client/ and the sibling ../peerloom-host
# (git archive HEAD of each, so uncommitted edits are not tested), in the same layout the
# docs use (/opt/peartune beside /opt/peerloom-host). Needs podman or docker.
#
# It checks both halves: without NODE_PATH the host exits with the one-line hint, and with
# NODE_PATH it scans, listens and announces.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_PKG="$(cd "$REPO/.." && pwd)/peerloom-host"
[ -d "$HOST_PKG/src" ] || { echo "no @peerloom/host at $HOST_PKG" >&2; exit 1; }

if command -v podman >/dev/null 2>&1; then ENGINE=podman
elif command -v docker >/dev/null 2>&1; then ENGINE=docker
else echo "needs podman or docker" >&2; exit 1; fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/peartune" "$STAGE/peerloom-host"
git -C "$REPO" archive HEAD host protocol client | tar -x -C "$STAGE/peartune"
git -C "$HOST_PKG" archive HEAD | tar -x -C "$STAGE/peerloom-host"

"$ENGINE" run --rm -v "$STAGE:/ctx:ro,Z" docker.io/library/node:20-bookworm-slim bash -c '
  set -e
  apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq libatomic1 >/dev/null 2>&1
  cp -r /ctx/peerloom-host /ctx/peartune /opt/
  # docs/host-linux.md step 1, verbatim apart from the clones.
  (cd /opt/peerloom-host && npm ci --no-audit --no-fund >/dev/null 2>&1)
  (cd /opt/peartune/host && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1)
  mkdir -p /tmp/music /tmp/data
  export PEARTUNE_MUSIC=/tmp/music PEARTUNE_DATA=/tmp/data PEARTUNE_HTTP_HOST=127.0.0.1

  echo "== without NODE_PATH: expect the hint =="
  if out=$(node /opt/peartune/host/index.js 2>&1); then echo "FAIL: started without NODE_PATH"; exit 1; fi
  echo "$out" | grep -q "set NODE_PATH=/opt/peartune/host/node_modules" || { echo "FAIL: no hint"; echo "$out" | tail -3; exit 1; }
  echo "ok"

  echo "== with NODE_PATH (what the systemd unit sets): expect it to start =="
  out=$(NODE_PATH=/opt/peartune/host/node_modules timeout 25 node /opt/peartune/host/index.js 2>&1 || true)
  for want in host:scanned host:listening host:announced; do
    echo "$out" | grep -q "$want" || { echo "FAIL: no $want"; echo "$out" | tail -5; exit 1; }
  done
  echo "ok"
'
echo "native install smoke: PASS"

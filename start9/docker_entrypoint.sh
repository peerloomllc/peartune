#!/bin/sh
set -e

# StartOS mounts the persistence volume at /data (manifest main.mounts.main).
# The host keeps its identity seed, grant store, generated dashboard password,
# and source/library config here. The duplicity backup mounts the same volume.
DATA_DIR=/data
mkdir -p "$DATA_DIR"

# Container adaptation:
#   0.0.0.0  - StartOS reaches the dashboard over its own network, not loopback,
#              so it can front it on the LAN (443/TLS) and over Tor.
# The dashboard PASSWORD is deliberately left UNSET: on a non-loopback bind with
# no PEARTUNE_PASSWORD, the host GENERATES one on first run and prints it below
# (also saved to $DATA_DIR/dashboard-password). Unlike the seeder we do NOT
# disable auth - the dashboard is a revoke button, defended even behind the proxy.
export PEARTUNE_HTTP_HOST=0.0.0.0
export PEARTUNE_HTTP_PORT=8741
export PEARTUNE_DATA="$DATA_DIR"
# Surface the generated dashboard password in StartOS's Properties page: the host
# writes it to this stats.yaml (version 2), which the `properties` procedure reads.
export PEARTUNE_STATS="$DATA_DIR/start9/stats.yaml"

printf "\n [i] Starting PearTune host (data: %s) ...\n\n" "$DATA_DIR"

# tini as PID 1 so signals propagate and any child is reaped.
exec tini -- node /app/host/index.js

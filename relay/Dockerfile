# PeerLoom blind relay - multi-arch (amd64/arm64) via the base image's platform.
# Build:  docker build -t peartune-relay ./relay
# Run:    docker run -d --name peartune-relay --network host \
#           -v peartune-relay-data:/data -e RELAY_DATA_DIR=/data peartune-relay
#
# --network host is the simplest way to give the DHT node direct access to the
# host's public interface (a relay MUST be reachable inbound). Without host
# networking, publish/forward the UDP port the node binds and ensure it is not
# behind NAT - a NAT'd relay is useless.

FROM node:20-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .

ENV RELAY_DATA_DIR=/data
VOLUME ["/data"]

CMD ["node", "index.js"]

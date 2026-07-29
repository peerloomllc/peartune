// Ports for the probe (proposals/2026-07-29-start9-bindportrange.md).

// The host's dashboard. Bound as a normal http interface so StartOS fronts it on the
// LAN - which the CONVERTED 0.3.5 package does not get: its address tables are empty
// for every host id, because the old interface definition does not survive s9pk convert.
export const uiPort = 8741

// The DHT's UDP port. THE WHOLE POINT OF THE PROBE.
//
// It must be pinned (PEARTUNE_DHT_PORT, see main.ts) and forwarded (bindPortRange, see
// interfaces.ts) with the SAME number on both sides, so external == internal and the
// mapping is port-preserving. A range is used because bindPortRange demands
// numberOfPorts >= 2; only the first is used, and the second is reserved padding.
export const dhtPort = 49737
export const dhtPortCount = 2

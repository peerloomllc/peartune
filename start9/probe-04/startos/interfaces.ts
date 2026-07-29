import { sdk } from './sdk'
import { i18n } from './i18n'
import { uiPort, dhtPort, dhtPortCount } from './utils'

/**
 * THE PROBE. See proposals/2026-07-29-start9-bindportrange.md.
 *
 * Two binds, and only the second one is the experiment:
 *
 *  1. The dashboard on 8741 over http. Ordinary, and it also recovers something the
 *     CONVERTED 0.3.5 package loses - that package has NO address at all in 0.4's
 *     model (`package host peartune address <id> list` is empty for every host id),
 *     so its dashboard is unreachable through StartOS on the LAN.
 *
 *  2. The DHT's UDP port, via bindPortRange. This is the only raw-UDP door in the
 *     0.4 SDK: the single-port bindPort is protocol-typed over http/https/ws/wss/
 *     ssh/dns with addSsl/secure, i.e. TCP and TLS only, so it cannot carry a DHT.
 *     numberOfPorts must be >= 2 (the docs push single ports at bindPort), so we ask
 *     for 2 and use the first.
 *
 * externalStartPort === internalStartPort on purpose: the forward maps external onto
 * internal by OFFSET, so equal bases make it port-preserving. Holepunching needs the
 * host reachable on a port peers can predict, and a shifted range would defeat that.
 *
 * WHAT THIS IS TESTING, and it is not the packaging: a forward may fix INBOUND without
 * fixing the punch. Holepunching needs the container's OUTBOUND UDP to leave from the
 * same external port that inbound arrives on. If lxcbr0 still SNATs the source port,
 * the mapping stays endpoint-dependent, the punch keeps failing, and the relay keeps
 * carrying every byte. Nothing in the SDK says whether the rule is symmetric - so the
 * acceptance test is RELAY BYTES, not "did it connect". It connects either way.
 */
export const setInterfaces = sdk.setupInterfaces(async ({ effects }) => {
  const uiOrigin = await sdk.MultiHost.of(effects, 'ui').bindPort(uiPort, {
    protocol: 'http',
  })
  const ui = await uiOrigin.export([
    sdk.createInterface(effects, {
      name: i18n('Dashboard'),
      id: 'ui',
      description: i18n('Pair devices, choose a music source, and revoke access'),
      type: 'ui',
      masked: false,
      schemeOverride: null,
      username: null,
      path: '',
      query: {},
    }),
  ])

  const dhtRange = await sdk.MultiHost.of(effects, 'dht').bindPortRange({
    internalStartPort: dhtPort,
    externalStartPort: dhtPort,
    numberOfPorts: dhtPortCount,
  })
  // RangeOrigin.export returns Promise<void>, not a receipt - the range registers its
  // single restricted `api` interface but contributes no address to the UI, so it is
  // awaited and NOT returned below.
  await dhtRange.export(
    sdk.createRangeInterface(effects, {
      id: 'dht',
      name: i18n('Peer-to-peer'),
      description: i18n(
        'The encrypted port phones connect on, forwarded so they can reach this server directly instead of through a relay.',
      ),
    }),
  )

  return [ui]
})

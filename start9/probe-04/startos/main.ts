import { i18n } from './i18n'
import { sdk } from './sdk'
import { uiPort, dhtPort } from './utils'

/**
 * The PearTune host, with its DHT port PINNED to the same number interfaces.ts
 * forwards. See proposals/2026-07-29-start9-bindportrange.md.
 *
 * PEARTUNE_DHT_PORT is the whole reason this probe needs its own image: without it the
 * DHT binds a RANDOM port per process, and a forward cannot follow a moving target.
 * (Note hyperdht/index.js:27 reads `opts.port || 49737`, which makes it look pinned by
 * default. It is not - that is a preference and does not survive.)
 *
 * runAsInit because the base image bundles tini as its init, and a supervisor that is
 * not PID 1 misbehaves on stop.
 */
export const main = sdk.setupMain(async ({ effects }) => {
  console.info(i18n('Starting the PearTune DHT probe'))

  return sdk.Daemons.of(effects).addDaemon('host', {
    subcontainer: sdk.SubContainer.of(
      effects,
      { imageId: 'peartune' },
      sdk.Mounts.of().mountVolume({
        volumeId: 'main',
        subpath: null,
        mountpoint: '/data',
        readonly: false,
      }),
      'host',
    ),
    exec: {
      command: ['node', '/app/host/index.js'],
      env: { PEARTUNE_DHT_PORT: String(dhtPort) },
      runAsInit: true,
    },
    // Health on the DASHBOARD port, not the DHT port. checkPortListening reads
    // /proc/net, and a UDP socket bound inside the container reports ready whether or
    // not the forward works - which is the thing under test, so gating health on it
    // would make a broken probe look healthy.
    ready: {
      display: i18n('Dashboard'),
      fn: () =>
        sdk.healthCheck.checkPortListening(effects, uiPort, {
          successMessage: i18n('The dashboard is ready'),
          errorMessage: i18n('The dashboard is not ready'),
        }),
    },
    requires: [],
  })
})

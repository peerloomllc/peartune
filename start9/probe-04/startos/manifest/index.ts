import { setupManifest } from '@start9labs/start-sdk'
import { long, short } from './i18n'

export const manifest = setupManifest({
  id: 'peartune-dht-probe',
  title: 'PearTune DHT Probe',
  license: 'MIT',
  packageRepo: 'https://github.com/peerloomllc/peartune',
  upstreamRepo: 'https://github.com/peerloomllc/peartune',
  marketingUrl: 'https://peerloomllc.com',
  donationUrl: null,
  description: { short, long },
  // Identity seed, grant store, generated dashboard password and source config.
  volumes: ['main'],
  images: {
    // dockerBuild rather than dockerTag: the probe needs PEARTUNE_DHT_PORT, which the
    // published 0.2.36 image predates. The Dockerfile FROMs that image and overwrites
    // only the two changed host files, so nothing is rebuilt from source.
    //
    // dockerTag, NOT dockerBuild: the SDK's dockerBuild shells out to a buildx-style
    // `-o type=docker,dest=-`, which podman rejects ("invalid type docker selected for
    // build output"), so dockerBuild needs real Docker. This box has podman only, so the
    // image is built and pushed by `make image` and pulled from a throwaway local
    // registry at pack time. The s9pk EMBEDS the image, so the registry only has to
    // exist while building.
    //
    // x86_64 only: every Start9 box we test on is x86_64, and the arm leg costs a qemu
    // pass for a throwaway probe.
    peartune: {
      source: { dockerTag: '127.0.0.1:5555/peartune-probe:0.1' },
      arch: ['x86_64'],
    },
  },
  dependencies: {},
})

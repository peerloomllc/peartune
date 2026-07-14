// Where the music comes from, chosen by the OPERATOR rather than by an env var.
//
// This exists because of what a store install actually looks like. Someone installs
// PearTune from the Umbrel app store, opens it, and there is no way on earth they
// are going to hand-edit a docker-compose file to point it at their Navidrome. With
// no configuration they would get the folder adapter, which has no tag reading -
// a library of FILENAMES. Everything good about this app (albums, artists, artwork,
// search) lives on the other side of that choice.
//
// So the source is data, not deployment. It lives in the host's own data dir, next
// to the identity and the grant store, and the dashboard writes it.
//
// PRECEDENCE, and the order matters:
//   1. source.json        - what the operator chose in the dashboard. Wins.
//   2. env / CLI          - how the container was started. The fallback, and what
//                           every existing deployment (Tim's Umbrel) still uses.
//   3. folder             - the honest last resort.
//
// A saved source therefore SURVIVES a container restart with different env vars,
// which is the whole point: the operator's choice outlives the deployment.

const fs = require('fs')
const path = require('path')

const { FolderAdapter } = require('./adapters/folder')
const { NavidromeAdapter } = require('./adapters/navidrome')

const FILE = 'source.json'

function pathOf (dataDir) {
  return path.join(dataDir, FILE)
}

function loadSource (dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(pathOf(dataDir), 'utf8'))
    if (raw && (raw.kind === 'navidrome' || raw.kind === 'folder')) return raw
  } catch {}
  return null
}

function saveSource (dataDir, cfg) {
  fs.mkdirSync(dataDir, { recursive: true })
  // 0600: this file holds the Navidrome password. The identity seed next to it is
  // already written this way; a credential should not be more readable than a key.
  fs.writeFileSync(pathOf(dataDir), JSON.stringify(cfg, null, 2), { mode: 0o600 })
  return cfg
}

// The config the operator chose, or the one the container was started with, or the
// folder. Never throws: a host that cannot decide where its music is should still
// come up, say so, and let the operator fix it in the dashboard.
function resolveSource ({ dataDir, navidrome, musicDir }) {
  const saved = loadSource(dataDir)
  if (saved) return { ...saved, from: 'dashboard' }

  if (navidrome?.url) {
    return {
      kind: 'navidrome',
      url: navidrome.url,
      username: navidrome.username,
      password: navidrome.password,
      from: 'env'
    }
  }

  return { kind: 'folder', root: musicDir, from: 'default' }
}

function buildAdapter (cfg, { libraryId, musicDir }) {
  if (cfg.kind === 'navidrome') {
    return new NavidromeAdapter({
      url: cfg.url,
      username: cfg.username,
      password: cfg.password,
      libraryId
    })
  }
  return new FolderAdapter({ root: cfg.root || musicDir, libraryId })
}

// What the dashboard is allowed to see. The password NEVER leaves the host - the
// operator gets told whether one is set, not what it is. A dashboard session is not
// a licence to read back credentials.
function publicView (cfg) {
  return {
    kind: cfg.kind,
    url: cfg.url || '',
    username: cfg.username || '',
    hasPassword: !!cfg.password,
    root: cfg.root || '',
    from: cfg.from || 'dashboard'
  }
}

module.exports = { loadSource, saveSource, resolveSource, buildAdapter, publicView }

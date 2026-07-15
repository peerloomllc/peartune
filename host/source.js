// Where the music comes from, chosen by the OPERATOR rather than by an env var.
//
// This exists because of what a store install actually looks like. Someone installs
// PearTune from the Umbrel app store, opens it, and there is no way on earth they
// are going to hand-edit a docker-compose file to point it at their Navidrome. With
// no configuration they would get the folder adapter - which now reads tags, but
// still only sees what is MOUNTED into the container.
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
//
// ONE CONFIG PER KIND, NOT ONE CONFIG.
//
// The first cut stored a single flat config, so the file held whichever source was
// current and nothing else. Switch Navidrome -> Folder -> Navidrome and the URL,
// username and password were GONE: you retyped them, because saving the folder had
// overwritten them. (Tim, first day of using it.)
//
// Now each kind keeps its own config and `active` is a POINTER. Flipping between
// sources is free, credentials survive the round trip, and this is also the shape
// that multiple simultaneous sources will need - which is where this is heading
// (see the combined-source trap in DECISIONS: trackId is source-scoped, so a merged
// library needs a dedup story before it can exist).

const fs = require('fs')
const path = require('path')

const { FolderAdapter } = require('./adapters/folder')
const { SubsonicAdapter } = require('./adapters/subsonic')
const { JellyfinAdapter } = require('./adapters/jellyfin')

const FILE = 'source.json'
const VERSION = 2

const KINDS = ['subsonic', 'jellyfin', 'folder']

// Kinds that were RENAMED. The adapter formerly called "navidrome" is really a
// Subsonic adapter (it speaks to any Subsonic server), so the kind is now 'subsonic'.
// Every host in the wild has a source.json that says 'navidrome'; migrate() maps it
// on read so the library does not go dark on upgrade. `trackId` is re-scoped by the
// rename, but nothing durable is keyed by it yet (the milestone-3 ledger does not
// exist), so this costs nothing today - see the proposal.
const RENAMED = { navidrome: 'subsonic' }
const canonKind = (k) => RENAMED[k] || k

// Which fields belong to which kind. Everything the dashboard POSTs is filtered
// through this, so a stray field from a browser cannot end up persisted in the
// host's config file.
const FIELDS = {
  // apiKey: the OpenSubsonic apiKeyAuthentication credential, an alternative to
  // username/password (Nextcloud/ownCloud Music, Ampache 7). A secret, like password.
  subsonic: ['url', 'username', 'password', 'apiKey'],
  jellyfin: ['url', 'username', 'password'],
  folder: ['root']
}

// The secrets. Never sent to the browser, and preserved when the browser sends the
// field back empty (which means "leave it alone", not "set it to the empty string").
const SECRETS = ['password', 'apiKey']

function pathOf (dataDir) {
  return path.join(dataDir, FILE)
}

function pick (kind, cfg) {
  const out = {}
  for (const f of FIELDS[kind] || []) {
    if (cfg[f] !== undefined && cfg[f] !== null) out[f] = cfg[f]
  }
  return out
}

// v1 was ONE flat config: { kind: 'navidrome', url, username, password }.
//
// Every host in the wild (Tim's Umbrel) has one of these on disk. Reading it as v2
// and losing the source would mean the library goes dark on upgrade, which is the
// one thing a source change must never do.
function migrate (raw) {
  if (!raw || typeof raw !== 'object') return null

  if (raw.version === VERSION && raw.sources) {
    const sources = {}
    // Iterate the FILE's keys (which may still say 'navidrome') and canonicalize,
    // rather than iterating KINDS - otherwise a renamed kind on disk is silently
    // dropped and the operator's Subsonic source vanishes on upgrade.
    for (const [key, cfg] of Object.entries(raw.sources)) {
      const kind = canonKind(key)
      if (KINDS.includes(kind) && cfg) sources[kind] = pick(kind, cfg)
    }
    const active = canonKind(raw.active)
    return { version: VERSION, active: KINDS.includes(active) ? active : null, sources }
  }

  const kind = canonKind(raw.kind)
  if (KINDS.includes(kind)) {
    return {
      version: VERSION,
      active: kind,
      sources: { [kind]: pick(kind, raw) }
    }
  }

  return null
}

class SourceStore {
  // env: what the container was started with (PEARTUNE_NAVIDROME_*), or null.
  constructor ({ dataDir, env = null, musicDir = '/music' }) {
    this.dataDir = dataDir
    this.env = env
    this.musicDir = musicDir
    this.data = this._read() || { version: VERSION, active: null, sources: {} }
  }

  _read () {
    try {
      return migrate(JSON.parse(fs.readFileSync(pathOf(this.dataDir), 'utf8')))
    } catch {
      return null // no file, bad JSON, or a shape we do not recognise: fall through
    }
  }

  _write () {
    fs.mkdirSync(this.dataDir, { recursive: true })
    // 0600: this file holds source passwords. The identity seed next to it is
    // already written this way; a credential should not be more readable than a key.
    fs.writeFileSync(pathOf(this.dataDir), JSON.stringify(this.data, null, 2), { mode: 0o600 })
  }

  // The config the operator chose, or the one the container was started with, or the
  // folder. NEVER THROWS: a host that cannot decide where its music is should still
  // come up, say so, and let the operator fix it in the dashboard.
  active () {
    const { active, sources } = this.data
    if (active && sources[active]) return { kind: active, ...sources[active], from: 'dashboard' }

    if (this.env?.subsonic?.url) {
      return { kind: 'subsonic', ...pick('subsonic', this.env.subsonic), from: 'env' }
    }

    return { kind: 'folder', root: this.musicDir, from: 'default' }
  }

  // What the dashboard should PREFILL the form for this kind with, whether or not it
  // is the one currently serving. This is what makes flipping between sources free.
  configFor (kind) {
    if (this.data.sources[kind]) return { ...this.data.sources[kind] }
    if (kind === 'subsonic' && this.env?.subsonic?.url) return pick('subsonic', this.env.subsonic)
    if (kind === 'folder') return { root: this.musicDir }
    return {}
  }

  save (cfg) {
    if (!KINDS.includes(cfg.kind)) throw new Error(`unknown source kind: ${cfg.kind}`)
    this.data.sources[cfg.kind] = pick(cfg.kind, cfg)
    this.data.active = cfg.kind
    this._write()
    return this.active()
  }

  // The password is never sent to the browser, so the browser cannot send it back.
  //
  // An empty password field on an already-configured source means "leave it alone" -
  // not "set the password to empty string", which would silently break the library
  // the next time the operator edited the URL.
  //
  // It reads from the STORE, not from the live source, and that is the fix for the
  // credential-wiping bug: your Navidrome password is still there while a folder is
  // serving, so switching back to Navidrome does not ask you to retype it.
  withKeptSecrets (cfg) {
    if (!KINDS.includes(cfg.kind)) throw new Error(`unknown source kind: ${cfg.kind}`)
    const saved = this.configFor(cfg.kind)
    const out = { ...cfg }
    for (const s of SECRETS) {
      if (!out[s] && saved[s]) out[s] = saved[s]
    }
    return out
  }

  // What the dashboard is allowed to see: every kind's config, with the passwords
  // replaced by the only fact about them the operator needs - whether one is set.
  // A dashboard session is not a licence to read back credentials.
  view () {
    const act = this.active()
    const kinds = {}
    for (const kind of KINDS) {
      const cfg = this.configFor(kind)
      const pub = {}
      for (const f of FIELDS[kind]) {
        if (SECRETS.includes(f)) pub[`has${f[0].toUpperCase()}${f.slice(1)}`] = !!cfg[f]
        else pub[f] = cfg[f] || ''
      }
      kinds[kind] = pub
    }
    return { active: act.kind, from: act.from, kinds }
  }
}

function buildAdapter (cfg, { libraryId, musicDir, log }) {
  if (cfg.kind === 'subsonic') {
    return new SubsonicAdapter({
      url: cfg.url,
      username: cfg.username,
      password: cfg.password,
      apiKey: cfg.apiKey,
      libraryId
    })
  }

  if (cfg.kind === 'jellyfin') {
    return new JellyfinAdapter({
      url: cfg.url,
      username: cfg.username,
      password: cfg.password,
      libraryId,
      log
    })
  }

  return new FolderAdapter({ root: cfg.root || musicDir, libraryId, log })
}

module.exports = { SourceStore, buildAdapter, KINDS, migrate }

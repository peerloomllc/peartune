// Raw-folder source adapter.
//
// Point the host at /music and it works, with no Navidrome, no Jellyfin and no
// server of any kind. This is the fallback and arguably the real product.
//
// Milestone 1 scope: enumerate audio files and stream bytes with range support.
// Tag reading (ID3 / Vorbis / MP4), artwork extraction and real album/artist
// grouping land in milestone 2 - see TODO.md. Until then metadata is the
// filename, which is enough to prove the transport.

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { trackId } = require('../../protocol/ids')

const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav'])

class FolderAdapter {
  constructor ({ root, libraryId }) {
    this.root = path.resolve(root)
    this.libraryId = libraryId
    this.kind = 'folder'
    this.byId = new Map() // trackId -> { id, relPath, absPath, size, title }
    this.scannedAt = null
  }

  async scan () {
    this.byId.clear()
    await this._walk(this.root)
    this.scannedAt = Date.now()
    return this.byId.size
  }

  async _walk (dir) {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        await this._walk(abs)
        continue
      }
      if (!AUDIO_EXT.has(path.extname(e.name).toLowerCase())) continue

      // The relative path is the sourceKey, so an id is stable across rescans
      // and across host restarts as long as the file does not move.
      const relPath = path.relative(this.root, abs)
      const id = trackId(this.libraryId, this.kind, relPath)
      const stat = await fsp.stat(abs).catch(() => null)
      if (!stat) continue

      this.byId.set(id, {
        id,
        relPath,
        absPath: abs,
        size: stat.size,
        title: path.basename(e.name, path.extname(e.name))
      })
    }
  }

  async stats () {
    return {
      source: this.kind,
      root: this.root,
      tracks: this.byId.size,
      albums: 0, // milestone 2
      artists: 0, // milestone 2
      scannedAt: this.scannedAt
    }
  }

  async list ({ type = 'tracks', limit = 200, cursor = 0 } = {}) {
    if (type !== 'tracks') return { type, items: [], nextCursor: null }
    const all = [...this.byId.values()]
    const start = Number(cursor) || 0
    const items = all.slice(start, start + limit).map(t => ({
      id: t.id,
      title: t.title,
      path: t.relPath,
      size: t.size
    }))
    const next = start + limit
    return { type, items, nextCursor: next < all.length ? next : null }
  }

  async get ({ id, type = 'track' }) {
    // No tag reading yet, so this adapter knows nothing about artists or albums -
    // only files. Say so explicitly rather than falling through to the track
    // lookup and returning a null that looks like "no such artist".
    if (type !== 'track') return null

    const t = this.byId.get(id)
    if (!t) return null
    return { id: t.id, title: t.title, path: t.relPath, size: t.size }
  }

  async search ({ q = '', limit = 50 } = {}) {
    const needle = String(q).toLowerCase()
    const tracks = [...this.byId.values()]
      .filter(t => t.title.toLowerCase().includes(needle) || t.relPath.toLowerCase().includes(needle))
      .slice(0, limit)
      .map(t => ({ id: t.id, title: t.title, path: t.relPath, size: t.size }))
    return { artists: [], albums: [], tracks }
  }

  async art () {
    return null // milestone 2
  }

  // Range support is load-bearing and belongs here from day one: `offset` serves
  // BOTH seeking and resuming a half-finished pinned download. Bolting it on
  // later would mean reworking the client's whole fetch path.
  //
  // The folder adapter ignores `format` / `bitrate`: it has no transcoder to
  // delegate to (that is Navidrome's job). So a raw FLAC library over cellular
  // is the one case that still burns real data, and the client warns about that
  // combination - see DECISIONS 2026-07-13.
  async stream ({ trackId: id, offset = 0, length } = {}) {
    const t = this.byId.get(id)
    if (!t) return null

    const start = Math.max(0, Number(offset) || 0)
    if (start >= t.size) return null

    const end = length ? Math.min(t.size - 1, start + Number(length) - 1) : t.size - 1
    return fs.createReadStream(t.absPath, { start, end })
  }
}

module.exports = { FolderAdapter, AUDIO_EXT }

// Device avatars: a small photo a user sets ON THEIR DEVICE (the phone app), sent to
// the host over the identity channel and shown on the dashboard. Stored as plain
// files in the data dir, keyed by the device's Noise-authenticated key - NOT in the
// grant bee (a security surface scanned on every list) or the state bee. The phone
// resizes to ~200px JPEG before sending, so these are tens of KB.
//
// The key is a z32 device key (host-minted vocabulary, not free text), but it is
// encoded into the filename anyway so it can never escape the avatars dir.

const fs = require('fs')
const path = require('path')

const MAX_BYTES = 512 * 1024 // generous ceiling for a ~200px JPEG; the phone sends far less

class AvatarStore {
  constructor (dir) { this.dir = dir }

  _file (deviceKey) { return path.join(this.dir, encodeURIComponent(String(deviceKey))) }

  has (deviceKey) {
    try { return !!deviceKey && fs.existsSync(this._file(deviceKey)) } catch { return false }
  }

  get (deviceKey) {
    try { return fs.readFileSync(this._file(deviceKey)) } catch { return null }
  }

  // When this photo was last written, in ms. The dashboard puts it in the <img> URL: the
  // src is otherwise identical across polls, so the browser keeps showing the old photo
  // (the element is never re-fetched) until someone reloads the page. 0 when there is none.
  at (deviceKey) {
    try { return Math.floor(fs.statSync(this._file(deviceKey)).mtimeMs) } catch { return 0 }
  }

  set (deviceKey, buffer) {
    if (!deviceKey) throw new Error('deviceKey required')
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('empty image')
    if (buffer.length > MAX_BYTES) throw new Error('image too large (resize to ~200px first)')
    fs.mkdirSync(this.dir, { recursive: true })
    fs.writeFileSync(this._file(deviceKey), buffer, { mode: 0o600 })
  }

  delete (deviceKey) {
    try { fs.unlinkSync(this._file(deviceKey)) } catch {}
  }
}

module.exports = { AvatarStore, MAX_BYTES }

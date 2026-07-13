// Wire constants. Shared by the host (Node) and the phone worklet (Bare), so
// this file must stay dependency-light and free of any Node-only API.
//
// Protocol version lives in the Protomux protocol STRING, not in a field. A v2
// is a new string, and a host can serve both at once. See the proposal's Compat
// section.

module.exports = {
  PAIR_PROTOCOL: 'peartune/pair/1',
  MEDIA_PROTOCOL: 'peartune/media/1',

  // Link scheme for the pairing QR. Deliberately distinct from PearCircle's
  // `pear://pearcircle/...` and PearCal's `/join` so the parsers cross-reject.
  LINK_SCHEME: 'pear://peartune/pair',
  LINK_VERSION: 1,

  // A pairing session is open only while the operator has the dashboard open,
  // and never for more than this. Same posture as the PearCircle seeder: the
  // trust for a FIRST pair is "a session is open on a topic the operator just
  // minted", so the window has to be short.
  PAIR_TTL_MS: 5 * 60 * 1000,

  // Byte-stream chunk size for media.stream. 64 KiB is a compromise: big enough
  // that per-frame overhead is noise, small enough that a seek does not have to
  // wait on a fat in-flight frame.
  CHUNK_SIZE: 64 * 1024,

  // Error codes. Typed, because an unknown method must degrade rather than drop
  // the channel (Compat).
  ERR: {
    NO_METHOD: 'ENOMETHOD',
    NOT_FOUND: 'ENOTFOUND',
    BAD_PARAMS: 'EBADPARAMS',
    FORBIDDEN: 'EFORBIDDEN',
    INTERNAL: 'EINTERNAL'
  },

  SCOPE: {
    FULL: 'full',
    READONLY: 'readonly'
  }
}

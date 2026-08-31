// WHICH URLS THE SHELL WILL HAND TO THE OS, and it is a list rather than "whatever
// the page said".
//
// `shell:openUrl` used to pass its argument straight to Linking.openURL, so an
// `intent://` URL could launch an arbitrary Android component and a `file://` one
// could point a viewer at local storage. That needs the bundled page compromised
// first - which is exactly when a second lock is worth having (found 2026-08-31 by an
// audit of PearCinema, verified present here).
//
// These four are every scheme the UI actually opens: https (About links, the GitHub
// report), mailto (the emailed report), and the Lightning and on-chain tip addresses.
// Anything else is refused loudly rather than silently, so a NEW one arrives as a
// visible error in development rather than a mystery in the field.
//
// Its own file, like starve.js and queue-index.js beside it: app/index.tsx cannot be
// required from a node test, and a rule with no test is a rule that rots.

const OPENABLE_SCHEMES = ['https:', 'mailto:', 'lightning:', 'bitcoin:']

function openableUrl (raw) {
  const url = String(raw || '').trim()
  const colon = url.indexOf(':')
  if (colon < 1) return false
  // Case-insensitive per RFC 3986. `trim` above kills the leading-whitespace trick
  // ("\n intent://..."), which some parsers skip and others do not.
  return OPENABLE_SCHEMES.includes(url.slice(0, colon + 1).toLowerCase())
}

module.exports = { openableUrl, OPENABLE_SCHEMES }

// Downloading a GROUP - an artist, a genre - rather than one album.
//
// THE CONSTRAINT THAT SHAPES ALL OF THIS: a pin is ALBUM-KEYED in the worklet
// (`pins[albumId]`, src/bare.js). There is no such thing as a pinned artist. So
// "download this artist" is a loop over that artist's albums, and everything here
// exists to make that loop honest: which albums are already on the phone, what the
// button should say while the loop runs, and what to ask before starting it.
//
// Keeping it album-keyed rather than inventing a group pin is deliberate. Each album
// stays separately resumable, separately removable, and the Downloads list keeps
// meaning exactly what it means today. The cost is that a group has no state of its
// own - it is derived, every time, from its albums. Which is what this file is.
//
// Pure and separate from App.jsx so it can be tested: a group download is easy to get
// subtly wrong (re-downloading what is already there, a button that says "Download"
// after everything downloaded) and none of that shows up in a screenshot.

// The album ids behind an artist or genre detail object, in order, deduped.
// Loose tracks are NOT included: they belong to no album, so nothing can pin them.
export function albumIdsOf (detail) {
  const seen = new Set()
  for (const a of detail?.albums || []) {
    const id = a?.id
    if (id != null && !seen.has(id)) seen.add(id)
  }
  return [...seen]
}

// What a download would actually fetch: the albums not already on the phone. Asking
// "download 12 albums?" when 11 are already downloaded is a lie, and re-pinning them
// would re-stream bytes we hold.
export function pendingDownloads (albumIds, pinned) {
  const has = pinned instanceof Set ? (id => pinned.has(id)) : (id => !!pinned?.[id])
  return (albumIds || []).filter(id => !has(id))
}

// What the Download control should show for a group.
//
//   empty        nothing to download (an artist with no albums, only loose tracks)
//   downloading  the loop is running - `done` of `total` albums
//   downloaded   every album is on the phone; the control removes them
//   partial      some are; the control downloads the rest
//   none         none are
//
// `active` is the in-flight group ({ key, done, total }) or null, and it only counts
// when it is THIS group's key - two artists must not share one spinner.
export function groupDownloadState ({ albumIds, pinned, active, key }) {
  const ids = albumIds || []
  if (active && key != null && active.key === key) {
    return { kind: 'downloading', done: active.done || 0, total: active.total || 0, pending: [] }
  }
  if (!ids.length) return { kind: 'empty', done: 0, total: 0, pending: [] }
  const pending = pendingDownloads(ids, pinned)
  if (!pending.length) return { kind: 'downloaded', done: ids.length, total: ids.length, pending }
  if (pending.length < ids.length) {
    return { kind: 'partial', done: ids.length - pending.length, total: ids.length, pending }
  }
  return { kind: 'none', done: 0, total: ids.length, pending }
}

// The confirmation, which Tim asked for by name (2026-08-11): a whole genre can be most
// of a library, and a mis-tap should not quietly fill someone's phone.
//
// It counts what will ACTUALLY be fetched, not the group's size - "Download 3 albums"
// when nine of the twelve are already here.
export function downloadPrompt ({ name, count }) {
  const n = count || 0
  return {
    title: `Download ${name || 'this'}?`,
    body: `${n} album${n === 1 ? '' : 's'} will be kept on this phone, playable with no connection.`,
    yes: 'Download'
  }
}

// Removing a group. Destructive enough to confirm, mild enough not to shout: the music
// itself is untouched, only this phone's copy.
export function removePrompt ({ name, count }) {
  const n = count || 0
  return {
    title: 'Remove downloads?',
    body: `${n} downloaded album${n === 1 ? '' : 's'} from ${name || 'this'} will be deleted from this phone. Your library keeps them.`,
    yes: 'Remove',
    danger: true
  }
}

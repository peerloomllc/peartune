// WHERE YOU WERE - the view state that has to outlive a WebView rebuild.
//
// This is not a nicety, and it is not GrapheneOS-specific. PearTune DELIBERATELY
// tears its own WebView down: app/index.tsx terminates the render process after any
// background of WEBVIEW_RECOVERY_MIN_BG_MS (20s) and reloads a fresh one, because
// that is the only cure for the Vanadium resume-freeze. A reload is a cold document,
// so every piece of React state - the tab, the album you had opened, the scroll
// offset - is gone. Measured on the TCL (stock Android, 2026-07-30): away 8s, the
// About tab was still there; away 26s, `terminated 1 renderer(s)` then
// `render process gone -> reload`, and the app came back on the Library root.
// GrapheneOS hits the same reset harder because its WebView is torn down by the OS
// as well, but every Android phone loses its place today.
//
// So the state has to live somewhere the WebView cannot take with it. It goes in the
// worklet's settings.json, next to the theme and the density, for the reason recorded
// in src/bare.js: that is the ONE place holding what this device knows, and it
// survives the reload AND a genuine relaunch (Tim, 2026-07-30: restore on cold start
// too, the way Spotify and Apple Music do - no staleness rule to explain).
//
// Everything here is pure so it can be tested without a DOM: App.jsx owns the
// reading, writing and scrolling, this file owns what a valid snapshot IS.

// The tabs, drill-down screens and sub-views that may appear in a snapshot. Deliberate
// allow-lists rather than "whatever was in the file": settings.json is rewritten by an
// older or newer build of this app, and an unknown `tab` would render nothing at all -
// a blank screen with a navbar, which reads as a broken app rather than a stale setting.
export const VIEW_TABS = ['library', 'you', 'queue', 'settings', 'about']
export const VIEW_BROWSE = ['albums', 'artists', 'genres', 'songs']
export const VIEW_SCREENS = ['album', 'artist', 'genre', 'playlist', 'download']
export const YOU_VIEWS = ['favorites', 'top', 'playlists', 'downloads', 'requests', 'manage']

// A drill-down deeper than this is not a thing anyone did on purpose, and an unbounded
// array here would be an unbounded write on every navigation.
const MAX_STACK = 8
// A scroll offset past this is not a position, it is a corrupt number. The tallest
// real screen is a few thousand pixels.
const MAX_SCROLL = 200000
// Names are display-only (the header of a drill-down), so they are capped rather than
// trusted. The screen re-fetches everything else from its id.
const MAX_NAME = 200

export const DEFAULT_VIEW = {
  tab: 'library',
  browse: 'albums',
  youView: 'favorites',
  filter: '_all',
  stack: [],
  expanded: false,
  scroll: 0
}

const isId = (v) => (typeof v === 'string' && v.length > 0) || (typeof v === 'number' && Number.isFinite(v))

// One drill-down, reduced to the four fields the screens actually read. Anything else
// that was in the file is dropped rather than carried, so a snapshot cannot grow
// fields nobody restores.
function cleanScreen (raw) {
  if (!raw || typeof raw !== 'object') return null
  if (!VIEW_SCREENS.includes(raw.type) || !isId(raw.id)) return null
  const out = { type: raw.type, id: raw.id }
  if (typeof raw.name === 'string' && raw.name) out.name = raw.name.slice(0, MAX_NAME)
  // Only playlists have the flag, and it picks which worklet method fetches the screen -
  // so a stray `server` on an album must not ride along.
  if (raw.type === 'playlist' && raw.server === true) out.server = true
  return out
}

// Normalize on BOTH sides - what we write and what we read back. Writing through it
// means a snapshot can never contain a field no restore path handles; reading through
// it means a file written by another build (or half-written, or hand-edited) degrades
// to the Library root instead of throwing on launch.
export function normalizeViewState (raw) {
  if (!raw || typeof raw !== 'object') return null
  const stack = Array.isArray(raw.stack)
    ? raw.stack.slice(0, MAX_STACK).map(cleanScreen).filter(Boolean)
    : []
  return {
    tab: VIEW_TABS.includes(raw.tab) ? raw.tab : 'library',
    browse: VIEW_BROWSE.includes(raw.browse) ? raw.browse : 'albums',
    youView: YOU_VIEWS.includes(raw.youView) ? raw.youView : 'favorites',
    filter: typeof raw.filter === 'string' && raw.filter ? raw.filter : '_all',
    stack,
    expanded: raw.expanded === true,
    scroll: Number.isFinite(raw.scroll) && raw.scroll > 0 ? Math.min(Math.round(raw.scroll), MAX_SCROLL) : 0
  }
}

// Is this snapshot worth acting on? A device that has only ever sat on the Library
// root has nothing to restore, and saying so lets the caller skip the whole restore
// path (and its scroll retry loop) on a first run.
export function isDefaultView (v) {
  const n = normalizeViewState(v)
  if (!n) return true
  return n.tab === 'library' && n.browse === 'albums' && n.filter === '_all' &&
    n.stack.length === 0 && !n.expanded && n.scroll === 0
}

// Skip the write when nothing moved. Scrolling fires this constantly, and the
// alternative is rewriting settings.json for every idle status tick.
export function sameViewState (a, b) {
  if (!a || !b) return a === b
  return JSON.stringify(a) === JSON.stringify(b)
}

// PearTune UI.
//
// Albums are the way in, not a flat track list. Two reasons, and the second is
// the hard one: a 1358-track flat list is not a music app, AND Subsonic has no
// "all songs" endpoint - a flat list can only ever show the first page of albums
// walked. Browsing by album is both the better UX and the only correct one.
//
// Navigation, suite-standard: a bottom navbar for the three top-level tabs, and a
// stack for drill-downs (album, artist). Android's back button pops that stack via
// the shell (shell:navState out, a 'back' event in); at the root the shell stops
// swallowing the press and the OS closes the app.

import { useEffect, useState, useRef } from 'react'
import jsQR from 'jsqr'
import {
  MusicNotes, MusicNotesSimple, UsersThree, Gear, Info, CaretRight, CaretLeft,
  CaretDown, Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, RepeatOnce, X,
  ArrowCounterClockwise, ArrowClockwise, Heart, CurrencyBtc, ShareNetwork,
  EnvelopeSimple, Code, Copy, PlugsConnected, ArrowsClockwise, Rows, SquaresFour,
  GridFour, ListPlus, Queue as QueueIcon, Trash, Plus, Playlist as PlaylistIcon,
  PencilSimple, DotsSixVertical, DownloadSimple, CheckCircle, CircleNotch,
  Palette, SpeakerHigh, Key, ChartLineUp, ArrowUp, ArrowDown, Faders, Moon, Camera
} from '@phosphor-icons/react'
import { call, on, haptic } from './bridge'
import { loadThemePref, applyThemePref, onSystemThemeChange } from './theme'

// --- About + donation (suite config, shared across PeerLoom apps) ------------
const APP_VERSION = '0.1.0'
const LIGHTNING_ADDRESS = 'peerloomllc@strike.me'
const STRIKE_TIP_URL = 'https://strike.me/peerloomllc/'
const BTC_ONCHAIN_ADDRESS = 'bc1q0kksenz3j4u9ppe6f4krclvzwxk7sjy00cc9cf'
const BUYMEACOFFEE_URL = 'https://buymeacoffee.com/peerloomllc'
const GITHUB_URL = 'https://github.com/peerloomllc/peartune'
const CONTACT_URL = 'mailto:peerloomllc@proton.me?subject=%5BPearTune%5D%20Feedback'
const SHARE_TEXT = 'PearTune - your self-hosted music, playable anywhere. No port forwarding, no VPN, no account.\n\nhttps://peerloomllc.com/peartune/'
// iOS hides the donation section per App Store guideline 3.1.1 (no external
// donation links). The shell injects the platform before the bundle runs.
const isIOS = () => typeof window !== 'undefined' && window.__pearPlatform === 'ios'

const openUrl = (url) => { call('shell:openUrl', { url }).catch(() => {}) }
const copyText = (text) => call('shell:clipboard', { text }).catch(() => {})

// Grid density. One control, not two: "grid or list" and "how many per row" are the
// same axis, and splitting them would give four states to explain for one decision.
// 4-up is deliberately absent - on a phone that is an ~85px cover, too small to
// recognise the art, which is the only reason to show a grid at all.
//
// The art SIZE follows the density. A cover fetched at 300px into a ~500px 2-up
// tile is visibly soft, and a 500px cover behind a 110px list row is bytes over P2P
// that nobody will ever see.
const DENSITY = {
  list: { cols: 1, art: 120, Icon: Rows, next: '2' },
  2: { cols: 2, art: 500, Icon: SquaresFour, next: '3' },
  3: { cols: 3, art: 350, Icon: GridFour, next: 'list' }
}
const densityOf = (d) => DENSITY[d] || DENSITY[2]

// The {sort,order} params for a view's chosen sort in a sort map, or {} for none
// (so the call falls through to the source's default order). Pure, so it works on a
// sort object that has NOT been committed to state yet - the restore-on-launch load
// and applySort's optimistic reload both need the params before setSort lands.
const sortParamsFor = (sortMap, view) => {
  const s = sortMap && sortMap[view]
  return s?.key ? { sort: s.key, order: s.order || 'asc' } : {}
}

export default function App () {
  const [state, setState] = useState({ loading: true })
  const [tab, setTab] = useState('library')
  const [stack, setStack] = useState([]) // drill-downs: album, artist
  const [browse, setBrowse] = useState('albums')
  const [albums, setAlbums] = useState([])
  const [cursor, setCursor] = useState(0)
  const [recent, setRecent] = useState(null) // the Recently Added shelf (newest albums)
  const [artists, setArtists] = useState(null)
  const [genres, setGenres] = useState(null)
  const [songs, setSongs] = useState(null)
  const [songCursor, setSongCursor] = useState(0)
  const [density, setDensity] = useState('2')
  // Per-view sort choice: { albums:{key,order}, artists:{key,order}, songs:{key,order} }.
  // Absent = the source's default (shelf) order. Which keys are OFFERED comes from the
  // host's advertised capability (state.sorts), so a source that cannot sort a view
  // (Subsonic songs) shows no control at all.
  const [sort, setSort] = useState({})
  const [display, setDisplay] = useState(false) // the layout + sort bottom sheet
  const [ident, setIdent] = useState(null) // device name + user claim
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [now, setNow] = useState(null)
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)
  const [scanning, setScanning] = useState(false)
  // Names live HERE, not inside Welcome, so a failed scan/pair that unmounts the
  // form does not wipe what you typed. `pairing` is the in-flight state between
  // "link accepted" and "host answered" - without it, pairing looked like nothing
  // was happening (you were dropped back on the onboarding screen mid-handshake).
  const [pairNames, setPairNames] = useState({ deviceName: '', userName: '' })
  const [pairing, setPairing] = useState(false)
  // Adding ANOTHER library from Settings (multi-host, 2026-07-19). Shows the same pairing
  // flow as onboarding, but over the running app instead of the pairing wall.
  const [addingLibrary, setAddingLibrary] = useState(false)
  const [donate, setDonate] = useState(false)
  const [confirming, setConfirming] = useState(null)
  const [menu, setMenu] = useState(null) // long-press: play / shuffle / queue
  const [queue, setQueue] = useState(null) // the up-next list, when opened
  const [note, setNote] = useState(null) // a transient confirmation
  const [viewing, setViewing] = useState(null) // artwork, full screen
  const [expanded, setExpanded] = useState(false) // the player: mini vs full
  const [skin, setSkin] = useState('modern') // player skin: modern | classic (the retro Winamp-style face)
  const [albumsLoaded, setAlbumsLoaded] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [shuffle, setShuffle] = useState(false)
  const [repeat, setRepeat] = useState(0) // 0 off, 1 one, 2 all
  const [sleep, setSleep] = useState(null) // sleep timer: { active, endOfTrack, deadline } from the shell
  const [sleepOpen, setSleepOpen] = useState(false) // the sleep-timer picker sheet
  const [themePref, setThemePref] = useState(() => loadThemePref())
  // Favorited ids, grouped by kind (track / album / artist). Sets for O(1) heart checks.
  const [favs, setFavs] = useState(() => ({ track: new Set(), album: new Set(), artist: new Set() }))
  const [favSupported, setFavSupported] = useState(true) // false = host too old
  const [favItems, setFavItems] = useState(null) // the Favorites view, resolved + grouped
  const [cont, setCont] = useState(null) // "continue listening": { track, positionMs }
  const [handoff, setHandoff] = useState(null) // another device holds the play session: { activeDeviceName, count }
  const [mostPlayed, setMostPlayed] = useState(null) // the Most Played view: { items }
  const [youView, setYouView] = useState('favorites') // the "You" tab's sub-picker: favorites | top | playlists
  const [playlists, setPlaylists] = useState(null) // the Playlists list: [{ id, name, count }]
  const [plSupported, setPlSupported] = useState(true) // false = host too old for playlists
  const [serverPls, setServerPls] = useState(null) // the source's OWN playlists (read-only, v2)
  const [addingTo, setAddingTo] = useState(null) // an item pending "add to playlist" (the picker)
  const [naming, setNaming] = useState(false) // the "new playlist" name prompt
  const [pinned, setPinned] = useState(() => new Set()) // pinned (downloaded) album ids
  const [pinning, setPinning] = useState({}) // albumId -> { done, total } while downloading
  const [downloads, setDownloads] = useState(null) // the Downloads view: [{ id, name, ... }]
  // Merged library (multi-host step 2): when 2+ hosts are paired the library home is the BLENDED,
  // deduped view of all of them, and `merged` holds its per-source status ({ merged, libraries:
  // [{libraryId, libraryName, connected, trackCount}], counts }) for the filter chips + greying.
  // `filter` is the selected source chip: '_all' (the blend) or one library's id (a per-host view,
  // which is just the merged index filtered). Null merged = single-host, the unchanged experience.
  const [merged, setMerged] = useState(null)
  const [filter, setFilter] = useState('_all')

  useEffect(() => {
    call('init')
      .then((s) => {
        setState({ ...s, loading: false })
        if (s.settings?.density) setDensity(String(s.settings.density))
        if (s.settings?.skin) setSkin(String(s.settings.skin))
        // Restore the persisted per-view sort. Held in a local, not read back from state,
        // for the load below: setSort has not committed yet in this same tick, so the
        // first albums load must take its params directly (same reason applySort does).
        const savedSort = s.settings?.sort && typeof s.settings.sort === 'object' ? s.settings.sort : null
        if (savedSort) setSort(savedSort)
        loadPinned() // pins are local - available even offline
        // Restore the paused queue from the last session (the shell rebuilds it and
        // emits play:started, which lights up the mini-player). Fire-and-forget: a
        // cached queue restores offline; an uncached one waits for the connection.
        call('restore').then(r => { if (r?.restored) setCont(null) }).catch(() => {})
        // Merged is the default when 2+ hosts are paired: the browse serves from the cached index
        // INSTANTLY (no connection needed), and a background rebuild refreshes it via merged:updated.
        setMerged(s.merged || null)
        if (s.merged?.merged) loadAlbums(0, sortParamsFor(savedSort, 'albums'))
        if (s.connected) { loadAlbums(0, sortParamsFor(savedSort, 'albums')); loadRecent(); loadSource(); loadFavs(); loadContinue(); loadHandoff(); loadPlaylists() }
      })
      .catch(e => setState({ loading: false, error: e.message }))

    const offs = [
      on('play:started', (d) => {
        setNow(d); setError(null)
        setHandoff(null) // we are the active player now - hide any "Playing on <other>" card
        countedRef.current = { trackId: d?.trackId, counted: false } // a fresh play to count
      }),
      on('play:status', setStatus),
      // Session handoff: another device took the token, so we paused. Say so, then refresh the
      // card so the user can "Play here" again to take it back. The retry covers the lazy-presence
      // race where our loadHandoff beats the new owner's claim propagating to our read.
      on('play:handedoff', () => { toast('Now playing on your other device.'); loadHandoff(); setTimeout(loadHandoff, 2000) }),
      // Add-to-queue grows the queue but does not touch playback, so no play:status
      // follows - update the length the navbar badge reads from this event instead,
      // or the badge stays stale until the next status tick.
      on('play:queued', (d) => setStatus(s => ({ ...(s || {}), queueLength: d.queueLength }))),
      on('play:stopped', () => { setNow(null); setStatus(null); setSleep(null); loadContinue(); loadHandoff() }),
      // Sleep timer state from the shell (where the countdown actually lives). `fired`
      // means the timer just stopped playback; the deadline drives the UI countdown.
      on('sleep:state', (d) => {
        setSleep(d.active ? d : null)
        if (d.fired) toast('Sleep timer — playback paused.')
      }),
      on('play:error', (d) => setError(d.error)),
      // The buffer ran dry while we were disconnected and could not get back in - a
      // revoke, or a network hole. play:stopped clears the player; this just says why,
      // once, without claiming "revoked" (from here it is indistinguishable from a
      // tunnel - see the host:disconnected note below).
      on('play:lost', () => toast('Lost the connection to your library.', true)),
      // Album downloads (phase 5C): live progress, then settle the pinned set + Downloads.
      on('pin:progress', (d) => setPinning(p => ({ ...p, [d.albumId]: { done: d.done, total: d.total } }))),
      on('pin:done', (d) => {
        setPinning(p => { const n = { ...p }; delete n[d.albumId]; return n })
        setPinned(s => new Set(s).add(d.albumId))
        loadDownloads(true)
        haptic('success')
      }),
      on('pin:error', (d) => {
        setPinning(p => { const n = { ...p }; delete n[d.albumId]; return n })
        haptic('warn'); toast(d.err || 'Download failed', true)
        loadDownloads(true)
      }),
      // The link died. Usually this is just Android suspending us in the
      // background, so do NOT accuse the server of revoking anyone - we cannot
      // tell the difference from here, and "your access may have been revoked" is
      // an alarming thing to say when the real answer is "you locked your phone".
      // Mark it and move on; the next thing that needs the wire will reconnect.
      on('host:disconnected', () => {
        // A drop is no longer a stop: the shell keeps the buffer playing and tries to
        // reconnect (proposal 2026-07-14). So DON'T clear the now-playing UI - the
        // music is still going. Just note we are off the wire; play:stopped is what
        // clears the player, and only if the buffer actually starves (a revoke).
        setState(s => ({ ...s, connected: false }))
        // In merged mode, re-read the per-library status (cheap - no rebuild): a revoke drops the
        // host's pool connection at once, so this greys its chip + Settings row immediately, without
        // waiting for the next index rebuild. A transient background drop greys it too and un-greys
        // on reconnect - honest either way. Query now AND after a beat: the single-client close (this
        // event) and the pool close race by a few ms on a revoke, so the delayed read catches the
        // pool drop if it lagged.
        const regrey = () => { if (mergedRef.current?.merged) call('mergedStatus').then(st => { if (st?.libraries) setMerged(st) }).catch(() => {}) }
        regrey(); setTimeout(regrey, 1200)
      }),
      on('host:connected', (d) => {
        setState(s => ({ ...s, connected: true, host: { ...s.host, ...d } }))
        setError(null)
        // init connects in the BACKGROUND now, so this event - not init - is what kicks
        // off the first library load, and refreshes it on every reconnect.
        loadIdentity()
        loadSource()
        loadFavs()
        loadContinue()
        loadHandoff(); setTimeout(loadHandoff, 2000) // retry: the active device may push its queue just after we connect
        loadPlaylists(true)
        // In merged mode, if any paired host is still missing from the blend, rebuild to fold the
        // one that just came online in (merged:updated then reloads browse + chips). If the blend is
        // already complete, just re-render browse from the current index rather than re-fetching.
        if (mergedRef.current?.merged) {
          if ((mergedRef.current.libraries || []).some(l => !l.connected)) call('refreshMerged').catch(() => {})
          else reloadBrowse()
        } else {
          loadAlbums(0)
          loadRecent()
        }
      }),
      // A background merged rebuild landed (launch, a host (re)joining, a pull-to-refresh): update
      // the source chips + greying and re-render the browse from the fresh blend.
      on('merged:updated', (st) => { setMerged(st); reloadBrowse() }),
      // The operator renamed the library on the dashboard; the worklet caught it on connect and
      // persisted it. Reflect it live in the header, the Settings switcher, and the merged chips.
      on('host:renamed', (d) => {
        setState(s => ({
          ...s,
          host: s.host?.hostKey === d.hostKey ? { ...s.host, libraryName: d.libraryName } : s.host,
          hosts: (s.hosts || []).map(h => h.hostKey === d.hostKey ? { ...h, libraryName: d.libraryName } : h)
        }))
        if (mergedRef.current?.merged) call('mergedStatus').then(st => { if (st?.libraries) setMerged(st) }).catch(() => {})
      }),

      // Switched to another paired library (multi-host, 2026-07-19). Swap the browse to the
      // new library and flip the active flag; the currently-playing track is left ALONE (a
      // switch must not stop the music - it plays out of the shared cache). If already
      // connected (switchHost awaits the connect), pull the new library now; otherwise the
      // host:connected that the background reconnect fires will.
      on('host:switched', (d) => {
        setState(s => ({
          ...s,
          host: { ...s.host, hostKey: d.hostKey, libraryId: d.libraryId, libraryName: d.libraryName },
          hosts: (s.hosts || []).map(h => ({ ...h, active: h.hostKey === d.hostKey }))
        }))
        // A Settings switch focuses ONE library (the worklet left merged mode); drop the blended
        // view and its chips. The '_all' chip re-enters merged.
        setMerged(m => (m ? { ...m, merged: false } : m)); setFilter('_all')
        setAlbums([]); setArtists(null); setAlbumsLoaded(false); setStack([]); setResults(null); setQuery(''); setError(null)
        if (liveRef.current?.connected) {
          loadAlbums(0); loadRecent(); loadSource(); loadFavs(); loadContinue(); loadPlaylists(true)
        }
        // Swap the play queue to the new library: if a track is playing it drains first, then
        // the new library's queue takes over; if nothing is playing it swaps straight over
        // (the shell decides - see switchQueue). A mid-play track is never cut off.
        call('switchQueue').catch(() => {})
      }),

      // Back from the background, where the link almost certainly died. Reconnect
      // BEFORE the user asks: they came back to a music app, not to a status page.
      // A ref, not state, because this listener registers once.
      on('app:active', () => {
        const s = liveRef.current
        if (s.host && !s.connected && !s.reconnecting) reconnect()
        loadHandoff() // lazy presence: another device may have started/stopped while we were away
      })
    ]
    return () => offs.forEach(f => f())
  }, [])

  // What the once-registered listeners above need to see, always current.
  const liveRef = useRef({})
  liveRef.current = { host: state.host, connected: state.connected, reconnecting }

  // Merged-mode refs, for the same reason as sortRef below: the once-registered listeners (and the
  // loaders they fire) captured the first render, so they read the CURRENT source filter, merged
  // status, and browse view through refs. filterRef is also set synchronously by the chip tap so a
  // reload picks up the new filter before setState commits.
  const mergedRef = useRef(null); mergedRef.current = merged
  const filterRef = useRef('_all'); filterRef.current = filter
  const browseRef = useRef('albums'); browseRef.current = browse

  // Reload whichever browse view is showing, from the current source filter (used after a merged
  // rebuild, and by a chip tap). Mirrors applySort's reset-then-load per view.
  function reloadBrowse () {
    const v = browseRef.current
    if (v === 'albums') { setAlbums([]); setCursor(0); setAlbumsLoaded(false); loadAlbums(0) }
    else if (v === 'artists') { setArtists(null); loadArtists() }
    else if (v === 'genres') { setGenres(null); loadGenres() }
    else if (v === 'songs') { setSongs(null); setSongCursor(0); loadSongs(0) }
  }

  // Pick a source-filter chip: '_all' (the blend) or one library's id. Any chip RE-ENTERS merged
  // mode first if a Settings switch had focused a single library. Set the ref synchronously so the
  // reload reads the new filter immediately.
  function pickFilter (libraryId) {
    haptic('light')
    filterRef.current = libraryId
    setFilter(libraryId)
    setStack([]); setResults(null); setQuery('')
    if (merged && !merged.merged) {
      call('enterMerged').then(st => { if (st?.libraries) { setMerged(st); reloadBrowse() } }).catch(() => {})
    } else {
      reloadBrowse()
    }
  }

  // The per-view sort, via a ref, because the loaders run from once-registered
  // listeners (host:connected fires the first library load) whose closures captured
  // the FIRST render's empty sort - reading the ref lets a no-param load pick up a
  // sort restored from settings on launch. sortParams reads this, not the state.
  const sortRef = useRef({})
  sortRef.current = sort

  // Resume positions (milestone 3, phase 2): every 8s while a track plays, save its
  // position to the host, so it (and any of this person's other devices) can pick up
  // where they left off. Clear near the end so a finished track starts fresh. Refs,
  // because the interval registers once and must read the CURRENT track/status.
  const nowRef = useRef(null); nowRef.current = now
  const statusRef = useRef(null); statusRef.current = status

  // A resume seek waiting for its track to be ready to accept it (set in playFrom).
  const pendingResumeRef = useRef(null)
  // A play is counted ONCE, after it has been listened to past a threshold. Reset each
  // time a track starts (play:started), so a replay counts again.
  const countedRef = useRef({ trackId: null, counted: false })
  useEffect(() => {
    const pr = pendingResumeRef.current
    if (!pr || !status || nowRef.current?.trackId !== pr.trackId) return
    // The track is live and reporting status now, so the player will honour the seek.
    // Only apply while still near the start, then clear so we never re-seek.
    if ((status.positionMs || 0) < pr.positionMs) {
      pendingResumeRef.current = null
      call('seekTo', { ms: pr.positionMs }).catch(() => {})
    }
  }, [status])

  useEffect(() => {
    const iv = setInterval(() => {
      const t = nowRef.current
      const s = statusRef.current
      if (!t?.trackId || !s) return
      const pos = s.positionMs || 0
      const dur = s.durationMs || t.durationMs || 0
      if (pos < 5000) return // the first few seconds are not a resume point
      const clear = dur && pos > dur * 0.95
      call('resumeSave', { trackId: t.trackId, positionMs: clear ? 0 : pos, durationMs: dur }).catch(() => {})

      // Count a PLAY once it has been listened to past the scrobble threshold (half the
      // track, or 4 minutes, whichever comes first) - and only once per play.
      const c = countedRef.current
      const threshold = dur ? Math.min(dur * 0.5, 240000) : 240000
      if (c.trackId === t.trackId && !c.counted && pos >= threshold) {
        countedRef.current = { trackId: t.trackId, counted: true }
        call('countBump', { trackId: t.trackId }).catch(() => {})
      }
    }, 8000)
    return () => clearInterval(iv)
  }, [])

  // Who this device says it is. The HOST is the authority on what its dashboard
  // shows, so this is read back from it rather than trusted from local settings.
  async function loadIdentity () {
    try {
      setIdent(await call('identity'))
    } catch {
      // Offline, or an old host with no identity API. Settings shows what we know.
    }
  }

  // WHICH library am I looking at? While only one source can be active at a time,
  // the app is the only place that can say which - a Navidrome, a Jellyfin and a raw
  // folder are three very different libraries, and now that any Subsonic server rides
  // the same source, "Navidrome" alone is no longer even the honest word for it.
  // Cheap (one stats call), and it refreshes on every reconnect and pull-to-refresh,
  // so flipping the source in the dashboard shows up here on the next pull.
  async function loadSource () {
    try {
      const st = await call('stats')
      // sourceName is the server's OWN name for itself ("Nextcloud Music", "Gonic",
      // "Emby Server"); source is the coarse kind. Prefer the specific one, keep the
      // kind so an older host with no sourceName still gets a label.
      setState(s => ({ ...s, source: st.source, sourceName: st.sourceName || null, sorts: st.sorts || null }))
    } catch {
      // Offline, or a host too old to answer: the indicator just stays hidden.
    }
  }

  async function saveIdentity ({ deviceName, userName }) {
    const r = await call('setIdentity', { deviceName, userName })
    setIdent(i => ({ ...i, ...r, supported: true }))
    haptic('success')
    toast('Sent to your server')
    return r
  }

  // "Added 12 tracks to the queue." Queueing is otherwise INVISIBLE - the music
  // does not change, which is the whole point of it - so without a word on screen
  // the button looks broken.
  const noteTimer = useRef(null)
  function toast (msg, bad = false) {
    setNote({ msg, bad })
    clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => setNote(null), bad ? 3200 : 2400)
  }

  // --- theme -----------------------------------------------------------------
  //
  // The preference is already painted: the shell read it out of the worklet and
  // stamped data-theme before this document loaded. All that is left is to follow
  // the OS while the preference is 'system'.
  useEffect(() => {
    if (themePref !== 'system') return undefined
    return onSystemThemeChange(() => applyThemePref('system'))
  }, [themePref])

  const changeTheme = (pref) => {
    setThemePref(pref)
    applyThemePref(pref)
  }

  // Streaming quality. Lives in the worklet's settings next to the theme, because the
  // SHIM reads it (in the worklet) to decide whether to ask the host for a transcode -
  // the WebView never touches audio. Optimistic: reflect the choice now, persist async.
  const changeQuality = (q) => {
    haptic('light')
    setState(s => ({ ...s, settings: { ...(s.settings || {}), streamQuality: q } }))
    call('setSettings', { streamQuality: q }).catch(() => {})
  }

  // --- navigation ------------------------------------------------------------
  //
  // Android back, suite convention: tell the shell whether we have anything to
  // pop, and it only swallows the press when we do - otherwise the OS closes the
  // app, as it should at the root. A ref, because the 'back' listener registers
  // once and must still see the latest state.
  const navRef = useRef({})
  navRef.current = { scanning, donate, confirming, menu, viewing, expanded, stack, tab }

  const canBack = !!(
    scanning || donate || confirming || menu || viewing || expanded ||
    stack.length || tab !== 'library'
  )
  useEffect(() => { call('shell:navState', { canBack }).catch(() => {}) }, [canBack])

  // Deepest layer first: artwork, then a sheet, then the expanded player, then the
  // screen stack, then back to the Library tab. Only when all of that is empty does
  // the shell stop swallowing the press and Android closes the app.
  useEffect(() => on('back', () => {
    const n = navRef.current
    if (n.viewing) return setViewing(null)
    if (n.menu) return setMenu(null)
    if (n.donate) return setDonate(false)
    if (n.confirming) return setConfirming(null)
    if (n.scanning) return setScanning(false)
    if (n.expanded) return setExpanded(false)
    if (n.stack.length) return setStack(s => s.slice(0, -1))
    if (n.tab !== 'library') return setTab('library')
  }), [])

  const push = (screen) => { haptic('light'); setStack(s => [...s, screen]) }
  const pop = () => setStack(s => s.slice(0, -1))

  // A tab is a fresh start, so it drops any drill-down under it. Entering "You"
  // kicks off the active collection's fetch (each loader guards on its own cache).
  const goTab = (k) => { haptic('light'); setStack([]); setTab(k); if (k === 'you') openYou(youView) }

  // Open a "You" sub-view, loading it. Favorites is the default, but an old host with
  // no favorites support has only Most Played, so fall through to it rather than land
  // on an empty, unswitchable Favorites list.
  const openYou = (v) => {
    if (v === 'downloads') showDownloads()
    else if (v === 'playlists') showPlaylists()
    else if (v === 'top' || !favSupported) showMostPlayed()
    else showFavorites()
  }

  // The dock (player + navbar) is fixed, so the content underneath has to know how
  // tall it is or its last row hides behind it. It changes height when the player
  // appears, so MEASURE it - a hardcoded number rots the first time the transport
  // gains a row.
  const dockRef = useRef(null)
  useEffect(() => {
    const root = document.documentElement
    const el = dockRef.current
    if (!el) {
      root.style.setProperty('--dock-h', '0px')
      return undefined
    }
    const sync = () => root.style.setProperty('--dock-h', el.offsetHeight + 'px')
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [state.host, now, tab, stack.length])

  // --- data ------------------------------------------------------------------

  // Which host capability key backs each browse view (the Songs view is 'tracks'
  // server-side), and the {sort,order} params for a view's active choice - empty
  // when none, so a call falls through to the source's default order.
  const SORT_TYPE = { genres: 'genres', albums: 'albums', artists: 'artists', songs: 'tracks' }
  const sortParams = (view) => sortParamsFor(sortRef.current, view)

  // Change (or clear) the sort for a view and reload it from the top. The new params
  // are passed straight into the loader rather than read back from state, because
  // setSort has not committed yet when the reload fires.
  function applySort (view, key, order) {
    const entry = key ? { key, order: order || 'asc' } : null
    const next = { ...sort, [view]: entry }
    setSort(next)
    // Persist the choice so it survives a relaunch, like density - it rides the same
    // worklet settings.json (state used to reset every launch; density did not - v1 gap).
    call('setSettings', { sort: next }).catch(() => {})
    const params = entry ? { sort: entry.key, order: entry.order } : {}
    haptic('light')
    if (view === 'albums') { setAlbums([]); setCursor(0); setAlbumsLoaded(false); loadAlbums(0, params) }
    else if (view === 'artists') { setArtists(null); loadArtists(params) }
    else if (view === 'genres') { setGenres(null); loadGenres(params) }
    else if (view === 'songs') { setSongs(null); setSongCursor(0); loadSongs(0, params) }
  }

  async function loadAlbums (from, params) {
    try {
      const page = await call('albums', { cursor: from, limit: 60, libraryId: filterRef.current, ...(params ?? sortParams('albums')) })
      setAlbums(a => (from ? [...a, ...page.items] : page.items))
      setCursor(page.nextCursor)
      setAlbumsLoaded(true)
    } catch (e) {
      setError(e.message)
      // Loaded means "we have an answer", including a bad one. Leaving it false
      // would spin skeletons forever behind the error.
      setAlbumsLoaded(true)
    }
  }

  // The host went away (revoked, rebooted, or the Umbrel is simply off). Paired
  // but unreachable is a NORMAL state for this app, not an error state, so it gets
  // a real screen with a button rather than a red banner and a shrug.
  async function reconnect () {
    setReconnecting(true)
    setError(null)
    try {
      await call('reconnect')
      setAlbums([])
      setArtists(null)
      setAlbumsLoaded(false)
      await loadAlbums(0)
      loadSource()
      haptic('success')
    } catch (e) {
      setError(e.message)
      haptic('warn')
    } finally {
      setReconnecting(false)
    }
  }

  // Artists load once, on the first visit: getArtists returns the whole index in
  // a single call, so unlike albums there is nothing to page.
  async function loadArtists (params) {
    try {
      const page = await call('artists', { libraryId: filterRef.current, ...(params ?? sortParams('artists')) })
      setArtists(page.items)
    } catch (e) {
      setError(e.message)
    }
  }

  async function showArtists (force) {
    setBrowse('artists')
    if (artists && !force) return
    await loadArtists()
  }

  // The Recently Added shelf: the newest albums, by the source's "date added" (folder
  // mtime, Subsonic newest, Jellyfin DateCreated). Only meaningful when the host
  // advertises the 'added' album sort (older hosts would return alphabetical), so the
  // shelf is gated on that capability at render; a failure just leaves it hidden.
  async function loadRecent () {
    // The blended index carries no per-host "date added", so the Recently Added shelf is a
    // single-host affordance; in merged mode it stays hidden (a cross-host recent is a refinement).
    if (mergedRef.current?.merged) { setRecent([]); return }
    try {
      const page = await call('albums', { sort: 'added', order: 'desc', limit: 12 })
      setRecent(page.items || [])
    } catch { setRecent([]) }
  }

  // Genres load once, like artists - the host returns the whole set in one call.
  async function loadGenres (params) {
    try {
      const page = await call('genres', { libraryId: filterRef.current, ...(params ?? sortParams('genres')) })
      setGenres(page.items)
    } catch (e) {
      setError(e.message)
    }
  }

  async function showGenres (force) {
    setBrowse('genres')
    if (genres && !force) return
    await loadGenres()
  }

  // The Songs view. It exists because Navidrome answers an empty-query search3
  // with everything, PAGED - so this is a real list, not the album walk the old
  // code did (which could only ever reach the first page of albums, and is why
  // this view was dropped the first time round).
  async function loadSongs (from, params) {
    try {
      const page = await call('tracks', { cursor: from, limit: 100, libraryId: filterRef.current, ...(params ?? sortParams('songs')) })
      setSongs(s => (from ? [...(s || []), ...page.items] : page.items))
      setSongCursor(page.nextCursor)
    } catch (e) {
      setError(e.message)
      setSongs(s => s || [])
    }
  }

  async function showSongs (force) {
    setBrowse('songs')
    if (songs && !force) return
    setSongs(null)
    await loadSongs(0)
  }

  // --- favorites (host-as-hub, milestone 3) -----------------------------------
  //
  // The host owns the truth; `favs` is a local mirror so the hearts are instant. An
  // old host (no favorites support) reports supported:false, and we hide the hearts
  // rather than show a control that does nothing.
  // The "continue listening" candidate for the launch card: the last track you were
  // playing, resolved and ready to render. Refreshed on connect and when playback stops.
  async function loadContinue () {
    try {
      setCont(await call('resumeLatest'))
    } catch {}
  }

  // Session handoff: show a "Playing on <name>" card when ANOTHER of this person's devices is
  // the active player with a non-empty queue. Cleared when this device becomes the active one
  // (play:started) or when the host does not support handoff / has no session.
  async function loadHandoff () {
    try {
      const s = await call('sessionInfo')
      setHandoff(s && s.supported && !s.active && s.hasQueue ? s : null)
    } catch { setHandoff(null) }
  }

  // "Play here": adopt the session from the other device. The shell claims the token, rebuilds
  // the queue, seeks to the handed position and plays; play:started then clears the card.
  function playHere () {
    haptic('medium')
    setHandoff(null) // optimistic - play:started confirms
    call('playHere').catch(() => toast('Could not take over the session.', true))
  }

  async function loadFavs () {
    try {
      const r = await call('favorites') // { track, album, artist, supported }
      setFavs({ track: new Set(r.track || []), album: new Set(r.album || []), artist: new Set(r.artist || []) })
      setFavSupported(r.supported !== false)
    } catch {
      // Keep whatever we have (offline, transient) - the worklet already falls back to
      // its cache, so a throw here is rare.
    }
  }

  // Optimistic toggle of a favorite of any KIND (track / album / artist). Flip the heart
  // at once, tell the host, revert if it refuses. Favoriting needs a connection (Phase 1).
  async function onFav (kind, item) {
    const id = item.id
    const on = !favs[kind].has(id)
    setFavs(prev => {
      const set = new Set(prev[kind])
      if (on) set.add(id); else set.delete(id)
      return { ...prev, [kind]: set }
    })
    haptic('light')
    try {
      await call('toggleFav', { kind, id, on })
      // Keep the Favorites VIEW in sync. ADDING invalidates the resolved list so it
      // re-fetches on the next open (an empty group is still truthy). REMOVING filters
      // the row out of its group instantly.
      if (on) setFavItems(null)
      else {
        const key = kind === 'track' ? 'tracks' : kind === 'album' ? 'albums' : 'artists'
        setFavItems(prev => (prev ? { ...prev, [key]: prev[key].filter(x => x.id !== id) } : prev))
      }
    } catch (e) {
      setFavs(prev => {
        const set = new Set(prev[kind])
        if (on) set.delete(id); else set.add(id)
        return { ...prev, [kind]: set }
      })
      setNote(favSupported ? 'Could not update favorite' : 'Favorites need a server update')
    }
  }

  // The Most Played view: the owner's top tracks, resolved (with their play counts).
  async function showMostPlayed (force) {
    setYouView('top')
    if (mostPlayed && !force) return
    setMostPlayed(null)
    try {
      setMostPlayed(await call('topPlayed', { limit: 50 }))
    } catch (e) {
      setError(e.message)
      setMostPlayed({ items: [] })
    }
  }

  // The Favorites VIEW resolves the favorited ids to renderable objects, grouped
  // { tracks, albums, artists }.
  async function showFavorites (force) {
    setYouView('favorites')
    if (favItems && !force) return
    setFavItems(null)
    try {
      const r = await call('favoriteItems')
      setFavItems({ tracks: r.tracks || [], albums: r.albums || [], artists: r.artists || [] })
    } catch (e) {
      setError(e.message)
      setFavItems({ tracks: [], albums: [], artists: [] })
    }
  }

  // --- playlists (host-as-hub, milestone 3, phase 4) --------------------------
  //
  // The list is summaries only ({ id, name, count }); a playlist's tracks are fetched
  // when it is opened (PlaylistScreen). The worklet caches the summaries so this
  // renders offline; supported:false means the host is too old and we hide the picker.
  async function loadPlaylists (force) {
    if (playlists && !force) return
    try {
      const r = await call('playlists')
      setPlaylists(r.items || [])
      setPlSupported(r.supported !== false)
    } catch {
      setPlaylists(p => p || [])
    }
  }

  // The source's OWN playlists (read-only). Loaded lazily with the host ones; a folder
  // source or a server without playlist support just returns [].
  async function loadServerPlaylists (force) {
    if (serverPls && !force) return
    try {
      const r = await call('serverPlaylists')
      setServerPls(r.items || [])
    } catch {
      setServerPls(s => s || [])
    }
  }

  async function showPlaylists (force) {
    setYouView('playlists')
    await Promise.all([loadPlaylists(force), loadServerPlaylists(force)])
  }

  // Create, then open the new playlist so the obvious next act - adding tracks - is
  // one tap away. Returns the new id so the add-to-playlist picker can create-and-add.
  async function createPlaylist (name) {
    try {
      const pl = await call('createPlaylist', { name })
      await loadPlaylists(true)
      return pl
    } catch (e) {
      haptic('warn'); toast(e.message, true)
      return null
    }
  }

  async function renamePlaylist (id, name) {
    try {
      await call('renamePlaylist', { id, name })
      await loadPlaylists(true)
    } catch (e) { haptic('warn'); toast(e.message, true) }
  }

  async function removePlaylist (id) {
    try {
      await call('deletePlaylist', { id })
      setPlaylists(ps => (ps || []).filter(p => p.id !== id))
    } catch (e) { haptic('warn'); toast(e.message, true) }
  }

  // --- downloads / pinned albums (milestone 3, phase 5C) ----------------------
  async function loadPinned () {
    try { setPinned(new Set((await call('pinnedAlbums')).ids || [])) } catch {}
  }
  async function loadDownloads (force) {
    if (downloads && !force) return
    try { setDownloads((await call('downloads')).items || []) } catch { setDownloads(d => d || []) }
  }
  async function showDownloads (force) {
    setYouView('downloads')
    await loadDownloads(force)
  }
  // Pin (download) an album. Progress arrives via pin:progress events; this just kicks it
  // off and reflects the optimistic "downloading" state.
  async function pinAlbum (albumId) {
    haptic('light')
    setPinning(p => ({ ...p, [albumId]: { done: 0, total: 0 } }))
    try {
      await call('pinAlbum', { albumId })
    } catch (e) {
      setPinning(p => { const n = { ...p }; delete n[albumId]; return n })
      haptic('warn'); toast(e.message, true)
    }
  }
  function unpinAlbum (albumId) {
    setConfirming({
      title: 'Remove download?',
      body: 'The offline copy is deleted from this phone. The album stays in your library.',
      danger: true,
      yes: 'Remove',
      onYes: async () => {
        try {
          await call('unpinAlbum', { albumId })
          setPinned(s => { const n = new Set(s); n.delete(albumId); return n })
          setDownloads(d => (d ? d.filter(x => x.id !== albumId) : d))
        } catch (e) { haptic('warn'); toast(e.message, true) }
      }
    })
  }

  const promptNewPlaylist = () => setNaming(true)

  // Make a playlist from the name prompt, then open it - adding tracks is the obvious
  // next act, and an empty playlist is where you do it from.
  async function createAndOpenPlaylist (name) {
    setNaming(false)
    const pl = await createPlaylist(name)
    if (pl) { setYouView('playlists'); push({ type: 'playlist', id: pl.id, name: pl.name }) }
  }

  const confirmDeletePlaylist = (id, name) => setConfirming({
    title: 'Delete playlist?',
    body: `"${name}" will be removed. The tracks themselves stay in your library.`,
    danger: true,
    yes: 'Delete',
    onYes: () => { removePlaylist(id); pop() }
  })

  // Add resolved tracks to a playlist. The caller already turned an album/artist/track
  // into a track list via tracksFor, so this just forwards the ids and confirms.
  async function addTracksToPlaylist (id, name, tracks) {
    const trackIds = tracks.map(t => t.id).filter(Boolean)
    if (!trackIds.length) { haptic('warn'); return toast('Nothing to add', true) }
    try {
      const res = await call('addToPlaylist', { id, trackIds })
      await loadPlaylists(true)
      haptic('light')
      // A playlist holds each track once, so some (or all) may already be there.
      const added = res?.added ?? trackIds.length
      toast(added ? `Added ${added} to ${name}` : `Already in ${name}`)
    } catch (e) { haptic('warn'); toast(e.message, true) }
  }

  // Density is a per-device preference, so it lives where the theme does: the
  // worklet's settings.json, not the WebView's storage.
  function setDensityValue (v) {
    haptic('light')
    setDensity(v)
    call('setSettings', { density: v }).catch(() => {})
  }

  // The player skin (modern | classic). Same worklet-settings home as density/theme, so it
  // survives a relaunch. Classic is the retro Winamp-style face on the EXPANDED player only.
  function setSkinValue (v) {
    haptic('light')
    setSkin(v)
    call('setSettings', { skin: v }).catch(() => {})
  }

  // Pull to refresh. The host does not push us anything when its library changes -
  // someone drops an album on the NAS and Navidrome rescans, and we would go on
  // showing yesterday's shelf until the app restarted. This is the gesture people
  // already reach for.
  async function refresh () {
    setError(null)
    // In merged mode a pull-to-refresh rebuilds the blend (re-fetches every host's catalog, folding
    // in one that came back online); merged:updated then re-renders the browse + chips. force bypasses
    // the rebuild cooldown - the user explicitly asked for fresh.
    if (mergedRef.current?.merged) {
      try { const st = await call('refreshMerged', { force: true }); if (st?.libraries) setMerged(st) } catch {}
      return
    }
    loadSource() // the operator may have switched the source since we last looked
    if (browse === 'artists') return showArtists(true)
    if (browse === 'songs') return showSongs(true)
    setAlbumsLoaded(false)
    setAlbums([])
    await loadAlbums(0)
  }

  async function runSearch (q) {
    setQuery(q)
    // The SONGS view filters what is already loaded, client-side (instant, works offline) -
    // so no server round-trip there. Albums/Artists still search the whole library server-
    // side. The Library render does the actual filtering off `query`.
    if (!q.trim() || browse === 'songs') return setResults(null)
    try {
      setResults(await call('search', { q, libraryId: filterRef.current }))
    } catch (e) {
      toast(e.message, true)
    }
  }

  // window.confirm() renders as an Android system dialog TITLED "JavaScript",
  // which is both ugly and slightly alarming on a screen about revoking access.
  // Ours is a themed sheet, and Android back dismisses it like any other layer.
  const unpair = () => setConfirming({
    title: 'Unpair from this library?',
    body: 'You will need a new pairing code from the server to reconnect. Nothing on the server is deleted, and this device keeps its identity - re-pairing to the same server reuses the same row on its dashboard.',
    yes: 'Unpair',
    danger: true,
    onYes: doUnpair
  })

  async function doUnpair () {
    try {
      await call('forget')
      setState(s => ({
        loading: false, deviceKey: s.deviceKey, deviceKeyZ32: s.deviceKeyZ32, host: null, connected: false
      }))
      setAlbums([])
      setArtists(null)
      setAlbumsLoaded(false)
      setStack([])
      setTab('library')
      setResults(null)
      setQuery('')
      setError(null)
      setExpanded(false)
    } catch (e) {
      setError(e.message)
    }
  }

  function toggleShuffle () {
    const on = !shuffle
    haptic('light')
    setShuffle(on)
    call('shuffle', { on })
  }

  // off -> all -> one -> off. Repeat-one at the END of the cycle: it is the mode
  // people want least often, so it should be the hardest to land on by accident.
  function cycleRepeat () {
    const next = repeat === 0 ? 2 : repeat === 2 ? 1 : 0
    haptic('light')
    setRepeat(next)
    call('repeat', { mode: next })
  }

  async function onPaired (link, names = {}) {
    setScanning(false)
    setError(null)
    setPairing(true)
    try {
      const host = await call('pair', { link, label: names.deviceName, userName: names.userName })
      // pair() is additive now; refresh the full library list so Settings shows the new one
      // (active). pair's own return has no list, so ask for it.
      let hosts = null
      try { hosts = (await call('listHosts')).hosts } catch {}
      setState(s => ({ ...s, host, connected: true, hosts: hosts || s.hosts }))
      // Adding a second library while one was active: clear the previous library's browse so
      // the new active one loads fresh (a no-op on a first pair).
      setAlbums([]); setArtists(null); setAlbumsLoaded(false); setStack([]); setResults(null); setQuery('')
      setAddingLibrary(false)
      haptic('success')
      // A pair added (or restored) a library. With 2+ libraries the app is the merged blend: enter it
      // if we weren't already, else FORCE a rebuild to fold the new/returned host in now (an explicit
      // pair must not wait on the rebuild cooldown). Otherwise it's single-host - load normally.
      if ((hosts || []).length >= 2) {
        filterRef.current = '_all'; setFilter('_all')
        const st = mergedRef.current?.merged
          ? await call('refreshMerged', { force: true }).catch(() => null)
          : await call('enterMerged').catch(() => null)
        if (st?.libraries) setMerged(st)
        reloadBrowse()
      } else {
        loadAlbums(0)
      }
    } catch (e) {
      setError(pairError(e.message))
      haptic('warn')
    } finally {
      // Back to the form (with the typed names intact) on failure; the success
      // path has already swapped in the library, so this just tidies the flag.
      setPairing(false)
    }
  }

  // --- multi-host: switch / add / remove a library (Settings) -----------------

  // Open the pairing flow to ADD another library, prefilling the name fields from what this
  // device already goes by so you never re-type your name to add a server.
  function openAddLibrary () {
    setPairNames({
      deviceName: state.settings?.deviceName || '',
      userName: state.settings?.userName || ''
    })
    setError(null); setScanning(false); setAddingLibrary(true)
  }

  async function switchLibrary (hostKey) {
    if (!hostKey || hostKey === state.host?.hostKey) return
    haptic('light')
    // Update the UI optimistically from the tap, so the switcher and the Library header
    // reflect the new library at once and never wait on (or drift with) a host event. The
    // worklet's connect then drives the browse reload via host:connected.
    setState(s => {
      const target = (s.hosts || []).find(h => h.hostKey === hostKey)
      return {
        ...s,
        host: target
          ? { ...s.host, hostKey, libraryId: target.libraryId, libraryName: target.libraryName }
          : s.host,
        hosts: (s.hosts || []).map(h => ({ ...h, active: h.hostKey === hostKey })),
        connected: false
      }
    })
    setAlbums([]); setArtists(null); setAlbumsLoaded(false); setStack([]); setResults(null); setQuery('')
    try {
      await call('switchHost', { hostKey })
    } catch (e) { setError(e.message) }
  }

  function removeLibrary (host) {
    setConfirming({
      title: `Remove ${host.libraryName || 'this library'}?`,
      body: "This device stops following that library and its downloads are cleared. Your other libraries and this device's identity are untouched - re-pair anytime to get it back.",
      yes: 'Remove',
      danger: true,
      onYes: async () => {
        try {
          const r = await call('removeHost', { hostKey: host.hostKey })
          setState(s => ({ ...s, hosts: r.hosts }))
          // Removing the LAST/active-with-none-left library drops us back to unpaired; the
          // worklet already emitted host:disconnected, so just clear the browse and views.
          if (!(r.hosts || []).some(h => h.active)) {
            setState(s => ({ ...s, host: null, connected: false }))
            setAlbums([]); setArtists(null); setAlbumsLoaded(false); setStack([]); setTab('library'); setResults(null); setQuery('')
          }
        } catch (e) { setError(e.message) }
      }
    })
  }

  const toQueue = (list) => list.map(x => ({
    id: x.id,
    title: x.title,
    artist: x.artist,
    album: x.album,
    art: x.art ?? null,
    // Carried so the player's own art viewer opens the big image rather than a
    // stretched thumbnail. The lock screen still gets the small one.
    artFull: x.artFull ?? null,
    durationMs: x.durationMs
  }))

  // Tapping a track queues the whole list behind it - which is what people mean
  // when they tap a track in an album.
  //
  // RESUME (milestone 3, phase 2): a track you deliberately stopped partway resumes
  // from there - but ONLY the one you tapped, never a track that arrives via queue
  // advance (that would jump you mid-listen). So the seek lives here, in the user-tap
  // path, not in the status listener. Guarded to a real middle (>5s, <95%) so a nearly
  // finished track just starts fresh.
  const playFrom = async (list, t) => {
    haptic('light')
    const index = Math.max(0, list.findIndex(x => x.id === t.id))
    // Ask for the resume BEFORE the seek can be dropped: seeking straight after play()
    // races the player getting ready and is ignored. Instead stash a PENDING resume and
    // apply it on the track's first status (below), when the player can honour it.
    pendingResumeRef.current = null
    call('play', { queue: toQueue(list), index })
    try {
      const r = await call('resumeGet', { trackId: t.id })
      const pos = r?.positionMs || 0
      const dur = r?.durationMs || t.durationMs || 0
      if (pos > 5000 && (!dur || pos < dur * 0.95)) pendingResumeRef.current = { trackId: t.id, positionMs: pos }
    } catch {}
  }

  // Play a whole album or artist without drilling into it for a track to tap.
  //
  // Shuffle starts on a RANDOM track, not on track 1 with shuffle merely enabled.
  // ExoPlayer owns the shuffled order (DECISIONS), but it still begins where we
  // point it, and "shuffle" that opens every album on its first song is not
  // shuffle.
  const playAll = (list, { shuffled = false } = {}) => {
    if (!list?.length) return
    haptic('light')
    const index = shuffled ? Math.floor(Math.random() * list.length) : 0
    setShuffle(shuffled)
    call('shuffle', { on: shuffled })
    return call('play', { queue: toQueue(list), index })
  }

  const enqueue = (list) => {
    if (!list?.length) return
    haptic('success')
    call('enqueue', { queue: toQueue(list) })
    toast(`Added ${list.length} ${list.length === 1 ? 'track' : 'tracks'} to the queue`)
  }

  // The queue is asked for, not cached. It lives in the shell (ExoPlayer owns the
  // shuffled order), so a copy kept here would drift the moment shuffle is on or a
  // track auto-advances - it is re-fetched whenever the screen is open and the
  // track changes underneath it.
  async function loadQueue () {
    try {
      setQueue(await call('queue'))
    } catch (e) {
      setError(e.message)
    }
  }

  // Load the queue whenever the Queue tab is open OR the classic player is expanded (its
  // docked "Playlist" window shows the same up-next list). Re-fetch on track change / queue
  // length change, same as the tab - the shell owns the authoritative order.
  const retroPlaylistOpen = expanded && skin === 'classic' && !!now
  useEffect(() => {
    if (tab !== 'queue' && !retroPlaylistOpen) return
    loadQueue()
  }, [tab, now?.trackId, status?.queueLength, retroPlaylistOpen])

  function jumpTo (index) {
    haptic('light')
    // If the player was stopped (its X), there is no live session to seek within - so
    // restart the kept queue through the full play path, which re-announces and brings
    // the player bar back. Otherwise a plain in-session jump.
    if (!now && queue?.items?.length) call('play', { queue: queue.items, index })
    else call('playIndex', { index })
  }

  // The player's X: stop PLAYBACK only, and KEEP the queue. The bar hides (play:stopped),
  // the queue stays in the Queue tab, and tapping a track there resumes it.
  function stopPlayback () {
    haptic('light')
    call('stopKeepQueue')
  }

  // The Queue screen's trash icon (behind a confirm). Empties the up-next but keeps the
  // CURRENT track playing - the queue collapses to that one track. With nothing playing,
  // it wipes the queue outright.
  async function clearQueue () {
    haptic('warn')
    if (now) {
      try {
        const res = await call('queueClearKeepCurrent')
        setQueue(res)
        setStatus(s => (s ? { ...s, queueLength: res.items.length } : s))
      } catch (e) { setError(e.message); loadQueue() }
    } else {
      call('stop')
      setQueue({ items: [], index: 0 })
    }
  }
  const confirmClearQueue = () => setConfirming({
    title: 'Clear the queue?',
    body: now
      ? 'Everything up next is removed. The current song keeps playing.'
      : 'The whole queue is removed.',
    danger: true,
    yes: 'Clear',
    onYes: clearQueue
  })

  // Reorder the queue. Update the visible list optimistically (so the row does not snap
  // back while the round-trip lands), then reconcile with the shell's authoritative
  // {items,index} - it owns ExoPlayer's order. The current track is tracked by identity
  // so its highlight follows the move without re-deriving the index math the shell owns.
  async function moveInQueue (from, to) {
    setQueue(qs => {
      if (!qs) return qs
      const list = qs.items.slice()
      const curId = list[qs.index]?.id
      const [m] = list.splice(from, 1)
      list.splice(to, 0, m)
      const at = curId != null ? list.findIndex(t => t.id === curId) : qs.index
      return { items: list, index: at < 0 ? qs.index : at }
    })
    try { setQueue(await call('queueMove', { from, to })) } catch (e) { setError(e.message); loadQueue() }
  }

  // Remove one track. The shell returns the new {items,index}; if that empties the queue
  // it also stopped playback (play:stopped clears the now-playing UI).
  async function removeFromQueue (i) {
    haptic('light')
    try {
      const res = await call('queueRemove', { index: i })
      setQueue(res)
      // Keep the navbar badge honest now, not on the next status tick (which may be a
      // while off when paused) - same reason the play:queued handler does it.
      setStatus(s => (s ? { ...s, queueLength: res.items.length } : s))
    } catch (e) { setError(e.message); loadQueue() }
  }

  // The long-press menu holds an ID, not tracks: a grid of 60 albums has not
  // fetched anybody's track list, and it should not, just in case someone might
  // long-press one. The tracks are fetched when an action is actually chosen.
  async function tracksFor (item) {
    if (item.type === 'track') return [item.track]
    if (item.type === 'album') {
      const a = await call('album', { id: item.id })
      return (a?.tracks || []).map(t => ({ ...t, art: t.art ?? a.art, artFull: a.artFull }))
    }
    if (item.type === 'artist') {
      const r = await call('artistTracks', { id: item.id })
      return r.items || []
    }
    if (item.type === 'genre') {
      const r = await call('genreTracks', { id: item.id })
      return r.items || []
    }
    return []
  }

  async function menuAction (item, action) {
    setMenu(null)
    // Add to playlist opens the PICKER; the tracks are resolved only once a playlist
    // is chosen (an album's track list should not be fetched just to open a menu).
    if (action === 'playlist') {
      if (plSupported) loadPlaylists()
      return setAddingTo(item)
    }
    try {
      const list = await tracksFor(item)
      // Rare now that an album-less artist returns its songs, but if the library
      // really has nothing behind it, say so IN PASSING - a red banner pinned to
      // the top of the screen is the wrong weight for "that one is empty".
      if (!list.length) {
        haptic('warn')
        return toast(`Nothing to play in ${item.name || 'that'}`, true)
      }
      if (action === 'queue') return enqueue(list)
      return playAll(list, { shuffled: action === 'shuffle' })
    } catch (e) {
      haptic('warn')
      toast(e.message, true)
    }
  }

  // The picker chose a playlist (or made a new one): resolve the pending item to its
  // tracks and append them. `pl` is { id, name }.
  async function addItemToPlaylist (pl) {
    const item = addingTo
    setAddingTo(null)
    if (!item || !pl) return
    try {
      const list = await tracksFor(item)
      if (!list.length) { haptic('warn'); return toast(`Nothing to add from ${item.name || 'that'}`, true) }
      await addTracksToPlaylist(pl.id, pl.name, list)
    } catch (e) { haptic('warn'); toast(e.message, true) }
  }

  if (state.loading) return <div className='center'><p className='muted'>Starting…</p></div>

  // Adding ANOTHER library over the running app (Settings > Libraries > Add). Same flow as
  // the pairing wall, but cancellable back into the app rather than a dead end.
  if (addingLibrary) {
    if (pairing) return <Pairing />
    return scanning
      ? (
        <Scanner
          onScan={(link) => onPaired(link, pairNames)}
          onCancel={() => { setError(null); setScanning(false) }}
          error={error}
        />
        )
      : (
        <Welcome
          names={pairNames}
          setNames={setPairNames}
          onScan={() => { setError(null); setScanning(true) }}
          onPaste={(link) => onPaired(link, pairNames)}
          onCancel={() => { setError(null); setScanning(false); setAddingLibrary(false) }}
          error={error}
        />
        )
  }

  // Pairing is a wall: with no library there is nothing to navigate, so there is
  // no navbar until there is.
  if (!state.host) {
    if (pairing) return <Pairing />
    return scanning
      ? (
        <Scanner
          onScan={(link) => onPaired(link, pairNames)}
          onCancel={() => { setError(null); setScanning(false) }}
          error={error}
        />
        )
      : (
        <Welcome
          names={pairNames}
          setNames={setPairNames}
          // Clear any stale error when opening the scanner - a failure from a
          // PREVIOUS attempt must not greet you on the fresh one.
          onScan={() => { setError(null); setScanning(true) }}
          onPaste={(link) => onPaired(link, pairNames)}
          error={error}
        />
        )
  }

  const top = stack[stack.length - 1] || null

  const viewArt = (url, title) => { if (url) { haptic('light'); setViewing({ url, title }) } }

  let screen
  if (top?.type === 'album') {
    screen = (
      <AlbumScreen
        id={top.id} now={now} error={error} onBack={pop} onPlay={playFrom}
        onPlayAll={playAll} onQueue={enqueue} onViewArt={viewArt}
        favs={favs} onFav={favSupported ? onFav : null}
        pinned={pinned.has(top.id)} pinning={pinning[top.id]}
        onPin={() => pinAlbum(top.id)} onUnpin={() => unpinAlbum(top.id)}
      />
    )
  } else if (top?.type === 'download') {
    screen = (
      <DownloadScreen
        id={top.id} name={top.name} now={now} onBack={pop}
        onPlay={playFrom} onPlayAll={playAll} onQueue={enqueue}
        onUnpin={() => unpinAlbum(top.id)}
      />
    )
  } else if (top?.type === 'artist') {
    screen = (
      <ArtistScreen
        id={top.id} name={top.name} now={now} onPlay={playFrom}
        onBack={pop} onViewArt={viewArt} onLong={setMenu}
        onArtistAction={(artistId, action) => menuAction({ type: 'artist', id: artistId }, action)}
        onOpenAlbum={(id) => push({ type: 'album', id })}
        favs={favs} onFav={favSupported ? onFav : null}
      />
    )
  } else if (top?.type === 'genre') {
    screen = (
      <GenreScreen
        id={top.id} name={top.name} now={now} onPlay={playFrom}
        onBack={pop} onLong={setMenu}
        onGenreAction={(genreId, action) => menuAction({ type: 'genre', id: genreId }, action)}
        onOpenAlbum={(id) => push({ type: 'album', id })}
        onOpenArtist={(a) => push({ type: 'artist', id: a.id, name: a.name })}
        favs={favs} onFav={favSupported ? onFav : null}
      />
    )
  } else if (top?.type === 'playlist') {
    // Two kinds share this screen: our own (editable) and the server's (read-only).
    // The `server` flag flips which worklet method fetches it and hides the edit tools.
    screen = top.server
      ? (
        <PlaylistScreen
          key={'srv:' + top.id} id={top.id} name={top.name} now={now} onBack={pop}
          server sourceName={sourceText(state)}
          onPlay={playFrom} onPlayAll={playAll} onQueue={enqueue}
        />
        )
      : (
        <PlaylistScreen
          key={top.id} id={top.id} name={top.name} now={now} onBack={pop}
          onPlay={playFrom} onPlayAll={playAll} onQueue={enqueue}
          onRename={renamePlaylist}
          onSetTracks={(pid, trackIds) => call('setPlaylistTracks', { id: pid, trackIds }).then(() => loadPlaylists(true))}
          onDelete={() => confirmDeletePlaylist(top.id, top.name)}
        />
        )
  } else if (tab === 'you') {
    screen = (
      <You
        state={state} density={density} now={now}
        handoff={handoff} playing={!!status?.playing} onPlayHere={playHere}
        youView={youView} onYouView={openYou}
        favSupported={favSupported} favItems={favItems} mostPlayed={mostPlayed}
        favs={favs} onFav={favSupported ? onFav : null}
        playlists={playlists} plSupported={plSupported}
        serverPls={serverPls} sourceName={sourceText(state)}
        downloads={downloads}
        onOpenPlaylist={(pl) => push({ type: 'playlist', id: pl.id, name: pl.name })}
        onOpenServerPlaylist={(pl) => push({ type: 'playlist', id: pl.id, name: pl.name, server: true })}
        onOpenDownload={(dl) => push({ type: 'download', id: dl.id, name: dl.name })}
        onNewPlaylist={promptNewPlaylist}
        onPlay={playFrom} onLong={setMenu}
        onOpenAlbum={(id) => push({ type: 'album', id })}
        onOpenArtist={(a) => push({ type: 'artist', id: a.id, name: a.name })}
      />
    )
  } else if (tab === 'queue') {
    screen = (
      <QueueScreen
        items={queue?.items || []}
        index={queue?.index ?? 0}
        skin={skin}
        onJump={jumpTo}
        onMove={moveInQueue}
        onRemove={removeFromQueue}
        onClear={confirmClearQueue}
      />
    )
  } else if (tab === 'settings') {
    screen = (
      <Settings
        state={state} merged={merged} themePref={themePref} onTheme={changeTheme} onUnpair={unpair}
        ident={ident} onSaveIdentity={saveIdentity} onQuality={changeQuality}
        skin={skin} onSkin={setSkinValue}
        onSwitchHost={switchLibrary} onRemoveHost={removeLibrary} onAddLibrary={openAddLibrary}
      />
    )
  } else if (tab === 'about') {
    screen = <About onDonate={() => setDonate(true)} />
  } else {
    screen = (
      <Library
        state={state} albums={albums} artists={artists} genres={genres} songs={songs} recent={recent}
        merged={merged} filter={filter} onFilter={pickFilter}
        cursor={cursor} songCursor={songCursor} density={density}
        browse={browse} query={query} results={results} now={now} error={error}
        albumsLoaded={albumsLoaded} reconnecting={reconnecting}
        favs={favs} onFav={favSupported ? onFav : null}
        cont={now ? null : cont}
        onContinue={() => { if (cont?.track) { playFrom([cont.track], cont.track); setCont(null) } }}
        handoff={handoff}
        playing={!!status?.playing}
        onPlayHere={playHere}
        onBrowse={(b) => {
          haptic('light')
          // Reset the search box when changing views: it means "search everything" on
          // Albums/Artists but "filter the loaded list" on Songs, so carrying a query
          // across that boundary would show a stale, wrong-shaped result.
          setQuery(''); setResults(null)
          if (b === 'genres') return showGenres()
          if (b === 'artists') return showArtists()
          if (b === 'songs') return showSongs()
          return setBrowse('albums')
        }}
        onDisplay={() => setDisplay(true)}
        onSearch={runSearch}
        onReconnect={reconnect}
        onRefresh={refresh}
        onMore={() => loadAlbums(cursor)}
        onMoreSongs={() => loadSongs(songCursor)}
        onOpenAlbum={(id) => push({ type: 'album', id })}
        onOpenArtist={(a) => push({ type: 'artist', id: a.id, name: a.name })}
        onOpenGenre={(g) => push({ type: 'genre', id: g.id, name: g.name })}
        onPlay={playFrom}
        onLong={setMenu}
      />
    )
  }

  return (
    <>
      {screen}

      <div className={'dock' + (now && skin === 'classic' ? ' dock-retro' : '')} ref={dockRef}>
        {ident?.expiresAt && state.connected && <GuestBanner expiresAt={ident.expiresAt} />}
        {now && (
          <Player
            now={now} status={status} expanded={expanded} skin={skin}
            shuffle={shuffle} repeat={repeat} onQueue={() => goTab('queue')}
            queueItems={queue?.items || []} queueIndex={queue?.index ?? 0} onJump={jumpTo}
            sleep={sleep} onSleep={() => { haptic('light'); setSleepOpen(true) }}
            onShuffle={toggleShuffle} onRepeat={cycleRepeat} onStop={stopPlayback}
            onExpand={() => { haptic('light'); setExpanded(true) }}
            onCollapse={() => { haptic('light'); setExpanded(false) }}
            onViewArt={() => viewArt(now.artFull || now.art, now.album || now.title)}
          />
        )}
        {/* The navbar stays put during a drill-down, unlike PearList's (which
            hides it inside a list). A music app's dock is fixed furniture: the
            player sits on top of it, and dropping the navbar under an album would
            make the player jump down the screen mid-song. */}
        <NavBar active={tab} onTab={goTab} queued={status?.queueLength ?? 0} />
      </div>

      {note && <div className={'toast' + (note.bad ? ' bad' : '')}>{note.msg}</div>}
      {display && (
        <DisplaySheet
          browse={browse} density={density} onDensity={setDensityValue}
          sorts={state.sorts} sort={sort} onSort={applySort}
          onClose={() => setDisplay(false)}
        />
      )}
      {menu && (
        <ActionSheet
          item={menu}
          onClose={() => setMenu(null)}
          onAction={(a) => menuAction(menu, a)}
          canPlaylist={plSupported}
        />
      )}
      {addingTo && (
        <PlaylistPicker
          item={addingTo}
          playlists={playlists}
          onClose={() => setAddingTo(null)}
          onPick={addItemToPlaylist}
          onCreate={async (name) => {
            const pl = await createPlaylist(name)
            if (pl) addItemToPlaylist(pl)
            else setAddingTo(null)
          }}
        />
      )}
      {naming && (
        <NamePrompt
          title='New playlist'
          placeholder='Playlist name'
          submitLabel='Create'
          onClose={() => setNaming(false)}
          onSubmit={createAndOpenPlaylist}
        />
      )}
      {viewing && <ArtViewer {...viewing} onClose={() => setViewing(null)} />}
      {sleepOpen && (
        <SleepSheet
          sleep={sleep}
          onClose={() => setSleepOpen(false)}
          onPick={(opts) => { call('sleep', opts).catch(() => {}); setSleepOpen(false) }}
        />
      )}
      {donate && <DonationSheet onClose={() => setDonate(false)} />}
      {confirming && (
        <Confirm
          {...confirming}
          onClose={() => setConfirming(null)}
          onConfirm={() => { setConfirming(null); confirming.onYes() }}
        />
      )}
    </>
  )
}

// --- navigation --------------------------------------------------------------

const TABS = [
  { key: 'library', label: 'Library', Icon: MusicNotes },
  { key: 'you', label: 'You', Icon: Heart },
  { key: 'queue', label: 'Queue', Icon: QueueIcon },
  { key: 'settings', label: 'Settings', Icon: Gear },
  { key: 'about', label: 'About', Icon: Info }
]

// The queue count rides on the TAB, which is the one thing on screen that is always
// there - dock or no dock, playing or not. That is the persistent indicator; the
// player's own counter is just a shortcut to the same screen.
function NavBar ({ active, onTab, queued }) {
  return (
    <nav className='navbar'>
      {TABS.map(({ key, label, Icon }) => {
        const on = active === key
        const badge = key === 'queue' && queued > 0 ? queued : null
        return (
          <button
            key={key} className={on ? 'on' : ''} onClick={() => onTab(key)}
            aria-current={on ? 'page' : undefined}
            aria-label={badge ? `${label}, ${badge} tracks` : label}
          >
            <span className='ic'>
              <Icon size={22} weight={on ? 'fill' : 'regular'} />
              {badge && <span className='badge'>{badge > 99 ? '99+' : badge}</span>}
            </span>
            <span>{label}</span>
          </button>
        )
      })}
    </nav>
  )
}

function Back ({ onClick }) {
  return (
    <button className='back' onClick={() => { haptic('light'); onClick() }}>
      <CaretLeft size={14} weight='bold' /> Back
    </button>
  )
}

// Long-press. There is no such gesture in a WebView, so: start a timer on touch,
// kill it if the finger moves or lifts early. The `fired` ref is the important
// part - without it the press ALSO opens the album on the way out, and you get a
// menu on top of a screen you did not ask for.
function usePress (onPress, onLongPress) {
  const timer = useRef(null)
  const fired = useRef(false)

  const clear = () => {
    clearTimeout(timer.current)
    timer.current = null
  }

  return {
    onTouchStart: () => {
      fired.current = false
      if (!onLongPress) return
      timer.current = setTimeout(() => {
        fired.current = true
        haptic('medium') // the press has "landed" - say so before the sheet appears
        onLongPress()
      }, 450)
    },
    onTouchMove: clear,
    onTouchEnd: clear,
    onTouchCancel: clear,
    onClick: () => {
      if (fired.current) {
        fired.current = false
        return
      }
      onPress?.()
    }
  }
}

// What is actually up next.
//
// The list comes from the SHELL, because that is where the queue lives (ExoPlayer
// owns the shuffled order). A copy kept in the UI would drift the moment shuffle is
// on or a track auto-advances - so this screen ASKS, every time it is opened and
// every time the track changes.
function QueueScreen ({ items, index, skin, onJump, onMove, onRemove, onClear }) {
  const [editing, setEditing] = useState(false)
  const [drag, setDrag] = useState(null)
  const retro = skin === 'classic'

  if (!items.length) {
    return (
      <div className='app'>
        <header><h1>Queue</h1></header>
        <div className='blank'>
          <QueueIcon size={40} weight='thin' />
          <h2>Nothing queued</h2>
          <p className='muted sm'>
            Play an album, or long-press one and choose Add to queue. What is coming
            up next will appear here.
          </p>
        </div>
      </div>
    )
  }

  const left = items.length - index - 1

  // Drag reorder, the same mechanism as PlaylistScreen: the grip captures the pointer
  // (touch-action:none in CSS stops the page scrolling under the finger), the lifted row
  // follows it, the others slide by one to open a gap, and a highlight marks the drop
  // slot. Rows keep their DOM order and move with transforms, so nothing remounts mid-drag.
  const dragStart = (i) => (e) => {
    const li = e.currentTarget.closest('li')
    const h = li?.offsetHeight || 64
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
    haptic('medium')
    setDrag({ from: i, dy: 0, insertAt: i, rowH: h, y0: e.clientY })
  }
  const dragMove = (e) => {
    setDrag(d => {
      if (!d) return d
      const dy = e.clientY - d.y0
      const insertAt = Math.max(0, Math.min(items.length - 1, d.from + Math.round(dy / d.rowH)))
      if (insertAt !== d.insertAt) { try { haptic('light') } catch {} }
      return { ...d, dy, insertAt }
    })
  }
  const dragEnd = () => {
    setDrag(d => { if (d && d.from !== d.insertAt) onMove(d.from, d.insertAt); return null })
  }
  const rowShift = (i) => {
    if (!drag) return 0
    if (i === drag.from) return drag.dy
    if (drag.from < drag.insertAt && i > drag.from && i <= drag.insertAt) return -drag.rowH
    if (drag.from > drag.insertAt && i >= drag.insertAt && i < drag.from) return drag.rowH
    return 0
  }

  const toggleEdit = () => { haptic('light'); setDrag(null); setEditing(e => !e) }
  const rowClass = (i) => (i === index ? 'on' : (i < index ? 'played' : ''))
  const sub = (t) => [t.artist, t.album].filter(Boolean).join(' · ')

  return (
    <div className={'app queuescreen' + (retro ? ' retroq' : '')}>
      {/* The header stays put (flex:none at the top of the fixed-height column) while the
          list scrolls below it. The action icons are absolutely positioned top-right so
          "Queue" stays centered like every other page header. */}
      <header className='queuehead'>
        <h1>{retro ? 'Playlist' : 'Queue'}</h1>
        <p className='muted sm'>
          {items.length} {items.length === 1 ? 'track' : 'tracks'}
          {left > 0 ? ` · ${left} still to play` : ' · last track'}
        </p>
        <div className='qacts'>
          <button className='qtrash' aria-label='Clear queue' onClick={onClear}>
            <Trash size={19} weight='regular' />
          </button>
          <button
            className={'qedit' + (editing ? ' on' : '')}
            aria-label={editing ? 'Done editing' : 'Edit queue'}
            onClick={toggleEdit}
          >
            <PencilSimple size={20} weight={editing ? 'fill' : 'regular'} />
          </button>
        </div>
      </header>

      {editing
        ? (
          <ul className='tracks editing' style={drag ? { '--rowh': drag.rowH + 'px' } : undefined}>
            {drag && (
              <li className='drophl' aria-hidden style={{ top: drag.insertAt * drag.rowH + 'px', height: drag.rowH + 'px' }} />
            )}
            {items.map((t, i) => {
              const lifted = drag && i === drag.from
              return (
                <li
                  key={`${t.id}:${i}`}
                  className={'editrow ' + rowClass(i) + (lifted ? ' lifted' : '')}
                  style={{
                    transform: `translateY(${rowShift(i)}px)` + (lifted ? ' scale(1.02)' : ''),
                    transition: lifted ? 'none' : 'transform 180ms cubic-bezier(0.2,0,0,1)',
                    zIndex: lifted ? 3 : 1
                  }}
                >
                  <button
                    className='plgrip' aria-label='Drag to reorder'
                    onPointerDown={dragStart(i)} onPointerMove={dragMove}
                    onPointerUp={dragEnd} onPointerCancel={dragEnd}
                  >
                    <DotsSixVertical size={20} weight='bold' />
                  </button>
                  <div className='meta'>
                    <div className='t'>{t.title}</div>
                    <div className='muted sm sub'>{sub(t)}</div>
                  </div>
                  <button className='rm' aria-label='Remove from queue' onClick={() => onRemove(i)}>
                    <X size={17} weight='bold' />
                  </button>
                </li>
              )
            })}
          </ul>
          )
        : (
          <ul className='tracks queuelist'>
            {items.map((t, i) => (
              <li key={`${t.id}:${i}`} className={rowClass(i)} onClick={() => onJump(i)}>
                <Cover src={t.art} sm />
                <div className='meta'>
                  <div className='t'>{t.title}</div>
                  <div className='muted sm sub'>{sub(t)}</div>
                </div>
                {i === index
                  ? <Play size={14} weight='fill' className='cur' />
                  : <span className='muted sm dur'>{t.durationMs ? fmt(t.durationMs) : ''}</span>}
              </li>
            ))}
          </ul>
          )}
    </div>
  )
}

// Play / Shuffle / Add to queue / Add to playlist, without drilling into the thing first.
function ActionSheet ({ item, onClose, onAction, canPlaylist }) {
  return (
    <div className='sheetwrap' onClick={onClose}>
      <div className='sheet' onClick={e => e.stopPropagation()}>
        <h1>{item.name}</h1>
        <div className='acts'>
          <button className='primary wide' onClick={() => onAction('play')}>
            <Play size={17} weight='fill' /> Play
          </button>
          {/* One track cannot be shuffled. Offering it would be a button that
              visibly does nothing. */}
          {item.type !== 'track' && (
            <button className='wide' onClick={() => onAction('shuffle')}>
              <Shuffle size={17} weight='bold' /> Shuffle
            </button>
          )}
          <button className='wide' onClick={() => onAction('queue')}>
            <ListPlus size={17} weight='bold' /> Add to queue
          </button>
          {canPlaylist && (
            <button className='wide' onClick={() => onAction('playlist')}>
              <PlaylistIcon size={17} weight='bold' /> Add to playlist
            </button>
          )}
          <button className='wide' onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// Choose a playlist to add the pending item to - or make a new one inline. The item's
// tracks are only resolved once a playlist is picked (the parent's addItemToPlaylist),
// so opening this never fetches an album's track list.
function PlaylistPicker ({ item, playlists, onClose, onPick, onCreate }) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const list = playlists || []
  const submit = (e) => { e.preventDefault(); const n = name.trim(); if (n) onCreate(n) }
  return (
    <div className='sheetwrap' onClick={onClose}>
      <div className='sheet' onClick={e => e.stopPropagation()}>
        <h1>Add to playlist</h1>
        <p className='muted sm'>{item.name}</p>
        {creating
          ? (
            <form className='plrename' onSubmit={submit}>
              <input
                className='search' autoFocus value={name}
                onChange={e => setName(e.target.value)} placeholder='Playlist name'
              />
              <div className='btnrow'>
                <button type='button' onClick={() => setCreating(false)}>Cancel</button>
                <button type='submit' className='primary' disabled={!name.trim()}>Create &amp; add</button>
              </div>
            </form>
            )
          : (
            <div className='acts'>
              <button className='wide newpl' onClick={() => setCreating(true)}>
                <Plus size={17} weight='bold' /> New playlist
              </button>
              {list.map(pl => (
                <button key={pl.id} className='wide plpick' onClick={() => onPick(pl)}>
                  <span>{pl.name}</span>
                  <span className='muted sm'>{pl.count} track{pl.count === 1 ? '' : 's'}</span>
                </button>
              ))}
              <button className='wide' onClick={onClose}>Cancel</button>
            </div>
            )}
      </div>
    </div>
  )
}

// The cover, as big as the screen will take it. The image is a SEPARATE, larger
// request over P2P (?s=1200) rather than the 300px grid thumbnail stretched out -
// album art is the one picture in this app people actually want to look at, and an
// upscaled thumbnail looks like a mistake on a modern phone.
function ArtViewer ({ url, title, onClose }) {
  return (
    <div className='artviewer' onClick={onClose}>
      <img src={url} alt={title || 'Album art'} />
      {title && <div className='muted sm cap'>{title}</div>}
    </div>
  )
}

// A themed sheet instead of window.confirm(), whose Android dialog is titled
// "JavaScript" - not what you want on the screen where someone gives up access to
// their library.
function Confirm ({ title, body, yes = 'Confirm', danger, onConfirm, onClose }) {
  return (
    <div className='sheetwrap' onClick={onClose}>
      <div className='sheet' onClick={e => e.stopPropagation()}>
        <h1>{title}</h1>
        {body && <p className='muted sm'>{body}</p>}
        <div className='btnrow'>
          <button onClick={onClose}>Cancel</button>
          <button
            className={danger ? 'danger' : 'primary'}
            onClick={() => { haptic(danger ? 'warn' : 'light'); onConfirm() }}
          >{yes}</button>
        </div>
      </div>
    </div>
  )
}

// A themed sheet that asks for one line of text (a new playlist's name). Same shape as
// Confirm, with an input - a WebView's window.prompt is as ugly as its confirm.
function NamePrompt ({ title, placeholder, submitLabel = 'Save', onSubmit, onClose }) {
  const [value, setValue] = useState('')
  const submit = (e) => { e.preventDefault(); const v = value.trim(); if (v) { haptic('light'); onSubmit(v) } }
  return (
    <div className='sheetwrap' onClick={onClose}>
      <div className='sheet' onClick={e => e.stopPropagation()}>
        <h1>{title}</h1>
        <form onSubmit={submit}>
          <input
            className='search' autoFocus value={value}
            onChange={e => setValue(e.target.value)} placeholder={placeholder}
          />
          <div className='btnrow'>
            <button type='button' onClick={onClose}>Cancel</button>
            <button type='submit' className='primary' disabled={!value.trim()}>{submitLabel}</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// --- library -----------------------------------------------------------------

// Human labels for the canonical sort keys the host advertises. 'title'/'name' are
// the same idea for a track vs an album; 'duration' reads as "Length" to a listener.
const SORT_LABEL = {
  title: 'Title', name: 'Name', artist: 'Artist', album: 'Album', year: 'Year', duration: 'Length', added: 'Recently added'
}

// The Display sheet: layout (grid density) and sort, in one bottom sheet opened by the
// single Display icon in the library header. Each section only appears when it applies
// - Layout on the grid views, Sort when the active source advertises keys for the view
// (state.sorts) - so a Subsonic Songs list, which has neither, never opens this (its
// button is disabled). Direction is a toggle shown only for a reversible source once a
// key is chosen.
const LAYOUT_OPTS = [
  { value: 'list', label: 'List', desc: 'One per row, with the full title' },
  { value: '2', label: 'Grid, 2 per row', desc: 'Larger covers' },
  { value: '3', label: 'Grid, 3 per row', desc: 'More on screen' }
]
function DisplaySheet ({ browse, density, onDensity, sorts, sort, onSort, onClose }) {
  const capType = browse === 'songs' ? 'tracks' : browse
  const cap = sorts?.[capType]
  const keys = cap?.keys || []
  const hasLayout = browse !== 'songs'
  const cur = sort?.[browse] || null
  const order = cur?.order || 'asc'
  const sortOpts = [
    { value: '', label: 'Default order' },
    ...keys.map(k => ({ value: k, label: SORT_LABEL[k] || k }))
  ]
  return (
    <div className='sheetwrap' onClick={onClose}>
      <div className='sheet' onClick={e => e.stopPropagation()}>
        <h1>Display</h1>
        {hasLayout && (
          <div className='dispsec'>
            <div className='displabel'>Layout</div>
            <OptionList options={LAYOUT_OPTS} value={String(density)} onChange={onDensity} />
          </div>
        )}
        {keys.length > 0 && (
          <div className='dispsec'>
            <div className='displabel'>
              <span>Sort by</span>
              {cur?.key && cap.reversible && (
                <button
                  className='dirtoggle'
                  onClick={() => onSort(browse, cur.key, order === 'asc' ? 'desc' : 'asc')}
                  aria-label={order === 'asc' ? 'Ascending - tap for descending' : 'Descending - tap for ascending'}
                >
                  {order === 'desc' ? <ArrowDown size={15} weight='bold' /> : <ArrowUp size={15} weight='bold' />}
                  {order === 'asc' ? 'Ascending' : 'Descending'}
                </button>
              )}
            </div>
            <OptionList options={sortOpts} value={cur?.key || ''} onChange={(v) => onSort(browse, v || null, order)} />
          </div>
        )}
        <div className='acts'><button className='wide' onClick={onClose}>Done</button></div>
      </div>
    </div>
  )
}

function Library ({
  state, albums, artists, genres, songs, recent, merged, filter, onFilter, cursor, songCursor, density,
  browse, query, results, now, error, albumsLoaded, reconnecting,
  favs, onFav, cont, onContinue, handoff, playing, onPlayHere,
  onBrowse, onDisplay, onSearch, onReconnect, onRefresh, onMore, onMoreSongs,
  onOpenAlbum, onOpenArtist, onOpenGenre, onPlay, onLong
}) {
  // Bind the generic onFav(kind, item) to per-kind heart handlers for the leaves.
  const favTrack = onFav ? (t => onFav('track', t)) : null
  // Server search shows its own results view - but NOT on Songs, which filters the
  // already-loaded list in place (see songFilter below and runSearch).
  const searching = results && query.trim() && browse !== 'songs'
  // The Songs client-side filter: match title / artist / album, case-insensitive.
  const songFilter = browse === 'songs' ? query.trim().toLowerCase() : ''
  const shownSongs = songFilter
    ? (songs || []).filter(t =>
        `${t.title || ''} ${t.artist || ''} ${t.album || ''}`.toLowerCase().includes(songFilter))
    : songs
  const D = densityOf(density)
  // The Display sheet offers layout (grid views only) and/or sort (whatever the
  // source can do). Disable its button when the active view has neither.
  const sortCap = state.sorts?.[browse === 'songs' ? 'tracks' : browse]
  const displayHasOptions = browse !== 'songs' || (sortCap?.keys?.length > 0)
  // The Recently Added shelf only makes sense when the source can order by date added
  // (older hosts would hand back alphabetical albums under a "recently added" title).
  const recentSupported = !!state.sorts?.albums?.keys?.includes('added')
  // The worklet hands us the base URL rather than finished art URLs, because only
  // the UI knows the density, and therefore the size to ask for.
  const artBase = state.artBase || state.host?.artBase || null

  // Merged-view header: the blended library isn't "the active host", so name it for what's showing -
  // "All libraries" for the blend, or the one library a chip has focused. `mergedAll` = the blend.
  const mergedAll = !!(merged?.merged && filter === '_all')
  const libTitle = merged?.merged
    ? (filter === '_all' ? 'All libraries' : (merged.libraries.find(l => l.libraryId === filter)?.libraryName || 'Library'))
    : (state.host.libraryName || 'Library')

  // Pull to refresh, by hand: this is a WebView, so there is no RefreshControl to
  // borrow. Only arms when the document is ALREADY at the top, or the gesture would
  // fight every upward scroll in a long grid. Damped by half, because a 1:1 pull
  // feels like the page has come unstuck.
  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const startY = useRef(null)
  const TRIGGER = 60

  const onTouchStart = (e) => {
    startY.current = window.scrollY <= 0 && !refreshing ? e.touches[0].clientY : null
  }
  const onTouchMove = (e) => {
    if (startY.current == null) return
    const dy = e.touches[0].clientY - startY.current
    if (dy > 0) setPull(Math.min(90, dy * 0.5))
  }
  const onTouchEnd = async () => {
    if (startY.current == null) return
    const reached = pull >= TRIGGER
    startY.current = null
    setPull(0)
    if (!reached) return
    haptic('light')
    setRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setRefreshing(false)
    }
  }

  const ptr = refreshing ? 44 : pull

  // Paired but unreachable. The server is a machine in someone's house: it gets
  // turned off, rebooted, moved - and Android drops the link every time this app
  // sits idle in the background. That is not an error, it is Tuesday.
  //
  // So the reconnect happens FIRST and silently (the shell fires app:active on
  // resume, and any call that needs the wire revives it anyway). What is left here
  // is the screen you see when a reconnect has actually FAILED - which is the only
  // moment "the server may be off, or your access was revoked" is a true thing to
  // say to someone.
  // Merged mode browses from the in-memory index (no single connection needed), so the blended view
  // renders from the cached index even while the active client is still connecting - don't gate it on
  // state.connected. Single-host mode still shows the not-connected wall.
  if (!state.connected && !merged?.merged) {
    return (
      <div className='app'>
        <header><h1>{state.host.libraryName || 'Library'}</h1></header>
        {reconnecting
          ? (
            <div className='blank'>
              <ArrowsClockwise size={40} weight='thin' className='spin' />
              <h2>Reconnecting…</h2>
            </div>
            )
          : (
            <div className='blank'>
              <PlugsConnected size={40} weight='thin' />
              <h2>Not connected</h2>
              <p className='muted sm'>
                {/* Always the plain, honest reason - never a raw reconnect error.
                    Off and revoked are indistinguishable from here, and a leaked
                    "host refused the connection (is a pairing window open?)" is
                    developer-speak that belonged to a pairing attempt, not this
                    screen. */}
                PearTune can't reach this library. Your server may be off, or its
                access for this device may have been revoked.
              </p>
              <button className='primary' onClick={onReconnect}>
                <ArrowsClockwise size={16} weight='bold' />
                Try again
              </button>
            </div>
            )}
      </div>
    )
  }

  return (
    <div
      className='app'
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <div className='ptr' style={{ height: ptr }}>
        {ptr > 0 && (
          <ArrowsClockwise
            size={18}
            className={refreshing ? 'spin' : ''}
            style={{ opacity: Math.min(1, ptr / TRIGGER), transform: `rotate(${ptr * 3}deg)` }}
          />
        )}
      </div>

      {/* The TITLE scrolls away; the search box and the picker do not. Those two
          are the controls you reach for from halfway down a grid of 60 albums, and
          scrolling back to the top to find them was the whole complaint. Keeping
          the title sticky as well would cost twice the height for a word you
          already know. */}
      <header>
        <h1>{libTitle}</h1>
        <p className='muted sm'>
          {songFilter
            ? `${shownSongs.length} of ${songs ? songs.length : 0} loaded songs`
            : count(browse, { albums, artists, genres, songs })}
          {/* In the blended view the source kind belongs to the active host, not the blend, so show
              the library COUNT instead ("2 libraries"); a single-host filter shows its source. */}
          {mergedAll
            ? <> · {merged.libraries.length} libraries</>
            : (sourceText(state) && <> · {sourceText(state)}</>)}
        </p>
      </header>

      <div className='sticky'>
        <div className='searchbar'>
          <input
            className='search'
            value={query}
            onChange={e => onSearch(e.target.value)}
            placeholder={browse === 'songs' ? 'Filter loaded songs' : 'Search artists, albums, tracks'}
          />
          {query && (
            <button className='searchclear' onClick={() => onSearch('')} aria-label='Clear search'>
              <X size={15} weight='bold' />
            </button>
          )}
        </div>
        {!searching && (
          <div className='pickrow'>
            {/* Ordered least → most granular: a genre holds artists, an artist holds
                albums, an album holds songs. */}
            <div className='seg'>
              <button className={browse === 'genres' ? 'on' : ''} onClick={() => onBrowse('genres')}>Genres</button>
              <button className={browse === 'artists' ? 'on' : ''} onClick={() => onBrowse('artists')}>Artists</button>
              <button className={browse === 'albums' ? 'on' : ''} onClick={() => onBrowse('albums')}>Albums</button>
              <button className={browse === 'songs' ? 'on' : ''} onClick={() => onBrowse('songs')}>Songs</button>
            </div>
            {/* One "Display" control (layout + sort) instead of two. Stays PUT and
                disabled when the active view has neither to offer (a Subsonic Songs
                list: no grid density, no all-songs sort), so the row does not reflow. */}
            <button
              className='icon dens'
              onClick={onDisplay}
              disabled={!displayHasOptions}
              aria-label='Display options'
            >
              <Faders size={20} weight='regular' />
            </button>
          </div>
        )}
        {/* The source-filter chips (multi-host step 2): [All] + one per library. The blended view is
            the default; a chip narrows to one host (which is just the merged index filtered). Shown
            only with 2+ libraries and not while searching. An offline host is greyed but still
            selectable (its tracks in the last blend remain browsable, just unplayable). */}
        {!searching && merged && (merged.libraries?.length >= 2) && (
          <SourceChips libraries={merged.libraries} filter={merged.merged ? filter : null} onPick={onFilter} />
        )}
      </div>

      {error && <div className='error'>{error}</div>}

      {/* Session handoff: another device is the active player. "Play here" adopts its queue.
          Shown on the home view when this device is NOT actively playing - a PAUSED local queue
          (e.g. a launch-restore) should still offer to switch, so gate on `playing`, not `now`. */}
      {/* The handoff affordance shows across ALL library sub-views (Albums / Artists / Songs),
          not just the album home - it's easy to miss otherwise. Hidden while searching (don't
          crowd results) or while playing here. Also rendered on the You tab. */}
      {handoff && !playing && !searching && (
        <HandoffCard handoff={handoff} onPlayHere={onPlayHere} />
      )}

      {/* Pick up where you left off. Home view, nothing playing here (parent nulls `cont`),
          AND no live session on another device - the "Playing on <name>" card above is the
          richer affordance for that case (it brings the whole queue, not just this one track),
          so Continue yields to it rather than showing the same song twice. */}
      {cont?.track && !now && !handoff && !searching && browse === 'albums' && (
        <ContinueCard cont={cont} onPlay={onContinue} />
      )}

      {searching
        ? (
          <SearchResults
            results={results} now={now} d={D} artBase={artBase} favs={favs} onFav={onFav}
            onOpenAlbum={onOpenAlbum} onOpenArtist={onOpenArtist} onPlay={onPlay} onLong={onLong}
          />
          )
        : browse === 'songs'
          ? (songs
              ? (shownSongs.length
                  ? (
                    <>
                      <ul className='tracks'>
                        {shownSongs.map(t => (
                          <Row
                            key={t.id} t={t} on={now?.trackId === t.id}
                            onPlay={() => onPlay(shownSongs, t)} onLong={onLong} art
                            fav={favs.track.has(t.id)} onFav={favTrack}
                          />
                        ))}
                      </ul>
                      {songCursor != null && (
                        <button className='more' onClick={onMoreSongs}>
                          {songFilter ? 'Load more songs to filter' : 'Load more'}
                        </button>
                      )}
                    </>
                    )
                  // No matches. When filtering, offer to pull in more of the (paged)
                  // library so the filter can reach songs not yet loaded.
                  : songFilter
                    ? (
                      <div className='blank'>
                        <p className='muted sm'>No loaded song matches “{query.trim()}”.</p>
                        {songCursor != null && (
                          <button className='more' onClick={onMoreSongs}>Load more songs</button>
                        )}
                      </div>
                      )
                    : <Empty />)
              : <SkeletonRows />)
          : browse === 'genres'
            ? (genres
                ? <GenreGrid genres={genres} onOpen={onOpenGenre} d={D} />
                : <SkeletonGrid d={D} />)
          : browse === 'artists'
            ? (artists
                ? <ArtistGrid artists={artists} onOpen={onOpenArtist} onLong={onLong} d={D} favs={favs} onFav={onFav} />
                : <SkeletonGrid round d={D} />)
            : !albumsLoaded
                ? <SkeletonGrid d={D} />
                : albums.length
                  ? (
                    <>
                      {recentSupported && recent && recent.length > 0 &&
                        <RecentShelf albums={recent} onOpen={onOpenAlbum} artBase={artBase} />}
                      <Grid albums={albums} onOpen={onOpenAlbum} onLong={onLong} d={D} artBase={artBase} favs={favs} onFav={onFav} />
                      {cursor != null && <button className='more' onClick={onMore}>Load more</button>}
                    </>
                    )
                  : <Empty />}
    </div>
  )
}

function Empty () {
  return (
    <div className='blank'>
      <MusicNotesSimple size={40} weight='thin' />
      <h2>Nothing here yet</h2>
      <p className='muted sm'>
        This library is empty. Add music on the server and let it rescan.
      </p>
    </div>
  )
}

function TopEmpty () {
  return (
    <div className='blank'>
      <MusicNotesSimple size={40} weight='thin' />
      <h2>Nothing played yet</h2>
      <p className='muted sm'>
        Listen to a few tracks and your most-played will collect here, synced across
        your devices.
      </p>
    </div>
  )
}

function FavEmpty () {
  return (
    <div className='blank'>
      <Heart size={40} weight='thin' />
      <h2>No favorites yet</h2>
      <p className='muted sm'>
        Tap the heart on any track, album or artist to save it here. Your favorites live
        on your server, so they follow you to your other devices.
      </p>
    </div>
  )
}

// The "You" tab: a person's own collections, split out of Library so the library
// picker stays a clean Albums / Artists / Songs. Its own small sub-picker switches
// between Favorites and Most Played (Playlists slots in here at P4). The content is
// the same FavoritesView and Most-Played list that used to live in Library; only the
// home changed.
function You ({
  state, density, now, handoff, playing, onPlayHere, youView, onYouView,
  favSupported, favItems, mostPlayed, favs, onFav,
  playlists, plSupported, serverPls, sourceName, downloads,
  onOpenPlaylist, onOpenServerPlaylist, onOpenDownload, onNewPlaylist,
  onPlay, onLong, onOpenAlbum, onOpenArtist
}) {
  const D = densityOf(density)
  const artBase = state.artBase || state.host?.artBase || null
  const favTrack = onFav ? (t => onFav('track', t)) : null
  // An old host with no favorites support has only Most Played; never sit on an
  // empty, hidden Favorites view.
  const view = (!favSupported && youView === 'favorites') ? 'top' : youView
  return (
    <div className='app'>
      <header>
        <h1>You</h1>
        <p className='muted sm'>{youCount(view, { favItems, mostPlayed, playlists, serverPls, downloads })}</p>
      </header>

      <div className='sticky'>
        <div className='pickrow'>
          {/* Icon-first picker: every view is an icon; the ACTIVE one also shows its label
              and grows to fill, the rest collapse to their icon. Keeps all four (Favorites /
              Most Played / Playlists / Downloads) on one row - four full labels overflowed and
              forced a sideways scroll that clipped Downloads. aria-label carries the name for
              the collapsed icons. */}
          <div className='seg icons'>
            {favSupported && (
              <button className={view === 'favorites' ? 'on' : ''} aria-label='Favorites' onClick={() => onYouView('favorites')}>
                <Heart size={17} weight={view === 'favorites' ? 'fill' : 'regular'} />
                {view === 'favorites' && <span>Favorites</span>}
              </button>
            )}
            <button className={view === 'top' ? 'on' : ''} aria-label='Most Played' onClick={() => onYouView('top')}>
              <ChartLineUp size={17} weight={view === 'top' ? 'fill' : 'regular'} />
              {view === 'top' && <span>Most Played</span>}
            </button>
            {plSupported && (
              <button className={view === 'playlists' ? 'on' : ''} aria-label='Playlists' onClick={() => onYouView('playlists')}>
                <PlaylistIcon size={17} weight={view === 'playlists' ? 'fill' : 'regular'} />
                {view === 'playlists' && <span>Playlists</span>}
              </button>
            )}
            <button className={view === 'downloads' ? 'on' : ''} aria-label='Downloads' onClick={() => onYouView('downloads')}>
              <DownloadSimple size={17} weight={view === 'downloads' ? 'fill' : 'regular'} />
              {view === 'downloads' && <span>Downloads</span>}
            </button>
          </div>
        </div>
      </div>

      {/* Session handoff also surfaces on the You tab (below the sub-picker), so it is not
          missable while browsing favorites/playlists/downloads. */}
      {handoff && !playing && <HandoffCard handoff={handoff} onPlayHere={onPlayHere} />}

      {view === 'favorites'
        ? (favItems
            ? <FavoritesView
                favItems={favItems} favs={favs} onFav={onFav} now={now} d={D} artBase={artBase}
                onPlay={onPlay} onLong={onLong} onOpenAlbum={onOpenAlbum} onOpenArtist={onOpenArtist}
              />
            : <SkeletonRows />)
        : view === 'playlists'
          ? <PlaylistsView
              playlists={playlists} serverPls={serverPls} sourceName={sourceName}
              onOpen={onOpenPlaylist} onOpenServer={onOpenServerPlaylist} onNew={onNewPlaylist}
            />
          : view === 'downloads'
            ? <DownloadsView downloads={downloads} d={D} onOpen={onOpenDownload} />
          : (mostPlayed
              ? (mostPlayed.items.length
                  ? (
                    <ul className='tracks'>
                      {mostPlayed.items.map(t => (
                        <Row
                          key={t.id} t={t} on={now?.trackId === t.id}
                          onPlay={() => onPlay(mostPlayed.items, t)} onLong={onLong} art
                          fav={favs.track.has(t.id)} onFav={favTrack} count={t.playCount}
                        />
                      ))}
                    </ul>
                    )
                  : <TopEmpty />)
              : <SkeletonRows />)}
    </div>
  )
}

function youCount (view, { favItems, mostPlayed, playlists, serverPls, downloads }) {
  if (view === 'top') return mostPlayed ? `${mostPlayed.items.length} most played` : 'Loading…'
  if (view === 'downloads') {
    if (!downloads) return 'Loading downloads…'
    return `${downloads.length} download${downloads.length === 1 ? '' : 's'}`
  }
  if (view === 'playlists') {
    if (!playlists) return 'Loading playlists…'
    const n = playlists.length + (serverPls?.length || 0)
    return `${n} playlist${n === 1 ? '' : 's'}`
  }
  if (!favItems) return 'Loading favorites…'
  const n = favItems.tracks.length + favItems.albums.length + favItems.artists.length
  return `${n} favorite${n === 1 ? '' : 's'}`
}

// The Playlists list: a "New playlist" button, then OUR playlists, then (v2) the
// source's OWN playlists in a read-only "From <server>" section. Tapping a row opens its
// detail. When there is nothing at all, one invitation rather than an empty grid.
function PlaylistsView ({ playlists, serverPls, sourceName, onOpen, onOpenServer, onNew }) {
  if (!playlists) return <SkeletonRows />
  const mine = playlists
  const theirs = serverPls || []
  const nothingAtAll = mine.length === 0 && theirs.length === 0
  // A header over OUR list only earns its keep once the server section is also there to
  // be told apart from; with just our own, the "New playlist" button already frames it.
  const showMineHeader = mine.length > 0 && theirs.length > 0
  return (
    <div className='plview'>
      <button className='wide newpl' onClick={onNew}>
        <Plus size={18} weight='bold' /> New playlist
      </button>

      {nothingAtAll && (
        <div className='blank'>
          <PlaylistIcon size={40} weight='thin' />
          <h2>No playlists yet</h2>
          <p className='muted sm'>
            Make one, then add tracks, albums or artists to it from their ⋯ menu. Your
            playlists live on your server, so they follow you to your other devices.
          </p>
        </div>
      )}

      {mine.length > 0 && (
        <>
          {showMineHeader && <h3 className='favh'>Your playlists</h3>}
          <PlaylistRows items={mine} onOpen={onOpen} />
        </>
      )}

      {theirs.length > 0 && (
        <section className='plserver'>
          <h3 className='favh'>{sourceName ? `From ${sourceName}` : 'From your server'}</h3>
          <PlaylistRows items={theirs} onOpen={onOpenServer} server />
        </section>
      )}
    </div>
  )
}

// The shared row list for both our playlists and the server's. Server rows carry a
// count only when the source reports one (songCount), and a subtly different icon so
// "yours vs the server's" reads at a glance.
function PlaylistRows ({ items, onOpen, server }) {
  return (
    <ul className='pllist'>
      {items.map(pl => {
        const n = server ? pl.songCount : pl.count
        return (
          <li key={pl.id} onClick={() => onOpen(pl)}>
            <span className='plicon'>
              <PlaylistIcon size={22} weight={server ? 'thin' : 'regular'} />
            </span>
            <div className='meta'>
              <div className='t'>{pl.name}</div>
              {n != null && <div className='muted sm sub'>{n} track{n === 1 ? '' : 's'}</div>}
            </div>
            <CaretRight size={18} className='muted' />
          </li>
        )
      })}
    </ul>
  )
}

// The Downloads view (phase 5C): albums pinned for offline, as a cover grid. Works with
// no connection - the list comes from the local pin registry. Tapping opens the offline
// album detail (DownloadScreen). Covers may fall back to a placeholder offline (art is not
// cached in v1).
function DownloadsView ({ downloads, d, onOpen }) {
  if (!downloads) return <SkeletonGrid d={d} />
  if (!downloads.length) return <DownloadsEmpty />
  const list = d.cols === 1
  return (
    <div className={'grid' + (list ? ' aslist' : '')} style={{ '--cols': d.cols }}>
      {downloads.map(a => (
        <Tile key={a.id} className='album' onPress={() => onOpen(a)}>
          <Cover src={a.art} />
          <div className='meta'>
            <div className='t sm'>{a.name}</div>
            <div className='muted sm sub'>
              {[a.artist, a.count ? `${a.count} track${a.count === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')}
            </div>
          </div>
          {a.complete === false && <span className='dlbadge'>Downloading…</span>}
        </Tile>
      ))}
    </div>
  )
}

function DownloadsEmpty () {
  return (
    <div className='blank'>
      <DownloadSimple size={40} weight='thin' />
      <h2>No downloads yet</h2>
      <p className='muted sm'>
        Open an album and tap Download to keep it on this phone. Downloads play with no
        connection - on a plane, on the subway, anywhere.
      </p>
    </div>
  )
}

// A downloaded album's own screen, sourced entirely from the local pin registry - so it
// renders and plays with NO connection, even from a cold launch. The shim serves each
// track from disk.
function DownloadScreen ({ id, name, now, onBack, onPlay, onPlayAll, onQueue, onUnpin }) {
  const [dl, setDl] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => {
    let live = true
    call('downloadDetail', { albumId: id })
      .then(d => { if (live) setDl(d || false) })
      .catch(e => { if (live) setErr(e.message) })
    return () => { live = false }
  }, [id])

  const tracks = dl?.tracks || []
  return (
    <div className='app'>
      <Back onClick={onBack} />
      {err && <div className='error'>{err}</div>}
      {dl === null && !err && <p className='muted center-p'>Loading…</p>}
      {dl === false && <p className='muted center-p'>This download is gone.</p>}
      {dl && (
        <>
          <div className='albumhead'>
            <Cover src={dl.art} big />
            <div className='headmeta'>
              <h1>{dl.name || name}</h1>
              <p className='muted sm'>
                {[dl.artist, `${tracks.length} track${tracks.length === 1 ? '' : 's'}`, 'Downloaded'].filter(Boolean).join(' · ')}
              </p>
            </div>
          </div>
          {tracks.length > 0 && (
            <Actions
              onPlay={() => onPlayAll(tracks)}
              onShuffle={() => onPlayAll(tracks, { shuffled: true })}
              onQueue={() => onQueue(tracks)}
            />
          )}
          <button className='dlremove' onClick={onUnpin}>
            <Trash size={16} weight='bold' /> Remove download
          </button>
          <ul className='tracks'>
            {tracks.map(t => (
              <Row key={t.id} t={t} on={now?.trackId === t.id} onPlay={() => onPlay(tracks, t)} showTrackNo />
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

// The Favorites view: favorited artists, albums and songs, each in its own section
// (only the non-empty ones show). Reuses the same grids and rows as the rest of the
// library; songs carry a heart to un-favorite inline.
function FavoritesView ({ favItems, favs, onFav, now, d, artBase, onPlay, onLong, onOpenAlbum, onOpenArtist }) {
  const { tracks, albums, artists } = favItems
  if (!tracks.length && !albums.length && !artists.length) return <FavEmpty />
  const favTrack = onFav ? (t => onFav('track', t)) : null
  return (
    <div className='favview'>
      {artists.length > 0 && (
        <section>
          <h3 className='favh'>Artists</h3>
          <ArtistGrid artists={artists} onOpen={onOpenArtist} onLong={onLong} d={d} favs={favs} onFav={onFav} />
        </section>
      )}
      {albums.length > 0 && (
        <section>
          <h3 className='favh'>Albums</h3>
          <Grid albums={albums} onOpen={onOpenAlbum} onLong={onLong} d={d} artBase={artBase} favs={favs} onFav={onFav} />
        </section>
      )}
      {tracks.length > 0 && (
        <section>
          <h3 className='favh'>Songs</h3>
          <ul className='tracks'>
            {tracks.map(t => (
              <Row
                key={t.id} t={t} on={now?.trackId === t.id}
                onPlay={() => onPlay(tracks, t)} onLong={onLong} art
                fav={favs.track.has(t.id)} onFav={favTrack}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

// "Continue listening" - a launch affordance that resumes the last track from where it
// was stopped. One tap plays it (playFrom applies the saved position). It disappears
// once something is playing, or when there is nothing to continue.
function ContinueCard ({ cont, onPlay }) {
  const t = cont.track
  const press = usePress(onPlay)
  return (
    <div className='contcard' {...press}>
      <Cover src={t.art} sm />
      <div className='meta'>
        <div className='muted sm cont-h'>Continue listening</div>
        <div className='t'>{t.title}</div>
        <div className='muted sm sub'>
          {[t.artist, cont.positionMs ? 'at ' + fmt(cont.positionMs) : ''].filter(Boolean).join(' · ')}
        </div>
      </div>
      <div className='contplay'><Play size={20} weight='fill' /></div>
    </div>
  )
}

// Session handoff: another of this person's devices is the active player. "Play here" adopts
// its queue (same track + spot) onto this device and pauses the other one. Shown only when
// nothing is playing here.
function HandoffCard ({ handoff, onPlayHere }) {
  const press = usePress(onPlayHere)
  const name = handoff.activeDeviceName || 'another device'
  const n = handoff.count || 0
  // Say what the other device is actually doing. It holds the token while paused too, so a flat
  // "Playing on X" would lie when X is paused (deferred follow-up #2). Default to "Playing" only
  // if the field is absent (an old worklet that never reported it).
  const verb = handoff.activePlaying === false ? 'Paused' : 'Playing'
  return (
    <div className='contcard' {...press}>
      <div className='handoff-ic'><SpeakerHigh size={22} weight='fill' /></div>
      <div className='meta'>
        <div className='muted sm cont-h'>{verb} on {name}</div>
        <div className='t'>Play here</div>
        <div className='muted sm sub'>{n} track{n === 1 ? '' : 's'} · continue on this device</div>
      </div>
      <div className='contplay'><Play size={20} weight='fill' /></div>
    </div>
  )
}

// A labelled heart for a detail header (album / artist). Bigger and clearer than the
// row heart because it is the primary action on that screen.
function FavHeart ({ on, onToggle, label }) {
  return (
    <button
      className={'favhead' + (on ? ' on' : '')}
      aria-label={on ? `Remove ${label} from favorites` : `Add ${label} to favorites`}
      onClick={onToggle}
    >
      <Heart size={20} weight={on ? 'fill' : 'regular'} />
      <span>{on ? 'Favorited' : 'Favorite'}</span>
    </button>
  )
}

// Download / Downloaded / Downloading, in the same pill as the favorite heart. While a
// download runs it shows a spinner and the track count; tapping a finished one removes it.
function DownloadButton ({ pinned, pinning, onPin, onUnpin }) {
  if (pinning) {
    return (
      <button className='favhead' disabled aria-label='Downloading'>
        <CircleNotch size={18} weight='bold' className='spin' />
        <span>{pinning.total ? `${pinning.done}/${pinning.total}` : 'Downloading…'}</span>
      </button>
    )
  }
  if (pinned) {
    return (
      <button className='favhead on' onClick={onUnpin} aria-label='Remove download'>
        <CheckCircle size={20} weight='fill' />
        <span>Downloaded</span>
      </button>
    )
  }
  return (
    <button className='favhead' onClick={onPin} aria-label='Download album'>
      <DownloadSimple size={20} weight='bold' />
      <span>Download</span>
    </button>
  )
}

// What to call the current source. The host reports the server's OWN name
// (sourceName: "Navidrome", "Nextcloud Music", "Gonic", "Emby Server"), which is what
// we want when we have it. sourceLabel is the fallback for an older host that only
// sends the coarse KIND - and 'subsonic' is the kind for ANY Subsonic server, so
// "Subsonic" is the honest umbrella there rather than naming one server the operator
// may not run. ('navidrome' is the pre-rename kind a not-yet-upgraded host still sends.)
function sourceText (state) {
  if (state.sourceName) return state.sourceName
  return sourceLabel(state.source)
}

// The paired libraries for the Settings switcher (multi-host, 2026-07-19). init/listHosts/
// removeHost supply state.hosts; fall back to the single active host so the section still
// renders on any pre-hosts state shape. ACTIVE is derived from state.host.hostKey - the one
// source of truth the switch always updates - rather than a stored flag, so the indicator can
// never drift from the library actually connected.
function libsOf (state) {
  const list = Array.isArray(state.hosts) && state.hosts.length
    ? state.hosts
    : (state.host ? [state.host] : [])
  const activeKey = state.host?.hostKey
  return list.map(h => ({ ...h, active: h.hostKey === activeKey }))
}

function sourceLabel (kind) {
  if (kind === 'jellyfin') return 'Jellyfin'
  if (kind === 'folder') return 'Folder'
  // 'subsonic' is the kind for ANY Subsonic server; 'navidrome' is the old name a
  // not-yet-upgraded host still reports. Both mean the same umbrella.
  if (kind === 'subsonic' || kind === 'navidrome') return 'Subsonic'
  return null
}

// Turn a raw pairing failure into something a person can act on. The wire errors
// are written for a developer ("host refused the connection (is a pairing window
// open?)"); the person holding the phone needs to know what to DO.
function pairError (msg = '') {
  const m = String(msg)
  if (/pairing window|host refused|firewall|denied/i.test(m)) {
    return "Couldn't reach your library. Make sure the pairing code is still showing on your server's dashboard, then try again."
  }
  if (/not a peartune|not a valid|invalid|malformed/i.test(m)) {
    return "That doesn't look like a PearTune pairing code. Copy it again from your server's dashboard."
  }
  if (/timed out|timeout|expired/i.test(m)) {
    return 'That pairing code has expired. Show a fresh one on your server and try again.'
  }
  return 'Pairing failed. Show a fresh code on your server and try again.'
}

function count (browse, { albums, artists, genres, songs }) {
  if (browse === 'artists') return `${artists ? artists.length : 0} artists`
  if (browse === 'genres') return `${genres ? genres.length : 0} genres`
  // "60 albums" is the whole truth; "100 songs" is not - it is the first page of a
  // list we are still walking. Say so rather than lying about the size of someone's
  // library.
  if (browse === 'songs') return songs ? `${songs.length} songs loaded` : 'Loading songs…'
  return `${albums.length} albums`
}

// A grid of the right SHAPE, greyed and breathing, rather than the word
// "Loading…" in the middle of an empty screen. The tiles are exactly the size the
// covers will be, so nothing jumps when they arrive.
function SkeletonGrid ({ round, n = 6, d = DENSITY[2] }) {
  const list = d.cols === 1
  return (
    <div className={'grid' + (list ? ' aslist' : '')} style={{ '--cols': d.cols }}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className={'album' + (round ? ' artist' : '')}>
          <div className={'cover skel' + (round ? ' artistpic' : '')} />
          <div className='meta'>
            <div className='skel line' />
            <div className='skel line short' />
          </div>
        </div>
      ))}
    </div>
  )
}

function SkeletonRows ({ n = 8 }) {
  return (
    <ul className='tracks'>
      {Array.from({ length: n }, (_, i) => (
        <li key={i}>
          <div className='cover sm-cover skel' />
          <div className='meta'>
            <div className='skel line' />
            <div className='skel line short' />
          </div>
        </li>
      ))}
    </ul>
  )
}

// One component for all three densities. A "list" is just a one-column grid whose
// rows are laid out sideways - not a separate screen with its own bugs.
// Search results, GROUPED and collapsible.
//
// A search for "krutch" can return four artists, a dozen albums and thirty songs,
// and the flat list meant scrolling past every artist to reach the songs. Each
// group now says how many it found and opens on a tap.
//
// A group with a handful of hits opens itself: making someone tap to reveal two
// results is a worse tax than the scrolling was.
function SearchResults ({ results, now, d, artBase, favs, onFav, onOpenAlbum, onOpenArtist, onPlay, onLong }) {
  const groups = [
    { key: 'artists', label: 'Artists', items: results.artists || [] },
    { key: 'albums', label: 'Albums', items: results.albums || [] },
    { key: 'tracks', label: 'Songs', items: results.tracks || [] }
  ].filter(g => g.items.length)

  const AUTO_OPEN = 5

  // Each group opens and closes on its own - this is not an accordion. You often
  // want the artists AND the songs; being forced to close one to see the other is
  // the same tedium in a different shape.
  const [open, setOpen] = useState({})
  useEffect(() => { setOpen({}) }, [results]) // a new search starts fresh

  if (!groups.length) return <p className='muted center-p'>Nothing found.</p>

  return (
    <>
      {groups.map(g => {
        const isOpen = open[g.key] ?? g.items.length <= AUTO_OPEN
        return (
          <div key={g.key} className='sgroup'>
            <button
              className='shead'
              aria-expanded={isOpen}
              onClick={() => { haptic('light'); setOpen(o => ({ ...o, [g.key]: !isOpen })) }}
            >
              <span>{g.label} <span className='cnt'>{g.items.length}</span></span>
              <CaretRight size={15} className={'caret' + (isOpen ? ' open' : '')} />
            </button>

            {isOpen && (
              <div className='sbody'>
                {g.key === 'artists' && (
                  <ArtistGrid artists={g.items} onOpen={onOpenArtist} onLong={onLong} d={d} favs={favs} onFav={onFav} />
                )}
                {g.key === 'albums' && (
                  <Grid albums={g.items} onOpen={onOpenAlbum} onLong={onLong} d={d} artBase={artBase} favs={favs} onFav={onFav} />
                )}
                {g.key === 'tracks' && (
                  <ul className='tracks'>
                    {g.items.map(t => (
                      <Row
                        key={t.id} t={t} on={now?.trackId === t.id}
                        onPlay={() => onPlay(g.items, t)} onLong={onLong} art
                        fav={favs?.track?.has(t.id)} onFav={onFav ? (x => onFav('track', x)) : null}
                      />
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

// The Recently Added shelf: a horizontal strip of the newest albums above the grid.
// Fixed-size tiles that scroll sideways, visually distinct from the full grid so it
// reads as a shelf rather than the top of the list. Tapping opens the album.
function RecentShelf ({ albums, onOpen, artBase }) {
  if (!albums.length) return null
  return (
    <div className='shelf'>
      <div className='shelf-head'>Recently added</div>
      <div className='shelf-row'>
        {albums.map(a => (
          <button className='shelf-item' key={a.id} onClick={() => onOpen(a.id)}>
            <Cover src={artFor(a, DENSITY[2], artBase)} />
            <div className='shelf-t'>{a.name}</div>
            {a.artist && <div className='shelf-a muted'>{a.artist}</div>}
          </button>
        ))}
      </div>
    </div>
  )
}

// The source-filter chips for the merged library (multi-host step 2). [All] is the blend; each other
// chip narrows to one library. An offline library (not in the current blend) is greyed but still
// tappable. `filter` is the active chip id, or null when a Settings switch has focused one host (so
// nothing here is lit and tapping any chip returns to the blended view).
function SourceChips ({ libraries, filter, onPick }) {
  return (
    <div className='chips'>
      <button className={'chip' + (filter === '_all' ? ' on' : '')} onClick={() => onPick('_all')}>All</button>
      {libraries.map(l => (
        <button
          key={l.libraryId}
          className={'chip' + (filter === l.libraryId ? ' on' : '') + (l.connected ? '' : ' off')}
          onClick={() => onPick(l.libraryId)}
          title={l.connected ? undefined : 'Offline'}
        >
          {l.libraryName || 'Library'}
        </button>
      ))}
    </div>
  )
}

function Grid ({ albums, onOpen, onLong, d = DENSITY[2], artBase, favs, onFav }) {
  if (!albums.length) return null
  const list = d.cols === 1
  return (
    <div className={'grid' + (list ? ' aslist' : '')} style={{ '--cols': d.cols }}>
      {albums.map(a => (
        <Tile
          key={a.id} className='album'
          onPress={() => onOpen(a.id)}
          onLongPress={onLong && (() => onLong({ type: 'album', id: a.id, name: a.name }))}
          fav={favs?.album?.has(a.id)}
          onFav={onFav ? (() => onFav('album', a)) : null}
        >
          <Cover src={artFor(a, d, artBase)} />
          <div className='meta'>
            <div className='t sm'>{a.name}</div>
            <div className='muted sm sub'>{a.artist}</div>
          </div>
        </Tile>
      ))}
    </div>
  )
}

// One element, two gestures: tap opens it, a long press offers to play it. When onFav
// is given it also carries a heart in the corner that must NOT trigger the tile's own
// press (stop it at pointerdown, which is what usePress listens on).
function Tile ({ className, onPress, onLongPress, children, fav, onFav }) {
  const press = usePress(onPress, onLongPress)
  return (
    <div className={className} {...press}>
      {children}
      {onFav && (
        <button
          className={'tileheart' + (fav ? ' on' : '')}
          aria-label={fav ? 'Remove from favorites' : 'Add to favorites'}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onFav() }}
        >
          <Heart size={17} weight={fav ? 'fill' : 'regular'} />
        </button>
      )}
    </div>
  )
}

// The art URL is built HERE because the size depends on the density, and asking
// the worklet to re-list the whole library just to change a number in a URL would
// be silly. Falls back to whatever it precomputed if the base is missing.
function artFor (x, d, artBase) {
  if (!x.coverId || !artBase) return x.art || null
  return `${artBase}${encodeURIComponent(x.coverId)}?s=${d.art}`
}

function ArtistGrid ({ artists, onOpen, onLong, d = DENSITY[2], favs, onFav, empty = <p className='muted center-p'>No artists.</p> }) {
  if (!artists.length) return empty
  const list = d.cols === 1
  return (
    <div className={'grid' + (list ? ' aslist' : '')} style={{ '--cols': d.cols }}>
      {artists.map(a => (
        <Tile
          key={a.id} className='album artist'
          onPress={() => onOpen(a)}
          onLongPress={onLong && (() => onLong({ type: 'artist', id: a.id, name: a.name }))}
          fav={favs?.artist?.has(a.id)}
          onFav={onFav ? (() => onFav('artist', a)) : null}
        >
          <Cover src={a.art} artist />
          <div className='meta'>
            <div className='t sm'>{a.name}</div>
            {/* "0 albums" is a true thing to say and a useless one - it is how
                Navidrome's participant-artist rows look, and stamping it under
                nineteen of them is just noise. Say nothing; the artist page will
                show their songs. */}
            {a.albumCount > 0 && (
              <div className='muted sm sub'>{a.albumCount} {a.albumCount === 1 ? 'album' : 'albums'}</div>
            )}
          </div>
        </Tile>
      ))}
    </div>
  )
}

// Genres reuse the album (square) tile - a genre's cover is its first album's, so
// the grid is real artwork, not a wall of grey. No long-press menu or heart: a genre
// is a doorway to its albums, not a thing you favourite. Subsonic/Jellyfin genres
// carry no art, so those fall back to the placeholder cover.
function GenreGrid ({ genres, onOpen, d = DENSITY[2], empty = <p className='muted center-p'>No genres.</p> }) {
  if (!genres.length) return empty
  const list = d.cols === 1
  return (
    <div className={'grid' + (list ? ' aslist' : '')} style={{ '--cols': d.cols }}>
      {genres.map(g => (
        <Tile key={g.id} className='album' onPress={() => onOpen(g)}>
          <Cover src={g.art} />
          <div className='meta'>
            <div className='t sm'>{g.name}</div>
            {g.albumCount > 0 && (
              <div className='muted sm sub'>{g.albumCount} {g.albumCount === 1 ? 'album' : 'albums'}</div>
            )}
          </div>
        </Tile>
      ))}
    </div>
  )
}

// The cover comes over P2P via the worklet's loopback server. A library often has
// albums with no art at all, so a missing cover must look intentional rather than
// broken.
function Cover ({ src, big, sm, artist }) {
  const [failed, setFailed] = useState(false)
  const cls = 'cover' + (big ? ' big' : '') + (sm ? ' sm-cover' : '') + (artist ? ' artistpic' : '')
  if (!src || failed) {
    return (
      <div className={cls + ' ph'}>
        {artist
          ? <UsersThree size={28} weight='regular' />
          : <MusicNotesSimple size={sm ? 18 : 28} weight='regular' />}
      </div>
    )
  }
  return <img className={cls} src={src} loading='lazy' onError={() => setFailed(true)} />
}

// Each drill-down fetches its own data from its id, so the nav stack holds nothing
// but ids and popping back never has to restore anything.
function AlbumScreen ({ id, now, error, onBack, onPlay, onPlayAll, onQueue, onViewArt, favs, onFav, pinned, pinning, onPin, onUnpin }) {
  const [album, setAlbum] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let live = true
    call('album', { id })
      .then(a => {
        if (!live) return
        // A null is a real answer ("the host does not have this"), not a slow one.
        // Treating it as "still loading" is how you get a spinner that never
        // stops - which is exactly what an older host, one that does not know this
        // type, produced.
        if (a) setAlbum(a)
        else setErr('That album is not in this library any more.')
      })
      .catch(e => { if (live) setErr(e.message) })
    return () => { live = false }
  }, [id])

  const problem = err || error

  if (!album) {
    return (
      <div className='app'>
        <Back onClick={onBack} />
        {problem ? <div className='error'>{problem}</div> : <p className='muted center-p'>Loading…</p>}
      </div>
    )
  }

  // The album's cover is the queue's cover: Navidrome gives per-album art, so a
  // track row inherits it.
  const tracks = (album.tracks || []).map(t => ({
    ...t, art: t.art ?? album.art, artFull: album.artFull
  }))

  return (
    <div className='app'>
      <Back onClick={onBack} />
      {problem && <div className='error'>{problem}</div>}

      <div className='albumhead'>
        <div className='tapart' onClick={() => onViewArt(album.artFull || album.art, album.name)}>
          <Cover src={album.art} big />
        </div>
        <div className='headmeta'>
          <h1>{album.name}</h1>
          <p className='muted sm'>{[album.artist, album.year].filter(Boolean).join(' · ')}</p>
          <div className='headacts'>
            {onFav && <FavHeart on={favs?.album?.has(album.id)} onToggle={() => onFav('album', album)} label='album' />}
            {onPin && <DownloadButton pinned={pinned} pinning={pinning} onPin={onPin} onUnpin={onUnpin} />}
          </div>
        </div>
      </div>

      <Actions
        onPlay={() => onPlayAll(tracks)}
        onShuffle={() => onPlayAll(tracks, { shuffled: true })}
        onQueue={() => onQueue(tracks)}
      />

      <ul className='tracks'>
        {tracks.map(t => (
          <Row
            key={t.id} t={t} on={now?.trackId === t.id} onPlay={() => onPlay(tracks, t)} showTrackNo
            fav={favs?.track?.has(t.id)} onFav={onFav ? (x => onFav('track', x)) : null}
          />
        ))}
      </ul>
    </div>
  )
}

// The obvious way to play a record: a button that says Play. Long-press on a tile
// is the shortcut for people who know it is there; this is for everyone else.
function Actions ({ onPlay, onShuffle, onQueue }) {
  return (
    <div className='actions'>
      <button className='primary' onClick={onPlay}>
        <Play size={16} weight='fill' /> Play
      </button>
      <button onClick={onShuffle}>
        <Shuffle size={16} weight='bold' /> Shuffle
      </button>
      <button className='icon sq' onClick={onQueue} aria-label='Add to queue'>
        <ListPlus size={18} weight='bold' />
      </button>
    </div>
  )
}

// An artist IS its albums (one getArtist call on the host), so this is the album
// grid again rather than a new kind of screen.
function ArtistScreen ({ id, name, now, onBack, onOpenAlbum, onPlay, onViewArt, onLong, onArtistAction, favs, onFav }) {
  const [artist, setArtist] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let live = true
    call('artist', { id })
      .then(a => {
        if (!live) return
        // See AlbumScreen: a null means the host has no such artist - which is
        // also what an older host says about a type it does not implement. Say so
        // rather than spinning.
        if (a) setArtist(a)
        else setErr('This library cannot browse by artist. The server may be running an older version of PearTune.')
      })
      .catch(e => { if (live) setErr(e.message) })
    return () => { live = false }
  }, [id])

  return (
    <div className='app'>
      <Back onClick={onBack} />

      <div className='albumhead'>
        <div className='tapart' onClick={() => onViewArt(artist?.artFull || artist?.art, artist?.name)}>
          <Cover src={artist?.art} big artist />
        </div>
        <div className='headmeta'>
          <h1>{artist?.name || name}</h1>
          {artist && (
            <p className='muted sm'>
              {artist.albums.length
                ? `${artist.albums.length} ${artist.albums.length === 1 ? 'album' : 'albums'}`
                : `${artist.tracks?.length || 0} ${artist.tracks?.length === 1 ? 'track' : 'tracks'}`}
            </p>
          )}
          {onFav && artist && <FavHeart on={favs?.artist?.has(id)} onToggle={() => onFav('artist', { id, name: artist.name })} label='artist' />}
        </div>
      </div>

      {artist && (!!artist.albums.length || !!artist.tracks?.length) && (
        <Actions
          onPlay={() => onArtistAction(id, 'play')}
          onShuffle={() => onArtistAction(id, 'shuffle')}
          onQueue={() => onArtistAction(id, 'queue')}
        />
      )}

      {err && <div className='error'>{err}</div>}
      {!artist && !err && <p className='muted center-p'>Loading…</p>}

      {/* An artist with no albums is not empty. Navidrome mints an artist row for
          every composite tag ("Artist/Remixer"), and those have songs but no albums
          of their own - so show the songs. This page used to say "No albums." and
          leave you nowhere. */}
      {artist && (artist.albums.length
        ? <Grid albums={artist.albums} onOpen={onOpenAlbum} onLong={onLong} favs={favs} onFav={onFav} />
        : artist.tracks?.length
          ? (
            <ul className='tracks'>
              {artist.tracks.map(t => (
                <Row
                  key={t.id} t={t} on={now?.trackId === t.id}
                  onPlay={() => onPlay(artist.tracks, t)} onLong={onLong} art
                  fav={favs?.track?.has(t.id)} onFav={onFav ? (x => onFav('track', x)) : null}
                />
              ))}
            </ul>
            )
          : <p className='muted center-p'>Nothing here.</p>)}
    </div>
  )
}

// A playlist's own screen (a drill-down like an album). Tap a track to play the
// playlist from there. For OUR playlists a pencil toggles Edit mode - the name becomes
// an inline field, and each row gets a drag grip and a remove button; a trash icon
// beside the pencil deletes the whole playlist. Server playlists are read-only (no
// icons, no edit).
//
// Every edit works on the RAW id list (pl.trackIds) via each resolved track's raw index
// `_i` - see the worklet's playlistDetail - so a track that failed to resolve this
// session is never dropped by reordering or by a neighbour's removal. React keys use the
// STABLE `_k` (not `_i`, which reordering reassigns) so a drag animates a move.
// A genre's own screen: a grid of its albums (a doorway one level broader than an
// artist). No big cover header - a genre has no single face - just its name, a
// Play/Shuffle/Queue bar, and the albums. A loose-tagged genre with no album of its
// own falls back to its tracks, the same as an artist.
function GenreScreen ({ id, name, now, onBack, onOpenAlbum, onOpenArtist, onPlay, onLong, onGenreAction, favs, onFav }) {
  const [genre, setGenre] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let live = true
    call('genre', { id })
      .then(g => {
        if (!live) return
        // A null means the host has no such genre - which is also what an older host
        // says about a type it does not implement. Say so rather than spinning.
        if (g) setGenre(g)
        else setErr('This library cannot browse by genre. The server may be running an older version of PearTune.')
      })
      .catch(e => { if (live) setErr(e.message) })
    return () => { live = false }
  }, [id])

  const hasContent = genre && (!!genre.albums.length || !!genre.tracks?.length)
  return (
    <div className='app'>
      <Back onClick={onBack} />

      <div className='plhead'>
        <h1>{genre?.name || name}</h1>
        {genre && (
          <p className='muted sm'>
            {genre.albums.length
              ? `${genre.albums.length} ${genre.albums.length === 1 ? 'album' : 'albums'}`
              : `${genre.tracks?.length || 0} ${genre.tracks?.length === 1 ? 'track' : 'tracks'}`}
          </p>
        )}
      </div>

      {hasContent && (
        <Actions
          onPlay={() => onGenreAction(id, 'play')}
          onShuffle={() => onGenreAction(id, 'shuffle')}
          onQueue={() => onGenreAction(id, 'queue')}
        />
      )}

      {err && <div className='error'>{err}</div>}
      {!genre && !err && <p className='muted center-p'>Loading…</p>}

      {genre && (genre.albums.length
        ? <Grid albums={genre.albums} onOpen={onOpenAlbum} onLong={onLong} favs={favs} onFav={onFav} />
        : genre.tracks?.length
          ? (
            <ul className='tracks'>
              {genre.tracks.map(t => (
                <Row
                  key={t.id} t={t} on={now?.trackId === t.id}
                  onPlay={() => onPlay(genre.tracks, t)} onLong={onLong} art
                  fav={favs?.track?.has(t.id)} onFav={onFav ? (x => onFav('track', x)) : null}
                />
              ))}
            </ul>
            )
          : <p className='muted center-p'>Nothing here.</p>)}
    </div>
  )
}

function PlaylistScreen ({ id, name, now, onBack, onPlay, onPlayAll, onQueue, onRename, onDelete, onSetTracks, server, sourceName }) {
  const [pl, setPl] = useState(null)
  const [err, setErr] = useState(null)
  const [editing, setEditing] = useState(false)
  const [nm, setNm] = useState('')
  const [drag, setDrag] = useState(null)     // { from, dy, insertAt, rowH } during a drag
  const [removing, setRemoving] = useState([]) // _k of rows fading out

  useEffect(() => {
    let live = true
    // The server's own playlists are read-only and fetched differently; ours carry the
    // raw id list needed to edit.
    call(server ? 'serverPlaylistDetail' : 'playlistDetail', { id })
      .then(p => { if (live) setPl(p) })
      .catch(e => { if (live) setErr(e.message) })
    return () => { live = false }
  }, [id, server])

  const title = pl?.name ?? name ?? 'Playlist'
  const tracks = pl?.tracks || []

  const commit = (rawIds, nextTracks) => {
    setPl(p => ({ ...p, trackIds: rawIds, tracks: nextTracks }))
    onSetTracks(id, rawIds)
  }

  // Remove: fade the row out first (a class flips opacity/height), THEN drop it from the
  // data, so the row visibly leaves rather than blinking away.
  const REMOVE_MS = 260
  const removeAt = (i) => {
    const t = tracks[i]
    if (!t || removing.includes(t._k)) return
    haptic('light')
    setRemoving(r => [...r, t._k])
    setTimeout(() => {
      const rawIds = pl.trackIds.slice(); rawIds.splice(t._i, 1)
      const nextTracks = tracks.filter(x => x._k !== t._k).map(x => ({ ...x, _i: x._i > t._i ? x._i - 1 : x._i }))
      commit(rawIds, nextTracks)
      setRemoving(r => r.filter(k => k !== t._k))
    }, REMOVE_MS)
  }

  // Move the resolved track at display index `from` to `to`. The resolved tracks own a
  // set of raw slots (their `_i`); reordering re-assigns their ids across those SAME
  // slots in the new order, so any unresolved id keeps its absolute position.
  const reorderTo = (from, to) => {
    if (from === to || from == null || to == null) return
    const slots = tracks.map(t => t._i)
    const next = tracks.slice()
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    const rawIds = pl.trackIds.slice()
    const nextTracks = next.map((t, k) => {
      rawIds[slots[k]] = t.id
      return { ...t, _i: slots[k] } // _k stays, so the row keeps its identity across the move
    })
    commit(rawIds, nextTracks)
  }

  // Drag reorder, PearList-style: the grip captures the pointer (touch-action:none in CSS
  // stops the page scrolling under the finger). The lifted row follows the finger; the
  // other rows slide by one to open a gap, and a highlight marks where it will land. The
  // list keeps its DOM order and moves rows with transforms, so nothing remounts mid-drag.
  const dragStart = (i) => (e) => {
    const li = e.currentTarget.closest('li')
    const h = li?.offsetHeight || 64
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
    haptic('medium')
    setDrag({ from: i, dy: 0, insertAt: i, rowH: h, y0: e.clientY })
  }
  const dragMove = (e) => {
    setDrag(d => {
      if (!d) return d
      const dy = e.clientY - d.y0
      const insertAt = Math.max(0, Math.min(tracks.length - 1, d.from + Math.round(dy / d.rowH)))
      if (insertAt !== d.insertAt) { try { haptic('light') } catch {} }
      return { ...d, dy, insertAt }
    })
  }
  const dragEnd = () => {
    setDrag(d => { if (d) reorderTo(d.from, d.insertAt); return null })
  }

  // Where does row `i` sit right now (its transform), given a live drag?
  const rowShift = (i) => {
    if (!drag) return 0
    if (i === drag.from) return drag.dy // the lifted row follows the finger
    if (drag.from < drag.insertAt && i > drag.from && i <= drag.insertAt) return -drag.rowH
    if (drag.from > drag.insertAt && i >= drag.insertAt && i < drag.from) return drag.rowH
    return 0
  }

  const saveName = () => {
    const n = nm.trim()
    if (n && n !== title) { setPl(p => ({ ...p, name: n })); onRename(id, n) }
  }
  const toggleEdit = () => {
    haptic('light')
    if (editing) saveName() // leaving Edit: commit the name (unmount won't fire onBlur)
    else setNm(title)
    setEditing(e => !e)
  }

  return (
    <div className='app'>
      <Back onClick={onBack} />
      {err && <div className='error'>{err}</div>}

      <div className='plhead'>
        <div className='pltitlerow'>
          {editing && !server
            ? (
              <input
                className='plname' autoFocus value={nm} aria-label='Playlist name'
                onChange={e => setNm(e.target.value)}
                onBlur={saveName}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }}
              />
              )
            : <h1>{title}</h1>}
          {pl && !server && (
            <div className='plheadacts'>
              <button
                className={'plicon' + (editing ? ' on' : '')}
                aria-label={editing ? 'Done editing' : 'Edit playlist'}
                onClick={toggleEdit}
              >
                <PencilSimple size={20} weight={editing ? 'fill' : 'regular'} />
              </button>
              <button className='plicon del' aria-label='Delete playlist' onClick={onDelete}>
                <Trash size={20} weight='regular' />
              </button>
            </div>
          )}
        </div>
        <p className='muted sm'>
          {tracks.length} track{tracks.length === 1 ? '' : 's'}
          {server && sourceName ? ` · on ${sourceName}` : ''}
        </p>
      </div>

      {tracks.length > 0 && (
        <Actions
          onPlay={() => onPlayAll(tracks)}
          onShuffle={() => onPlayAll(tracks, { shuffled: true })}
          onQueue={() => onQueue(tracks)}
        />
      )}

      {!pl && !err && <SkeletonRows />}

      {pl && (tracks.length === 0
        ? (
          <div className='blank'>
            <PlaylistIcon size={40} weight='thin' />
            <h2>This playlist is empty</h2>
            <p className='muted sm'>
              {server
                ? 'This playlist has no tracks we can play from this source.'
                : 'Add tracks, albums or artists to it from their ⋯ menu anywhere in the app.'}
            </p>
          </div>
          )
        : editing
          ? (
            <ul className='tracks editing' style={drag ? { '--rowh': drag.rowH + 'px' } : undefined}>
              {drag && (
                <li className='drophl' aria-hidden style={{ top: drag.insertAt * drag.rowH + 'px', height: drag.rowH + 'px' }} />
              )}
              {tracks.map((t, i) => {
                const lifted = drag && i === drag.from
                const gone = removing.includes(t._k)
                return (
                  <li
                    key={t._k}
                    className={'editrow' + (lifted ? ' lifted' : '') + (gone ? ' removing' : '')}
                    // A removing row hands all styling to the .removing class (its inline
                    // transition would otherwise block the fade); everyone else gets the
                    // live drag transform.
                    style={gone
                      ? undefined
                      : {
                          transform: `translateY(${rowShift(i)}px)` + (lifted ? ' scale(1.02)' : ''),
                          transition: lifted ? 'none' : 'transform 180ms cubic-bezier(0.2,0,0,1)',
                          zIndex: lifted ? 3 : 1
                        }}
                  >
                    <button
                      className='plgrip' aria-label='Drag to reorder'
                      onPointerDown={dragStart(i)} onPointerMove={dragMove}
                      onPointerUp={dragEnd} onPointerCancel={dragEnd}
                    >
                      <DotsSixVertical size={20} weight='bold' />
                    </button>
                    <div className='meta'>
                      <div className='t'>{t.title}</div>
                      <div className='muted sm sub'>{[t.artist, t.album].filter(Boolean).join(' · ')}</div>
                    </div>
                    <button className='rm' aria-label='Remove from playlist' onClick={() => removeAt(i)}>
                      <X size={17} weight='bold' />
                    </button>
                  </li>
                )
              })}
            </ul>
            )
          : (
            <ul className='tracks'>
              {tracks.map((t, i) => (
                <Row
                  key={t._k ?? i} t={t} on={now?.trackId === t.id}
                  onPlay={() => onPlay(tracks, t)} art
                />
              ))}
            </ul>
            ))}
    </div>
  )
}

function Row ({ t, on, onPlay, onLong, showTrackNo, art, fav, onFav, count }) {
  const press = usePress(
    () => onPlay(t),
    onLong && (() => onLong({ type: 'track', track: t, name: t.title }))
  )
  return (
    <li className={on ? 'on' : ''} {...press}>
      {showTrackNo && <span className='muted sm no'>{t.track ?? ''}</span>}
      {art && <Cover src={t.art} sm />}
      <div className='meta'>
        <div className='t'>{t.title}</div>
        <div className='muted sm sub'>
          {t.artist
            ? [t.artist, t.album].filter(Boolean).join(' · ')
            : `${(t.size / 1048576).toFixed(1)} MB`}
        </div>
      </div>
      {count != null
        ? <span className='muted sm plays'>{count} play{count === 1 ? '' : 's'}</span>
        : <span className='muted sm dur'>{t.durationMs ? fmt(t.durationMs) : ''}</span>}
      {onFav && (
        // The heart lives on the row but must not play it. Stop the press at
        // pointerdown (usePress is pointer-based) AND the click.
        <button
          className={'favbtn' + (fav ? ' on' : '')}
          aria-label={fav ? 'Remove from favorites' : 'Add to favorites'}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onFav(t) }}
        >
          <Heart size={18} weight={fav ? 'fill' : 'regular'} />
        </button>
      )}
    </li>
  )
}

// --- now playing -------------------------------------------------------------

// ONE player, two shapes.
//
// Mini and full used to be separate components, swapped on a flag - which is why
// the change SNAPPED: React tore one subtree down and built another, so there was
// nothing for the browser to animate between. Now it is a single element whose
// extra half grows and fades, and the dock (which measures itself) carries the
// content padding along with it.
function Player ({
  now, status, expanded, skin, shuffle, repeat, onShuffle, onRepeat, onExpand, onCollapse,
  onViewArt, onQueue, onStop, queueItems, queueIndex, onJump, sleep, onSleep
}) {
  const dur = status?.durationMs || now.durationMs || 0
  const pos = status?.positionMs || 0
  const pct = dur ? Math.min(100, (pos / dur) * 100) : 0
  const qlen = status?.queueLength ?? now.queueLength ?? 0

  // The classic skin only re-faces the EXPANDED player - the mini bar stays the same compact
  // control, so collapsing always lands somewhere familiar. It is a distinct tree (not a
  // restyle of the modern expando), so the grow/shrink tween does not carry across the swap -
  // acceptable for a skin the user deliberately switches to.
  if (expanded && skin === 'classic') {
    return (
      <div className='player open retroplayer'>
        <RetroPlayer
          now={now} status={status} shuffle={shuffle} repeat={repeat}
          onShuffle={onShuffle} onRepeat={onRepeat} onStop={onStop} onViewArt={onViewArt}
          onCollapse={onCollapse} sleep={sleep} onSleep={onSleep}
          items={queueItems} index={queueIndex} onJump={onJump}
        />
      </div>
    )
  }

  // Classic + collapsed = "windowshade": the whole player squashed to a thin metal strip
  // (tiny LCD, scrolling title, mini spectrum, play/pause), so collapsing keeps the retro
  // illusion instead of dropping back to the modern amber bar. Tap it to expand.
  if (!expanded && skin === 'classic') {
    return (
      <div className='player mini retromini' onClick={onExpand}>
        <RetroMini now={now} status={status} />
      </div>
    )
  }

  // Tap anywhere on the bar to seek. The seek goes out over P2P as a byte-range
  // request, which is why range support had to be right from day one.
  const scrub = (e) => {
    if (!dur) return
    const r = e.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
    call('seekTo', { ms: Math.round(ratio * dur) })
  }

  return (
    <div
      className={'player' + (expanded ? ' open' : ' mini')}
      onClick={expanded ? undefined : onExpand}
    >
      <button className='grip' onClick={onCollapse} aria-label='Collapse player' tabIndex={expanded ? 0 : -1}>
        <CaretDown size={16} weight='bold' />
      </button>

      <div className='row1'>
        <div className='tapart' onClick={expanded ? onViewArt : undefined}>
          <Cover src={now.art} sm />
        </div>
        <div className='meta'>
          <div className='t'>{now.title}</div>
          <div className='muted sm sub'>
            {status?.buffering
              ? 'buffering…'
              : [now.artist, now.album].filter(Boolean).join(' · ') || ' '}
          </div>
        </div>

        {expanded
          ? (
            <button
              className='icon close'
              onClick={() => { haptic('light'); onStop() }}
              aria-label='Stop'
            >
              <X size={18} weight='bold' />
            </button>
            )
          : (
            // No queue pill here. The count lives on the Queue TAB, two centimetres
            // below this row - a second copy of the same number, inches away, is
            // noise, and it stole space from the one control people hit without
            // looking. stopPropagation, or play/pause would also expand the player.
            <button
              className='icon big'
              onClick={(e) => { e.stopPropagation(); haptic('light'); call('toggle') }}
              aria-label='Play/pause'
            >
              {status?.playing ? <Pause size={22} weight='fill' /> : <Play size={22} weight='fill' />}
            </button>
            )}
      </div>

      {/* Collapsed, this is the whole progress display: a hairline. */}
      <div className='hairline'><div className='fill' style={{ width: pct + '%' }} /></div>

      {/* ...and this is the half that grows. max-height rather than height, so it
          does not need a magic number that rots the first time a row is added. */}
      <div className='expando'>
        <div className='bar' onClick={scrub}>
          <div className='fill' style={{ width: pct + '%' }} />
        </div>
        <div className='times muted sm'>
          <span>{fmt(pos)}</span>
          {/* The LIVE queue length, from status - not the one captured when this
              track started. Add an album to the queue and the count has to move,
              or the only feedback that anything happened is a toast that has
              already faded. */}
          {qlen > 1
            ? (
              <button className='qbtn' onClick={onQueue}>
                {(status?.index ?? now.index) + 1} / {qlen} <ListPlus size={14} weight='bold' />
              </button>
              )
            : <span />}
          <span>{dur ? fmt(dur) : '--:--'}</span>
        </div>

        <div className='transport'>
          <button className={'icon mode' + (shuffle ? ' on' : '')} onClick={onShuffle} aria-label='Shuffle'>
            <Shuffle size={19} weight={shuffle ? 'fill' : 'regular'} />
          </button>
          <button className='icon' onClick={() => { haptic('light'); call('prev') }} aria-label='Previous'>
            <SkipBack size={22} weight='fill' />
          </button>
          <button className='icon big' onClick={() => { haptic('light'); call('toggle') }} aria-label='Play/pause'>
            {status?.playing ? <Pause size={26} weight='fill' /> : <Play size={26} weight='fill' />}
          </button>
          <button className='icon' onClick={() => { haptic('light'); call('next') }} aria-label='Next'>
            <SkipForward size={22} weight='fill' />
          </button>
          <button className={'icon mode' + (repeat ? ' on' : '')} onClick={onRepeat} aria-label='Repeat'>
            {repeat === 1
              ? <RepeatOnce size={19} weight='fill' />
              : <Repeat size={19} weight={repeat === 2 ? 'fill' : 'regular'} />}
          </button>
        </div>

        <div className='transport sub-transport'>
          <button className='icon' onClick={() => call('seekBy', { seconds: -15 })} aria-label='Back 15 seconds'>
            <ArrowCounterClockwise size={15} /> 15
          </button>
          <button
            className={'icon sleepbtn' + (sleep?.active ? ' on' : '')}
            onClick={() => { haptic('light'); onSleep() }}
            aria-label='Sleep timer'
          >
            <Moon size={16} weight={sleep?.active ? 'fill' : 'regular'} />
            {sleep?.active && <SleepCountdown sleep={sleep} />}
          </button>
          <button className='icon' onClick={() => call('seekBy', { seconds: 15 })} aria-label='Forward 15 seconds'>
            15 <ArrowClockwise size={15} />
          </button>
        </div>
      </div>
    </div>
  )
}

// The little countdown next to the moon. The AUTHORITATIVE timer runs in the shell (so it
// survives the screen going off); this is display-only, ticking against the deadline the
// shell handed us. If the WebView was frozen while backgrounded it just resumes from the
// real remaining time when it wakes.
function SleepCountdown ({ sleep }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [])
  if (sleep.endOfTrack) return <span className='sleeplabel'>end</span>
  const s = Math.max(0, Math.round(((sleep.deadline || 0) - Date.now()) / 1000))
  return <span className='sleeplabel'>{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</span>
}

// Pick how long until playback fades out and pauses. The choice goes to the shell
// (call('sleep', ...)), which owns the countdown; this sheet only shows what is armed.
function SleepSheet ({ sleep, onClose, onPick }) {
  const cur = sleep?.active ? sleep.minutes : null
  return (
    <div className='sheetwrap' onClick={onClose}>
      <div className='sheet' onClick={e => e.stopPropagation()}>
        <h1>Sleep timer</h1>
        <p className='muted sm'>Fade out and pause after…</p>
        <div className='acts'>
          {[15, 30, 45, 60].map(m => (
            <button
              key={m}
              className={'wide' + (cur === m ? ' on' : '')}
              onClick={() => onPick({ minutes: m })}
            >
              <Moon size={16} weight='regular' /> {m} minutes
            </button>
          ))}
          <button
            className={'wide' + (sleep?.endOfTrack ? ' on' : '')}
            onClick={() => onPick({ endOfTrack: true })}
          >
            <MusicNotes size={16} weight='regular' /> End of track
          </button>
          {sleep?.active && (
            <button className='wide' onClick={() => onPick({ off: true })}>
              Turn off timer
            </button>
          )}
          <button className='wide' onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// The classic skin's player face: a retro amplifier window - LCD time, a scrolling title,
// a live spectrum, chunky transport. It reads the SAME now/status and drives the SAME controls
// as the modern player (call('toggle'|'prev'|'next'|'seekTo'), onShuffle/onRepeat/onStop), so it
// is purely a re-facing. An original look inspired by the classic player, not anyone's artwork.
function RetroPlayer ({ now, status, shuffle, repeat, onShuffle, onRepeat, onStop, onViewArt, onCollapse, sleep, onSleep, items = [], index = 0, onJump }) {
  const dur = status?.durationMs || now.durationMs || 0
  const pos = status?.positionMs || 0
  const pct = dur ? Math.min(100, (pos / dur) * 100) : 0
  const playing = !!status?.playing
  const idx = (status?.index ?? now.index ?? 0) + 1
  const s = Math.floor(pos / 1000)
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')

  // The ZZZ toggle's face: ZZZ idle, whole minutes left when a timed sleep is armed, END
  // for end-of-track. A 1s tick refreshes the minute readout while a timed one runs (the
  // status ticks would already re-render mid-song, but this keeps it live while paused too).
  const [, sleepTick] = useState(0)
  const sleepTimed = sleep?.active && !sleep.endOfTrack
  useEffect(() => {
    if (!sleepTimed) return
    const id = setInterval(() => sleepTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [sleepTimed])
  const sleepLabel = !sleep?.active
    ? 'ZZZ'
    : sleep.endOfTrack
      ? 'END'
      : Math.max(0, Math.ceil(((sleep.deadline || 0) - Date.now()) / 60000)) + 'm'

  const vizRef = useRef(null)
  const playRef = useRef(playing); playRef.current = playing

  // Keep the current row in view in the docked playlist (block:'nearest' scrolls only the
  // list, not the whole sheet). Re-runs when the track or the list changes.
  const curRef = useRef(null)
  useEffect(() => { curRef.current?.scrollIntoView({ block: 'nearest' }) }, [index, items.length])

  // The spectrum. Simulated (playback runs through native ExoPlayer, not Web Audio, so the
  // WebView cannot FFT the real signal without a native Visualizer hook - a later add). Bass-
  // heavy, jittery bars with falling peak caps; frozen and decaying while paused; a static
  // silhouette under prefers-reduced-motion (no animation loop at all).
  useEffect(() => {
    const c = vizRef.current
    if (!c) return
    const x = c.getContext('2d')
    const W = c.width, H = c.height, N = 19, bw = W / N
    const vals = new Array(N).fill(0)
    const peaks = new Array(N).fill(0)
    const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
    let raf = 0, t = 0

    const paint = () => {
      x.clearRect(0, 0, W, H)
      for (let i = 0; i < N; i++) {
        const bh = vals[i]
        for (let y = 0; y < bh; y += 3) {
          const f = y / H
          x.fillStyle = f > 0.75 ? '#ff5a5a' : f > 0.5 ? '#e8e04a' : '#3fe08a'
          x.fillRect(i * bw + 1, H - y - 3, bw - 2, 2)
        }
        x.fillStyle = '#bafcd6'
        x.fillRect(i * bw + 1, H - peaks[i] - 1, bw - 2, 2)
      }
    }

    if (reduce) {
      for (let i = 0; i < N; i++) vals[i] = peaks[i] = (Math.sin(i * 0.7) * 0.5 + 0.5) * (1 - i / N * 0.6) * H * 0.6
      paint()
      return
    }

    const tick = () => {
      t += 0.05
      for (let i = 0; i < N; i++) {
        const target = playRef.current
          ? Math.max(0, (Math.sin(t + i * 0.7) * 0.5 + 0.5) * (1 - i / N * 0.6) * H * (0.5 + Math.random() * 0.6))
          : 0
        vals[i] += (target - vals[i]) * 0.35
        peaks[i] = Math.max(peaks[i] - 0.8, vals[i])
      }
      paint()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const scrub = (e) => {
    if (!dur) return
    const r = e.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
    call('seekTo', { ms: Math.round(ratio * dur) })
  }

  return (
    <div className='retro'>
      <div className='rt-win'>
        {/* Tapping anywhere on the titlebar collapses to the shade strip - the whole banner is
            the grab bar, not just the arrow. The buttons stopPropagation so each does its own thing. */}
        <div className='rt-title' onClick={() => { haptic('light'); onCollapse() }}>
          <span className='rt-dots'><i /><i /><i /></span>
          <span className='rt-wm'>PEARTUNE</span>
          <span className='rt-tbtns'>
            {/* The titlebar buttons live where Winamp's did: shade (collapse to the strip) + close (stop). */}
            <button className='rt-x' onClick={(e) => { e.stopPropagation(); haptic('light'); onCollapse() }} aria-label='Collapse player'>▾</button>
            <button className='rt-x' onClick={(e) => { e.stopPropagation(); haptic('light'); onStop() }} aria-label='Stop'>×</button>
          </span>
        </div>

        <div className='rt-body'>
          <div className='rt-left'>
            <div className='rt-lcd rt-time'>{mm}<span className={playing ? 'rt-col' : 'rt-col off'}>:</span>{ss}</div>
            <div className='rt-kbps'><span>kbps <b>—</b></span><span>kHz <b>44</b></span></div>
            <div className='rt-stereo'><span>mono</span><span className='on'>stereo</span></div>
          </div>

          <div className='rt-right'>
            <div className='rt-marq'>
              {/* Two identical copies back-to-back + a -50% scroll = a seamless marquee with the
                  title always on screen somewhere (a single copy leaves the strip blank half the time). */}
              <div className='rt-track'>
                <span>{idx}. {now.title}{now.artist ? ' — ' + now.artist : ''} &nbsp;★&nbsp; PearTune &nbsp;★&nbsp; </span>
                <span>{idx}. {now.title}{now.artist ? ' — ' + now.artist : ''} &nbsp;★&nbsp; PearTune &nbsp;★&nbsp; </span>
              </div>
            </div>
            <canvas ref={vizRef} className='rt-viz' width='300' height='40' onClick={onViewArt} />
          </div>

          <div className='rt-seek' onClick={scrub}>
            <div className='rt-prog' style={{ width: pct + '%' }} />
            <div className='rt-knob' style={{ left: pct + '%' }} />
          </div>

          <div className='rt-transport'>
            <button className='rt-btn' onClick={() => { haptic('light'); call('prev') }} aria-label='Previous'>⏮</button>
            <button className={'rt-btn rt-play' + (playing ? ' lit' : '')} onClick={() => { haptic('light'); call('toggle') }} aria-label='Play/pause'>{playing ? '❚❚' : '▶'}</button>
            <button className='rt-btn' onClick={() => { haptic('light'); call('next') }} aria-label='Next'>⏭</button>
            <span className='rt-sp' />
            <button className={'rt-btn rt-tg' + (shuffle ? ' lit' : '')} onClick={onShuffle}>SHUF</button>
            <button className={'rt-btn rt-tg' + (repeat ? ' lit' : '')} onClick={onRepeat}>{repeat === 1 ? 'REP1' : 'REP'}</button>
            <button className={'rt-btn rt-tg' + (sleep?.active ? ' lit' : '')} onClick={() => { haptic('light'); onSleep() }} aria-label='Sleep timer'>{sleepLabel}</button>
          </div>
        </div>
      </div>

      {/* The docked "Playlist" window, faithful to Winamp's separate PL editor sitting under the
          main window. Reads the SAME up-next list as the Queue tab (loaded when the classic player
          expands); tap a row to jump. Reorder/remove stay on the Queue tab - this is a compact
          jukebox list, not the editor. */}
      <div className='rt-plwin'>
        <div className='rt-pltitle'>
          <span className='rt-wm'>PLAYLIST</span>
          <span className='rt-plcount'>{items.length} {items.length === 1 ? 'track' : 'tracks'}</span>
        </div>
        <ul className='rt-pl'>
          {items.map((t, i) => (
            <li
              key={`${t.id}:${i}`}
              ref={i === index ? curRef : null}
              className={i === index ? 'cur' : (i < index ? 'played' : '')}
              onClick={() => { haptic('light'); onJump && onJump(i) }}
            >
              <span className='rt-pln'>{i + 1}</span>
              <span className='rt-plt'>{t.title}{t.artist ? ' — ' + t.artist : ''}</span>
              <span className='rt-pld'>{t.durationMs ? fmt(t.durationMs) : ''}</span>
            </li>
          ))}
          {!items.length && <li className='rt-plempty'>nothing queued</li>}
        </ul>
      </div>
    </div>
  )
}

// The classic skin's collapsed face: "windowshade" - the player as a thin metal strip.
// Tiny LCD time, a scrolling title, a mini spectrum, and play/pause. Tapping the strip (handled
// by the parent) expands to the full RetroPlayer; the play button stops propagation so it does
// not also expand. Reads the same now/status as everything else.
function RetroMini ({ now, status }) {
  const dur = status?.durationMs || now.durationMs || 0
  const pos = status?.positionMs || 0
  const pct = dur ? Math.min(100, (pos / dur) * 100) : 0
  const playing = !!status?.playing
  const idx = (status?.index ?? now.index ?? 0) + 1
  const s = Math.floor(pos / 1000)
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')

  const vizRef = useRef(null)
  const playRef = useRef(playing); playRef.current = playing
  useEffect(() => {
    const c = vizRef.current
    if (!c) return
    const x = c.getContext('2d')
    const W = c.width, H = c.height, N = 13, bw = W / N
    const vals = new Array(N).fill(0)
    const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
    let raf = 0, t = 0
    const paint = () => {
      x.clearRect(0, 0, W, H)
      for (let i = 0; i < N; i++) {
        for (let y = 0; y < vals[i]; y += 2) {
          const f = y / H
          x.fillStyle = f > 0.7 ? '#ff5a5a' : f > 0.45 ? '#e8e04a' : '#3fe08a'
          x.fillRect(i * bw + 1, H - y - 2, bw - 1.5, 1.5)
        }
      }
    }
    if (reduce) { for (let i = 0; i < N; i++) vals[i] = (Math.sin(i * 0.7) * 0.5 + 0.5) * (1 - i / N * 0.6) * H * 0.6; paint(); return }
    const tick = () => {
      t += 0.06
      for (let i = 0; i < N; i++) {
        const target = playRef.current ? Math.max(0, (Math.sin(t + i * 0.7) * 0.5 + 0.5) * (1 - i / N * 0.6) * H * (0.5 + Math.random() * 0.6)) : 0
        vals[i] += (target - vals[i]) * 0.35
      }
      paint()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className='retro rm'>
      <div className='rm-win'>
        <div className='rt-lcd rm-time'>{mm}<span className={playing ? 'rt-col' : 'rt-col off'}>:</span>{ss}</div>
        <div className='rm-marq'>
          <div className='rt-track'>
            <span>{idx}. {now.title}{now.artist ? ' — ' + now.artist : ''} &nbsp;★&nbsp; </span>
            <span>{idx}. {now.title}{now.artist ? ' — ' + now.artist : ''} &nbsp;★&nbsp; </span>
          </div>
        </div>
        <canvas ref={vizRef} className='rm-viz' width='120' height='20' />
        <button
          className={'rt-btn rm-pp' + (playing ? ' lit' : '')}
          onClick={(e) => { e.stopPropagation(); haptic('light'); call('toggle') }}
          aria-label='Play/pause'
        >{playing ? '❚❚' : '▶'}</button>
        <div className='rm-prog' style={{ width: pct + '%' }} />
      </div>
    </div>
  )
}

function fmt (ms) {
  if (!ms && ms !== 0) return '--:--'
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// Coarse time-until, for the guest-pass banner ("5 min", "2 hr", "3 days"). ROUND, not
// floor: a 2-hour pass should read "2 hr", not "1 hr" for its whole first hour (floor) -
// and rounding a 25-hour pass to "1 day" beats ceil's misleading "2 days".
function untilCoarse (ts) {
  const s = Math.floor((ts - Date.now()) / 1000)
  if (s < 60) return 'under a minute'
  if (s < 3600) return Math.round(s / 60) + ' min'
  if (s < 86400) return Math.round(s / 3600) + ' hr'
  const d = Math.round(s / 86400)
  return d + (d === 1 ? ' day' : ' days')
}

// A slim strip in the dock telling a GUEST device its access is time-limited. Its own
// ticker keeps the countdown live between reconnects (loadIdentity refreshes expiresAt
// on every connect, so an operator's extend/clear reflects here too).
function GuestBanner ({ expiresAt }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 30000)
    return () => clearInterval(t)
  }, [])
  return <div className='guestbar'>Guest access · expires in {untilCoarse(expiresAt)}</div>
}

// Human bytes: MB up to a gig, then GB. Enough precision to watch a cache fill.
function fmtBytes (n) {
  if (!n) return '0 MB'
  const mb = n / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb / 1024 >= 10 ? 0 : 1)} GB` : `${Math.round(mb)} MB`
}

// --- settings ----------------------------------------------------------------

const QUALITIES = [
  { value: 'auto', label: 'Auto', desc: 'Full quality on Wi-Fi, a smaller stream on cellular' },
  { value: 'original', label: 'Original', desc: 'Always the original file — best quality, ~1 GB an album' },
  { value: '320', label: '320 kbps', desc: 'High quality, less data everywhere' },
  { value: '192', label: '192 kbps', desc: 'Good quality, saves more data' },
  { value: '128', label: '128 kbps', desc: 'Lowest quality, least data' }
]

const CACHE_CAPS = [
  { value: 512 * 1024 * 1024, label: '512 MB' },
  { value: 1024 * 1024 * 1024, label: '1 GB' },
  { value: 2 * 1024 * 1024 * 1024, label: '2 GB' },
  { value: 0, label: 'Unlimited', desc: 'Keep every played track' }
]

// A vertical radio-style picker: every choice visible (no horizontal scroll), each
// with a name + optional one-line descriptor, a check on the selected one.
function OptionList ({ options, value, onChange }) {
  return (
    <div className='optlist'>
      {options.map(o => (
        <button
          key={String(o.value)} className={'opt' + (value === o.value ? ' on' : '')}
          aria-pressed={value === o.value}
          onClick={() => { haptic('light'); onChange(o.value) }}
        >
          <span className='opt-main'>
            <span className='opt-name'>{o.label}</span>
            {o.desc && <span className='opt-desc'>{o.desc}</span>}
          </span>
          {value === o.value && <CheckCircle size={19} weight='fill' />}
        </button>
      ))}
    </div>
  )
}

// A picked file as a data URL, via FileReader (the PearCircle path - a plain WebView
// <input type=file>, no native picker/crop).
function readFileDataUrl (file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => reject(r.error || new Error('read failed'))
    r.readAsDataURL(file)
  })
}

// Center-crop the image to a square and JPEG-compress in a canvas, stepping quality
// down until it is comfortably small. Returns the base64 (no data: prefix) - the host
// stores the raw JPEG and serves it back, so no image library is needed either side.
function compressToAvatarB64 (dataUrl, size = 256) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = c.height = size
      const sw = img.naturalWidth || img.width
      const sh = img.naturalHeight || img.height
      const crop = Math.min(sw, sh)
      c.getContext('2d').drawImage(img, (sw - crop) / 2, (sh - crop) / 2, crop, crop, 0, 0, size, size)
      let out = c.toDataURL('image/jpeg', 0.85)
      for (const q of [0.85, 0.7, 0.55, 0.4]) {
        out = c.toDataURL('image/jpeg', q)
        if (out.length - out.indexOf(',') - 1 <= 300000) break // ~300KB base64 ceiling
      }
      resolve(out.slice(out.indexOf(',') + 1))
    }
    img.onerror = () => reject(new Error('decode failed'))
    img.src = dataUrl
  })
}

function Settings ({ state, merged, themePref, onTheme, onUnpair, ident, onSaveIdentity, onQuality, skin, onSkin, onSwitchHost, onRemoveHost, onAddLibrary }) {
  const quality = state.settings?.streamQuality || 'auto'
  const [copied, setCopied] = useState(false)
  const [dev, setDev] = useState(null)
  const [usr, setUsr] = useState(null)
  const [saving, setSaving] = useState(false)
  const [cache, setCache] = useState(null) // { bytes, count, cap }

  useEffect(() => { call('cacheStats').then(setCache).catch(() => {}) }, [])
  const cap = cache?.cap ?? (state.settings?.cacheCap ?? 0)
  const setCap = async (bytes) => { haptic('light'); try { setCache(await call('setCacheCap', { bytes })) } catch {} }
  const clearCache = async () => { haptic('warn'); try { setCache(await call('clearCache')) } catch {} }
  const [cellular, setCellular] = useState(state.settings?.downloadCellular ?? false)
  const toggleCellular = async () => { const on = !cellular; haptic('light'); setCellular(on); try { await call('setDownloadCellular', { on }) } catch {} }

  // null means "not edited yet" - fall back to what the host told us. Using '' as
  // the initial value instead would silently clear a name the moment identity
  // loaded a beat later than the first render.
  const deviceName = dev ?? ident?.deviceName ?? ''
  const userName = usr ?? ident?.userName ?? ''
  const dirty =
    (dev !== null && dev !== (ident?.deviceName ?? '')) ||
    (usr !== null && usr !== (ident?.userName ?? ''))

  const save = async () => {
    setSaving(true)
    try {
      await onSaveIdentity({ deviceName: deviceName.trim(), userName: userName.trim() })
      setDev(null)
      setUsr(null)
    } catch (e) {
      // The worklet already toasts; nothing to add here.
    } finally {
      setSaving(false)
    }
  }

  const copyKey = () => {
    copyText(state.deviceKeyZ32 || state.deviceKey)
    haptic('success')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const [open, setOpen] = useState(null)
  const toggle = (id) => setOpen(o => (o === id ? null : id))

  // The avatar shown in the profile header: the last-picked one (optimistic) else what
  // the worklet persisted. `avatar` is base64 JPEG (no data: prefix).
  const [avatarLocal, setAvatarLocal] = useState(null)
  const avatar = avatarLocal ?? state.settings?.avatar ?? ''
  const initial = (userName || deviceName || '?').trim().charAt(0).toUpperCase() || '?'
  const fileRef = useRef(null)
  // Plain WebView file picker (opens the gallery) + a canvas compress - the PearCircle
  // path, no native crop. The picked photo shows at once and is pushed to the host.
  const onPickFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return
    haptic('light')
    try {
      const base64 = await compressToAvatarB64(await readFileDataUrl(file), 256)
      setAvatarLocal(base64)
      await call('setAvatar', { avatar: base64 }) // saves locally + pushes to the host
    } catch { haptic('warn') }
  }

  return (
    <div className='app'>
      <header><h1>Settings</h1></header>

      {/* Profile header - always visible, like the other apps. Your photo, your name,
          and this device's name; it is what the server operator sees on their dashboard. */}
      <div className='profile'>
        <button className='profile-av' onClick={() => fileRef.current?.click()} aria-label='Change your photo'>
          {avatar
            ? <img src={avatar.startsWith('data:') ? avatar : 'data:image/jpeg;base64,' + avatar} alt='' />
            : <span className='profile-mono'>{initial}</span>}
          <span className='profile-cam' aria-hidden='true'><Camera size={13} weight='fill' /></span>
        </button>
        <input ref={fileRef} type='file' accept='image/*' style={{ display: 'none' }} onChange={onPickFile} />
        <div className='profile-fields'>
          <input
            className='profile-name' value={userName} onChange={e => setUsr(e.target.value)}
            placeholder='Your name' maxLength={64} disabled={!state.connected} aria-label='Your name'
          />
          <input
            className='profile-dev' value={deviceName} onChange={e => setDev(e.target.value)}
            placeholder='This device' maxLength={64} disabled={!state.connected} aria-label='Device name'
          />
        </div>
        {dirty && (
          <button className='profile-save' onClick={save} disabled={saving || !state.connected}>
            {saving ? '…' : 'Save'}
          </button>
        )}
      </div>
      {/* A claim grants nothing until the operator confirms it - say so honestly. */}
      {ident?.userName && (
        <div className='profile-note desc'>
          {ident.confirmed
            ? `Your server has confirmed this device belongs to ${ident.userName}.`
            : ident.belongsTo
              ? `Your server still has this device down as ${ident.belongsTo}. It is waiting to confirm you are ${ident.userName} — only the person running it can move a device to someone else.`
              : `Waiting for your server to confirm you are ${ident.userName}. Until then this is only a label.`}
        </div>
      )}
      {ident && ident.supported === false && (
        <div className='profile-note desc'>
          Your server is running an older PearTune and cannot be told about names yet.
          Update it, or re-pair to set the device name.
        </div>
      )}

      <div className='settings-acc'>
        <Section id='appearance' title='Appearance' Icon={Palette} open={open === 'appearance'} onToggle={toggle}>
          <div className='label'>Theme</div>
          <div className='seg'>
            {[['dark', 'Dark'], ['light', 'Light'], ['system', 'System']].map(([k, l]) => (
              <button
                key={k} className={themePref === k ? 'on' : ''}
                aria-pressed={themePref === k}
                onClick={() => { haptic('light'); onTheme(k) }}
              >{l}</button>
            ))}
          </div>
          {/* Player skin. Classic is a retro amplifier-style face on the full-screen player -
              LCD readout, scrolling title, a live spectrum. The library stays as it is. */}
          <div className='label' style={{ marginTop: '.7rem' }}>Player skin</div>
          <div className='seg'>
            {[['modern', 'Modern'], ['classic', 'Classic']].map(([k, l]) => (
              <button
                key={k} className={skin === k ? 'on' : ''}
                aria-pressed={skin === k}
                onClick={() => onSkin(k)}
              >{l}</button>
            ))}
          </div>
        </Section>

        <Section id='quality' title='Streaming quality' Icon={SpeakerHigh} open={open === 'quality'} onToggle={toggle}>
          <OptionList options={QUALITIES} value={quality} onChange={onQuality} />
        </Section>

        <Section id='storage' title='Offline storage' Icon={DownloadSimple} open={open === 'storage'} onToggle={toggle}>
          <div className='desc'>
            Tracks you play are kept on this phone so they play again with no connection;
            the oldest clear out to stay under this size.
          </div>
          <div className='row'>
            <div><div className='label'>Using</div></div>
            <span className='val'>
              {fmtBytes(cache?.bytes || 0)}{cap ? ` / ${fmtBytes(cap)}` : ''}
              {cache?.count ? ` · ${cache.count} track${cache.count === 1 ? '' : 's'}` : ''}
            </span>
          </div>
          <div className='label' style={{ marginTop: '.5rem' }}>Keep up to</div>
          <OptionList options={CACHE_CAPS} value={cap} onChange={setCap} />
          <button
            className='wide'
            style={{ marginTop: '.5rem', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '.4rem' }}
            onClick={clearCache} disabled={!cache?.count}
          >
            <Trash size={16} weight='bold' /> Clear cache
          </button>
          <div className='row' style={{ marginTop: '.4rem' }}>
            <div>
              <div className='label'>Download over cellular</div>
              <div className='desc'>Off by default — a downloaded album can be hundreds of MB.</div>
            </div>
            <button className={'toggle' + (cellular ? ' on' : '')} role='switch' aria-checked={cellular} onClick={toggleCellular}>
              {cellular ? 'On' : 'Off'}
            </button>
          </div>
        </Section>

        <Section id='library' title={libsOf(state).length > 1 ? 'Libraries' : 'Library'} Icon={MusicNotesSimple} open={open === 'library'} onToggle={toggle}>
          {libsOf(state).map(h => {
            // In the MERGED view every paired library is part of the blend, so its status is whether
            // it's currently IN the blend (from merged.libraries) - which updates on a rebuild/revoke,
            // unlike the single active client's state.connected. Rows are informational here (the home
            // chips do the filtering); tap-to-switch stays only in single-host mode, where "active"
            // and state.connected are the right signals. `ml` present => merged mode.
            const ml = merged?.merged ? (merged.libraries || []).find(l => l.libraryId === h.libraryId) : null
            const online = ml ? ml.connected : (h.active && state.connected)
            const showDot = ml ? true : h.active // merged: every row has a status; single: only the active one
            const desc = ml
              ? (ml.connected ? 'In your blended library' : 'Offline — unreachable')
              : (h.active
                  ? (state.connected ? 'Active — connected' : 'Active — connecting…')
                  : 'Tap to switch to this library')
            const tappable = !ml && !h.active // only switch libraries in single-host mode
            return (
              <div
                className='row'
                key={h.hostKey}
                onClick={() => { if (tappable) onSwitchHost(h.hostKey) }}
                style={{ cursor: tappable ? 'pointer' : 'default' }}
              >
                <div>
                  <div className='label'>
                    {h.libraryName || 'Library'}
                    {showDot && (
                      <span className='val' style={{ color: online ? 'var(--color-primary)' : undefined, marginLeft: 8 }}>
                        {online ? '●' : '○'}
                      </span>
                    )}
                  </div>
                  <div className='desc'>{desc}</div>
                </div>
                <button className='rowremove' aria-label={'Remove ' + (h.libraryName || 'library')} onClick={(e) => { e.stopPropagation(); onRemoveHost(h) }}>
                  <Trash size={19} weight='regular' />
                </button>
              </div>
            )
          })}
          <div className='row'>
            <div>
              <div className='label'>Add a library</div>
              <div className='desc'>
                Pair this phone to another server. Switch between them here; your downloads and
                favorites are kept per library.
              </div>
            </div>
            <button className='primary' onClick={onAddLibrary}>Add</button>
          </div>
        </Section>

        <Section id='device' title='Device key' Icon={Key} open={open === 'device'} onToggle={toggle}>
          <div className='desc'>
            The key the server knows this phone by. It is the row to look for in the
            PearTune dashboard when deciding what to revoke.
          </div>
          <div className='key'>{state.deviceKeyZ32 || state.deviceKey}</div>
          <div className='btnrow'>
            <button onClick={copyKey}>
              <Copy size={15} /> {copied ? 'Copied' : 'Copy key'}
            </button>
          </div>
        </Section>
      </div>

      <div className='version'>v{APP_VERSION}</div>
    </div>
  )
}

// --- about -------------------------------------------------------------------

function About ({ onDonate }) {
  const [open, setOpen] = useState(null)
  const toggle = (id) => setOpen(o => (o === id ? null : id))

  return (
    <div className='app'>
      <div className='wordmark'>
        <div className='name'>Pear<span className='tune'>Tune</span></div>
        <div className='muted sm'>Your music. Your server. Anywhere.</div>
      </div>

      <Section id='how' title='How it works' Icon={Info} open={open === 'how'} onToggle={toggle}>
        <p>
          PearTune plays your music straight off the machine it already lives on -
          an Umbrel, a NAS, an old desktop - over an encrypted peer-to-peer
          connection. No port forwarding, no VPN, no dynamic DNS, no account, and
          no copy of your library in anyone's cloud.
        </p>
        <p>
          The server keeps the list of which devices are allowed in, and can cut one
          off in the middle of a song.
        </p>
        <div className='btnrow'>
          <button onClick={() => openUrl('https://pears.com/')}>Learn about P2P ↗</button>
        </div>
      </Section>

      {!isIOS() && (
        <Section id='support' title='Support development' Icon={Heart} open={open === 'support'} onToggle={toggle}>
          <p>PearTune is free and open source. If it brings you value, consider sending a little back.</p>
          <div className='btnrow'>
            <button className='primary' onClick={onDonate}>⚡ Bitcoin ⚡</button>
            <button onClick={() => openUrl(BUYMEACOFFEE_URL)}>$ USD $</button>
          </div>
        </Section>
      )}

      <Section id='btc' title='Learn about Bitcoin' Icon={CurrencyBtc} open={open === 'btc'} onToggle={toggle}>
        <p>
          New to Bitcoin? The Satoshi Nakamoto Institute has a free, concise crash
          course on how it works and why it matters.
        </p>
        <div className='btnrow'>
          <button onClick={() => openUrl('https://nakamotoinstitute.org/crash-course/')}>Bitcoin Crash Course ↗</button>
        </div>
      </Section>

      <Section id='oss' title='Open source' Icon={Code} open={open === 'oss'} onToggle={toggle}>
        <p>PearTune is open source under the MIT license. Read the code, file an issue, or contribute.</p>
        <div className='btnrow'>
          <button onClick={() => openUrl(GITHUB_URL)}>View on GitHub ↗</button>
        </div>
      </Section>

      <Section id='share' title='Share the app' Icon={ShareNetwork} open={open === 'share'} onToggle={toggle}>
        <p>
          Know someone with a music collection and no good way to reach it from
          their phone? Share PearTune.
        </p>
        <div className='btnrow'>
          <button onClick={() => call('shell:share', { title: 'PearTune', text: SHARE_TEXT }).catch(() => {})}>
            Share PearTune
          </button>
        </div>
      </Section>

      <Section id='contact' title='Contact' Icon={EnvelopeSimple} open={open === 'contact'} onToggle={toggle}>
        <div className='btnrow'>
          <button onClick={() => openUrl(CONTACT_URL)}>Email</button>
          <button onClick={() => openUrl(GITHUB_URL + '/issues')}>Issue</button>
        </div>
      </Section>

      <div className='version'>v{APP_VERSION}</div>
    </div>
  )
}

function Section ({ id, title, Icon, open, onToggle, children }) {
  return (
    <div className='card tight acc'>
      <button onClick={() => { haptic('light'); onToggle(id) }} aria-expanded={open}>
        <span className='accleft'>
          <Icon size={17} weight='regular' />
          {title}
        </span>
        <CaretRight size={15} weight='regular' className={'caret' + (open ? ' open' : '')} />
      </button>
      <div className={'body' + (open ? ' open' : '')}>
        <div className='inner'>{children}</div>
      </div>
    </div>
  )
}

// Lightning first (fast, cheap), on-chain for people who prefer it. The Bitcoin
// button never fires straight into a wallet: it opens this, so someone with no
// wallet installed is not dumped on an "unhandled URI" error.
function DonationSheet ({ onClose }) {
  const [hasWallet, setHasWallet] = useState(false)
  const [copied, setCopied] = useState(null)

  useEffect(() => {
    call('shell:canOpenURL', { url: 'lightning:test' })
      .then(r => setHasWallet(!!r?.can))
      .catch(() => {})
  }, [])

  const copy = (what, value) => {
    copyText(value)
    setCopied(what)
    setTimeout(() => setCopied(null), 1500)
  }

  return (
    <div className='sheetwrap' onClick={onClose}>
      <div className='sheet' onClick={e => e.stopPropagation()}>
        <h1>⚡ Bitcoin Lightning ⚡</h1>
        <p className='muted sm'>
          Support PearTune with Bitcoin over Lightning (fast and low-fee), or
          on-chain.
        </p>

        {hasWallet && (
          <button
            className='primary wide'
            onClick={() => { openUrl('lightning:' + LIGHTNING_ADDRESS); onClose() }}
          >
            Open in your Lightning wallet
          </button>
        )}

        <h2>Lightning address</h2>
        <div className='key'>{LIGHTNING_ADDRESS}</div>
        <div className='btnrow'>
          <button onClick={() => copy('ln', LIGHTNING_ADDRESS)}>{copied === 'ln' ? 'Copied' : 'Copy'}</button>
          <button onClick={() => openUrl(STRIKE_TIP_URL)}>Pay in a browser ↗</button>
        </div>

        <h2>On-chain Bitcoin</h2>
        <div className='key'>{BTC_ONCHAIN_ADDRESS}</div>
        <div className='btnrow'>
          <button onClick={() => copy('btc', BTC_ONCHAIN_ADDRESS)}>{copied === 'btc' ? 'Copied' : 'Copy'}</button>
        </div>

        <button className='wide' style={{ marginTop: '1rem' }} onClick={onClose}>Close</button>
      </div>
    </div>
  )
}

// --- pairing -----------------------------------------------------------------

// The names are asked for BEFORE pairing, because the device name rides in the
// pairing handshake itself (deviceHello already carries it) - and because the
// alternative is what we shipped until now: every device on the operator's
// dashboard called "Android phone", telling them nothing about which phone to
// revoke.
function Welcome ({ names, setNames, onScan, onPaste, onCancel, error }) {
  const [link, setLink] = useState('')

  // Your name is REQUIRED: on the host it is the human a device is confirmed as
  // (per-person revoke needs a person), so an unnamed device is a worse dashboard
  // for the operator. The device name stays optional - it has a sensible fallback.
  const named = names.userName.trim().length > 0

  return (
    <div className='center'>
      <h1>Pear<span className='tune'>Tune</span></h1>
      <p className='muted'>
        Your self-hosted music, anywhere. Open the PearTune dashboard on your
        server and show the pairing code.
      </p>
      {error && <div className='error'>{error}</div>}

      <div className='namebox'>
        <label className='muted sm'>This device</label>
        <input
          value={names.deviceName}
          onChange={e => setNames({ ...names, deviceName: e.target.value })}
          placeholder='This phone'
          maxLength={64}
        />
        <label className='muted sm'>Your name</label>
        <input
          value={names.userName}
          onChange={e => setNames({ ...names, userName: e.target.value })}
          placeholder='Your name'
          maxLength={64}
        />
        <p className='muted sm hint'>
          The person running the server sees these, so they know whose device this
          is. They confirm your name before it means anything.
        </p>
      </div>

      <button className='primary' onClick={onScan} disabled={!named}>Scan pairing code</button>
      <details>
        <summary className='muted sm'>Paste a link instead</summary>
        <input value={link} onChange={e => setLink(e.target.value)} placeholder='pear://peartune/pair?…' />
        <button onClick={() => onPaste(link.trim())} disabled={!named || !link.trim()}>Pair</button>
      </details>
      {onCancel && <button onClick={onCancel}>Cancel</button>}
    </div>
  )
}

// The in-flight pairing screen. Between accepting a link and the host answering
// there is a real, sometimes multi-second, holepunch; showing the onboarding form
// there read as "nothing happened". A spinner says the opposite.
function Pairing () {
  return (
    <div className='center'>
      <h1>Pear<span className='tune'>Tune</span></h1>
      <CircleNotch size={40} weight='bold' className='spin' />
      <p className='muted'>Pairing with your library…</p>
    </div>
  )
}

function Scanner ({ onScan, onCancel, error }) {
  const video = useRef(null)
  const canvas = useRef(null)
  const [msg, setMsg] = useState('Point at the pairing code')

  useEffect(() => {
    let stream = null
    let raf = null
    let done = false

    // navigator.mediaDevices is UNDEFINED outside a secure context, so this must
    // be a guard and not a `.catch`: reading .getUserMedia off undefined throws
    // synchronously, right here in an effect, which unmounts the whole tree and
    // paints a black screen with nothing in the log. (It did. See the shell's
    // baseUrl.) Fail with a sentence a human can act on instead.
    ;(async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('This device will not give the app a camera.')
        }
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        if (done) return s.getTracks().forEach(t => t.stop())
        stream = s
        video.current.srcObject = s
        video.current.play()
        tick()
      } catch (e) {
        setMsg(`Camera unavailable (${e.message}). Paste the link instead.`)
      }
    })()

    function tick () {
      if (done) return
      const v = video.current
      const c = canvas.current
      if (v && c && v.readyState === v.HAVE_ENOUGH_DATA) {
        c.width = v.videoWidth
        c.height = v.videoHeight
        const ctx = c.getContext('2d')
        ctx.drawImage(v, 0, 0, c.width, c.height)
        const img = ctx.getImageData(0, 0, c.width, c.height)
        const code = jsQR(img.data, img.width, img.height)
        if (code?.data) {
          done = true
          onScan(code.data)
          return
        }
      }
      raf = requestAnimationFrame(tick)
    }

    return () => {
      done = true
      if (raf) cancelAnimationFrame(raf)
      stream?.getTracks().forEach(t => t.stop())
    }
  }, [])

  return (
    <div className='scanner'>
      <video ref={video} playsInline muted />
      <canvas ref={canvas} style={{ display: 'none' }} />
      <div className='overlay'>
        <p>{msg}</p>
        {error && <div className='error'>{error}</div>}
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

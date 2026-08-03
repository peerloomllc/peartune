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
import QRCode from 'qrcode'
import {
  MusicNotes, MusicNotesSimple, UsersThree, Gear, Info, CaretRight, CaretLeft,
  CaretDown, Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, RepeatOnce, X,
  ArrowCounterClockwise, ArrowClockwise, Heart, CurrencyBtc, ShareNetwork,
  EnvelopeSimple, Code, Copy, PlugsConnected, ArrowsClockwise, Rows, SquaresFour,
  GridFour, ListPlus, Queue as QueueIcon, Trash, Plus, Playlist as PlaylistIcon,
  PencilSimple, DotsSixVertical, DownloadSimple, CheckCircle, CircleNotch,
  Palette, SpeakerHigh, Key, ChartLineUp, ArrowUp, ArrowDown, Faders, Moon, Camera, QrCode,
  WarningCircle, LockKey, DeviceMobile, MusicNotesPlus, XCircle, CheckSquare, Square
} from '@phosphor-icons/react'
import { call, on, haptic } from './bridge'
import { friendlyError, redact, reportUrl, reportMailto } from './errors.mjs'
import { loadThemePref, applyThemePref, onSystemThemeChange } from './theme'
import { shouldShowNudge } from './donation'
import { normalizeViewState, isDefaultView, sameViewState } from './viewstate'
import { runScene, sceneOpens } from './screenshot'

// --- About + donation (suite config, shared across PeerLoom apps) ------------
// INJECTED AT BUILD TIME from app.json, which is the one place the version is set (and the one
// place scripts/release.sh rewrites). It was a hardcoded '0.1.0' and NOTHING synced it - not the
// release script, not a plugin - so About and every bug report would have gone on saying 0.1.0
// through every release after the first. The fallback is for a bundle built by some other means.
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'
const LIGHTNING_ADDRESS = 'peerloomllc@strike.me'
const STRIKE_TIP_URL = 'https://strike.me/peerloomllc/'
const BTC_ONCHAIN_ADDRESS = 'bc1q0kksenz3j4u9ppe6f4krclvzwxk7sjy00cc9cf'
const BUYMEACOFFEE_URL = 'https://buymeacoffee.com/peerloomllc'
const GITHUB_URL = 'https://github.com/peerloomllc/peartune'
const CONTACT_EMAIL = 'peerloomllc@proton.me'
const CONTACT_URL = `mailto:${CONTACT_EMAIL}?subject=%5BPearTune%5D%20Feedback`
const SHARE_TEXT = 'PearTune - the music on your own server, or a friend\'s, playable anywhere. No port forwarding, no VPN, no account.\n\nhttps://peerloomllc.com/peartune/'
// iOS hides the donation section per App Store guideline 3.1.1 (no external
// donation links). The shell injects the platform before the bundle runs.
const isIOS = () => typeof window !== 'undefined' && window.__pearPlatform === 'ios'

const openUrl = (url) => { call('shell:openUrl', { url }).catch(() => {}) }
const copyText = (text) => call('shell:clipboard', { text }).catch(() => {})
// A device public key, abbreviated for a row. Same shape the dashboard uses, so the two surfaces
// print the same thing and can be compared at a glance.
const shortKey = (k) => { const s = String(k || ''); return s.length > 14 ? s.slice(0, 6) + '…' + s.slice(-4) : s }

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
  // Which onboarding card is up, and (on the "whose library" card) which answer was
  // picked. Up HERE rather than inside Onboarding for the same reason the names are:
  // the component unmounts on a scan or a failed pair, and coming back to the intro
  // every time would be a fresh start you did not ask for. It is also what lets
  // Android back walk the cards (the 'back' listener below).
  const [obPhase, setObPhase] = useState('intro') // 'intro' | 'whose' | 'names' | 'pair'
  const [obOwner, setObOwner] = useState(null) // 'mine' | 'friend' | null
  // Adding ANOTHER library from Settings (multi-host, 2026-07-19). Shows the same pairing
  // flow as onboarding, but over the running app instead of the pairing wall.
  const [addingLibrary, setAddingLibrary] = useState(false)
  // "Try it without a server" is in flight. The first tap copies ~18 MB of bundled audio out of
  // the app package into the cache, which takes a beat on a slow phone - long enough that a
  // button with no feedback reads as broken (proposal 2026-07-28-app-review-demo).
  const [demoStarting, setDemoStarting] = useState(false)
  // A pear:// pairing link the app was opened with, waiting for a device name before it can
  // be used. Only ever set on a device with NO library yet - a paired one pairs immediately.
  const [pendingLink, setPendingLink] = useState(null)
  const [donate, setDonate] = useState(false)
  const [nudge, setNudge] = useState(false) // the after-two-weeks donation reminder
  const [reqComposer, setReqComposer] = useState(null) // music-request composer: { name } prefill, or null
  const [reqSupported, setReqSupported] = useState(true) // false = active host too old for requests
  const [myRequests, setMyRequests] = useState(null) // this device's own requests (the You > Requests view)
  // For the once-registered reconnect handler, which closed over the first render. Only reload the
  // list if it has ever been looked at - a device that never opens Requests should not pay a
  // round-trip for it on every reconnect.
  const myRequestsRef = useRef(null)
  myRequestsRef.current = myRequests
  const [ownerDevices, setOwnerDevices] = useState(null) // the managed library's devices, for an owner (You > Manage)
  const [ownerReqs, setOwnerReqs] = useState(null) // the full request queue, for an owner to resolve (You > Manage)
  const [ownedLibs, setOwnedLibs] = useState([]) // libraries this device OWNS + can reach (the Manage picker)
  const [manageLib, setManageLib] = useState(null) // libraryId currently selected in Manage (null = active/default)
  const manageLibRef = useRef(null) // so the once-registered devices:changed handler reads the live selection
  manageLibRef.current = manageLib
  const [ownerPending, setOwnerPending] = useState(0) // count of unresolved requests, for the You-tab badge
  const [ownerPair, setOwnerPair] = useState(null) // { link } while an owner-opened pairing window is up
  const [ownerTour, setOwnerTour] = useState(false) // one-shot "you're an owner now" walkthrough
  const [confirming, setConfirming] = useState(null)
  // The pending relay-audio consent prompt, or null (proposal 2026-07-29). Set by the
  // worklet's relay:consent-needed event, cleared when answered or dismissed.
  const [relayAsk, setRelayAsk] = useState(null)
  const [menu, setMenu] = useState(null) // long-press: play / shuffle / queue
  const [queue, setQueue] = useState(null) // the up-next list, when opened
  const [note, setNote] = useState(null) // a transient confirmation
  const [viewing, setViewing] = useState(null) // artwork, full screen
  const [expanded, setExpanded] = useState(false) // the player: mini vs full
  const [skin, setSkin] = useState('modern') // player skin: modern | classic (the retro Winamp-style face)
  // Show the Recently Added shelf above the album grid. A SETTING, not a dismiss (Tim asked for
  // "hide/dismiss"): a dismiss has to answer "when does it come back?", and any answer to that is
  // a rule nobody can see. This is a switch you can find again where you turned it off.
  const [showRecent, setShowRecent] = useState(true)
  const [albumsLoaded, setAlbumsLoaded] = useState(false)
  // How many background refreshes are in flight. A COUNT, not a boolean: a cold launch fires one
  // per library as each connects, and a boolean would clear on the first to finish while three
  // were still running. Drives the quiet "Updating…" in the library header - the honest signal
  // that replaced the flicker, since the content itself no longer disappears to say so.
  const [updating, setUpdating] = useState(0)
  // The hint the header shows while a refresh runs, DEBOUNCED - `updating` itself is a raw counter
  // that goes 1 -> 0 -> 1 -> 0 as each library's reload starts and finishes, so binding the text
  // straight to it made the subtitle blink several times on a cold launch (Tim, 2026-07-28). The
  // grid was already steady by then; this was the last thing moving. Rise immediately (a refresh
  // that takes a while should say so at once) and fall only after a quiet dwell, which collapses a
  // burst of four reloads into one steady hint that appears once and leaves once.
  const [updatingSteady, setUpdatingSteady] = useState(false)
  useEffect(() => {
    if (updating > 0) { setUpdatingSteady(true); return }
    const t = setTimeout(() => setUpdatingSteady(false), 900)
    return () => clearTimeout(t)
  }, [updating])
  // THE LAUNCH WINDOW, which `updating` alone does not cover (Tim, 2026-07-28). A cold launch
  // paints the CACHED index first and only then dispatches a reload per library, so for about a
  // second the screen is fully drawn, work is plainly happening, and nothing on it says so - and
  // when the cached index is empty (a first run, a cleared cache) that second is spent asserting
  // "Nothing here yet. This library is empty", which is a claim, not a wait. `booting` is true
  // from mount and falls only once a reload has actually run AND settled, so the indicator is
  // continuous from the first paint to the last arrival instead of blinking on halfway through.
  const [booting, setBooting] = useState(true)
  const sawReloadRef = useRef(false)
  useEffect(() => { if (updating > 0) sawReloadRef.current = true }, [updating])
  useEffect(() => {
    if (booting && sawReloadRef.current && !updatingSteady) setBooting(false)
  }, [booting, updatingSteady])
  // A hard stop, because `booting` must never be able to stick. A library that is simply never
  // going to answer (a host that is off) would otherwise leave a spinner running forever, which
  // is a worse lie than the empty state this replaces.
  useEffect(() => {
    const t = setTimeout(() => setBooting(false), 20000)
    return () => clearTimeout(t)
  }, [])
  // The ONE "something is happening" signal the library screen reads: it drives both the header
  // hint and the empty state, so those two can never disagree about whether we are still working.
  // ...and NEVER during a store capture. `booting` only falls once a real reload has run and
  // settled, and in screenshot mode nothing real ever runs - so the header sat on a permanent
  // "Updating…" in every frame. This is the one thing the fixture layer cannot express, since it
  // stands in for the transport and this is a UI state, so it is read from the global directly
  // rather than pretending a call answered it.
  const busy = (booting || updatingSteady) && !window.__pearScreenshotScene
  const [reconnecting, setReconnecting] = useState(false)
  // A cold launch has not FAILED - it has not tried yet. init() answers with
  // connected:false and kicks the connect off in the background (src/bare.js), so
  // the not-connected wall painted a failure before anything had been attempted:
  // every launch opened on "PearTune can't reach this library" for a moment (Tim,
  // 2026-07-24). This is the missing third state - trying - and it is not a guess:
  // the worklet says how the attempt ended, host:connected or host:disconnected.
  const [firstConnect, setFirstConnect] = useState(false)
  const [shuffle, setShuffle] = useState(false)
  const [repeat, setRepeat] = useState(0) // 0 off, 1 one, 2 all
  const [sleep, setSleep] = useState(null) // sleep timer: { active, endOfTrack, deadline } from the shell
  const [sleepOpen, setSleepOpen] = useState(false) // the sleep-timer picker sheet
  // Home Assistant speakers (proposal 2026-08-01). `speakers` is null until we have asked;
  // an empty list, an old host, a non-owner grant and an unconfigured host all collapse to
  // "no button", which is why only ONE flag drives the UI.
  const [speakers, setSpeakers] = useState(null) // [{ entityId, name, state }] or null
  const [castingTo, setCastingTo] = useState(null) // entityId we are currently playing on
  const [speakerOpen, setSpeakerOpen] = useState(false) // the "Play on" sheet
  const [speakerBusy, setSpeakerBusy] = useState(false)
  // The once-registered speaker:ended handler closes over the first render, so it reads
  // these rather than the state values. Same trick as youViewRef below.
  const castingToRef = useRef(null)
  castingToRef.current = castingTo
  // Whether the SPEAKER is paused. Tracked here because the speaker has no position and
  // the phone's own `status.playing` is false throughout a cast (it is held paused), so
  // neither one can answer "is the music going" while casting.
  const [castPaused, setCastPaused] = useState(false)
  const castPausedRef = useRef(false)
  castPausedRef.current = castPaused
  const [themePref, setThemePref] = useState(() => loadThemePref())
  // Favorited ids, grouped by kind (track / album / artist). Sets for O(1) heart checks.
  const [favs, setFavs] = useState(() => ({ track: new Set(), album: new Set(), artist: new Set() }))
  const [favSupported, setFavSupported] = useState(true) // false = host too old
  const [favItems, setFavItems] = useState(null) // the Favorites view, resolved + grouped
  // For the once-registered push handlers, which close over the first render and would otherwise
  // read a favItems that is forever null. Same trick as youViewRef, right below.
  const favItemsRef = useRef(null)
  favItemsRef.current = favItems
  // Which libraries were in the blend last time we heard: a ref, not state, because it only ever
  // answers "did a host just JOIN?" for the merged:updated handler and must never cause a render.
  // Starts empty on purpose - the first event after launch then re-reads the hearts once, which is
  // exactly what a cold start needs (the pool is warmer by then than it was on host:connected).
  const blendLibsRef = useRef(new Set())
  const [cont, setCont] = useState(null) // "continue listening": { track, positionMs }
  const [handoff, setHandoff] = useState(null) // another device holds the play session: { activeDeviceName, count }
  const [mostPlayed, setMostPlayed] = useState(null) // the Most Played view: { items }
  const [youView, setYouView] = useState('favorites') // the "You" tab's sub-picker: favorites | top | playlists
  const youViewRef = useRef('favorites') // for the once-registered devices:changed handler
  youViewRef.current = youView
  const [playlists, setPlaylists] = useState(null) // the Playlists list: [{ id, name, count }]
  // Bumped when ANOTHER of this person's devices changes a playlist. An open PlaylistScreen takes
  // it as a dep and refetches IN PLACE (its effect overwrites rather than clearing, so there is no
  // skeleton flash) - the lesson from the Favorites ghost shells, applied before it could repeat.
  const [plRefresh, setPlRefresh] = useState(0)
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

  // Seed the pairing form from the identity this device already carries. Removing a library
  // (or unpairing entirely) deliberately KEEPS deviceName/userName in settings.json - you are
  // still you - but the form used to open blank, so the obvious thing to do was retype your
  // name. Retype it differently and the host mints a SECOND person, which is where a good
  // share of the orphan people came from. Seeds a field only while it is still empty, so it
  // can never overwrite what someone is typing, and openAddLibrary's explicit prefill wins.
  useEffect(() => {
    const d = state.settings?.deviceName || ''
    const u = state.settings?.userName || ''
    if (!d && !u) return
    setPairNames(p => ({ deviceName: p.deviceName || d, userName: p.userName || u }))
  }, [state.settings?.deviceName, state.settings?.userName])

  useEffect(() => {
    call('init')
      .then((s) => {
        setState({ ...s, loading: false })
        if (s.settings?.density) setDensity(String(s.settings.density))
        if (s.settings?.skin) setSkin(String(s.settings.skin))
        // Default true, so only an explicit false hides it - a missing key must not read as "off".
        if (s.settings?.showRecent === false) setShowRecent(false)
        // Restore the persisted per-view sort. Held in a local, not read back from state,
        // for the load below: setSort has not committed yet in this same tick, so the
        // first albums load must take its params directly (same reason applySort does).
        const savedSort = s.settings?.sort && typeof s.settings.sort === 'object' ? s.settings.sort : null
        // The REF too, synchronously: it is normally assigned during render, so a
        // loader fired from here (the restored browse view below) would otherwise
        // read the first render's empty sort and ask for the default order.
        if (savedSort) { setSort(savedSort); sortRef.current = savedSort }
        // Where you were last time - the tab, the drill-down, the source filter, the
        // player size and the scroll. Before the loads below, because it sets the
        // source filter they read (see restoreView).
        const view = restoreView(s)
        const showAlbums = !view || view.browse === 'albums'
        loadPinned() // pins are local - available even offline
        // Load the identity on mount, not only on host:connected: fully offline (no host ever
        // connects) that event never fires, so the Name/Device fields sat blank forever. identity()
        // returns the LOCAL names immediately now (never blocks on a connect), so this is instant
        // online or off; a later host:connected re-runs it to fold in the confirmed status (Tim, 2026-07-22).
        loadIdentity()
        // Restore the paused queue from the last session (the shell rebuilds it and
        // emits play:started, which lights up the mini-player). Fire-and-forget: a
        // cached queue restores offline; an uncached one waits for the connection.
        call('restore').then(r => { if (r?.restored) setCont(null) }).catch(() => {})
        // Merged is the default when 2+ hosts are paired: the browse serves from the cached index
        // INSTANTLY (no connection needed), and a background rebuild refreshes it via merged:updated.
        setMerged(s.merged || null)
        if (s.merged?.merged && showAlbums) loadAlbums(0, sortParamsFor(savedSort, 'albums'))
        if (s.connected) {
          if (showAlbums) loadAlbums(0, sortParamsFor(savedSort, 'albums'))
          loadRecent(); loadSource(); loadFavs(); loadContinue(); loadHandoff(); loadPlaylists(); loadSpeakers()
        }
        // Paired but not connected YET: the background connect is in flight, so show
        // a spinner rather than a verdict until it lands or fails.
        else if (s.host) setFirstConnect(true)

        // The two-week donation nudge the siblings show. shouldShowNudge (src/ui/
        // donation.js) owns the rule; decided once here off init, not re-checked, so
        // it cannot pop mid-session.
        if (shouldShowNudge({ settings: s.settings, host: s.host, ios: isIOS(), now: Date.now() })) {
          setNudge(true)
        }
      })
      .catch(e => setState({ loading: false, error: e.message }))

    const offs = [
      on('play:started', (d) => {
        setNow(d); setError(null)
        setHandoff(null) // we are the active player now - hide any "Playing on <other>" card
        countedRef.current = { trackId: d?.trackId, counted: false } // a fresh play to count
        // THE ONE PATH THAT FEEDS THE SPEAKER (proposal 2026-08-02). The shell announces
        // every track change here - a queue tap, Next, Previous, an automatic advance, a
        // shuffled pick - so forwarding from this single point is what makes shuffle and
        // repeat work on a speaker without any of this code knowing they exist.
        if (castingToRef.current && d?.trackId) {
          setCastPaused(false)
          castCurrent(d.trackId)
        }
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
      // Collapsing matters beyond tidiness: the full player unmounts with the track,
      // but `canBack` still counts `expanded`, so leaving it set costs one back press
      // that appears to do nothing at all.
      on('play:stopped', () => { setNow(null); setStatus(null); setSleep(null); setExpanded(false); loadContinue(); loadHandoff() }),
      // Sleep timer state from the shell (where the countdown actually lives). `fired`
      // means the timer just stopped playback; the deadline drives the UI countdown.
      on('sleep:state', (d) => {
        setSleep(d.active ? d : null)
        if (d.fired) toast('Sleep timer - playback paused.')
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
        // DELIBERATELY NOT setFirstConnect(false) here, which is what used to make the failure
        // wall flash up mid-launch (Tim, 2026-07-30). The old comment claimed "the cold-launch
        // attempt has now CONCLUDED, badly" - and that is simply not true. This event fires when
        // init's background connectTo misses its 20s waitForLink, but the swarm membership
        // OUTLIVES that wait: the nudge loop keeps forcing fresh discovery every 10s and the
        // connection frequently lands moments later. waitForLink's own comment says as much -
        // "a UX bound, not a give-up".
        //
        // MEASURED on the TCL by polling the live WebView (a screenshot cannot see it):
        //   t+ 3.69s  "Connecting…"
        //   t+23.69s  "Not connected"   <- 20s exactly: the wait elapsing, not a failure
        //   t+29.18s  library loads
        // 5.5 seconds of telling the user it could not reach a library it was busy reaching. The
        // cost is worse than the flash itself: this is the same wall a REAL failure shows, so
        // crying wolf here teaches people to disbelieve it - and it is the exact screen that was
        // stuck wrongly in #268.
        //
        // The spinner now runs until either the connection lands or the 45s backstop above
        // decides we have been trying long enough. That backstop was already chosen for this
        // very reason: "sized well past the worklet's own 20s first-connect wait so a
        // legitimately slow off-LAN connect is never called a failure early".
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
        // ...unless a pairing screen owns the error (see pairUiRef): a rejected code
        // connects to the host that rejected it, so this would erase its own explanation.
        if (!pairUiRef.current) setError(null)
        setFirstConnect(false)
        // init connects in the BACKGROUND now, so this event - not init - is what kicks
        // off the first library load, and refreshes it on every reconnect.
        loadIdentity()
        loadSource()
        loadFavs()
        loadContinue()
        loadHandoff(); setTimeout(loadHandoff, 2000) // retry: the active device may push its queue just after we connect
        loadPlaylists(true)
        // Speakers belong here for the same reason as everything above: init connects in the
        // BACKGROUND, so `connected` is false when init resolves and the load it does there
        // never runs on a cold start. Found on the TCL 2026-08-01 - the speaker button was
        // missing on a freshly launched app even though the host was serving the list. It
        // also covers the operator turning Home Assistant on while the app sits connected,
        // which nothing else would tell us about until a reconnect.
        loadSpeakers()
        // REQUESTS TOO, and this is not symmetry for its own sake. A backgrounded phone loses its
        // connection in about 30 seconds (measured on the TCL, 2026-07-30), and a push cannot
        // reach a device that is not there - so anything that happened while it was away is
        // missed, and the reconnect is the only chance to notice. Everything else in this list
        // already understood that; requests were the one thing left out, so a request resolved
        // while your phone was in your pocket kept its old status until the app was reopened.
        if (myRequestsRef.current) loadRequests(true)
        if (youViewRef.current === 'manage') loadOwnerReqs()
        // In merged mode, if any paired host is still missing from the blend, rebuild to fold the
        // one that just came online in (merged:updated then reloads browse + chips). If the blend is
        // already complete, just re-render browse from the current index rather than re-fetching.
        if (mergedRef.current?.merged) {
          if ((mergedRef.current.libraries || []).some(l => !l.connected)) call('refreshMerged').catch(() => {})
          else reloadBrowse()
          loadRecent()
        } else {
          loadAlbums(0)
          loadRecent()
        }
      }),
      // A background merged rebuild landed (launch, a host (re)joining, a pull-to-refresh): update
      // the source chips + greying and re-render the browse + the recently-added shelf from the blend.
      on('merged:updated', (st) => {
        setMerged(st); reloadBrowse(); loadRecent()
        // AND re-read the hearts when a library JOINS the blend. In merged mode the heart state is
        // the UNION of every CONNECTED host's favorites (the worklet walks the pool for it), but it
        // was only ever fetched on host:connected - which fires for the ACTIVE client, before the
        // pool has finished coming up. So after removing and re-pairing a library the Favorites
        // list was right while every heart rendered as an outline, and only a relaunch fixed it:
        // the list is fetched when you open it (pool warm by then), the id-set was not fetched
        // again at all. Same reason a cold launch could show hollow hearts for a beat.
        //
        // Only on a JOIN: a host DROPPING out cannot add favorites, and re-reading on every event
        // would mean a favList round-trip per host every time a link flaps.
        const live = new Set((st?.libraries || []).filter(l => l.connected).map(l => l.libraryId))
        const joined = [...live].some(id => !blendLibsRef.current.has(id))
        blendLibsRef.current = live
        if (joined) {
          loadFavs()
          // The resolved list is missing that host's rows too. Same in-place refresh as the
          // favorites push: nulling it here would leave the Favorites view on ghost shells if it
          // happens to be the screen you are on when a library reconnects.
          refreshFavItems()
        }
      }),
      // A library reachable only through the relay is about to stream audio and has not been
      // asked yet (proposal 2026-07-29-relay-audio-consent). The worklet raises this ONCE per
      // library - ExoPlayer range-requests a single track many times - and has already refused
      // the request with a 403, so the player has stopped. Whichever way this is answered, the
      // user presses play again; we do not try to resume behind their back.
      on('relay:consent-needed', (d) => {
        setRelayAsk({ libraryId: d.libraryId, libraryName: d.libraryName })
      }),

      // The operator renamed the library on the dashboard; the worklet caught it on connect and
      // persisted it. Reflect it live in the header, the Settings switcher, and the merged chips.
      on('host:renamed', (d) => {
        // `libraryName` is the LABEL (your alias when you set one, suffixed on a clash);
        // `hostName` is what the server itself now calls the library, which Settings shows
        // under an aliased row - so a rename you cannot see in the label is still visible.
        const patch = { libraryName: d.libraryName, ...(d.hostName ? { hostName: d.hostName } : {}), ...(d.alias !== undefined ? { alias: d.alias } : {}) }
        setState(s => ({
          ...s,
          host: s.host?.hostKey === d.hostKey ? { ...s.host, ...patch } : s.host,
          hosts: (s.hosts || []).map(h => h.hostKey === d.hostKey ? { ...h, ...patch } : h)
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
        // Leaving merged mode drops the filter, so the worklet's copy has to drop with it.
        call('setLibraryFilter', { libraryId: '_all' }).catch(() => {})
        setAlbums([]); setArtists(null); setAlbumsLoaded(false); setStack([]); setResults(null); setQuery(''); setError(null)
        if (liveRef.current?.connected) {
          loadAlbums(0); loadRecent(); loadSource(); loadFavs(); loadContinue(); loadPlaylists(true); loadSpeakers()
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
      }),

      // A host (that we own) told us its device roster changed - a pair, a revoke, a delete, a
      // promotion on its dashboard. If we are currently managing THAT library, refresh the list
      // live instead of only on the next open (Tim: a dashboard revoke did not update Manage).
      on('devices:changed', (d) => {
        // Only while actually viewing Manage. A null selection means "the active library" (loadOwnerDevices
        // falls back to it), so reload then too; with a selection, only when the push is for that library.
        if (youViewRef.current !== 'manage') return
        const lib = manageLibRef.current
        if (!lib || !d?.libraryId || d.libraryId === lib) loadOwnerDevices()
      }),

      // Tier A notifications (P3). The host only pushes request:new to OWNER devices, so this
      // arriving means we are one - banner it and refresh the count the You-tab badge reads. If
      // Manage is open its list reloads too (loadOwnerReqs also recomputes the pending count).
      on('request:new', (d) => {
        toast(d?.name ? `New request: ${d.name}` : 'New music request')
        if (youViewRef.current === 'manage') loadOwnerReqs()
        else refreshOwnerPending()
      }),
      // The owner queue changed WITHOUT a new arrival: someone withdrew their ask, or it was
      // resolved on the dashboard. Only arrivals used to be pushed, so Manage watched the queue
      // grow and never shrink (Tim, 2026-07-30). No toast - a row leaving is not something to
      // interrupt an operator about, and a resolve they just did on the dashboard would toast
      // back at them. loadOwnerReqs sets the list in place, so there is no skeleton flash.
      on('requests:changed', () => {
        if (youViewRef.current === 'manage') loadOwnerReqs()
        else refreshOwnerPending()
      }),
      // Pushed to whoever filed the request, on every device they are on. Tell them and refresh
      // their own list so the status colour is right the moment they open Requests.
      on('request:resolved', (d) => {
        const verb = d?.status === 'added' ? 'added' : 'declined'
        toast(d?.name ? `Your request for ${d.name} was ${verb}` : `A request was ${verb}`)
        loadRequests(true)
      }),
      // ANOTHER of this person's devices changed a favorite. Nothing else asks while the app sits
      // connected - loadFavs runs on mount, on connect, on a host join and on our own toggle - so
      // without this the hearts and the list stayed on the old answer until the app was reopened
      // (Tim, 2026-07-30). BOTH have to be refreshed: `favs` is the id sets the hearts read, and
      // favItems is the resolved list. Dropping favItems to null makes the Favorites screen
      // refetch when it is next opened rather than fetching rows nobody is looking at - and
      // clearing only ONE of the two is what made the list and the heart disagree in the first
      // report of this bug. No toast: a favorite you made on your other phone is not news to
      // interrupt with, it should just be right.
      on('favorites:changed', () => {
        loadFavs()
        refreshFavItems()
      }),
      // ...and the same for playlists, which had the identical gap: one created, renamed, deleted
      // or reordered on another phone did not arrive until something made the app ask again, and
      // nothing does while it sits connected. loadPlaylists(true) forces past its cache; plRefresh
      // reaches an open playlist DETAIL, which is a second surface that would otherwise show the
      // old track list. No toast - your own edit on your own other device is not an interruption.
      on('playlists:changed', () => {
        loadPlaylists(true)
        setPlRefresh((n) => n + 1)
      }),
      // A track we sent to a Home Assistant speaker finished (proposal 2026-08-01). The
      // speaker has NO QUEUE of its own, so this push is the only thing that can advance
      // one - the app owns the queue and sends the next track here. Ignore a push for a
      // speaker we have since moved off, or it would skip a track on the phone.
      on('speaker:ended', (d) => {
        if (!castingToRef.current || d?.entityId !== castingToRef.current) return
        castNext()
      }),
      // A pear:// pairing link was opened while the app was already running. The shell parks
      // it and nudges; we take it below. See takePendingLink.
      on('link:pending', () => { takePendingLink() })
    ]
    // ...and the COLD START, where the link was known before this component existed. Same
    // atomic take, so whichever of the two arrives first wins and the other finds nothing.
    takePendingLink()
    return () => offs.forEach(f => f())
  }, [])

  // A pear:// pairing link, opened from a message, a browser or a QR app. The shell holds it
  // (only the shell can see the intent) and this fetches-and-clears it. It only STASHES:
  // where the link should go depends on whether this device has a library yet, and at a cold
  // start that is not known until init() answers. Deciding here would read `state.host` as
  // null on every launch and push an already-paired phone back into onboarding.
  async function takePendingLink () {
    let url = null
    try { url = (await call('shell:pendingLink'))?.url || null } catch {}
    if (url) setPendingLink(url)
  }

  // ...and the decision, once init() has answered so `state.host` means something. Pairing
  // needs a NAME, and an un-onboarded device has not given one:
  //   - already paired -> straight into the add-a-library flow, names already known.
  //   - not paired yet -> hold the link and jump onboarding to the naming card, whose
  //     Continue button pairs with it instead of sending you to a scanner you do not need.
  //     Intro and the whose-library explainer are skipped: someone who followed a pairing
  //     link has already been told what this is, by whoever sent it.
  useEffect(() => {
    if (!pendingLink || state.loading) return
    if (!state.host) { setObPhase('names'); return }
    setError(null)
    setPendingLink(null)
    setAddingLibrary(true)
    // NAMES RESOLVED HERE, not read from `pairNames` alone. That state is seeded from
    // state.settings by an effect above, and BOTH effects run off the same init() commit - so
    // this one sees the pre-seed value and pairs with an empty claim. The device then lands on
    // the operator's dashboard unassigned, with no person attached, even though the name has
    // been sitting in settings.json since onboarding (measured 2026-07-28: paired from demo
    // mode by link, belongsTo came back null while settings held "Alex").
    //
    // That is exactly what moving the naming card BEFORE the demo choice was meant to prevent,
    // so the link path has to honour it too. pairNames wins when it has something (the person
    // may have just typed it on the naming card and not saved yet); the stored identity is the
    // fallback that makes a link pair non-anonymous.
    onPaired(pendingLink, {
      deviceName: pairNames.deviceName || ident?.deviceName || state.settings?.deviceName || '',
      userName: pairNames.userName || ident?.userName || state.settings?.userName || ''
    })
  }, [pendingLink, state.loading, state.host])

  // Becoming an owner used to just make a Manage icon quietly appear in the You picker,
  // with no hint it was there or what it did. So the first time this device is confirmed
  // an owner, point them at it once. One-shot and gated on a persisted flag, exactly like
  // the donation nudge - a ref stops it re-firing within the session before the flag lands.
  const ownerTourRef = useRef(false)
  useEffect(() => {
    if (!ident?.owner) return
    if (ownerTourRef.current || state.settings?.ownerTourShown) return
    ownerTourRef.current = true
    setOwnerTour(true)
  }, [ident?.owner, state.settings?.ownerTourShown])
  // Whichever way the tour is answered it is done for good. "Show me" also drops the
  // person straight into You > Manage; a quiet dismiss just closes it.
  function finishOwnerTour (goManage) {
    call('setSettings', { ownerTourShown: true }).catch(() => {})
    setState(s => ({ ...s, settings: { ...s.settings, ownerTourShown: true } }))
    setOwnerTour(false)
    if (goManage) { haptic('light'); setStack([]); setTab('you'); showManage() }
  }

  // What the once-registered listeners above need to see, always current.
  const liveRef = useRef({})
  liveRef.current = { host: state.host, connected: state.connected, reconnecting }
  // Is a PAIRING screen the thing on screen right now? host:connected clears the last error,
  // which is right for the ordinary case - a reconnect really does fix most of them - and
  // wrong here: a refused pairing code opens a connection to that very host, so the
  // host:connected it triggers wiped the explanation before it could be read, leaving the
  // pairing card silent about why nothing happened. Found chasing deep links (2026-07-28),
  // but it was always reachable from the scanner; a link just walks into it every time.
  const pairUiRef = useRef(false)
  pairUiRef.current = !state.host || addingLibrary || pairing || scanning
  // The once-registered push handlers (request:new etc.) read owner status through this, since
  // they closed over the first render and `ident` changes later, on connect. (youViewRef, used by
  // the same handlers, is declared up by the youView state.)
  const identRef = useRef(null)
  identRef.current = ident

  // Prime the You-tab request badge for owners: once this device is a confirmed owner and there
  // is a connection to ask over, count the unresolved requests so the badge is right before they
  // ever open Manage. A push keeps it live after that; this covers the cold-open count.
  useEffect(() => {
    if (ident?.owner && state.connected) refreshOwnerPending()
    else if (!ident?.owner) setOwnerPending(0)
  }, [ident?.owner, state.connected])

  // Merged-mode refs, for the same reason as sortRef below: the once-registered listeners (and the
  // loaders they fire) captured the first render, so they read the CURRENT source filter, merged
  // status, and browse view through refs. filterRef is also set synchronously by the chip tap so a
  // reload picks up the new filter before setState commits.
  // Returning to Library while disconnected re-tries. The case that made this obvious: the
  // Connection check reached both libraries in under half a second, the user went back to
  // Library, and it was still showing the failure from a minute earlier because nothing ever
  // asked again. Guarded on `reconnecting` so tab-flipping cannot stack dials.
  useEffect(() => {
    if (tab !== 'library') return
    const s = liveRef.current
    if (s.host && !s.connected && !s.reconnecting) reconnect()
  }, [tab])

  // The names typed on the onboarding card, readable from a callback that closed over an older
  // render (startDemo runs across an await, and the second half must not save a stale name).
  const pairNamesRef = useRef(pairNames); pairNamesRef.current = pairNames
  const mergedRef = useRef(null); mergedRef.current = merged
  const filterRef = useRef('_all'); filterRef.current = filter
  const browseRef = useRef('albums'); browseRef.current = browse
  // What each view is CURRENTLY showing, readable from the once-registered event listeners (whose
  // closures captured the first render's empty state). reloadBrowse uses these to decide whether it
  // has anything worth keeping on screen while it refetches - see the flicker note there.
  const albumsRef = useRef([]); albumsRef.current = albums
  const artistsRef = useRef(null); artistsRef.current = artists
  const genresRef = useRef(null); genresRef.current = genres
  const songsRef = useRef(null); songsRef.current = songs

  // Reload whichever browse view is showing, from the current source filter (used after a merged
  // rebuild, and by a chip tap).
  //
  // IT DOES NOT BLANK THE VIEW FIRST, and that is the point (Tim, 2026-07-27). This runs on every
  // host:connected and every merged:updated, so a cold launch with four libraries ran it several
  // times - and it used to clear the list and drop back to skeletons before each refetch. The grid
  // flashed empty and refilled once per library, and the header count, which is just the array
  // length, bounced 0 -> 60 -> 0 -> 60. The data was never wrong, only the way it arrived.
  //
  // So: keep what is on screen and swap it when the new page lands (loadAlbums(0) REPLACES the
  // array rather than appending, so no clear is needed). Blank only when there is genuinely
  // nothing to show yet, which is what the skeletons are for. Refs, not state, because the
  // listeners that call this captured the first render.
  function reloadBrowse () {
    const v = browseRef.current
    const track = (p) => {
      setUpdating(n => n + 1)
      Promise.resolve(p).finally(() => setUpdating(n => Math.max(0, n - 1)))
    }
    if (v === 'albums') {
      if (!albumsRef.current.length) { setAlbums([]); setAlbumsLoaded(false) }
      setCursor(0); track(loadAlbums(0))
    } else if (v === 'artists') {
      if (!artistsRef.current) setArtists(null)
      track(loadArtists())
    } else if (v === 'genres') {
      if (!genresRef.current) setGenres(null)
      track(loadGenres())
    } else if (v === 'songs') {
      if (!songsRef.current) setSongs(null)
      setSongCursor(0); track(loadSongs(0))
    }
    // The shelf sits INSIDE the albums view and is scoped to the same library, so it has to move
    // with the filter too. Leaving it out is what let a one-library grid sit under a whole-blend
    // shelf; it is cheap (one call, 12 rows) so it reloads on any view change, not just albums.
    loadRecent()
  }

  // "Refresh artwork" just emptied the cover store and minted a new art base. Adopt it and
  // re-render: the grid composes its covers from artBase (artFor), but the lists also carry `art`
  // URLs the worklet built at fetch time, and those still point at the old base - so a reload is
  // what makes the detail screens refetch too. See refreshArtwork in src/bare.js for why a new
  // base is needed at all rather than just clearing the store.
  const onArtRefreshed = (artBase) => {
    if (artBase) setState(s => ({ ...s, artBase }))
    reloadBrowse()
  }

  // Pick a source-filter chip: '_all' (the blend) or one library's id. Any chip RE-ENTERS merged
  // mode first if a Settings switch had focused a single library. Set the ref synchronously so the
  // reload reads the new filter immediately.
  function pickFilter (libraryId) {
    haptic('light')
    filterRef.current = libraryId
    setFilter(libraryId)
    // Tell the WORKLET too, not just the browse calls. Browsing passes the filter per-call, but
    // streaming is resolved by urlFor from the SHELL, which never sees it - so without this,
    // picking a library narrowed the list and left playback coming from somewhere else entirely
    // (Tim, 2026-07-28). Fire-and-forget: the worst case is one track routed the old way.
    call('setLibraryFilter', { libraryId }).catch(() => {})
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
  // Identity reads must land in the order they were ISSUED, not the order they happen to come
  // back. Pairing fires two of them: `host:connected` kicks one off from inside pair() (before the
  // claim has been sent), then onPaired fires another (after). They race over the same connection,
  // and when the older one won it overwrote the fresh answer - Settings sat on "Waiting for your
  // server to confirm you are X" while the host had already auto-created and assigned the person,
  // and only a relaunch cleared it. Stamp each read and drop any reply that a newer read has
  // already superseded.
  const identSeq = useRef(0)
  async function loadIdentity () {
    const seq = ++identSeq.current
    try {
      const r = await call('identity')
      if (seq === identSeq.current) setIdent(r)
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

  // The photo, with the settings mirror kept in step - see onPickFile in Settings.
  async function saveAvatar (base64) {
    await call('setAvatar', { avatar: base64 })
    setState(s => ({ ...s, settings: { ...(s.settings || {}), avatar: base64 } }))
  }

  async function saveIdentity ({ deviceName, userName }) {
    const r = await call('setIdentity', { deviceName, userName })
    // A SAVE is newer than any read issued before it, so retire those too: the host's reply here
    // is authoritative, and an identity read still in flight would otherwise land afterwards and
    // put the pre-save name back on screen.
    identSeq.current++
    setIdent(i => ({ ...i, ...r, supported: true }))
    // Keep the settings MIRROR in step. It is what openAddLibrary prefills from, so leaving it
    // stale meant adding a library carried the OLD name back to the worklet and overwrote the
    // one you had just saved.
    setState(s => ({ ...s, settings: { ...(s.settings || {}), deviceName, userName } }))
    haptic('success')
    toast('Sent to the server')
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
  navRef.current = { scanning, donate, nudge, ownerTour, reqComposer, ownerPair, confirming, menu, viewing, expanded, stack, tab, host: state.host, obPhase, obOwner, addingLibrary }

  const canBack = !!(
    scanning || donate || nudge || ownerTour || reqComposer || ownerPair || confirming || menu || viewing || expanded ||
    stack.length || tab !== 'library' ||
    // On the onboarding wall there is no stack, but there are cards to walk back
    // through. At the intro there is nothing behind us, so the OS closes the app.
    (!state.host && obPhase !== 'intro') ||
    // Adding a library over the running app is a CARD, not a wall: there is always an app
    // behind it to go back to. It was missing here, so back fell through every layer and
    // Android closed the app instead - reported from demo mode (the Connect button), but it
    // was equally true of Settings > Libraries > Add on a paired phone.
    addingLibrary
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
    // Backing out of the nudge is a "maybe later" - it counts as answered, or it
    // would greet you again next launch. Same as tapping Maybe later.
    if (n.nudge) { call('setSettings', { donationNudgeShown: true }).catch(() => {}); return setNudge(false) }
    // Backing out of the owner tour counts as "got it" - one-shot, don't re-greet.
    if (n.ownerTour) return finishOwnerTour(false)
    if (n.reqComposer) return setReqComposer(null)
    if (n.ownerPair) return stopOwnerPair()
    if (n.confirming) return setConfirming(null)
    if (n.scanning) return setScanning(false)
    if (n.expanded) return setExpanded(false)
    // Adding a library over the running app: one card, and behind it the app. Cancel back
    // into it rather than letting the press fall through to the OS.
    if (n.addingLibrary) return cancelAddLibrary()
    // The onboarding wall walks its cards back. On "whose library" an answer is
    // undone first, so back returns you to the two choices rather than skipping
    // the whole card.
    if (!n.host) {
      if (n.obPhase === 'pair') return setObPhase('whose')
      if (n.obPhase === 'whose') return n.obOwner ? setObOwner(null) : setObPhase('names')
      if (n.obPhase === 'names') return setObPhase('intro')
      return
    }
    // Through pop() and not a bare setStack, so a hardware Back restores the scroll of
    // the screen it returns to exactly as the on-screen Back button does.
    if (n.stack.length) return pop()
    if (n.tab !== 'library') {
      pendingScrollRef.current = 0
      setTab('library')
      window.scrollTo(0, 0)
      return
    }
  }), [])

  // BACKSTOP, not the mechanism. host:connected / host:disconnected are what
  // normally end the first attempt; this only covers an event that never arrives.
  // Sized well past the worklet's own 20s first-connect wait (ACTIVE_CONNECT_WAIT_MS)
  // so a legitimately slow off-LAN connect is never called a failure early - the
  // wall lying in the other direction is the same bug with the sign flipped.
  useEffect(() => {
    if (!firstConnect) return
    const t = setTimeout(() => setFirstConnect(false), 45000)
    return () => clearTimeout(t)
  }, [firstConnect])

  // PER-LEVEL SCROLL MEMORY. One offset per level of the nav stack: index 0 is the
  // tab's own screen, index n the nth drill-down. Opening a screen banks where you
  // were and starts the new one at the top; Back puts the old offset back. Without
  // it, drilling into an album from halfway down the grid and pressing Back returned
  // you to the top of the grid, so finding your place again was manual every time.
  //
  // In memory only, deliberately: the launch snapshot (src/ui/viewstate.js) already
  // persists the offset of the screen you are ON, and persisting the whole ladder
  // would restore offsets for screens whose data may no longer exist.
  const scrollMemRef = useRef([])
  const stackRef = useRef([]); stackRef.current = stack

  // Emptying the stack empties the ladder, whatever emptied it. EIGHT paths reset the
  // stack wholesale (a library switch, unpair, leaving demo, a merged rebuild, the
  // owner shortcut...), and clearing at each of them is a list somebody will one day
  // add to and forget. This holds the invariant instead: a saved offset describes one
  // visit to one screen, so once you are back at a tab root nothing is owed.
  useEffect(() => { if (!stack.length) scrollMemRef.current = [] }, [stack.length])

  const push = (screen) => {
    haptic('light')
    scrollMemRef.current[stackRef.current.length] = window.scrollY || 0
    setStack(s => [...s, screen])
    // A new screen starts at the top. It usually looked like it did anyway, because a
    // short screen clamps the carried-over offset to zero - but a long one (an artist
    // with many albums) would have opened part-way down.
    pendingScrollRef.current = 0
    window.scrollTo(0, 0)
  }

  const pop = () => {
    const level = Math.max(0, stackRef.current.length - 1)
    setStack(s => s.slice(0, -1))
    // Top first, then chase: the screen we are returning to may re-fetch its own data,
    // so it can be too short to hold the old offset for a moment (restoreScroll polls).
    // Landing at the top and moving down beats landing part-way and jumping. Clearing
    // the pending target first means a launch restore still in flight does not outlive
    // the navigation that overtook it.
    pendingScrollRef.current = 0
    window.scrollTo(0, 0)
    restoreScroll(scrollMemRef.current[level] || 0)
  }

  // A tab is a fresh start, so it drops any drill-down under it - and with it the
  // scroll ladder, which belonged to that tab's stack. Entering "You" kicks off the
  // active collection's fetch (each loader guards on its own cache).
  const goTab = (k) => {
    haptic('light')
    pendingScrollRef.current = 0
    setStack([]); setTab(k)
    window.scrollTo(0, 0)
    if (k === 'you') openYou(youView)
  }

  // Open a "You" sub-view, loading it. Favorites is the default, but an old host with
  // no favorites support has only Most Played, so fall through to it rather than land
  // on an empty, unswitchable Favorites list.
  const openYou = (v) => { haptic('light'); openYouView(v) }
  // The same dispatch WITHOUT the haptic, for the launch restore: a phone that buzzes
  // in your hand while it is only putting the screen back is reporting an input that
  // never happened.
  const openYouView = (v) => {
    if (v === 'downloads') showDownloads()
    else if (v === 'requests') showRequests()
    else if (v === 'manage') showManage()
    else if (v === 'playlists') showPlaylists()
    else if (v === 'top' || !favSupported) showMostPlayed()
    else showFavorites()
  }

  // --- where you were --------------------------------------------------------
  //
  // Coming back to PearTune must land you where you left off. It does not today
  // because the app reloads its OWN WebView after 20s in the background (the
  // Vanadium freeze recovery in app/index.tsx), which is a cold document - so the
  // tab, the drill-down and the scroll are gone on every stock-Android phone, not
  // just on GrapheneOS. src/ui/viewstate.js carries the measurement and the rules;
  // this is the plumbing.
  //
  // Read through a ref rather than the effect's closure: the scroll listener
  // registers once and must still see the current tab.
  const viewRef = useRef({})
  viewRef.current = { tab, browse, youView, filter, stack, expanded }
  const viewSavedRef = useRef(null) // last snapshot written, so an idle scroll is not a write
  const viewReadyRef = useRef(false) // nothing is persisted until the restore has run
  const viewTimer = useRef(null)
  const pendingScrollRef = useRef(0) // a restore target still waiting for its content
  const pendingExpandedRef = useRef(false) // ditto, waiting for the shell to re-announce the track

  // Snapshot on a trailing debounce. Navigation coalesces (a tab tap that drops a
  // stack is two state changes, one write) and scrolling writes once you stop, not
  // once a frame.
  function scheduleViewSave (delay) {
    if (!viewReadyRef.current) return
    clearTimeout(viewTimer.current)
    viewTimer.current = setTimeout(() => {
      // While a restore is still chasing its target, the live scroll is 0 and would
      // overwrite the position we are in the middle of putting back.
      const scroll = pendingScrollRef.current || window.scrollY || 0
      const v = normalizeViewState({ ...viewRef.current, scroll })
      if (sameViewState(v, viewSavedRef.current)) return
      viewSavedRef.current = v
      call('setSettings', { view: v }).catch(() => {})
    }, delay)
  }

  useEffect(() => { scheduleViewSave(200) }, [tab, browse, youView, filter, stack, expanded])
  useEffect(() => {
    const onScroll = () => scheduleViewSave(600)
    // A finger on the screen ends any restore still in flight. Touch is the one signal
    // that separates "the user is scrolling" from "we are putting the scroll back" -
    // our own scrollTo fires the scroll event but never this one - and without it a
    // restore that arrives late would yank the page out from under someone.
    const onTouch = () => { pendingScrollRef.current = 0 }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('touchstart', onTouch, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('touchstart', onTouch)
      clearTimeout(viewTimer.current)
    }
  }, [])

  // Put the scroll back once the screen is tall enough to hold it. Its data arrives
  // asynchronously (and a drill-down fetches its own), so this polls rather than
  // firing once and landing at the top. The deadline stops it chasing a target that
  // will never be reachable - a shorter album, or a screen that failed to load - and
  // settles for as far down as the content actually goes.
  function restoreScroll (target) {
    if (!target) return
    pendingScrollRef.current = target
    const deadline = Date.now() + 8000
    const tick = () => {
      if (!pendingScrollRef.current) return // a real scroll or a nav change took over
      const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
      if (max >= target) { window.scrollTo(0, target); pendingScrollRef.current = 0; return }
      if (Date.now() > deadline) { window.scrollTo(0, max); pendingScrollRef.current = 0; return }
      setTimeout(tick, 120)
    }
    setTimeout(tick, 60)
  }

  // The full-size player only exists while something is playing, and `now` comes back
  // from the shell a beat after the reload. Holding the restored size until it lands
  // matters for more than looks: `canBack` counts `expanded`, so setting it with
  // nothing playing would render nothing at all while still swallowing a back press.
  useEffect(() => {
    if (!pendingExpandedRef.current || !now) return
    pendingExpandedRef.current = false
    setExpanded(true)
  }, [now])

  // Apply the snapshot from settings.json. Returns it so init() can skip the album
  // load when the restored view is not the album grid. Call it BEFORE that load: the
  // source filter is read from filterRef, so setting it here is what makes the first
  // browse call ask the right library instead of asking twice.
  function restoreView (s) {
    const v = normalizeViewState(s.settings?.view)
    viewSavedRef.current = v
    viewReadyRef.current = true
    // No library yet means the pairing wall, which has no tabs to put back.
    if (!v || !s.host || isDefaultView(v)) return null
    // A filter naming a library that is no longer paired would browse an empty list
    // under a chip that is not there, so it falls back to the blend.
    const libs = s.merged?.libraries || []
    if (v.filter !== '_all' && libs.some(l => l.libraryId === v.filter)) {
      filterRef.current = v.filter
      setFilter(v.filter)
      // The WORKLET holds the filter too (it routes streaming), and it SURVIVES a
      // WebView reload - so on that path this is a no-op, and on a cold start it is
      // what stops playback resolving to a different library than the one on screen.
      call('setLibraryFilter', { libraryId: v.filter }).catch(() => {})
    }
    if (v.tab !== 'library') setTab(v.tab)
    if (v.tab === 'you') openYouView(v.youView)
    if (v.stack.length) setStack(v.stack)
    if (v.expanded) pendingExpandedRef.current = true
    // Artists / genres / songs each load their own list. Albums is the default and
    // init() loads it, so it is the one view this must NOT ask for twice.
    //
    // A launch with nothing to read from (no connection, no cached blend) DELIBERATELY
    // drops back to Albums rather than restoring the view: setting `browse` without a
    // loader would leave an empty Songs list that only a manual tap could fill, since
    // the single-host reconnect path reloads albums and not the current view.
    if (v.browse !== 'albums' && (s.connected || s.merged?.merged)) {
      if (v.browse === 'artists') showArtists()
      else if (v.browse === 'genres') showGenres()
      else showSongs()
    }
    restoreScroll(v.scroll)
    return v
  }

  // STORE-SCREENSHOT SCENES, and the same exception `busy` above makes. Nearly all of a scene
  // arrives as DATA: the canned init answer carries a `settings.view`, and restoreView right
  // above puts the app on that screen by the ordinary relaunch path - so no screen knows scenes
  // exist and none can drift from what ships. Two things have no data path in. The full-size
  // player only exists once a track is PLAYING, which is an event from the shell; and the pairing
  // sheet is local state here. runScene fires the first and is handed the second, which is why
  // this is one guarded read rather than a scene number threaded through the tree.
  //
  // Guarded on the injected global, so an ordinary launch - every launch that is not the capture
  // script - never reaches the call at all.
  useEffect(() => {
    if (!window.__pearScreenshotScene || state.loading) return
    runScene({ openOwnerPair })
  }, [state.loading])

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
    haptic('light')
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
    // In merged mode the shelf mixes each host's own recently-added (round-robin, deduped); in
    // single-host it's the one host's 'added' sort. Either way it follows the library you picked -
    // the shelf used to ignore the filter and show the whole blend under a one-library grid.
    try {
      const page = mergedRef.current?.merged
        ? await call('recentMerged', { limit: 12, libraryId: filterRef.current })
        : await call('albums', { sort: 'added', order: 'desc', limit: 12 })
      setRecent(recentEnough(page.items || []))
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

  // The favorites changed underneath the Favorites view - because another of this person's devices
  // changed one, or because a host joined the blend and brought its own rows.
  //
  // If that view is the one being LOOKED AT, refetch IN PLACE, leaving the current rows on screen
  // until the new ones land. Setting favItems to null is what the callers used to do, and on a
  // screen that is already open it is a trap: null renders <SkeletonRows/>, and the only thing
  // that refetches is OPENING the view - so it sat on ghost shells until you navigated out and
  // back in (Tim, 2026-07-30, on the first version of the favorites push). Null is still right
  // when nobody is looking: it makes the next open fetch fresh, without fetching rows for a screen
  // that is not on screen.
  //
  // On failure, fall back to null rather than keeping rows we now know are stale - a wrong list
  // that looks authoritative is worse than a spinner.
  async function refreshFavItems () {
    if (!favItemsRef.current || youViewRef.current !== 'favorites') { setFavItems(null); return }
    try {
      const r = await call('favoriteItems')
      setFavItems({ tracks: r.tracks || [], albums: r.albums || [], artists: r.artists || [] })
    } catch {
      setFavItems(null)
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
  // The requester's OWN requests (You > Requests). Merged mode unions + collapses across
  // hosts in the worklet; supported:false hides the tab (an old host, like favorites).
  async function loadRequests (force) {
    if (myRequests && !force) return
    try {
      const r = await call('requestList')
      setMyRequests(r.requests || [])
      if (r.supported === false) setReqSupported(false)
    } catch { setMyRequests(m => m || []) }
  }
  async function showRequests () {
    setYouView('requests')
    // ALWAYS refetch on open, like Manage does. loadRequests early-returns when the list is
    // already loaded, and showRequests used to pass no force - so your own Requests screen was
    // fetched once per app session and never again, and a request resolved in between kept its
    // old status colour every time you opened it. The list is small and this is a tap, not a
    // heartbeat. It sets in place rather than clearing, so there is no skeleton flash.
    await loadRequests(true)
  }
  // Owner: the active library's devices + request queue (You > Manage). Reloads each open -
  // a revoke, a resolve or a new pair should show promptly, and the lists are small.
  // Every owner load/action acts on the library currently selected in Manage (manageLibRef), so
  // an owner of several manages each in turn. Undefined libraryId = the active one (worklet default).
  async function loadOwnerDevices (libId = manageLibRef.current) {
    try { setOwnerDevices((await call('ownerDevices', { libraryId: libId })).devices || []) } catch { setOwnerDevices(d => d || []) }
  }
  // The request queue is the ONE part of Manage that is not per-library: an ask fans out to every
  // library, so the owner's queue aggregates back across every library they own (no libraryId -
  // the worklet unions + folds). That is also why the picker does not reload it.
  async function loadOwnerReqs () {
    try {
      const list = (await call('ownerRequests')).requests || []
      setOwnerReqs(list)
      setOwnerPending(list.filter(r => r.status === 'pending').length)
    } catch { setOwnerReqs(r => r || []) }
  }
  // The You-tab badge count, kept fresh without opening Manage: loaded when this device is a
  // confirmed owner and connected, and again on a request:new push. Non-owners never fetch it.
  async function refreshOwnerPending () {
    if (!identRef.current?.owner) { setOwnerPending(0); return }
    try { setOwnerPending(((await call('ownerRequests')).requests || []).filter(r => r.status === 'pending').length) } catch {}
  }
  async function showManage () {
    setYouView('manage')
    setOwnerDevices(null); setOwnerReqs(null)
    // Which libraries do I own AND can reach? Default the picker to the active one if I own it,
    // else the first owned; keep a prior valid selection across reopens.
    let libs = []
    try { libs = (await call('ownedLibraries')).libraries || [] } catch {}
    setOwnedLibs(libs)
    const lib = (manageLibRef.current && libs.some(l => l.libraryId === manageLibRef.current))
      ? manageLibRef.current
      : (libs.find(l => l.active)?.libraryId || libs[0]?.libraryId || null)
    setManageLib(lib); manageLibRef.current = lib
    await Promise.all([loadOwnerDevices(lib), loadOwnerReqs()])
  }
  // Switch which owned library Manage is acting on. Devices + pairing are per-library; the request
  // queue above them is the aggregate, so it stays put rather than reloading on every switch.
  async function switchManageLib (libId) {
    if (libId === manageLibRef.current) return
    haptic('light')
    setManageLib(libId); manageLibRef.current = libId
    setOwnerDevices(null)
    await loadOwnerDevices(libId)
  }
  async function revokeOwnerDevice (deviceKey) {
    const r = await call('ownerRevoke', { libraryId: manageLibRef.current, deviceKey }).catch(() => null)
    haptic(r?.ok ? 'warn' : 'light')
    if (!r?.ok) toast('Could not revoke that device', true)
    loadOwnerDevices()
  }
  // Resolve a request from the owner phone (P2b). Optimistic: reflect it now, reload to confirm.
  // The row is a COLLAPSED ask, so it carries `refs` - every (libraryId, id) copy the fan-out
  // created - and resolving clears the pending copy on each, not just the library in view.
  async function resolveOwnerRequest (row, status) {
    haptic('light')
    // Optimistic: reflect the new status AND drop the badge now (a pending row is being cleared),
    // then reload to confirm. loadOwnerReqs recomputes the count from truth, so a failed call or a
    // race self-corrects.
    setOwnerReqs(list => (list || []).map(r => r.id === row.id ? { ...r, status } : r))
    setOwnerPending(n => Math.max(0, n - 1))
    const r = await call('ownerResolveRequest', { id: row.id, libraryId: row.libraryId, refs: row.refs, status }).catch(() => null)
    if (!r?.ok) toast('Could not update that request', true)
    // A library that was offline keeps its copy pending. Say so rather than letting the row
    // quietly reappear on the next read looking like the tap did not take.
    else if (r.partial) toast(`Cleared on ${r.resolved} of ${r.total} libraries`)
    loadOwnerReqs()
  }
  // Open a pairing window remotely so the owner can let a device in while away (P2b). The
  // returned link is shared/copied; a device pairs through it. Stop closes the window.
  async function openOwnerPair () {
    haptic('light')
    const r = await call('ownerPairStart', { libraryId: manageLibRef.current }).catch(() => null)
    if (!r?.ok || !r.link) return toast('Could not open a pairing window', true)
    setOwnerPair({ link: r.link })
  }
  async function stopOwnerPair () {
    setOwnerPair(null)
    call('ownerPairStop', { libraryId: manageLibRef.current }).catch(() => {})
    loadOwnerDevices() // a device may have paired through it
  }
  // Remove one of MY requests - a completed one I'm done with, or a pending one I want to
  // withdraw. Optimistic (drop it from the list now); the host refuses anything not mine.
  async function removeRequest (row) {
    haptic('light')
    setMyRequests(list => (list || []).filter(r => r !== row))
    const r = await call('requestDelete', { refs: row.refs }).catch(() => null)
    if (!r?.ok) { toast('Could not remove that request', true); loadRequests(true) }
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

  const promptNewPlaylist = () => { haptic('light'); setNaming(true) }

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
  // Same worklet-settings home as density and the theme, so it survives a relaunch.
  function setShowRecentValue (v) {
    haptic('light')
    setShowRecent(v)
    call('setSettings', { showRecent: v }).catch(() => {})
  }

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
    // SONGS and GENRES filter what is already loaded, client-side (instant, works offline) - so no
    // server round-trip there (the server search returns no genres anyway). Albums/Artists still
    // search the whole library server-side. The Library render does the actual filtering off `query`.
    if (!q.trim() || browse === 'songs' || browse === 'genres') return setResults(null)
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
      // demo:false - a real library exists now, so the worklet has already retired the bundled
      // one (see the retireDemo call in pair()). Leaving the flag set here would keep the "Demo
      // music" banner over somebody's actual collection.
      setState(s => ({ ...s, host, connected: true, hosts: hosts || s.hosts, demo: false }))
      // Adding a second library while one was active: clear the previous library's browse so
      // the new active one loads fresh (a no-op on a first pair).
      setAlbums([]); setArtists(null); setAlbumsLoaded(false); setStack([]); setResults(null); setQuery('')
      const cameFromAdd = addingLibrary // captured before the flag is cleared, for the toast wording
      setAddingLibrary(false)
      // A successful pair should always land on the Library, not drop back to Settings (where the
      // add-a-library flow was launched from). Harmless on a first pair (already there).
      setTab('library')
      // Visible confirmation, not just the haptic below. An owner promotion of a library we were
      // already on gets its own line (and the owner tour fires off the identity re-read below);
      // an owner code that did NOT take must say so rather than leaving you silently a normal device.
      if (host.promoted) toast(`You’re now an owner of ${host.libraryName || 'this library'}`)
      else if (host.ownerFailed) toast('Could not make this device an owner - the owner window may have closed. Open a new one on the dashboard and scan again.', true)
      else toast(`${cameFromAdd ? 'Added' : 'Paired with'} ${host.libraryName || 'library'}`)
      // pair() now sends the claim, so the host may ALREADY have confirmed us (a brand-new name
      // auto-creates its person). Re-read the identity or Settings would sit on "Waiting for your
      // server to confirm you are X" until the next reconnect, which is exactly the stale banner
      // this pass set out to kill.
      loadIdentity()
      haptic('success')
      // A pair added (or restored) a library. With 2+ libraries the app is the merged blend: enter it
      // if we weren't already, else FORCE a rebuild to fold the new/returned host in now (an explicit
      // pair must not wait on the rebuild cooldown). Otherwise it's single-host - load normally.
      if ((hosts || []).length >= 2) {
        filterRef.current = '_all'; setFilter('_all')
        call('setLibraryFilter', { libraryId: '_all' }).catch(() => {})
        const st = mergedRef.current?.merged
          ? await call('refreshMerged', { force: true }).catch(() => null)
          : await call('enterMerged').catch(() => null)
        if (st?.libraries) setMerged(st)
        reloadBrowse()
      } else {
        loadAlbums(0)
      }
      // AFTER the blend has been rebuilt (so the new host is in the pool), re-read the hearts.
      // In merged mode they are the union of every CONNECTED host's favorites, and the pool only
      // comes up during the rebuild above - so a pair that ADDS a host, or a RE-pair that brings
      // one back with its favorites, would otherwise leave every heart hollow until the next
      // relaunch. The resolved Favorites list is dropped too: it is missing that host's rows.
      loadFavs()
      setFavItems(null)
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
  // "Try it without a server" (proposal 2026-07-28-app-review-demo). Turns on the bundled demo
  // library: five CC0 tracks that play with no host, no pairing and no network at all.
  //
  // The shell does the resolving (only it can reach the app's own assets) and the worklet does
  // the installing; from here it looks like a library appearing. Everything after the await is
  // the same wake-up the app does on a real connect, minus the parts that need a server.
  async function startDemo () {
    if (demoStarting) return
    haptic('light')
    setError(null)
    setDemoStarting(true)
    try {
      // PERSIST THE NAME FIRST. It was typed on the card before this one and, on the pairing
      // path, would ride straight into pair(). The demo path has no pair() to carry it, so
      // without this it lives only in React state - and Connect (or a relaunch) would find a
      // device that has been using the app for an hour and still cannot say who it belongs to.
      const n = pairNamesRef.current
      if (n.userName.trim() || n.deviceName.trim()) {
        await call('setSettings', { userName: n.userName.trim(), deviceName: n.deviceName.trim() }).catch(() => {})
      }
      const r = await call('shell:enableDemo')
      let hosts = null
      try { hosts = (await call('listHosts')).hosts } catch {}
      setState(s => ({
        ...s,
        demo: true,
        host: r.host,
        hosts: hosts || [r.host],
        connected: true,
        shimPort: r.shimPort,
        artBase: r.artBase
      }))
      setTab('library')
      loadAlbums(0)
      loadSource()
      loadFavs()
      haptic('success')
    } catch (e) {
      setError(e.message)
      haptic('warn')
    } finally {
      setDemoStarting(false)
    }
  }

  // Leave demo mode by hand (Settings). Gives the ~18 MB back and puts the app on the pairing
  // wall, which is where a device with no library belongs. Pairing a real server does this by
  // itself - this is for someone who tried the demo, decided against it, and wants the space.
  async function leaveDemo () {
    haptic('light')
    try {
      // Stop FIRST. The files are about to be deleted out from under the player, and a player
      // left pointing at a loopback URL whose bytes have gone just stalls.
      await call('stop').catch(() => {})
      await call('disableDemo')
      setState(s => ({ ...s, demo: false, host: null, hosts: [], connected: false }))
      setObPhase('intro')
      setObOwner(null)
      setStack([]); setAlbums([]); setArtists(null); setAlbumsLoaded(false); setResults(null); setQuery('')
      setTab('library')
      toast('Demo music removed')
    } catch (e) {
      setError(e.message)
      haptic('warn')
    }
  }

  function openAddLibrary () {
    haptic('light')
    // `ident` is the live identity (what Settings shows and what the last Save wrote); the
    // settings mirror is the fallback for the offline case where ident never loaded. Reading
    // the mirror FIRST is what let a stale copy ride through a pair and clobber the real name.
    //
    // ...and `p` last, because a DEMO user has neither: they named themselves on the onboarding
    // card and no host has ever confirmed it, so `ident` is null and the settings mirror is only
    // as good as the write that saved it. Falling back to what is already in hand means Connect
    // from demo mode can never blank a name the person typed two cards ago.
    setPairNames(p => ({
      deviceName: ident?.deviceName || state.settings?.deviceName || p.deviceName || '',
      userName: ident?.userName || state.settings?.userName || p.userName || ''
    }))
    setError(null); setScanning(false); setAddingLibrary(true)
  }

  // Leave the add-a-library card without pairing, back into the running app. Android back
  // calls this too - see the 'back' listener, where its absence is what closed the app.
  function cancelAddLibrary () {
    setError(null)
    setScanning(false)
    setAddingLibrary(false)
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

  // YOUR OWN name for a library (proposal 2026-07-27-local-library-alias). A library is named by
  // the machine it lives on, so a friend's default "My Library" was un-relabellable until now.
  // Blank clears it and the row goes back to whatever the server currently calls it. Local to
  // this phone: the alias is never sent to a host.
  async function saveLibraryAlias (hostKey, alias) {
    haptic('light')
    try {
      const r = await call('setLibraryAlias', { hostKey, alias })
      setState(s => ({
        ...s,
        hosts: r.hosts,
        // The active library's own header/label lives on state.host, which listHosts does not
        // replace - so re-point it or the header keeps the pre-alias name until the next switch.
        host: s.host ? { ...s.host, ...(r.hosts.find(h => h.hostKey === s.host.hostKey) || {}) } : s.host
      }))
    } catch (e) { setError(e.message) }
  }

  // Flip one library's relay-audio consent from Settings (proposal 2026-07-29). Always
  // REMEMBERED - a deliberate trip to Settings is a standing decision, unlike the prompt
  // where the checkbox governs it. Local to this phone, like the alias.
  async function saveRelayAudio (libraryId, value) {
    haptic('light')
    try {
      const r = await call('setRelayAudio', { libraryId, value, remember: true })
      if (r?.hosts) setState(s => ({ ...s, hosts: r.hosts }))
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
          // The hearts and the Favorites list still hold that library's ids. Drop them: leaving
          // them would show favorites for a library this device no longer follows, and it also
          // keeps the blend's view of "what is favorited" honest for the next join.
          loadFavs()
          setFavItems(null)
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

  // --- Home Assistant speakers (proposal 2026-08-01) ------------------------
  //
  // Asked once per connect, and only ever answered for an OWNER of a host that has
  // Home Assistant set up. Every other case (old host, non-owner, unconfigured,
  // offline) collapses to an empty list, which is what hides the button - so there
  // is no state in which a speaker control appears and then fails when tapped.
  async function loadSpeakers () {
    try {
      const r = await call('speakerList')
      // Drop speakers Home Assistant reports as `unavailable` - it cannot reach them, so
      // offering one is offering a tap that fails. `off` is deliberately kept: play_media
      // wakes a Cast device that is merely off, and hiding those would hide most of a house.
      const list = (r?.speakers || []).filter(s => s.state !== 'unavailable')
      setSpeakers(r?.enabled ? list : [])
      // Re-attach to a cast this device already had running: the app can be closed and
      // reopened while a speaker plays, and the host still knows about it. And CLEAR one
      // that has since ended - this used to only ever set, so the cast icon could stay
      // lit over nothing after a reconnect (review finding 5). The host is the authority
      // on what is playing; do not second-guess it from local state.
      const mine = (r?.active || [])[0]
      setCastingTo(mine ? mine.entityId : null)
      if (!mine) setCastPaused(false)
    } catch {
      setSpeakers([])
    }
  }

  // CASTING IS A MODE OF THE PLAYER, NOT A SECOND PLAYER (proposal 2026-08-02).
  //
  // The shell's ExoPlayer stays the brain: it owns the queue, the shuffle ORDER, the
  // repeat mode and what "next" means. Cast mode only takes away its voice. So every
  // track change - a tap in the queue, Next, Previous, an automatic advance, a shuffled
  // pick - arrives here the same way, as `play:started`, and we forward THAT to the
  // speaker.
  //
  // Phase 1 walked the queue with its own integer cursor instead, which is why a
  // shuffled queue cast in file order. That cursor is gone; this is less code.
  async function castCurrent (trackId) {
    if (!castingToRef.current || !trackId) return
    const r = await call('speakerPlay', { entityId: castingToRef.current, trackId })
    if (!r?.ok) {
      setError(r?.error || 'could not play on that speaker')
      await castHere()
    }
  }

  async function castTo (entityId) {
    setSpeakerBusy(true)
    try {
      // Mute and hold the phone BEFORE the speaker starts. Two copies of the same song a
      // room apart is the worst outcome here, so it must not depend on ordering luck.
      // The shell needs the entity: a lock-screen press arrives there, not here.
      await call('castMode', { on: true, entityId }).catch(() => {})
      setCastingTo(entityId)
      castingToRef.current = entityId
      // Whatever is loaded right now is what the speaker should pick up. `now` is the
      // shell's own announcement of the current track, so it already reflects shuffle.
      const trackId = nowRef.current?.trackId
      if (trackId) await castCurrent(trackId)
      setSpeakerOpen(false)
    } finally {
      setSpeakerBusy(false)
    }
  }

  // Back to the phone: silence the speaker, then give this player its voice back. The
  // track RESTARTS rather than resuming mid-song - the speaker reports no position of
  // its own, so there is no honest place to resume from (proposal, open question 3).
  async function castHere () {
    const entityId = castingToRef.current
    setCastingTo(null)
    castingToRef.current = null
    setSpeakerOpen(false)
    if (entityId) await call('speakerStop', { entityId }).catch(() => {})
    await call('castMode', { on: false }).catch(() => {})
  }

  // The host saw the track finish. Ask the SHELL for the next one rather than working it
  // out here: it honours shuffle and repeat, and its play:started brings us back to
  // castCurrent. Nothing in this path knows what shuffle is, which is the point.
  async function castNext () {
    await call('next').catch(() => {})
  }

  // Play/pause while casting drives the SPEAKER. Without this the button fell through to
  // the phone and started a second stream (the review's worst finding).
  async function castToggle () {
    const entityId = castingToRef.current
    if (!entityId) return
    const method = castPausedRef.current ? 'speakerResume' : 'speakerPause'
    setCastPaused(!castPausedRef.current)
    const r = await call(method, { entityId })
    if (!r?.ok) setCastPaused(castPausedRef.current) // put the icon back if it did not take
  }

  // The player's X: stop PLAYBACK only, and KEEP the queue. The bar hides (play:stopped),
  // the queue stays in the Queue tab, and tapping a track there resumes it.
  function stopPlayback () {
    haptic('light')
    // While casting, the X has to stop the SPEAKER as well. Without this it stopped a
    // phone that was already silent and left the room playing, with nothing left in the
    // app that would ever stop it (review finding 3).
    if (castingToRef.current) castHere()
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
  const confirmClearQueue = () => { haptic('light'); setConfirming({
    title: 'Clear the queue?',
    body: now
      ? 'Everything up next is removed. The current song keeps playing.'
      : 'The whole queue is removed.',
    danger: true,
    yes: 'Clear',
    onYes: clearQueue
  }) }

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
        <Onboarding
          // The last card only: this device is already named and already claims a user, so
          // there is nothing left to introduce or ask. That now holds for DEMO MODE too - the
          // naming card comes before the demo choice, so a demo user reached the library having
          // already given a name (Tim, 2026-07-28). Hence addHost unconditionally: it is what
          // says "do not re-ask", and gating Scan QR on a name we already have would disable the
          // button with nothing on screen explaining why.
          addHost
          // ...but a demo user's server is their FIRST, not an added one, so the copy differs.
          firstServer={!!state.demo}
          phase='pair'
          setPhase={() => {}}
          owner={null}
          setOwner={() => {}}
          names={pairNames}
          setNames={setPairNames}
          onScan={() => { setError(null); setScanning(true) }}
          onPaste={(link) => onPaired(link, pairNames)}
          onCancel={cancelAddLibrary}
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
        <Onboarding
          phase={obPhase}
          setPhase={setObPhase}
          owner={obOwner}
          setOwner={setObOwner}
          names={pairNames}
          setNames={setPairNames}
          // Clear any stale error when opening the scanner - a failure from a
          // PREVIOUS attempt must not greet you on the fresh one.
          onScan={() => { setError(null); setScanning(true) }}
          onPaste={(link) => { setPendingLink(null); onPaired(link, pairNames) }}
          // The way out of the pairing wall for someone with no server yet.
          onDemo={startDemo}
          demoStarting={demoStarting}
          // A pear:// link this device was opened with. Turns the naming card's
          // Continue into "Pair" and pre-fills the paste box, so following a link
          // never asks you to go and find the link you just followed.
          pendingLink={pendingLink}
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
        // No Download in demo mode (a null onPin hides the button). Downloading means "pull
        // these bytes off the server and keep them", and the demo album is already on the
        // phone with no server behind it - the control would offer to do something that is
        // both impossible and already done.
        onPin={state.demo ? null : () => pinAlbum(top.id)} onUnpin={() => unpinAlbum(top.id)}
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
          key={top.id} id={top.id} name={top.name} now={now} onBack={pop} refreshKey={plRefresh}
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
        reqSupported={reqSupported} myRequests={myRequests}
        onNewRequest={() => { haptic('light'); setReqComposer({ name: '' }) }}
        onRemoveRequest={removeRequest}
        isOwner={!!ident?.owner}
        ownerLibraryName={ownedLibs.find(l => l.libraryId === manageLib)?.libraryName || ident?.libraryName || state.host?.libraryName}
        ownedLibs={ownedLibs} manageLib={manageLib} onSwitchManageLib={switchManageLib}
        ownerDevices={ownerDevices} selfKey={state.deviceKeyZ32} onRevokeDevice={revokeOwnerDevice}
        ownerReqs={ownerReqs} onResolveRequest={resolveOwnerRequest} onOwnerPair={openOwnerPair} onToast={toast}
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
        ident={ident} onRefreshIdentity={loadIdentity} onSaveIdentity={saveIdentity} onSaveAvatar={saveAvatar} onQuality={changeQuality}
        onArtRefreshed={onArtRefreshed}
        skin={skin} onSkin={setSkinValue} showRecent={showRecent} onShowRecent={setShowRecentValue}
        onSwitchHost={switchLibrary} onRemoveHost={removeLibrary} onAddLibrary={openAddLibrary}
        onDisableDemo={leaveDemo}
        onSetAlias={saveLibraryAlias}
        onSetRelayAudio={saveRelayAudio}
      />
    )
  } else if (tab === 'about') {
    screen = <About onDonate={() => setDonate(true)} deviceKey={state.deviceKeyZ32 || state.deviceKey} />
  } else {
    screen = (
      <Library
        state={state} albums={albums} artists={artists} genres={genres} songs={songs} recent={recent} showRecent={showRecent}
        merged={merged} filter={filter} onFilter={pickFilter} onAddLibrary={openAddLibrary}
        cursor={cursor} songCursor={songCursor} density={density}
        browse={browse} query={query} results={results} now={now} error={error}
        onDismissError={() => setError(null)}
        albumsLoaded={albumsLoaded} reconnecting={reconnecting} firstConnect={firstConnect} updating={busy}
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
        onDisplay={() => { haptic('light'); setDisplay(true) }}
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
        onRequest={reqSupported ? (name => { haptic('light'); setReqComposer({ name: name || '' }) }) : null}
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
            canCast={!!(speakers && speakers.length)} castingTo={castingTo}
            castPaused={castPaused} onCastToggle={castToggle}
            onSpeakers={() => { loadSpeakers(); setSpeakerOpen(true) }}
          />
        )}
        {/* The navbar stays put during a drill-down, unlike PearList's (which
            hides it inside a list). A music app's dock is fixed furniture: the
            player sits on top of it, and dropping the navbar under an album would
            make the player jump down the screen mid-song. */}
        <NavBar active={tab} onTab={goTab} queued={status?.queueLength ?? 0} youBadge={ownerPending} />
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
      {speakerOpen && (
        <SpeakerSheet
          speakers={speakers || []}
          castingTo={castingTo}
          busy={speakerBusy}
          onClose={() => setSpeakerOpen(false)}
          onPick={castTo}
          onHere={castHere}
        />
      )}
      {sleepOpen && (
        <SleepSheet
          sleep={sleep}
          onClose={() => setSleepOpen(false)}
          onPick={(opts) => { call('sleep', opts).catch(() => {}); setSleepOpen(false) }}
        />
      )}
      {donate && <DonationSheet onClose={() => setDonate(false)} />}
      {ownerPair && <OwnerPairSheet link={ownerPair.link} toast={toast} onClose={stopOwnerPair} />}
      {reqComposer && (
        <RequestComposer prefill={reqComposer.name} toast={toast}
          onUnsupported={() => { setReqSupported(false); setReqComposer(null) }}
          onSent={() => loadRequests(true)}
          onClose={() => setReqComposer(null)} />
      )}
      {nudge && (
        <DonationNudge
          // Whichever button they press, it is answered - the nudge is one-shot.
          onDonate={() => { call('setSettings', { donationNudgeShown: true }).catch(() => {}); setNudge(false); setDonate(true) }}
          onDismiss={() => { call('setSettings', { donationNudgeShown: true }).catch(() => {}); setNudge(false) }}
        />
      )}
      {ownerTour && (
        <OwnerTour
          libraryName={ident?.libraryName || state.host?.libraryName}
          onShow={() => finishOwnerTour(true)}
          onDismiss={() => finishOwnerTour(false)}
        />
      )}
      {confirming && (
        <Confirm
          {...confirming}
          onClose={() => setConfirming(null)}
          onConfirm={() => { setConfirming(null); confirming.onYes() }}
        />
      )}
      {relayAsk && (
        <RelayConsentSheet
          libraryName={relayAsk.libraryName}
          onDecide={(value, remember) => {
            const { libraryId } = relayAsk
            setRelayAsk(null)
            call('setRelayAudio', { libraryId, value, remember })
              .then((r) => { if (r?.hosts) setState(s => ({ ...s, hosts: r.hosts })) })
              .catch(() => {})
            if (value === 'allow') toast('Press play again to start.')
          }}
          // Dismissing without choosing is NOT a decision, so the consent stays 'ask'. But
          // the worklet only raises this event ONCE per library (its relayAsked debounce),
          // so a bare dismiss would make every later play attempt fail with a 403 and NO
          // prompt - silently unplayable. Sending value 'ask' clears that debounce without
          // storing anything, so the next attempt asks again. Answering "Not now" is the
          // way to actually say no.
          onClose={() => {
            const { libraryId } = relayAsk
            setRelayAsk(null)
            call('setRelayAudio', { libraryId, value: 'ask', remember: false }).catch(() => {})
          }}
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
function NavBar ({ active, onTab, queued, youBadge = 0 }) {
  return (
    <nav className='navbar'>
      {TABS.map(({ key, label, Icon }) => {
        const on = active === key
        // Queue shows its track count; You shows an owner's unresolved-request count. A tab only
        // ever carries one badge, and no tab has both meanings.
        const badge = key === 'queue' && queued > 0 ? queued
          : key === 'you' && youBadge > 0 ? youBadge
          : null
        const badgeLabel = key === 'queue' ? `${badge} tracks` : `${badge} requests`
        return (
          <button
            key={key} className={on ? 'on' : ''} onClick={() => onTab(key)}
            aria-current={on ? 'page' : undefined}
            aria-label={badge ? `${label}, ${badgeLabel}` : label}
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

// The relay-audio consent prompt (proposal 2026-07-29-relay-audio-consent). Raised the
// FIRST time a library that is only reachable through PeerLoom's relay would stream
// audio, not at pairing: at pairing the user has not heard a note yet and cannot
// reasonably weigh it, and pairing is a handshake anyway - the megabytes are here.
//
// Two buttons plus a remember checkbox, TICKED BY DEFAULT (decisions 2 + 3): the default
// outcome of either button is the sticky one, and unticking is the session-only escape
// hatch that saves us a third button.
//
// The copy has to survive being read by someone who does not know what a relay is, and
// must not oversell: say what it can and cannot see, and that it stores nothing.
function RelayConsentSheet ({ libraryName, onDecide, onClose }) {
  const [remember, setRemember] = useState(true)
  const name = libraryName || 'this library'
  return (
    <div className='sheetwrap' onClick={onClose}>
      <div className='sheet' onClick={e => e.stopPropagation()}>
        <h1>Stream {name} through the relay?</h1>
        <p className='muted sm'>
          This network won’t let your phone reach {name} directly, so the music can only
          get here through a relay PeerLoom runs. It passes the audio along encrypted, so
          we can’t hear what you play, and it keeps no copy.
        </p>
        {/* Expectation-setting, not a funding appeal (Tim, 2026-07-29). One line here so a
            future slowdown is not a mystery and so "direct is better" is the obvious
            reading; the full story - what it costs, what happens if capacity or funding
            runs short - lives on /relay/, which the privacy page links. */}
        <p className='muted sm'>
          It’s shared and PeerLoom pays for it, so it can be slower when lots of people
          are using it, and it isn’t guaranteed.
        </p>
        <p className='muted sm'>
          Choose no and downloaded albums still play. You can change this any time in
          Settings under this library.
        </p>
        {/* Label LEFT, checkbox RIGHT, on ONE line - the same shape as every other
            toggle row in Settings, so it reads as a setting rather than a form field.
            .row is space-between, so order alone does the placement; nowrap is what
            stops "Remember for this library" wrapping under the box in the narrow sheet. */}
        <label className='row' style={{ cursor: 'pointer', flexWrap: 'nowrap' }}>
          <span className='label' style={{ whiteSpace: 'nowrap' }}>Remember for this library</span>
          {/* A Phosphor icon, not the browser's native checkbox - that renders as a
              platform-blue box with a generic tick and looks nothing like the rest of
              the app. role/aria-checked keep it a real checkbox for accessibility. */}
          <span
            role='checkbox' aria-checked={remember} tabIndex={0}
            style={{ flex: '0 0 auto', display: 'flex', color: remember ? 'var(--color-primary)' : 'var(--color-text-muted)' }}
          >
            {remember
              ? <CheckSquare size={26} weight='fill' />
              : <Square size={26} weight='regular' />}
          </span>
        </label>
        <div className='btnrow'>
          <button onClick={() => { haptic('light'); onDecide('deny', remember) }}>Not now</button>
          <button className='primary' onClick={() => { haptic('light'); onDecide('allow', remember) }}>
            Stream via relay
          </button>
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
  state, albums, artists, genres, songs, recent, showRecent, merged, filter, onFilter, onAddLibrary, cursor, songCursor, density, updating,
  browse, query, results, now, error, onDismissError, albumsLoaded, reconnecting, firstConnect,
  favs, onFav, cont, onContinue, handoff, playing, onPlayHere,
  onBrowse, onDisplay, onSearch, onReconnect, onRefresh, onMore, onMoreSongs,
  onOpenAlbum, onOpenArtist, onOpenGenre, onPlay, onLong, onRequest
}) {
  // Bind the generic onFav(kind, item) to per-kind heart handlers for the leaves.
  const favTrack = onFav ? (t => onFav('track', t)) : null
  // Server search shows its own results view - but NOT on Songs or Genres, which filter the
  // already-loaded list in place (see songFilter/genreFilter below and runSearch). The server
  // search only returns artists/albums/tracks (never genres), so on the Genres view a query has
  // to filter the loaded genres or it does nothing at all (Tim, 2026-07-24).
  const searching = results && query.trim() && browse !== 'songs' && browse !== 'genres'
  // The Songs client-side filter: match title / artist / album, case-insensitive.
  const songFilter = browse === 'songs' ? query.trim().toLowerCase() : ''
  const shownSongs = songFilter
    ? (songs || []).filter(t =>
        `${t.title || ''} ${t.artist || ''} ${t.album || ''}`.toLowerCase().includes(songFilter))
    : songs
  // The Genres client-side filter: match the genre name. Genres load in full (not paged), so this
  // reaches every genre - no "load more to filter" caveat like Songs has.
  const genreFilter = browse === 'genres' ? query.trim().toLowerCase() : ''
  const shownGenres = genreFilter
    ? (genres || []).filter(g => (g.name || '').toLowerCase().includes(genreFilter))
    : genres
  const D = densityOf(density)
  // Can we actually REACH what we are looking at? In the blend a source filter names one
  // library, so ask that one; on '_all' any live host counts. Single-host falls back to the
  // connection flag. Drives the empty state, which must not claim a library is empty when we
  // simply could not read it.
  const viewedLib = merged?.merged && filter && filter !== '_all'
    ? (merged.libraries || []).find(l => l.libraryId === filter)
    : null
  const reachable = viewedLib
    ? !!viewedLib.connected
    : (merged?.merged ? (merged.libraries || []).some(l => l.connected) : !!state.connected)
  // "All" (the blended view) vs one picked library - the copy below differs, and saying
  // "this library" while showing every one of them was simply wrong.
  const allScope = !viewedLib && !!merged?.merged
  // A connect is in flight and nothing has answered yet. The single-host wall above has had
  // a Reconnecting screen for a while; merged mode never got one, so it showed the failure
  // instantly on open - which is what Tim saw off-LAN.
  const connecting = (!!reconnecting || !!firstConnect) && !reachable
  // The Display sheet offers layout (grid views only) and/or sort (whatever the
  // source can do). Disable its button when the active view has neither.
  const sortCap = state.sorts?.[browse === 'songs' ? 'tracks' : browse]
  const displayHasOptions = browse !== 'songs' || (sortCap?.keys?.length > 0)
  // The Recently Added shelf only makes sense when the source can order by date added
  // (older hosts would hand back alphabetical albums under a "recently added" title). In merged mode
  // the shelf comes from recentMerged (each host's own 'added' order, interleaved), so show it there
  // whenever it returned anything.
  const recentSupported = merged?.merged || !!state.sorts?.albums?.keys?.includes('added')
  // Whether the shelf renders AT ALL, in one place: the host has to advertise the 'added' sort,
  // there has to be something in it, and the user has to want it (Settings > Appearance). Three
  // conditions that were previously spread across the render.
  const shelfShown = recentSupported && showRecent && !!recent && recent.length > 0
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

  // Library switcher: the header title is a dropdown (replaces the old source-filter chips, 2026-07-24).
  // Only a switcher with 2+ libraries in the blend; a single library shows a plain, un-tappable title.
  // Open from the start ONLY in the store capture of scene 3 (sceneOpens is false whenever there
  // is no injected scene, which is every real launch). The blended grid alone looks the same as
  // one library's grid, so a frame captioned "every library at once" would have shown a title and
  // nothing else - the menu is where the libraries are actually named. The second and last read
  // of the scene in the UI; see the runScene note in App.
  const [libMenuOpen, setLibMenuOpen] = useState(() => sceneOpens('libraryMenu'))
  const canSwitch = !!(merged?.merged && merged.libraries?.length >= 2)

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
        {/* Trying, not failed. A cold launch lands here first (firstConnect), and a
            manual retry lands here too (reconnecting) - the wall below is only for
            an attempt that has actually concluded. */}
        {reconnecting || firstConnect
          ? (
            <div className='blank'>
              <ArrowsClockwise size={40} weight='thin' className='spin' />
              <h2>{reconnecting ? 'Reconnecting…' : 'Connecting…'}</h2>
            </div>
            )
          : (
            <div className='blank'>
              <PlugsConnected size={40} weight='thin' />
              <h2>Not connected</h2>
              <p className='muted sm'>
                {/* Always the plain, honest reason - never a raw reconnect error.
                    Off and revoked are indistinguishable from here, and a leaked
                    "host refused the connection" is developer-speak that belonged
                    to a pairing attempt, not this screen. */}
                PearTune can't reach this library. The server may be off, or its
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
            // During the PULL, rotate the icon with the gesture. Once REFRESHING, drop the inline
            // transform and let `.spin` own it: an inline transform becomes the animation's implicit
            // `from`, so `.spin` (to: rotate(360deg)) would sweep 132deg->360deg then snap back each
            // cycle - the top spinner's hitch (Tim, 2026-07-22). The reconnect spinner has no inline
            // transform, which is why it turns smoothly.
            style={{
              opacity: Math.min(1, ptr / TRIGGER),
              ...(refreshing ? {} : { transform: `rotate(${ptr * 3}deg)` })
            }}
          />
        )}
      </div>

      {/* The TITLE scrolls away; the search box and the picker do not. Those two
          are the controls you reach for from halfway down a grid of 60 albums, and
          scrolling back to the top to find them was the whole complaint. Keeping
          the title sticky as well would cost twice the height for a word you
          already know. */}
      <header>
        {/* The title IS the library menu: tap it to pick the blend ("All") or one library - the same
            filter the old chip row drove - and to "Add a library" without a trip to Settings. With 2+
            libraries the menu lists them all; with one it's just the Add row (so a solo user can still
            add a second from here). */}
        <div className='libhead'>
          <button
            className={'libpick' + (libMenuOpen ? ' open' : '')}
            onClick={() => { haptic('light'); setLibMenuOpen(o => !o) }}
            aria-haspopup='menu'
            aria-expanded={libMenuOpen}
          >
            <h1>{libTitle}</h1>
            <CaretDown size={16} weight='bold' className='libcaret' />
          </button>

          {libMenuOpen && (
            <>
              <div className='libmenu-backdrop' onClick={() => setLibMenuOpen(false)} />
              <div className='libmenu' role='menu'>
                {/* Library filter (blend + per-library) only makes sense with 2+ libraries. */}
                {canSwitch && (
                  <>
                    <button
                      role='menuitem'
                      className={filter === '_all' ? 'on' : ''}
                      onClick={() => { onFilter('_all'); setLibMenuOpen(false) }}
                    >
                      All libraries
                    </button>
                    {merged.libraries.map(l => (
                      <button
                        key={l.libraryId}
                        role='menuitem'
                        className={(filter === l.libraryId ? 'on' : '') + (l.connected ? '' : ' off')}
                        onClick={() => { onFilter(l.libraryId); setLibMenuOpen(false) }}
                        title={l.connected ? undefined : 'Offline'}
                      >
                        {l.libraryName || 'Library'}
                      </button>
                    ))}
                    <div className='libmenu-sep' />
                  </>
                )}
                <button
                  role='menuitem'
                  className='libmenu-add'
                  onClick={() => { setLibMenuOpen(false); onAddLibrary() }}
                >
                  <Plus size={15} weight='bold' /> Add a library
                </button>
              </div>
            </>
          )}
        </div>
        <p className='muted sm'>
          {songFilter
            ? `${shownSongs.length} of ${songs ? songs.length : 0} loaded songs`
            : genreFilter
              ? `${(shownGenres || []).length} of ${genres ? genres.length : 0} genres`
              : count(browse, { albums, artists, genres, songs })}
          {/* The blend says how many libraries it is blending - that is what you are looking at, and
              nothing else on this screen tells you. The SOURCE KIND ("Folder", "Subsonic") used to
              sit here for a single library and was dropped (Tim, 2026-07-27): it is the operator's
              vocabulary, chosen on the dashboard, and it says nothing to the person listening. */}
          {/* The count of libraries you are PAIRED to, not how many have joined the blend so far -
              the latter climbs 1, 2, 3, 4 as they connect on a cold launch, which reads as the
              subtitle flickering (Tim, 2026-07-28). Per-library connected/offline state lives in
              Settings and on the chips, where it can be seen properly. */}
          {mergedAll && libsOf(state).length > 1 && <> · {libsOf(state).length} libraries</>}
          {/* A background refresh is running (a library connecting on a cold launch, a pull to
              refresh). The grid deliberately does NOT blank while this happens, so this line is
              the only thing that says so - quiet on purpose, and gone the moment the last
              in-flight load settles. The SPINNER earns its place: the words alone sat still in a
              subtitle full of other still words, and read as a label rather than as activity
              (Tim, 2026-07-28). Motion is what says "working"; the text just names what kind. */}
          {updating && (
            <> · <ArrowsClockwise size={12} weight='bold' className='spin inline-spin' /> Updating…</>
          )}
        </p>
      </header>

      <div className='sticky'>
        <div className='searchbar'>
          <input
            className='search'
            value={query}
            onChange={e => onSearch(e.target.value)}
            placeholder={browse === 'songs' ? 'Filter loaded songs' : browse === 'genres' ? 'Filter genres' : 'Search artists, albums, tracks'}
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
        {/* The old source-filter chip row lived here; it's now the header title dropdown (2026-07-24). */}
      </div>

      {/* Dismiss has to come DOWN as a prop: this is Library, and setError lives in
          App. Calling it here compiled and rendered fine, and did nothing on tap. */}
      <Problem error={error} onDismiss={onDismissError} />

      {/* DEMO MODE says so, every time, on the main screen. The proposal is explicit that the
          demo library "must never look like a paired library" - so this is not dismissable and
          not a one-off toast: it is the standing answer to "whose music is this?", and it carries
          the one action that matters next. */}
      {state.demo && !searching && <DemoBanner onAddLibrary={onAddLibrary} />}

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
            query={query} onRequest={onRequest}
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
                    : <Empty reachable={reachable} onRetry={onReconnect} all={allScope} connecting={connecting} loading={updating} />)
              : <SkeletonRows />)
          : browse === 'genres'
            ? (genres
                ? (shownGenres.length
                    ? <GenreGrid genres={shownGenres} onOpen={onOpenGenre} onLong={onLong} d={D} />
                    : <div className='blank'><p className='muted sm'>No genre matches “{query.trim()}”.</p></div>)
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
                      {shelfShown && <RecentShelf albums={recent} onOpen={onOpenAlbum} artBase={artBase} />}
                      {/* Only when the shelf is above it: the heading exists to separate the two,
                          and on its own at the top of the page it would be a label for nothing. */}
                      {shelfShown && <div className='grid-head'>All albums</div>}
                      <Grid albums={albums} onOpen={onOpenAlbum} onLong={onLong} d={D} artBase={artBase} favs={favs} onFav={onFav} />
                      {cursor != null && <button className='more' onClick={onMore}>Load more</button>}
                    </>
                    )
                  : <Empty reachable={reachable} onRetry={onReconnect} all={allScope} connecting={connecting} loading={updating} />}
    </div>
  )
}

// An empty grid means one of two VERY different things, and saying the wrong one sends
// people off to fix a problem they do not have. A library we cannot reach (offline, or
// access ended from the dashboard) served us nothing; that is not the same as a library
// with no music in it, and "add music on the server and let it rescan" is actively
// misleading advice to someone who was just revoked.
function Empty ({ reachable = true, onRetry, all = false, connecting = false, loading = false }) {
  // Trying is not the same as failed, and the app used to show the failure the instant it
  // opened - before it had tried at all. On a phone off-LAN the first connect can legitimately
  // take tens of seconds (a hole-punch that aborts takes ~11s to abort), so silence there reads
  // as "broken" when it is "working on it".
  if (connecting) {
    return (
      <div className='blank'>
        <ArrowsClockwise size={40} weight='thin' className='spin' />
        <h2>{all ? 'Connecting to your libraries…' : 'Connecting…'}</h2>
        <p className='muted sm'>Away from home this can take a moment.</p>
      </div>
    )
  }
  if (!reachable) {
    return (
      <div className='blank'>
        <MusicNotesSimple size={40} weight='thin' />
        {/* Plural when the view is ALL libraries - saying "this library" while showing every
            one of them made the message read as being about a library the user had not picked. */}
        <h2>{all ? 'Can’t reach your libraries' : 'Can’t reach this library'}</h2>
        <p className='muted sm'>
          {all
            ? 'This device is offline, or the servers are unreachable right now. If one was removed there, pair again from its dashboard.'
            : 'This device is offline, or the server ended its access. If it was removed there, pair again from the server’s dashboard.'}
        </p>
        {onRetry && <button className='more' onClick={onRetry}>Try again</button>}
      </div>
    )
  }
  // Reachable, nothing to show YET, and work still in flight. This is the third thing an empty
  // grid can mean and the app used to skip it: it went straight to "This library is empty. Add
  // music on the server" while libraries were still answering (Tim, 2026-07-28). That is advice
  // to go fix a server that has nothing wrong with it. Emptiness is a CONCLUSION and it can only
  // be drawn once the work has stopped.
  if (loading) {
    return (
      <div className='blank'>
        <ArrowsClockwise size={40} weight='thin' className='spin' />
        <h2>Loading your music…</h2>
        <p className='muted sm'>
          {all
            ? 'Your libraries are still answering. Music appears as each one arrives.'
            : 'Still reading this library. Music appears as it arrives.'}
        </p>
      </div>
    )
  }
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
        on the server, so they follow you to your other devices.
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
  reqSupported, myRequests, onNewRequest, onRemoveRequest,
  isOwner, ownerLibraryName, ownedLibs, manageLib, onSwitchManageLib, ownerDevices, selfKey, onRevokeDevice,
  ownerReqs, onResolveRequest, onOwnerPair, onToast,
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
        <p className='muted sm'>{youCount(view, { favItems, mostPlayed, playlists, serverPls, downloads, myRequests, ownerDevices, ownerLibraryName })}</p>
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
            {reqSupported && (
              <button className={view === 'requests' ? 'on' : ''} aria-label='Requests' onClick={() => onYouView('requests')}>
                <MusicNotesPlus size={17} weight={view === 'requests' ? 'fill' : 'regular'} />
                {view === 'requests' && <span>Requests</span>}
              </button>
            )}
            {/* Owner-only: manage the ACTIVE library (device list + revoke), proposal 2026-07-24 P2.
                Shown only for a device the dashboard made an owner of the current library. */}
            {isOwner && (
              <button className={view === 'manage' ? 'on' : ''} aria-label='Manage library' onClick={() => onYouView('manage')}>
                <UsersThree size={17} weight={view === 'manage' ? 'fill' : 'regular'} />
                {view === 'manage' && <span>Manage</span>}
              </button>
            )}
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
          : view === 'requests'
            ? <RequestsView requests={myRequests} onNew={onNewRequest} onRemove={onRemoveRequest} />
          : view === 'manage'
            ? <ManageView devices={ownerDevices} libraryName={ownerLibraryName} selfKey={selfKey} onRevoke={onRevokeDevice}
                ownedLibs={ownedLibs} manageLib={manageLib} onSwitchManageLib={onSwitchManageLib}
                requests={ownerReqs} onResolve={onResolveRequest} onPair={onOwnerPair} onToast={onToast} />
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

function youCount (view, { favItems, mostPlayed, playlists, serverPls, downloads, myRequests, ownerDevices, ownerLibraryName }) {
  if (view === 'manage') {
    const live = (ownerDevices || []).filter(d => !d.revokedAt).length
    return ownerLibraryName ? `Managing ${ownerLibraryName}` : (ownerDevices ? `${live} device${live === 1 ? '' : 's'}` : 'Loading…')
  }
  if (view === 'requests') {
    if (!myRequests) return 'Loading requests…'
    const pend = myRequests.filter(r => r.status === 'pending').length
    return myRequests.length ? `${myRequests.length} request${myRequests.length === 1 ? '' : 's'}${pend ? ` · ${pend} pending` : ''}` : 'No requests yet'
  }
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
            playlists live on the server, so they follow you to your other devices.
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
          <h3 className='favh'>{sourceName ? `From ${sourceName}` : 'From the server'}</h3>
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

// The requester's OWN music requests (You > Requests, proposal 2026-07-24). A full
// scrolling screen - the composer bottom-sheet only CREATES a request now, this is where
// they live and scale. In a blend collapseRequests (worklet) folds each ask to one row
// showing the best status + which libraries.
function RequestsView ({ requests, onNew, onRemove }) {
  if (!requests) return <SkeletonRows />
  // EM DASH ON PURPOSE, exempt from the suite-wide no-em-dash rule (Tim, 2026-07-28). It is a
  // SEPARATOR between two data fields, not prose, and " - " reads as a hyphenated title once an
  // artist or album name contains one of its own. Do not "fix" this in a style sweep.
  const line = (r) => [r.name, r.artist].filter(Boolean).join(' — ')
  const KIND = { artist: 'Artist', album: 'Album', track: 'Track' }
  if (!requests.length) {
    return (
      <div className='blank'>
        <MusicNotesPlus size={40} weight='thin' />
        <h2>No requests yet</h2>
        <p className='muted sm'>
          Search for music that isn’t in the library and tap Request. Whoever runs the
          library sees it and can add it - you’ll see the status here.
        </p>
        <button className='primary' style={{ marginTop: '1rem' }} onClick={onNew}>
          <MusicNotesPlus size={18} weight='bold' /> Request music
        </button>
      </div>
    )
  }
  return (
    <>
      <button className='wide' style={{ marginBottom: '.6rem' }} onClick={onNew}>
        <MusicNotesPlus size={17} weight='bold' /> Request music
      </button>
      <ul className='reqview'>
        {requests.map(r => (
          <li key={r.id || `${r.kind}:${r.name}`}>
            <div className='rqv-main'>
              <span className='rqv-name'>{line(r)}</span>
              <span className='rqv-sub muted sm'>
                {KIND[r.kind] || r.kind}
                {r.libraries?.length > 1 && ` · ${r.libraries.length} libraries`}
              </span>
            </div>
            <span className={'rq-status ' + r.status}>{r.status}</span>
            {/* Remove YOUR request: clear a finished one, or withdraw a pending one
                (which also pulls it from the operator's queue). Instant, like the queue's
                remove - low stakes, and the host refuses anything not yours. */}
            <button className='rqv-rm' aria-label={r.status === 'pending' ? 'Withdraw request' : 'Remove request'} onClick={() => onRemove(r)}>
              <Trash size={18} weight='regular' />
            </button>
          </li>
        ))}
      </ul>
    </>
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
      <Problem error={err} />
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

// The standing "this is not your music" notice for demo mode (proposal 2026-07-28-app-review-demo).
//
// Deliberately not dismissable. The demo library is a real, browsable, playable library with a
// real album and real artwork, and that is exactly why it needs saying out loud: someone who
// forgot they tapped "Try it without a server" would otherwise have no way to tell this from a
// paired one. It also carries the next step, because "how do I get MY music in here" is the only
// question this screen leaves.
function DemoBanner ({ onAddLibrary }) {
  return (
    <div className='demobanner'>
      <div className='demo-ic'><MusicNotes size={18} weight='bold' /></div>
      <div className='meta'>
        <div className='demo-h'>Demo music</div>
        <p className='muted sm'>
          A few sample tracks that come with the app. Connect a PearTune server to play your own
          music - or a friend’s.
        </p>
      </div>
      <button className='primary sm' onClick={onAddLibrary}>Connect</button>
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
// are written for a developer ("no answer from the host (unreachable, or not
// accepting pair requests)"); the person holding the phone needs to know what to DO.
// "The server said no" and "the server never answered" are different failures with different
// fixes, and they used to share one message. That cost real debugging time: an expired pairing
// window and a phone that cannot reach the host at all both read as "Couldn't reach your
// library", so the message could not tell you which one you were looking at.
// What every report carries besides the message: which build, and which platform.
const reportMeta = (repo) => ({
  version: APP_VERSION, platform: window.__pearPlatform || 'unknown platform', repo
})

// The card itself. Dismissible where the failure is an event (playback died);
// permanent where it is the reason a screen is empty (a load failed), because
// dismissing that would leave a blank page with no explanation.
function Problem ({ error, onDismiss }) {
  const [open, setOpen] = useState(false)
  const info = friendlyError(error)
  if (!info) return null
  const { kind, title, hint, technical } = info

  return (
    <div className={'problem' + (kind === 'bug' ? ' bug' : '')} role='alert'>
      <div className='prow'>
        <WarningCircle size={20} weight='fill' className='picon' />
        <div className='ptext'>
          <div className='ptitle'>{title}</div>
          {hint && <div className='phint'>{hint}</div>}
        </div>
        {onDismiss && (
          <button className='pclose' onClick={onDismiss} aria-label='Dismiss'>
            <X size={16} weight='bold' />
          </button>
        )}
      </div>

      {technical && (
        <>
          <div className='pacts'>
            <button className='plink' onClick={() => setOpen(o => !o)} aria-expanded={open}>
              {open ? 'Hide details' : 'Details'}
            </button>
            {/* Three ways out, because each one fails for someone: GitHub makes you
                SIGN IN before it will show a prefilled issue, mail needs a mail app,
                and Copy needs neither. All three carry the same redacted report. */}
            {kind === 'bug' && (
              <>
                <button className='plink' onClick={() => openUrl(reportUrl(technical, reportMeta(GITHUB_URL)))}>
                  Report on GitHub
                </button>
                <button className='plink' onClick={() => openUrl(reportMailto(technical, { ...reportMeta(), to: CONTACT_EMAIL }))}>
                  Email
                </button>
                <button className='plink' onClick={() => copyText(redact(technical))}>Copy</button>
              </>
            )}
          </div>
          {open && <pre className='ptech'>{redact(technical)}</pre>}
        </>
      )}
    </div>
  )
}

function pairError (msg = '') {
  const m = String(msg)
  // The host let the connection OPEN and then hung up: it read the code and said no. This
  // is the only case where we actually know the code was the problem, so it is the only
  // case allowed to say so.
  if (/host refused|denied/i.test(m)) {
    return 'That server turned that pairing code down. It has most likely expired, so show a fresh one on the dashboard and try again.'
  }
  if (/not a peartune|not a valid|invalid|malformed/i.test(m)) {
    return "That doesn't look like a PearTune pairing code. Copy it again from the dashboard you are pairing with."
  }
  // The connection never opened. The transport CANNOT tell a firewall deny (no pairing
  // window) from a dropped holepunch - both arrive as "could not connect" - so neither may
  // be asserted here. Saying "it has expired" for a network blip is what sent an earlier
  // investigation down the wrong path.
  if (/no answer from the host|never answered|unreachable|timed out|timeout/i.test(m)) {
    return "Couldn't set up with your library. The server didn't answer - the pairing window may have closed, or this phone can't reach it right now. Show a fresh code on the dashboard, and check both are on a network that can reach each other."
  }
  if (/expired/i.test(m)) {
    return 'That pairing code has expired. Show a fresh one on the dashboard and try again.'
  }
  return 'Pairing failed. Show a fresh code on the dashboard and try again.'
}

// "Recently added" means recently, not "the newest twelve whenever they landed" (Tim, 2026-07-27).
// Without a cutoff the shelf is permanent: a library nobody has added to in a year still carries a
// dozen albums under that heading, which is a lie the first time you read it and furniture every
// time after. SEVEN DAYS (Tim, asked between 7/30/90): the shelf reads as news - this week's new
// music - and is gone again a week later, rather than lingering as decoration.
//
// A missing addedAt counts as NOT recent: the shelf can only make its claim about albums whose age
// we actually know, and no shelf is better than a wrong one. (The shelf is already gated on the
// host supporting the 'added' sort at all - see recentSupported.)
const RECENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

function recentEnough (albums) {
  const cutoff = Date.now() - RECENT_MAX_AGE_MS
  return (albums || []).filter(a => Number(a.addedAt) > cutoff)
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
function SearchResults ({ results, now, d, artBase, favs, onFav, onOpenAlbum, onOpenArtist, onPlay, onLong, query, onRequest }) {
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

  // Nothing in the library matches - the one place a REQUEST makes sense: the music you
  // searched for is not here, so offer to ask the owner to add it (proposal 2026-07-24,
  // P1). Only when the host supports requests (onRequest set) and you actually typed
  // something. The trimmed query prefills the composer.
  if (!groups.length) {
    const q = (query || '').trim()
    return (
      <div className='center-p'>
        <p className='muted'>Nothing found.</p>
        {onRequest && q && (
          <button className='primary' style={{ marginTop: '.6rem' }} onClick={() => onRequest(q)}>
            <MusicNotesPlus size={18} weight='bold' /> Request “{q}”
          </button>
        )}
      </div>
    )
  }

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
  // Is there more to the right? The shelf scrolls sideways and nothing said so, so the albums
  // past the edge were easy to miss entirely (Tim, 2026-07-30). Measured rather than assumed:
  // the row holds however many the host returned, at a width that depends on the screen, so
  // "there is more" is a runtime fact. Re-checked on scroll and on resize; the ResizeObserver
  // matters because the covers arrive asynchronously and the row grows under us.
  const rowRef = useRef(null)
  const [more, setMore] = useState(false) // more to the right
  const [back, setBack] = useState(false) // ...and to the left, once you have moved
  useEffect(() => {
    const el = rowRef.current
    if (!el) return undefined
    // 8px of slack at BOTH ends: sub-pixel widths mean scrollLeft never quite reaches the exact
    // end, and a hint that lingers when there is nothing left that way is worse than none.
    const sync = () => {
      setMore(el.scrollWidth - el.clientWidth - el.scrollLeft > 8)
      setBack(el.scrollLeft > 8)
    }
    sync()
    el.addEventListener('scroll', sync, { passive: true })
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => { el.removeEventListener('scroll', sync); ro.disconnect() }
  }, [albums.length])

  if (!albums.length) return null
  return (
    <div className='shelf'>
      <div className='shelf-head'>Recently added</div>
      <div className={'shelf-scroll' + (more ? ' more' : '') + (back ? ' back' : '')}>
        <div className='shelf-row' ref={rowRef}>
          {albums.map(a => (
            <button className='shelf-item' key={a.id} onClick={() => onOpen(a.id)}>
              <Cover src={artFor(a, DENSITY[2], artBase)} />
              <div className='shelf-t'>{a.name}</div>
              {a.artist && <div className='shelf-a muted'>{a.artist}</div>}
            </button>
          ))}
        </div>
        {/* The fade alone is easy to read as "the picture ends here", so each carries a caret.
            BOTH ENDS: the right-hand one shipped first and the left was missing (Tim,
            2026-07-30) - once you have scrolled in, there is just as much off-screen behind you,
            and nothing said so. Each shows only while there is something that way.
            aria-hidden: they are hints, not controls - the row itself is what scrolls. */}
        <div className='shelf-back' aria-hidden='true'><CaretLeft size={16} weight='bold' /></div>
        <div className='shelf-more' aria-hidden='true'><CaretRight size={16} weight='bold' /></div>
      </div>
    </div>
  )
}

// The source-filter chips for the merged library (multi-host step 2). [All] is the blend; each other
// chip narrows to one library. An offline library (not in the current blend) is greyed but still
// tappable. `filter` is the active chip id, or null when a Settings switch has focused one host (so
// nothing here is lit and tapping any chip returns to the blended view).
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
function GenreGrid ({ genres, onOpen, onLong, d = DENSITY[2], empty = <p className='muted center-p'>No genres.</p> }) {
  if (!genres.length) return empty
  const list = d.cols === 1
  return (
    <div className={'grid' + (list ? ' aslist' : '')} style={{ '--cols': d.cols }}>
      {genres.map(g => (
        <Tile
          key={g.id} className='album'
          onPress={() => onOpen(g)}
          // Long-press for Play / Shuffle / Add to queue / Add to playlist, the same as albums
          // and artists (Tim, 2026-07-30). Genres were the ONE browse view without it, for no
          // reason anyone recorded - the whole machinery behind it already handled the type:
          // menuAction routes 'genre' and tracksFor calls genreTracks. It was purely that this
          // grid never took an onLong to pass along.
          onLongPress={onLong && (() => onLong({ type: 'genre', id: g.id, name: g.name }))}
        >
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
        {problem ? <Problem error={problem} /> : <p className='muted center-p'>Loading…</p>}
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
      <Problem error={problem} />

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

      <Problem error={err} />
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

      <Problem error={err} />
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

function PlaylistScreen ({ id, name, now, onBack, onPlay, onPlayAll, onQueue, onRename, onDelete, onSetTracks, server, sourceName, refreshKey = 0 }) {
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
    // refreshKey: another of this person's devices edited a playlist, so refetch. The effect
    // OVERWRITES pl rather than clearing it first, so the rows on screen stay up until the new
    // ones land - no skeleton flash, which is the trap the Favorites view fell into.
  }, [id, server, refreshKey])

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
      <Problem error={err} />

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
  onViewArt, onQueue, onStop, queueItems, queueIndex, onJump, sleep, onSleep,
  canCast, castingTo, castPaused, onCastToggle, onSpeakers
}) {
  // While casting, play/pause drives the SPEAKER and the icon reflects the SPEAKER. The
  // phone is muted and held paused throughout, so `status.playing` is false the whole
  // time and reading it would show a play icon over music that is playing (proposal
  // 2026-08-02). One helper, used by both the mini bar and the expanded transport, so
  // the two can never disagree.
  const playing = castingTo ? !castPaused : !!status?.playing
  const onPlayPause = () => {
    haptic('light')
    if (castingTo) onCastToggle()
    else call('toggle')
  }
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
    // No seeking while casting: the speaker cannot seek (the Voice PE reports no SEEK)
    // and the phone this would move is muted, so a tap here would silently do nothing.
    if (!dur || castingTo) return
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
              onClick={(e) => { e.stopPropagation(); onPlayPause() }}
              aria-label='Play/pause'
            >
              {playing ? <Pause size={22} weight='fill' /> : <Play size={22} weight='fill' />}
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
          <button className='icon big' onClick={onPlayPause} aria-label='Play/pause'>
            {playing ? <Pause size={26} weight='fill' /> : <Play size={26} weight='fill' />}
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
          <button className='icon' onClick={() => call('seekBy', { seconds: -15 })} aria-label='Back 15 seconds' disabled={!!castingTo}>
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
          <button className='icon' onClick={() => call('seekBy', { seconds: 15 })} aria-label='Forward 15 seconds' disabled={!!castingTo}>
            15 <ArrowClockwise size={15} />
          </button>
          {/* Only when the host actually offers speakers AND this device may use them.
              An unconfigured host, an old host or a non-owner grant all mean canCast
              is false, and then there is no button at all rather than one that
              explains itself when tapped. */}
          {canCast &&
            <button
              // `mode` matters: only button.icon.mode.on carries the highlight colour, so
              // without it the "actively casting" state rendered as nothing at all. Same
              // class the shuffle and repeat toggles use, which is what this is.
              className={'icon mode' + (castingTo ? ' on' : '')}
              onClick={() => { haptic('light'); onSpeakers() }}
              aria-label='Play on a speaker'
            >
              <SpeakerHigh size={16} weight={castingTo ? 'fill' : 'regular'} />
            </button>}
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

// Where the music comes out: this phone, or a Home Assistant speaker in the house
// (proposal 2026-08-01).
//
// The list is deliberately flat and short. Anything clever - which speakers exist,
// whether this device may use them - was decided by the host before we got here; a
// non-owner or an unconfigured host simply never sees the button that opens this.
//
// The honest limits are stated in the sheet rather than discovered: a speaker has no
// queue of its own, so there is a small gap between tracks, and the Nabu Casa speaker
// cannot scrub at all. Better said here than reported as a bug.
function SpeakerSheet ({ speakers, castingTo, onClose, onPick, onHere, busy }) {
  return (
    <div className='sheetwrap' onClick={onClose}>
      <div className='sheet' onClick={e => e.stopPropagation()}>
        <h1>Play on</h1>
        <div className='acts'>
          <button className={'wide' + (castingTo ? '' : ' on')} onClick={onHere} disabled={busy}>
            <DeviceMobile size={16} weight='regular' /> This phone
          </button>
          {speakers.map(s => (
            <button
              key={s.entityId}
              className={'wide' + (castingTo === s.entityId ? ' on' : '')}
              onClick={() => onPick(s.entityId)}
              disabled={busy}
            >
              <SpeakerHigh size={16} weight='regular' /> {s.name}
            </button>
          ))}
          {!speakers.length && <p className='muted sm'>No speakers found.</p>}
          {castingTo &&
            <p className='muted sm'>
              There is a short gap between tracks on a speaker, and you cannot scrub
              through a song. Everything else works as usual.
            </p>}
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

        {/* EVERY EM DASH BELOW IS DELIBERATE and exempt from the suite-wide no-em-dash rule
            (Tim, 2026-07-28). This is the CLASSIC skin: it is imitating a 90s amplifier's LCD
            readout, where "3. Title — Artist" is what the thing being imitated actually showed.
            The rule governs PROSE; this is a facsimile. A style sweep that hyphenates these has
            changed the look of the skin, which is the whole feature. Leave them. */}
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

// Ascending, because these are now a left-to-right slider (Tim, 2026-07-29) and a slider's
// axis has to MEAN something. 'auto' is deliberately NOT in this list: it is a mode, not a
// point on a quality scale (full quality on Wi-Fi, a smaller stream on cellular), so it sits
// on the axis nowhere honestly - at the left it would claim to be the lowest quality, which
// on Wi-Fi is the opposite of true. It gets its own toggle above the slider instead.
const QUALITIES = [
  { value: '128', label: '128 kbps', desc: 'Lowest quality, least data' },
  { value: '192', label: '192 kbps', desc: 'Good quality, saves more data' },
  { value: '320', label: '320 kbps', desc: 'High quality, less data everywhere' },
  { value: 'original', label: 'Original', desc: 'Always the original file - best quality, ~1 GB an album' }
]
const QUALITY_AUTO_DESC = 'Full quality on Wi-Fi, a smaller stream on cellular'

const CACHE_CAPS = [
  { value: 512 * 1024 * 1024, label: '512 MB' },
  { value: 1024 * 1024 * 1024, label: '1 GB' },
  { value: 2 * 1024 * 1024 * 1024, label: '2 GB' },
  { value: 0, label: 'Unlimited', desc: 'Keep every played track' }
]

// A discrete slider over an ordered option list (Tim, 2026-07-29). Tap anywhere on the track
// or drag the thumb; the text underneath names the stop you are on and updates AS YOU MOVE,
// before anything is committed.
//
// Built on <input type=range> rather than a hand-rolled div. That buys correct touch handling,
// tap-to-position, keyboard arrows and a real slider role for free - all of which are easy to
// get subtly wrong with pointer events, and none of which are the interesting part of this
// change. The look is entirely ours via ::-webkit-slider-* (the WebView is Chromium).
//
// The value is committed on CHANGE (pointer up / key), not on INPUT. Dragging across four
// stops would otherwise fire four worklet writes, and for the cache cap each one can trigger
// an eviction pass - so a drag from Unlimited to 512 MB would start deleting audio at every
// stop on the way past.
function StepSlider ({ options, value, onChange, disabled = false, ariaLabel }) {
  const at = Math.max(0, options.findIndex(o => o.value === value))
  // Local index so the label can follow the finger while the committed value has not moved.
  const [draft, setDraft] = useState(null)
  const i = draft ?? at
  const cur = options[i] || options[0]
  // Re-sync when the committed value changes from elsewhere (a load, or the Auto toggle).
  useEffect(() => { setDraft(null) }, [value])

  return (
    <div className={'stepslider' + (disabled ? ' off' : '')}>
      <input
        type='range' min={0} max={options.length - 1} step={1} value={i}
        disabled={disabled}
        aria-label={ariaLabel}
        // The number means nothing to a screen reader; the label is the actual value.
        aria-valuetext={cur.label}
        onInput={(e) => {
          const n = Number(e.target.value)
          if (n !== i) haptic('light')   // a detent per stop, so a drag feels like steps
          setDraft(n)
        }}
        onChange={(e) => {
          const n = Number(e.target.value)
          setDraft(n)
          if (options[n] && options[n].value !== value) onChange(options[n].value)
        }}
      />
      <div className='stepslider-ticks' aria-hidden='true'>
        {options.map((o, n) => <span key={String(o.value)} className={n <= i ? 'on' : ''} />)}
      </div>
      <div className='stepslider-read'>
        <span className='stepslider-name'>{cur.label}</span>
        {cur.desc && <span className='stepslider-desc'>{cur.desc}</span>}
      </div>
    </div>
  )
}

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

// How often Settings re-asks the host who this device belongs to WHILE the answer is still
// "waiting to be confirmed". Slower than the worklet's own 4s session heartbeat, so this
// adds less traffic than what an open connection already carries.
const IDENT_POLL_MS = 5000
const IDENT_POLL_MAX = 36 // 3 minutes of asking, then wait for the next time Settings opens

// Owner maintenance in the app (proposal 2026-07-24, P2): the ACTIVE library's device list,
// with revoke - the You > Manage view, shown only to a device the dashboard made an owner of
// the current library. Data is fetched by the parent (ownerDevices) and reloaded after a
// revoke. A revoke cuts the device off within the second (the same teeth as the dashboard);
// the host refuses revoking another OWNER, so that button is hidden here too.
function ManageView ({ devices, libraryName, selfKey, onRevoke, ownedLibs = [], manageLib, onSwitchManageLib, requests, onResolve, onPair, onToast }) {
  const [confirm, setConfirm] = useState(null) // { device } pending a revoke
  const multi = (ownedLibs || []).length > 1
  // EM DASH ON PURPOSE, exempt from the suite-wide no-em-dash rule (Tim, 2026-07-28). It is a
  // SEPARATOR between two data fields, not prose, and " - " reads as a hyphenated title once an
  // artist or album name contains one of its own. Do not "fix" this in a style sweep.
  const line = (r) => [r.name, r.artist].filter(Boolean).join(' — ')
  const KIND = { artist: 'Artist', album: 'Album', track: 'Track' }
  return (
    <>
      {/* Requests sit ABOVE the picker because they are not per-library: an ask fans out to every
          library, so the queue is aggregated back across all of them and one tap clears every copy
          (Tim, 2026-07-25). Devices and pairing below ARE per-library and follow the picker. */}
      <ManageRequests requests={requests} onResolve={onResolve} line={line} KIND={KIND} multi={multi} />

      {/* Own more than one library? Pick which one's devices to manage. Just one shows no picker. */}
      {multi && (
        <div className='mglibs'>
          {ownedLibs.map(l => (
            <button
              key={l.libraryId}
              className={l.libraryId === manageLib ? 'on' : ''}
              onClick={() => onSwitchManageLib(l.libraryId)}
            >{l.libraryName}</button>
          ))}
        </div>
      )}

      {!devices ? <SkeletonRows /> : <ManageBody
        devices={devices} libraryName={libraryName} selfKey={selfKey} onRevoke={onRevoke} onPair={onPair}
        confirm={confirm} setConfirm={setConfirm} onToast={onToast} />}
    </>
  )
}

// The owner's incoming music requests, folded across every library they own. A row may cover
// several libraries (the same ask fanned out), so it names them when there is more than one to
// tell apart - and resolving hands the whole row back so the fan-out can be undone everywhere.
function ManageRequests ({ requests, onResolve, line, KIND, multi }) {
  const pending = (requests || []).filter(r => r.status === 'pending')
  if (!pending.length) return null
  return (
    <>
      <div className='mgh'>Requests <span className='cnt'>{pending.length}</span></div>
      <ul className='ownerdevs'>
        {pending.map(r => (
          <li key={r.id}>
            <div className='who'>
              <div className='name'>{line(r)} <span className='badge'>{KIND[r.kind] || r.kind}</span>{r.count > 1 && <span className='badge'>×{r.count}</span>}</div>
              <div className='sub muted sm'>
                {r.requesterName} asked{multi && r.libraries?.length ? ` · ${r.libraries.join(', ')}` : ''}
              </div>
            </div>
            <button className='reqact added' aria-label='Mark added' onClick={() => onResolve(r, 'added')}>
              <CheckCircle size={24} weight='fill' />
            </button>
            <button className='reqact declined' aria-label='Decline' onClick={() => onResolve(r, 'declined')}>
              <XCircle size={24} weight='fill' />
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

// The body of Manage for ONE library: its devices + pairing. Split out so the library picker
// above can stay put while the list below swaps to a skeleton on a library switch.
function ManageBody ({ devices, libraryName, selfKey, onRevoke, onPair, confirm, setConfirm, onToast }) {
  const onCopyKey = (d) => { copyText(d.deviceKey); haptic('success'); onToast && onToast('Device key copied') }
  const live = devices.filter(d => !d.revokedAt)
  return (
    <>
      <button className='wide' style={{ marginBottom: '.7rem' }} onClick={onPair}>
        <QrCode size={17} weight='bold' /> Pair a device
      </button>

      <div className='mgh'>Devices</div>
      <p className='muted sm' style={{ margin: '0 0 .4rem' }}>
        Everyone with access to {libraryName || 'this library'}. Revoke a device and it loses
        access immediately, even mid-song.
      </p>
      <ul className='ownerdevs'>
        {live.map(d => {
          const isSelf = d.deviceKey === selfKey
          const isOwner = d.scope === 'owner'
          return (
            <li key={d.deviceKey}>
              <div className='who'>
                <div className='name'>
                  {d.label}
                  {isOwner && <span className='badge'>owner</span>}
                  {isSelf && <span className='badge'>this phone</span>}
                </div>
                {/* Prefer the host's disambiguated person label (suffixed only when two people
                    share a name) over the raw claimedUser, which is merely what the device said
                    and would print two identical "Sam"s. */}
                <div className='sub muted sm'>{d.online ? 'Connected' : 'Offline'}{(d.belongsTo || d.claimedUser) ? ` · ${d.belongsTo || d.claimedUser}` : ''}</div>
                {/* The device's public key, tap to copy. The suffix says WHICH Sam; this says
                    which DEVICE, and it is the one thing a device cannot misreport (Noise proves
                    it per connection). Whoever holds that phone can read the same value back to
                    you from Settings > Device key, so an owner working away from the dashboard
                    can still confirm they are about to revoke the right one (Tim, 2026-07-26). */}
                <button className='mgkey' aria-label={'Copy device key for ' + d.label} onClick={() => onCopyKey(d)}>
                  {shortKey(d.deviceKey)}
                </button>
              </div>
              {/* No revoke on yourself (unpair is how you leave) or on another owner
                  (dashboard-only, and the host refuses it anyway). */}
              {!isSelf && !isOwner && (
                <button className='rqv-rm' aria-label={'Revoke ' + d.label} onClick={() => setConfirm({ device: d })}>
                  <Trash size={18} weight='regular' />
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {confirm && (
        <Confirm
          title={`Revoke “${confirm.device.label}”?`}
          body='It loses access immediately, even mid-song. It would have to pair again to return.'
          yes='Revoke' danger
          onConfirm={() => { onRevoke(confirm.device.deviceKey); setConfirm(null) }}
          onClose={() => setConfirm(null)}
        />
      )}
    </>
  )
}

// The owner opens a pairing window remotely (P2b): show the link to share so someone can pair
// The person you're adding might be right next to you (scan the QR) or across town
// (send the link). Offer both - the QR first, since scanning is the easy path when
// you're together, with the link and Share underneath for when you're not.
function OwnerPairSheet ({ link, toast, onClose }) {
  const [copied, setCopied] = useState(false)
  const [qr, setQr] = useState(null)
  useEffect(() => {
    let live = true
    QRCode.toDataURL(link, { width: 320, margin: 2, errorCorrectionLevel: 'M' })
      .then(url => { if (live) setQr(url) })
      .catch(() => {})
    return () => { live = false }
  }, [link])
  const copy = () => { copyText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); toast('Link copied') }
  const share = () => call('shell:share', { title: 'PearTune', text: link }).catch(() => {})
  return (
    <div className='sheetwrap' onClick={onClose}>
      <div className='sheet' onClick={e => e.stopPropagation()}>
        <h1>Pair a device</h1>
        <p className='muted sm'>If you’re together, they scan this. Otherwise send them the link. It works for 5 minutes and lets in one device.</p>
        {qr && <div className='pairqr'><img src={qr} alt='Pairing QR code' /></div>}
        <div className='key addr' style={{ marginTop: '.2rem' }}>{link}</div>
        <div className='pairbtns'>
          <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
          <button className='primary' onClick={share}>Share</button>
        </div>
        <button className='wide' onClick={onClose}>Done</button>
      </div>
    </div>
  )
}

function Settings ({ state, merged, themePref, onTheme, onUnpair, ident, onRefreshIdentity, onSaveIdentity, onSaveAvatar, onArtRefreshed, onQuality, skin, onSkin, showRecent, onShowRecent, onSwitchHost, onRemoveHost, onAddLibrary, onSetAlias, onSetRelayAudio, onDisableDemo }) {
  const quality = state.settings?.streamQuality || 'auto'
  const [dev, setDev] = useState(null)
  const [usr, setUsr] = useState(null)
  const [saving, setSaving] = useState(false)
  const [cache, setCache] = useState(null) // { bytes, count, cap }

  useEffect(() => { call('cacheStats').then(setCache).catch(() => {}) }, [])

  // WHO this device belongs to is the host's answer, and the operator changes it on their
  // dashboard - out of band, while the app just sits here. #122 made the host answer
  // truthfully, but nothing was ASKING again: the read only happened on connect and on
  // pair, so a confirm or a rename did not show until the next reconnect. So: re-read
  // whenever Settings opens, and keep asking while the note still says "waiting" - that is
  // precisely when somebody is watching this screen for it to change. It stops the moment
  // the host confirms, so a settled Settings tab is not a poll loop.
  const identPending = !!ident && !ident.confirmed && ident.supported !== false
  useEffect(() => {
    if (!state.connected) return
    onRefreshIdentity()
    if (!identPending) return
    // Bounded, because "waiting" can last as long as the operator takes and a Settings tab
    // left open in a pocket must not poll for an hour. Three minutes covers somebody
    // actually watching for the banner to flip; after that, reopening Settings re-arms it.
    let left = IDENT_POLL_MAX
    const t = setInterval(() => {
      if (--left <= 0) return clearInterval(t)
      onRefreshIdentity()
    }, IDENT_POLL_MS)
    return () => clearInterval(t)
  }, [identPending, state.connected])
  const cap = cache?.cap ?? (state.settings?.cacheCap ?? 0)
  const setCap = async (bytes) => { haptic('light'); try { setCache(await call('setCacheCap', { bytes })) } catch {} }
  const clearCache = async () => { haptic('warn'); try { setCache(await call('clearCache')) } catch {} }
  // Drop the stored covers so they refetch at whatever the server now has (proposal
  // 2026-07-29-persist-album-art). Art only - downloads still play offline.
  const refreshArt = async () => {
    haptic('light')
    try {
      const r = await call('refreshArtwork')
      // Re-read, or the "Using" figure above keeps showing what was just thrown away.
      setCache(await call('cacheStats'))
      // Hand the NEW art base up. Without this the button emptied the store and nothing
      // re-fetched: every cover on screen kept being answered from the WebView's own http cache
      // against the URLs it already had, so a wrong cover stayed wrong and Using stayed at 0
      // until the app was restarted (measured on the TCL, 2026-07-30).
      onArtRefreshed?.(r?.artBase)
    } catch {}
  }
  // The last NON-auto quality, so switching Auto off returns you to what you had rather than
  // dumping you on a default. A ref, not state: nothing renders from it directly.
  const lastFixedQuality = useRef(quality !== 'auto' ? quality : null)
  useEffect(() => { if (quality && quality !== 'auto') lastFixedQuality.current = quality }, [quality])
  const [cellular, setCellular] = useState(state.settings?.downloadCellular ?? false)
  const toggleCellular = async () => { const on = !cellular; haptic('light'); setCellular(on); try { await call('setDownloadCellular', { on }) } catch {} }
  // The off-LAN relay privacy toggle. Default ON (the reliability backstop); OFF is
  // pure peer-to-peer, no PeerLoom infrastructure ever touched (proposal 2026-07-23).
  const [useRelay, setUseRelay] = useState(state.settings?.useRelay !== false)
  const toggleRelay = async () => { const on = !useRelay; haptic('light'); setUseRelay(on); try { await call('setUseRelay', { on }) } catch {} }

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

  const [open, setOpen] = useState(null)
  const toggle = (id) => { haptic('light'); setOpen(o => (o === id ? null : id)) }

  // Which library row is being renamed, and the draft. null = none (the common case).
  const [aliasEdit, setAliasEdit] = useState(null)
  const saveAlias = async () => {
    const { hostKey, value } = aliasEdit
    setAliasEdit(null) // close optimistically: the write is local to this phone, nothing to await on a host
    await onSetAlias(hostKey, value.trim())
  }

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
      // Through the parent, NOT call() directly: `avatarLocal` only lives as long as this
      // screen is mounted, so a save that did not also update state.settings looked fine
      // until you left Settings and came back - and then showed the PREVIOUS photo, which
      // is exactly what Tim hit. saveIdentity has kept the mirror in step for names since
      // #111; the avatar never did.
      await onSaveAvatar(base64)
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
            // belongsTo, not userName: the CONFIRMED identity as the host labels it, suffixed
            // where two people share a name. userName is only what this device typed, so it
            // would read "Sam" while the operator's dashboard reads "Sam #4f2a" - and then the
            // two of them cannot check they mean the same person (Tim, 2026-07-26).
            ? `The server has confirmed this device belongs to ${ident.belongsTo || ident.userName}.`
            : ident.belongsTo
              ? `The server still has this device down as ${ident.belongsTo}. It is waiting to confirm you are ${ident.userName} - only the person running it can move a device to someone else.`
              : `Waiting for the server to confirm you are ${ident.userName}. Until then this is only a label.`}
        </div>
      )}
      {ident && ident.supported === false && (
        <div className='profile-note desc'>
          That server is running an older PearTune and cannot be told about names yet.
          Update it, or re-pair to set the device name.
        </div>
      )}

      <div className='settings-acc'>
        <Section id='library' title={state.demo ? 'Library' : (libsOf(state).length > 1 ? 'Libraries' : 'Library')} Icon={MusicNotesSimple} open={open === 'library'} onToggle={toggle}>
          {/* DEMO MODE gets its own section body rather than a row in the normal list. The
              generic row offers Rename and Remove, and neither means anything for a library
              with no server behind it: there is no operator to disagree with the name, and
              "remove" would try to send a goodbye to a host that does not exist. What a demo
              user actually wants is one of two things - connect a real server, or take the
              sample music back off the phone. */}
          {state.demo
            ? (
              <>
                <div className='row'>
                  <div style={{ minWidth: 0 }}>
                    <div className='label'>Demo music</div>
                    <div className='desc'>
                      Sample tracks bundled with the app. They play with no server and no network,
                      and nothing about them is shared anywhere.
                    </div>
                  </div>
                </div>
                <div className='btnrow'>
                  <button className='primary' onClick={onAddLibrary}>Connect a server</button>
                  <button onClick={onDisableDemo}>Remove the demo music</button>
                </div>
              </>
              )
            : <>
          {/* Two actions up top: add another server (+), or become an owner of a server you run
              (the same people icon Manage uses). Both open the pairing scanner - a plain code adds a
              library, the host's "Pair my phone as owner" code promotes this device. The libraries
              you are paired to follow beneath. */}
          <div className='libactions'>
            <button className='libact' aria-label='Add a library' title='Add a library' onClick={onAddLibrary}>
              <Plus size={22} weight='bold' />
              <span>Add server</span>
            </button>
            <button className='libact' aria-label='Pair as owner' title='Pair as owner - manage a server you run' onClick={onAddLibrary}>
              <UsersThree size={22} weight='bold' />
              <span>Pair as owner</span>
            </button>
          </div>
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
              ? (ml.connected ? 'Connected' : 'Offline')
              : (h.active
                  ? (state.connected ? 'Active - connected' : 'Active - connecting…')
                  : 'Tap to switch to this library')
            const tappable = !ml && !h.active // only switch libraries in single-host mode

            // Editing YOUR OWN name for this library. The row becomes the editor in place rather
            // than opening a sheet - it is one short field, and the name you are replacing is
            // right there to read while you type.
            if (aliasEdit?.hostKey === h.hostKey) {
              return (
                <div className='row' key={h.hostKey}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <input
                      className='profile-dev' style={{ width: '100%' }} autoFocus
                      value={aliasEdit.value} onChange={e => setAliasEdit({ ...aliasEdit, value: e.target.value })}
                      onKeyDown={e => { if (e.key === 'Enter') saveAlias() }}
                      placeholder={h.hostName || h.libraryName || 'Library'}
                      maxLength={40} aria-label='Your name for this library'
                    />
                    <div className='desc'>
                      Only on this phone - your server is not told. Leave it empty to use the name
                      the server gives it{h.hostName ? ` (“${h.hostName}”)` : ''}.
                    </div>
                    <div className='btnrow'>
                      <button onClick={() => setAliasEdit(null)}>Cancel</button>
                      <button onClick={saveAlias}>Save</button>
                    </div>
                  </div>
                </div>
              )
            }

            return (
              <div
                className='row'
                key={h.hostKey}
                onClick={() => { if (tappable) onSwitchHost(h.hostKey) }}
                style={{ cursor: tappable ? 'pointer' : 'default' }}
              >
                <div style={{ minWidth: 0 }}>
                  <div className='label'>
                    {h.libraryName || 'Library'}
                    {showDot && (
                      <span className='val' style={{ color: online ? 'var(--color-primary)' : undefined, marginLeft: 8 }}>
                        {online ? '●' : '○'}
                      </span>
                    )}
                  </div>
                  <div className='desc'>{desc}</div>
                  {/* An alias WINS over the server's name, so the server's name has to stay visible
                      somewhere - otherwise the operator renaming their library is invisible to you
                      and clearing the alias looks like it produced a name from nowhere. */}
                  {h.alias && h.hostName && h.hostName !== h.alias && (
                    <div className='desc'>Your server calls it “{h.hostName}”</div>
                  )}
                  {/* RELAY CONSENT (proposal 2026-07-29-relay-audio-consent). Shown only when it
                      is actually true of this library - either it is on the relay right now, or a
                      standing answer is stored - so a library that never needs the choice never
                      mentions it. Without this row a "Not now" is a sticky no with no visible
                      cause: the album simply refuses to play and nothing says why. */}
                  {(h.relayed || (h.relayConsent && h.relayConsent !== 'ask')) && (
                    <div className='desc'>
                      {h.relayConsent === 'allow'
                        ? 'Streaming through the relay is allowed for this library. '
                        : h.relayConsent === 'deny'
                          ? 'Streaming through the relay is turned off for this library, so it only plays downloads. '
                          : 'Reachable only through the relay right now. '}
                      <button
                        className='linkbtn'
                        onClick={(e) => {
                          e.stopPropagation(); haptic('light')
                          onSetRelayAudio(h.libraryId, h.relayConsent === 'allow' ? 'deny' : 'allow')
                        }}
                      >{h.relayConsent === 'allow' ? 'Turn off' : 'Allow'}</button>
                    </div>
                  )}
                </div>
                <div className='rowacts'>
                  <button
                    className='rowremove' aria-label={'Rename ' + (h.libraryName || 'library') + ' on this phone'}
                    title='Your own name for this library'
                    onClick={(e) => { e.stopPropagation(); haptic('light'); setAliasEdit({ hostKey: h.hostKey, value: h.alias || '' }) }}
                  >
                    <PencilSimple size={19} weight='regular' />
                  </button>
                  <button className='rowremove' aria-label={'Remove ' + (h.libraryName || 'library')} onClick={(e) => { e.stopPropagation(); onRemoveHost(h) }}>
                    <Trash size={19} weight='regular' />
                  </button>
                </div>
              </div>
            )
          })}
              </>}
        </Section>

        {/* SOUND AND DOWNLOADS. These were two rows, "Streaming quality" and "Offline storage",
            and they answer the SAME question - how much data does this use and what does it leave
            on my phone - so someone worried about their data allowance had to guess which one to
            open (Tim, 2026-07-28). One row, quality first because it applies to every track and the
            cache only to what you keep. */}
        <Section id='sound' title='Sound and downloads' Icon={SpeakerHigh} open={open === 'sound'} onToggle={toggle}>
          {/* AUTO is a mode, not a rung on the quality ladder, so it is a toggle rather than
              the slider's left-hand stop - see the comment on QUALITIES. With it on, the
              slider is disabled and shows nothing misleading; turning it off drops you at
              whatever fixed quality was last chosen. */}
          <div className='row'>
            <div>
              <div className='label'>Choose quality automatically</div>
              <div className='desc'>{QUALITY_AUTO_DESC}</div>
            </div>
            <button
              className={'toggle' + (quality === 'auto' ? ' on' : '')}
              role='switch' aria-checked={quality === 'auto'}
              onClick={() => { haptic('light'); onQuality(quality === 'auto' ? (lastFixedQuality.current || '320') : 'auto') }}
            >{quality === 'auto' ? 'On' : 'Off'}</button>
          </div>
          <div className='label' style={{ marginTop: '.6rem' }}>Streaming quality</div>
          <StepSlider
            options={QUALITIES}
            value={quality === 'auto' ? (lastFixedQuality.current || '320') : quality}
            onChange={onQuality}
            disabled={quality === 'auto'}
            ariaLabel='Streaming quality'
          />
          <div className='label' style={{ marginTop: '.9rem' }}>Offline storage</div>
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
          <StepSlider options={CACHE_CAPS} value={cap} onChange={setCap} ariaLabel='Keep up to' />
          <button
            className='wide'
            style={{ marginTop: '.5rem', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '.4rem' }}
            onClick={clearCache} disabled={!cache?.count}
          >
            <Trash size={16} weight='bold' /> Clear cache
          </button>
          {/* ARTWORK. Covers are kept until their library is removed, which is predictable and
              never re-downloads on a timer (decision 1, proposal 2026-07-29-persist-album-art).
              But a server CAN change an album's art without changing its cover id, and then the
              old image would be right forever - so this is the escape hatch. Whole store rather
              than one album, because "which cover is wrong" is not something the app can know.
              Deliberately NOT next to Clear cache's danger styling: this costs a re-download,
              not your offline music. */}
          <div className='label' style={{ marginTop: '.9rem' }}>Album artwork</div>
          <div className='desc'>
            Covers are saved on this phone the first time they load, so browsing doesn't
            re-download them. If a cover looks wrong or out of date, fetch them again.
          </div>
          {/* The SPACE artwork uses is not obvious from anywhere else. There is deliberately no
              setting to tune it (a count cap, decided 2026-07-29) - but covers measured ~137 KB
              each on a real library, so this can reach a few hundred MB, and a number you cannot
              see is a number nobody reclaims. Refresh below is what reclaims it. */}
          <div className='row'>
            <div><div className='label'>Using</div></div>
            <span className='val'>
              {fmtBytes(cache?.artBytes || 0)}
              {cache?.artCount ? ` · ${cache.artCount} cover${cache.artCount === 1 ? '' : 's'}` : ''}
            </span>
          </div>
          <button
            className='wide'
            style={{ marginTop: '.5rem', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '.4rem' }}
            onClick={refreshArt}
          >
            <ArrowsClockwise size={16} weight='bold' /> Refresh artwork
          </button>
          <div className='row' style={{ marginTop: '.4rem' }}>
            <div>
              <div className='label'>Download over cellular</div>
              <div className='desc'>Off by default - a downloaded album can be hundreds of MB.</div>
            </div>
            <button className={'toggle' + (cellular ? ' on' : '')} role='switch' aria-checked={cellular} onClick={toggleCellular}>
              {cellular ? 'On' : 'Off'}
            </button>
          </div>
        </Section>

        <Section id='conn' title='Connection' Icon={PlugsConnected} open={open === 'conn'} onToggle={toggle}>
          {/* The relay backstop. On by default so a hard-NAT/cellular user can still reach
              home; off is pure peer-to-peer with nothing of PeerLoom's in the path, at the
              cost of "works anywhere". Even on, it is direct-first: the relay only carries a
              connection when the direct hole-punch fails, and it never sees inside the
              encrypted stream. (The old "Run check" diagnostics lived here; removed 2026-07-24,
              slow and superseded by the relay backstop.) */}
          <div className='row'>
            <div>
              <div className='label'>Use the relay when direct fails</div>
              <div className='desc'>
                On by default. If your phone and server can’t connect directly (strict
                carrier NAT), route through PeerLoom’s relay - it only ever carries the
                encrypted stream, never your files. Turn off for pure peer-to-peer, at the
                cost of connecting from some networks.
              </div>
            </div>
            <button className={'toggle' + (useRelay ? ' on' : '')} role='switch' aria-checked={useRelay} onClick={toggleRelay}>
              {useRelay ? 'On' : 'Off'}
            </button>
          </div>
        </Section>

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
          {/* The Recently Added shelf. Off is a real preference, not a fault: someone who knows
              their own library does not need a "new arrivals" rail above it every time. */}
          <div className='row' style={{ marginTop: '.7rem' }}>
            <div>
              <div className='label'>Recently added row</div>
              <div className='desc'>The row of newest albums above your library.</div>
            </div>
            <button
              className={'toggle' + (showRecent ? ' on' : '')} role='switch' aria-checked={showRecent}
              onClick={() => onShowRecent(!showRecent)}
            >{showRecent ? 'On' : 'Off'}</button>
          </div>
        </Section>

      </div>

      <div className='version'>v{APP_VERSION}</div>
    </div>
  )
}

// --- about -------------------------------------------------------------------

function About ({ onDonate, deviceKey }) {
  const [open, setOpen] = useState(null)
  const toggle = (id) => { haptic('light'); setOpen(o => (o === id ? null : id)) }
  const [copied, setCopied] = useState(false)
  const copyKey = () => {
    copyText(deviceKey)
    haptic('success')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className='app'>
      <div className='wordmark'>
        <div className='name'>Pear<span className='tune'>Tune</span></div>
        <div className='muted sm'>Your music, or a friend’s. Anywhere.</div>
      </div>

      <Section id='how' title='How it works' Icon={Info} open={open === 'how'} onToggle={toggle}>
        <p>
          PearTune plays your music straight off the machine it already lives on -
          an Umbrel, a NAS, an old desktop - over an encrypted peer-to-peer
          connection. No port forwarding, no VPN, no dynamic DNS, no account, and
          no copy of your library in anyone's cloud.
        </p>
        <p>
          The machine does not have to be yours. Whoever runs a library can let a
          friend or family member in, each as their own person with their own
          devices, favourites and resume points - no login to pass around, and no
          copy of a single file.
        </p>
        <p>
          The server keeps the list of which devices are allowed in, and can cut one
          off in the middle of a song.
        </p>
        <p>
          On a few networks too strict for a direct connection (some carrier NATs),
          and only then, your phone routes through a relay run by PeerLoom. It carries
          the still-encrypted stream in transit only - never a stored copy of your
          music, and it cannot see the contents, just that your device is reaching
          that server. It is optional: turn it off in Settings → Connection for pure
          peer-to-peer, at the cost of connecting from some networks.
        </p>
        <div className='btnrow'>
          <button onClick={() => openUrl('https://pears.com/')}>Learn about P2P ↗</button>
        </div>
      </Section>

      {/* THIS DEVICE. It lived in Settings as "Device key" until 2026-07-28, and it was the odd one
          out there: Settings is things you CHANGE, and this is a value you READ OUT - to whoever runs
          a library, so they can tell which row in their dashboard is you. About is where the rest of
          "what is this install" already lives, so it belongs here, next to How it works. */}
      <Section id='device' title='This device' Icon={Key} open={open === 'device'} onToggle={toggle}>
        <p>
          The key a library knows this phone by. When someone running a server asks which
          device is yours, or you are deciding what to remove on their dashboard, this is
          the row to look for.
        </p>
        <div className='key'>{deviceKey}</div>
        <div className='btnrow'>
          <button onClick={copyKey}>
            <Copy size={15} /> {copied ? 'Copied' : 'Copy key'}
          </button>
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

      {/* THE DEMO MUSIC'S ARTIST. The tracks are CC0, which waives all rights and requires no
          attribution at all - so this is a courtesy, not a licence term, and it costs nothing.
          Shown to everyone, not only while demo mode is on: the music ships in every copy of the
          app, and someone who tried the demo and then paired a server should still be able to find
          out who made the songs they heard. See assets/demo-music/LICENSE.md. */}
      <Section id='music' title='The sample music' Icon={MusicNotes} open={open === 'music'} onToggle={toggle}>
        <p>
          The few tracks PearTune plays before you connect a server are from the album
          <b> LOFI AMBIENT SONGS !</b> by <b>Loyalty Freak Music</b>, released into the public
          domain under CC0. No attribution is required - we are crediting them because they
          deserve it.
        </p>
        <div className='btnrow'>
          <button onClick={() => openUrl('https://loyaltyfreakmusic.com/')}>Loyalty Freak Music ↗</button>
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

// Ask the owner to add music (proposal 2026-07-24, P1). CREATE only: kind + name +
// optional artist. Your requests + their status live in You > Requests now (a full
// scrolling screen), not here - a bottom-sheet list did not scale (Tim, 2026-07-24).
// On send it closes and onSent refreshes that view. v1 is a human queue: the owner adds
// the music by hand and it appears on the next scan.
function RequestComposer ({ prefill, onClose, toast, onUnsupported, onSent }) {
  const [kind, setKind] = useState('album')
  const [name, setName] = useState(prefill || '')
  const [artist, setArtist] = useState('')
  const [busy, setBusy] = useState(false)

  const send = async () => {
    const nm = name.trim()
    if (!nm) return
    setBusy(true)
    const r = await call('requestAdd', { kind, name: nm, artist: artist.trim() || undefined }).catch(() => null)
    setBusy(false)
    if (!r?.ok) {
      haptic('warn')
      // An old host with no request method: tell the app to hide the affordance for the
      // rest of the session (feature-detect, same posture as favorites/playlists), then close.
      if (r?.supported === false) { toast('This library’s server is too old for requests', true); return onUnsupported?.() }
      return toast(r?.error || 'Could not send the request', true)
    }
    haptic('success')
    // Merged mode fans out to every connected library (r.sent); single-host returns a
    // fold count. Either way, say it landed - and point at where to watch it.
    toast(r.sent > 1 ? `Requested from ${r.sent} libraries. See it in You › Requests.`
      : r.count > 1 ? 'Already requested - the owner has been reminded.'
        : 'Requested. See it in You › Requests.')
    onSent?.()
    onClose()
  }

  const KINDS = [['album', 'Album'], ['artist', 'Artist'], ['track', 'Track']]

  return (
    <div className='sheetwrap' onClick={onClose}>
      <div className='sheet' onClick={e => e.stopPropagation()}>
        <h1>Request music</h1>
        <p className='muted sm'>Ask whoever runs this library to add something that isn’t here yet. They decide.</p>
        <div className='seg wide' style={{ marginTop: '.4rem' }}>
          {KINDS.map(([k, l]) => <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{l}</button>)}
        </div>
        <input value={name} autoFocus placeholder={kind === 'artist' ? 'Artist name' : kind === 'album' ? 'Album title' : 'Song title'}
          maxLength={200} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && !busy && send()} />
        {kind !== 'artist' &&
          <input value={artist} placeholder='Artist (optional)' maxLength={200} onChange={e => setArtist(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !busy && send()} />}
        <div className='btnrow' style={{ marginTop: '.5rem' }}>
          <button onClick={onClose}>Cancel</button>
          <button className='primary' onClick={send} disabled={busy || !name.trim()}>
            {busy ? 'Requesting…' : 'Request'}
          </button>
        </div>
      </div>
    </div>
  )
}

// The two-week nudge (the siblings all show one). Deliberately NOT the full rail
// chooser - just the ask, once. "Donate" opens the real DonationSheet; either quiet
// option answers it for good. Same sheet chrome as Confirm, so it reads as part of
// the app and not a pop-up ad.
function DonationNudge ({ onDonate, onDismiss }) {
  return (
    <div className='sheetwrap' onClick={onDismiss}>
      <div className='sheet' onClick={e => e.stopPropagation()}>
        <h1>⚡ Enjoying PearTune?</h1>
        <p className='muted sm'>
          PearTune is free and open source - no ads, no accounts, no subscriptions. If it
          is useful to you, a tip helps keep it that way. Entirely optional.
        </p>
        <div className='acts'>
          <button className='primary wide' onClick={() => { haptic('light'); onDonate() }}>Support PearTune</button>
          <button className='wide' onClick={() => { haptic('light'); onDismiss() }}>Maybe later</button>
          <button className='wide' onClick={() => { haptic('light'); onDismiss() }}>Already did · thanks ✓</button>
        </div>
      </div>
    </div>
  )
}

// Shown once, the first time a device is confirmed an owner (gated on a persisted flag
// upstream). Same sheet chrome as the nudge, so it reads as part of the app. It names
// the new Manage view, says what it does and drops the person straight into it.
function OwnerTour ({ libraryName, onShow, onDismiss }) {
  return (
    <div className='sheetwrap' onClick={onDismiss}>
      <div className='sheet' onClick={e => e.stopPropagation()}>
        <div className='tourbadge'><UsersThree size={30} weight='fill' /></div>
        <h1>You’re an owner now</h1>
        <p className='muted sm'>
          {libraryName ? <>You look after <b>{libraryName}</b>. </> : <>You look after this library. </>}
          There’s a new <b>Manage</b> tab under <b>You</b> where you run it: see every device
          that has access and cut one off at any time, add a device by QR or link, and answer
          music requests.
        </p>
        <div className='acts'>
          <button className='primary wide' onClick={() => { haptic('light'); onShow() }}>Show me</button>
          <button className='wide' onClick={() => { haptic('light'); onDismiss() }}>Got it</button>
        </div>
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

// --- pairing / onboarding ----------------------------------------------------

// A brand-new install is walked through four cards rather than dropped straight
// onto a form:
//
//   intro -> who are you -> whose library -> pair
//
// The third one is PearTune's own problem, and the reason this is not just the
// siblings' intro-then-name flow. Every other PeerLoom app is phone-to-phone and
// works the moment it is installed; PearTune needs a SERVER running somewhere,
// and someone who installs the app first has nothing to scan and nothing telling
// them why. That card says so, and splits the ways people arrive: running their
// own library, being let into a friend's, or having no server at all yet - which
// is the demo.
//
// NAMING COMES BEFORE THE DEMO CHOICE (Tim, 2026-07-28). It used to sit after the
// whose-library card, which put "Try it without a server" on the intro - so a demo
// user reached a working library having never been asked who they were, and later
// tapping Connect had to rewind them through the naming cards to avoid pairing
// them nameless. Asking first costs one card up front and makes every path after it
// a single step.
//
// ADDING a library over the running app (Settings > Libraries > Add, and Connect
// from the demo banner) skips to the last card: the identity is already
// established, and re-asking would be a wall on the way to scanning a code.
//
// The phase lives in App, not here, so Android back can walk it (see the 'back'
// listener); this component is told which card to draw.
function Onboarding ({
  phase, setPhase, owner, setOwner,
  names, setNames, onScan, onPaste, onCancel, error, addHost = false, pendingLink = null,
  onDemo = null, demoStarting = false, firstServer = false
}) {
  // Pre-filled when the app was OPENED with a pear:// pairing link: the box exists so you can
  // paste a link, and we already have it. Initial value only - once the card is up this is the
  // person's field to edit or clear.
  const [link, setLink] = useState(pendingLink || '')

  // Your name is REQUIRED at ONBOARDING: on the host it is the human a device is confirmed as
  // (per-person revoke needs a person), so an unnamed device is a worse dashboard for the operator.
  // The device name stays optional - it has a sensible fallback. But when ADDING a second library
  // (addHost), the identity is already established (this device is already named + claims a user),
  // so the name card is skipped entirely and we pair straight through with the stored identity.
  const named = names.userName.trim().length > 0
  const ready = addHost || named

  const Wordmark = () => <h1>Pear<span className='tune'>Tune</span></h1>

  if (phase === 'intro') {
    return (
      <div className='center onboard'>
        <Wordmark />
        <p className='muted'>Your music, or a friend’s. Anywhere.</p>
        <div className='namebox obwhy'>
          <div><MusicNotes size={18} weight='bold' /><span>Plays straight off a computer you or a friend owns - an Umbrel, a NAS, an old desktop.</span></div>
          <div><LockKey size={18} weight='bold' /><span>No account, no cloud copy of the files, and nothing on that machine exposed to the internet.</span></div>
          <div><DeviceMobile size={18} weight='bold' /><span>Scan a code once and this phone is allowed in. Whoever runs the library can cut it off any time.</span></div>
        </div>
        <button className='primary' onClick={() => { haptic('light'); setPhase('names') }}>Get started</button>
      </div>
    )
  }

  // Whose library is it? The choice is not cosmetic - it decides whether the next
  // thing you need is a server to install or a friend to ask. Picking one swaps
  // the buttons for that answer; Android back clears the pick before leaving the card.
  if (phase === 'whose') {
    return (
      <div className='center onboard'>
        <Wordmark />
        <p className='muted'>PearTune plays from a <b>PearTune server</b>: a computer with the music on it, running the PearTune host.</p>
        {!owner
          ? (
            <>
              <button className='primary' onClick={() => { haptic('light'); setOwner('mine') }}>It’s mine</button>
              <button onClick={() => { haptic('light'); setOwner('friend') }}>It’s a friend’s</button>
            </>
            )
          : (
            <>
              <div className='namebox'>
                {owner === 'mine'
                  ? <p className='sm'>
                      Install the PearTune host on that computer and open its dashboard - it walks you
                      through naming the library, pointing it at your music and showing a pairing code.
                      Then come back here and scan it - or copy the pairing link under the code and paste
                      it instead, at the pairing step.
                    </p>
                  : <p className='sm'>
                      Ask them to open their PearTune dashboard and press <b>Pair a device</b>. If you are
                      with them, scan the QR code it shows. If you are not, they can copy the pairing link
                      underneath it and send it to you - you can paste that instead of scanning, at the
                      pairing step. Either way it lasts five minutes, and you do not have to be on their
                      wifi.
                    </p>}
              </div>
              {/* The one link a new operator follows OUT of the app, so it should land on the page
                  that answers the question the button asks. It pointed at the PRODUCT page until
                  now, which pitches PearTune to someone who has already installed it and says
                  nothing about how to set a server up (Tim, 2026-07-24). The setup guide exists as
                  of website PR #47: pick the machine, run the installer, expect the unsigned-build
                  warning, open the dashboard, pair. */}
              {owner === 'mine' &&
                <button onClick={() => { haptic('light'); openUrl('https://peerloomllc.com/peartune/docs/setting-up-a-server') }}>How to set up a server ↗</button>}
              <button className='primary' onClick={() => { haptic('light'); setPhase('pair') }}>Continue</button>
              <button onClick={() => { haptic('light'); setOwner(null) }}>Back</button>
            </>
            )}
        {/* THE THIRD ANSWER, and the way out of the wall (proposal 2026-07-28-app-review-demo).
            The two above assume a server exists somewhere. If one does not - the App Store
            reviewer's position, and equally the position of anyone who installs the app before
            setting one up - PearTune has nothing to show and no button to press. So it belongs
            HERE, next to the others, rather than as an escape hatch on the intro: "where is your
            music?" has three honest answers, and "nowhere yet" is one of them.
            Only on the un-answered card, so it never crowds an explainer someone is reading. */}
        {onDemo && !owner && (
          <>
            <div className='obsep' />
            <button onClick={onDemo} disabled={demoStarting}>
              {demoStarting ? 'Setting up…' : 'I don’t have one yet'}
            </button>
            <p className='muted sm hint'>
              Play a few sample tracks that come with the app, so you can look around before you
              have a library to connect to.
            </p>
          </>
        )}
        {!owner && <button onClick={() => { haptic('light'); setPhase('names') }}>Back</button>}
      </div>
    )
  }

  if (phase === 'names') {
    return (
      <div className='center onboard'>
        <Wordmark />
        <p className='muted'>Who is this?</p>
        <div className='namebox'>
          {/* YOUR NAME first, then the device - the same order Settings uses. The two screens
              disagreeing made the pair-then-check-Settings flow read as if the fields had swapped
              places under you. */}
          <label className='muted sm'>Your name</label>
          <input
            value={names.userName}
            onChange={e => setNames({ ...names, userName: e.target.value })}
            placeholder='Your name'
            maxLength={64}
          />
          <label className='muted sm'>This device</label>
          <input
            value={names.deviceName}
            onChange={e => setNames({ ...names, deviceName: e.target.value })}
            placeholder='This phone'
            maxLength={64}
          />
          <p className='muted sm hint'>
            Whoever runs the library sees these, so they know whose device this is.
            They confirm your name before it means anything.
          </p>
        </div>
        {/* Following a pairing link lands HERE, not on the scanner card - the link IS the
            thing the scanner would have produced, and the only thing still missing is a name.
            So this button finishes the job rather than sending you off to find it again. */}
        {pendingLink && (
          <p className='muted sm'>You opened a pairing link. Name yourself and this phone, then tap Pair.</p>
        )}
        <button
          className='primary'
          onClick={() => { haptic('light'); if (pendingLink) onPaste(pendingLink); else setPhase('whose') }}
          disabled={!ready}
        >
          {pendingLink ? 'Pair' : 'Continue'}
        </button>
        <button onClick={() => { haptic('light'); setPhase('intro') }}>Back</button>
      </div>
    )
  }

  // The last card: the scanner and the paste-a-link fallback.
  return (
    <div className='center onboard'>
      <Wordmark />
      <p className='muted'>
        {addHost && !firstServer
          ? 'Open the PearTune dashboard on the server you want to add - yours or a friend’s - and show its pairing code.'
          : owner === 'friend'
            ? 'Scan the pairing code from their dashboard - or paste the link they sent you.'
            : 'Show the pairing code on the server’s dashboard and scan it - or paste the link under it.'}
      </p>
      <Problem error={error} />

      <button className='primary scanbtn' onClick={() => { haptic('medium'); onScan() }} disabled={!ready}>
        <QrCode size={20} weight='bold' /> Scan QR
      </button>
      <details>
        <summary className='muted sm'>Paste a link instead</summary>
        {/* autocapitalize/autocorrect off: iOS was capitalizing the scheme to "Pear://", and parseLink is
            deliberately case-sensitive (for cross-app rejection), so a perfectly good pasted link got
            rejected with "That doesn't look like a PearTune pairing code" (Tim, 2026-07-22). Kill the
            mangling at the source rather than loosening the parser. */}
        <input
          value={link}
          onChange={e => setLink(e.target.value)}
          placeholder='pear://peartune/pair?…'
          autocapitalize='none'
          autocorrect='off'
          autocomplete='off'
          spellcheck={false}
        />
        <button onClick={() => { haptic('medium'); onPaste(link.trim()) }} disabled={!ready || !link.trim()}>Pair</button>
      </details>
      {!addHost && <button onClick={() => { haptic('light'); setPhase('names') }}>Back</button>}
      {onCancel && <button onClick={() => { haptic('light'); onCancel() }}>Cancel</button>}
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

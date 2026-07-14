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
  GridFour, ListPlus, Queue as QueueIcon, Trash
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

export default function App () {
  const [state, setState] = useState({ loading: true })
  const [tab, setTab] = useState('library')
  const [stack, setStack] = useState([]) // drill-downs: album, artist
  const [browse, setBrowse] = useState('albums')
  const [albums, setAlbums] = useState([])
  const [cursor, setCursor] = useState(0)
  const [artists, setArtists] = useState(null)
  const [songs, setSongs] = useState(null)
  const [songCursor, setSongCursor] = useState(0)
  const [density, setDensity] = useState('2')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [now, setNow] = useState(null)
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)
  const [scanning, setScanning] = useState(false)
  const [donate, setDonate] = useState(false)
  const [confirming, setConfirming] = useState(null)
  const [menu, setMenu] = useState(null) // long-press: play / shuffle / queue
  const [queue, setQueue] = useState(null) // the up-next list, when opened
  const [note, setNote] = useState(null) // a transient confirmation
  const [viewing, setViewing] = useState(null) // artwork, full screen
  const [expanded, setExpanded] = useState(false) // the player: mini vs full
  const [albumsLoaded, setAlbumsLoaded] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [shuffle, setShuffle] = useState(false)
  const [repeat, setRepeat] = useState(0) // 0 off, 1 one, 2 all
  const [themePref, setThemePref] = useState(() => loadThemePref())

  useEffect(() => {
    call('init')
      .then((s) => {
        setState({ ...s, loading: false })
        if (s.settings?.density) setDensity(String(s.settings.density))
        if (s.connected) loadAlbums(0)
      })
      .catch(e => setState({ loading: false, error: e.message }))

    const offs = [
      on('play:started', (d) => { setNow(d); setError(null) }),
      on('play:status', setStatus),
      on('play:stopped', () => { setNow(null); setStatus(null) }),
      on('play:error', (d) => setError(d.error)),
      // The link died. Usually this is just Android suspending us in the
      // background, so do NOT accuse the server of revoking anyone - we cannot
      // tell the difference from here, and "your access may have been revoked" is
      // an alarming thing to say when the real answer is "you locked your phone".
      // Mark it and move on; the next thing that needs the wire will reconnect.
      on('host:disconnected', () => {
        setNow(null)
        setStatus(null)
        setState(s => ({ ...s, connected: false }))
      }),
      on('host:connected', (d) => {
        setState(s => ({ ...s, connected: true, host: { ...s.host, ...d } }))
        setError(null)
      }),

      // Back from the background, where the link almost certainly died. Reconnect
      // BEFORE the user asks: they came back to a music app, not to a status page.
      // A ref, not state, because this listener registers once.
      on('app:active', () => {
        const s = liveRef.current
        if (s.host && !s.connected && !s.reconnecting) reconnect()
      })
    ]
    return () => offs.forEach(f => f())
  }, [])

  // What the once-registered listeners above need to see, always current.
  const liveRef = useRef({})
  liveRef.current = { host: state.host, connected: state.connected, reconnecting }

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

  // A tab is a fresh start, so it drops any drill-down under it.
  const goTab = (k) => { haptic('light'); setStack([]); setTab(k) }

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

  async function loadAlbums (from) {
    try {
      const page = await call('albums', { cursor: from, limit: 60 })
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
  async function showArtists (force) {
    setBrowse('artists')
    if (artists && !force) return
    try {
      const page = await call('artists')
      setArtists(page.items)
    } catch (e) {
      setError(e.message)
    }
  }

  // The Songs view. It exists because Navidrome answers an empty-query search3
  // with everything, PAGED - so this is a real list, not the album walk the old
  // code did (which could only ever reach the first page of albums, and is why
  // this view was dropped the first time round).
  async function loadSongs (from) {
    try {
      const page = await call('tracks', { cursor: from, limit: 100 })
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

  // Density is a per-device preference, so it lives where the theme does: the
  // worklet's settings.json, not the WebView's storage.
  function cycleDensity () {
    const next = densityOf(density).next
    haptic('light')
    setDensity(next)
    call('setSettings', { density: next }).catch(() => {})
  }

  // Pull to refresh. The host does not push us anything when its library changes -
  // someone drops an album on the NAS and Navidrome rescans, and we would go on
  // showing yesterday's shelf until the app restarted. This is the gesture people
  // already reach for.
  async function refresh () {
    setError(null)
    if (browse === 'artists') return showArtists(true)
    if (browse === 'songs') return showSongs(true)
    setAlbumsLoaded(false)
    setAlbums([])
    await loadAlbums(0)
  }

  async function runSearch (q) {
    setQuery(q)
    if (!q.trim()) return setResults(null)
    try {
      setResults(await call('search', { q }))
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

  async function onPaired (link) {
    setScanning(false)
    setError(null)
    try {
      const host = await call('pair', { link })
      setState(s => ({ ...s, host, connected: true }))
      haptic('success')
      loadAlbums(0)
    } catch (e) {
      setError(e.message)
      haptic('warn')
    }
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
  const playFrom = (list, t) => {
    haptic('light')
    const index = Math.max(0, list.findIndex(x => x.id === t.id))
    return call('play', { queue: toQueue(list), index })
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

  useEffect(() => {
    if (tab !== 'queue') return
    loadQueue()
  }, [tab, now?.trackId, status?.queueLength])

  function jumpTo (index) {
    haptic('light')
    call('playIndex', { index })
  }

  function clearQueue () {
    haptic('warn')
    call('stop')
    setQueue({ items: [], index: 0 })
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
    return []
  }

  async function menuAction (item, action) {
    setMenu(null)
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

  if (state.loading) return <div className='center'><p className='muted'>Starting…</p></div>

  // Pairing is a wall: with no library there is nothing to navigate, so there is
  // no navbar until there is.
  if (!state.host) {
    return scanning
      ? <Scanner onScan={onPaired} onCancel={() => setScanning(false)} error={error} />
      : <Welcome onScan={() => setScanning(true)} onPaste={onPaired} error={error} />
  }

  const top = stack[stack.length - 1] || null

  const viewArt = (url, title) => { if (url) { haptic('light'); setViewing({ url, title }) } }

  let screen
  if (top?.type === 'album') {
    screen = (
      <AlbumScreen
        id={top.id} now={now} error={error} onBack={pop} onPlay={playFrom}
        onPlayAll={playAll} onQueue={enqueue} onViewArt={viewArt}
      />
    )
  } else if (top?.type === 'artist') {
    screen = (
      <ArtistScreen
        id={top.id} name={top.name} now={now} onPlay={playFrom}
        onBack={pop} onViewArt={viewArt} onLong={setMenu}
        onArtistAction={(artistId, action) => menuAction({ type: 'artist', id: artistId }, action)}
        onOpenAlbum={(id) => push({ type: 'album', id })}
      />
    )
  } else if (tab === 'queue') {
    screen = (
      <QueueScreen
        items={queue?.items || []}
        index={queue?.index ?? 0}
        onJump={jumpTo}
        onClear={clearQueue}
      />
    )
  } else if (tab === 'settings') {
    screen = <Settings state={state} themePref={themePref} onTheme={changeTheme} onUnpair={unpair} />
  } else if (tab === 'about') {
    screen = <About onDonate={() => setDonate(true)} />
  } else {
    screen = (
      <Library
        state={state} albums={albums} artists={artists} songs={songs}
        cursor={cursor} songCursor={songCursor} density={density}
        browse={browse} query={query} results={results} now={now} error={error}
        albumsLoaded={albumsLoaded} reconnecting={reconnecting}
        onBrowse={(b) => {
          haptic('light')
          if (b === 'artists') return showArtists()
          if (b === 'songs') return showSongs()
          return setBrowse('albums')
        }}
        onDensity={cycleDensity}
        onSearch={runSearch}
        onReconnect={reconnect}
        onRefresh={refresh}
        onMore={() => loadAlbums(cursor)}
        onMoreSongs={() => loadSongs(songCursor)}
        onOpenAlbum={(id) => push({ type: 'album', id })}
        onOpenArtist={(a) => push({ type: 'artist', id: a.id, name: a.name })}
        onPlay={playFrom}
        onLong={setMenu}
      />
    )
  }

  return (
    <>
      {screen}

      <div className='dock' ref={dockRef}>
        {now && (
          <Player
            now={now} status={status} expanded={expanded}
            shuffle={shuffle} repeat={repeat} onQueue={() => goTab('queue')}
            onShuffle={toggleShuffle} onRepeat={cycleRepeat}
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
      {menu && (
        <ActionSheet
          item={menu}
          onClose={() => setMenu(null)}
          onAction={(a) => menuAction(menu, a)}
        />
      )}
      {viewing && <ArtViewer {...viewing} onClose={() => setViewing(null)} />}
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
function QueueScreen ({ items, index, onJump, onClear }) {
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

  return (
    <div className='app'>
      <header>
        <h1>Queue</h1>
        <p className='muted sm'>
          {items.length} {items.length === 1 ? 'track' : 'tracks'}
          {left > 0 ? ` · ${left} still to play` : ' · last track'}
        </p>
      </header>

      <ul className='tracks queuelist'>
        {items.map((t, i) => (
          <li
            key={`${t.id}:${i}`}
            className={i === index ? 'on' : (i < index ? 'played' : '')}
            onClick={() => onJump(i)}
          >
            <Cover src={t.art} sm />
            <div className='meta'>
              <div className='t'>{t.title}</div>
              <div className='muted sm sub'>
                {[t.artist, t.album].filter(Boolean).join(' · ')}
              </div>
            </div>
            {i === index
              ? <Play size={14} weight='fill' className='cur' />
              : <span className='muted sm dur'>{t.durationMs ? fmt(t.durationMs) : ''}</span>}
          </li>
        ))}
      </ul>

      {/* Honest label. There is no way to empty the queue without stopping the
          music: the queue IS what is playing. */}
      <button className='more danger' onClick={onClear}>
        <Trash size={15} weight='bold' /> Clear queue and stop
      </button>
    </div>
  )
}

// Play / Shuffle / Add to queue, without drilling into the thing first.
function ActionSheet ({ item, onClose, onAction }) {
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
          <button className='wide' onClick={onClose}>Cancel</button>
        </div>
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

// --- library -----------------------------------------------------------------

function Library ({
  state, albums, artists, songs, cursor, songCursor, density,
  browse, query, results, now, error, albumsLoaded, reconnecting,
  onBrowse, onDensity, onSearch, onReconnect, onRefresh, onMore, onMoreSongs,
  onOpenAlbum, onOpenArtist, onPlay, onLong
}) {
  const searching = results && query.trim()
  const D = densityOf(density)
  // The worklet hands us the base URL rather than finished art URLs, because only
  // the UI knows the density, and therefore the size to ask for.
  const artBase = state.artBase || state.host?.artBase || null

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
  if (!state.connected) {
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
                {error || 'PearTune cannot reach this library. The server may be off, or its access for this device may have been revoked.'}
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
        <h1>{state.host.libraryName || 'Library'}</h1>
        <p className='muted sm'>{count(browse, { albums, artists, songs })}</p>
      </header>

      <div className='sticky'>
        <input
          className='search'
          value={query}
          onChange={e => onSearch(e.target.value)}
          placeholder='Search artists, albums, tracks'
        />
        {!searching && (
          <div className='pickrow'>
            <div className='seg'>
              <button className={browse === 'albums' ? 'on' : ''} onClick={() => onBrowse('albums')}>Albums</button>
              <button className={browse === 'artists' ? 'on' : ''} onClick={() => onBrowse('artists')}>Artists</button>
              <button className={browse === 'songs' ? 'on' : ''} onClick={() => onBrowse('songs')}>Songs</button>
            </div>
            {/* Stays PUT in the Songs view, disabled, rather than disappearing.
                A control that vanishes reflows the row it was in, and the picker
                you just tapped jumps sideways under your thumb - which reads as a
                glitch, not as "this does not apply here". Songs is a list; there is
                no density to choose. */}
            <button
              className='icon dens'
              onClick={onDensity}
              disabled={browse === 'songs'}
              aria-label={browse === 'songs' ? 'Layout (not available for songs)' : 'Change layout'}
            >
              <D.Icon size={20} weight='regular' />
            </button>
          </div>
        )}
      </div>

      {error && <div className='error'>{error}</div>}

      {searching
        ? (
          <SearchResults
            results={results} now={now} d={D} artBase={artBase}
            onOpenAlbum={onOpenAlbum} onOpenArtist={onOpenArtist} onPlay={onPlay} onLong={onLong}
          />
          )
        : browse === 'songs'
          ? (songs
              ? (songs.length
                  ? (
                    <>
                      <ul className='tracks'>
                        {songs.map(t => (
                          <Row
                            key={t.id} t={t} on={now?.trackId === t.id}
                            onPlay={() => onPlay(songs, t)} onLong={onLong} art
                          />
                        ))}
                      </ul>
                      {songCursor != null && (
                        <button className='more' onClick={onMoreSongs}>Load more</button>
                      )}
                    </>
                    )
                  : <Empty />)
              : <SkeletonRows />)
          : browse === 'artists'
            ? (artists
                ? <ArtistGrid artists={artists} onOpen={onOpenArtist} onLong={onLong} d={D} />
                : <SkeletonGrid round d={D} />)
            : !albumsLoaded
                ? <SkeletonGrid d={D} />
                : albums.length
                  ? (
                    <>
                      <Grid albums={albums} onOpen={onOpenAlbum} onLong={onLong} d={D} artBase={artBase} />
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

function count (browse, { albums, artists, songs }) {
  if (browse === 'artists') return `${artists ? artists.length : 0} artists`
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
function SearchResults ({ results, now, d, artBase, onOpenAlbum, onOpenArtist, onPlay, onLong }) {
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
                  <ArtistGrid artists={g.items} onOpen={onOpenArtist} onLong={onLong} d={d} />
                )}
                {g.key === 'albums' && (
                  <Grid albums={g.items} onOpen={onOpenAlbum} onLong={onLong} d={d} artBase={artBase} />
                )}
                {g.key === 'tracks' && (
                  <ul className='tracks'>
                    {g.items.map(t => (
                      <Row
                        key={t.id} t={t} on={now?.trackId === t.id}
                        onPlay={() => onPlay(g.items, t)} onLong={onLong} art
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

function Grid ({ albums, onOpen, onLong, d = DENSITY[2], artBase }) {
  if (!albums.length) return null
  const list = d.cols === 1
  return (
    <div className={'grid' + (list ? ' aslist' : '')} style={{ '--cols': d.cols }}>
      {albums.map(a => (
        <Tile
          key={a.id} className='album'
          onPress={() => onOpen(a.id)}
          onLongPress={onLong && (() => onLong({ type: 'album', id: a.id, name: a.name }))}
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

// One element, two gestures: tap opens it, a long press offers to play it.
function Tile ({ className, onPress, onLongPress, children }) {
  const press = usePress(onPress, onLongPress)
  return <div className={className} {...press}>{children}</div>
}

// The art URL is built HERE because the size depends on the density, and asking
// the worklet to re-list the whole library just to change a number in a URL would
// be silly. Falls back to whatever it precomputed if the base is missing.
function artFor (x, d, artBase) {
  if (!x.coverId || !artBase) return x.art || null
  return `${artBase}${encodeURIComponent(x.coverId)}?s=${d.art}`
}

function ArtistGrid ({ artists, onOpen, onLong, d = DENSITY[2], empty = <p className='muted center-p'>No artists.</p> }) {
  if (!artists.length) return empty
  const list = d.cols === 1
  return (
    <div className={'grid' + (list ? ' aslist' : '')} style={{ '--cols': d.cols }}>
      {artists.map(a => (
        <Tile
          key={a.id} className='album artist'
          onPress={() => onOpen(a)}
          onLongPress={onLong && (() => onLong({ type: 'artist', id: a.id, name: a.name }))}
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
function AlbumScreen ({ id, now, error, onBack, onPlay, onPlayAll, onQueue, onViewArt }) {
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
        <div>
          <h1>{album.name}</h1>
          <p className='muted sm'>{[album.artist, album.year].filter(Boolean).join(' · ')}</p>
        </div>
      </div>

      <Actions
        onPlay={() => onPlayAll(tracks)}
        onShuffle={() => onPlayAll(tracks, { shuffled: true })}
        onQueue={() => onQueue(tracks)}
      />

      <ul className='tracks'>
        {tracks.map(t => (
          <Row key={t.id} t={t} on={now?.trackId === t.id} onPlay={() => onPlay(tracks, t)} showTrackNo />
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
function ArtistScreen ({ id, name, now, onBack, onOpenAlbum, onPlay, onViewArt, onLong, onArtistAction }) {
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
        <div>
          <h1>{artist?.name || name}</h1>
          {artist && (
            <p className='muted sm'>
              {artist.albums.length
                ? `${artist.albums.length} ${artist.albums.length === 1 ? 'album' : 'albums'}`
                : `${artist.tracks?.length || 0} ${artist.tracks?.length === 1 ? 'track' : 'tracks'}`}
            </p>
          )}
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
        ? <Grid albums={artist.albums} onOpen={onOpenAlbum} onLong={onLong} />
        : artist.tracks?.length
          ? (
            <ul className='tracks'>
              {artist.tracks.map(t => (
                <Row
                  key={t.id} t={t} on={now?.trackId === t.id}
                  onPlay={() => onPlay(artist.tracks, t)} onLong={onLong} art
                />
              ))}
            </ul>
            )
          : <p className='muted center-p'>Nothing here.</p>)}
    </div>
  )
}

function Row ({ t, on, onPlay, onLong, showTrackNo, art }) {
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
      <span className='muted sm dur'>{t.durationMs ? fmt(t.durationMs) : ''}</span>
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
  now, status, expanded, shuffle, repeat, onShuffle, onRepeat, onExpand, onCollapse,
  onViewArt, onQueue
}) {
  const dur = status?.durationMs || now.durationMs || 0
  const pos = status?.positionMs || 0
  const pct = dur ? Math.min(100, (pos / dur) * 100) : 0
  const qlen = status?.queueLength ?? now.queueLength ?? 0

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
              onClick={() => { haptic('light'); call('stop') }}
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
          <button className='icon' onClick={() => call('seekBy', { seconds: 15 })} aria-label='Forward 15 seconds'>
            15 <ArrowClockwise size={15} />
          </button>
        </div>
      </div>
    </div>
  )
}

function fmt (ms) {
  if (!ms && ms !== 0) return '--:--'
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// --- settings ----------------------------------------------------------------

function Settings ({ state, themePref, onTheme, onUnpair }) {
  const [copied, setCopied] = useState(false)

  const copyKey = () => {
    copyText(state.deviceKeyZ32 || state.deviceKey)
    haptic('success')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className='app'>
      <header><h1>Settings</h1></header>

      <div className='card'>
        <h3>Appearance</h3>
        <div className='seg'>
          {[['dark', 'Dark'], ['light', 'Light'], ['system', 'System']].map(([k, l]) => (
            <button
              key={k} className={themePref === k ? 'on' : ''}
              aria-pressed={themePref === k}
              onClick={() => { haptic('light'); onTheme(k) }}
            >{l}</button>
          ))}
        </div>
      </div>

      <div className='card'>
        <h3>Library</h3>
        <div className='row'>
          <div>
            <div className='label'>{state.host?.libraryName || 'Library'}</div>
            <div className='desc'>{state.connected ? 'Connected' : 'Not connected'}</div>
          </div>
          <span className='val' style={{ color: state.connected ? 'var(--color-primary)' : undefined }}>
            {state.connected ? '●' : '○'}
          </span>
        </div>
        <div className='row'>
          <div>
            <div className='label'>Unpair</div>
            <div className='desc'>
              Forget this library. You will need a new pairing code to reconnect.
            </div>
          </div>
          <button className='danger' onClick={onUnpair}>Unpair</button>
        </div>
      </div>

      <div className='card'>
        <h3>This device</h3>
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

function Welcome ({ onScan, onPaste, error }) {
  const [link, setLink] = useState('')
  return (
    <div className='center'>
      <h1>PearTune</h1>
      <p className='muted'>
        Your self-hosted music, anywhere. Open the PearTune dashboard on your
        server and show the pairing code.
      </p>
      {error && <div className='error'>{error}</div>}
      <button className='primary' onClick={onScan}>Scan pairing code</button>
      <details>
        <summary className='muted sm'>Paste a link instead</summary>
        <input value={link} onChange={e => setLink(e.target.value)} placeholder='pear://peartune/pair?…' />
        <button onClick={() => onPaste(link.trim())} disabled={!link.trim()}>Pair</button>
      </details>
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

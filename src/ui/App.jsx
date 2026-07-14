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
  EnvelopeSimple, Code, Copy, PlugsConnected, ArrowsClockwise
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

export default function App () {
  const [state, setState] = useState({ loading: true })
  const [tab, setTab] = useState('library')
  const [stack, setStack] = useState([]) // drill-downs: album, artist
  const [browse, setBrowse] = useState('albums')
  const [albums, setAlbums] = useState([])
  const [cursor, setCursor] = useState(0)
  const [artists, setArtists] = useState(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [now, setNow] = useState(null)
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)
  const [scanning, setScanning] = useState(false)
  const [donate, setDonate] = useState(false)
  const [confirming, setConfirming] = useState(null)
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
        if (s.connected) loadAlbums(0)
      })
      .catch(e => setState({ loading: false, error: e.message }))

    const offs = [
      on('play:started', (d) => { setNow(d); setError(null) }),
      on('play:status', setStatus),
      on('play:stopped', () => { setNow(null); setStatus(null) }),
      on('play:error', (d) => setError(d.error)),
      on('host:disconnected', () => {
        setNow(null)
        setStatus(null)
        setError('The host disconnected. Your access may have been revoked, or the server is offline.')
        setState(s => ({ ...s, connected: false }))
      }),
      on('host:connected', (d) => {
        setState(s => ({ ...s, connected: true, host: { ...s.host, ...d } }))
        setError(null)
      })
    ]
    return () => offs.forEach(f => f())
  }, [])

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
  navRef.current = { scanning, donate, confirming, expanded, stack, tab }

  const canBack = !!(scanning || donate || confirming || expanded || stack.length || tab !== 'library')
  useEffect(() => { call('shell:navState', { canBack }).catch(() => {}) }, [canBack])

  // Deepest layer first: a sheet, then the expanded player, then the screen stack,
  // then back to the Library tab. Only when all of that is empty does the shell
  // stop swallowing the press and Android closes the app.
  useEffect(() => on('back', () => {
    const n = navRef.current
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
  async function showArtists () {
    setBrowse('artists')
    if (artists) return
    try {
      const page = await call('artists')
      setArtists(page.items)
    } catch (e) {
      setError(e.message)
    }
  }

  async function runSearch (q) {
    setQuery(q)
    if (!q.trim()) return setResults(null)
    try {
      setResults(await call('search', { q }))
    } catch (e) {
      setError(e.message)
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

  // Tapping a track queues the whole list behind it - which is what people mean
  // when they tap a track in an album.
  const playFrom = (list, t) => {
    haptic('light')
    const queue = list.map(x => ({
      id: x.id, title: x.title, artist: x.artist, album: x.album, art: x.art ?? null, durationMs: x.durationMs
    }))
    const index = Math.max(0, list.findIndex(x => x.id === t.id))
    return call('play', { queue, index })
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

  let screen
  if (top?.type === 'album') {
    screen = <AlbumScreen id={top.id} now={now} error={error} onBack={pop} onPlay={playFrom} />
  } else if (top?.type === 'artist') {
    screen = (
      <ArtistScreen
        id={top.id} name={top.name} onBack={pop}
        onOpenAlbum={(id) => push({ type: 'album', id })}
      />
    )
  } else if (tab === 'settings') {
    screen = <Settings state={state} themePref={themePref} onTheme={changeTheme} onUnpair={unpair} />
  } else if (tab === 'about') {
    screen = <About onDonate={() => setDonate(true)} />
  } else {
    screen = (
      <Library
        state={state} albums={albums} artists={artists} cursor={cursor}
        browse={browse} query={query} results={results} now={now} error={error}
        albumsLoaded={albumsLoaded} reconnecting={reconnecting}
        onBrowse={(b) => { haptic('light'); return b === 'artists' ? showArtists() : setBrowse('albums') }}
        onSearch={runSearch}
        onReconnect={reconnect}
        onMore={() => loadAlbums(cursor)}
        onOpenAlbum={(id) => push({ type: 'album', id })}
        onOpenArtist={(a) => push({ type: 'artist', id: a.id, name: a.name })}
        onPlay={playFrom}
      />
    )
  }

  return (
    <>
      {screen}

      <div className='dock' ref={dockRef}>
        {now && (expanded
          ? (
            <NowPlaying
              now={now} status={status}
              shuffle={shuffle} repeat={repeat}
              onShuffle={toggleShuffle} onRepeat={cycleRepeat}
              onCollapse={() => { haptic('light'); setExpanded(false) }}
            />
            )
          : (
            <MiniPlayer
              now={now} status={status}
              onExpand={() => { haptic('light'); setExpanded(true) }}
            />
            ))}
        {/* The navbar stays put during a drill-down, unlike PearList's (which
            hides it inside a list). A music app's dock is fixed furniture: the
            player sits on top of it, and dropping the navbar under an album would
            make the player jump down the screen mid-song. */}
        <NavBar active={tab} onTab={goTab} />
      </div>

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
  { key: 'settings', label: 'Settings', Icon: Gear },
  { key: 'about', label: 'About', Icon: Info }
]

function NavBar ({ active, onTab }) {
  return (
    <nav className='navbar'>
      {TABS.map(({ key, label, Icon }) => {
        const on = active === key
        return (
          <button
            key={key} className={on ? 'on' : ''} onClick={() => onTab(key)}
            aria-current={on ? 'page' : undefined} aria-label={label}
          >
            <Icon size={22} weight={on ? 'fill' : 'regular'} />
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
  state, albums, artists, cursor, browse, query, results, now, error,
  albumsLoaded, reconnecting,
  onBrowse, onSearch, onReconnect, onMore, onOpenAlbum, onOpenArtist, onPlay
}) {
  const searching = results && query.trim()

  // Paired but unreachable. The server is a machine in someone's house: it gets
  // turned off, rebooted, moved. That is not an error, it is Tuesday - so it gets
  // a screen that explains itself and a button, not a red banner.
  if (!state.connected) {
    return (
      <div className='app'>
        <header><h1>{state.host.libraryName || 'Library'}</h1></header>
        <div className='blank'>
          <PlugsConnected size={40} weight='thin' />
          <h2>Not connected</h2>
          <p className='muted sm'>
            {error || 'PearTune cannot reach this library right now. The server may be off, or its access for this device may have been revoked.'}
          </p>
          <button className='primary' onClick={onReconnect} disabled={reconnecting}>
            <ArrowsClockwise size={16} weight='bold' />
            {reconnecting ? 'Reconnecting…' : 'Try again'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className='app'>
      <header>
        <h1>{state.host.libraryName || 'Library'}</h1>
        <p className='muted sm'>
          {browse === 'artists'
            ? `${artists ? artists.length : 0} artists`
            : `${albums.length} albums`}
        </p>
        <input
          className='search'
          value={query}
          onChange={e => onSearch(e.target.value)}
          placeholder='Search artists, albums, tracks'
        />
        {!searching && (
          <div className='seg' style={{ marginTop: '.4rem' }}>
            <button className={browse === 'albums' ? 'on' : ''} onClick={() => onBrowse('albums')}>Albums</button>
            <button className={browse === 'artists' ? 'on' : ''} onClick={() => onBrowse('artists')}>Artists</button>
          </div>
        )}
      </header>

      {error && <div className='error'>{error}</div>}

      {searching
        ? (
          <>
            {!!results.artists?.length && <h2>Artists</h2>}
            <ArtistGrid artists={results.artists || []} onOpen={onOpenArtist} empty={null} />
            {!!results.albums.length && <h2>Albums</h2>}
            <Grid albums={results.albums} onOpen={onOpenAlbum} />
            {!!results.tracks.length && <h2>Tracks</h2>}
            <ul className='tracks'>
              {results.tracks.map(t => (
                <Row key={t.id} t={t} on={now?.trackId === t.id} onPlay={() => onPlay(results.tracks, t)} />
              ))}
            </ul>
            {!results.albums.length && !results.tracks.length && !results.artists?.length && (
              <p className='muted center-p'>Nothing found.</p>
            )}
          </>
          )
        : browse === 'artists'
          ? (artists
              ? <ArtistGrid artists={artists} onOpen={onOpenArtist} />
              : <SkeletonGrid round />)
          : !albumsLoaded
              ? <SkeletonGrid />
              : albums.length
                ? (
                  <>
                    <Grid albums={albums} onOpen={onOpenAlbum} />
                    {cursor != null && <button className='more' onClick={onMore}>Load more</button>}
                  </>
                  )
                : (
                  <div className='blank'>
                    <MusicNotesSimple size={40} weight='thin' />
                    <h2>Nothing here yet</h2>
                    <p className='muted sm'>
                      This library has no albums. Add music on the server and let it
                      rescan.
                    </p>
                  </div>
                  )}
    </div>
  )
}

// A grid of the right SHAPE, greyed and breathing, rather than the word
// "Loading…" in the middle of an empty screen. The tiles are exactly the size the
// covers will be, so nothing jumps when they arrive.
function SkeletonGrid ({ round, n = 6 }) {
  return (
    <div className='grid'>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className={'album' + (round ? ' artist' : '')}>
          <div className={'cover skel' + (round ? ' artistpic' : '')} />
          <div className='skel line' />
          <div className='skel line short' />
        </div>
      ))}
    </div>
  )
}

function Grid ({ albums, onOpen }) {
  if (!albums.length) return null
  return (
    <div className='grid'>
      {albums.map(a => (
        <div key={a.id} className='album' onClick={() => onOpen(a.id)}>
          <Cover src={a.art} />
          <div className='t sm'>{a.name}</div>
          <div className='muted sm sub'>{a.artist}</div>
        </div>
      ))}
    </div>
  )
}

function ArtistGrid ({ artists, onOpen, empty = <p className='muted center-p'>No artists.</p> }) {
  if (!artists.length) return empty
  return (
    <div className='grid'>
      {artists.map(a => (
        <div key={a.id} className='album artist' onClick={() => onOpen(a)}>
          <Cover src={a.art} artist />
          <div className='t sm'>{a.name}</div>
          {a.albumCount != null && (
            <div className='muted sm sub'>{a.albumCount} {a.albumCount === 1 ? 'album' : 'albums'}</div>
          )}
        </div>
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
function AlbumScreen ({ id, now, error, onBack, onPlay }) {
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
  const tracks = (album.tracks || []).map(t => ({ ...t, art: t.art ?? album.art }))

  return (
    <div className='app'>
      <Back onClick={onBack} />
      {problem && <div className='error'>{problem}</div>}

      <div className='albumhead'>
        <Cover src={album.art} big />
        <div>
          <h1>{album.name}</h1>
          <p className='muted sm'>{[album.artist, album.year].filter(Boolean).join(' · ')}</p>
        </div>
      </div>

      <ul className='tracks'>
        {tracks.map(t => (
          <Row key={t.id} t={t} on={now?.trackId === t.id} onPlay={() => onPlay(tracks, t)} showTrackNo />
        ))}
      </ul>
    </div>
  )
}

// An artist IS its albums (one getArtist call on the host), so this is the album
// grid again rather than a new kind of screen.
function ArtistScreen ({ id, name, onBack, onOpenAlbum }) {
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
        <Cover src={artist?.art} big artist />
        <div>
          <h1>{artist?.name || name}</h1>
          {artist && (
            <p className='muted sm'>
              {artist.albums.length} {artist.albums.length === 1 ? 'album' : 'albums'}
            </p>
          )}
        </div>
      </div>

      {err && <div className='error'>{err}</div>}
      {!artist && !err && <p className='muted center-p'>Loading…</p>}
      {artist && (artist.albums.length
        ? <Grid albums={artist.albums} onOpen={onOpenAlbum} />
        : <p className='muted center-p'>No albums.</p>)}
    </div>
  )
}

function Row ({ t, on, onPlay, showTrackNo }) {
  return (
    <li className={on ? 'on' : ''} onClick={() => onPlay(t)}>
      {showTrackNo && <span className='muted sm no'>{t.track ?? ''}</span>}
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

// The dock's resting state. The full transport is ~200px of a phone screen, which
// is a lot of furniture to keep in view while browsing a library - so by default
// the player is one row (art, title, play/pause) with a hairline of progress, and
// tapping it opens the real thing.
function MiniPlayer ({ now, status, onExpand }) {
  const dur = status?.durationMs || now.durationMs || 0
  const pos = status?.positionMs || 0
  const pct = dur ? Math.min(100, (pos / dur) * 100) : 0

  return (
    <div className='player mini' onClick={onExpand}>
      <div className='row1'>
        <Cover src={now.art} sm />
        <div className='meta'>
          <div className='t'>{now.title}</div>
          <div className='muted sm sub'>
            {status?.buffering
              ? 'buffering…'
              : [now.artist, now.album].filter(Boolean).join(' · ') || ' '}
          </div>
        </div>
        {/* stopPropagation, or play/pause would also expand the player - the one
            control people hit without looking should not move the screen. */}
        <button
          className='icon big'
          onClick={(e) => { e.stopPropagation(); haptic('light'); call('toggle') }}
          aria-label='Play/pause'
        >
          {status?.playing ? <Pause size={22} weight='fill' /> : <Play size={22} weight='fill' />}
        </button>
      </div>
      <div className='hairline'><div className='fill' style={{ width: pct + '%' }} /></div>
    </div>
  )
}

function NowPlaying ({ now, status, shuffle, repeat, onShuffle, onRepeat, onCollapse }) {
  const dur = status?.durationMs || now.durationMs || 0
  const pos = status?.positionMs || 0
  const pct = dur ? Math.min(100, (pos / dur) * 100) : 0

  // Tap anywhere on the bar to seek. The seek goes out over P2P as a byte-range
  // request, which is why range support had to be right from day one.
  const scrub = (e) => {
    if (!dur) return
    const r = e.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
    call('seekTo', { ms: Math.round(ratio * dur) })
  }

  return (
    <div className='player'>
      <button className='grip' onClick={onCollapse} aria-label='Collapse player'>
        <CaretDown size={16} weight='bold' />
      </button>

      <div className='row1'>
        <Cover src={now.art} sm />
        <div className='meta'>
          <div className='t'>{now.title}</div>
          <div className='muted sm sub'>
            {status?.buffering
              ? 'buffering…'
              : [now.artist, now.album].filter(Boolean).join(' · ') || ' '}
          </div>
        </div>
        <button
          className='icon close'
          onClick={() => { haptic('light'); call('stop') }}
          aria-label='Stop'
        >
          <X size={18} weight='bold' />
        </button>
      </div>

      <div className='bar' onClick={scrub}>
        <div className='fill' style={{ width: pct + '%' }} />
      </div>
      <div className='times muted sm'>
        <span>{fmt(pos)}</span>
        <span>{now.queueLength > 1 ? `${(status?.index ?? now.index) + 1} / ${now.queueLength}` : ''}</span>
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

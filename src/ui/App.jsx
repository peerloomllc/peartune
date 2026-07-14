// PearTune UI.
//
// Albums are the way in, not a flat track list. Two reasons, and the second is
// the hard one: a 1358-track flat list is not a music app, AND Subsonic has no
// "all songs" endpoint - a flat list can only ever show the first page of albums
// walked. Browsing by album is both the better UX and the only correct one.

import { useEffect, useState, useRef } from 'react'
import jsQR from 'jsqr'
import { call, on } from './bridge'

export default function App () {
  const [state, setState] = useState({ loading: true })
  const [albums, setAlbums] = useState([])
  const [cursor, setCursor] = useState(0)
  const [open, setOpen] = useState(null) // the album being viewed
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [now, setNow] = useState(null)
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)
  const [scanning, setScanning] = useState(false)

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

  async function loadAlbums (from) {
    try {
      const page = await call('albums', { cursor: from, limit: 60 })
      setAlbums(a => (from ? [...a, ...page.items] : page.items))
      setCursor(page.nextCursor)
    } catch (e) {
      setError(e.message)
    }
  }

  async function openAlbum (id) {
    try {
      setOpen({ loading: true })
      setOpen(await call('album', { id }))
    } catch (e) {
      setOpen(null)
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

  async function onPaired (link) {
    setScanning(false)
    setError(null)
    try {
      const host = await call('pair', { link })
      setState(s => ({ ...s, host, connected: true }))
      loadAlbums(0)
    } catch (e) {
      setError(e.message)
    }
  }

  const play = (t) => call('play', { trackId: t.id, title: t.title })

  if (state.loading) return <div className="center"><p className="muted">Starting…</p></div>

  if (!state.host) {
    return scanning
      ? <Scanner onScan={onPaired} onCancel={() => setScanning(false)} error={error} />
      : <Welcome onScan={() => setScanning(true)} onPaste={onPaired} error={error} />
  }

  if (open) {
    return (
      <Album
        album={open}
        now={now}
        onBack={() => setOpen(null)}
        onPlay={play}
        footer={now && <NowPlaying now={now} status={status} />}
      />
    )
  }

  const searching = results && query.trim()

  return (
    <div className="app">
      <header>
        <h1>{state.host.libraryName || 'Library'}</h1>
        <p className="muted sm">
          {state.connected ? `${albums.length} albums` : 'Not connected'}
        </p>
        <input
          className="search"
          value={query}
          onChange={e => runSearch(e.target.value)}
          placeholder="Search artists, albums, tracks"
        />
      </header>

      {error && <div className="error">{error}</div>}

      {searching
        ? (
          <>
            {!!results.albums.length && <h2>Albums</h2>}
            <Grid albums={results.albums} onOpen={openAlbum} />
            {!!results.tracks.length && <h2>Tracks</h2>}
            <ul className="tracks">
              {results.tracks.map(t => (
                <Row key={t.id} t={t} on={now?.trackId === t.id} onPlay={play} />
              ))}
            </ul>
            {!results.albums.length && !results.tracks.length && (
              <p className="muted center-p">Nothing found.</p>
            )}
          </>
          )
        : (
          <>
            <Grid albums={albums} onOpen={openAlbum} />
            {cursor != null && (
              <button className="more" onClick={() => loadAlbums(cursor)}>Load more</button>
            )}
          </>
          )}

      {now && <NowPlaying now={now} status={status} />}
    </div>
  )
}

function Grid ({ albums, onOpen }) {
  if (!albums.length) return null
  return (
    <div className="grid">
      {albums.map(a => (
        <div key={a.id} className="album" onClick={() => onOpen(a.id)}>
          <Cover src={a.art} />
          <div className="t sm">{a.name}</div>
          <div className="muted sm sub">{a.artist}</div>
        </div>
      ))}
    </div>
  )
}

// The cover comes over P2P via the worklet's loopback server. A library often
// has albums with no art at all, so a missing cover must look intentional rather
// than broken.
function Cover ({ src, big }) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) return <div className={'cover ph' + (big ? ' big' : '')} />
  return (
    <img
      className={'cover' + (big ? ' big' : '')}
      src={src}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}

function Album ({ album, now, onBack, onPlay, footer }) {
  if (album.loading) return <div className="center"><p className="muted">Loading…</p></div>

  return (
    <div className="app">
      <button className="back" onClick={onBack}>‹ Back</button>

      <div className="albumhead">
        <Cover src={album.art} big />
        <div>
          <h1>{album.name}</h1>
          <p className="muted sm">
            {[album.artist, album.year].filter(Boolean).join(' · ')}
          </p>
        </div>
      </div>

      <ul className="tracks">
        {(album.tracks || []).map(t => (
          <Row key={t.id} t={t} on={now?.trackId === t.id} onPlay={onPlay} showTrackNo />
        ))}
      </ul>

      {footer}
    </div>
  )
}

function Row ({ t, on, onPlay, showTrackNo }) {
  return (
    <li className={on ? 'on' : ''} onClick={() => onPlay(t)}>
      {showTrackNo && <span className="muted sm no">{t.track ?? ''}</span>}
      <div className="meta">
        <div className="t">{t.title}</div>
        <div className="muted sm sub">
          {t.artist
            ? [t.artist, t.album].filter(Boolean).join(' · ')
            : `${(t.size / 1048576).toFixed(1)} MB`}
        </div>
      </div>
      <span className="muted sm dur">{t.durationMs ? fmt(t.durationMs) : ''}</span>
    </li>
  )
}

function NowPlaying ({ now, status }) {
  return (
    <footer>
      <div className="meta">
        <div className="t">{now.title}</div>
        <div className="muted sm">
          {status?.buffering ? 'buffering…' : status?.playing ? 'playing' : 'paused'}
          {status?.durationMs ? ` · ${fmt(status.positionMs)} / ${fmt(status.durationMs)}` : ''}
        </div>
      </div>
      <button onClick={() => call('stop')}>Stop</button>
    </footer>
  )
}

function fmt (ms) {
  if (!ms && ms !== 0) return '--:--'
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function Welcome ({ onScan, onPaste, error }) {
  const [link, setLink] = useState('')
  return (
    <div className="center">
      <h1>PearTune</h1>
      <p className="muted">
        Your self-hosted music, anywhere. Open the PearTune dashboard on your
        server and show the pairing code.
      </p>
      {error && <div className="error">{error}</div>}
      <button className="primary" onClick={onScan}>Scan pairing code</button>
      <details>
        <summary className="muted sm">Paste a link instead</summary>
        <input value={link} onChange={e => setLink(e.target.value)} placeholder="pear://peartune/pair?…" />
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

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => {
        stream = s
        video.current.srcObject = s
        video.current.play()
        tick()
      })
      .catch(() => setMsg('Camera unavailable. Paste the link instead.'))

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
    <div className="scanner">
      <video ref={video} playsInline muted />
      <canvas ref={canvas} style={{ display: 'none' }} />
      <div className="overlay">
        <p>{msg}</p>
        {error && <div className="error">{error}</div>}
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

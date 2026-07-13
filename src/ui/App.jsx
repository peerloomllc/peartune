// PearTune UI. Milestone 1: pair, browse, play, and show plainly when the host
// cuts us off.
//
// It is deliberately plain. The design pass comes once the transport is proven on
// real hardware; shipping a beautiful UI on top of an unproven connection would
// be building the roof first.

import { useEffect, useState, useRef } from 'react'
import jsQR from 'jsqr'
import { call, on } from './bridge'

export default function App () {
  const [state, setState] = useState({ loading: true })
  const [tracks, setTracks] = useState([])
  const [now, setNow] = useState(null)
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)
  const [scanning, setScanning] = useState(false)

  useEffect(() => {
    call('init')
      .then(async (s) => {
        setState({ ...s, loading: false })
        if (s.connected) loadTracks()
      })
      .catch(e => setState({ loading: false, error: e.message }))

    const offs = [
      on('play:started', (d) => { setNow(d); setError(null) }),
      on('play:status', setStatus),
      on('play:stopped', () => { setNow(null); setStatus(null) }),
      on('play:error', (d) => setError(d.error)),
      // The host revoked us, or went away. Say so; do not leave a dead player.
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

  async function loadTracks () {
    try {
      const { items } = await call('tracks', { limit: 300 })
      setTracks(items)
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
      loadTracks()
    } catch (e) {
      setError(e.message)
    }
  }

  if (state.loading) return <div className="center"><p className="muted">Starting…</p></div>

  if (!state.host) {
    return scanning
      ? <Scanner onScan={onPaired} onCancel={() => setScanning(false)} error={error} />
      : <Welcome onScan={() => setScanning(true)} onPaste={onPaired} error={error} />
  }

  return (
    <div className="app">
      <header>
        <h1>{state.host.libraryName || 'Library'}</h1>
        <p className="muted">
          {state.connected
            ? `${tracks.length} tracks`
            : 'Not connected'}
        </p>
      </header>

      {error && <div className="error">{error}</div>}

      <ul className="tracks">
        {tracks.map(t => (
          <li
            key={t.id}
            className={now?.trackId === t.id ? 'on' : ''}
            onClick={() => call('play', { trackId: t.id, title: t.title })}
          >
            <span className="t">{t.title}</span>
            <span className="muted sm">{(t.size / 1048576).toFixed(1)} MB</span>
          </li>
        ))}
      </ul>

      {now && (
        <footer>
          <div>
            <div className="t">{now.title}</div>
            <div className="muted sm">
              {status?.buffering ? 'buffering…' : status?.playing ? 'playing' : 'paused'}
              {status?.durationMs
                ? ` · ${fmt(status.positionMs)} / ${fmt(status.durationMs)}`
                : ''}
            </div>
          </div>
          <button onClick={() => call('stop')}>Stop</button>
        </footer>
      )}
    </div>
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
        <input
          value={link}
          onChange={e => setLink(e.target.value)}
          placeholder="pear://peartune/pair?…"
        />
        <button onClick={() => onPaste(link.trim())} disabled={!link.trim()}>Pair</button>
      </details>
    </div>
  )
}

// The camera QR scanner runs in the WebView with getUserMedia + jsQR, the same
// approach PearList already ships, so there is no native scanner module.
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

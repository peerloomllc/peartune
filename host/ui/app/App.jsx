import { useState, useEffect, useRef, useCallback } from 'react'
import {
  MusicNotes, UsersThree, Broadcast, Heart, Sun, Moon, GearSix, SignOut,
  CaretRight, Plus, X, Copy, ArrowSquareOut, CurrencyBtc, CheckCircle
} from '@phosphor-icons/react'
import QRCode from 'qrcode'
import { api, copyText, ago, DONATE } from './api'
import { loadThemePref, applyThemePref, resolveTheme } from './theme'

// The operator control plane, as an app shell adapted from the PearCircle seeder's
// #153 redesign: a fixed top bar, a scrollable middle (stats + the people-first
// access list + the music source), a fixed action bar, and modals. It replaced
// host/ui/page.js, a 700-line hand-written HTML string that had produced a stored
// XSS and two syntax-in-a-string bugs; React escapes by default, so that class of
// bug is gone.

/* ---- themed confirm (replaces window.confirm on the control plane) --------- */
let _pushConfirm = null
function askConfirm (opts) {
  return new Promise(resolve => {
    if (!_pushConfirm) return resolve(window.confirm(opts.message || opts.title))
    _pushConfirm({ ...opts, resolve })
  })
}
function ConfirmHost () {
  const [c, setC] = useState(null)
  useEffect(() => { _pushConfirm = setC; return () => { _pushConfirm = null } }, [])
  useEffect(() => {
    if (!c) return
    const h = e => { if (e.key === 'Escape') { c.resolve(false); setC(null) } }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [c])
  if (!c) return null
  const close = v => { c.resolve(v); setC(null) }
  return (
    <div className='overlay' onMouseDown={e => { if (e.target === e.currentTarget) close(false) }}>
      <div className='modal confirm' role='alertdialog' aria-modal='true'>
        <h3>{c.title}</h3>
        {c.message && <p className='hint'>{c.message}</p>}
        <div className='confirm-actions'>
          <button className='ghost' onClick={() => close(false)}>{c.cancelLabel || 'Cancel'}</button>
          <button className={c.danger ? 'destructive' : ''} onClick={() => close(true)} autoFocus>{c.confirmLabel || 'Confirm'}</button>
        </div>
      </div>
    </div>
  )
}

export default function App () {
  const [state, setState] = useState(null)
  const [note, setNote] = useState(null)
  const [modal, setModal] = useState(null) // 'pair' | 'support' | null
  const [pref, setPref] = useState(loadThemePref())

  useEffect(() => { applyThemePref(pref) }, [pref])

  const toast = useCallback((msg, bad) => {
    setNote({ msg, bad })
    clearTimeout(toast._t)
    toast._t = setTimeout(() => setNote(null), bad ? 3600 : 2400)
  }, [])

  const refresh = useCallback(async () => {
    const s = await api('/api/state')
    if (s && s.stats) setState(s)
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 3000)
    return () => clearInterval(t)
  }, [refresh])

  const cycleTheme = () => setPref(resolveTheme(pref) === 'dark' ? 'light' : 'dark')
  const isDark = resolveTheme(pref) === 'dark'

  if (!state) {
    return <div className='app'><div className='main'><div className='empty'>Connecting to the host…</div></div></div>
  }

  const st = state.stats || {}
  const liveDevices = (state.devices || []).filter(d => !d.revokedAt)

  return (
    <div className='app'>
      <TopBar state={state} isDark={isDark} onTheme={cycleTheme} onOpen={setModal} />

      <div className='main'>
        {state.sourceError &&
          <div className='banner'>The music source is not working: {state.sourceError}</div>}

        <div className='stats'>
          <div className='stat hero'><div className='num'>{st.tracks || 0}</div><div className='lbl'>tracks</div></div>
          <div className='stat'><div className='num'>{st.albums || 0}</div><div className='lbl'>albums</div></div>
          <div className='stat'><div className='num'>{st.artists || 0}</div><div className='lbl'>artists</div></div>
        </div>

        <AccessPanel state={state} refresh={refresh} toast={toast} online={liveDevices.filter(d => d.online).length} />
        <SourcePanel state={state} refresh={refresh} toast={toast} />
      </div>

      <div className='actionbar'>
        <Identity hostKey={state.hostKey} />
        <div className='spacer' />
        <button onClick={() => setModal('pair')}><Broadcast size={16} weight='bold' /> Pair a device</button>
      </div>

      {modal === 'pair' && <PairModal onClose={() => setModal(null)} toast={toast} />}
      {modal === 'support' && <SupportModal onClose={() => setModal(null)} />}
      {note && <div className={'toast' + (note.bad ? ' err' : '')}>{note.msg}</div>}
      <ConfirmHost />
    </div>
  )
}

/* ---- top bar -------------------------------------------------------------- */
function TopBar ({ state, isDark, onTheme, onOpen }) {
  const [menu, setMenu] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!menu) return
    const h = e => { if (!ref.current?.contains(e.target)) setMenu(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [menu])

  const st = state.stats || {}
  const sourceOk = !state.sourceError
  const logout = async () => { await api('/api/logout', {}); location.reload() }

  return (
    <header className='topbar'>
      <div className='brand'>
        <div className='brand-mark'><MusicNotes size={18} weight='fill' /></div>
        <div>
          <div className='brand-name'>Pear<span>Tune</span></div>
          <div className='brand-sub'>{state.libraryName || 'your music, anywhere'}</div>
        </div>
      </div>
      <div className='topbar-right'>
        <span className='pill' title={sourceOk ? 'Music source' : state.sourceError}>
          <span className={'dot ' + (sourceOk ? 'good' : 'bad')} />
          {st.source || 'no source'}
        </span>
        <button className='iconbtn' onClick={onTheme} aria-label='Toggle theme' title={isDark ? 'Switch to light' : 'Switch to dark'}>
          {isDark ? <Sun size={17} /> : <Moon size={17} />}
        </button>
        <div className='menuwrap' ref={ref}>
          <button className='iconbtn' onClick={() => setMenu(v => !v)} aria-label='Menu' aria-expanded={menu}><GearSix size={17} /></button>
          {menu &&
            <div className='menu' role='menu'>
              <button onClick={() => { setMenu(false); onOpen('support') }}><Heart size={16} /> Support development</button>
              <div className='sep' />
              <button onClick={() => { setMenu(false); logout() }}><SignOut size={16} /> Log out</button>
            </div>}
        </div>
      </div>
    </header>
  )
}

function Identity ({ hostKey }) {
  const [copied, setCopied] = useState(false)
  if (!hostKey) return <div className='identity' />
  const short = hostKey.slice(0, 8) + '…' + hostKey.slice(-6)
  const copy = async () => { if (await copyText(hostKey)) { setCopied(true); setTimeout(() => setCopied(false), 1200) } }
  return (
    <div className='identity' title={hostKey}>
      <span className='subtle'>host</span>
      <span className='mono'>{short}</span>
      <button className='iconbtn' style={{ width: 28, height: 28 }} onClick={copy} aria-label='Copy host key'>
        {copied ? <CheckCircle size={15} weight='fill' color='var(--good)' /> : <Copy size={14} />}
      </button>
    </div>
  )
}

/* ---- people-first access -------------------------------------------------- */
function AccessPanel ({ state, refresh, toast, online }) {
  const [open, setOpen] = useState({})
  const [showRevoked, setShowRevoked] = useState(false)
  const [pname, setPname] = useState('')

  const persons = (state.persons || []).filter(p => !p.revokedAt)
  const devices = state.devices || []
  const byPerson = id => devices.filter(d => d.personId === id)
  const unassigned = devices.filter(d => !d.personId && !d.revokedAt)
  const revokedLoose = devices.filter(d => !d.personId && d.revokedAt)
  const revokedCount = devices.filter(d => d.revokedAt).length

  const mutate = async (path, body, ok) => {
    const r = await api(path, body)
    if (r.error) return toast('Failed: ' + r.error, true)
    if (ok) toast(ok(r))
    refresh()
  }
  const addPerson = () => {
    const name = pname.trim()
    if (!name) return
    setPname('')
    mutate('/api/person', { name }, () => `Added ${name}.`)
  }
  const revokePerson = async p => {
    if (!await askConfirm({ title: `Revoke all of ${p.name}'s devices?`, message: 'They lose access immediately, even mid-song. Nobody else is affected. Their play counts stay in your history.', confirmLabel: 'Revoke all', danger: true })) return
    mutate('/api/person/revoke', { personId: p.id }, r => `Revoked ${p.name}: ${r.devices} device(s), ${r.killed} live connection(s) cut off.`)
  }
  const deletePerson = async p => {
    if (!await askConfirm({ title: `Delete ${p.name}?`, message: 'They have no devices, so this only tidies the list. Nothing is revoked.', confirmLabel: 'Delete' })) return
    mutate('/api/person/delete', { personId: p.id }, () => `Deleted ${p.name}.`)
  }
  const revoke = async d => {
    if (!await askConfirm({ title: `Revoke "${d.label}"?`, message: 'It loses access immediately, even mid-song. Its play counts stay in your history.', confirmLabel: 'Revoke', danger: true })) return
    mutate('/api/revoke', { deviceKey: d.deviceKey }, r => r.killed > 0
      ? `Revoked ${d.label} and cut off ${r.killed} live connection${r.killed === 1 ? '' : 's'}.`
      : `Revoked ${d.label}. It was not connected.`)
  }
  const deleteDevice = async d => {
    if (!await askConfirm({ title: `Delete "${d.label}"?`, message: 'Access is already revoked and stays revoked. This only removes the record; the device would have to pair again to return.', confirmLabel: 'Delete' })) return
    mutate('/api/device/delete', { deviceKey: d.deviceKey }, () => `Deleted ${d.label}.`)
  }
  const confirmClaim = async d => {
    if (!await askConfirm({ title: `Confirm ${d.label} belongs to ${d.claimedUser}?`, message: 'They will be created if new, and you can then revoke all of their devices in one click.', confirmLabel: 'Confirm' })) return
    mutate('/api/person/confirm', { deviceKey: d.deviceKey }, r => `${d.label} now belongs to ${r.person.name}.`)
  }
  const assign = (d, personId) => mutate('/api/assign', { deviceKey: d.deviceKey, personId: personId || null })

  const empty = !persons.length && !unassigned.length && !(showRevoked && revokedCount)

  return (
    <div className='panel grow'>
      <div className='panel-head'>
        <h2>People &amp; devices</h2>
        <span className='count'>{online ? `· ${online} online` : ''}</span>
      </div>
      <div className='list'>
        {empty
          ? <div className='empty'><strong>No devices paired yet.</strong><br />Use “Pair a device” below to add one.</div>
          : <>
              {persons.map(p => {
                const theirs = byPerson(p).filter(d => !d.revokedAt || showRevoked)
                const live = byPerson(p).filter(d => !d.revokedAt)
                const on = live.filter(d => d.online).length
                const isOpen = open[p.id]
                return (
                  <div className='person' key={p.id}>
                    <div className='prow' onClick={() => setOpen(o => ({ ...o, [p.id]: !o[p.id] }))}>
                      <CaretRight size={14} weight='bold' className={'caret' + (isOpen ? ' open' : '')} />
                      <span className={'live' + (on ? '' : ' off')} aria-hidden='true' />
                      <div className='who'>
                        <div className='name'>{p.name}</div>
                        <div className='sub'>{live.length} device{live.length === 1 ? '' : 's'}{on ? ` · ${on} online` : ''}</div>
                      </div>
                      {live.length
                        ? <button className='ghost small danger' onClick={e => { e.stopPropagation(); revokePerson(p) }}>Revoke all</button>
                        : <button className='ghost small danger' onClick={e => { e.stopPropagation(); deletePerson(p) }}>Delete</button>}
                    </div>
                    {isOpen &&
                      <div className='devices-sub'>
                        {theirs.map(d => <DeviceRow key={d.deviceKey} d={d} persons={persons} onRevoke={revoke} onDelete={deleteDevice} onConfirm={confirmClaim} />)}
                      </div>}
                  </div>
                )
              })}
              {(unassigned.length || (showRevoked && revokedLoose.length)) ?
                <>
                  <div className='group-h'>Unassigned</div>
                  {unassigned.map(d => <DeviceRow key={d.deviceKey} d={d} persons={persons} onAssign={assign} onRevoke={revoke} onDelete={deleteDevice} onConfirm={confirmClaim} loose />)}
                  {showRevoked && revokedLoose.map(d => <DeviceRow key={d.deviceKey} d={d} onRevoke={revoke} onDelete={deleteDevice} onConfirm={confirmClaim} loose />)}
                </> : null}
            </>}
      </div>
      <div style={{ padding: '0 16px 14px' }}>
        <div className='addrow'>
          <input value={pname} placeholder='Name (e.g. Ben)' onChange={e => setPname(e.target.value)} onKeyDown={e => e.key === 'Enter' && addPerson()} />
          <button className='ghost' onClick={addPerson}><Plus size={15} weight='bold' /> Add</button>
        </div>
        {revokedCount ?
          <div className='footer-toggle'>{revokedCount} revoked · <button className='link' onClick={() => setShowRevoked(v => !v)}>{showRevoked ? 'hide' : 'show'}</button></div>
          : null}
      </div>
    </div>
  )
}

function DeviceRow ({ d, persons, onAssign, onRevoke, onDelete, onConfirm, loose }) {
  const holder = persons && persons.find(p => p.id === d.personId)
  const matches = holder && d.claimedUser && holder.name.toLowerCase() === d.claimedUser.toLowerCase()
  const showClaim = !d.revokedAt && d.claimedUser && !matches
  return (
    <div>
      <div className='drow'>
        {loose && <span className={'live' + (d.revokedAt ? ' rev' : (d.online ? '' : ' off'))} aria-hidden='true' />}
        <div className='who'>
          <div className='name'>{d.label}{d.revokedAt && <span className='badge'>revoked</span>}</div>
          {d.revokedAt
            ? <div className='sub rev'>revoked {ago(d.revokedAt)}</div>
            : <div className='sub'>{d.online ? 'connected' : 'last seen ' + ago(d.lastSeenAt)}</div>}
        </div>
        {onAssign && !d.revokedAt &&
          <select className='assign' value={d.personId || ''} onChange={e => onAssign(d, e.target.value)}>
            <option value=''>— unassigned —</option>
            {(persons || []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>}
        {d.revokedAt
          ? <button className='ghost small danger' onClick={() => onDelete(d)}>Delete</button>
          : <button className='ghost small danger' onClick={() => onRevoke(d)}>Revoke</button>}
      </div>
      {showClaim &&
        <div className='claim'>
          {holder ? 'now claims to be ' : 'claims to be '}<b>{d.claimedUser}</b>
          <button className='small' onClick={() => onConfirm(d)}>Confirm</button>
        </div>}
    </div>
  )
}

/* ---- music source panel --------------------------------------------------- */
const SERVERS = {
  subsonic: { label: 'Subsonic server', placeholder: 'http://localhost:4533' },
  jellyfin: { label: 'Jellyfin / Emby', placeholder: 'http://localhost:8096' }
}

function SourcePanel ({ state, refresh, toast }) {
  const [kind, setKind] = useState('folder')
  const [cfg, setCfg] = useState({})
  const [dirty, setDirty] = useState(false)
  const [msg, setMsg] = useState(null)
  const [browse, setBrowse] = useState(null)
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty

  useEffect(() => {
    if (dirtyRef.current) return
    const kinds = (state.source && state.source.kinds) || {}
    setKind((state.source && state.source.active) || 'folder')
    setCfg({
      subsonic: { url: '', username: '', ...(kinds.subsonic || {}) },
      jellyfin: { url: '', username: '', ...(kinds.jellyfin || {}) },
      folder: { root: '/music', ...(kinds.folder || {}) }
    })
  }, [state.source])

  const touch = () => setDirty(true)
  const set = (k, v) => { setCfg(c => ({ ...c, [kind]: { ...c[kind], [k]: v } })); touch() }
  const pick = k => { setKind(k); touch(); setBrowse(null) }
  const cancel = () => { setDirty(false); setMsg(null); setBrowse(null); refresh() }

  const form = () => {
    const c = cfg[kind] || {}
    if (kind === 'folder') return { kind: 'folder', root: (c.root || '').trim() }
    const out = { kind, url: (c.url || '').trim(), username: (c.username || '').trim() }
    if (c.password) out.password = c.password
    if (kind === 'subsonic' && c.apiKey) out.apiKey = c.apiKey
    return out
  }
  const test = async () => {
    setMsg({ text: 'testing…' })
    const r = await api('/api/source/test', form())
    if (!r.ok) return setMsg({ text: r.error, ok: false })
    setMsg(r.tracks ? { text: `works — ${r.tracks} tracks`, ok: true } : { text: 'reachable, but no music in there.', ok: false })
  }
  const save = async () => {
    setMsg({ text: 'saving…' })
    const r = await api('/api/source', form())
    if (!r.ok) return setMsg({ text: r.error, ok: false })
    setDirty(false); setBrowse(null)
    await refresh()
    setMsg({ text: `saved — ${r.tracks} tracks`, ok: true })
    toast('Music source saved.')
  }
  const rescan = async () => {
    setMsg({ text: 'rescanning…' })
    const r = await api('/api/source/rescan', {})
    await refresh()
    setMsg(r.ok ? { text: `rescanned — ${r.tracks} tracks`, ok: true } : { text: r.error, ok: false })
  }
  const openBrowse = async path => {
    setBrowse({ loading: true })
    const start = path || (cfg.folder && cfg.folder.root) || '/'
    let r = await api('/api/source/folders?path=' + encodeURIComponent(start))
    if (r.error) r = await api('/api/source/folders?path=/')
    setBrowse(r.error ? { error: r.error } : r)
  }

  const c = cfg[kind] || {}
  const server = SERVERS[kind]

  return (
    <div className='panel'>
      <div className='panel-head'><h2><MusicNotes size={13} weight='bold' style={{ verticalAlign: '-2px', marginRight: 5 }} />Music source</h2></div>
      <div className='panel-body'>
        <div className='seg'>
          <button className={kind === 'subsonic' ? 'on' : ''} onClick={() => pick('subsonic')}>Subsonic</button>
          <button className={kind === 'jellyfin' ? 'on' : ''} onClick={() => pick('jellyfin')}>Jellyfin / Emby</button>
          <button className={kind === 'folder' ? 'on' : ''} onClick={() => pick('folder')}>Folder</button>
        </div>

        {kind === 'folder'
          ? <>
              <label>Folder <span className='subtle'>— a path inside the PearTune container</span></label>
              <div className='pick'>
                <input value={c.root || ''} placeholder='/music' onChange={e => set('root', e.target.value)} />
                <button className='ghost' onClick={() => openBrowse()}>Browse…</button>
              </div>
              {browse && <FolderBrowser browse={browse} onOpen={openBrowse} onUse={p => { set('root', p); setBrowse(null) }} />}
            </>
          : <>
              <label>{server.label} URL</label>
              <input value={c.url || ''} placeholder={server.placeholder} onChange={e => set('url', e.target.value)} />
              <label>Username</label>
              <input value={c.username || ''} placeholder='umbrel' onChange={e => set('username', e.target.value)} />
              <label>Password</label>
              <input type='password' placeholder={c.hasPassword ? 'unchanged' : 'password'} onChange={e => set('password', e.target.value)} />
              {kind === 'subsonic' && <>
                <label>API key <span className='subtle'>— optional; for servers that use one</span></label>
                <input type='password' placeholder={c.hasApiKey ? 'unchanged' : 'leave blank to use username + password'} onChange={e => set('apiKey', e.target.value)} />
              </>}
            </>}

        <div className='srcactions'>
          <button className='ghost small' onClick={test}>Test</button>
          <button className='small' onClick={save}>Save</button>
          <button className='ghost small' onClick={rescan}>Rescan</button>
          {dirty && <button className='ghost small' onClick={cancel}>Cancel</button>}
          {msg && <span className={msg.ok === true ? 'msg-good' : msg.ok === false ? 'msg-bad' : 'subtle'}>{msg.text}</span>}
        </div>
        {dirty && <p className='hint warn' style={{ marginTop: 10 }}>Changing the source changes every track's identity, so play counts and resume positions from the old source will not follow. Nothing is deleted.</p>}
      </div>
    </div>
  )
}

function FolderBrowser ({ browse, onOpen, onUse }) {
  if (browse.loading) return <div className='browse'><div className='empty' style={{ padding: '10px' }}>looking…</div></div>
  if (browse.error) return <div className='browse'><div className='empty' style={{ padding: '10px' }}>{browse.error}</div></div>
  return (
    <div className='browse'>
      <div className='head'>
        <code className='mono' style={{ fontSize: 12, color: 'var(--muted)' }}>{browse.path}{browse.here ? ` · ${browse.here} audio files` : ''}</code>
        <button className='small' onClick={() => onUse(browse.path)}>Use this folder</button>
      </div>
      <ul>
        {browse.parent && <li><button onClick={() => onOpen(browse.parent)}>../</button></li>}
        {(browse.dirs || []).map(d =>
          <li key={d.path}><button onClick={() => onOpen(d.path)}><span>{d.name}/</span>{d.music && <span className='has'>music</span>}</button></li>)}
        {!(browse.dirs || []).length && !browse.here && <li><div className='empty' style={{ padding: '10px' }}>nothing in here</div></li>}
      </ul>
    </div>
  )
}

/* ---- modals --------------------------------------------------------------- */
function Modal ({ title, onClose, children }) {
  useEffect(() => {
    const h = e => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className='overlay' onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className='modal' role='dialog' aria-modal='true' aria-label={title}>
        <div className='modal-head'>
          <h3>{title}</h3>
          <button className='iconbtn' onClick={onClose} aria-label='Close'><X size={17} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

function PairModal ({ onClose, toast }) {
  const [qr, setQr] = useState(null) // { link, dataUrl }
  const [busy, setBusy] = useState(false)
  const start = async () => {
    setBusy(true)
    const { link } = await api('/api/pair/start', {})
    const dataUrl = await QRCode.toDataURL(link, { width: 240, margin: 1, errorCorrectionLevel: 'M' }).catch(() => null)
    setQr({ link, dataUrl })
    setBusy(false)
  }
  const stop = async () => { await api('/api/pair/stop', {}); setQr(null); toast('Pairing window closed.') }
  return (
    <Modal title='Pair a device' onClose={async () => { if (qr) await api('/api/pair/stop', {}); onClose() }}>
      {!qr
        ? <div className='stack center'>
            <p className='hint center'>Opens a 5 minute window. Scan the code in PearTune on your phone.</p>
            <button onClick={start} disabled={busy}>{busy ? 'Starting…' : 'Show pairing code'}</button>
          </div>
        : <div className='stack center'>
            {qr.dataUrl && <img className='qr' src={qr.dataUrl} alt='Pairing QR code' />}
            <div className='hint center'>Valid for 5 minutes. Closes as soon as one device pairs.</div>
            <div className='key addr'>{qr.link}</div>
            <button className='ghost' onClick={stop}>Cancel</button>
          </div>}
    </Modal>
  )
}

// The seeder's donation panel, ported: two no-account rails (Bitcoin, USD/card),
// a QR per rail, rendered entirely client-side. Same addresses as the phone app.
function SupportModal ({ onClose }) {
  const [tab, setTab] = useState('btc')
  const [qr, setQr] = useState(null)
  const [copied, setCopied] = useState(null)
  const payload = tab === 'btc' ? DONATE.lightning : DONATE.bmcUrl
  useEffect(() => {
    let cancelled = false
    setQr(null)
    QRCode.toDataURL(payload, { width: 200, margin: 1, errorCorrectionLevel: 'M' })
      .then(u => { if (!cancelled) setQr(u) }).catch(() => {})
    return () => { cancelled = true }
  }, [payload])
  const copy = async (what, value) => { if (await copyText(value)) { setCopied(what); setTimeout(() => setCopied(null), 1500) } }
  return (
    <Modal title='Support development' onClose={onClose}>
      <div className='stack center'>
        <p className='hint center'>PearTune is free and open source. No accounts, no servers, no subscriptions — if it brings you value, a tip helps keep it free. Entirely optional.</p>
        <div className='tabs'>
          <button className={tab === 'btc' ? '' : 'ghost'} onClick={() => setTab('btc')}>⚡ Bitcoin</button>
          <button className={tab === 'usd' ? '' : 'ghost'} onClick={() => setTab('usd')}>💲 Card / USD</button>
        </div>
        {qr ? <img className='qr' src={qr} alt={tab === 'btc' ? 'Lightning QR' : 'Buy Me a Coffee QR'} /> : <div className='empty'>generating…</div>}

        {tab === 'btc'
          ? <>
              <div className='hint center'>Scan with any Lightning wallet (pick your own amount), or copy the address.</div>
              <h4>Lightning address</h4>
              <div className='key addr'>{DONATE.lightning}</div>
              <div className='btnrow'>
                <button className='ghost small' onClick={() => copy('ln', DONATE.lightning)}>{copied === 'ln' ? 'Copied' : <><Copy size={14} /> Copy</>}</button>
                <a className='btn small' href={DONATE.strikeUrl} target='_blank' rel='noopener noreferrer'><ArrowSquareOut size={14} /> Pay in a browser</a>
              </div>
              <h4><CurrencyBtc size={12} weight='bold' style={{ verticalAlign: '-1px' }} /> On-chain Bitcoin</h4>
              <div className='key addr'>{DONATE.onchain}</div>
              <div className='btnrow'>
                <button className='ghost small' onClick={() => copy('btc', DONATE.onchain)}>{copied === 'btc' ? 'Copied' : <><Copy size={14} /> Copy</>}</button>
              </div>
            </>
          : <>
              <div className='hint center'>Scan to open Buy Me a Coffee, or open it here to pay by card.</div>
              <div className='key addr'>{DONATE.bmcUrl}</div>
              <div className='btnrow'>
                <button className='ghost small' onClick={() => copy('bmc', DONATE.bmcUrl)}>{copied === 'bmc' ? 'Copied' : <><Copy size={14} /> Copy</>}</button>
                <a className='btn small' href={DONATE.bmcUrl} target='_blank' rel='noopener noreferrer'><ArrowSquareOut size={14} /> Open</a>
              </div>
            </>}
      </div>
    </Modal>
  )
}

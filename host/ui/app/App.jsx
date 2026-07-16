import { useState, useEffect, useRef, useCallback } from 'react'
import {
  MusicNotes, UsersThree, Broadcast, Heart, Sun, Moon,
  SignOut, CaretRight, Plus, X, Copy, ArrowSquareOut, CurrencyBtc
} from '@phosphor-icons/react'
import QRCode from 'qrcode'
import { api, copyText, ago, DONATE } from './api'
import { loadThemePref, applyThemePref, resolveTheme } from './theme'

// The whole operator surface on one screen: pair a device, manage who has access,
// choose the music source, and support development. It replaces host/ui/page.js -
// a 700-line hand-written HTML string that was the control plane and had already
// grown a stored XSS and two template-literal syntax bugs. React escapes by
// default, so the class of bug that page kept producing cannot happen here.

export default function App () {
  const [state, setState] = useState(null)
  const [note, setNote] = useState(null)
  const [donate, setDonate] = useState(false)
  const [pref, setPref] = useState(loadThemePref())

  // Toast: a transient confirmation. `bad` gives it the error colour and a longer
  // dwell, because "revoked" and "that failed" deserve different attention.
  const toast = useCallback((msg, bad) => {
    setNote({ msg, bad })
    clearTimeout(toast._t)
    toast._t = setTimeout(() => setNote(null), bad ? 3600 : 2400)
  }, [])

  const refresh = useCallback(async () => {
    const s = await api('/api/state')
    if (s && s.stats) setState(s)
  }, [])

  // Poll every 3s so a device coming online, or another operator's change, shows
  // up without a manual reload. The source panel guards its own in-progress edits
  // (see SourcePanel) - the poll updates everything around it.
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 3000)
    return () => clearInterval(t)
  }, [refresh])

  // Apply the theme as an EFFECT, never during render: applyThemePref mutates
  // <html> and localStorage, and this component re-renders every 3s on the poll.
  useEffect(() => { applyThemePref(pref) }, [pref])
  const cycleTheme = () => setPref(resolveTheme(pref) === 'dark' ? 'light' : 'dark')

  const logout = async () => {
    await api('/api/logout', {})
    location.reload()
  }

  if (!state) {
    return <div className='dash'><p className='empty'>Loading…</p></div>
  }

  const st = state.stats || {}
  const liveDevices = (state.devices || []).filter(d => !d.revokedAt)
  const isDark = resolveTheme(pref) === 'dark' // resolves 'system' too

  return (
    <div className='dash'>
      <div className='topbar'>
        <div>
          <div className='brand'>
            Pear<span>Tune</span>
            {state.libraryName && state.libraryName !== 'PearTune' &&
              <span className='libname'> · {state.libraryName}</span>}
          </div>
          <div className='stats'>
            <b>{st.tracks || 0}</b> tracks
            {st.albums ? <> · <b>{st.albums}</b> albums</> : null}
            {st.artists ? <> · <b>{st.artists}</b> artists</> : null}
            {' · '}{st.source || '?'}
            {' · '}<b>{liveDevices.length}</b> device{liveDevices.length === 1 ? '' : 's'}
          </div>
        </div>
        <div className='spacer' />
        <div className='actions'>
          <button className='ghost sm' onClick={() => setDonate(true)}>
            <Heart size={16} weight='fill' color='var(--color-error)' style={{ verticalAlign: '-3px' }} /> Support
          </button>
          <button className='icon ghost' title='Theme' onClick={cycleTheme}>
            {isDark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button className='icon ghost' title='Log out' onClick={logout}><SignOut size={18} /></button>
        </div>
      </div>

      {state.sourceError &&
        <div className='banner'>The music source is not working: {state.sourceError}</div>}

      <div className='grid'>
        <div className='col'>
          <PairPanel toast={toast} />
          <SourcePanel state={state} refresh={refresh} toast={toast} />
        </div>
        <div className='col'>
          <AccessPanel state={state} refresh={refresh} toast={toast} />
        </div>
      </div>

      {note && <div className={'toast' + (note.bad ? ' err' : '')}>{note.msg}</div>}
      {donate && <DonationSheet onClose={() => setDonate(false)} />}
    </div>
  )
}

// --- pairing -----------------------------------------------------------------

function PairPanel ({ toast }) {
  const [qr, setQr] = useState(null) // { link, dataUrl }
  const [busy, setBusy] = useState(false)

  const start = async () => {
    setBusy(true)
    const { link } = await api('/api/pair/start', {})
    const dataUrl = await QRCode.toDataURL(link, { width: 240, margin: 1, errorCorrectionLevel: 'M' }).catch(() => null)
    setQr({ link, dataUrl })
    setBusy(false)
  }

  const stop = async () => {
    await api('/api/pair/stop', {})
    setQr(null)
    toast('Pairing window closed.')
  }

  return (
    <div className='panel'>
      <h2><Broadcast size={14} weight='bold' /> Pair a device</h2>
      {!qr
        ? <>
            <button className='primary' onClick={start} disabled={busy}>Show pairing code</button>
            <p className='hint'>Opens a 5 minute window. Scan the code in PearTune on your phone.</p>
          </>
        : <div className='pair-qr'>
            {qr.dataUrl && <img src={qr.dataUrl} alt='Pairing QR code' />}
            <p className='hint' style={{ textAlign: 'center', margin: 0 }}>Valid for 5 minutes. Closes as soon as one device pairs.</p>
            <code>{qr.link}</code>
            <button onClick={stop}>Cancel</button>
          </div>}
    </div>
  )
}

// --- music source ------------------------------------------------------------

const SERVERS = {
  subsonic: { label: 'Subsonic server', placeholder: 'http://localhost:4533' },
  jellyfin: { label: 'Jellyfin / Emby', placeholder: 'http://localhost:8096' }
}
const KINDS = ['subsonic', 'jellyfin', 'folder']

function SourcePanel ({ state, refresh, toast }) {
  const [kind, setKind] = useState('folder')
  const [cfg, setCfg] = useState({}) // per-kind form values, seeded from the store
  const [dirty, setDirty] = useState(false)
  const [msg, setMsg] = useState(null) // { text, ok }
  const [browse, setBrowse] = useState(null) // folder browser listing
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty

  // Seed the form from the store, but ONLY while the operator is not editing.
  // Click Folder, and two seconds later the poll would otherwise re-render the
  // card from the server's truth (still Navidrome) and throw the choice away. So
  // once you touch this card, it is yours until Save or Cancel.
  useEffect(() => {
    if (dirtyRef.current) return
    const kinds = (state.source && state.source.kinds) || {}
    const active = (state.source && state.source.active) || 'folder'
    setKind(active)
    setCfg({
      subsonic: { url: '', username: '', ...(kinds.subsonic || {}) },
      jellyfin: { url: '', username: '', ...(kinds.jellyfin || {}) },
      folder: { root: '/music', ...(kinds.folder || {}) }
    })
  }, [state.source])

  const touch = () => setDirty(true)
  const set = (k, v) => { setCfg(c => ({ ...c, [kind]: { ...c[kind], [k]: v } })); touch() }
  const pick = (k) => { setKind(k); touch(); setBrowse(null) }

  const cancel = () => { setDirty(false); setMsg(null); setBrowse(null); refresh() }

  // The wire form for the active kind. A blank password or api key means "keep the
  // one you already have" - the host never sends secrets back to the browser, so an
  // empty box must not clear them.
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
    setMsg(r.tracks
      ? { text: `works — ${r.tracks} tracks`, ok: true }
      : { text: 'reachable, but no music in there. Nothing to play.', ok: false })
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

  const openBrowse = async (path) => {
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
      <h2><MusicNotes size={14} weight='bold' /> Music source</h2>
      <div className='seg'>
        <button className={kind === 'subsonic' ? 'on' : ''} onClick={() => pick('subsonic')}>Subsonic</button>
        <button className={kind === 'jellyfin' ? 'on' : ''} onClick={() => pick('jellyfin')}>Jellyfin / Emby</button>
        <button className={kind === 'folder' ? 'on' : ''} onClick={() => pick('folder')}>Folder</button>
      </div>

      {kind === 'folder'
        ? <>
            <label>Folder <span className='meta'>— a path inside the PearTune container</span></label>
            <div className='pick'>
              <input value={c.root || ''} placeholder='/music' onChange={e => set('root', e.target.value)} />
              <button onClick={() => openBrowse()}>Browse…</button>
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
              <label>API key <span className='meta'>— optional; for servers that use one</span></label>
              <input type='password' placeholder={c.hasApiKey ? 'unchanged' : 'leave blank to use username + password'} onChange={e => set('apiKey', e.target.value)} />
            </>}
          </>}

      <div className='row wrap' style={{ marginTop: '.9rem' }}>
        <button onClick={test}>Test</button>
        <button className='primary' onClick={save}>Save</button>
        <button onClick={rescan}>Rescan</button>
        {dirty && <button className='ghost' onClick={cancel}>Cancel</button>}
        {msg && <span className={'meta ' + (msg.ok === true ? 'ok' : msg.ok === false ? 'bad' : '')}>{msg.text}</span>}
      </div>

      {dirty && <p className='hint warn'>Changing the source changes every track's identity, so play counts and resume positions from the old source will not follow. Nothing is deleted.</p>}
    </div>
  )
}

// Built from real DOM/JSX, never string HTML: these names come off a filesystem
// onto the page with the revoke buttons. (The old page built this with
// createElement for the same reason; here JSX escapes for free.)
function FolderBrowser ({ browse, onOpen, onUse }) {
  if (browse.loading) return <div className='browse'><div className='empty' style={{ padding: '.5rem .6rem' }}>looking…</div></div>
  if (browse.error) return <div className='browse'><div className='empty' style={{ padding: '.5rem .6rem' }}>{browse.error}</div></div>
  return (
    <div className='browse'>
      <div className='head'>
        <code>{browse.path}{browse.here ? ` · ${browse.here} audio files here` : ''}</code>
        <button className='primary sm' onClick={() => onUse(browse.path)}>Use this folder</button>
      </div>
      <ul>
        {browse.parent &&
          <li><button onClick={() => onOpen(browse.parent)}>../</button></li>}
        {(browse.dirs || []).map(d =>
          <li key={d.path}><button onClick={() => onOpen(d.path)}>
            <span>{d.name}/</span>{d.music && <span className='has'>music</span>}
          </button></li>)}
        {!(browse.dirs || []).length && !browse.here &&
          <li><div className='empty' style={{ padding: '.5rem .6rem' }}>nothing in here</div></li>}
      </ul>
    </div>
  )
}

// --- access (people-first) ---------------------------------------------------

function AccessPanel ({ state, refresh, toast }) {
  const [open, setOpen] = useState({}) // personId -> expanded
  const [showRevoked, setShowRevoked] = useState(false)
  const [pname, setPname] = useState('')

  const persons = (state.persons || []).filter(p => !p.revokedAt)
  const devices = state.devices || []
  const byPerson = (id) => devices.filter(d => d.personId === id)
  const unassigned = devices.filter(d => !d.personId && !d.revokedAt)
  const revokedLoose = devices.filter(d => !d.personId && d.revokedAt)

  const mutate = async (path, body, ok) => {
    const r = await api(path, body)
    if (r.error) return toast('Failed: ' + r.error, true)
    if (ok) toast(ok(r))
    refresh()
  }

  const addPerson = async () => {
    const name = pname.trim()
    if (!name) return
    setPname('')
    mutate('/api/person', { name }, () => `Added ${name}.`)
  }

  const revokePerson = (p) => {
    if (!confirm(`Revoke ALL of ${p.name}'s devices?\n\nThey lose access immediately, even mid-song. Nobody else is affected. Their play counts stay in your history.`)) return
    mutate('/api/person/revoke', { personId: p.id }, r => `Revoked ${p.name}: ${r.devices} device(s), ${r.killed} live connection(s) cut off.`)
  }
  const deletePerson = (p) => {
    if (!confirm(`Delete ${p.name} from the list?\n\nThey have no devices, so this only tidies the list. Nothing is revoked.`)) return
    mutate('/api/person/delete', { personId: p.id }, () => `Deleted ${p.name} from the list.`)
  }
  const revoke = (d) => {
    if (!confirm(`Revoke "${d.label}"?\n\nIt loses access immediately, even mid-song. Its play counts stay in your history.`)) return
    mutate('/api/revoke', { deviceKey: d.deviceKey }, r => r.killed > 0
      ? `Revoked ${d.label} and cut off ${r.killed} live connection${r.killed === 1 ? '' : 's'}.`
      : `Revoked ${d.label}. It was not connected.`)
  }
  const deleteDevice = (d) => {
    if (!confirm(`Delete "${d.label}" from the list?\n\nAccess is already revoked and stays revoked. This only removes the record; the device would have to pair again to return.`)) return
    mutate('/api/device/delete', { deviceKey: d.deviceKey }, () => `Deleted ${d.label} from the list.`)
  }
  const confirmClaim = (d) => {
    if (!confirm(`Confirm that "${d.label}" belongs to ${d.claimedUser}?\n\nThey will be created if they are new, and you can then revoke all of their devices in one click.`)) return
    mutate('/api/person/confirm', { deviceKey: d.deviceKey }, r => `${d.label} now belongs to ${r.person.name}.`)
  }
  const assign = (d, personId) => mutate('/api/assign', { deviceKey: d.deviceKey, personId: personId || null })

  const revokedCount = devices.filter(d => d.revokedAt).length

  return (
    <div className='panel'>
      <h2><UsersThree size={14} weight='bold' /> People &amp; devices</h2>

      {!persons.length && !unassigned.length && !(showRevoked && revokedCount)
        ? <p className='empty'>No devices paired yet. Show a pairing code to add one.</p>
        : <div className='access-list'>
            {persons.map(p => {
              const theirs = byPerson(p).filter(d => !d.revokedAt || showRevoked)
              const live = byPerson(p).filter(d => !d.revokedAt)
              const online = live.filter(d => d.online).length
              const isOpen = open[p.id]
              return (
                <div className='person' key={p.id}>
                  <div className='prow' onClick={() => setOpen(o => ({ ...o, [p.id]: !o[p.id] }))}>
                    <CaretRight size={14} weight='bold' className={'caret' + (isOpen ? ' open' : '')} />
                    <div className='who'>
                      <div className='name'>{p.name}</div>
                      <span className='meta'>
                        {live.length} device{live.length === 1 ? '' : 's'}
                        {online ? <> · <span className='dot' />{online} online</> : null}
                      </span>
                    </div>
                    {live.length
                      ? <button className='danger sm' onClick={e => { e.stopPropagation(); revokePerson(p) }}>Revoke all</button>
                      : <button className='danger sm' onClick={e => { e.stopPropagation(); deletePerson(p) }}>Delete</button>}
                  </div>
                  {isOpen &&
                    <div className='devices-sub'>
                      {theirs.map(d => <DeviceRow key={d.deviceKey} d={d} persons={persons} onRevoke={revoke} onDelete={deleteDevice} onConfirm={confirmClaim} />)}
                    </div>}
                </div>
              )
            })}
          </div>}

      {(unassigned.length || (showRevoked && revokedLoose.length)) ?
        <>
          <div className='group-h'>Unassigned</div>
          <div className='access-list' style={{ maxHeight: '14rem' }}>
            {unassigned.map(d =>
              <DeviceRow key={d.deviceKey} d={d} persons={persons} onAssign={assign} onRevoke={revoke} onDelete={deleteDevice} onConfirm={confirmClaim} />)}
            {showRevoked && revokedLoose.map(d =>
              <DeviceRow key={d.deviceKey} d={d} onRevoke={revoke} onDelete={deleteDevice} onConfirm={confirmClaim} />)}
          </div>
        </> : null}

      <div className='addrow'>
        <input value={pname} placeholder='Name (e.g. Ben)' onChange={e => setPname(e.target.value)} onKeyDown={e => e.key === 'Enter' && addPerson()} />
        <button onClick={addPerson}><Plus size={15} weight='bold' /></button>
      </div>

      {revokedCount ?
        <p className='meta footer-toggle'>{revokedCount} revoked · <button className='link' onClick={() => setShowRevoked(v => !v)}>{showRevoked ? 'hide' : 'show'}</button></p>
        : null}
    </div>
  )
}

function DeviceRow ({ d, persons, onAssign, onRevoke, onDelete, onConfirm }) {
  // Show a claim to confirm whenever the device's self-declared user does not match
  // the person it is assigned to - not only when unassigned. A confirmed person who
  // renames is making a new claim; hiding it would leave a stale name on screen.
  const holder = persons && persons.find(p => p.id === d.personId)
  const matches = holder && d.claimedUser && holder.name.toLowerCase() === d.claimedUser.toLowerCase()
  const showClaim = !d.revokedAt && d.claimedUser && !matches
  return (
    <div>
      <div className='drow'>
        <div className='who'>
          <div className='name'>{d.label}</div>
          {d.revokedAt
            ? <span className='revoked'>revoked {ago(d.revokedAt)}</span>
            : <span className='meta'><span className={'dot' + (d.online ? '' : ' off')} />{d.online ? 'connected' : 'last seen ' + ago(d.lastSeenAt)}</span>}
        </div>
        {onAssign && !d.revokedAt &&
          <select className='assign' value={d.personId || ''} onChange={e => onAssign(d, e.target.value)}>
            <option value=''>— unassigned —</option>
            {(persons || []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>}
        {d.revokedAt
          ? <button className='danger sm' onClick={() => onDelete(d)}>Delete</button>
          : <button className='danger sm' onClick={() => onRevoke(d)}>Revoke</button>}
      </div>
      {showClaim &&
        <div className='claim'>
          {holder ? 'now claims to be ' : 'claims to be '}<b>{d.claimedUser}</b>
          <button className='sm' onClick={() => onConfirm(d)}>Confirm</button>
        </div>}
    </div>
  )
}

// --- support development -----------------------------------------------------

// The seeder's donation panel, ported: two no-account rails (Bitcoin, USD/card),
// a QR for whichever is showing (the dashboard is often open on a laptop while you
// pay from a phone), rendered entirely client-side. Same addresses as the phone
// app's About tab.
function DonationSheet ({ onClose }) {
  const [tab, setTab] = useState('btc') // 'btc' | 'usd'
  const [qr, setQr] = useState(null)
  const [copied, setCopied] = useState(null)

  const payload = tab === 'btc' ? DONATE.lightning : DONATE.bmcUrl

  useEffect(() => {
    let cancelled = false
    setQr(null)
    QRCode.toDataURL(payload, { width: 200, margin: 1, errorCorrectionLevel: 'M' })
      .then(url => { if (!cancelled) setQr(url) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [payload])

  const copy = async (what, value) => {
    if (await copyText(value)) { setCopied(what); setTimeout(() => setCopied(null), 1500) }
  }

  return (
    <div className='sheetwrap' onClick={onClose}>
      <div className='sheet' onClick={e => e.stopPropagation()}>
        <h1>Support development</h1>
        <p className='meta'>PearTune is free and open source. No accounts, no servers, no subscriptions — if it brings you value, a tip helps keep it free. Entirely optional.</p>

        <div className='seg' style={{ marginTop: '1rem' }}>
          <button className={tab === 'btc' ? 'on' : ''} onClick={() => setTab('btc')}>⚡ BTC ⚡</button>
          <button className={tab === 'usd' ? 'on' : ''} onClick={() => setTab('usd')}>💲 USD 💲</button>
        </div>

        {qr
          ? <img className='qr' src={qr} alt={tab === 'btc' ? 'Lightning donation QR' : 'Buy Me a Coffee QR'} />
          : <div className='empty'>generating…</div>}

        {tab === 'btc'
          ? <>
              <h2>Lightning address</h2>
              <div className='key'>{DONATE.lightning}</div>
              <div className='btnrow'>
                <button className='sm' onClick={() => copy('ln', DONATE.lightning)}>{copied === 'ln' ? 'Copied' : <><Copy size={14} /> Copy</>}</button>
                <button className='sm' onClick={() => window.open(DONATE.strikeUrl, '_blank', 'noopener,noreferrer')}><ArrowSquareOut size={14} /> Pay in a browser</button>
              </div>
              <h2><CurrencyBtc size={13} weight='bold' style={{ verticalAlign: '-2px' }} /> On-chain Bitcoin</h2>
              <div className='key'>{DONATE.onchain}</div>
              <div className='btnrow'>
                <button className='sm' onClick={() => copy('btc', DONATE.onchain)}>{copied === 'btc' ? 'Copied' : <><Copy size={14} /> Copy</>}</button>
              </div>
            </>
          : <>
              <p className='hint' style={{ textAlign: 'center' }}>Scan to open Buy Me a Coffee on your phone, or open it here to donate by card.</p>
              <div className='key'>{DONATE.bmcUrl}</div>
              <div className='btnrow'>
                <button className='sm' onClick={() => copy('bmc', DONATE.bmcUrl)}>{copied === 'bmc' ? 'Copied' : <><Copy size={14} /> Copy</>}</button>
                <button className='sm primary' onClick={() => window.open(DONATE.bmcUrl, '_blank', 'noopener,noreferrer')}><ArrowSquareOut size={14} /> Open</button>
              </div>
            </>}

        <button className='wide' style={{ marginTop: '1.2rem' }} onClick={onClose}><X size={15} /> Close</button>
      </div>
    </div>
  )
}

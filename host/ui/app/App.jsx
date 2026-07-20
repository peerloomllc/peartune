import { useState, useEffect, useRef, useCallback } from 'react'
import {
  MusicNotes, UsersThree, Broadcast, Heart, Sun, Moon, GearSix, SignOut,
  CaretRight, Plus, X, Copy, ArrowSquareOut, CurrencyBtc, CurrencyDollar,
  Lightning, CheckCircle, Folder, CaretLeft, Wrench
} from '@phosphor-icons/react'
import QRCode from 'qrcode'
import { api, copyText, ago, until, fmtDur, platformLabel, DONATE } from './api'
import { loadThemePref, applyThemePref, resolveTheme } from './theme'
import { PEAR_MARK } from './icon'

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
// An informational popup (single button), themed like the confirm dialog. Used
// for the outcome of Test / Save / Rescan instead of a line of loose green text.
function notify (title, message) {
  return askConfirm({ title, message, confirmLabel: 'Done', info: true })
}

// Capitalise the first letter of each word for display, leaving the rest as-is so
// an already-cased or all-caps name is not mangled. The music source reports its
// own name (often lower-case, e.g. "navidrome", "nextcloud music").
const titleCase = s => String(s || '').replace(/\b\w/g, c => c.toUpperCase())

// A height+fade collapse, always mounted so it animates BOTH ways (open and close).
function Collapse ({ open, children }) {
  return <div className={'collapse' + (open ? ' open' : '')}>{children}</div>
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
        <div className={'confirm-actions' + (c.info ? ' center' : '')}>
          {!c.info && <button className='ghost' onClick={() => close(false)}>{c.cancelLabel || 'Cancel'}</button>}
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
  const [tab, setTab] = useState('people') // 'people' | 'source'
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
  const online = liveDevices.filter(d => d.online).length

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

        <div className='tabbar' role='tablist' aria-label='Dashboard sections'>
          <button role='tab' id='tab-people' aria-controls='pane-people' aria-selected={tab === 'people'}
            className={tab === 'people' ? 'on' : ''} onClick={() => setTab('people')}>
            People &amp; Devices
          </button>
          <button role='tab' id='tab-source' aria-controls='pane-source' aria-selected={tab === 'source'}
            className={(tab === 'source' ? 'on' : '') + (state.sourceError ? ' warn' : '')} onClick={() => setTab('source')}>
            Music Source
          </button>
        </div>

        {/* Both panels stay mounted (hidden, not unmounted) so in-flight edits -
            a renamed person, a half-filled source form - survive a tab switch. */}
        <div className='tabpanes'>
          <div className='tabpane' id='pane-people' role='tabpanel' aria-labelledby='tab-people' hidden={tab !== 'people'}>
            <AccessPanel state={state} refresh={refresh} toast={toast} online={online} />
          </div>
          <div className='tabpane' id='pane-source' role='tabpanel' aria-labelledby='tab-source' hidden={tab !== 'source'}>
            <SourcePanel state={state} refresh={refresh} toast={toast} />
          </div>
        </div>
      </div>

      <div className='actionbar'>
        <Identity hostKey={state.hostKey} />
        <div className='spacer' />
        <button onClick={() => setModal('pair')}><Broadcast size={16} weight='bold' /> Pair a device</button>
      </div>

      {modal === 'pair' && <PairModal onClose={() => setModal(null)} toast={toast} />}
      {modal === 'support' && <SupportModal onClose={() => setModal(null)} />}
      {modal === 'maintenance' && <MaintenanceModal state={state} onClose={() => setModal(null)} onSaved={refresh} toast={toast} />}
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
        <img className='brand-mark' src={PEAR_MARK} alt='' aria-hidden='true' />
        <div>
          <div className='brand-name'>Pear<span>Tune</span></div>
          <div className='brand-sub'>{state.libraryName || 'Your music, anywhere'}</div>
        </div>
      </div>
      <span className='pill' title={sourceOk ? 'Music source' : state.sourceError}>
        <span className={'dot ' + (sourceOk ? 'good' : 'bad')} />
        {st.source ? titleCase(st.source) : 'No source'}
      </span>
      <div className='topbar-right'>
        <button className='iconbtn' onClick={onTheme} aria-label='Toggle theme' title={isDark ? 'Switch to light' : 'Switch to dark'}>
          {isDark ? <Sun size={17} /> : <Moon size={17} />}
        </button>
        <div className='menuwrap' ref={ref}>
          <button className='iconbtn' onClick={() => setMenu(v => !v)} aria-label='Menu' aria-expanded={menu}><GearSix size={17} /></button>
          {menu &&
            <div className='menu' role='menu'>
              <button onClick={() => { setMenu(false); onOpen('maintenance') }}><Wrench size={16} /> Maintenance</button>
              <button onClick={() => { setMenu(false); onOpen('support') }}><Heart size={16} /> Support Development</button>
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
      <span className='subtle'>Host</span>
      <span className='mono'>{short}</span>
      <button className='iconbtn' style={{ width: 28, height: 28 }} onClick={copy} aria-label='Copy host key'>
        {copied ? <CheckCircle size={15} weight='fill' color='var(--good)' /> : <Copy size={14} />}
      </button>
    </div>
  )
}

// A device's avatar (the photo its user set on the phone, via /api/device/avatar),
// else a monogram on a colour derived from a name. Display-only - the DEVICE sets the
// photo, not the operator. `keyId` is the deviceKey; `name` seeds the fallback + colour.
function Avatar ({ keyId, hasAvatar, name, online }) {
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?'
  const hue = [...(name || '')].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7)
  return (
    <span className={'avatar' + (online ? '' : ' idle')} style={{ '--hue': hue }}>
      {hasAvatar && keyId
        ? <img className='avatar-img' src={'/api/device/avatar?id=' + encodeURIComponent(keyId)} alt='' />
        : <span className='avatar-mono' aria-hidden='true'>{initial}</span>}
      {online && <span className='avatar-live' aria-hidden='true' />}
    </span>
  )
}

/* ---- people-first access -------------------------------------------------- */
function AccessPanel ({ state, refresh, toast, online }) {
  const [open, setOpen] = useState({})
  const [showRevoked, setShowRevoked] = useState(false)
  const [pname, setPname] = useState('')
  const [renaming, setRenaming] = useState(null) // { id, draft } while editing a person's name

  const persons = (state.persons || []).filter(p => !p.revokedAt)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  const devices = state.devices || []
  const byPerson = id => devices.filter(d => d.personId === id)
  // A device is "pending" when it claims an identity that isn't (yet) its confirmed
  // person. Pending devices are surfaced in their own Needs-confirmation card and
  // pulled out of the normal lists, so every device row stays uniform.
  const claimMismatch = d => {
    if (d.revokedAt || !d.claimedUser) return false
    const holder = persons.find(p => p.id === d.personId)
    return !holder || holder.name.toLowerCase() !== d.claimedUser.toLowerCase()
  }
  const pending = devices.filter(claimMismatch)
  const unassigned = devices.filter(d => !d.personId && !d.revokedAt && !claimMismatch(d))
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
  // Rename in place: the person's name becomes an input with save/cancel. A no-op
  // (blank or unchanged) just closes the editor; the host refuses a name that collides
  // with another person and mutate surfaces that as a toast.
  const startRename = p => setRenaming({ id: p.id, draft: p.name })
  const saveRename = () => {
    const r = renaming; if (!r) return
    const name = r.draft.trim()
    const p = persons.find(x => x.id === r.id)
    setRenaming(null)
    if (!name || (p && name === p.name)) return
    mutate('/api/person/rename', { personId: r.id, name }, res => `Renamed to ${res.person.name}.`)
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
  // Confirm is direct: the Needs-confirmation card already shows the claim in full,
  // so a second dialog would be redundant. (Revoke still double-checks - it's destructive.)
  const confirmClaim = d => mutate('/api/person/confirm', { deviceKey: d.deviceKey }, r => `${d.label} now belongs to ${r.person.name}.`)
  const assign = (d, personId) => mutate('/api/assign', { deviceKey: d.deviceKey, personId: personId || null })
  // Edit a guest's expiry: a duration re-limits (from now), 'permanent' clears it. This is
  // how you promote a guest to permanent, or extend a pass without making them re-scan.
  const changeExpiry = (d, v) => v === 'permanent'
    ? mutate('/api/device/expiry', { deviceKey: d.deviceKey, expiresAt: null }, () => `${d.label} now has permanent access.`)
    : mutate('/api/device/expiry', { deviceKey: d.deviceKey, expiresMs: Number(v) }, () => `${d.label} now expires in ${fmtDur(Number(v))}.`)

  const empty = !persons.length && !unassigned.length && !pending.length && !(showRevoked && revokedCount)

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
              {pending.length > 0 &&
                <>
                  <div className='pend-hdr'>⚑ Needs confirmation</div>
                  {pending.map(d => <PendingCard key={d.deviceKey} d={d} onConfirm={confirmClaim} onRevoke={revoke} />)}
                </>}
              {persons.map(p => {
                const live = byPerson(p.id).filter(d => !d.revokedAt && !claimMismatch(d))
                const revoked = byPerson(p.id).filter(d => d.revokedAt)
                const on = live.filter(d => d.online).length
                const expandable = live.length + revoked.length > 0
                const isOpen = expandable && open[p.id]
                const editing = renaming?.id === p.id
                // At most one of a person's devices is the active player (host model).
                // Surface it on the collapsed row so you can see who's listening without
                // expanding; the device rows carry it once open.
                const playing = live.map(d => d.nowPlaying).find(Boolean)
                // The person's "face" is their connected device with a photo, else the
                // most-recently-seen one that has a photo; the monogram (person name)
                // otherwise. Their avatar stands in for the person on this row.
                const face = live.find(d => d.online && d.hasAvatar) ||
                  [...live].filter(d => d.hasAvatar).sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0))[0] || null
                return (
                  <div className='person' key={p.id}>
                    <div className={'prow' + (expandable ? '' : ' flat')} onClick={() => !editing && expandable && setOpen(o => ({ ...o, [p.id]: !o[p.id] }))}>
                      <CaretRight size={14} weight='bold' className={'caret' + (isOpen ? ' open' : '') + (expandable ? '' : ' hidden')} />
                      <Avatar keyId={face?.deviceKey} hasAvatar={!!face} name={p.name} online={on > 0} />
                      {editing
                        ? <>
                            <input
                              className='rename-input' value={renaming.draft} autoFocus aria-label='Person name'
                              onClick={e => e.stopPropagation()}
                              onChange={e => setRenaming(r => ({ ...r, draft: e.target.value }))}
                              onKeyDown={e => {
                                if (e.key === 'Enter') { e.preventDefault(); saveRename() }
                                if (e.key === 'Escape') setRenaming(null)
                              }} />
                            <button className='ghost small' onClick={e => { e.stopPropagation(); saveRename() }}>Save</button>
                            <button className='ghost small' onClick={e => { e.stopPropagation(); setRenaming(null) }}>Cancel</button>
                          </>
                        : <>
                            <div className='who'>
                              <div className='name'>{p.name}</div>
                              <div className='sub'>{live.length} device{live.length === 1 ? '' : 's'}{on ? ` · ${on} online` : ''}{p.createdAt ? ` · added ${ago(p.createdAt)}` : ''}</div>
                              {!isOpen && playing && <NowPlaying np={playing} />}
                            </div>
                            <button className='ghost small' onClick={e => { e.stopPropagation(); startRename(p) }}>Rename</button>
                            {live.length
                              ? <button className='ghost small danger' onClick={e => { e.stopPropagation(); revokePerson(p) }}>Revoke all</button>
                              : <button className='ghost small danger' onClick={e => { e.stopPropagation(); deletePerson(p) }}>Delete</button>}
                          </>}
                    </div>
                    <div className={'devices-sub' + (isOpen ? ' open' : '')}>
                      {live.map(d => <DeviceRow key={d.deviceKey} d={d} onRevoke={revoke} onDelete={deleteDevice} onExpiry={changeExpiry} />)}
                      {revoked.length > 0 &&
                        <Collapse open={showRevoked}>
                          <div className='revoked-stack'>
                            {revoked.map(d => <DeviceRow key={d.deviceKey} d={d} onRevoke={revoke} onDelete={deleteDevice} />)}
                          </div>
                        </Collapse>}
                    </div>
                  </div>
                )
              })}
              {(unassigned.length || revokedLoose.length) ?
                <>
                  <div className='group-h'>Unassigned</div>
                  {unassigned.map(d => <DeviceRow key={d.deviceKey} d={d} persons={persons} onAssign={assign} onRevoke={revoke} onDelete={deleteDevice} onExpiry={changeExpiry} loose />)}
                  {revokedLoose.length > 0 &&
                    <Collapse open={showRevoked}>
                      <div className='revoked-stack'>
                        {revokedLoose.map(d => <DeviceRow key={d.deviceKey} d={d} onRevoke={revoke} onDelete={deleteDevice} loose />)}
                      </div>
                    </Collapse>}
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

// Every device row is exactly two lines (name + status) - no claim chip. A device
// with an unconfirmed claim is handled by PendingCard instead (see AccessPanel).
// What a device is playing right now: a small album thumbnail (off /api/art) + the
// track, tinted primary while playing and tagged when paused. Renders nothing when
// the device is idle (np is null - only the session's active device carries one).
function NowPlaying ({ np }) {
  if (!np) return null
  const label = [np.title || 'Unknown track', np.artist].filter(Boolean).join(' — ')
  return (
    <div className={'nowplaying' + (np.playing ? ' on' : '')}>
      {np.coverId
        ? <img className='np-art' src={'/api/art?id=' + encodeURIComponent(np.coverId)} alt='' aria-hidden='true' />
        : <span className='np-art blank' aria-hidden='true'><MusicNotes size={11} weight='fill' /></span>}
      <span className='np-track' title={label}>{label}</span>
      {!np.playing && <span className='np-paused'>paused</span>}
    </div>
  )
}

function DeviceRow ({ d, persons, onAssign, onRevoke, onDelete, onExpiry, loose }) {
  const guest = !!d.expiresAt && !d.revokedAt
  const expired = guest && Date.now() > d.expiresAt
  return (
    <div className='dev'>
      <div className='drow'>
        <Avatar keyId={d.deviceKey} hasAvatar={d.hasAvatar && !d.revokedAt} name={d.label} online={d.online && !d.revokedAt} />
        <div className='who'>
          <div className='name'>
            {d.label}
            {platformLabel(d.platform) && <span className='badge plat'>{platformLabel(d.platform)}</span>}
            {d.revokedAt && <span className='badge'>revoked</span>}
            {guest && <span className={'badge' + (expired ? '' : ' guest')}>{expired ? 'expired' : 'guest'}</span>}
          </div>
          <div className={'sub' + ((d.revokedAt || expired) ? ' rev' : '')}>
            <span>{d.revokedAt ? `Revoked ${ago(d.revokedAt)}` : (d.online ? 'Connected' : 'Last seen ' + ago(d.lastSeenAt))}</span>
            {!d.revokedAt && d.grantedAt && <span>{`· paired ${ago(d.grantedAt)}`}</span>}
            {guest && <span>{expired ? ' · pass expired' : ` · expires in ${until(d.expiresAt)}`}</span>}
          </div>
          <NowPlaying np={d.nowPlaying} />
        </div>
        {onAssign && !d.revokedAt &&
          <select className='assign' value={d.personId || ''} onChange={e => onAssign(d, e.target.value)}>
            <option value=''>— Unassigned —</option>
            {(persons || []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>}
        {/* Guest-pass controls: re-limit (from now) or promote to permanent. A permanent
            device shows nothing here - limit new guests via the guest pairing window. */}
        {guest && onExpiry &&
          <select className='assign' value='' onChange={e => { if (e.target.value) onExpiry(d, e.target.value) }}>
            <option value='' disabled>{expired ? 'Renew…' : 'Change…'}</option>
            <option value={String(DAY_MS)}>Expire in 24 hours</option>
            <option value={String(7 * DAY_MS)}>Expire in 7 days</option>
            <option value={String(30 * DAY_MS)}>Expire in 30 days</option>
            <option value='permanent'>Make permanent</option>
          </select>}
        {d.revokedAt
          ? <button className='ghost small danger' onClick={() => onDelete(d)}>Delete</button>
          : <button className='ghost small danger' onClick={() => onRevoke(d)}>Revoke</button>}
      </div>
    </div>
  )
}

// A device claiming an identity, given room to be read and acted on. Confirm and
// Revoke are equal-width; Confirm is direct, Revoke double-checks.
function PendingCard ({ d, onConfirm, onRevoke }) {
  return (
    <div className='pending'>
      <div className='pend-top'>
        <span className='nm'>{d.label}</span>
        <span className='pend-st'><span className={'live' + (d.online ? '' : ' off')} aria-hidden='true' />{d.online ? 'Connected' : 'Last seen ' + ago(d.lastSeenAt)}</span>
      </div>
      <div className='pend-claim'>Claims to be <b>{d.claimedUser}</b></div>
      <div className='pend-acts'>
        <button onClick={() => onConfirm(d)}>Confirm</button>
        <button className='ghost danger' onClick={() => onRevoke(d)}>Revoke</button>
      </div>
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
  const [busy, setBusy] = useState(null) // 'test' | 'save' | 'rescan' | null
  const [browse, setBrowse] = useState(null)
  const [newRoot, setNewRoot] = useState('') // the "add a folder" input
  const [detected, setDetected] = useState(null) // null=not scanned, []=none, [...]=found
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty

  // Look for a Jellyfin/Nextcloud/Subsonic server co-located on this box, once, so
  // the operator can pre-fill its internal address instead of having to know it
  // (jellyfin.embassy:8096 and friends). Best-effort: a failure just shows nothing.
  useEffect(() => {
    let live = true
    api('/api/source/detect').then(r => { if (live) setDetected((r && r.sources) || []) })
    return () => { live = false }
  }, [])

  // Pre-fill a detected server: switch to its tab and drop in its URL. Sets cfg for
  // the target kind directly (not via `set`, which closes over the old `kind`).
  const useDetected = (d) => {
    setKind(d.kind); setDirty(true); setBrowse(null)
    setCfg(c => ({ ...c, [d.kind]: { ...(c[d.kind] || {}), url: d.url } }))
  }

  useEffect(() => {
    if (dirtyRef.current) return
    const kinds = (state.source && state.source.kinds) || {}
    setKind((state.source && state.source.active) || 'folder')
    const roots = (kinds.folder && kinds.folder.roots && kinds.folder.roots.length) ? kinds.folder.roots : ['/music']
    setCfg({
      subsonic: { url: '', username: '', ...(kinds.subsonic || {}) },
      jellyfin: { url: '', username: '', ...(kinds.jellyfin || {}) },
      folder: { roots }
    })
  }, [state.source])

  const touch = () => setDirty(true)
  const set = (k, v) => { setCfg(c => ({ ...c, [kind]: { ...c[kind], [k]: v } })); touch() }
  const pick = k => { setKind(k); touch(); setBrowse(null) }
  const cancel = () => { setDirty(false); setBrowse(null); refresh() }
  const tracks = n => `${(n || 0).toLocaleString()} track${n === 1 ? '' : 's'}`
  // tracks, plus albums/artists when the source reports them (folder always; Subsonic
  // and Jellyfin/Emby after this change; a subset server may still omit albums).
  const summary = r => {
    const parts = [tracks(r.tracks)]
    if (r.albums) parts.push(`${r.albums.toLocaleString()} album${r.albums === 1 ? '' : 's'}`)
    if (r.artists) parts.push(`${r.artists.toLocaleString()} artist${r.artists === 1 ? '' : 's'}`)
    return parts.join(' · ')
  }

  // A folder source is a LIST of directories now. Add/remove operate on that list;
  // duplicates are ignored so tapping "Choose this folder" on one you already have
  // is a no-op rather than a double entry.
  const roots = () => (cfg.folder && cfg.folder.roots) || []
  const addRoot = (p) => {
    const clean = String(p || '').trim()
    if (!clean) return
    const existing = roots()
    if (existing.includes(clean)) return // exact duplicate: silently ignored
    // Overlapping folders are either redundant (a subfolder of one you already have)
    // or would supersede others (a parent of ones you have - which the scan drops,
    // and if that drops your PRIMARY folder every track id re-keys). Block both with
    // a reason rather than silently doing something surprising. Container paths are posix.
    const norm = s => s.replace(/\/+$/, '')
    const inside = (a, b) => norm(a) === norm(b) || norm(a).startsWith(norm(b) + '/')
    const parent = existing.find(r => inside(clean, r))
    if (parent) {
      notify('Already covered', <>That folder is inside <span className='hl'>{parent}</span>, which you already have — its music is already included.</>)
      return
    }
    const children = existing.filter(r => inside(r, clean))
    if (children.length) {
      const hitsPrimary = children.includes(existing[0])
      notify('Folders overlap', <>
        <span className='hl'>{clean}</span> contains {children.length === 1 ? 'a folder' : 'folders'} you already have ({children.join(', ')}). Remove {children.length === 1 ? 'it' : 'them'} first if you want to use the parent instead.
        {hitsPrimary ? <> That would also re-key your library, since it replaces your primary folder.</> : null}
      </>)
      return
    }
    setCfg(c => ({ ...c, folder: { roots: [...existing, clean] } })); touch()
  }
  const removeRoot = (p) => {
    setCfg(c => ({ ...c, folder: { roots: roots().filter(r => r !== p) } })); touch()
  }

  const form = () => {
    const c = cfg[kind] || {}
    if (kind === 'folder') return { kind: 'folder', roots: roots().map(r => r.trim()).filter(Boolean) }
    const out = { kind, url: (c.url || '').trim(), username: (c.username || '').trim() }
    if (c.password) out.password = c.password
    if (kind === 'subsonic' && c.apiKey) out.apiKey = c.apiKey
    return out
  }
  const test = async () => {
    setBusy('test')
    const r = await api('/api/source/test', form())
    setBusy(null)
    if (!r.ok) return notify('Connection failed', r.error || 'The music source could not be reached.')
    notify(
      r.tracks ? 'Connection successful' : 'No music found',
      r.tracks
        ? <>PearTune reached the music source and found <span className='hl'>{tracks(r.tracks)}</span>.</>
        : 'The music source is reachable, but no tracks were found there. Check the folder path or the server credentials.'
    )
  }
  const save = async () => {
    setBusy('save')
    const r = await api('/api/source', form())
    if (!r.ok) { setBusy(null); return notify('Could not save the music source', r.error || 'The music source could not be saved.') }
    setDirty(false); setBrowse(null)
    await refresh()
    setBusy(null)
    notify('Music source saved', <>The music source has been updated. <span className='hl'>{summary(r)}</span> are now available to your devices.</>)
  }
  const rescan = async () => {
    setBusy('rescan')
    const r = await api('/api/source/rescan', {})
    await refresh()
    setBusy(null)
    if (!r.ok) return notify('Rescan failed', r.error || 'The library could not be rescanned.')
    notify('Rescan complete', <>The library was rescanned and now contains <span className='hl'>{summary(r)}</span>.</>)
  }
  const setAutoRescan = async (e) => {
    const min = Number(e.target.value)
    const r = await api('/api/rescan-interval', { minutes: min })
    if (r.error || r.ok === false) return toast('Failed: ' + (r.error || 'could not set auto-rescan'), true)
    await refresh()
    const label = { 0: 'off', 15: 'every 15 minutes', 30: 'every 30 minutes', 60: 'every hour', 360: 'every 6 hours' }[min] || `every ${min} minutes`
    toast(min ? `Auto-rescan ${label}.` : 'Auto-rescan off.')
  }
  const openBrowse = async path => {
    const start = path || roots()[roots().length - 1] || '/'
    // Keep the path in the loading state so the modal's header does not flicker
    // or resize while the next listing loads.
    setBrowse(b => ({ loading: true, path: start, dirs: (b && b.dirs) || [], parent: b && b.parent }))
    let r = await api('/api/source/folders?path=' + encodeURIComponent(start))
    if (r.error) r = await api('/api/source/folders?path=/')
    setBrowse(r.error ? { error: r.error, path: start } : r)
  }

  const c = cfg[kind] || {}
  const server = SERVERS[kind]

  return (
    <div className='panel'>
      <div className='panel-head'><h2><MusicNotes size={13} weight='bold' style={{ verticalAlign: '-2px', marginRight: 5 }} />Music source</h2></div>
      <div className='panel-body'>
        <div className='seg'>
          <button className={kind === 'folder' ? 'on' : ''} onClick={() => pick('folder')}>Folder</button>
          <button className={kind === 'subsonic' ? 'on' : ''} onClick={() => pick('subsonic')}>Subsonic</button>
          <button className={kind === 'jellyfin' ? 'on' : ''} onClick={() => pick('jellyfin')}>Jellyfin / Emby</button>
        </div>

        {detected && detected.length > 0 &&
          <div className='srcdetect'>
            <span className='subtle'>Found on this server — tap to use its address:</span>
            <div className='srcdetect-row'>
              {detected.map((d, i) =>
                <button key={i} className='detectchip' onClick={() => useDetected(d)} title={d.url}>
                  {d.server} · {d.name}
                </button>)}
            </div>
          </div>}

        <div className='srcfields'>
          {kind === 'folder'
            ? <>
                <label>Folders <span className='subtle'>— paths inside the PearTune container</span></label>
                <div className='rootlist'>
                  {roots().length
                    ? roots().map((r, i) =>
                        <div className='rootrow' key={r}>
                          <span className='rootpath' title={r}>{r}{i === 0 && roots().length > 1 && <span className='subtle'> · primary</span>}</span>
                          <button className='iconbtn' aria-label={'Remove ' + r} onClick={() => removeRoot(r)}><X size={13} /></button>
                        </div>)
                    : <div className='rootrow'><span className='subtle'>No folders yet — add one below.</span></div>}
                </div>
                <div className='pick'>
                  <input value={newRoot} placeholder='/music' onChange={e => setNewRoot(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && newRoot.trim()) { addRoot(newRoot); setNewRoot('') } }} />
                  <button className='ghost' onClick={() => { if (newRoot.trim()) { addRoot(newRoot); setNewRoot('') } else openBrowse() }}>{newRoot.trim() ? 'Add' : 'Browse…'}</button>
                </div>
              </>
            : <>
                <label>{server.label} URL</label>
                <input value={c.url || ''} placeholder={server.placeholder} onChange={e => set('url', e.target.value)} />
                <label>Username</label>
                <input value={c.username || ''} placeholder='umbrel' onChange={e => set('username', e.target.value)} />
                <label>Password</label>
                <input type='password' placeholder={c.hasPassword ? 'Unchanged' : 'Password'} onChange={e => set('password', e.target.value)} />
                {kind === 'subsonic' && <>
                  <label>API key <span className='subtle'>— optional; for servers that use one</span></label>
                  <input type='password' placeholder={c.hasApiKey ? 'Unchanged' : 'Leave blank to use username and password'} onChange={e => set('apiKey', e.target.value)} />
                </>}
              </>}
        </div>

        <div className='srcactions'>
          <button className='ghost' onClick={test} disabled={!!busy}>{busy === 'test' ? 'Testing…' : 'Test'}</button>
          <button onClick={save} disabled={!!busy}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
          <button className='ghost' onClick={rescan} disabled={!!busy}>{busy === 'rescan' ? 'Rescanning…' : 'Rescan'}</button>
        </div>
        {/* Scheduled auto-rescan: pick it up without a manual Rescan when files land.
            Most useful for a folder library (a server watches its own). */}
        <label className='autoscan'>
          <span>Auto-rescan</span>
          <select value={state.rescanIntervalMin || 0} onChange={setAutoRescan}>
            <option value={0}>Off</option>
            <option value={15}>Every 15 minutes</option>
            <option value={30}>Every 30 minutes</option>
            <option value={60}>Every hour</option>
            <option value={360}>Every 6 hours</option>
          </select>
        </label>
        {/* Always rendered so its appearance/disappearance never resizes the panel. */}
        <div className='srcdiscard'>{dirty && <button className='link' onClick={cancel}>Discard changes</button>}</div>
      </div>
      {browse &&
        <Modal title='Choose a Folder' onClose={() => setBrowse(null)}>
          <FolderBrowser browse={browse} onOpen={openBrowse} onUse={p => { addRoot(p); setBrowse(null) }} />
        </Modal>}
    </div>
  )
}

function FolderBrowser ({ browse, onOpen, onUse }) {
  const path = browse.path || '/'
  const dirs = browse.dirs || []
  return (
    <div className='fb'>
      <div className='fb-head'>
        <span className='fb-path' title={path}>{path}</span>
        {browse.here ? <span className='fb-count'>{browse.here} audio files</span> : null}
      </div>
      <div className='fb-list'>
        {browse.error
          ? <div className='fb-empty'>{browse.error}</div>
          : browse.loading
            ? <div className='fb-empty'>Looking…</div>
            : <ul className='fb-ul' key={path}>
                {browse.parent && <li><button onClick={() => onOpen(browse.parent)}><span className='fb-name'><CaretLeft size={15} className='fb-up' /><span>Up a level</span></span></button></li>}
                {dirs.map(d =>
                  <li key={d.path}><button onClick={() => onOpen(d.path)}>
                    <span className='fb-name'><Folder size={16} weight={d.music ? 'fill' : 'regular'} className='fb-up' /><span>{d.name}</span></span>
                    {d.music && <span className='fb-has'>music</span>}
                  </button></li>)}
                {!dirs.length && !browse.here && <li><div className='fb-empty' style={{ height: 'auto', padding: '16px' }}>Nothing in here</div></li>}
              </ul>}
      </div>
      <button className='block' onClick={() => onUse(path)}>Choose this folder</button>
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

const DAY_MS = 86400000
const GUEST_DURATIONS = [
  { ms: DAY_MS, label: '24 hours' },
  { ms: 7 * DAY_MS, label: '7 days' },
  { ms: 30 * DAY_MS, label: '30 days' }
]

function PairModal ({ onClose, toast }) {
  const [qr, setQr] = useState(null) // { link, dataUrl, guest, expiresMs }
  const [busy, setBusy] = useState(false)
  const [guest, setGuest] = useState(false)
  const [durMs, setDurMs] = useState(DAY_MS)
  const [copied, setCopied] = useState(false)
  const copyLink = async () => { if (await copyText(qr.link)) { setCopied(true); setTimeout(() => setCopied(false), 1500) } }
  const start = async () => {
    setBusy(true)
    // A guest window carries the operator's chosen duration; a full window sends nothing.
    const r = await api('/api/pair/start', guest ? { expiresMs: durMs } : {})
    const dataUrl = await QRCode.toDataURL(r.link, { width: 240, margin: 1, errorCorrectionLevel: 'M' }).catch(() => null)
    setQr({ link: r.link, dataUrl, guest: r.guest, expiresMs: r.expiresMs })
    setBusy(false)
  }
  const stop = async () => { await api('/api/pair/stop', {}); setQr(null); toast('Pairing window closed.') }
  return (
    <Modal title='Pair a Device' onClose={async () => { if (qr) await api('/api/pair/stop', {}); onClose() }}>
      {!qr
        ? <div className='stack center'>
            <div className='seg wide'>
              <button className={guest ? '' : 'on'} onClick={() => setGuest(false)}>Full access</button>
              <button className={guest ? 'on' : ''} onClick={() => setGuest(true)}>Guest pass</button>
            </div>
            {guest
              ? <label className='hint center dur'>Access expires
                  <select value={durMs} onChange={e => setDurMs(Number(e.target.value))}>
                    {GUEST_DURATIONS.map(o => <option key={o.ms} value={o.ms}>{o.label} after pairing</option>)}
                  </select>
                </label>
              : <p className='hint center'>Permanent access. Scan the code in PearTune on your phone.</p>}
            <button onClick={start} disabled={busy}>{busy ? 'Starting…' : 'Show pairing code'}</button>
          </div>
        : <div className='stack center'>
            {qr.dataUrl && <img className='qr' src={qr.dataUrl} alt='Pairing QR code' />}
            <div className='hint center'>
              {qr.guest
                ? `Guest pass — access expires ${fmtDur(qr.expiresMs)} after this device pairs.`
                : 'Valid for 5 minutes. Closes as soon as one device pairs.'}
            </div>
            <div className='keyrow'>
              <div className='key addr'>{qr.link}</div>
            </div>
            <div className='pairacts'>
              <button className='ghost' onClick={stop}>Cancel</button>
              <button onClick={copyLink}>
                {copied ? <><CheckCircle size={15} weight='fill' color='var(--good)' /> Copied</> : <><Copy size={15} /> Copy</>}
              </button>
            </div>
          </div>}
    </Modal>
  )
}

// Operator maintenance. A sectioned modal - Library name is the first section;
// more (guest grants, listening history, danger zone, …) can be added as siblings
// without reshaping this.
function MaintenanceModal ({ state, onClose, onSaved, toast }) {
  return (
    <Modal title='Maintenance' onClose={onClose}>
      <div className='maint'>
        <LibraryNameSection state={state} onSaved={onSaved} toast={toast} />
        <PasswordSection state={state} onSaved={onSaved} toast={toast} />
      </div>
    </Modal>
  )
}

// A readable random password (no 0/o/1/l/i to misread). Fills the New field so the
// operator can set a strong one without inventing it.
function suggestPassword () {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789'
  const r = new Uint8Array(16)
  ;(window.crypto || window.msCrypto).getRandomValues(r)
  let s = ''
  for (let i = 0; i < 16; i++) { s += a[r[i] % a.length]; if (i % 4 === 3 && i < 15) s += '-' }
  return s
}

function PasswordSection ({ state, onSaved, toast }) {
  const src = state.passwordSource
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)

  // Loopback with no gate: nothing to manage.
  if (src === 'none' || src == null) return null

  // Platform-owned (PEARTUNE_PASSWORD): a change here would be lost on restart, so
  // say where to change it instead of offering a control that silently no-ops.
  if (src === 'explicit') {
    return (
      <section className='maint-section'>
        <h4>Dashboard password</h4>
        <p className='hint'>Set by your platform (the <code>PEARTUNE_PASSWORD</code> environment variable). Change it there — a change here would be overwritten on the next restart.</p>
      </section>
    )
  }

  const canSave = next.trim().length >= 6 && !busy
  const change = async () => {
    setBusy(true)
    const r = await api('/api/password', { next: next.trim() })
    setBusy(false)
    if (!r.ok) return toast('Failed: ' + (r.error || 'could not change the password'), true)
    setNext('')
    onSaved()
    toast('Dashboard password changed.')
  }

  return (
    <section className='maint-section'>
      <h4>Dashboard password</h4>
      <p className='hint'>The lock on this dashboard. Anyone with it can revoke devices and open a pairing window. You are signed in, so you don’t need the old one to set a new one.</p>
      <input value={next} maxLength={64} placeholder='New password (min 6)' autoComplete='new-password'
        onChange={e => setNext(e.target.value)} onKeyDown={e => e.key === 'Enter' && canSave && change()} />
      <div className='srcdiscard'><button className='link' onClick={() => setNext(suggestPassword())}>Suggest a strong one</button></div>
      <button className='block' style={{ marginTop: 4 }} onClick={change} disabled={!canSave}>{busy ? 'Changing…' : 'Change password'}</button>
    </section>
  )
}

function LibraryNameSection ({ state, onSaved, toast }) {
  const [name, setName] = useState(state.libraryName || '')
  const [busy, setBusy] = useState(false)
  const dirty = name.trim() !== (state.libraryName || '')
  const save = async () => {
    const clean = name.trim()
    if (!clean) return
    setBusy(true)
    const r = await api('/api/library', { name: clean })
    setBusy(false)
    if (!r.ok) return toast('Failed: ' + (r.error || 'could not rename the library'), true)
    onSaved()
    toast('Library renamed.')
  }
  return (
    <section className='maint-section'>
      <h4>Library name</h4>
      <p className='hint'>Shown on this dashboard, and to a device when it pairs.</p>
      <input value={name} maxLength={64} placeholder='My Library'
        onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && dirty && save()} />
      <button className='block' style={{ marginTop: 10 }} onClick={save} disabled={busy || !name.trim() || !dirty}>{busy ? 'Saving…' : 'Save'}</button>
    </section>
  )
}

// Three no-account rails (Lightning, on-chain BTC, USD/card), one QR each,
// rendered entirely client-side. Same addresses as the phone app.
const RAILS = {
  ln: { value: DONATE.lightning, caption: 'Scan with any Lightning wallet (pick your own amount), or copy the address.' },
  onchain: { value: DONATE.onchain, caption: 'On-chain Bitcoin — higher fees, so Lightning is cheaper for small tips.' },
  usd: { value: DONATE.bmcUrl, caption: 'Scan to open Buy Me a Coffee, or open it here to pay by card.' }
}
function SupportModal ({ onClose }) {
  const [tab, setTab] = useState('ln')
  const [qr, setQr] = useState(null)
  const [copied, setCopied] = useState(false)
  const rail = RAILS[tab]
  useEffect(() => {
    let cancelled = false
    setQr(null); setCopied(false)
    QRCode.toDataURL(rail.value, { width: 220, margin: 1, errorCorrectionLevel: 'M' })
      .then(u => { if (!cancelled) setQr(u) }).catch(() => {})
    return () => { cancelled = true }
  }, [rail.value])
  const copy = async () => { if (await copyText(rail.value)) { setCopied(true); setTimeout(() => setCopied(false), 1500) } }
  return (
    <Modal title='Support Development' onClose={onClose}>
      <div className='stack center'>
        <p className='hint center'>No accounts, no servers, no subscriptions. If PearTune is useful to you, a tip helps keep it free — entirely optional.</p>
        <div className='tabs'>
          <button className={tab === 'ln' ? '' : 'ghost'} onClick={() => setTab('ln')}><Lightning size={15} weight='fill' /> Lightning</button>
          <button className={tab === 'onchain' ? '' : 'ghost'} onClick={() => setTab('onchain')}><CurrencyBtc size={15} weight='bold' /> On-chain</button>
          <button className={tab === 'usd' ? '' : 'ghost'} onClick={() => setTab('usd')}><CurrencyDollar size={15} weight='bold' /> USD</button>
        </div>

        {qr ? <img className='qr' src={qr} alt='Donation QR code' /> : <div className='empty'>Generating…</div>}

        <div className='donate-cap'>{rail.caption}</div>
        <div className='key addr'>{rail.value}</div>
        <div className='donate-actions'>
          <button className='ghost' onClick={copy}>{copied ? <><CheckCircle size={15} weight='fill' /> Copied</> : <><Copy size={15} /> Copy</>}</button>
          {tab === 'usd' && <a className='btn' href={DONATE.bmcUrl} target='_blank' rel='noopener noreferrer'><ArrowSquareOut size={15} /> Open</a>}
        </div>
      </div>
    </Modal>
  )
}

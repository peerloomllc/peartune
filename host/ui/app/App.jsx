import { useState, useEffect, useRef, useCallback } from 'react'
import {
  MusicNotes, Broadcast, Heart, Sun, Moon, GearSix, SignOut,
  CaretRight, Copy, ArrowSquareOut, CurrencyBtc, CurrencyDollar,
  Lightning, CheckCircle, Wrench, Compass, Prohibit, Trash, Check, DeviceMobile
} from '@phosphor-icons/react'
import QRCode from 'qrcode'
import { api, copyText, ago, until, fmtDur, platformLabel, shortKey, DONATE } from './api'
import { loadThemePref, applyThemePref, resolveTheme } from './theme'
import { PEAR_MARK } from './icon'
import { Collapse, ConfirmHost, Modal, askConfirm } from './ui'
import { SourcePanel } from './SourcePanel'
import { PairModal, DAY_MS } from './Pair'
import { MaintenanceModal } from './Maintenance'
import SetupWizard from './Wizard'
import { needsSetup, setupDismissed, dismissSetup, undismissSetup } from './setup'
import { shouldShowUpdate, dismissUpdate, dismissedVersion } from './update'

// The operator control plane, as an app shell adapted from the PearCircle seeder's
// #153 redesign: a fixed top bar, a scrollable middle (stats + the people-first
// access list + the music source), a fixed action bar, and modals. It replaced
// host/ui/page.js, a 700-line hand-written HTML string that had produced a stored
// XSS and two syntax-in-a-string bugs; React escapes by default, so that class of
// bug is gone.

// Capitalise the first letter of each word for display, leaving the rest as-is so
// an already-cased or all-caps name is not mangled. The music source reports its
// own name (often lower-case, e.g. "navidrome", "nextcloud music").
const titleCase = s => String(s || '').replace(/\b\w/g, c => c.toUpperCase())

export default function App () {
  const [state, setState] = useState(null)
  const [note, setNote] = useState(null)
  const [modal, setModal] = useState(null) // 'pair' | 'support' | null
  const [tab, setTab] = useState('people') // 'people' | 'source'
  const [pref, setPref] = useState(loadThemePref())
  // null until the first /api/state answers - a fresh host opens the wizard, and a
  // configured one never sees it. Once set, it is the operator's, not the poll's:
  // finishing or skipping must not be undone by the next refresh.
  const [setup, setSetup] = useState(null)
  // GET /api/update, kept off the 3s /api/state poll on purpose: the host only asks
  // GitHub once an hour, so polling it with the dashboard's hot path would be 1200
  // requests for one answer. null until the first reply, and never fatal.
  const [update, setUpdate] = useState(null)
  // Read once at mount, then held in state so a dismissal hides the banner without a
  // reload. localStorage is the durable copy; this is just what the render reads.
  const [dismissedUpdate, setDismissedUpdate] = useState(dismissedVersion)

  useEffect(() => { applyThemePref(pref) }, [pref])

  const toast = useCallback((msg, bad) => {
    setNote({ msg, bad })
    clearTimeout(toast._t)
    toast._t = setTimeout(() => setNote(null), bad ? 3600 : 2400)
  }, [])

  const refresh = useCallback(async () => {
    const s = await api('/api/state')
    if (s && s.stats) {
      setState(s)
      // Decided once, off the first state we ever see. Re-deciding on every poll
      // would yank the wizard away the moment its own source step saved.
      setSetup(v => v === null ? (needsSetup(s) && !setupDismissed()) : v)
    }
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 3000)
    return () => clearInterval(t)
  }, [refresh])

  useEffect(() => {
    const poll = () => api('/api/update').then(setUpdate).catch(() => {})
    poll()
    // Half the host's own check interval, so a dashboard left open overnight picks up
    // a release without a reload, and a shut one costs nothing.
    const t = setInterval(poll, 30 * 60 * 1000)
    return () => clearInterval(t)
  }, [])

  const cycleTheme = () => setPref(resolveTheme(pref) === 'dark' ? 'light' : 'dark')
  const isDark = resolveTheme(pref) === 'dark'
  const leaveSetup = () => { dismissSetup(); setSetup(false) }
  const openSetup = () => { undismissSetup(); setSetup(true) }

  if (!state) {
    return <div className='app'><div className='main'><div className='empty'>Connecting to the host…</div></div></div>
  }

  if (setup) {
    return (
      <>
        <SetupWizard state={state} refresh={refresh} toast={toast}
          isDark={isDark} onTheme={cycleTheme} onExit={leaveSetup} />
        {note && <div className={'toast' + (note.bad ? ' err' : '')}>{note.msg}</div>}
        <ConfirmHost />
      </>
    )
  }

  const st = state.stats || {}
  const liveDevices = (state.devices || []).filter(d => !d.revokedAt)
  const online = liveDevices.filter(d => d.online).length
  const pendingRequests = (state.requests || []).filter(r => r.status === 'pending').length

  return (
    <div className='app'>
      <TopBar state={state} isDark={isDark} onTheme={cycleTheme} onOpen={setModal} onSetup={openSetup} />

      <div className='main'>
        {shouldShowUpdate(update, dismissedUpdate) &&
          <UpdateBanner info={update} onDismiss={() => { dismissUpdate(update.latest); setDismissedUpdate(update.latest) }} />}

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
          <button role='tab' id='tab-requests' aria-controls='pane-requests' aria-selected={tab === 'requests'}
            className={tab === 'requests' ? 'on' : ''} onClick={() => setTab('requests')}>
            Requests{pendingRequests > 0 && <span className='tabbadge'>{pendingRequests}</span>}
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
          <div className='tabpane' id='pane-requests' role='tabpanel' aria-labelledby='tab-requests' hidden={tab !== 'requests'}>
            <RequestsPanel state={state} refresh={refresh} toast={toast} />
          </div>
        </div>
      </div>

      <div className='actionbar'>
        <Identity hostKey={state.hostKey} />
        <div className='spacer' />
        <button onClick={() => setModal('pair')}><Broadcast size={16} weight='bold' /> Pair a device</button>
      </div>

      {modal === 'pair' && <PairModal onClose={() => setModal(null)} toast={toast} />}
      {modal === 'pair-owner' && <PairModal owner onClose={() => setModal(null)} toast={toast} />}
      {modal === 'support' && <SupportModal onClose={() => setModal(null)} />}
      {modal === 'maintenance' && <MaintenanceModal state={state} onClose={() => setModal(null)} onSaved={refresh} toast={toast} />}
      {note && <div className={'toast' + (note.bad ? ' err' : '')}>{note.msg}</div>}
      <ConfirmHost />
    </div>
  )
}

/* ---- "a new PearTune is out" ---------------------------------------------- */
// Notify only: a version, a link and a way to dismiss it. No "update now" button,
// because applying an update means a privileged installer swap per platform and the
// sibling seeder's own notes say that helper is still unwritten. See update.js.
function UpdateBanner ({ info, onDismiss }) {
  return (
    <div className='banner info'>
      <span>
        <strong>PearTune {info.latest} is out.</strong>{' '}
        {info.htmlUrl
          ? <a href={info.htmlUrl} target='_blank' rel='noreferrer'>See what changed and download it</a>
          : 'Grab it from the PearTune releases page.'}
      </span>
      <button className='bannerx' onClick={onDismiss} title='Hide until the next release'
        aria-label='Hide this update notice'>×</button>
    </div>
  )
}

/* ---- top bar -------------------------------------------------------------- */
function TopBar ({ state, isDark, onTheme, onOpen, onSetup }) {
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
              <button onClick={() => { setMenu(false); onSetup() }}><Compass size={16} /> Setup guide</button>
              <button onClick={() => { setMenu(false); onOpen('pair-owner') }}><DeviceMobile size={16} /> Pair my phone as owner</button>
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
function Avatar ({ keyId, hasAvatar, avatarAt, name, online }) {
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?'
  const hue = [...(name || '')].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7)
  return (
    <span className={'avatar' + (online ? '' : ' idle')} style={{ '--hue': hue }}>
      {hasAvatar && keyId
        ? <img
            className='avatar-img'
            /* `v` is the photo's mtime. Without it the src never changes, so a NEW photo
               keeps rendering as the old one until the page is reloaded - the poll updates
               the JSON, but nothing tells this <img> to re-fetch. */
            src={'/api/device/avatar?id=' + encodeURIComponent(keyId) + (avatarAt ? '&v=' + avatarAt : '')}
            alt='' />
        : <span className='avatar-mono' aria-hidden='true'>{initial}</span>}
      {online && <span className='avatar-live' aria-hidden='true' />}
    </span>
  )
}

/* ---- people-first access -------------------------------------------------- */
function AccessPanel ({ state, refresh, toast, online }) {
  const [open, setOpen] = useState({})
  const [showRevoked, setShowRevoked] = useState(false)
  const [renaming, setRenaming] = useState(null) // { id, draft } while editing a person's name

  const devices = state.devices || []
  const byPerson = id => devices.filter(d => d.personId === id)
  // EMPTY = holds no device that still has access. This is the HOST's own rule
  // (grants.deletePerson refuses while a non-revoked grant points here), so the
  // Delete button is offered exactly when the host would accept it. Note it counts
  // a claim-mismatched device as held, even though that device renders under Needs
  // confirmation rather than on this row.
  const heldBy = id => byPerson(id).filter(d => !d.revokedAt)
  const isEmpty = p => heldBy(p.id).length === 0
  // Emptied people sink below the people who actually hold a phone. They are kept,
  // not auto-deleted: with person carry-over (proposal 2026-07-21) a phone that left
  // by itself comes BACK to this same person and finds its favourites - so deleting
  // eagerly would destroy the thing carry-over exists to preserve. We only make the
  // staleness visible and the tidy-up one click.
  const persons = (state.persons || []).filter(p => !p.revokedAt)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .sort((a, b) => (isEmpty(a) ? 1 : 0) - (isEmpty(b) ? 1 : 0))
  const emptyPersons = persons.filter(isEmpty)
  // When was this person left holding nothing? Their last device's revoke is the
  // moment; a person who never had one (added by hand) falls back to when they were
  // added, and a pre-upgrade row with neither just reads "No devices".
  const emptySince = p => byPerson(p.id).reduce((t, d) => Math.max(t, d.revokedAt || 0), 0) || p.createdAt || 0
  // A device is "pending" when it claims an identity that isn't (yet) its confirmed
  // person. Pending devices are surfaced in their own Needs-confirmation card and
  // pulled out of the normal lists, so every device row stays uniform.
  const claimMismatch = d => {
    if (d.revokedAt || !d.claimedUser) return false
    const holder = persons.find(p => p.id === d.personId)
    return !holder || holder.name.toLowerCase() !== d.claimedUser.toLowerCase()
  }
  const pending = devices.filter(claimMismatch)
  // The LIVE people already holding a claimed name. 0 = confirming just mints, 1 = the operator
  // chooses join-or-new, 2+ = they must also say WHICH one (personByName would otherwise join a
  // coin flip). Drives PendingCard's actions.
  const holdersOf = name => !name
    ? []
    : persons.filter(p => p.name.toLowerCase() === String(name).toLowerCase())
      .map(p => {
        // Name the devices they already hold. Two rows reading "Sam #4f2a" and "Sam #9c11" are
        // unambiguous but meaningless; "Sam - TCL, iPad" is how the operator actually knows which
        // Sam they mean.
        const held = byPerson(p.id).filter(d => !d.revokedAt).map(d => d.label)
        return { ...p, hint: held.length ? held.join(', ') : 'no devices yet' }
      })
  const unassigned = devices.filter(d => !d.personId && !d.revokedAt && !claimMismatch(d))
  const revokedLoose = devices.filter(d => !d.personId && d.revokedAt)
  const revokedCount = devices.filter(d => d.revokedAt).length

  const mutate = async (path, body, ok) => {
    const r = await api(path, body)
    if (r.error) return toast('Failed: ' + r.error, true)
    if (ok) toast(ok(r))
    refresh()
  }
  const revokePerson = async p => {
    if (!await askConfirm({ title: `Revoke all of ${p.name}'s devices?`, message: 'They lose access immediately, even mid-song. Nobody else is affected. Their play counts stay in your history.', confirmLabel: 'Revoke all', danger: true })) return
    mutate('/api/person/revoke', { personId: p.id }, r => `Revoked ${p.name}: ${r.devices} device(s), ${r.killed} live connection(s) cut off.`)
  }
  const deletePerson = async p => {
    if (!await askConfirm({ title: `Delete ${p.name}?`, message: 'They have no devices, so nothing is revoked. Their listening history goes with them: favourites, resume points and play counts. If that phone pairs again it comes back as a new person.', confirmLabel: 'Delete', danger: true })) return
    mutate('/api/person/delete', { personId: p.id }, () => `Deleted ${p.name}.`)
  }
  // Tidy every emptied person in one go. Only offered when there is more than one to
  // clear - a single stale row is a one-click Delete already. Each is deleted through
  // the SAME guarded endpoint, so a person who picked up a device between the render
  // and the click is refused by the host rather than swept up.
  const clearEmpty = async () => {
    const targets = emptyPersons
    if (!await askConfirm({
      title: `Clear ${targets.length} empty people?`,
      message: `${targets.map(p => p.name).join(', ')} hold no devices. Deleting them also deletes their listening history - favourites, resume points and play counts. Nothing is revoked.`,
      confirmLabel: `Delete ${targets.length}`,
      danger: true
    })) return
    let gone = 0
    let failed = 0
    for (const p of targets) {
      const r = await api('/api/person/delete', { personId: p.id })
      if (r.deleted) gone++
      else failed++
    }
    refresh()
    toast(failed
      ? `Deleted ${gone}; ${failed} could not be deleted (a device came back).`
      : `Deleted ${gone} empty ${gone === 1 ? 'person' : 'people'}.`, !!failed)
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
  //
  // `opts` carries the operator's answer when the claimed name is not unambiguous: {asNew} for a
  // genuinely different person of the same name, {personId} to say WHICH same-named person to
  // join. Plain confirm (no opts) keeps the old behaviour - join the one holder, or mint.
  const confirmClaim = (d, opts = {}) =>
    mutate('/api/person/confirm', { deviceKey: d.deviceKey, ...opts }, r => `${d.label} now belongs to ${r.person.label}.`)
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
                  {pending.map(d => <PendingCard key={d.deviceKey} d={d} holders={holdersOf(d.claimedUser)} onConfirm={confirmClaim} onRevoke={revoke} />)}
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
                const gone = isEmpty(p)
                return (
                  <div className={'person' + (gone ? ' gone' : '')} key={p.id}>
                    <div className={'prow' + (expandable ? '' : ' flat')} onClick={() => !editing && expandable && setOpen(o => ({ ...o, [p.id]: !o[p.id] }))}>
                      <CaretRight size={14} weight='bold' className={'caret' + (isOpen ? ' open' : '') + (expandable ? '' : ' hidden')} />
                      <Avatar keyId={face?.deviceKey} hasAvatar={!!face} avatarAt={face?.avatarAt} name={p.name} online={on > 0} />
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
                              {/* The disambiguated label (name + #suffix only when a name is
                                  shared) - the operator must know WHOSE access this revoke
                                  button cuts. Rename still edits the plain name. */}
                              <div className='name'>{p.label || p.name}</div>
                              {/* One <span>, never a bare text node: `.sub > span` is what
                                  ellipsizes, and loose text overflows the row instead
                                  (it used to wrap under the buttons on a phone). */}
                              <div className='sub'>
                                {gone && <span className='chip-gone'>No devices</span>}
                                <span>{gone
                                  ? (emptySince(p) ? `since ${ago(emptySince(p))}` : '')
                                  : `${live.length} device${live.length === 1 ? '' : 's'}${on ? ` · ${on} online` : ''}${p.createdAt ? ` · added ${ago(p.createdAt)}` : ''}`}</span>
                              </div>
                              {!isOpen && playing && <NowPlaying np={playing} />}
                            </div>
                            <button className='ghost small' onClick={e => { e.stopPropagation(); startRename(p) }}>Rename</button>
                            {gone
                              ? <button className='ghost small danger' onClick={e => { e.stopPropagation(); deletePerson(p) }}>Delete</button>
                              : <button className='ghost small danger' onClick={e => { e.stopPropagation(); revokePerson(p) }}>Revoke all</button>}
                          </>}
                    </div>
                    <div className={'devices-sub' + (isOpen ? ' open' : '')}>
                      {live.map(d => <DeviceRow key={d.deviceKey} d={d} onCopied={() => toast("Device key copied")} onRevoke={revoke} onDelete={deleteDevice} onExpiry={changeExpiry} />)}
                      {revoked.length > 0 &&
                        <Collapse open={showRevoked}>
                          <div className='revoked-stack'>
                            {revoked.map(d => <DeviceRow key={d.deviceKey} d={d} onCopied={() => toast("Device key copied")} onRevoke={revoke} onDelete={deleteDevice} />)}
                          </div>
                        </Collapse>}
                    </div>
                  </div>
                )
              })}
              {emptyPersons.length > 1 &&
                <div className='sweep'>
                  <span>{emptyPersons.length} people hold no devices.</span>
                  <button className='ghost small danger' onClick={clearEmpty}>Clear empty people</button>
                </div>}
              {(unassigned.length || revokedLoose.length) ?
                <>
                  <div className='group-h'>Unassigned</div>
                  {unassigned.map(d => <DeviceRow key={d.deviceKey} d={d} onCopied={() => toast("Device key copied")} persons={persons} onAssign={assign} onRevoke={revoke} onDelete={deleteDevice} onExpiry={changeExpiry} loose />)}
                  {revokedLoose.length > 0 &&
                    <Collapse open={showRevoked}>
                      <div className='revoked-stack'>
                        {revokedLoose.map(d => <DeviceRow key={d.deviceKey} d={d} onCopied={() => toast("Device key copied")} onRevoke={revoke} onDelete={deleteDevice} loose />)}
                      </div>
                    </Collapse>}
                </> : null}
            </>}
      </div>
      <div style={{ padding: '0 16px 14px' }}>
        {revokedCount ?
          <div className='footer-toggle'>{revokedCount} revoked · <button className='link' onClick={() => setShowRevoked(v => !v)}>{showRevoked ? 'hide' : 'show'}</button></div>
          : null}
      </div>
    </div>
  )
}

/* ---- music requests (proposal 2026-07-24, P1) ----------------------------- */
// What paired devices have asked the operator to add. v1 is a HUMAN queue: the
// operator adds the music by hand (or via their own downloader) and marks it added;
// it appears on the next source scan. Pending first, then resolved (dimmed) for a
// record. All request text is escaped by React on render + capped at the host.
function RequestsPanel ({ state, refresh, toast }) {
  const requests = state.requests || []
  const pending = requests.filter(r => r.status === 'pending')
  const resolved = requests.filter(r => r.status !== 'pending')

  const act = async (path, id, ok) => {
    const r = await api(path, { id, ...(ok?.status ? { status: ok.status } : {}) })
    if (r.error) return toast('Failed: ' + r.error, true)
    if (ok?.msg) toast(ok.msg)
    refresh()
  }
  const resolve = (r, status) => act('/api/requests/resolve', r.id, {
    status, msg: status === 'added' ? `Marked "${r.name}" added.` : `Declined "${r.name}".`
  })
  const remove = async (r) => {
    if (!await askConfirm({ title: 'Remove this request?', message: 'It just clears the row. It does not un-add any music.', confirmLabel: 'Remove' })) return
    act('/api/requests/delete', r.id, { msg: 'Removed.' })
  }

  // A request describes music that does NOT exist in the library yet, so it has no
  // trackId/coverId and no art - a line of text is all there is to show.
  const line = (r) => [r.name, r.artist].filter(Boolean).join(' — ')
  const KIND = { artist: 'Artist', album: 'Album', track: 'Track' }

  return (
    <div className='panel grow'>
      <div className='panel-head'>
        <h2>Requests</h2>
        <span className='count'>{pending.length ? `· ${pending.length} pending` : ''}</span>
      </div>
      <div className='list'>
        {!requests.length
          ? <div className='empty'><strong>No requests yet.</strong><br />When someone you’ve shared with asks for music in the app, it shows up here.</div>
          : <>
              {pending.map(r =>
                <div className='reqrow' key={r.id}>
                  <div className='who'>
                    <div className='name'>
                      {line(r)}
                      <span className='badge plat'>{KIND[r.kind] || r.kind}</span>
                      {r.count > 1 && <span className='badge'>×{r.count}</span>}
                    </div>
                    <div className='sub'><span>{r.requesterName} · asked {ago(r.createdAt)}</span></div>
                  </div>
                  <button className='ghost small' onClick={() => resolve(r, 'added')}><Check size={14} weight='bold' /> Added</button>
                  <button className='ghost small danger' onClick={() => resolve(r, 'declined')}><Prohibit size={14} /> Decline</button>
                </div>)}
              {resolved.length > 0 &&
                <>
                  <div className='group-h'>Resolved</div>
                  {resolved.map(r =>
                    <div className='reqrow done' key={r.id}>
                      <div className='who'>
                        <div className='name'>
                          {line(r)}
                          <span className={'badge' + (r.status === 'added' ? ' guest' : '')}>{r.status}</span>
                        </div>
                        <div className='sub rev'><span>{r.requesterName} · {r.status} {ago(r.resolvedAt || r.updatedAt)}</span></div>
                      </div>
                      <button className='iconbtn' aria-label='Remove' onClick={() => remove(r)}><Trash size={14} /></button>
                    </div>)}
                </>}
            </>}
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

function DeviceRow ({ d, persons, onAssign, onRevoke, onDelete, onExpiry, onCopied, loose }) {
  const guest = !!d.expiresAt && !d.revokedAt
  const expired = guest && Date.now() > d.expiresAt
  return (
    <div className='dev'>
      <div className='drow'>
        <Avatar keyId={d.deviceKey} hasAvatar={d.hasAvatar && !d.revokedAt} avatarAt={d.avatarAt} name={d.label} online={d.online && !d.revokedAt} />
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
          {/* The device's public key: its one unforgeable identity (Noise proves it on every
              connection), where the label and the claimed name are only what the device SAID.
              So this is what settles it when two rows look alike. Click to copy the full key -
              the phone shows the same value under Settings > Device key, so an operator and
              whoever holds the phone can check they mean the same device. */}
          <button
            className='devkey'
            title={d.deviceKey}
            onClick={() => { copyText(d.deviceKey); onCopied && onCopied() }}
          >{shortKey(d.deviceKey)}<Copy size={11} weight='bold' /></button>
          <NowPlaying np={d.nowPlaying} />
        </div>
        {onAssign && !d.revokedAt &&
          <select className='assign' value={d.personId || ''} onChange={e => onAssign(d, e.target.value)}>
            <option value=''>— Unassigned —</option>
            {(persons || []).map(p => <option key={p.id} value={p.id}>{p.label || p.name}</option>)}
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
// A device claiming an identity, awaiting the operator's word. The actions depend on whether
// anyone already holds the claimed name, because confirming means different things:
//
//   nobody holds it  -> "Confirm" mints that person. Unambiguous, one button, as it always was.
//   one holder       -> "Join <name>" or "New person". This is the case that used to silently
//                       join, which is wrong for two real Sams (Tim, 2026-07-26).
//   several holders  -> pick WHICH one to join, or New person. Without this the host would join
//                       whichever the keyspace yields first.
//
// Only the operator is ever offered these. A device saying "I'm Sam" must never be able to seat
// itself beside the real Sam - that is the rule the whole confirmation step exists to enforce.
function PendingCard ({ d, holders = [], onConfirm, onRevoke }) {
  const [pick, setPick] = useState('')
  const many = holders.length > 1
  return (
    <div className='pending'>
      <div className='pend-top'>
        <span className='nm'>{d.label}</span>
        <span className='pend-st'><span className={'live' + (d.online ? '' : ' off')} aria-hidden='true' />{d.online ? 'Connected' : 'Last seen ' + ago(d.lastSeenAt)}</span>
      </div>
      <div className='pend-claim'>Claims to be <b>{d.claimedUser}</b></div>
      <div className='pend-key' title={d.deviceKey}>{shortKey(d.deviceKey)}</div>
      {holders.length > 0 && (
        <div className='pend-note'>
          {many
            ? `${holders.length} people are called ${d.claimedUser}. Pick who this device belongs to, or add another.`
            : `${d.claimedUser} is already here. Is this their device, or a different ${d.claimedUser}?`}
        </div>
      )}
      {many && (
        <select className='assign pend-pick' value={pick} onChange={e => setPick(e.target.value)}>
          <option value=''>Choose {d.claimedUser}…</option>
          {holders.map(p => <option key={p.id} value={p.id}>{p.label || p.name} · {p.hint}</option>)}
        </select>
      )}
      <div className='pend-acts'>
        {holders.length === 0
          ? <button onClick={() => onConfirm(d)}>Confirm</button>
          : many
            ? <button disabled={!pick} onClick={() => onConfirm(d, { personId: pick })}>Join</button>
            : <button onClick={() => onConfirm(d, { personId: holders[0].id })}>Join {holders[0].label || holders[0].name}</button>}
        {holders.length > 0 && <button className='ghost' onClick={() => onConfirm(d, { asNew: true })}>New person</button>}
        <button className='ghost danger' onClick={() => onRevoke(d)}>Revoke</button>
      </div>
    </div>
  )
}

/* ---- the donation modal -------------------------------------------------- */
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
    QRCode.toDataURL(rail.value, { width: 220, margin: 4, errorCorrectionLevel: 'M' })
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

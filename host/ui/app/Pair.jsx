// Pairing a device: the guest/full choice, the QR, and the "did it work?" watcher.
// Split out of App.jsx so the first-run wizard can run the SAME flow inline in a
// step instead of popping a modal on top of itself. PairFlow is the flow; PairModal
// is that flow in the dashboard's modal.

import { useState, useEffect, useRef } from 'react'
import { CheckCircle, Clock, Copy } from '@phosphor-icons/react'
import QRCode from 'qrcode'
import { api, copyText, fmtDur } from './api'
import { Modal } from './ui'
import { FolderPicker } from './Sharing'

export const DAY_MS = 86400000
const GUEST_DURATIONS = [
  { ms: DAY_MS, label: '24 hours' },
  { ms: 7 * DAY_MS, label: '7 days' },
  { ms: 30 * DAY_MS, label: '30 days' }
]

// onDone(outcome) fires when the operator is finished here: after a successful pair
// ({ ok: true, label }), or when they dismiss the expired card ({ ok: false }).
// `guestOption` hides the full/guest choice - a host being set up for the first time
// is pairing its owner's phone, not handing out a day pass.
export function PairFlow ({ toast, onDone, guestOption = true, owner = false }) {
  const [qr, setQr] = useState(null) // { link, dataUrl, guest, expiresMs }
  const [busy, setBusy] = useState(false)
  const [guest, setGuest] = useState(false)
  const [durMs, setDurMs] = useState(DAY_MS)
  // Per-person folders at pairing time (proposal 2026-08-31). `hears` is a QUESTION,
  // not a default: null until the operator answers, and no pairing code until they
  // do - "Can hear: everything" is a line somebody has to notice and disagree with
  // (Tim, on the PearCinema round). Only asked where the source can enforce it.
  const [canNarrow, setCanNarrow] = useState(false)
  const [hears, setHears] = useState(null) // null | 'all' | 'folders'
  const [paths, setPaths] = useState([])
  useEffect(() => {
    api('/api/state').then(st => setCanNarrow(!!st.canNarrow && !owner)).catch(() => {})
  }, [owner])
  const [copied, setCopied] = useState(false)
  const [outcome, setOutcome] = useState(null) // { ok: true, label } | { ok: false } once the window ends
  // deviceKey -> "grantedAt|scope" BEFORE the window opened. Success is a device whose signature
  // CHANGED - not merely a new key. Two things change it: a (re)pair stamps a fresh grantedAt
  // (grant() sets Date.now() every time, so a revoked-then-repaired device is caught), and an owner
  // PROMOTION of an already-paired phone flips scope to 'owner' WITHOUT a new grantedAt (it goes
  // over the live channel via ownerClaim, not this window's hello). Folding scope into the signature
  // catches both, so an owner promotion no longer wrongly reads as "expired".
  const seenGrants = useRef(new Map())
  const sig = (d) => `${d.grantedAt}|${d.scope || ''}`
  // Whether a window is still OPEN host-side, readable from the unmount cleanup below
  // (which closes over the FIRST render's state otherwise, and would never stop
  // anything). An outcome means the host already closed it - paired or timed out - so
  // leaving then has nothing to stop.
  const openRef = useRef(false)
  openRef.current = !!qr && !outcome
  const copyLink = async () => { if (await copyText(qr.link)) { setCopied(true); setTimeout(() => setCopied(false), 1500) } }

  // Leaving with a code still up closes the window host-side. This lives in an
  // unmount cleanup rather than on the close button so EVERY exit is covered -
  // Escape, the backdrop, the wizard moving on. close() is idempotent, so
  // stopping an already-closed (paired or timed-out) window is a no-op.
  useEffect(() => () => { if (openRef.current) api('/api/pair/stop', {}) }, [])

  // Watch the open window and SAY what happened, instead of leaving the operator holding a QR with
  // no idea whether it worked. The host's pair window is one-shot - pair.js close('paired') - so
  // `pairing` flips true->false either way; a device that pairs THROUGH this window (a new grant, or
  // a re-activated one with a fresh grantedAt) is what separates "paired" from "expired". Polls
  // faster than the dashboard's 3s so the confirmation feels immediate, and only while a code is up.
  useEffect(() => {
    if (!qr || outcome) return
    let done = false
    const t = setInterval(async () => {
      if (done) return
      const st = await api('/api/state').catch(() => null)
      if (!st || done) return
      const fresh = (st.devices || []).find(d => !d.revokedAt && seenGrants.current.get(d.deviceKey) !== sig(d))
      if (fresh) {
        done = true
        const label = fresh.label || 'a device'
        setOutcome({ ok: true, label, owner: owner || fresh.scope === 'owner' })
        setTimeout(() => onDone({ ok: true, label }), 2200)
      } else if (st.pairing === false) {
        // The window ended with nobody through it. Do NOT auto-close: the operator is standing
        // there and needs a fresh code, not a modal that vanishes.
        done = true
        setOutcome({ ok: false })
      }
    }, 1000)
    return () => { done = true; clearInterval(t) }
  }, [qr, outcome])

  const start = async () => {
    setBusy(true)
    // Remember who was here BEFORE the window opened. A device key that was not in this set is the
    // one that just paired through it - which is what lets us say WHICH device, and lets us tell a
    // successful pair from a window that simply timed out.
    const before = await api('/api/state').catch(() => null)
    seenGrants.current = new Map((before?.devices || []).map(d => [d.deviceKey, sig(d)]))
    // An OWNER window mints scope 'owner' (P2); a guest window carries the chosen duration;
    // a full window sends nothing. Owner and guest are mutually exclusive host-side.
    const opts = owner ? { owner: true } : guest ? { expiresMs: durMs } : {}
    if (canNarrow && hears === 'folders') opts.paths = paths
    const r = await api('/api/pair/start', opts)
    if (r.error) { setBusy(false); if (toast) toast('Failed: ' + r.error, true); return }
    // margin 4 = the spec's full quiet zone (was 1). A too-thin quiet zone hurts scanning, and it
    // bites hardest in DARK mode: the white QR card is a bright island in a dark page, so the phone
    // camera meters the dark surroundings and blows out the card, washing out the modules. A proper
    // quiet zone + a bigger .qr card (below) keep contrast even, so it scans in either theme.
    const dataUrl = await QRCode.toDataURL(r.link, { width: 256, margin: 4, errorCorrectionLevel: 'M' }).catch(() => null)
    setQr({ link: r.link, dataUrl, guest: r.guest, owner: r.owner, expiresMs: r.expiresMs })
    setBusy(false)
  }
  const stop = async () => { await api('/api/pair/stop', {}); setQr(null); if (toast) toast('Pairing window closed.') }

  if (!qr) {
    return (
      <div className='stack center'>
        {guestOption && !owner &&
          <div className='seg wide'>
            <button className={guest ? '' : 'on'} onClick={() => setGuest(false)}>Full access</button>
            <button className={guest ? 'on' : ''} onClick={() => setGuest(true)}>Guest pass</button>
          </div>}
        {owner
          ? <p className='hint center'>Scan this in PearTune on the phone you want to make an <b>owner</b>. It can then manage this library from the app - see devices, revoke, open a pairing window.</p>
          : guest
            ? <label className='hint center dur'>Access expires
                <select value={durMs} onChange={e => setDurMs(Number(e.target.value))}>
                  {GUEST_DURATIONS.map(o => <option key={o.ms} value={o.ms}>{o.label} after pairing</option>)}
                </select>
              </label>
            : <p className='hint center'>Permanent access. Scan the code in PearTune on your phone.</p>}
        {canNarrow && (
          <>
            <div className='seg wide'>
              <button className={hears === 'all' ? 'on' : ''} onClick={() => setHears('all')}>Hears everything</button>
              <button className={hears === 'folders' ? 'on' : ''} onClick={() => setHears('folders')}>Chosen folders</button>
            </div>
            {hears === 'folders' && <FolderPicker value={paths} onChange={setPaths} />}
            {hears === null && <p className='hint center'>Say what this device may hear before the code appears.</p>}
          </>
        )}
        <button onClick={start} disabled={busy || (canNarrow && (hears === null || (hears === 'folders' && !paths.length)))}>{busy ? 'Starting…' : 'Show pairing code'}</button>
      </div>
    )
  }

  if (outcome) {
    return (
      <div className='stack center'>
        {outcome.ok
          ? <>
              <CheckCircle size={44} weight='fill' color='var(--good)' />
              <h3 className='pairdone'>{outcome.owner ? `${outcome.label} is now an owner` : `Paired with ${outcome.label}`}</h3>
              <p className='hint center'>{outcome.owner ? 'It can manage this library from the app now. Closing…' : 'It can reach your library now. Closing…'}</p>
            </>
          : <>
              <Clock size={40} weight='regular' color='var(--muted)' />
              <h3 className='pairdone'>That code expired</h3>
              <p className='hint center'>Nobody paired through it. Show a fresh one when the phone is ready.</p>
              <div className='pairacts'>
                <button className='ghost' onClick={() => onDone({ ok: false })}>Close</button>
                <button onClick={() => { setOutcome(null); setQr(null) }}>New code</button>
              </div>
            </>}
      </div>
    )
  }

  return (
    <div className='stack center'>
      <div className='qrpanel'>
        {qr.dataUrl && <img className='qr' src={qr.dataUrl} alt='Pairing QR code' />}
        <div className='qrcap'>
          {qr.owner
            ? 'Owner pairing — this phone gains library management. Valid for 5 minutes.'
            : qr.guest
              ? `Guest pass — access expires ${fmtDur(qr.expiresMs)} after this device pairs.`
              : 'Valid for 5 minutes. Closes as soon as one device pairs.'}
        </div>
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
    </div>
  )
}

export function PairModal ({ onClose, toast, owner = false }) {
  return (
    <Modal title={owner ? 'Pair an Owner Phone' : 'Pair a Device'} onClose={onClose}>
      <PairFlow toast={toast} onDone={onClose} owner={owner} />
    </Modal>
  )
}

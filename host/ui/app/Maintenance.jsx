// Operator maintenance. A sectioned modal - Library name is the first section;
// more (guest grants, listening history, danger zone, …) can be added as siblings
// without reshaping this. The sections are exported individually because the
// first-run wizard shows the same password section as one of its steps.

import { useState } from 'react'
import { api } from './api'
import { Modal } from './ui'

export function MaintenanceModal ({ state, onClose, onSaved, toast }) {
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
export function suggestPassword () {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789'
  const r = new Uint8Array(16)
  ;(window.crypto || window.msCrypto).getRandomValues(r)
  let s = ''
  for (let i = 0; i < 16; i++) { s += a[r[i] % a.length]; if (i % 4 === 3 && i < 15) s += '-' }
  return s
}

// `heading` null drops the title AND the explanation: the first-run wizard puts
// this section under a step that has already said all of that, and two paragraphs
// of the same news reads as a bug.
export function PasswordSection ({ state, onSaved, toast, heading = 'Dashboard password' }) {
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
        {heading && <h4>{heading}</h4>}
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
      {heading && <>
        <h4>{heading}</h4>
        <p className='hint'>The lock on this dashboard. Anyone with it can revoke devices and open a pairing window. You are signed in, so you don’t need the old one to set a new one.</p>
      </>}
      <input value={next} maxLength={64} placeholder='New password (min 6)' autoComplete='new-password'
        onChange={e => setNext(e.target.value)} onKeyDown={e => e.key === 'Enter' && canSave && change()} />
      <div className='srcdiscard'><button className='link' onClick={() => setNext(suggestPassword())}>Suggest a strong one</button></div>
      <button className='block' style={{ marginTop: 4 }} onClick={change} disabled={!canSave}>{busy ? 'Changing…' : 'Change password'}</button>
    </section>
  )
}

export function LibraryNameSection ({ state, onSaved, toast }) {
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

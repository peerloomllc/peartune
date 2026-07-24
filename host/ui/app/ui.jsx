// The dashboard's shared chrome: the modal, the themed confirm/notify dialog and
// the collapse. Split out of App.jsx when the first-run wizard needed the same
// pieces - two components importing each other for a <Modal> is how a cycle
// starts.

import { useState, useEffect } from 'react'
import { X } from '@phosphor-icons/react'

/* ---- themed confirm (replaces window.confirm on the control plane) --------- */
let _pushConfirm = null
export function askConfirm (opts) {
  return new Promise(resolve => {
    if (!_pushConfirm) return resolve(window.confirm(opts.message || opts.title))
    _pushConfirm({ ...opts, resolve })
  })
}

// An informational popup (single button), themed like the confirm dialog. Used
// for the outcome of Test / Save / Rescan instead of a line of loose green text.
export function notify (title, message) {
  return askConfirm({ title, message, confirmLabel: 'Done', info: true })
}

// A height+fade collapse, always mounted so it animates BOTH ways (open and close).
export function Collapse ({ open, children }) {
  return <div className={'collapse' + (open ? ' open' : '')}>{children}</div>
}

export function ConfirmHost () {
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

export function Modal ({ title, onClose, children }) {
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

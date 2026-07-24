// Where the music comes from, as the operator sees it: a kind picker, the fields
// for that kind, a folder browser, and Test / Save / Rescan. Split out of App.jsx
// so the first-run wizard can show the SAME panel rather than a second, drifting
// copy of it (`embedded` drops the panel chrome and the running-library controls,
// which a host being set up for the first time has no use for).

import { useState, useEffect, useRef } from 'react'
import { MusicNotes, X, CaretLeft, Folder } from '@phosphor-icons/react'
import { api } from './api'
import { Modal, notify } from './ui'

const SERVERS = {
  subsonic: { label: 'Subsonic server', placeholder: 'http://localhost:4533' },
  jellyfin: { label: 'Jellyfin / Emby', placeholder: 'http://localhost:8096' }
}

export function SourcePanel ({ state, refresh, toast, embedded = false, onSaved }) {
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
    if (onSaved) onSaved(r)
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
    <div className={embedded ? 'srcembed' : 'panel'}>
      {!embedded &&
        <div className='panel-head'><h2><MusicNotes size={13} weight='bold' style={{ verticalAlign: '-2px', marginRight: 5 }} />Music source</h2></div>}
      <div className={embedded ? '' : 'panel-body'}>
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
          {!embedded && <button className='ghost' onClick={rescan} disabled={!!busy}>{busy === 'rescan' ? 'Rescanning…' : 'Rescan'}</button>}
        </div>
        {/* Scheduled auto-rescan: pick it up without a manual Rescan when files land.
            Most useful for a folder library (a server watches its own). Not offered
            during first-run setup - there is no library to keep up to date yet. */}
        {!embedded &&
          <label className='autoscan'>
            <span>Auto-rescan</span>
            <select value={state.rescanIntervalMin || 0} onChange={setAutoRescan}>
              <option value={0}>Off</option>
              <option value={15}>Every 15 minutes</option>
              <option value={30}>Every 30 minutes</option>
              <option value={60}>Every hour</option>
              <option value={360}>Every 6 hours</option>
            </select>
          </label>}
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

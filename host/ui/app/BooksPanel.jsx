// Audiobooks from Audiobookshelf, beside the music source (proposal
// 2026-09-13-audiobookshelf-books-source). Its own panel rather than a fourth tab of the
// music source picker: it never replaces the music, and removing it leaves the music as it was.

import { useState, useEffect } from 'react'
import { api } from './api'
import { notify } from './ui'

export function BooksPanel ({ state, refresh }) {
  const saved = state.books || null
  const [url, setUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(null) // 'test' | 'save' | 'remove' | null
  const [found, setFound] = useState(null)

  // Fill the form from what is saved, until the operator starts typing.
  useEffect(() => {
    if (dirty) return
    setUrl(saved?.url || '')
    setUsername(saved?.username || '')
  }, [saved?.url, saved?.username])

  // An Audiobookshelf on this same box (the Umbrel app answers on localhost:13378).
  useEffect(() => {
    let live = true
    api('/api/source/detect').then(r => {
      if (!live) return
      setFound(((r && r.sources) || []).filter(d => d.kind === 'audiobookshelf'))
    })
    return () => { live = false }
  }, [])

  const edit = (setter) => (e) => { setter(e.target.value); setDirty(true) }
  // Empty secrets mean "keep the saved one" on the host, so they are only sent when typed.
  const form = () => {
    const out = { url: url.trim(), username: username.trim() }
    if (apiKey) out.apiKey = apiKey
    if (password) out.password = password
    return out
  }
  const books = (n) => `${(n || 0).toLocaleString()} audiobook${n === 1 ? '' : 's'}`

  const test = async () => {
    setBusy('test')
    const r = await api('/api/books/test', form())
    setBusy(null)
    if (!r.ok) return notify('Could not reach Audiobookshelf', r.error || 'The Audiobookshelf server did not answer.')
    notify('Audiobookshelf works', <>Found <span className='hl'>{books(r.books)}</span> in {r.libraries} book librar{r.libraries === 1 ? 'y' : 'ies'}.</>)
  }
  const save = async () => {
    setBusy('save')
    const r = await api('/api/books', form())
    if (!r.ok) { setBusy(null); return notify('Could not add Audiobookshelf', r.error || 'The audiobooks source could not be saved.') }
    setDirty(false); setApiKey(''); setPassword('')
    await refresh()
    setBusy(null)
    notify('Audiobooks added', <><span className='hl'>{books(r.books)}</span> from Audiobookshelf are now in the library, next to your music.</>)
  }
  const remove = async () => {
    setBusy('remove')
    await api('/api/books/remove', {})
    setDirty(false); setApiKey(''); setPassword(''); setUrl(''); setUsername('')
    await refresh()
    setBusy(null)
    notify('Audiobooks removed', 'Audiobookshelf is no longer part of the library. The music source is unchanged.')
  }

  return (
    <div className='panel bookspanel'>
      <div className='panel-body'>
        <h4>Audiobooks from Audiobookshelf</h4>
        <p className='hint'>
          Optional. Adds the books in an Audiobookshelf server to this library, beside your music.
          Everyone who can use the library can listen to them, including people limited to
          certain music folders. An API key is best: create one in Audiobookshelf under
          Settings, API Keys.
        </p>

        {saved && (
          <p className={saved.error ? 'hint warn' : 'hint'}>
            {saved.error
              ? <>Could not read Audiobookshelf: {saved.error}</>
              : <>Serving <span className='hl'>{books(saved.books)}</span> from {saved.url}.</>}
          </p>
        )}

        {found && found.length > 0 && !url && (
          <div className='srcdetect'>
            <span className='subtle'>Found on this server - tap to use its address:</span>
            <div className='srcdetect-row'>
              {found.map((d, i) =>
                <button key={i} className='detectchip' onClick={() => { setUrl(d.url); setDirty(true) }} title={d.url}>
                  {d.server} · {d.name}
                </button>)}
            </div>
          </div>
        )}

        <label>Audiobookshelf URL</label>
        <input value={url} placeholder='http://localhost:13378' onChange={edit(setUrl)} />
        <label>API key</label>
        <input type='password' value={apiKey} placeholder={saved?.hasApiKey ? 'Unchanged' : 'Paste an Audiobookshelf API key'} onChange={edit(setApiKey)} />
        <label>Or username and password</label>
        <input value={username} placeholder='Username' onChange={edit(setUsername)} />
        <input type='password' value={password} placeholder={saved?.hasPassword ? 'Unchanged' : 'Password'} onChange={edit(setPassword)} style={{ marginTop: 6 }} />

        <div className='srcactions'>
          <button className='ghost' onClick={test} disabled={!!busy || !url.trim()}>{busy === 'test' ? 'Testing…' : 'Test'}</button>
          <button onClick={save} disabled={!!busy || !url.trim()}>{busy === 'save' ? 'Saving…' : saved ? 'Save' : 'Add'}</button>
          <button className='ghost' onClick={remove} disabled={!!busy || !saved}>{busy === 'remove' ? 'Removing…' : 'Remove'}</button>
        </div>
      </div>
    </div>
  )
}

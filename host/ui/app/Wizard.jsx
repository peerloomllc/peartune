// First-run setup: the guided path a brand-new host takes before it is any use.
//
// Every piece here already existed as a separate dashboard control - the library
// name in the Maintenance modal, the music-source panel with its autodetect, the
// password section, the pairing modal. What did NOT exist was an ORDER. A fresh
// install dropped the operator into the full dashboard with "My Library", an empty
// default source and no devices, and left them to find those four controls in three
// different places. This sequences them, opens with a plain-language explainer of
// what PearTune even is, and hands off to the dashboard at the end.
//
// It is a full-page view rather than a modal on purpose: the dashboard behind it
// has nothing to show yet, and the source step opens the folder browser in a modal
// of its own (a modal inside a modal is a stacking bug waiting to happen).

import { useState } from 'react'
import { CheckCircle, MusicNotes, Broadcast, Tag, Lock, CaretLeft, Sun, Moon } from '@phosphor-icons/react'
import { api } from './api'
import { SourcePanel } from './SourcePanel'
import { PairFlow } from './Pair'
import { PasswordSection } from './Maintenance'
import { setupSteps, DEFAULT_LIBRARY_NAME } from './setup'
import { PEAR_MARK } from './icon'

const TITLES = {
  welcome: 'Welcome',
  name: 'Name it',
  source: 'Your music',
  password: 'Password',
  pair: 'Pair a phone',
  done: 'All set'
}

export default function SetupWizard ({ state, refresh, toast, isDark, onTheme, onExit }) {
  const steps = setupSteps(state)
  const [at, setAt] = useState(0)
  const step = steps[at] || 'welcome'
  const next = () => setAt(i => Math.min(i + 1, steps.length - 1))
  const back = () => setAt(i => Math.max(i - 1, 0))
  // The dots skip the bookends: "Welcome" and "All set" are not work to be done.
  const dots = steps.filter(s => s !== 'welcome' && s !== 'done')

  return (
    <div className='app'>
      <header className='topbar'>
        <div className='brand'>
          <img className='brand-mark' src={PEAR_MARK} alt='' aria-hidden='true' />
          <div>
            <div className='brand-name'>Pear<span>Tune</span></div>
            <div className='brand-sub'>Setting up</div>
          </div>
        </div>
        <div className='spacer' />
        <div className='topbar-right'>
          <button className='iconbtn' onClick={onTheme} aria-label='Toggle theme' title={isDark ? 'Switch to light' : 'Switch to dark'}>
            {isDark ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          {/* Nothing left to skip on the last card - it has the button that leaves. */}
          {step !== 'done' && <button className='link' onClick={onExit}>Skip setup</button>}
        </div>
      </header>

      <div className='main'>
        {dots.length > 0 &&
          <ol className='wizdots' aria-label='Setup progress'>
            {dots.map((s, n) => {
              const i = steps.indexOf(s)
              const done = i < at
              const now = i === at
              return (
                <li key={s} className={(now ? 'now' : '') + (done ? ' done' : '')} aria-current={now ? 'step' : undefined}>
                  <span className='wizdot' aria-hidden='true'>{done ? <CheckCircle size={13} weight='fill' /> : n + 1}</span>
                  <span className='wizlbl'>{TITLES[s]}</span>
                </li>
              )
            })}
          </ol>}

        <div className='panel wizcard'>
          {step === 'welcome' && <Welcome hasPassword={steps.includes('password')} />}
          {step === 'name' && <NameStep state={state} refresh={refresh} toast={toast} onNext={next} />}
          {step === 'source' && <SourceStep state={state} refresh={refresh} toast={toast} />}
          {step === 'password' && <PasswordStep state={state} refresh={refresh} toast={toast} />}
          {step === 'pair' && <PairStep onNext={next} toast={toast} />}
          {step === 'done' && <DoneStep state={state} />}
        </div>

        <Nav step={step} state={state} at={at} onBack={back} onNext={next} onExit={onExit} />
      </div>
    </div>
  )
}

/* ---- the bottom bar ------------------------------------------------------- */
// One place decides what the primary button says and whether it is live, so a step
// body stays a step body. `name` saves through its own handler (NameStep passes it
// up via onNext), so it is the one step whose primary lives in the step itself.
function Nav ({ step, state, at, onBack, onNext, onExit }) {
  if (step === 'name') return <div className='wiznav'>{at > 0 && <button className='ghost' onClick={onBack}><CaretLeft size={15} /> Back</button>}</div>

  const sourceReady = !!(state.source && state.source.from === 'dashboard')
  const primary =
    step === 'welcome' ? { label: 'Get started', on: true, go: onNext }
      : step === 'source' ? { label: 'Continue', on: sourceReady, go: onNext }
        : step === 'password' ? { label: 'Continue', on: true, go: onNext }
          : step === 'done' ? { label: 'Open the dashboard', on: true, go: onExit }
            : null // 'pair' drives itself

  // Skipping is always allowed. A setup flow you cannot get out of is worse than no
  // setup flow - and the operator may already know exactly which control they want.
  const skippable = step === 'source' || step === 'password' || step === 'pair'

  return (
    <div className='wiznav'>
      {at > 0 && step !== 'done' && <button className='ghost' onClick={onBack}><CaretLeft size={15} /> Back</button>}
      <div className='spacer' />
      {skippable && <button className='link' onClick={onNext}>Skip this step</button>}
      {primary && <button onClick={primary.go} disabled={!primary.on}>{primary.label}</button>}
    </div>
  )
}

/* ---- steps ---------------------------------------------------------------- */
function Welcome ({ hasPassword }) {
  return (
    <div className='wizbody'>
      <h2 className='wizh'>Your music, on your phone, anywhere</h2>
      <p className='hint'>
        PearTune plays the music that lives on <b>this machine</b>. Your phone connects to it
        directly, from anywhere - no port forwarding, no VPN, no account and no copy of your
        music on anyone else’s server.
      </p>
      <p className='hint'>{hasPassword ? 'Four' : 'Three'} quick steps and you are listening:</p>
      <ol className='wizlist'>
        <li><Tag size={17} weight='bold' /><div><b>Name this library</b><span>What your phone will call it.</span></div></li>
        <li><MusicNotes size={17} weight='bold' /><div><b>Point it at your music</b><span>A folder on this machine, or a music server you already run.</span></div></li>
        {hasPassword && <li><Lock size={17} weight='bold' /><div><b>Set a password</b><span>The lock on this page. Optional, but do it.</span></div></li>}
        <li><Broadcast size={17} weight='bold' /><div><b>Pair your phone</b><span>Scan a code once. That phone is then allowed in, and only that phone.</span></div></li>
      </ol>
    </div>
  )
}

function NameStep ({ state, refresh, toast, onNext }) {
  const [name, setName] = useState(state.libraryName || '')
  const [busy, setBusy] = useState(false)
  const clean = name.trim()
  const save = async () => {
    // Unchanged (including someone who is happy with "My Library") is not an error -
    // it just moves on rather than POSTing a rename that renames nothing.
    if (!clean || clean === state.libraryName) return onNext()
    setBusy(true)
    const r = await api('/api/library', { name: clean })
    setBusy(false)
    if (!r.ok) return toast('Failed: ' + (r.error || 'could not rename the library'), true)
    await refresh()
    onNext()
  }
  return (
    <div className='wizbody'>
      <h2 className='wizh'>Name this library</h2>
      <p className='hint'>Shown on this page, and on every phone that pairs with it. “{DEFAULT_LIBRARY_NAME}” works, but a name helps once you have more than one.</p>
      <input value={name} maxLength={64} placeholder={DEFAULT_LIBRARY_NAME} autoFocus
        onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && !busy && save()} />
      <button className='block' style={{ marginTop: 12 }} onClick={save} disabled={busy || !clean}>
        {busy ? 'Saving…' : 'Save and continue'}
      </button>
    </div>
  )
}

function SourceStep ({ state, refresh, toast }) {
  const saved = !!(state.source && state.source.from === 'dashboard')
  const found = (state.stats && state.stats.tracks) || 0
  return (
    <div className='wizbody'>
      <h2 className='wizh'>Where is your music?</h2>
      <p className='hint'>
        Either a <b>folder</b> on this machine, or a music server you already run
        (<b>Subsonic</b>-compatible - Navidrome, Nextcloud Music and friends - or <b>Jellyfin / Emby</b>).
        Anything PearTune finds running here shows up as a shortcut. <b>Test</b> checks it without
        committing; <b>Save</b> makes it your library.
      </p>
      <SourcePanel state={state} refresh={refresh} toast={toast} embedded />
      {saved
        ? <p className='hint good-line'><CheckCircle size={15} weight='fill' /> Saved - {found.toLocaleString()} track{found === 1 ? '' : 's'} in your library.</p>
        : <p className='hint subtle'>Save your music source to continue.</p>}
    </div>
  )
}

function PasswordStep ({ state, refresh, toast }) {
  return (
    <div className='wizbody'>
      <h2 className='wizh'>Lock this page</h2>
      <p className='hint'>
        This page can revoke devices and open a pairing window, so it is worth a password you chose.
        You are signed in already, so you do not need the old one. Skip this if the password you
        signed in with is fine.
      </p>
      <PasswordSection state={state} onSaved={refresh} toast={toast} heading={null} />
    </div>
  )
}

function PairStep ({ onNext, toast }) {
  return (
    <div className='wizbody'>
      <h2 className='wizh'>Pair your phone</h2>
      <p className='hint'>
        Install PearTune on your phone, open it and scan this code. Pairing is what allows a
        device in - you can revoke it from this page at any time, and it loses access immediately.
      </p>
      <PairFlow toast={toast} guestOption={false} onDone={onNext} />
    </div>
  )
}

function DoneStep ({ state }) {
  const tracks = (state.stats && state.stats.tracks) || 0
  const devices = (state.devices || []).filter(d => !d.revokedAt).length
  return (
    <div className='wizbody center'>
      <CheckCircle size={46} weight='fill' color='var(--good)' />
      <h2 className='wizh'>You are set up</h2>
      <ul className='wizsum'>
        <li><Tag size={15} /> {state.libraryName || DEFAULT_LIBRARY_NAME}</li>
        <li><MusicNotes size={15} /> {tracks.toLocaleString()} track{tracks === 1 ? '' : 's'}</li>
        <li><Broadcast size={15} /> {devices} device{devices === 1 ? '' : 's'} paired</li>
      </ul>
      <p className='hint'>
        Everything here can be changed later: the name and password live under the gear menu,
        the music source under <b>Music Source</b> and <b>Pair a device</b> is at the bottom of
        the dashboard.
      </p>
    </div>
  )
}

// Home Assistant speakers, as the operator sets them up (proposal 2026-08-01).
//
// Deliberately small: an address, a token, Test and Save, then the speakers we can
// see. Everything clever happens on the host. Markup follows SourcePanel's classes
// (srcfields / srcactions / hint / subtle / banner) rather than inventing new ones,
// so it inherits the dashboard's spacing and dark mode for free.
//
// THE COPY IS WORTH READING. Phase 1 refuses a Home Assistant that is not on this
// same machine, because Home Assistant is the party that FETCHES the audio: a remote
// one would mean publishing the library to the network. The panel says that in plain
// words, because an operator typing their real HA address deserves the reason rather
// than "invalid address".

import { useState, useEffect, useRef } from 'react'
import { SpeakerHigh } from '@phosphor-icons/react'
import { api, copyText } from './api'
import { haConfig, PACKAGE_INCLUDE, PACKAGE_PATH } from './ha-config'
import { notify } from './ui'

export function SpeakersPanel ({ toast }) {
  const [cfg, setCfg] = useState(null)
  const [speakers, setSpeakers] = useState([])
  const [castPort, setCastPort] = useState(0)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(null) // 'test' | 'save' | null
  const [dirty, setDirty] = useState(false)
  // Shown ONCE after minting; publicConfig never carries it back.
  const [voiceToken, setVoiceToken] = useState('')
  // For load(), which is called from async handlers that closed over an older
  // render. Same guard SourcePanel uses, and for the same reason: without it a
  // refresh silently reverts what the operator has typed but not yet saved.
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty

  // `force` = we just saved, so what is on disk IS what the operator wanted and it
  // is safe to adopt. Otherwise an unsaved edit wins over the stored config.
  //
  // THIS BIT THE FIRST HARDWARE RUN. Test called load() unconditionally, so
  // "tick the box -> Test -> Save" fed the SAVED (unticked) value back into the
  // form, and Save then wrote enabled:false while the operator was looking at a
  // ticked box. The speaker list refreshed; the config must not.
  const load = async (force = false) => {
    const r = await api('/api/speakers')
    if (!r || !r.config) return
    if (force || !dirtyRef.current) setCfg(r.config)
    setSpeakers(r.speakers || [])
    if (r.castPort) setCastPort(r.castPort)
  }

  useEffect(() => { load(true) }, [])

  const set = (patch) => { setCfg(c => ({ ...c, ...patch })); setDirty(true) }

  const save = async () => {
    setBusy('save')
    // An empty token field means "keep the stored one", the same rule the music
    // source panel uses for passwords - so it is only sent when actually typed.
    const body = { enabled: cfg.enabled, baseUrl: cfg.baseUrl }
    if (token) body.token = token
    const r = await api('/api/speakers', body)
    setBusy(null)
    if (!r.ok) return notify('Could not save', r.error || 'unknown error')
    setToken('')
    setDirty(false)
    await load(true)
    if (toast) toast('Speakers saved')
  }

  // Generated from what the host actually reports, so the port and token can never drift
  // from what is running. Kept in one place rather than split across the docs and the UI.
  // Generated from what the host actually reports, so the port and token can never drift
  // from what is running. Lives in its own module because a test parses it - see
  // test/ha-config.test.js and the note at the top of ha-config.js.
  const haYaml = haConfig({ port: castPort || 8742, token: voiceToken })

  const enableVoice = async () => {
    setBusy('voice')
    const r = await api('/api/speakers/voice', { enabled: true, entityId: cfg.voiceEntityId || '' })
    setBusy(null)
    if (!r.ok) return notify('Could not turn on voice control', r.error || 'unknown error')
    setVoiceToken(r.voiceToken || '')
    if (r.port) setCastPort(r.port)
    await load(true)
  }

  const disableVoice = async () => {
    setBusy('voice')
    const r = await api('/api/speakers/voice', { enabled: false })
    setBusy(null)
    if (!r.ok) return notify('Could not turn it off', r.error || 'unknown error')
    setVoiceToken('')
    await load(true)
    if (toast) toast('Voice control off')
  }

  const setVoiceSpeaker = async (entityId) => {
    setCfg(c => ({ ...c, voiceEntityId: entityId }))
    await api('/api/speakers', { enabled: cfg.enabled, baseUrl: cfg.baseUrl, voiceEntityId: entityId })
  }

  const test = async () => {
    setBusy('test')
    const r = await api('/api/speakers/test', {})
    setBusy(null)
    if (!r.ok) return notify('Could not reach Home Assistant', r.error || 'unknown error')
    notify('Home Assistant is reachable', `Found ${r.speakers} speaker${r.speakers === 1 ? '' : 's'}.`)
    await load()
  }

  return (
    <div className='panel'>
      <div className='panel-head'>
        <h2>
          <SpeakerHigh size={13} weight='bold' style={{ verticalAlign: '-2px', marginRight: 5 }} />
          Speakers
        </h2>
      </div>
      <div className='panel-body'>
        {!cfg
          ? <p className='hint'>Loading…</p>
          : <>
            <p className='hint'>
              Play your library on a Home Assistant speaker. PearTune asks Home Assistant
              to play it and Home Assistant fetches the music itself, so nothing new is
              opened up on your network.
            </p>

            <div className='srcfields'>
              <label className='autoscan'>
                <span>Allow speaker playback</span>
                <input
                  type='checkbox'
                  checked={!!cfg.enabled}
                  onChange={e => set({ enabled: e.target.checked })}
                />
              </label>

              <label>Home Assistant address</label>
              <input
                value={cfg.baseUrl || ''}
                placeholder='http://127.0.0.1:8123'
                onChange={e => set({ baseUrl: e.target.value })}
              />
              <p className='hint'>
                This has to be a Home Assistant running on <strong>this same machine</strong>,
                an address like <code>http://127.0.0.1:8123</code>. Home Assistant is what
                actually fetches the music, so pointing at one on another machine would mean
                opening your library up to your network. PearTune will not do that yet.
              </p>

              <label>
                Access token{' '}
                {cfg.tokenSet && <span className='subtle'>- one is saved</span>}
              </label>
              <input
                type='password'
                value={token}
                placeholder={cfg.tokenSet ? 'Unchanged' : 'Paste a long-lived access token'}
                onChange={e => { setToken(e.target.value); setDirty(true) }}
              />
              <p className='hint'>
                In Home Assistant: click your name at the bottom left, open the{' '}
                <strong>Security</strong> tab, scroll to <strong>Long-lived access
                tokens</strong> and create one.
              </p>
            </div>

            {cfg.problem && <div className='banner'>{cfg.problem}</div>}

            <div className='srcactions center'>
              <button className='ghost' onClick={test} disabled={!!busy || !cfg.enabled}>
                {busy === 'test' ? 'Testing…' : 'Test'}
              </button>
              <button onClick={save} disabled={!!busy || !dirty}>
                {busy === 'save' ? 'Saving…' : 'Save'}
              </button>
            </div>

            {/* VOICE. Its own block and its own switch, because letting anyone in the room
                start music is a genuinely different decision from casting off your phone.
                The disclosure is the point of this section, not decoration (Tim,
                2026-08-02: "we just have to make sure proper explanations/disclosures are
                there"), so it says plainly what turning this on means BEFORE the switch. */}
            {cfg.enabled && cfg.tokenSet && (
              <div className='foundlist'>
                <div className='group-h'>Voice control</div>
                <p className='hint'>
                  Lets someone say <em>"Okay Nabu, play Led Zeppelin"</em> and hear it start
                  on a speaker.
                </p>
                <div className='banner info'>
                  <span>
                    <strong>Anyone who can speak in your home can play your music.</strong>{' '}
                    There is no password on a spoken request and no way to tell who said it,
                    so treat this like leaving a record player out: fine at home, worth
                    thinking about with guests. It cannot browse, download, share or change
                    anything - only start playback on your own speakers. Turning it off, or
                    revoking the "Home Assistant voice" device on the People &amp; Devices
                    tab, stops it at once.
                  </span>
                </div>

                {!cfg.voiceEnabled
                  ? <div className='srcactions center'>
                    <button onClick={enableVoice} disabled={!!busy}>
                      {busy === 'voice' ? 'Turning on…' : 'Turn on voice control'}
                    </button>
                  </div>
                  : <>
                    <label>Speaker to use when the request does not name one</label>
                    <select
                      value={cfg.voiceEntityId || ''}
                      onChange={e => setVoiceSpeaker(e.target.value)}
                    >
                      <option value=''>Pick a speaker…</option>
                      {speakers.map(s => <option key={s.entityId} value={s.entityId}>{s.name}</option>)}
                    </select>
                    {voiceToken
                      ? <>
                        {/* THE WHOLE CONFIG, FILLED IN, WITH A COPY BUTTON. The first cut
                            showed a bare token and told the operator to "paste it into the
                            configuration below" - and there was no configuration below, and
                            no port shown, because the port used to be random. Handing
                            someone a secret and a homework assignment is not a setup flow.
                            They still have to edit a file, which there is no way around,
                            but they should never have to transcribe or look anything up. */}
                        <p className='hint'>
                          <strong>Almost done.</strong> Two steps, and the first is only ever
                          needed once.
                        </p>
                        <p className='hint'>
                          <strong>1.</strong> If your Home Assistant{' '}
                          <code>configuration.yaml</code> does not already load packages, add
                          this to it once:
                        </p>
                        <textarea readOnly rows={2} className='mono setupyaml' value={PACKAGE_INCLUDE} onFocus={e => e.target.select()} />
                        <p className='hint'>
                          <strong>2.</strong> Save the block below as{' '}
                          <code>{PACKAGE_PATH}</code> next to your{' '}
                          <code>configuration.yaml</code>. Everything is filled in already.
                          PearTune lives entirely in that one file, so an update replaces it
                          rather than editing your main configuration again. Then restart Home
                          Assistant.
                        </p>
                        <textarea readOnly rows={16} className='mono setupyaml' value={haYaml} onFocus={e => e.target.select()} />
                        <div className='srcactions center'>
                          <button onClick={async () => {
                            const ok = await copyText(haYaml)
                            if (toast) toast(ok ? 'Configuration copied' : 'Could not copy - select it and copy by hand')
                          }}>Copy configuration</button>
                        </div>
                        <p className='hint'>
                          Then say <em>"Okay Nabu, put on Led Zeppelin"</em>.{' '}
                          <strong>"Put on" and "listen to", not "play".</strong> Home
                          Assistant reserves "play something" for its own music search, which
                          cannot see your library and answers <em>"no devices supports the
                          required features"</em>. The token above is
                          shown once - if you lose it, press New token and paste the new
                          block over the old one. Full notes, including what to do if you use
                          an AI voice assistant, are in <code>docs/home-assistant-voice.md</code>.
                        </p>
                      </>
                      : <p className='hint'>
                        Voice control is on. If you need the Home Assistant configuration
                        again, press <strong>New token</strong> - the block is only shown
                        when a token is minted, because it contains one.
                      </p>}
                    <div className='srcactions center'>
                      <button className='ghost' onClick={enableVoice} disabled={!!busy}>
                        {busy === 'voice' ? 'Working…' : 'New token'}
                      </button>
                      <button className='destructive' onClick={disableVoice} disabled={!!busy}>
                        Turn off
                      </button>
                    </div>
                  </>}
              </div>
            )}

            {speakers.length > 0 && (
              <div className='foundlist'>
                <div className='group-h'>Speakers found</div>
                <div className='rootlist'>
                  {speakers.map(s => (
                    <div className='rootrow' key={s.entityId}>
                      <SpeakerHigh size={14} />
                      <span className='foundname' title={s.entityId}>{s.name}</span>
                      <span className='subtle'>{s.state}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {cfg.enabled && cfg.tokenSet && !cfg.problem && speakers.length === 0 &&
              <p className='hint'>No speakers found yet. Try Test.</p>}
          </>}
      </div>
    </div>
  )
}

// PearTune shell.
//
// Three layers, same as every app in the suite: this RN shell hosts the Bare
// worklet (P2P) and the WebView (UI), and routes IPC between them.
//
// The one thing that is PearTune-specific: the shell owns the AUDIO PLAYER. The
// worklet serves audio on a loopback HTTP port, and the player streams from that
// URL, so ExoPlayer does the buffering, seeking, decoding and background
// playback and we do not reimplement any of it.
//
// Consequence worth understanding: the audio flows through the live P2P
// connection while it plays. When the host revokes this device, the connection
// dies, the loopback stream breaks, and the music stops. That is the product.

import { useEffect, useRef, useState } from 'react'
import { View, Text, StatusBar, BackHandler, Appearance, AppState, NativeModules, Platform, Settings, Share } from 'react-native'
import { WebView } from 'react-native-webview'
import * as Linking from 'expo-linking'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'
import * as Network from 'expo-network'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Worklet } from 'react-native-bare-kit'
// expo-audio, not expo-av: av is deprecated as of SDK 54.
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio'
import b4a from 'b4a'
import { Asset } from 'expo-asset'
import * as FileSystem from 'expo-file-system/legacy'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const bundle = require('../assets/bare-universal.bundle')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { reindexAfterMove, reindexAfterRemove } = require('./queue-index')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { decideStarve, decideRecover } = require('./starve')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { openableUrl } = require('./openable')

// THE DEMO LIBRARY (proposal 2026-07-28-app-review-demo). Five CC0 tracks that ship inside the
// app so PearTune works with no server at all - see assets/demo-music/LICENSE.md for why they are
// safe to redistribute in a binary.
//
// The requires are static because Metro's asset graph is static: the file names have to appear
// literally in the source or the media does not make it into the build. `manifest.json` is a
// SOURCE ext, so it arrives already parsed; the audio and the cover are ASSET exts, so they
// arrive as module handles that Asset.fromModule resolves to real paths at runtime.
//
// Nothing here is resolved (and so nothing is copied out of the bundle) until the user actually
// asks for the demo - see shell:enableDemo. A first launch that goes straight to pairing pays
// none of it.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const DEMO_MANIFEST = require('../assets/demo-music/manifest.json')
// NOT cover.jpg. See the note in metro.config.js: a recognised image extension becomes an
// Android drawable RESOURCE, which expo-asset can only name, never resolve to a readable path.
const DEMO_COVER = require('../assets/demo-music/cover.bin')
const DEMO_AUDIO: Record<string, any> = {
  '01 Drowning in your smile.mp3': require('../assets/demo-music/01 Drowning in your smile.mp3'),
  '02 Dancing in the street.mp3': require('../assets/demo-music/02 Dancing in the street.mp3'),
  '03 Aeroplane.mp3': require('../assets/demo-music/03 Aeroplane.mp3'),
  '04 Im glad you are here with me.mp3': require('../assets/demo-music/04 Im glad you are here with me.mp3'),
  '05 Sugar and coffee.mp3': require('../assets/demo-music/05 Sugar and coffee.mp3')
}

// Copy a bundled asset out to a real path the worklet can read. On a release build the file is
// inside the APK/IPA, so downloadAsync is a genuine copy the first time and a no-op after -
// which is why enabling the demo twice is cheap.
async function resolveAsset (mod: any): Promise<string | null> {
  try {
    const a = Asset.fromModule(mod)
    await a.downloadAsync()
    const uri = a.localUri ?? a.uri ?? ''
    if (!uri) return null
    const path = uri.replace(/^file:\/\//, '')
    // PERCENT-DECODE. A file:// URI is a URL, so its path is percent-encoded - and four of
    // the five demo tracks have spaces in their names. Stripping the scheme alone leaves
    // "%20" in the string, which bare-fs opens literally and ENOENTs, so every track failed
    // to install and the demo library browsed perfectly while playing nothing.
    //
    // ANDROID NEVER SHOWED THIS: its asset packager copies each file out under a sanitised,
    // space-free name (assets_demomusic_01drowninginyoursmile.mp3), so there was nothing to
    // encode. iOS keeps the real filename inside the app bundle. The cover survived there
    // only because `cover.bin` happens to have no space in it - which is exactly why the
    // symptom was "art works, audio does not". Found on the iOS Simulator, 2026-07-28.
    try {
      return decodeURIComponent(path)
    } catch {
      return path // a malformed escape is not worth losing the asset over
    }
  } catch {
    return null
  }
}

type Pending = { resolve: (v: any) => void; reject: (e: any) => void }

// THE PENDING PAIR LINK LIVES AT MODULE SCOPE, not in a ref, and that is the whole fix for a
// link doing nothing when the app is already open (2026-07-28).
//
// A warm pear:// intent REMOUNTS this component. Measured on the TCL by tagging each mount:
//   [link] stash via event rv=d8k1di5y inst=974
//   [link] UI collected NOTHING        inst=883
// The URL was written into mount 974's ref and looked for in mount 883's, which is a fresh null.
// So the link was never lost in transit and no listener was missing - every hop fired. It was
// stored somewhere that does not outlive the event that fills it.
//
// A module-level slot survives any number of remounts, so whichever mount is alive when the UI
// asks gets the link. It also makes the two orderings equivalent: if the remount lands after the
// stash, the new mount's boot-time take collects it; if before, the link:pending nudge does.
let pendingPairLink: string | null = null

// The shell paints the strip behind the status bar and under the WebView, so it
// has to know the theme too - otherwise a light UI sits under a black notch. The
// UI owns the decision (it knows whether the setting is light, dark or system)
// and reports the RESOLVED scheme back down here.
const SHELL_BG = { dark: '#17140f', light: '#faf6ee' } // must match --color-surface-base (analog amber)

// How long the player may sit buffering-with-no-progress while disconnected before we
// call it: the buffer starved and we cannot get back in. Long enough that a normal
// network switch reconnects and refills first (the buffer usually covers a fast one
// outright); short enough that a revoke does not leave a frozen player for a minute.
const STARVE_MS = 15000

// The worklet only cares about metered-vs-not: cellular is where it caps the
// bitrate, everything else is treated as free. ETHERNET and WIFI are both 'wifi'
// (unmetered); UNKNOWN falls back to 'wifi' so we never surprise-transcode on wifi
// just because Android was vague about the connection.
function netKind (type?: Network.NetworkStateType): 'wifi' | 'cellular' | 'none' {
  if (type === Network.NetworkStateType.CELLULAR) return 'cellular'
  if (type === Network.NetworkStateType.NONE) return 'none'
  return 'wifi'
}

// WebView resume-freeze recovery (GrapheneOS / Vanadium). See
// /home/tim/peerloomllc/WEBVIEW_FREEZE_FIX_PORT.md; reference impl PearCircle #165.
//
// Android's cached-app freezer cgroup-freezes the WebView's out-of-process Vanadium renderer while
// we are backgrounded. Since the 2026-07-19 Vanadium 151 update, on resume the app gets a NEW
// window surface but the thawed renderer's compositor never re-attaches to it: zero new buffers, a
// frozen screen - while React, JS, taps and haptics all keep working, because they live in the app
// process, which is perfectly healthy. That combination is what makes it read as "the app hung".
//
// Only a FRESH render process recovers it. This REPLACES the #110 remount machinery, which could
// not work: a view-remount rebinds the SAME pooled, stale renderer. We terminate the renderer
// outright (native module, plugins/with-webview-recovery.js) and reload in onRenderProcessGone.
//
// Gated on how long we were away: terminating costs a ~1-2s reload of the UI, so it must not fire
// when someone flicks to another app and straight back. 20s is the reference implementation's
// number and is tunable up if it proves too eager in daily use.
const WEBVIEW_RECOVERY_MIN_BG_MS = 20_000
let _backgroundedAt = 0
// Absent on iOS and on any build made before the native module existed - every call site guards.
const { WebViewRecovery } = NativeModules

export default function App () {
  const insets = useSafeAreaInsets()
  const webRef = useRef<WebView>(null)
  const workletRef = useRef<any>(null)
  const ipcRef = useRef<any>(null)
  const pending = useRef<Map<number, Pending>>(new Map())
  const nextId = useRef(1)
  const player = useRef<AudioPlayer | null>(null)
  const queueRef = useRef<any[]>([])
  const indexRef = useRef(0)
  // The resolved source URLs, index-aligned with queueRef. Kept PRISTINE (never a ?t=
  // variant), so a seek-swap always builds from clean sources and going back to a track
  // starts it from its beginning. (proposal 2026-08-16-seekable-transcodes, slice 2)
  const urlsRef = useRef<string[]>([])
  // Where the current item's TRANSCODED source starts. A transcode requested with
  // ?t=<ms> begins mid-song, but the player counts its own bytes from zero - every
  // position this file reports or persists is base + player position. 0 for direct
  // play and for any track entered normally, so nothing changes on the old paths.
  const baseOffsetMs = useRef(0)
  const seekSwap = useRef<{ busy: boolean, pending: number | null }>({ busy: false, pending: null })
  // One retry per death of a transcoded source (decideRecover). Reset by forward
  // progress or a track change, spent by a recovery attempt.
  const recoverRef = useRef({ tries: 0 })
  // Recovery's OWN stall clock, always armed (dropped:true). The real starve watchdog
  // only watches while the link is down - but a broken transcoded stream can sit
  // buffering forever under a link that flapped straight back up (seen on the
  // emulator: stream socket dies, link reconnects in under a second, player buffers
  // at a frozen position indefinitely). Recovery must not depend on the link's mood.
  const recoverStall = useRef({ pos: -1, at: 0 })
  const heartbeat = useRef<any>(null) // the watchdog's own clock; see ensurePlayer
  // Whether setActiveForLockScreen has built the session for the CURRENT player.
  // announce() goes metadata-only while true; cleared wherever the controls are.
  const lockScreenActive = useRef(false)
  // Mirrored so the persisted queue snapshot can carry them (ExoPlayer owns the
  // live modes; we only need the last-set values for restore).
  const shuffleRef = useRef(false)
  const repeatRef = useRef(0)
  const posRef = useRef(0) // last known position (ms), from the status listener
  const lastPersist = useRef(0) // throttle disk writes from the frequent status listener
  const wasPlaying = useRef(false) // playing-edge detection, to claim the session-handoff token
  // Sleep timer. It lives HERE, in the native shell, not in the WebView: the whole
  // point is the screen is off while you drift off, and a WebView JS timer gets
  // throttled or frozen when the app is backgrounded. The foreground-service audio
  // keeps this process (and its setTimeout) alive. sleepDeadline is epoch-ms for the
  // UI's countdown; sleepEndOfTrack arms the "stop when this song finishes" mode.
  const sleepTimeout = useRef<any>(null)
  const sleepFade = useRef<any>(null)
  const sleepDeadline = useRef(0)
  const sleepMinutes = useRef(0) // the chosen duration, so the UI can highlight it
  const sleepEndOfTrack = useRef(false)
  // Set by next/prev/playIndex so the status listener can tell a user skip from a
  // track ending on its own - only the latter should trip end-of-track sleep.
  const manualNav = useRef(false)
  // CAST MODE (proposal 2026-08-02). A Home Assistant speaker is the output, so this
  // player is the BRAIN but not the voice: it still owns the queue, the shuffle order,
  // the repeat mode and what "next" means, and every track change still announces itself
  // to the UI - which forwards it to the speaker. It just makes no sound while muted and
  // held paused. Nothing here re-hands the playlist, so gapless and the shuffle order
  // survive a round trip through casting (the reason setShuffle delegates to ExoPlayer
  // in the first place - see its comment).
  const castMode = useRef(false)
  // Which speaker the cast is on, and whether we believe it is paused. The shell needs
  // both to answer a lock-screen press, and it cannot ask the UI - the WebView may be
  // asleep or gone while the lock screen is very much awake.
  const castEntity = useRef<string | null>(null)
  const castSpeakerPaused = useRef(false)
  // A pending queue swap after a LIBRARY SWITCH while a track is playing (multi-host). Holds
  // the NEW library's saved queue snapshot; the current track is left to play out (drain),
  // and when it ends we load + play this snapshot. Null when not draining. While set,
  // persistence is suppressed so the new library's queue.json is not clobbered by the
  // transient collapsed-to-one-foreign-track state.
  const switchDrain = useRef<any>(null)
  const netSub = useRef<{ remove: () => void } | null>(null)
  // Are we currently disconnected from the host? On a drop we do NOT tear the
  // player down (a network switch and a revoke look identical here) - we keep the
  // buffer playing and let the RECONNECT result decide: a switch reconnects and
  // playback rides through; a revoke is denied and the buffer starves.
  const dropped = useRef(false)
  // Progress watchdog for the starvation case: { pos, at }. If we are dropped and
  // buffering with pos frozen past STARVE_MS, the buffer has run dry.
  const starve = useRef({ pos: -1, at: 0 })
  // Same watchdog shape, for a switch-drain: the foreign track can't refill past its buffer
  // (the new host doesn't have it), so a dry buffer means "end the drain, bring up the new
  // library" rather than freeze.
  const drainStall = useRef({ pos: -1, at: 0 })
  const [uiHtml, setUiHtml] = useState<string | null>(null)
  // Set only when the boot sequence threw. There is no WebView in that case, so this is the
  // one message the app is still able to show.
  const [bootError, setBootError] = useState<string | null>(null)
  const [scheme, setScheme] = useState<'light' | 'dark'>('dark')
  // Whether the UI has a screen or overlay to pop. Suite convention
  // (shell:navState): when it is false we let the press fall through and Android
  // closes the app, which is what a user at the root of an app expects.
  const canBack = useRef(false)

  // --- worklet IPC ---------------------------------------------------------

  const call = (method: string, args: any = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId.current++
      pending.current.set(id, { resolve, reject })
      ipcRef.current?.write(b4a.from(JSON.stringify({ id, method, args }) + '\n'))
    })

  const toWeb = (name: string, data: any) => {
    webRef.current?.injectJavaScript(
      `window.__pearEvent(${JSON.stringify(name)}, ${JSON.stringify(data)}); true;`
    )
  }

  // --- deep links -----------------------------------------------------------
  //
  // `pear://peartune/pair?v=1&rv=...&host=...`, the link under the pairing QR. The
  // intentFilter in app.json delivers the intent and the iOS scheme delivers the URL;
  // what did NOT work was everything after that, because this app is ONE expo-router
  // route (`app/index.tsx`) and the router had no match for host `peartune` + path
  // `/pair`. So every pear:// link - warm OR cold-started - landed on expo-router's
  // "Unmatched Route" screen with the URL printed on it (Tim, 2026-07-26).
  //
  // The router is not the right place to fix it: there is no screen to route TO. The
  // whole app is a WebView, so the URL is DATA for the UI, not navigation. Read it
  // here, park it, and let the UI take it. `app/+not-found.tsx` covers the other half
  // by redirecting anything unmatched back to index, so a stray link can no longer
  // strand the app on a debug screen.
  // Only PearTune's own pairing links. Another app's pear:// URL (the suite shares the
  // scheme) must not be shoved into the pairing flow, and the parser the UI uses is
  // deliberately strict, so filter here rather than hand it a URL it will only reject.
  const isPairLink = (u: any) => typeof u === 'string' && u.startsWith('pear://peartune/pair')
  useEffect(() => {
    let cancelled = false
    // The COLD START case. getInitialURL resolves the URL the app was launched with;
    // the UI asks for it on mount, which may be before or after this settles - either
    // order works, because the UI also re-asks on the link:pending nudge below.
    // One line per link TAKEN (never per launch), because "did the intent even arrive?" is the
    // first question any report about this will raise, and it is the one thing not visible from
    // the UI side. It is also how the three delivery modes were told apart while testing.
    const take = (url: string, how: string) => {
      // rv fingerprint, so a stash and a collect can be matched up in a log. Cheap, and it is
      // what turned "the link does nothing" from a guess into a measurement.
      console.warn('[link] stash via ' + how + ' rv=' + String(url).slice(-8))
      pendingPairLink = url
      toWeb('link:pending', {})
    }
    Linking.getInitialURL()
      .then((u) => { if (!cancelled && isPairLink(u)) take(u as string, 'launch') })
      .catch(() => {})
    // The WARM case: a link tapped while the app is already open.
    const sub = Linking.addEventListener('url', ({ url }) => {
      if (isPairLink(url)) take(url, 'event')
    })
    return () => { cancelled = true; sub.remove() }
  }, [])

  // --- audio ---------------------------------------------------------------

  // --- the queue ------------------------------------------------------------
  //
  // Tapping a track plays THAT track and queues the rest of the album behind it,
  // which is what people mean when they tap a track. One AudioPlayer is reused
  // across tracks via replace(): tearing it down and rebuilding it per track
  // would drop the MediaSession, and the lock-screen controls would flicker away
  // between songs.

  const SEEK_STEP = 15 // seconds, matching the lock-screen rewind/FF buttons

  // GAPLESS. The queue lives inside ExoPlayer, not here.
  //
  // The obvious design - keep the queue in JS and swap the source on
  // didJustFinish - CANNOT be gapless: by the time that event fires, playback has
  // already stopped, and only then do we fetch a URL, prepare and buffer.
  //
  // So we hand ExoPlayer the whole playlist up front (setQueueSources, added by
  // patches/expo-audio+1.1.1.patch). It then decodes ahead across the boundary
  // and honours MP3 encoder delay/padding, which is what gapless actually means.
  // It also pre-fetches the NEXT track's bytes over P2P before the current one
  // ends, which is what makes the seam silent rather than merely short.
  //
  // The same patch stops expo-audio stripping the next/previous commands from the
  // MediaSession, so the lock screen now gets real track buttons too.

  async function ensurePlayer (urls: string[], startIndex: number) {
    // shouldPlayInBackground + FOREGROUND_SERVICE_MEDIA_PLAYBACK keep audio alive
    // once the screen goes off. interruptionMode 'doNotMix' is what makes Android
    // associate the lock-screen controls with US: without it the OS may not hand
    // this player the session at all.
    await setAudioModeAsync({
      shouldPlayInBackground: true,
      playsInSilentMode: true,
      interruptionMode: 'doNotMix'
    })

    let p: any = player.current
    if (!p) {
      p = createAudioPlayer({ uri: urls[startIndex] })
      player.current = p

      const onStatus = (s: any) => {
        // A STRAY PLAY WHILE CASTING, and this is the one that bites hardest.
        //
        // The lock screen and headset buttons reach ExoPlayer through its MediaSession,
        // NOT through our toggle() - so the guard there never saw them. Measured on the
        // TCL 2026-08-02: pressing play during a cast raced the queue at roughly a track
        // every few seconds (each slot is one second of silence) and then killed the
        // player outright. It destroyed the cast rather than doing nothing.
        //
        // So catch it here, where every play arrives whatever pressed it: pause again at
        // once, and treat the press as what the person meant - pause or resume THE
        // SPEAKER, alternating, since one button is all the lock screen gives them.
        if (castMode.current && p.playing) {
          try { p.pause() } catch {}
          const entityId = castEntity.current
          if (entityId) {
            const paused = !castSpeakerPaused.current
            castSpeakerPaused.current = paused
            call(paused ? 'speakerPause' : 'speakerResume', { entityId }).catch(() => {})
          }
          return
        }

        // ExoPlayer owns the queue now, so IT decides when we crossed into the
        // next track. Trust its index rather than counting didJustFinish events.
        const i = p.currentQueueIndex ?? indexRef.current
        if (i !== indexRef.current) {
          const natural = !manualNav.current
          manualNav.current = false
          indexRef.current = i
          // A new item plays its own source from ITS zero - only a seek-swap sets this.
          baseOffsetMs.current = 0
          recoverRef.current.tries = 0
          recoverStall.current = { pos: -1, at: 0 }
          announce(i)
          persistQueue(true) // a track advanced - save the new index right away

          // AND SEND IT TO THE SPEAKER FROM HERE (proposal 2026-08-02-cast-control-lives-
          // in-the-shell). This used to be the UI's job, off the back of play:started - but
          // Android freezes the WebView with the screen, so a lock-screen next queued up and
          // only fired when the app was reopened. Tim saw exactly that. Every other link in
          // this chain already runs in the shell; this was the one that did not.
          if (castMode.current && castEntity.current) {
            const t = queueRef.current[i]
            if (t) {
              castSpeakerPaused.current = false
              call('speakerPlay', { entityId: castEntity.current, trackId: t.id }).catch(() => {})
            }
          }

          // Sleep timer, end-of-track mode: the previous song finished ON ITS OWN
          // (not a user skip), so pause at the top of this next track - the natural
          // "stop after the song ends". The index is the trustworthy signal here
          // (see above); didJustFinish is only reliable at the very end of the queue,
          // where stop() below ends things and clears the timer anyway.
          if (sleepEndOfTrack.current && natural) {
            sleepEndOfTrack.current = false
            try { p.pause() } catch {}
            persistQueue(true)
            pushSleep(true)
          }
        }

        // STARVATION. A drop is not a stop, so we kept the buffer playing - but a
        // revoked device whose buffer runs dry (or a player that errors out to idle
        // waiting for bytes it cannot get) must end cleanly, not freeze. decideStarve
        // owns that call and is unit-tested per branch (app/starve.js, test/starve).
        // Absolute position in the SONG, not in the source: a seek-swapped transcode's
        // bytes start mid-track, so the player's own clock is offset by the swap target.
        const posMs = baseOffsetMs.current + Math.round((s.currentTime ?? 0) * 1000)

        // Real forward progress re-arms the recovery budget: a stream that limps but
        // moves gets one fresh retry per stall, not one per lifetime.
        if (s.playing && posMs !== posRef.current) recoverRef.current.tries = 0



        // Switch-drain: if the buffered foreign track runs dry (new host can't serve it), don't
        // hang on "buffering" - reuse decideStarve (dropped:true forces its idle/stall timing)
        // to detect the dry buffer, then advance into the new library instead of freezing.
        if (switchDrain.current) {
          const ds = decideStarve({
            dropped: true,
            playbackState: s.playbackState,
            isBuffering: !!s.isBuffering,
            positionMs: posMs,
            now: Date.now(),
            starve: drainStall.current,
            graceMs: STARVE_MS
          })
          drainStall.current = ds.starve
          if (ds.starved) { drainStall.current = { pos: -1, at: 0 }; finishDrain(); return }
        }

        const d = decideStarve({
          dropped: dropped.current,
          playbackState: s.playbackState,
          isBuffering: !!s.isBuffering,
          positionMs: posMs,
          now: Date.now(),
          starve: starve.current,
          graceMs: STARVE_MS
        })
        starve.current = d.starve

        // TRANSCODE RECOVERY (proposal 2026-08-16, slice 3). Two ways a broken
        // transcoded source ends the music, and both land here: the player erroring
        // out to idle (it cannot range-resume a stream with no ranges), or the starve
        // watchdog firing on a stalled buffer. Before ending playback, re-enter the
        // stream ONCE at the last known absolute position via the same seek-swap a
        // scrub uses. seekTo answers false for direct play - those sources
        // range-resume on their own, so a death there really is terminal - and the
        // budget-spent path falls through to exactly the old behaviour. A REVOKED
        // device's retry is a fresh stream request the host's gate denies, so its
        // second death arrives with tries spent and playback ends as the acceptance
        // test demands.
        const rs = decideStarve({
          // Recovery's clock runs regardless of LINK state (see recoverStall) - but not on a
          // player that is not meant to be playing. `playing` is false while buffering too,
          // so the gate is ExoPlayer's playWhenReady (exposed by our expo-audio patch): a
          // Bluetooth car pausing us mid-buffer left isBuffering true at a frozen position,
          // and 15 s later this clock called it a stall and pressed play - on the phone's
          // speaker (Tim, 2026-08-29). Undefined (iOS, older status) keeps the old behaviour.
          dropped: s.playWhenReady !== false,
          playbackState: s.playbackState,
          isBuffering: !!s.isBuffering,
          positionMs: posMs,
          now: Date.now(),
          starve: recoverStall.current,
          graceMs: STARVE_MS
        })
        recoverStall.current = rs.starve
        const deadCause = rs.starved ? (rs.reason === 'idle' ? 'idle' : 'starve')
          : (s.playbackState === 'idle' || s.playbackState === 'error') ? s.playbackState : null
        if (deadCause && !seekSwap.current.busy && decideRecover({
          cause: deadCause,
          tries: recoverRef.current.tries,
          hasQueue: queueRef.current.length > 0,
          casting: !!castMode.current
        })) {
          recoverRef.current.tries++
          // The retry re-enters at the SAME frozen position, so give it a fresh grace
          // window - otherwise this clock refires instantly on the unchanged number.
          recoverStall.current = { pos: -1, at: Date.now() }
          const resumeAt = posRef.current
          console.log('[recover] cause=' + deadCause + ' at=' + resumeAt + ' try=' + recoverRef.current.tries)
          ;(async () => {
            const swapped = await seekTo(resumeAt)
            console.log('[recover] swapped=' + swapped)
            if (!swapped) recoverRef.current.tries = 99 // direct play: no loop, the old rules stand
          })()
          return
        }
        if (d.starved) { onStarved(d.reason); return }

        // The playlist ran out. Normally that is a stop() - but if we're DRAINING the last
        // track of the old library after a switch, this "end" is the cue to bring up the new
        // library's queue instead (unless a sleep-end-of-track is armed, which wins - stop).
        // On Android didJustFinish is ExoPlayer's STATE_ENDED: the WHOLE playlist ran out, in
        // shuffle order too. The media-index test is for platforms whose finish fires per item
        // - and it is wrong under shuffle both ways (the last-played index is random), which
        // is why it only guards the non-Android side now that shuffle actually reaches the
        // player (see play()).
        const playlistEnded = Platform.OS === 'android'
          ? s.didJustFinish
          : (s.didJustFinish && indexRef.current >= queueRef.current.length - 1)
        if (playlistEnded) {
          if (switchDrain.current && !sleepEndOfTrack.current) { finishDrain() } else { stop() }
        }

        toWeb('play:status', {
          playing: !!s.playing,
          positionMs: posMs,
          // A seek-swapped source only holds the REMAINDER of the song, so its own
          // duration would read short - the UI's metadata fallback is the honest one.
          durationMs: baseOffsetMs.current ? null : (s.duration ? Math.round(s.duration * 1000) : null),
          buffering: !!s.isBuffering,
          index: indexRef.current,
          queueLength: queueRef.current.length
        })

        // Session handoff: whenever playback transitions INTO playing, make sure we hold the
        // "active player" token. One place covers every path (play / resume / jump / next);
        // the worklet claim is idempotent, so re-firing is free.
        if (s.playing && !wasPlaying.current) activateSession()
        // ...and whenever it transitions OUT of playing, flush that fact NOW. toggle() already
        // does this for the in-app button, but a pause from the LOCK SCREEN, the notification, a
        // headset button, a car or any other media-session route never passes through it - and the
        // status poll goes silent the instant playback stops, so the throttled persist below never
        // runs again. The last thing pushed stays "playing: true" (Tim, 2026-07-28: paused 25s,
        // both hosts still said playing). Catching the edge here covers every route at once,
        // because they all end up in this listener.
        else if (!s.playing && wasPlaying.current) persistQueue(true)
        wasPlaying.current = !!s.playing

        posRef.current = posMs
        persistQueue() // throttled: keeps the saved position roughly current
      }
      p.addListener('playbackStatusUpdate', onStatus)

      // HEARTBEAT. expo-audio's status events go SILENT while the player sits
      // buffering - measured on the emulator: one burst at load, then nothing for a
      // minute while a broken transcoded stream buffered at a frozen position. That
      // blinds every event-driven watchdog at exactly the moment it exists for, so
      // stall detection gets its own clock: poll the same handler with the player's
      // imperative status. 5s is coarse enough to cost nothing and fine enough that
      // the 15s starve grace still means roughly fifteen seconds.
      if (!heartbeat.current) {
        heartbeat.current = setInterval(() => {
          const cur: any = player.current
          if (!cur) return
          try { onStatus(cur.currentStatus) } catch {}
        }, 5000)
      }
    }

    p.setQueueSources(urls.map((uri: string) => ({ uri })))
    urlsRef.current = urls.slice()
    baseOffsetMs.current = 0
    p.seekToQueueIndex(startIndex)
    return p
  }

  // Tell the UI and the lock screen which track is playing. Called on every
  // playlist transition, including ExoPlayer's own gapless advance.
  function announce (i: number) {
    const t = queueRef.current[i]
    if (!t) return

    const meta = {
      title: t.title,
      artist: t.artist ?? undefined,
      albumTitle: t.album ?? undefined,
      artworkUrl: t.art ?? undefined
    }
    // FIRST activation builds the MediaSession + foreground notification. Every LATER
    // track change is METADATA-ONLY: setActiveForLockScreen releases the whole session
    // and re-posts the foreground notification, and doing that from the BACKGROUND
    // trips Android's foreground-service-start restriction - the audio OUTPUT dies
    // while the player keeps decoding. Tim heard exactly that on the Pixel
    // (2026-08-16): next song silent after a couple of seconds, clock still
    // advancing, sound back the moment the app foregrounds. updateLockScreenMetadata
    // touches neither the session nor the service, so a background transition keeps
    // its sound.
    if (lockScreenActive.current) {
      try { (player.current as any)?.updateLockScreenMetadata(meta) } catch {}
    } else {
      player.current?.setActiveForLockScreen(true, meta, { showSeekForward: true, showSeekBackward: true })
      lockScreenActive.current = true
    }

    announceToUi(i)
  }

  // The UI half of announce, on its own - for the case where the WEBVIEW lost its
  // state but playback did not (see restoreQueue). The lock screen is untouched there
  // on purpose: setActiveForLockScreen tears the MediaSession down and rebuilds it,
  // and doing that mid-playback risks the audio focus with it (the same hazard the
  // playIndex comment documents). The notification is already correct anyway - it is
  // the phone's WebView that was killed, not the player.
  function announceToUi (i: number) {
    const t = queueRef.current[i]
    if (!t) return

    toWeb('play:started', {
      trackId: t.id,
      title: t.title,
      artist: t.artist ?? null,
      album: t.album ?? null,
      art: t.art ?? null,
      // The big cover, for the UI's full-screen art viewer. The lock screen above
      // deliberately keeps the small one - it is a notification, not a gallery.
      artFull: t.artFull ?? null,
      // The library's own length. The player only learns a TRANSCODED stream's
      // duration once the whole thing has downloaded (no content-length), so off-LAN
      // the UI showed --:-- until near the end of the song. status.durationMs still
      // wins once the player actually knows; this is the fallback that makes the
      // number appear immediately (Tim, off-LAN, 2026-08-16).
      durationMs: t.durationMs ?? null,
      index: i,
      queueLength: queueRef.current.length
    })
  }

  // Push the CURRENT transport state to the UI without waiting for the next status tick.
  // Needed because a PAUSED player emits none at all: a UI that just reloaded would show
  // the right track with a dead progress bar and a play/pause button set to whatever it
  // guessed. Same shape the playbackStatusUpdate listener sends.
  function pushStatus () {
    const p: any = player.current
    if (!p) return
    toWeb('play:status', {
      playing: !!p.playing,
      positionMs: baseOffsetMs.current + Math.round((p.currentTime ?? 0) * 1000),
      durationMs: baseOffsetMs.current ? null : (p.duration ? Math.round(p.duration * 1000) : null),
      buffering: !!p.isBuffering,
      index: indexRef.current,
      queueLength: queueRef.current.length
    })
  }

  // Tell the worklet this device is now the active session player (handoff). Fire-and-forget:
  // the claim rides P2P and playback must not wait on it; the worklet call is idempotent.
  const activateSession = () => { call('sessionActivate').catch(() => {}) }

  // Another device took over the session (we pushed our queue and the host said ok:false - the
  // token moved). Stop cleanly here: the queue now lives on the host session (owned by the new
  // device), so we don't keep a redundant paused mini-player of a track that's playing
  // elsewhere - the UI shows the "Playing on <other>" card instead, and "Play here" re-adopts
  // the session. stop() also clears our now-stale local queue and deactivates our token.
  function onHandedOff () {
    stop({ forget: true }) // another device owns the session now; our local queue is stale
    toWeb('play:handedoff', {})
  }

  // Snapshot the queue to disk (via the worklet) so a relaunch can restore it. The worklet
  // ALSO mirrors it to the host session when we hold the token, and reports lostSession if we
  // were superseded. Throttled, because the status listener fires several times a second;
  // `force` bypasses it for structural changes (play / enqueue / index advance / mode).
  function persistQueue (force = false) {
    // Mid library-switch drain: the queue is transiently a single foreign track from the OLD
    // library, and queue.json is now the NEW library's. Don't overwrite it with the drain
    // state - finishDrain writes the correct new-library queue once the current track ends.
    if (switchDrain.current) return
    // An EMPTY queue is never worth saving, and saving it is how the queue got lost: after a
    // stop() cleared queueRef, a late status tick persisted `items: []` over the snapshot the
    // stop had deliberately kept (seen on the TCL 2026-08-29: the file survived the stop and
    // was empty a moment later). Discarding is clearQueueState's job, via stop({ forget }).
    if (!queueRef.current.length) return
    const t = Date.now()
    if (!force && t - lastPersist.current < 4000) return
    lastPersist.current = t
    call('saveQueueState', {
      items: queueRef.current,
      index: indexRef.current,
      positionMs: posRef.current,
      shuffle: shuffleRef.current,
      repeat: repeatRef.current,
      // Mirrored to the host session so another device seeks to the right spot and its card
      // reads "Playing"/"Paused on <name>" honestly. Read live from the player so a forced
      // snapshot right after pause()/play() carries the state it just changed to.
      playing: !!player.current?.playing
    }).then((r: any) => { if (r?.lostSession) onHandedOff() }).catch(() => {})
  }

  async function play ({ queue, index = 0 }: any) {
    switchDrain.current = null // an explicit play cancels a pending switch-drain
    const q = Array.isArray(queue) ? queue : []
    queueRef.current = q
    indexRef.current = index
    if (!q.length) return stop({ forget: true }) // an explicit empty play IS a discard

    try {
      // Resolve every track's loopback URL up front. ExoPlayer needs the whole
      // playlist to be able to decode ahead across a track boundary.
      const urls: string[] = []
      for (const t of q) {
        const { url }: any = await call('urlFor', { trackId: t.id })
        urls.push(url)
      }

      const p = await ensurePlayer(urls, index)
      // The UI sends `shuffle` BEFORE `play` (artist -> Shuffle), and setShuffle on a player
      // that does not exist yet is a no-op - so a cold-start shuffle used to play the array
      // IN ORDER from a random index, hit the end a few songs later and stop. Every other
      // path that builds a player re-applies the modes; this one did not (Tim, 2026-08-29).
      px()?.setShuffle(shuffleRef.current)
      px()?.setRepeatMode(repeatRef.current)
      announce(index)
      p.play()
      persistQueue(true)
    } catch (e: any) {
      // A revoked device lands here: the loopback stream broke because the P2P
      // connection under it was destroyed.
      toWeb('play:error', { error: e?.message ?? String(e) })
    }
  }

  // Add to queue: append to what is ALREADY playing, without touching it.
  //
  // The native side is addMediaSources, not setMediaSources (see the expo-audio
  // patch). Re-handing ExoPlayer the whole playlist would reset the current item
  // and restart buffering - the user asked to queue a record for later, not to
  // interrupt the song they are in the middle of.
  async function enqueue ({ queue }: any) {
    switchDrain.current = null // building the queue cancels a pending switch-drain
    const q = Array.isArray(queue) ? queue : []
    if (!q.length) return

    // Nothing is playing, so there is no queue to add to. "Add to queue" and
    // "play" are the same request in that case, and pretending otherwise leaves
    // the user tapping a button that appears to do nothing.
    if (!player.current) return play({ queue: q, index: 0 })

    try {
      const urls: string[] = []
      for (const t of q) {
        const { url }: any = await call('urlFor', { trackId: t.id })
        urls.push(url)
      }
      queueRef.current = [...queueRef.current, ...q]
      urlsRef.current = [...urlsRef.current, ...urls]
      px()?.addQueueSources(urls.map((uri) => ({ uri })))
      persistQueue(true)
      toWeb('play:queued', { count: q.length, queueLength: queueRef.current.length })
    } catch (e: any) {
      toWeb('play:error', { error: e?.message ?? String(e) })
    }
  }

  // Reorder the queue: move the track at `from` to `to`. ExoPlayer's own moveMediaItem
  // (via the patch) keeps the current track playing and preserves gapless; we mirror the
  // move in queueRef and slide indexRef so the now-playing highlight follows the TRACK,
  // not the slot (reindexAfterMove matches what ExoPlayer does to currentMediaItemIndex).
  // Returns the new {items,index} so the UI updates without a round-trip.
  function queueMove ({ from, to }: any) {
    const f = Number(from); const t = Number(to)
    const q = queueRef.current
    if (!Number.isInteger(f) || !Number.isInteger(t) ||
        f < 0 || t < 0 || f >= q.length || t >= q.length || f === t) {
      return { items: q, index: indexRef.current }
    }
    px()?.moveQueueItem(f, t)
    const [moved] = q.splice(f, 1)
    q.splice(t, 0, moved)
    indexRef.current = reindexAfterMove(indexRef.current, f, t)
    persistQueue(true)
    return { items: queueRef.current, index: indexRef.current }
  }

  // Remove one track. Removing the LAST remaining track empties the player - that is a
  // stop(), not a queue edit. Removing the CURRENT track lets ExoPlayer advance to the
  // next (the status tick then resyncs indexRef from currentQueueIndex); we set indexRef
  // optimistically here so the list updates immediately.
  function queueRemove ({ index }: any) {
    const i = Number(index)
    const q = queueRef.current
    if (!Number.isInteger(i) || i < 0 || i >= q.length) {
      return { items: q, index: indexRef.current }
    }
    if (q.length === 1) { stop({ forget: true }); return { items: [], index: 0 } }
    const wasCurrent = i === indexRef.current
    px()?.removeQueueItem(i)
    const len = q.length
    q.splice(i, 1)
    indexRef.current = reindexAfterRemove(indexRef.current, i, len)
    // Removing the CURRENT track: ExoPlayer slides the next one into this slot, so the
    // index is UNCHANGED and the status listener's index-change check never fires -
    // update the now-playing (mini-player + lock screen) to the new track explicitly.
    // (No seek here, so this is the safe kind of announce - unlike playIndex's.)
    if (wasCurrent) announce(indexRef.current)
    persistQueue(true)
    return { items: queueRef.current, index: indexRef.current }
  }

  // "Clear Queue" that KEEPS the current track playing: remove every other item so the
  // queue collapses to just the now-playing track, uninterrupted. We remove from the
  // ends inward (after the current, then before it) so indices stay valid and the
  // current media item is never touched - ExoPlayer keeps playing it, and its index
  // slides to 0. Empty / single-item queues are a no-op.
  function queueClearKeepCurrent () {
    const q = queueRef.current
    const cur = indexRef.current
    if (q.length <= 1) return { items: queueRef.current, index: indexRef.current }
    const keep = q[cur]
    if (!keep) { stop({ forget: true }); return { items: [], index: 0 } }
    for (let i = q.length - 1; i > cur; i--) px()?.removeQueueItem(i)
    for (let i = cur - 1; i >= 0; i--) px()?.removeQueueItem(i)
    queueRef.current = [keep]
    indexRef.current = 0
    persistQueue(true)
    return { items: [keep], index: 0 }
  }

  function toggle () {
    const p = player.current
    if (!p) return
    // While casting, this player is a silent placeholder queue - playing it would race
    // through a track a second and cast each one. The UI routes its own play/pause to the
    // SPEAKER; this guard is for the lock screen and headset buttons, which reach here
    // directly and cannot be intercepted upstream. They do nothing during a cast, which is
    // a known gap rather than a good answer (TODO).
    if (castMode.current) return
    if (p.playing) p.pause()
    else p.play()
    // Flush the new play/pause state (and exact position) to the host session at once. A pause
    // otherwise wouldn't push - the status poll goes silent the instant playback stops - so
    // another device's card would keep saying "Playing on <name>" and a takeover would seek to
    // a stale spot. The forced snapshot reads player.playing, which pause()/play() just set.
    persistQueue(true)
  }

  // --- cast mode (proposal 2026-08-02) --------------------------------------
  //
  // Entering mutes and holds this player paused; leaving unmutes and resumes. The queue
  // is NOT touched, so skipToNext, skipToPrevious, the shuffle order, the repeat mode,
  // queue taps and the lock-screen buttons all keep working - they simply make no sound
  // here, and the UI forwards each resulting play:started to the speaker.
  //
  // Resuming on the way out restarts the CURRENT track rather than seeking into it: the
  // speaker reports no position of its own (the Voice PE has no media_position), so
  // there is no honest place to resume from. Proposal open question 3.
  async function setCastMode (on: boolean, entityId: string | null = null) {
    const p = player.current as any
    castMode.current = !!on
    castEntity.current = on ? entityId : null
    castSpeakerPaused.current = false

    if (on) {
      if (p) {
        try {
          p.volume = 0
          p.pause()
          // AND POINT EVERY QUEUE SLOT AT SILENCE. The player has to stay loaded - it is
          // what owns the order, shuffle and repeat - but a loaded player buffers whatever
          // track it sits on whether or not anyone can hear it. Measured on the TCL
          // 2026-08-02: casting four tracks pulled 7 MB the phone never played, about
          // 1.75 MB a track, which on cellular is close to the cost of just listening.
          //
          // Same length, same indices, so skipToNext/skipToPrevious/the shuffle order are
          // untouched; only the bytes behind each slot change. The real URLs come back on
          // the way out, where the player is rebuilt anyway.
          const n = queueRef.current.length
          if (n) {
            const r: any = await call('silenceUrl')
            const at = indexRef.current
            p.setQueueSources(new Array(n).fill({ uri: r.url }))
            urlsRef.current = new Array(n).fill(r.url)
            baseOffsetMs.current = 0
            p.seekToQueueIndex(at)
            px()?.setShuffle(shuffleRef.current)
            px()?.setRepeatMode(repeatRef.current)
            p.pause() // seekToQueueIndex can resume it; a silent 1s queue must never run
          }
        } catch {}
      }
      persistQueue(true)
      return
    }

    // LEAVING. p.play() is NOT enough, and this cost a hardware round to learn: after a
    // spell muted and paused across several skipToNext calls, the player comes back with
    // `state=NONE` in Android's media session - no playback state at all, not merely
    // paused. play(), toggle() and even playIndex() all failed to revive it, and only an
    // app restart did. So rebuild rather than resume: tear the player down and load the
    // queue onto a fresh one, which is the same path a relaunch takes and is therefore
    // already the well-tested way back.
    const snap = {
      items: queueRef.current,
      index: indexRef.current,
      shuffle: shuffleRef.current,
      repeat: repeatRef.current,
      // Deliberately no positionMs: the speaker reports no position of its own, so the
      // track restarts. Seeking to where the PHONE was paused would be a guess at a
      // place the music has long since passed.
      positionMs: 0
    }
    stopPlayer() // releases and nulls it, so ensurePlayer builds a new one
    if (!snap.items.length) return
    await loadQueueOnPlayer(snap, true)
  }

  // --- sleep timer ---------------------------------------------------------

  // Cancel any armed timer / mid-flight fade and restore full volume (a fade may have
  // left it partway down). Leaves playback exactly as it is.
  function clearSleep () {
    if (sleepTimeout.current) { clearTimeout(sleepTimeout.current); sleepTimeout.current = null }
    if (sleepFade.current) { clearInterval(sleepFade.current); sleepFade.current = null }
    sleepDeadline.current = 0
    sleepMinutes.current = 0
    sleepEndOfTrack.current = false
    // ...but NOT while casting, where 0 is the deliberate volume. Restoring it here would
    // un-mute the phone behind the user's back and put a second copy of the song in the
    // room the moment anything cleared a sleep timer.
    try { if (player.current && !castMode.current) player.current.volume = 1 } catch {}
  }

  // Push the current sleep state so the UI can light the moon and count down. `fired`
  // marks the transition where the timer just stopped playback (so the UI can toast).
  function pushSleep (fired = false) {
    toWeb('sleep:state', {
      active: !!sleepTimeout.current || sleepEndOfTrack.current,
      endOfTrack: sleepEndOfTrack.current,
      deadline: sleepDeadline.current || null,
      minutes: sleepMinutes.current || null,
      fired
    })
  }

  // The timed-mode deadline arrived: ease the volume down over ~5s, then pause. We
  // fade rather than cut so it does not jolt you awake, and restore volume to 1 after
  // so a later manual resume is not silent. Not used for end-of-track (that stops at a
  // real track boundary, where a fade would be pointless).
  function fadeAndPause () {
    sleepTimeout.current = null
    sleepDeadline.current = 0
    const p = player.current
    if (!p) { clearSleep(); pushSleep(true); return }
    let v = 1
    if (sleepFade.current) clearInterval(sleepFade.current)
    sleepFade.current = setInterval(() => {
      v -= 0.1
      try { p.volume = Math.max(0, v) } catch {}
      if (v <= 0) {
        clearInterval(sleepFade.current); sleepFade.current = null
        try { p.pause() } catch {}
        // Same reason as clearSleep: while casting, 0 is deliberate.
        try { if (!castMode.current) p.volume = 1 } catch {}
        persistQueue(true)
        pushSleep(true)
      }
    }, 500)
  }

  // Arm/disarm from the UI. { off } cancels; { endOfTrack } stops when the current song
  // finishes on its own (the status listener watches didJustFinish); { minutes } counts
  // down then fades out. One mode at a time - each call clears the last.
  function setSleep ({ minutes, endOfTrack, off }: any) {
    clearSleep()
    if (off) { pushSleep(); return }
    if (endOfTrack) {
      sleepEndOfTrack.current = true
      pushSleep()
      return
    }
    const mins = Math.max(1, Number(minutes) || 0)
    const ms = mins * 60000
    sleepMinutes.current = mins
    sleepDeadline.current = Date.now() + ms
    sleepTimeout.current = setTimeout(fadeAndPause, ms)
    pushSleep()
  }

  // setQueueSources / skipToNext / skipToPrevious / currentQueueIndex come from
  // patches/expo-audio+1.1.1.patch. We patched the Kotlin, NOT the .d.ts, so
  // TypeScript does not know about them - reach them through a cast rather than
  // patching type files we would then also have to maintain.
  const px = () => player.current as any

  // Delegated to ExoPlayer, so the lock-screen buttons and the in-app buttons go
  // down exactly the same path.
  function next () {
    manualNav.current = true
    px()?.skipToNext()
  }

  // ExoPlayer's seekToPrevious already implements the convention every player
  // uses: restart the current track unless you are near its start, in which case
  // step back one.
  function prev () {
    manualNav.current = true
    px()?.skipToPrevious()
  }

  // ExoPlayer owns the shuffle order, so `next` and the LOCK-SCREEN next button
  // both respect it. Shuffling our own array instead would mean re-handing the
  // playlist to the player, which restarts buffering and breaks gapless.
  function setShuffle (on: boolean) {
    px()?.setShuffle(on)
    shuffleRef.current = on
    persistQueue(true)
    toWeb('play:mode', { shuffle: on })
  }

  // 0 = off, 1 = repeat one, 2 = repeat all.
  function setRepeat (mode: number) {
    px()?.setRepeatMode(mode)
    repeatRef.current = mode
    persistQueue(true)
    toWeb('play:mode', { repeat: mode })
  }

  function seekBy (seconds: number) {
    const p = player.current
    if (!p) return
    // Absolute in the SONG (base + player clock), then through seekTo so a transcoded
    // stream gets the swap treatment instead of ExoPlayer's reset-to-zero.
    seekTo(Math.max(0, baseOffsetMs.current + Math.round(((p.currentTime || 0) + seconds) * 1000)))
  }

  // Direct play seeks like it always has: byte ranges, ExoPlayer does the work. A
  // TRANSCODE cannot - the target's bytes do not exist until ffmpeg makes them - so the
  // worklet answers seekUrl with a ?t=<ms> source that STARTS at the target, and we swap
  // it under the player (proposal 2026-08-16-seekable-transcodes, slice 2). The worklet
  // owns the is-this-a-transcode decision, same as it owns the quality policy; a null
  // url means "seek normally". One swap in flight at a time: a tap that lands mid-swap
  // parks its target and runs after, so a scrub burst coalesces to the last position.
  async function seekTo (ms: number) {
    const p = player.current
    if (!p) return
    const target = Math.max(0, Math.round(ms))
    if (seekSwap.current.busy) { seekSwap.current.pending = target; return }
    const t = queueRef.current[indexRef.current]
    if (t) {
      seekSwap.current.busy = true
      try {
        const r: any = await call('seekUrl', { trackId: t.id, positionMs: target })
        if (r?.url) {
          const at = indexRef.current
          const urls = urlsRef.current.slice()
          urls[at] = r.url
          // Base FIRST: the rebuild emits statuses immediately, and they must already
          // read as base + 0, not as a jump back to zero.
          baseOffsetMs.current = target
          px()?.setQueueSources(urls.map((uri: string) => ({ uri })))
          px()?.seekToQueueIndex(at)
          p.play()
          return true
        }
      } catch {
        // seekUrl unreachable (offline, worklet mid-restart): fall through and seek
        // the source we have - for direct play that is correct, for a transcode it is
        // today's reset-to-zero, never worse.
      } finally {
        seekSwap.current.busy = false
        const next = seekSwap.current.pending
        seekSwap.current.pending = null
        if (next !== null && next !== target) seekTo(next)
      }
    }
    baseOffsetMs.current = 0
    p.seekTo(Math.max(0, target / 1000))
    return false
  }

  function stopPlayer () {
    if (heartbeat.current) { clearInterval(heartbeat.current); heartbeat.current = null }
    if (!player.current) return
    try {
      player.current.clearLockScreenControls()
      lockScreenActive.current = false
      player.current.pause()
      player.current.remove()
    } catch {}
    player.current = null
  }

  // A network drop. Keep the player and the queue; try to get back in. On a switch
  // the reconnect succeeds and the buffer covers the gap. On a revoke it is denied -
  // and we do NOT stop here: the current track plays out whatever ExoPlayer already
  // buffered, and the player starving (below) is what finally ends it. The shim also
  // reconnects on demand for the request that broke mid-stream, so this proactive
  // call is just to get a switch back faster.
  async function onHostDropped () {
    if (dropped.current) return
    dropped.current = true
    try {
      await call('reconnect')
      dropped.current = false
    } catch {
      // Denied (revoke) or host unreachable. Leave the buffer playing.
    }
  }

  // The buffer starved while disconnected and we could not reconnect - a revoke, or a
  // network hole we did not climb out of in time. Stop, and tell the UI it was a lost
  // connection (NOT necessarily a revoke: from here a revoke and a tunnel look the
  // same, and only a denied reconnect - which the worklet reports separately - would
  // justify saying "revoked"). DECISIONS 2026-07-14.
  function onStarved (reason?: string) {
    console.warn('[peartune] playback lost while off the wire, reason:', reason || 'unknown')
    toWeb('play:lost', {})
    stop()
  }

  // STOP DOES NOT FORGET THE QUEUE unless the caller says so. Until 2026-08-29 every stop()
  // deleted queue.json, and two of the callers are things the user never asked for: the
  // starve path (the link dropped behind a locked screen and the NEXT track could not load)
  // and the end-of-playlist check (which shuffle could trip a few songs in - see play()).
  // Tim's repro: artist -> Shuffle on Jellyfin, screen off, pause, resume, and when the song
  // ended the queue was gone for good, with the routine screen-on reload hiding the toast.
  // Now the snapshot stays on disk, and the next `restore` (UI mount, or host:connected)
  // brings it back paused where it was. Only a deliberate discard passes { forget: true }:
  // unpairing, emptying the queue by hand, or another device taking the session.
  function stop ({ forget = false }: { forget?: boolean } = {}) {
    switchDrain.current = null // a stop cancels any pending switch-drain
    clearSleep() // no queue to fall asleep to
    stopPlayer()
    queueRef.current = []
    indexRef.current = 0
    posRef.current = 0
    wasPlaying.current = false
    if (forget) call('clearQueueState').catch(() => {})
    call('sessionDeactivate').catch(() => {}) // stop pushing; the host session persists as last-known
    toWeb('play:stopped', {})
  }

  // The player's X: stop PLAYBACK but KEEP the queue (unlike stop(), which wipes it).
  // The ExoPlayer instance stays alive and PAUSED - so tapping a track in the Queue tab
  // resumes via playIndex, which needs a live player - and we just hide the now-playing
  // bar (play:stopped) and clear the lock-screen session. The persisted queue is left
  // intact, so it also survives a relaunch.
  function stopKeepQueue () {
    const p = player.current
    if (p) {
      try { p.pause(); p.clearLockScreenControls() } catch {}
      lockScreenActive.current = false
    }
    posRef.current = 0
    toWeb('play:stopped', {})
  }

  // Restore the saved queue on launch, PAUSED, seeked to where you were - the strong
  // "continue where you left off" (the whole session, which is why it earns a media
  // notification, unlike a single track). It is the play() flow MINUS p.play(), plus a
  // seek and re-applied shuffle/repeat. URLs are re-resolved from IDs because the shim
  // port changes each launch. No-op if something is already playing, or if offline and
  // a track's URL cannot be resolved.
  // Called by the UI on every mount. Two different situations arrive here:
  //
  // 1. A COLD START - no player. Rebuild the last session's queue, paused.
  // 2. A LIVE PLAYER and a fresh UI. That is a WEBVIEW RELOAD, not a cold start: the
  //    renderer was killed and recreated (GrapheneOS/Vanadium does this on resume, and
  //    our own recovery does it deliberately after 20s backgrounded - see #134). The
  //    shell kept playing the whole time; only the WebView lost its state.
  //
  // Case 2 used to return `{ restored: false }` and stop, which was true of the QUEUE and
  // wrong for the user: the UI, having heard no play:started, showed no player at all
  // while the music kept playing, and offered "Continue listening" for the very track it
  // was already playing. So re-announce to the UI instead. The lock screen and the player
  // are deliberately not touched - nothing is wrong with them.
  async function restoreQueue () {
    if (player.current) {
      announceToUi(indexRef.current)
      toWeb('play:mode', { shuffle: shuffleRef.current, repeat: repeatRef.current })
      pushStatus()
      return { restored: true, live: true, index: indexRef.current, queueLength: queueRef.current.length }
    }
    let saved: any
    try {
      saved = await call('loadQueueState')
    } catch { return { restored: false } }
    const q = Array.isArray(saved?.items) ? saved.items : []
    if (!q.length) return { restored: false }

    try {
      const index = Math.min(Math.max(0, Number(saved.index) || 0), q.length - 1)
      const urls: string[] = []
      let port: number | null = null
      for (const t of q) {
        const r: any = await call('urlFor', { trackId: t.id })
        urls.push(r.url)
        if (r.port) port = r.port
      }
      if (player.current) return { restored: false } // a play() raced us while resolving

      // The persisted art URLs carry the OLD shim port (it changes each launch), so
      // rewrite them to the current one - otherwise the mini-player + lock-screen art
      // 404 on the dead port.
      if (port) {
        const fix = (u: any) => (typeof u === 'string' ? u.replace(/(127\.0\.0\.1:)\d+/, `$1${port}`) : u)
        for (const t of q) { t.art = fix(t.art); t.artFull = fix(t.artFull) }
      }

      queueRef.current = q
      indexRef.current = index
      shuffleRef.current = !!saved.shuffle
      repeatRef.current = Number(saved.repeat) || 0

      const p = await ensurePlayer(urls, index)
      px()?.setShuffle(shuffleRef.current)
      px()?.setRepeatMode(repeatRef.current)
      announce(index) // shows the now-playing (paused) + the lock-screen session
      if (saved.positionMs) p.seekTo(Math.max(0, saved.positionMs / 1000))
      toWeb('play:mode', { shuffle: shuffleRef.current, repeat: repeatRef.current })
      // Deliberately NO p.play() - it comes up paused.
      return { restored: true, index, queueLength: q.length }
    } catch {
      return { restored: false }
    }
  }

  // Build the ACTIVE library's saved queue onto the player - like restoreQueue but WITHOUT the
  // "don't clobber active playback" guard, so it can REPLACE a queue on a library switch.
  // `play` controls whether it comes up playing (a drain finishing) or paused (a switch while
  // idle). Reuses the live player via ensurePlayer, so the swap is in-place.
  async function loadQueueOnPlayer (saved: any, play: boolean) {
    const q = Array.isArray(saved?.items) ? saved.items : []
    if (!q.length) return { ok: false }
    try {
      const index = Math.min(Math.max(0, Number(saved.index) || 0), q.length - 1)
      const urls: string[] = []
      let port: number | null = null
      for (const t of q) {
        const r: any = await call('urlFor', { trackId: t.id })
        urls.push(r.url)
        if (r.port) port = r.port
      }
      if (port) {
        const fix = (u: any) => (typeof u === 'string' ? u.replace(/(127\.0\.0\.1:)\d+/, `$1${port}`) : u)
        for (const t of q) { t.art = fix(t.art); t.artFull = fix(t.artFull) }
      }
      queueRef.current = q
      indexRef.current = index
      shuffleRef.current = !!saved.shuffle
      repeatRef.current = Number(saved.repeat) || 0
      const p = await ensurePlayer(urls, index)
      px()?.setShuffle(shuffleRef.current)
      px()?.setRepeatMode(repeatRef.current)
      announce(index)
      if (saved.positionMs) p.seekTo(Math.max(0, saved.positionMs / 1000))
      toWeb('play:mode', { shuffle: shuffleRef.current, repeat: repeatRef.current })
      if (play) p.play()
      persistQueue(true)
      return { ok: true }
    } catch {
      return { ok: false }
    }
  }

  // The current (old-library) track finished draining after a switch: bring up the new
  // library's queue and keep the music going. Clearing the flag FIRST re-enables persistence
  // so loadQueueOnPlayer's write lands. Nothing to advance into -> stop cleanly.
  async function finishDrain () {
    const snap = switchDrain.current
    switchDrain.current = null
    if (!snap || !Array.isArray(snap.items) || !snap.items.length) { stop({ forget: true }); return }
    const r = await loadQueueOnPlayer(snap, true) // the user was listening - come up playing
    if (!r.ok) stop()
  }

  // A library switch happened (multi-host). queue.json is already the NEW library's (the
  // worklet re-points it before host:switched). If a track is PLAYING, keep it playing and let
  // it DRAIN: collapse the queue to just that track so no old-library "next" plays, and hold
  // the new library's queue for when it ends (finishDrain). If nothing is playing, there is no
  // music to protect - swap straight to the new library's queue, paused.
  async function switchQueue () {
    let saved: any
    try { saved = await call('loadQueueState') } catch { saved = null }

    if (player.current?.playing) {
      switchDrain.current = saved || { items: [] } // suppresses persistQueue until it drains
      if (queueRef.current.length > 1) queueClearKeepCurrent()
      return { draining: true }
    }

    switchDrain.current = null
    const nq = Array.isArray(saved?.items) ? saved.items : []
    if (nq.length) { await loadQueueOnPlayer(saved, false); return { swapped: true } }
    // New library has no saved queue: drop any stale paused queue so the mini-player doesn't
    // keep showing an old-library track. (queue.json for the new library is already empty.)
    if (player.current) stop()
    return { swapped: false }
  }

  // Re-open the CURRENT track from whichever library can still serve it, at the position we had
  // reached. Used only when a splice was impossible (see play:rehost above) - so it is the rare,
  // audible path, not the common one. Position first, because rebuilding the sources resets it.
  async function rehostCurrent () {
    const q = queueRef.current
    const index = indexRef.current
    if (!Array.isArray(q) || !q.length) return
    const p = px()
    const positionMs = Math.max(0, baseOffsetMs.current + Math.round((p?.currentTime ?? 0) * 1000))
    const wasPlaying = !!p?.playing
    try {
      const urls: string[] = []
      for (const t of q) { const r: any = await call('urlFor', { trackId: t.id }); urls.push(r.url) }
      const np = await ensurePlayer(urls, index)
      if (positionMs) np.seekTo(positionMs / 1000)
      if (wasPlaying) np.play()
      toWeb('play:rehosted', { positionMs })
    } catch (e: any) {
      // Nothing else can serve it either - fall back to the old behaviour and let the buffer end.
      toWeb('play:error', { error: e?.message ?? String(e) })
    }
  }

  // "Play here" (session handoff): adopt a session handed over from another device. Same rebuild
  // as restoreQueue - re-resolve URLs from IDs, port-rewrite the art (it carried the OTHER
  // device's shim port) - but it PLAYS, REPLACES any current playback, and seeks to the handed
  // position. The worklet already claimed the token (sessionTakeover); this just plays it.
  async function playSession (snap: any) {
    switchDrain.current = null // adopting another device's session cancels a pending switch-drain
    const q = Array.isArray(snap?.items) ? snap.items : []
    if (!q.length) return { ok: false }
    try {
      const index = Math.min(Math.max(0, Number(snap.index) || 0), q.length - 1)
      const urls: string[] = []
      let port: number | null = null
      for (const t of q) { const r: any = await call('urlFor', { trackId: t.id }); urls.push(r.url); if (r.port) port = r.port }
      if (port) {
        const fix = (u: any) => (typeof u === 'string' ? u.replace(/(127\.0\.0\.1:)\d+/, `$1${port}`) : u)
        for (const t of q) { t.art = fix(t.art); t.artFull = fix(t.artFull) }
      }
      queueRef.current = q
      indexRef.current = index
      shuffleRef.current = !!snap.shuffle
      repeatRef.current = Number(snap.repeat) || 0
      const p = await ensurePlayer(urls, index)
      px()?.setShuffle(shuffleRef.current)
      px()?.setRepeatMode(repeatRef.current)
      announce(index)
      if (snap.positionMs) p.seekTo(Math.max(0, snap.positionMs / 1000))
      p.play()
      persistQueue(true)
      toWeb('play:mode', { shuffle: shuffleRef.current, repeat: repeatRef.current })
      return { ok: true }
    } catch (e: any) {
      toWeb('play:error', { error: e?.message ?? String(e) })
      return { ok: false }
    }
  }

  // The "Play here" button: claim the token + fetch the session queue (worklet), then play it.
  // Fire-and-forget from the UI's side - it reacts to play:started like any other playback.
  async function playHere () {
    const s: any = await call('sessionTakeover').catch(() => null)
    if (!s?.ok) { toWeb('play:error', { error: 'Could not take over the session.' }); return { ok: false } }
    return playSession(s)
  }

  // --- boot ----------------------------------------------------------------

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      // The worklet's data dir. The device identity lives here, and it IS the
      // grant the host holds - wiping it means re-pairing.
      // `?? ''` used to turn a missing documentDirectory into the RELATIVE path "peartune",
      // which is not a failure the worklet can see: Bare.argv[0] is truthy, so its own
      // fallback never fires and it happily resolves "peartune" against whatever its cwd is.
      // The result is a phantom data directory - no identity, no hosts - on a phone that is
      // perfectly paired, which presents as the onboarding screen and a device key nobody has
      // granted. Refuse to start rather than start somewhere else.
      const docs = FileSystem.documentDirectory
      if (!docs) throw new Error('no documentDirectory - refusing to start the worklet on a relative data path')
      const dataDir = docs.replace('file://', '') + 'peartune'

      const worklet = new Worklet()
      const asset = Asset.fromModule(bundle)
      await asset.downloadAsync()
      const src = await FileSystem.readAsStringAsync(asset.localUri!, {
        encoding: FileSystem.EncodingType.Base64
      })

      // argv[1] is the PLATFORM. The worklet used to hardcode 'android' in its pairing claim, so
      // every iPhone that ever paired showed up on the operator's dashboard as an Android phone -
      // wrong information at exactly the moment it matters, when they are deciding what to revoke
      // (found on the first signed iOS build, 2026-07-28). The shell is the only side that knows,
      // and it knows at boot, so it says so at boot.
      await worklet.start('/app.bundle', b4a.from(src, 'base64'), [dataDir, Platform.OS])
      if (cancelled) return

      workletRef.current = worklet
      const ipc = worklet.IPC
      ipcRef.current = ipc

      // Tell the worklet what network we are on, so 'Auto' quality knows when to cap
      // the bitrate. Once now (before the first play), and again whenever it changes.
      // Fire-and-forget: a failure just means we stay on the safe 'wifi' default.
      // Always read the type from getNetworkStateAsync(), never from the listener's
      // event payload: on Android that payload arrives with a stale `type` (measured -
      // it reports WIFI even in airplane mode), while a fresh query is accurate. The
      // listener is only a trigger; this function is the source of truth.
      const reportNet = async () => {
        try {
          const st = await Network.getNetworkStateAsync()
          await call('setNetwork', { type: netKind(st.type) })
        } catch {}
      }
      reportNet()
      netSub.current = Network.addNetworkStateListener(() => { reportNet() })

      let buf = ''
      ipc.on('data', (data: any) => {
        buf += b4a.toString(data)
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          let msg: any
          try {
            msg = JSON.parse(line)
          } catch {
            continue
          }

          if (msg.event) {
            // A DROP IS NOT A STOP. This used to call stop() - tear the player down
            // and wipe the queue - because a network switch and a revoke are
            // indistinguishable at the instant of disconnect. They diverge on
            // RECONNECT (a switch succeeds, a revoke is denied), so we keep the buffer
            // playing and let the reconnect decide (proposal 2026-07-14).
            if (msg.event === 'host:disconnected') onHostDropped()
            // The host saw the cast track finish. Advancing is the shell's job now, not the
            // UI's: the speaker has no queue of its own, and the renderer that used to do
            // this is asleep whenever the screen is. next() moves ExoPlayer, whose index
            // change sends the new track to the speaker just above.
            else if (msg.event === 'speaker:ended') { if (castMode.current) next() }
            else if (msg.event === 'host:connected') dropped.current = false
            else if (msg.event === 'play:rehost') {
              // MID-SONG FAILOVER, the half the shim cannot do (proposal 2026-07-27). The library
              // serving this track went away and another one HAS the track, but the two copies are
              // different encodes - so the shim could not splice into the same response, and the
              // byte offsets of the new copy mean nothing to a player mid-track. Re-open the queue
              // (urlFor now routes to the copy we can actually reach) and seek back to where we
              // were. A gap, not a stop.
              rehostCurrent().catch(() => {})
              continue
            }
            else if (msg.event === 'session:superseded') {
              // Instant presence: another of this person's devices claimed the play token, so
              // stop NOW. Same handler as the lazy path (a rejected heartbeat) - onHandedOff is
              // idempotent, so a lazy rejection arriving after this too is harmless. It already
              // emits play:handedoff to the UI, so we do not also forward this raw event.
              onHandedOff()
              continue
            }
            toWeb(msg.event, msg.data)
            continue
          }

          const p = pending.current.get(msg.id)
          if (!p) continue
          pending.current.delete(msg.id)
          if (msg.error) p.reject(new Error(msg.error))
          else p.resolve(msg.result)
        }
      })

      // THEME, BEFORE THE FIRST PAINT.
      //
      // The theme preference lives in the worklet (settings.json), not in the
      // WebView's localStorage, and that is what makes a flash-free cold start
      // possible: the worklet is already up by the time we load the UI, so we can
      // read the preference, resolve it against the OS, paint the native chrome
      // correctly, and hand the WebView a document that ALREADY carries the right
      // data-theme. A light-theme user never sees a frame of dark.
      // WHICH SCENE, if any. Android reads the intent extra through a native module
      // (plugins/with-screenshot-scene.js). iOS needs no native code at all: a `-key value` launch
      // argument lands in NSUserDefaults' argument domain, and RN's Settings is a thin wrapper over
      // that - so `xcrun simctl launch ... -screenshotScene 4` is readable directly. Both are
      // settable ONLY by whoever launches the app, which is the property that made extras the
      // right surface in the first place.
      const shotScene = Platform.OS === 'ios'
        ? (Number(Settings.get('screenshotScene')) || 0)
        : (NativeModules?.PearTuneScreenshot?.scene | 0)
      const shotDarkRaw = Platform.OS === 'ios'
        ? Settings.get('screenshotDark')
        : NativeModules?.PearTuneScreenshot?.dark
      // -1 / undefined both mean "the script said nothing", which must not read as light.
      const shotDarkPref = shotDarkRaw === undefined || shotDarkRaw === null || shotDarkRaw === -1
        ? -1
        : (Number(shotDarkRaw) ? 1 : 0)

      const settings: any = await call('settings').catch(() => ({ theme: 'system' }))
      const os = Appearance.getColorScheme() ?? 'dark'
      // A capture forces the appearance, because the store wants BOTH and the emulator's own
      // setting is not worth fighting per run. -1 means the script said nothing, which is every
      // launch that is not a capture - then the user's own preference decides, as always.
      const resolved = shotDarkPref === 0 || shotDarkPref === 1
        ? (shotDarkPref === 1 ? 'dark' : 'light')
        : (settings?.theme === 'system' || !settings?.theme ? os : settings.theme)
      if (!cancelled) setScheme(resolved === 'light' ? 'light' : 'dark')

      // The WebView UI, loaded as a string so there is no file:// / MIME dance.
      const html = await FileSystem.readAsStringAsync(
        (await Asset.fromModule(require('../assets/index.html')).downloadAsync()).localUri!
      )

      // Injected BEFORE the bundle (it is the last thing in <body>), so the UI
      // boots already knowing the OS scheme and its own preference.
      // STORE SCREENSHOT SCENE (plugins/with-screenshot-scene.js). 0 = a normal launch, which is
      // every launch that is not the capture script - the constants read an intent extra only adb
      // can set. Injected here rather than pushed later because the UI has to know BEFORE it
      // mounts: a scene swaps the data layer, and a UI that mounted against the real one first
      // would flash real content into the frame we are about to capture.
      const shot = shotScene
      const shotDark = shotDarkPref
      // THE FIXTURE, read from a file the capture script drops in the app's own document dir.
      // Not bundled, deliberately: it is real album art out of a real library, fine in a store
      // listing and not fine inside a shipped binary or a public repo. Only read when a scene is
      // set, so an ordinary launch never touches the disk for it - and a missing or unreadable
      // file is not an error: the UI falls through to the real app (test/screenshot-scenes).
      let shotFixture = ''
      if (shot) {
        try {
          const f = (FileSystem.documentDirectory ?? '') + 'screenshot-fixture.json'
          const raw = await FileSystem.readAsStringAsync(f)
          JSON.parse(raw) // parse to VALIDATE; injecting a broken blob would be a syntax error
                          // in the boot script, which takes the whole UI down rather than one scene
          shotFixture = `window.__pearScreenshotFixture=${raw};`
        } catch {
          console.warn('[screenshot] scene ' + shot + ' has no readable fixture - showing the real app')
        }
      }

      const boot = '<script>' +
        (shot ? `window.__pearScreenshotScene=${JSON.stringify(shot)};` : '') +
        shotFixture +
        (shot && shotDark === 0 ? 'window.__pearScreenshotDark=false;' : '') +
        (shot && shotDark === 1 ? 'window.__pearScreenshotDark=true;' : '') +
        // The SCENE's appearance wins, not the simulator's. The UI resolves 'system' against
        // __pearColorScheme, so injecting the raw OS scheme here let the device's own light mode
        // override a `-screenshotDark 1` capture - which is exactly what it did on the first run.
        `window.__pearColorScheme=${JSON.stringify(shotDarkPref === 0 || shotDarkPref === 1 ? resolved : os)};` +
        `window.__pearTheme=${JSON.stringify(settings?.theme ?? 'system')};` +
        `window.__pearPlatform=${JSON.stringify(Platform.OS)};` +
        `document.documentElement.setAttribute('data-theme',${JSON.stringify(resolved)});` +
        '</script>'

      if (!cancelled) setUiHtml(html.replace('<body>', '<body>' + boot))
    })().catch((e) => {
      // NOT `() => {}`. Boot failing silently is indistinguishable from boot being slow: the
      // WebView never gets mounted, so the app sits on its blank shell forever with nothing
      // written anywhere saying why. Every failure in here is fatal to the whole app, which
      // makes it exactly the wrong thing to swallow.
      console.error('[peartune] boot failed', e)
      if (!cancelled) setBootError(e?.message ?? String(e))
    })

    // Back belongs to the UI, which owns the nav stack. Suite convention: the UI
    // tells us whether it has anything to pop (shell:navState), and we only
    // swallow the press when it does. Otherwise we return false and Android does
    // the normal thing - closes the app. Swallowing it unconditionally (what this
    // did before) meant back was simply dead.
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!canBack.current) return false
      toWeb('back', {})
      return true
    })

    // SYSTEM THEME. An Android WebView's `prefers-color-scheme` does NOT reliably
    // follow the app's night mode - it depends on algorithmic darkening, which
    // varies by WebView version and would also recolour our CSS behind our back.
    // RN's Appearance API is the authority, so we push the OS scheme in and the UI
    // resolves 'system' against it. (Suite gotcha: this only works because app.json
    // sets userInterfaceStyle "automatic" - with "dark", Appearance always reports
    // dark and system-follow silently breaks. Do not regress it.)
    const appearance = Appearance.addChangeListener(({ colorScheme }) => {
      const s = colorScheme ?? 'dark'
      webRef.current?.injectJavaScript(
        `window.__pearColorScheme=${JSON.stringify(s)};` +
        "window.dispatchEvent(new Event('pearcolorscheme')); true;"
      )
    })

    // COMING BACK. Android suspends a backgrounded app that is not holding a
    // foreground service, so an idle PearTune loses its link to the host within
    // about twenty seconds. That is normal, and not worth a permanent notification
    // to prevent - but the app must not still be sitting on a dead connection when
    // the user returns to it. Tell the UI, and it reconnects before they notice.
    const appState = AppState.addEventListener('change', (s) => {
      // WebView resume-freeze recovery (Android only - iOS/WKWebView has no cached-app freezer).
      // Terminating the renderer is what actually unfreezes the screen; the reload it triggers is
      // why this is gated on a real absence rather than every glance at another app.
      if (Platform.OS === 'android') {
        if (s === 'background' || s === 'inactive') {
          if (_backgroundedAt === 0) _backgroundedAt = Date.now()
        } else if (s === 'active') {
          const bgMs = _backgroundedAt ? Date.now() - _backgroundedAt : 0
          _backgroundedAt = 0
          if (bgMs >= WEBVIEW_RECOVERY_MIN_BG_MS && WebViewRecovery?.terminateRenderer) {
            WebViewRecovery.terminateRenderer()
              .then((n: number) => { if (n) console.warn('[webview] terminated ' + n + ' renderer(s) after ' + Math.round(bgMs / 1000) + 's backgrounded') })
              .catch(() => {}) // an old build with no native module, or no WebView up yet
          }
        }
      }
      if (s === 'active') {
        toWeb('app:active', {})
        // The network may have changed while we were suspended (walked out of wifi),
        // and the listener does not fire in the background - so re-check on resume.
        Network.getNetworkStateAsync()
          .then((st) => call('setNetwork', { type: netKind(st.type) }))
          .catch(() => {})
      }
    })

    return () => {
      cancelled = true
      back.remove()
      appearance.remove()
      appState.remove()
      netSub.current?.remove()
      stopPlayer()
      workletRef.current?.terminate?.()
    }
  }, [])

  // --- WebView -> shell ----------------------------------------------------

  const onMessage = async (e: any) => {
    let msg: any
    try {
      msg = JSON.parse(e.nativeEvent.data)
    } catch {
      return
    }

    const reply = (payload: any) => {
      webRef.current?.injectJavaScript(
        `window.__pearResponse(${msg.id}, ${JSON.stringify(payload)}); true;`
      )
    }

    // Methods the SHELL answers, because only the shell can reach the native media
    // stack (or its own chrome). Every one of them still gets a reply: the UI's
    // call() parks a promise per id, so a silently unanswered method leaks one
    // forever - and `seekTo` fires on every frame of a scrub.
    const local: Record<string, () => any> = {
      play: () => play(msg.args),
      enqueue: () => enqueue(msg.args),

      // The queue lives HERE (the shell hands it to ExoPlayer, and ExoPlayer owns
      // the shuffled order), so the UI has to ask for it rather than keep its own
      // copy that would drift the moment shuffle is on or a track auto-advances.
      queue: () => ({
        items: queueRef.current,
        index: indexRef.current
      }),

      // Edit the queue in place: reorder (drag) or remove a track. Both mirror
      // ExoPlayer's own move/remove (via the patch) so the current track keeps
      // playing, and both return the new {items,index} so the UI reflects it at once.
      queueMove: () => queueMove(msg.args),
      queueRemove: () => queueRemove(msg.args),
      // Clear the queue but keep the current track playing (the Queue screen's
      // "Clear Queue"). A full stop is a separate 'stop' call (the player's X).
      queueClearKeepCurrent: () => queueClearKeepCurrent(),
      // The player's X: stop playback, keep the queue (see stopKeepQueue).
      stopKeepQueue: () => stopKeepQueue(),

      // Jump straight to a track in the queue. seekToQueueIndex is ExoPlayer's own
      // (via the patch), so this respects the shuffled order rather than fighting
      // it.
      //
      // Do NOT announce() here, however tempting. setActiveForLockScreen tears the
      // MediaSession down and builds a new one, and doing that in the same breath
      // as a seek loses the audio focus with it - the jump worked, and landed
      // PAUSED. The status listener already announces when it sees the index move
      // (that is how gapless advance updates the lock screen), so the only correct
      // thing to do here is seek, play, and let it notice.
      playIndex: () => {
        const i = Number(msg.args?.index) || 0
        const p = px()
        if (!p) return
        manualNav.current = true
        p.seekToQueueIndex(i)
        // While casting, every slot is one second of silence, so playing would race the
        // whole queue in under a minute and fire a cast per second. The seek alone is what
        // is wanted: it announces the track, and the UI sends THAT to the speaker.
        if (!castMode.current) p.play()
      },

      toggle,
      next,
      prev,
      stop,
      restore: () => restoreQueue(),
      // A library switch (multi-host): drain the current track then bring up the new library's
      // queue, or swap straight to it if nothing is playing. Called by the UI on host:switched.
      switchQueue: () => switchQueue(),
      // Session handoff: "Play here" adopts the session another device is holding.
      playHere: () => playHere(),
      seekBy: () => seekBy(msg.args.seconds ?? SEEK_STEP),
      seekTo: () => seekTo(msg.args.ms ?? 0),
      shuffle: () => setShuffle(!!msg.args.on),
      repeat: () => setRepeat(Number(msg.args.mode) || 0),
      // A Home Assistant speaker is the output now (proposal 2026-08-02). This player
      // keeps the queue and the order; it just stops making sound.
      // Fire-and-forget: leaving cast mode rebuilds the player (see setCastMode), which
      // resolves a URL per queued track and can take a moment on a long queue. The UI has
      // nothing to do with the result, and holding the IPC reply open would just make the
      // sheet feel stuck.
      castMode: () => { setCastMode(!!msg.args?.on, msg.args?.entityId ?? null); return { ok: true } },
      sleep: () => setSleep(msg.args || {}),

      // The UI resolved its theme ('system' against the OS scheme we pushed it)
      // and is telling us what it painted, so the status bar and the strip behind
      // the WebView match.
      theme: () => setScheme(msg.args?.scheme === 'light' ? 'light' : 'dark'),

      // Whether back has anything to pop. See the BackHandler above.
      'shell:navState': () => { canBack.current = !!msg.args?.canBack }
    }

    if (local[msg.method]) {
      // AWAIT A THENABLE BEFORE REPLYING. Several of these are async (play,
      // enqueue, restore, switchQueue, playHere), and replying with the Promise
      // itself serialized it: the UI got `{"_h":0,"_i":0,...}` on Hermes instead of
      // the answer, so `call('restore').then(r => r?.restored)` in src/ui/App.jsx
      // had never once seen `restored` - on mount or on host:connected. The restore
      // ran; only its answer was lost, which is why nothing looked broken (found
      // 2026-08-29 while fixing the queue loss).
      //
      // A rejection becomes an error the UI can show, rather than an unhandled one:
      // the bridge's `call` rejects on { error }, and every caller of these already
      // catches. Sync methods are unchanged - `await` on a non-thenable is the same
      // value, one microtask later.
      try {
        const result = await local[msg.method]()
        return reply({ result: result ?? { ok: true } })
      } catch (e: any) {
        console.warn('[shell] ' + msg.method + ' failed: ' + (e?.message || e))
        return reply({ error: e?.message || String(e) })
      }
    }

    // Shell services the WebView cannot do for itself: the OS share sheet, opening
    // a link in the real browser (or a lightning: URI in a wallet), and the
    // clipboard - navigator.clipboard is unreliable in an about:blank WebView, so
    // About's addresses copy through here. Same names as the sibling apps.
    try {
      if (msg.method === 'shell:share') {
        const res = await Share.share({ message: msg.args?.text ?? '', title: msg.args?.title ?? '' })
        return reply({ result: { ok: res.action !== Share.dismissedAction } })
      }
      // The deep link the app was OPENED with, fetched-and-cleared in one call so it can
      // never be handed out twice. Pull, not push: at a cold start the URL is known long
      // before the WebView has mounted a listener, and a pushed event would land in the
      // dark. The UI asks once on boot and again whenever link:pending says a new one
      // arrived, and both paths go through this same atomic take.
      if (msg.method === 'shell:pendingLink') {
        const url = pendingPairLink
        pendingPairLink = null
        // The COLLECTION half of the pair of log lines - `take` above records that a link
        // ARRIVED, this records that the UI came and got it. Without both, a link that goes
        // nowhere is indistinguishable between "the intent never reached JS" and "it did and
        // nothing collected it", and those have completely different causes. That ambiguity
        // cost real time on 2026-07-28.
        console.warn('[link] UI collected ' + (url ? 'rv=' + String(url).slice(-8) : 'NOTHING'))
        return reply({ result: { url: url ?? null } })
      }
      if (msg.method === 'shell:openUrl') {
        if (!msg.args?.url) return reply({ error: 'url required' })
        if (!openableUrl(msg.args.url)) {
          console.warn('[shell] refused to open ' + String(msg.args.url).slice(0, 24))
          return reply({ error: 'unsupported url scheme' })
        }
        await Linking.openURL(msg.args.url)
        return reply({ result: { ok: true } })
      }
      if (msg.method === 'shell:canOpenURL') {
        const can = await Linking.canOpenURL(msg.args?.url ?? '').catch(() => false)
        return reply({ result: { ok: true, can: !!can } })
      }
      if (msg.method === 'shell:clipboard') {
        const text = msg.args?.text
        if (typeof text !== 'string' || !text) return reply({ error: 'text required' })
        await Clipboard.setStringAsync(text)
        return reply({ result: { ok: true } })
      }
      // "Try it without a server". Only the shell can do this half: the demo media are Expo
      // assets, and resolving them to real paths is a native-side job. It hands those paths to
      // the worklet, which installs them into the audio cache and switches into demo mode.
      //
      // A track whose asset will not resolve is simply left out of `files` - the worklet skips
      // it and the demo library is one track shorter, which is a far better failure than a
      // button that does nothing.
      if (msg.method === 'shell:enableDemo') {
        const files: Record<string, string> = {}
        for (const [name, mod] of Object.entries(DEMO_AUDIO)) {
          const p = await resolveAsset(mod)
          if (p) files[name] = p
        }
        const cover = await resolveAsset(DEMO_COVER)
        const result = await call('enableDemo', { manifest: DEMO_MANIFEST, files, cover })
        return reply({ result })
      }
      if (msg.method === 'shell:haptic') {
        const k = msg.args?.kind
        try {
          if (k === 'medium') await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
          else if (k === 'success') await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
          else if (k === 'warn') await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
          else await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
        } catch {}
        return reply({ result: { ok: true } })
      }
    } catch (err: any) {
      return reply({ error: err?.message ?? String(err) })
    }

    // Unpairing tears down the player first: the worklet is about to close the
    // connection the audio is streaming over, and a player left pointing at a
    // dead loopback socket just stalls.
    if (msg.method === 'forget') stop({ forget: true })

    try {
      reply({ result: await call(msg.method, msg.args) })
    } catch (err: any) {
      reply({ error: err?.message ?? String(err) })
    }
  }

  const bg = SHELL_BG[scheme]

  return (
    <View style={{ flex: 1, paddingTop: insets.top, backgroundColor: bg }}>
      <StatusBar barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'} backgroundColor={bg} />
      {bootError && (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <Text style={{ color: scheme === 'dark' ? '#fff' : '#000', fontSize: 17, marginBottom: 10 }}>
            PearTune could not start.
          </Text>
          <Text style={{ color: scheme === 'dark' ? '#aaa' : '#555', fontSize: 14, textAlign: 'center' }}>
            {bootError}
          </Text>
          <Text style={{ color: scheme === 'dark' ? '#aaa' : '#555', fontSize: 14, textAlign: 'center', marginTop: 10 }}>
            Your libraries and pairings have not been touched. Close PearTune and open it again.
          </Text>
        </View>
      )}
      {uiHtml && (
        <WebView
          ref={webRef}
          // The other half of the resume-freeze recovery. Our terminate above kills the renderer,
          // which lands here with didCrash=false; reloading binds a FRESH render process to the
          // current window surface, which is the thing that actually repaints. This also covers a
          // renderer the OS killed on its own - previously that left the UI dead until the app was
          // swiped away, because nothing reloaded it.
          onRenderProcessGone={(e: any) => {
            console.warn('[webview] render process gone, didCrash=' + e?.nativeEvent?.didCrash + ' -> reload')
            webRef.current?.reload()
          }}
          // THE baseUrl IS NOT DECORATION - the QR scanner does not work without
          // it. getUserMedia only exists in a SECURE CONTEXT. Loaded as a bare
          // HTML string the document's origin is about:blank, which is not one, so
          // navigator.mediaDevices is UNDEFINED: the scanner threw on the property
          // access, React unmounted the tree, and pairing showed a black screen
          // with no error. https://localhost is a trustworthy origin, and it is
          // what PearList's scanner has always used.
          source={{ html: uiHtml, baseUrl: 'https://localhost/' }}
          originWhitelist={['*']}
          onMessage={onMessage}
          javaScriptEnabled
          domStorageEnabled
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          // ...and the consequence of that https origin: the artwork is served by
          // the worklet over http://127.0.0.1, so every cover is now MIXED CONTENT
          // and the WebView would block it. Allow it. This is not the blanket
          // cleartext hole - the network security config still restricts cleartext
          // to 127.0.0.1 (plugins/with-localhost-cleartext.js).
          mixedContentMode='always'
          // The QR scanner runs in the WebView (getUserMedia), same as PearList.
          mediaCapturePermissionGrantType='grant'
          // THE CAMERA, AND NOTHING ELSE. This used to grant whatever was asked
          // (ev.resources verbatim), so a page that could ask - which needs the
          // bundled UI compromised first, but that is the point of defence in
          // depth - got the microphone for the asking. The scanner is the only
          // capture this app has ever wanted.
          onPermissionRequest={(ev: any) => {
            try {
              const asked: string[] = ev?.resources || []
              const camera = asked.filter((r) => String(r).includes('VIDEO_CAPTURE'))
              if (camera.length === asked.length && camera.length > 0) ev.grant(camera)
              else ev.deny?.()
            } catch {}
          }}
          // A NAVIGATION GUARD, because originWhitelist above is ['*']: the UI is
          // one bundled page that never navigates anywhere, so anything trying to
          // is either an accident or a redirect somebody injected. Our own document
          // and about:blank load; every other destination is refused, and an http(s)
          // one is handed to the browser where it belongs rather than silently lost.
          onShouldStartLoadWithRequest={(req: any) => {
            const url = String(req?.url || '')
            if (url === 'about:blank' || url.startsWith('https://localhost/')) return true
            if (/^https?:\/\//i.test(url) && req?.navigationType !== 'other') {
              Linking.openURL(url).catch(() => {})
            }
            console.warn('[webview] refused navigation to ' + url.slice(0, 32))
            return false
          }}
          style={{ flex: 1, backgroundColor: bg }}
        />
      )}
    </View>
  )
}

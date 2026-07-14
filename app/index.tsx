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
import { View, StatusBar, BackHandler, Appearance, AppState, Platform, Share } from 'react-native'
import { WebView } from 'react-native-webview'
import * as Linking from 'expo-linking'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Worklet } from 'react-native-bare-kit'
// expo-audio, not expo-av: av is deprecated as of SDK 54.
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio'
import b4a from 'b4a'
import { Asset } from 'expo-asset'
import * as FileSystem from 'expo-file-system/legacy'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const bundle = require('../assets/bare-universal.bundle')

type Pending = { resolve: (v: any) => void; reject: (e: any) => void }

// The shell paints the strip behind the status bar and under the WebView, so it
// has to know the theme too - otherwise a light UI sits under a black notch. The
// UI owns the decision (it knows whether the setting is light, dark or system)
// and reports the RESOLVED scheme back down here.
const SHELL_BG = { dark: '#14130f', light: '#faf8f5' }

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
  const [uiHtml, setUiHtml] = useState<string | null>(null)
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

      p.addListener('playbackStatusUpdate', (s: any) => {
        // ExoPlayer owns the queue now, so IT decides when we crossed into the
        // next track. Trust its index rather than counting didJustFinish events.
        const i = p.currentQueueIndex ?? indexRef.current
        if (i !== indexRef.current) {
          indexRef.current = i
          announce(i)
        }

        // The playlist ran out.
        if (s.didJustFinish && indexRef.current >= queueRef.current.length - 1) stop()

        toWeb('play:status', {
          playing: !!s.playing,
          positionMs: Math.round((s.currentTime ?? 0) * 1000),
          durationMs: s.duration ? Math.round(s.duration * 1000) : null,
          buffering: !!s.isBuffering,
          index: indexRef.current,
          queueLength: queueRef.current.length
        })
      })
    }

    p.setQueueSources(urls.map((uri: string) => ({ uri })))
    p.seekToQueueIndex(startIndex)
    return p
  }

  // Tell the UI and the lock screen which track is playing. Called on every
  // playlist transition, including ExoPlayer's own gapless advance.
  function announce (i: number) {
    const t = queueRef.current[i]
    if (!t) return

    player.current?.setActiveForLockScreen(
      true,
      {
        title: t.title,
        artist: t.artist ?? undefined,
        albumTitle: t.album ?? undefined,
        artworkUrl: t.art ?? undefined
      },
      { showSeekForward: true, showSeekBackward: true }
    )

    toWeb('play:started', {
      trackId: t.id,
      title: t.title,
      artist: t.artist ?? null,
      album: t.album ?? null,
      art: t.art ?? null,
      // The big cover, for the UI's full-screen art viewer. The lock screen above
      // deliberately keeps the small one - it is a notification, not a gallery.
      artFull: t.artFull ?? null,
      index: i,
      queueLength: queueRef.current.length
    })
  }

  async function play ({ queue, index = 0 }: any) {
    const q = Array.isArray(queue) ? queue : []
    queueRef.current = q
    indexRef.current = index
    if (!q.length) return stop()

    try {
      // Resolve every track's loopback URL up front. ExoPlayer needs the whole
      // playlist to be able to decode ahead across a track boundary.
      const urls: string[] = []
      for (const t of q) {
        const { url }: any = await call('urlFor', { trackId: t.id })
        urls.push(url)
      }

      const p = await ensurePlayer(urls, index)
      announce(index)
      p.play()
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
      px()?.addQueueSources(urls.map((uri) => ({ uri })))
      toWeb('play:queued', { count: q.length, queueLength: queueRef.current.length })
    } catch (e: any) {
      toWeb('play:error', { error: e?.message ?? String(e) })
    }
  }

  function toggle () {
    const p = player.current
    if (!p) return
    if (p.playing) p.pause()
    else p.play()
  }

  // setQueueSources / skipToNext / skipToPrevious / currentQueueIndex come from
  // patches/expo-audio+1.1.1.patch. We patched the Kotlin, NOT the .d.ts, so
  // TypeScript does not know about them - reach them through a cast rather than
  // patching type files we would then also have to maintain.
  const px = () => player.current as any

  // Delegated to ExoPlayer, so the lock-screen buttons and the in-app buttons go
  // down exactly the same path.
  function next () {
    px()?.skipToNext()
  }

  // ExoPlayer's seekToPrevious already implements the convention every player
  // uses: restart the current track unless you are near its start, in which case
  // step back one.
  function prev () {
    px()?.skipToPrevious()
  }

  // ExoPlayer owns the shuffle order, so `next` and the LOCK-SCREEN next button
  // both respect it. Shuffling our own array instead would mean re-handing the
  // playlist to the player, which restarts buffering and breaks gapless.
  function setShuffle (on: boolean) {
    px()?.setShuffle(on)
    toWeb('play:mode', { shuffle: on })
  }

  // 0 = off, 1 = repeat one, 2 = repeat all.
  function setRepeat (mode: number) {
    px()?.setRepeatMode(mode)
    toWeb('play:mode', { repeat: mode })
  }

  function seekBy (seconds: number) {
    const p = player.current
    if (!p) return
    const target = Math.max(0, Math.min((p.duration || 0), (p.currentTime || 0) + seconds))
    p.seekTo(target)
  }

  function seekTo (ms: number) {
    player.current?.seekTo(Math.max(0, ms / 1000))
  }

  function stopPlayer () {
    if (!player.current) return
    try {
      player.current.clearLockScreenControls()
      player.current.pause()
      player.current.remove()
    } catch {}
    player.current = null
  }

  function stop () {
    stopPlayer()
    queueRef.current = []
    indexRef.current = 0
    toWeb('play:stopped', {})
  }

  // --- boot ----------------------------------------------------------------

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      // The worklet's data dir. The device identity lives here, and it IS the
      // grant the host holds - wiping it means re-pairing.
      const dataDir = (FileSystem.documentDirectory ?? '').replace('file://', '') + 'peartune'

      const worklet = new Worklet()
      const asset = Asset.fromModule(bundle)
      await asset.downloadAsync()
      const src = await FileSystem.readAsStringAsync(asset.localUri!, {
        encoding: FileSystem.EncodingType.Base64
      })

      await worklet.start('/app.bundle', b4a.from(src, 'base64'), [dataDir])
      if (cancelled) return

      workletRef.current = worklet
      const ipc = worklet.IPC
      ipcRef.current = ipc

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
            // The host cut us off (revoked, or it went away). Stop the player
            // rather than leaving a stalled one on screen.
            if (msg.event === 'host:disconnected') stop()
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
      const settings: any = await call('settings').catch(() => ({ theme: 'system' }))
      const os = Appearance.getColorScheme() ?? 'dark'
      const resolved = settings?.theme === 'system' || !settings?.theme
        ? os
        : settings.theme
      if (!cancelled) setScheme(resolved === 'light' ? 'light' : 'dark')

      // The WebView UI, loaded as a string so there is no file:// / MIME dance.
      const html = await FileSystem.readAsStringAsync(
        (await Asset.fromModule(require('../assets/index.html')).downloadAsync()).localUri!
      )

      // Injected BEFORE the bundle (it is the last thing in <body>), so the UI
      // boots already knowing the OS scheme and its own preference.
      const boot = '<script>' +
        `window.__pearColorScheme=${JSON.stringify(os)};` +
        `window.__pearTheme=${JSON.stringify(settings?.theme ?? 'system')};` +
        `window.__pearPlatform=${JSON.stringify(Platform.OS)};` +
        `document.documentElement.setAttribute('data-theme',${JSON.stringify(resolved)});` +
        '</script>'

      if (!cancelled) setUiHtml(html.replace('<body>', '<body>' + boot))
    })().catch(() => {})

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
      if (s === 'active') toWeb('app:active', {})
    })

    return () => {
      cancelled = true
      back.remove()
      appearance.remove()
      appState.remove()
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
        p.seekToQueueIndex(i)
        p.play()
      },

      toggle,
      next,
      prev,
      stop,
      seekBy: () => seekBy(msg.args.seconds ?? SEEK_STEP),
      seekTo: () => seekTo(msg.args.ms ?? 0),
      shuffle: () => setShuffle(!!msg.args.on),
      repeat: () => setRepeat(Number(msg.args.mode) || 0),

      // The UI resolved its theme ('system' against the OS scheme we pushed it)
      // and is telling us what it painted, so the status bar and the strip behind
      // the WebView match.
      theme: () => setScheme(msg.args?.scheme === 'light' ? 'light' : 'dark'),

      // Whether back has anything to pop. See the BackHandler above.
      'shell:navState': () => { canBack.current = !!msg.args?.canBack }
    }

    if (local[msg.method]) {
      const result = local[msg.method]()
      return reply({ result: result ?? { ok: true } })
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
      if (msg.method === 'shell:openUrl') {
        if (!msg.args?.url) return reply({ error: 'url required' })
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
    if (msg.method === 'forget') stop()

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
      {uiHtml && (
        <WebView
          ref={webRef}
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
          onPermissionRequest={(ev: any) => { try { ev?.grant?.(ev.resources) } catch {} }}
          style={{ flex: 1, backgroundColor: bg }}
        />
      )}
    </View>
  )
}

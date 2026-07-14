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
import { View, StatusBar, BackHandler, Platform } from 'react-native'
import { WebView } from 'react-native-webview'
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

  async function ensurePlayer (url: string) {
    // shouldPlayInBackground + FOREGROUND_SERVICE_MEDIA_PLAYBACK keep audio alive
    // once the screen goes off. interruptionMode 'doNotMix' is what makes Android
    // associate the lock-screen controls with US: without it the OS may not hand
    // this player the session at all.
    await setAudioModeAsync({
      shouldPlayInBackground: true,
      playsInSilentMode: true,
      interruptionMode: 'doNotMix'
    })

    if (player.current) {
      player.current.replace({ uri: url })
      return player.current
    }

    const p = createAudioPlayer({ uri: url })
    player.current = p

    p.addListener('playbackStatusUpdate', (s: any) => {
      // End of track -> advance. This is the whole reason a queue exists.
      if (s.didJustFinish) {
        next()
        return
      }
      toWeb('play:status', {
        playing: !!s.playing,
        positionMs: Math.round((s.currentTime ?? 0) * 1000),
        durationMs: s.duration ? Math.round(s.duration * 1000) : null,
        buffering: !!s.isBuffering,
        index: indexRef.current,
        queueLength: queueRef.current.length
      })
    })

    return p
  }

  async function playAt (i: number) {
    const q = queueRef.current
    if (i < 0 || i >= q.length) return stop()

    const t = q[i]
    indexRef.current = i

    try {
      // The loopback URL the worklet serves. ExoPlayer range-requests it, and
      // every one of those ranges is fetched over the live P2P connection.
      const { url }: any = await call('urlFor', { trackId: t.id })
      const p = await ensurePlayer(url)

      // Lock screen + notification. The artwork URL is our OWN loopback server,
      // so the cover on the lock screen also came over P2P.
      p.setActiveForLockScreen(
        true,
        {
          title: t.title,
          artist: t.artist ?? undefined,
          albumTitle: t.album ?? undefined,
          artworkUrl: t.art ?? undefined
        },
        { showSeekForward: true, showSeekBackward: true }
      )

      p.play()
      toWeb('play:started', {
        trackId: t.id,
        title: t.title,
        artist: t.artist ?? null,
        album: t.album ?? null,
        art: t.art ?? null,
        index: i,
        queueLength: q.length
      })
    } catch (e: any) {
      // A revoked device lands here: the loopback stream broke because the P2P
      // connection under it was destroyed.
      toWeb('play:error', { error: e?.message ?? String(e) })
    }
  }

  function play ({ queue, index = 0 }: any) {
    queueRef.current = Array.isArray(queue) ? queue : []
    return playAt(index)
  }

  function toggle () {
    const p = player.current
    if (!p) return
    if (p.playing) p.pause()
    else p.play()
  }

  function next () {
    if (indexRef.current + 1 >= queueRef.current.length) return stop()
    playAt(indexRef.current + 1)
  }

  // The convention every music player uses: PREVIOUS restarts the current track
  // if you are more than a few seconds in, and only steps back a track if you
  // press it near the beginning. Jumping straight back is a common annoyance.
  function prev () {
    const p = player.current
    if (p && p.currentTime > 3) return p.seekTo(0)
    if (indexRef.current - 1 < 0) return p?.seekTo(0)
    playAt(indexRef.current - 1)
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

      // The WebView UI, loaded as a string so there is no file:// / MIME dance.
      const html = await FileSystem.readAsStringAsync(
        (await Asset.fromModule(require('../assets/index.html')).downloadAsync()).localUri!
      )
      if (!cancelled) setUiHtml(html)
    })().catch(() => {})

    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      webRef.current?.injectJavaScript('window.__pearBack && window.__pearBack(); true;')
      return true
    })

    return () => {
      cancelled = true
      back.remove()
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

    // Playback is the shell's job, not the worklet's: only the shell can talk to
    // the native media stack.
    if (msg.method === 'play') return play(msg.args)
    if (msg.method === 'toggle') return toggle()
    if (msg.method === 'next') return next()
    if (msg.method === 'prev') return prev()
    if (msg.method === 'seekBy') return seekBy(msg.args.seconds ?? SEEK_STEP)
    if (msg.method === 'seekTo') return seekTo(msg.args.ms ?? 0)
    if (msg.method === 'stop') return stop()

    try {
      const result = await call(msg.method, msg.args)
      webRef.current?.injectJavaScript(
        `window.__pearResponse(${msg.id}, ${JSON.stringify({ result })}); true;`
      )
    } catch (err: any) {
      webRef.current?.injectJavaScript(
        `window.__pearResponse(${msg.id}, ${JSON.stringify({ error: err?.message ?? String(err) })}); true;`
      )
    }
  }

  return (
    <View style={{ flex: 1, paddingTop: insets.top, backgroundColor: '#14130f' }}>
      <StatusBar barStyle="light-content" backgroundColor="#14130f" />
      {uiHtml && (
        <WebView
          ref={webRef}
          source={{ html: uiHtml }}
          originWhitelist={['*']}
          onMessage={onMessage}
          javaScriptEnabled
          domStorageEnabled
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          // The QR scanner runs in the WebView (getUserMedia), same as PearList.
          onPermissionRequest={(req: any) => req.grant?.()}
          style={{ flex: 1, backgroundColor: '#14130f' }}
        />
      )}
    </View>
  )
}

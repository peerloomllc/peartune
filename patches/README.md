# Patches, and the one that needs re-checking by hand

`patch-package` applies everything in this folder on `postinstall`. Two live patches:

| patch | what it does |
| --- | --- |
| `hyperswarm+4.17.0.patch` | see the patch itself |
| `expo-audio+1.1.1.patch` | gapless queue support - the reason PearTune can play an album without a gap between tracks |

## expo-audio: bump the version, re-verify the patch

**This is the one standing rule in this folder, and it lives here rather than in a TODO list
because the only person who needs it is whoever bumps `expo-audio` - and they are looking at
this folder, not at somebody's backlog.**

The patch:

- removes the `publication` block, which forces a **source build** of the module instead of
  using the precompiled AAR;
- edits `AudioModule.kt`, `AudioPlayer.kt` and `AudioMediaSessionCallback.kt`.

**The failure mode is silent.** `patch-package` reports success - the diff applied cleanly - and
the build then uses the **precompiled AAR anyway**, so the Kotlin changes are simply absent.
Nothing errors. Gapless playback quietly stops working, and it stops working in a way that a
unit test cannot see, because the missing code is on the other side of the JS bridge.

So after any bump, do not trust the apply. Check the built APK for the symbol:

```
unzip -p android/app/build/outputs/apk/debug/app-debug.apk classes*.dex | strings | grep -c setQueueSources
```

Zero means the AAR won, whatever `postinstall` said. Anything above zero means the source build
was used and the patch is really in there.

Pinned versions matter: the file name carries the version it was cut against
(`expo-audio+1.1.1.patch`), and `package.json` currently asks for `^1.1.1`. A minor bump that
moves the Kotlin around will make the patch fail loudly, which is the good case. The bad case is
the one above.

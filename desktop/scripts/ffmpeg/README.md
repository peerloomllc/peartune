# The bundled ffmpeg

The binaries that ship inside the PearTune desktop installers are built by the scripts
in this directory and land in `desktop/vendor/ffmpeg/<platform>-<arch>/`.

They are **not committed**. `desktop/vendor/` is generated in its entirety, so this
README lives here beside the build scripts rather than beside the output.

## Why they exist

The container image has carried a static ffmpeg since 0.2.45. A desktop install never
got one: nothing bundled a binary and nothing set `PEARTUNE_FFMPEG`, so
`host/transcode.js` fell through to a bare `ffmpeg` on PATH that a normal Mac or Windows
machine does not have.

That failure is silent by construction. A host that cannot transcode does not error - it
degrades to raw bytes, and a format the phone cannot decode then plays as nothing at
all, which the app shows as "paused" forever. It is the 2026-08-14 `.wma` bug, on every
desktop library there is, and PR #380 widened it to `.ogg` on iOS.

## Why they are not in git

Roughly 17MB across four platforms, and a fresh copy on every ffmpeg bump would sit in
history for good. They change rarely and they persist on disk between releases, so the
cost of rebuilding is paid per ffmpeg version rather than per release. Same call
pearcinema made for the same reason.

The risk that buys is shipping an installer with no binary in it - reintroducing the
exact bug this fixes, invisibly. So the desktop build scripts REFUSE to package when
they are missing, rather than warning and carrying on.

## Building them

```
desktop/scripts/ffmpeg/build.sh          # all four
desktop/scripts/ffmpeg/check.sh          # prove they work
```

`build.sh` needs rootless podman for the Linux and Windows targets and ssh to the Mac
for the macOS slices. Sources and checksums are pinned in
`desktop/scripts/ffmpeg/sources.env` and verified before anything is unpacked.

## What is in them

**Audio only.** PearTune never touches a video codec, and the ready-made general-purpose
LGPL builds are ~110MB each, which would roughly double the Windows and Linux
installers to carry code that can never run. These are ~4-5MB:

| platform | size |
| --- | ---: |
| darwin-arm64 | 3.8 MB |
| darwin-x64 | 4.3 MB |
| linux-x64 | 5.0 MB (fully static) |
| win32-x64 | 4.0 MB |

Decoders cover every extension `host/adapters/folder.js` indexes; encoders cover the
three formats `host/transcode.js` can emit. Built from ffmpeg 7.1 with libmp3lame and
libopus.

## Licensing: LGPL, and it is a requirement

PearTune is MIT and these binaries ship **inside the installer**, so a GPL ffmpeg would
drag copyleft across the app - the same reason `CLAUDE.md` refuses the holesail
packages. lame is LGPL and opus is BSD, so `--enable-libmp3lame --enable-libopus` needs
no `--enable-gpl`, and nothing in the build turns it on.

That is asserted rather than assumed, in two places: the build refuses to emit a binary
whose own `-version` banner reports `--enable-gpl` or `--enable-nonfree`, and `check.sh`
re-asserts it on each binary afterwards. The flags used are a readback; the banner is
the artifact.

#!/bin/bash
# Builds the bundled ffmpeg for one target INSIDE the build container.
# Not run directly - build.sh drives it.  $1 = linux-x64 | win32-x64
#
# AUDIO ONLY, and enumerated rather than trimmed down from the default. PearTune is a
# music app: it never touches a video codec, and the ready-made general-purpose LGPL
# builds are 110MB each, which would roughly double the Windows and Linux installers to
# carry code that can never run. What comes out of here is ~5MB.
#
# LGPL, NOT GPL, and that is a licensing requirement rather than a preference. PearTune
# is MIT and this binary ships inside the installer, so a GPL ffmpeg would drag copyleft
# across the app - the same reason CLAUDE.md refuses the holesail packages. GPL is off
# by ffmpeg's default and nothing here turns it on, and the build then asserts it on the
# BUILT BINARY rather than trusting the flags.
set -euo pipefail
TARGET="$1"
SRC=/src
OUT=/out/$TARGET
PREFIX=/deps
mkdir -p "$OUT" "$PREFIX"

case "$TARGET" in
  linux-x64) CROSS=(); HOST=""; EXE="" ;;
  win32-x64)
    CROSS=(--host=x86_64-w64-mingw32); HOST="x86_64-w64-mingw32"; EXE=".exe"
    # Debian's gcc turns on _FORTIFY_SOURCE by default, which makes opus emit calls to
    # __memcpy_chk. mingw's CRT does not provide the _chk family, so the ffmpeg link
    # dies with "undefined reference to __memcpy_chk" - and ffmpeg reports that as
    # "opus not found using pkg-config", blaming the wrong thing entirely. Turn fortify
    # off for the cross build rather than dragging in -lssp.
    export CPPFLAGS="-U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=0"
    ;;
  *) echo "unknown target $TARGET" >&2; exit 1 ;;
esac

cd /tmp && rm -rf build && mkdir build && cd build

echo ">>> lame"
tar -xzf $SRC/lame-3.100.tar.gz
cd lame-3.100
# lame 3.100 ships a broken symbol export for this one; every distro patches it.
sed -i '/lame_init_old/d' include/libmp3lame.sym
./configure --prefix=$PREFIX --disable-shared --enable-static \
  --disable-frontend --disable-decoder --disable-analyzer-hooks \
  "${CROSS[@]}" >/dev/null
make -j"$(nproc)" >/dev/null && make install >/dev/null
cd ..

echo ">>> opus"
tar -xzf $SRC/opus-1.5.2.tar.gz
cd opus-1.5.2
./configure --prefix=$PREFIX --disable-shared --enable-static \
  --disable-doc --disable-extra-programs "${CROSS[@]}" >/dev/null
make -j"$(nproc)" >/dev/null && make install >/dev/null
cd ..

echo ">>> ffmpeg"
tar -xJf $SRC/ffmpeg-7.1.tar.xz
cd ffmpeg-7.1

# AUDIO ONLY, and enumerated rather than trimmed-from-default, because the point of
# this build is that a music app should not ship a video encoder. Everything listed
# here traces to a real requirement:
#   demuxers/decoders - host/adapters/folder.js AUDIO_EXT, the formats the scanner indexes
#   encoders/muxers   - host/transcode.js TRANSCODE, the three formats we can emit
#   protocols         - file (folder adapter) and pipe (upstream streams on stdin)
FF_FLAGS=(
  --prefix=/ff
  --disable-everything --disable-autodetect --disable-doc --disable-debug
  --disable-ffplay --disable-ffprobe --disable-network --disable-shared --enable-static
  --enable-libmp3lame --enable-libopus
  --enable-protocol=file,pipe
  --enable-demuxer=mp3,flac,mov,aac,ogg,wav,asf,aiff,w64,caf
  --enable-decoder=mp3,mp3float,flac,aac,aac_latm,alac,vorbis,opus,wmav1,wmav2,wmapro,wmalossless,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_u8,pcm_f32le,pcm_f32be,pcm_f64le,pcm_alaw,pcm_mulaw
  --enable-encoder=libmp3lame,libopus,aac
  --enable-muxer=mp3,ogg,adts
  --enable-parser=mpegaudio,flac,aac,aac_latm,vorbis,opus
  --enable-filter=aresample,aformat,anull,atrim,asetnsamples,aselect,anullsink
  --enable-bsf=null,extract_extradata
  --extra-cflags=-I$PREFIX/include
  --extra-ldflags=-L$PREFIX/lib
  --pkg-config-flags=--static
)
if [ "$TARGET" = "linux-x64" ]; then
  # Fully static: the binary must run on whatever distro the user installed the
  # .deb or AppImage on, not just on the one it was built in.
  FF_FLAGS+=(--extra-ldflags=-static)
else
  # --pkg-config is spelled out because a cross build otherwise looks for
  # x86_64-w64-mingw32-pkg-config, which no Debian package provides. ffmpeg then
  # falls back to `false`, every dependency check "fails", and the error blames
  # opus rather than the missing tool.
  FF_FLAGS+=(--cross-prefix=${HOST}- --arch=x86_64 --target-os=mingw32 --extra-ldflags=-static --pkg-config=pkg-config)
fi

export PKG_CONFIG_PATH=$PREFIX/lib/pkgconfig
./configure "${FF_FLAGS[@]}" >/tmp/conf.log 2>&1 || { echo "--- CONFIGURE FAILED ---"; tail -30 /tmp/conf.log; tail -25 ffbuild/config.log 2>/dev/null; exit 1; }
make -j"$(nproc)" >/tmp/make.log 2>&1 || { echo "--- MAKE FAILED ---"; tail -25 /tmp/make.log; exit 1; }
# LGPL OR NOTHING. PearTune is MIT and this binary ships inside the installer, so a
# GPL ffmpeg would pull copyleft across the app - the same reason CLAUDE.md refuses
# the holesail packages. GPL is off by ffmpeg's default and no flag here turns it on,
# but assert it on the ARTIFACT rather than trusting the flags, because the flags are
# the readback and the banner is the thing.
if ./ffmpeg$EXE -version 2>/dev/null | grep -qi -- "--enable-gpl"; then
  echo "ERROR: built binary reports --enable-gpl - refusing to ship it" >&2; exit 1
fi
if ./ffmpeg$EXE -version 2>/dev/null | grep -qi -- "--enable-nonfree"; then
  echo "ERROR: built binary reports --enable-nonfree - refusing to ship it" >&2; exit 1
fi
cp ffmpeg$EXE "$OUT/ffmpeg$EXE"
"$HOST"-strip "$OUT/ffmpeg$EXE" 2>/dev/null || strip "$OUT/ffmpeg$EXE" 2>/dev/null || true
ls -la "$OUT"

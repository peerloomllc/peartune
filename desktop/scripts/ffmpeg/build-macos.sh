#!/bin/bash
# Builds the bundled ffmpeg for one macOS slice. Runs ON the Mac - build.sh ships it
# there over ssh and collects the result.  $1 = arm64 | x86_64   $2 = the output dir name
#
# Both slices are built and both are shipped in every .dmg. They are ~4MB each, which is
# far cheaper than an arch-mismatch bug that only shows up on somebody else's Mac.
#
# Same audio-only, LGPL-only rules as build-in-container.sh - see the header there.
set -euo pipefail
ARCH="$1"; OUTNAME="$2"
SRC="$HOME/peartune-ffbuild/src"
PREFIX="$HOME/peartune-ffbuild/deps-$ARCH"
OUT="$HOME/peartune-ffbuild/out/$OUTNAME"
rm -rf "$PREFIX" "$OUT"; mkdir -p "$PREFIX" "$OUT"
W="$HOME/peartune-ffbuild/work-$ARCH"; rm -rf "$W"; mkdir -p "$W"; cd "$W"

export CFLAGS="-arch $ARCH -mmacosx-version-min=11.0"
export LDFLAGS="-arch $ARCH -mmacosx-version-min=11.0"
export PATH="$PREFIX/bin:$PATH"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
HOSTFLAG=""
[ "$ARCH" = "x86_64" ] && HOSTFLAG="--host=x86_64-apple-darwin"

# pkgconf FIRST, and built for the BUILD machine rather than the target: macOS ships no
# pkg-config, ffmpeg's configure hard-requires one to find libopus, and installing a
# Homebrew formula would be a permanent change to a machine that is not ours to change.
# So it is built here, into the throwaway prefix, and thrown away with it. Native arch
# on purpose - this one is a tool that RUNS during the build, not a thing we ship.
echo ">>> pkgconf (build tool)"
tar -xJf "$SRC/pkgconf-2.3.0.tar.xz"
cd pkgconf-2.3.0
CFLAGS="" LDFLAGS="" ./configure --prefix="$PREFIX" >/dev/null
make -j"$(sysctl -n hw.ncpu)" >/dev/null && make install >/dev/null
ln -sf "$PREFIX/bin/pkgconf" "$PREFIX/bin/pkg-config"
cd "$W"

echo ">>> lame ($ARCH)"
tar -xzf "$SRC/lame-3.100.tar.gz"
cd lame-3.100
sed -i '' '/lame_init_old/d' include/libmp3lame.sym
./configure --prefix="$PREFIX" --disable-shared --enable-static \
  --disable-frontend --disable-decoder --disable-analyzer-hooks $HOSTFLAG >/dev/null
make -j"$(sysctl -n hw.ncpu)" >/dev/null && make install >/dev/null
cd "$W"

echo ">>> opus ($ARCH)"
tar -xzf "$SRC/opus-1.5.2.tar.gz"
cd opus-1.5.2
./configure --prefix="$PREFIX" --disable-shared --enable-static \
  --disable-doc --disable-extra-programs $HOSTFLAG >/dev/null
make -j"$(sysctl -n hw.ncpu)" >/dev/null && make install >/dev/null
cd "$W"

echo ">>> ffmpeg ($ARCH)"
tar -xJf "$SRC/ffmpeg-7.1.tar.xz"
cd ffmpeg-7.1
FF=(
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
  --extra-cflags="-I$PREFIX/include -arch $ARCH -mmacosx-version-min=11.0"
  --extra-ldflags="-L$PREFIX/lib -arch $ARCH -mmacosx-version-min=11.0"
  --pkg-config="$PREFIX/bin/pkgconf" --pkg-config-flags=--static
  --arch="$ARCH"
)
# Cross-building the Intel slice on an Apple Silicon mac: configure must be told not to
# run what it just compiled, or every check fails with "Bad CPU type in executable".
[ "$ARCH" = "x86_64" ] && FF+=(--enable-cross-compile --target-os=darwin --cc=clang)

unset CFLAGS LDFLAGS
./configure "${FF[@]}" >/tmp/ffconf-$ARCH.log 2>&1 || { echo "--- CONFIGURE FAILED ($ARCH) ---"; tail -25 /tmp/ffconf-$ARCH.log; exit 1; }
make -j"$(sysctl -n hw.ncpu)" >/tmp/ffmake-$ARCH.log 2>&1 || { echo "--- MAKE FAILED ($ARCH) ---"; tail -25 /tmp/ffmake-$ARCH.log; exit 1; }

# Assert on the ARTIFACT, not the flags. See the same check in the Linux builder.
if ./ffmpeg -version 2>/dev/null | grep -qi -- "--enable-gpl"; then
  echo "ERROR: $ARCH binary reports --enable-gpl - refusing" >&2; exit 1
fi
strip ffmpeg 2>/dev/null || true
cp ffmpeg "$OUT/ffmpeg"
ls -la "$OUT/ffmpeg"
file "$OUT/ffmpeg"

#!/usr/bin/env bash
# Regenerate test/fixtures/music - the tagged library the folder adapter is tested
# against.
#
# The fixtures are COMMITTED, and that is deliberate: `npm run verify` must be green
# on a machine with no ffmpeg. This script exists so they can be rebuilt, not so
# they can be built on demand.
#
# Every file is one second of silence, so the whole library is a few dozen KB. What
# matters is the TAGS, and each directory here is a case that broke a real music
# scanner at some point:
#
#   Led Zeppelin/IV        - the easy one: full tags, embedded cover art
#   Pink Floyd/The Wall    - ONE album split across two disc folders. Must merge.
#   Compilations/...       - one album, two different track artists, NO albumartist
#                            tag. Must NOT splinter into two albums.
#   Untagged               - no tags at all. The directory is the album.
#   Handel/Messiah         - no embedded art, a cover.jpg beside the music instead.
#
# Usage: scripts/make-music-fixtures.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)/test/fixtures/music"
rm -rf "$root"
mkdir -p "$root"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# A 1x1 red JPEG, and a blue one, so a test can tell "the embedded cover" from "the
# cover.jpg next to it" by looking at the bytes.
ffmpeg -v error -f lavfi -i color=c=red:s=32x32:d=1 -frames:v 1 "$tmp/embedded.jpg"
ffmpeg -v error -f lavfi -i color=c=blue:s=32x32:d=1 -frames:v 1 "$tmp/external.jpg"

# The duration belongs to the SOURCE FILTER, not to the command line. Written as
# `-t 1` it is a positional option, and any later `-i` (the cover art) turns it into
# an option for THAT input instead - which leaves the silence unbounded and ffmpeg
# happily writing gigabytes.
silence() { ffmpeg -v error -f lavfi -i anullsrc=r=44100:cl=mono:duration=1 "$@"; }

# --- Led Zeppelin / IV: MP3 + ID3v2, embedded art -----------------------------
mkdir -p "$root/Led Zeppelin/IV"
for i in 1 2; do
  case $i in
    1) title="Black Dog" ;;
    2) title="Rock and Roll" ;;
  esac
  silence -i "$tmp/embedded.jpg" -map 0:a -map 1:v -c:v copy -id3v2_version 3 \
    -metadata title="$title" \
    -metadata artist="Led Zeppelin" \
    -metadata album_artist="Led Zeppelin" \
    -metadata album="Led Zeppelin IV" \
    -metadata track="$i/8" \
    -metadata disc="1/1" \
    -metadata date="1971" \
    -metadata genre="Rock" \
    -disposition:v attached_pic \
    "$root/Led Zeppelin/IV/0$i $title.mp3"
done

# --- Pink Floyd / The Wall: FLAC + Vorbis comments, ONE album, TWO disc dirs ---
mkdir -p "$root/Pink Floyd/The Wall/CD1" "$root/Pink Floyd/The Wall/CD2"
silence -metadata title="In the Flesh" -metadata artist="Pink Floyd" \
  -metadata ALBUMARTIST="Pink Floyd" -metadata album="The Wall" \
  -metadata track="1" -metadata disc="1" -metadata date="1979" \
  "$root/Pink Floyd/The Wall/CD1/01 In the Flesh.flac"
silence -metadata title="Hey You" -metadata artist="Pink Floyd" \
  -metadata ALBUMARTIST="Pink Floyd" -metadata album="The Wall" \
  -metadata track="1" -metadata disc="2" -metadata date="1979" \
  "$root/Pink Floyd/The Wall/CD2/01 Hey You.flac"

# --- A compilation: no albumartist tag, two different artists, one folder ------
mkdir -p "$root/Compilations/Test Hits"
silence -metadata title="Song A" -metadata artist="Artist A" \
  -metadata album="Test Hits" -metadata track="1" -metadata date="2001" \
  "$root/Compilations/Test Hits/01 Song A.m4a"
silence -metadata title="Song B" -metadata artist="Artist B" \
  -metadata album="Test Hits" -metadata track="2" -metadata date="2001" \
  "$root/Compilations/Test Hits/02 Song B.m4a"

# --- No tags at all. The directory is the album, the filename is the title ----
mkdir -p "$root/Untagged"
silence -map_metadata -1 "$root/Untagged/mystery recording.mp3"

# --- No embedded art; a cover.jpg beside the music ----------------------------
mkdir -p "$root/Handel/Messiah"
silence -metadata title="Hallelujah" -metadata artist="George Frideric Handel" \
  -metadata album_artist="George Frideric Handel" -metadata album="Messiah" \
  -metadata track="1" -metadata date="1741" \
  "$root/Handel/Messiah/01 Hallelujah.mp3"
cp "$tmp/external.jpg" "$root/Handel/Messiah/cover.jpg"

# Not audio. Must be ignored, not listed as a track.
echo "not music" > "$root/Handel/Messiah/notes.txt"

find "$root" -type f | sort
du -sh "$root"

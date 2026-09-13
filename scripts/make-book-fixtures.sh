#!/usr/bin/env bash
# Regenerate test/fixtures/books - the tiny audiobooks the folder adapter's book tests
# run against (proposals/2026-09-13-audiobooks.md, slice 1).
#
# COMMITTED, like test/fixtures/music, so `npm run verify` stays green on a machine
# with no ffmpeg. Full-length books for device testing are a different script:
# scripts/make-audiobook-samples.sh.
#
#   Short Book/Short Book.m4b    2 s, two chapters, embedded cover. A book by its
#                                extension alone, whatever folder it sits in.
#   Book in Parts/0N Part N.mp3  two 1 s mp3s, no cover. Music, UNLESS their folder
#                                root is marked as Audiobooks.
#
# Usage: scripts/make-book-fixtures.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)/test/fixtures/books"
rm -rf "$root"
mkdir -p "$root/Short Book" "$root/Book in Parts"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

ffmpeg -v error -f lavfi -i color=c=red:s=32x32:d=1 -frames:v 1 "$tmp/cover.jpg"
printf ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=Chapter One\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=1000\nEND=2000\ntitle=Chapter Two\n' > "$tmp/meta.txt"

# Duration on the source filter, not `-t`: see the note in make-music-fixtures.sh.
ffmpeg -v error -f lavfi -i anullsrc=r=22050:cl=mono:duration=2 -i "$tmp/meta.txt" -i "$tmp/cover.jpg" \
  -map 0:a -map 2:v -map_metadata 1 -map_chapters 1 -c:a aac -b:a 32k -c:v copy \
  -disposition:v attached_pic \
  -metadata title="Short Book" -metadata album="Short Book" \
  -metadata artist="Test Author" -metadata album_artist="Test Author" \
  -metadata genre="Audiobook" \
  -f mp4 "$root/Short Book/Short Book.m4b"

for p in 1 2; do
  ffmpeg -v error -f lavfi -i anullsrc=r=22050:cl=mono:duration=1 -c:a libmp3lame -b:a 32k -id3v2_version 3 \
    -metadata title="Part $p" -metadata album="Book in Parts" \
    -metadata artist="Test Author" -metadata track="$p/2" \
    "$root/Book in Parts/0$p Part $p.mp3"
done

# --- chapter layouts (test/fixtures/chapters) ---------------------------------
# One 3 s, three-chapter m4b in each way a real book stores its chapters, for the chapter
# reader (host/chapters.js). NOT under books/, so they do not change the library tests.
#   end-index.m4b    ffmpeg's default: index (moov) at the END, both chpl and a chapter track
#   start-index.m4b  -movflags +faststart: index at the start
#   track-only.m4b   +disable_chpl: only the QuickTime chapter track, no Nero chpl list
#   no-chapters.m4a  none at all
chap="$(dirname "$root")/chapters"
rm -rf "$chap"
mkdir -p "$chap"
printf ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=Opening\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=1000\nEND=2000\ntitle=The Middle, Part Two\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=2000\nEND=3000\ntitle=Caf\xc3\xa9 Ending\n' > "$tmp/chap.txt"
three() { ffmpeg -v error -f lavfi -i anullsrc=r=22050:cl=mono:duration=3 -i "$tmp/chap.txt" -map 0:a -map_metadata 1 -map_chapters 1 -c:a aac -b:a 32k "$@"; }
three -f mp4 "$chap/end-index.m4b"
three -movflags +faststart -f mp4 "$chap/start-index.m4b"
three -movflags +disable_chpl -f mp4 "$chap/track-only.m4b"
ffmpeg -v error -f lavfi -i anullsrc=r=22050:cl=mono:duration=1 -c:a aac -b:a 32k -f mp4 "$chap/no-chapters.m4a"

du -ah "$root" "$chap"

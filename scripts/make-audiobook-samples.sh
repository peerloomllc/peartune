#!/usr/bin/env bash
# Build full-length sample audiobooks for testing on real devices
# (proposals/2026-09-13-audiobooks.md, "Test environment").
#
# NOT unit-test fixtures. Those are tiny and committed, and arrive with slice 1 of the
# proposal next to the tests that use them. These are hours long, so they are built on
# demand and copied to a test host (the Umbrel's /library/audiobooks, which the
# Audiobookshelf app there reads too).
#
# Every book is spoken markers over quiet brown noise: espeak-ng reads "<book>,
# chapter N, minute M" at a fixed interval. So whatever the player shows can be checked
# by ear - after a seek, a resume, a chapter jump or a speed change you HEAR where you
# are. The noise is there for SIZE: AAC squeezes silence to almost nothing (a silent
# 10-hour book came out at 7.5 MB), and a real book at 64 kb/s is about 290 MB, which
# is what the cache and bandwidth need to be tested against.
#
#   The Short Book/The Short Book.m4b  one file, 3 chapters x 3 min, marker every 30 s,
#                                      index at the START (-movflags +faststart)
#   The M4A Book/The M4A Book.m4a      one file, 3 chapters x 3 min, .m4a not .m4b,
#                                      index at the END (ffmpeg's default)
#   The Book in Parts/NN Part N.mp3    5 files x 3 min, cover.jpg beside them,
#                                      no chapters (each part is a track)
#   The Long Book/The Long Book.m4b    one file, 10 chapters x 60 min, marker every
#                                      5 min, index at the END (resume near the end,
#                                      deep seeks, a big file)
#
# Both index layouts on purpose. Found while building these (2026-09-13): the host's tag
# reader (music-metadata 11.14, includeChapters) sees NO chapters when the index is at
# the end, and only the FIRST chapter when ffmpeg stores all chapter titles in one
# chunk, which it does. ffprobe -show_chapters reads all of them in both layouts.
#
# Each book has its own cover colour, embedded in the single-file books.
#
# Usage: scripts/make-audiobook-samples.sh [outdir]   (default: ./audiobook-samples)
# Needs ffmpeg, ffprobe and espeak-ng. The long book takes a few minutes.
set -euo pipefail

out="${1:-audiobook-samples}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for bin in ffmpeg ffprobe espeak-ng; do
  command -v "$bin" >/dev/null || { echo "missing: $bin" >&2; exit 1; }
done

AUTHOR="PearTune Test Author"
RATE=22050

cover() { # cover <colour> <file>
  ffmpeg -v error -y -f lavfi -i "color=c=$1:s=600x600:d=1" -frames:v 1 "$2"
}

# chapter_audio <book> <chapter> <minutes> <interval-seconds> <out.m4a>
# One chapter: a spoken marker at 0, interval, 2*interval... each padded with silence
# to exactly <interval> seconds, mixed over quiet noise and encoded as 64 kb/s AAC.
chapter_audio() {
  local book="$1" ch="$2" mins="$3" step="$4" dst="$5"
  local n=$(( mins * 60 / step )) list="$tmp/list-$ch.txt" i at label
  : > "$list"
  for (( i = 0; i < n; i++ )); do
    at=$(( i * step ))
    if (( at % 60 == 0 )); then label="minute $(( at / 60 ))"
    else label="minute $(( at / 60 )), $(( at % 60 )) seconds"; fi
    espeak-ng -s 170 -w "$tmp/say.wav" "$book. Chapter $ch. $label."
    ffmpeg -v error -y -i "$tmp/say.wav" -af "apad=whole_dur=$step,atrim=0:$step" \
      -ar $RATE -ac 1 "$tmp/m-$ch-$i.wav"
    echo "file '$tmp/m-$ch-$i.wav'" >> "$list"
  done
  ffmpeg -v error -y -f concat -safe 0 -i "$list" \
    -f lavfi -i "anoisesrc=color=brown:amplitude=0.02:sample_rate=$RATE:duration=$(( n * step ))" \
    -filter_complex "[0:a][1:a]amix=inputs=2:duration=first:normalize=0" \
    -c:a aac -b:a 64k -ar $RATE -ac 1 "$dst"
  rm -f "$tmp"/m-"$ch"-*.wav
}

# single_file_book <title> <chapters> <minutes-each> <interval> <colour> <ext> <start|end>
# The last argument is where the index (moov) goes: start = -movflags +faststart.
single_file_book() {
  local title="$1" chapters="$2" mins="$3" step="$4" colour="$5" ext="$6" index="$7"
  local flags=()
  [ "$index" = start ] && flags=(-movflags +faststart)
  local dir="$out/$title" meta="$tmp/meta.txt" list="$tmp/chapters.txt" c start=0 dur
  mkdir -p "$dir"
  printf ';FFMETADATA1\n' > "$meta"
  : > "$list"
  for (( c = 1; c <= chapters; c++ )); do
    echo "  $title: chapter $c of $chapters"
    chapter_audio "$title" "$c" "$mins" "$step" "$tmp/ch-$c.m4a"
    echo "file '$tmp/ch-$c.m4a'" >> "$list"
    # Real encoded length, so chapter starts line up with what the file holds.
    dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$tmp/ch-$c.m4a")
    dur=$(awk -v d="$dur" 'BEGIN { printf "%d", d * 1000 }')
    printf '[CHAPTER]\nTIMEBASE=1/1000\nSTART=%d\nEND=%d\ntitle=Chapter %d\n' \
      "$start" $(( start + dur )) "$c" >> "$meta"
    start=$(( start + dur ))
  done
  ffmpeg -v error -y -f concat -safe 0 -i "$list" -c copy "$tmp/joined.m4a"
  cover "$colour" "$tmp/cover.jpg"
  ffmpeg -v error -y -i "$tmp/joined.m4a" -i "$meta" -i "$tmp/cover.jpg" \
    -map 0:a -map 2:v -map_metadata 1 -map_chapters 1 -c:a copy -c:v copy \
    -disposition:v attached_pic ${flags[@]+"${flags[@]}"} \
    -metadata title="$title" -metadata album="$title" \
    -metadata artist="$AUTHOR" -metadata album_artist="$AUTHOR" \
    -metadata genre="Audiobook" -metadata date="2026" \
    -f mp4 "$dir/$title.$ext"
  rm -f "$tmp"/ch-*.m4a "$tmp/joined.m4a"
}

parts_book() {
  local title="The Book in Parts" dir="$out/The Book in Parts" p
  mkdir -p "$dir"
  cover purple "$dir/cover.jpg"
  for p in 1 2 3 4 5; do
    echo "  $title: part $p of 5"
    chapter_audio "$title, part $p" 1 3 30 "$tmp/part.m4a"
    ffmpeg -v error -y -i "$tmp/part.m4a" -c:a libmp3lame -b:a 64k -id3v2_version 3 \
      -metadata title="Part $p" -metadata album="$title" \
      -metadata artist="$AUTHOR" -metadata album_artist="$AUTHOR" \
      -metadata track="$p/5" -metadata genre="Audiobook" -metadata date="2026" \
      "$dir/0$p Part $p.mp3"
  done
  rm -f "$tmp/part.m4a"
}

single_file_book "The Short Book" 3 3 30 teal m4b start
single_file_book "The M4A Book" 3 3 30 orange m4a end
parts_book
single_file_book "The Long Book" 10 60 300 navy m4b end

echo "done: $out"
du -sh "$out"/*

#!/usr/bin/env bash
# Snapshot one GENRE of a real, paired library into a screenshot fixture.
#
# The store screenshots use Tim's own library filtered to Synthwave (TODO.md, decided
# 2026-07-30): 76 albums, so the grids are genuinely full, by independent artists nobody
# would recognise. Capturing that slice ONCE into a fixture means the capture scripts do
# not need a paired, connected phone every time they run.
#
# THE OUTPUT IS DELIBERATELY GITIGNORED. The covers are real, commercial album art:
# acceptable in a store listing that Tim publishes, NOT acceptable committed to a public
# MIT repo where it would live in git history forever. Only the finished PNGs carry it.
# Nobody but Tim can regenerate this anyway - it is his library.
#
# Usage (with a paired phone on adb, app running and CONNECTED):
#   ./scripts/screenshot-fixture.sh                       # TCL, genre Synthwave
#   SERIAL=... GENRE="Witch House" ./scripts/screenshot-fixture.sh
#
# How it gets the art: album rows carry an `art` URL served by the app's own loopback
# shim, so it is only reachable from INSIDE the phone. We ask the WebView to fetch each
# one, which lands it in the on-device art cache, then pull that cache over adb. Fetching
# is what populates it - the cache only holds covers the app has actually displayed.

set -euo pipefail

SERIAL="${SERIAL:-4H65K7MFZXSCSWPR}"
GENRE="${GENRE:-Synthwave}"
PORT="${PORT:-9333}"
SIZE="${SIZE:-500}"                       # a HINT; the shim picks its own, so never assert on it
PKG="${PKG:-com.peartune.debug}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/metadata/screenshot-fixtures"
CDP="$(dirname "$0")/cdp.sh"

[ -x "$CDP" ] || { echo "need cdp.sh beside this script (see TODO/DONE for the helper)" >&2; exit 1; }

mkdir -p "$OUT/covers"
echo "== $GENRE from $SERIAL =="

# 1. The album rows. Also forces each cover through the shim so the on-device cache has
#    it - done in the same pass so a slow library is only walked once.
"$CDP" "$SERIAL" "$PORT" "$(cat <<EOF
(async () => {
  const gs = (await __probe('genres', {})).result
  const list = gs.items || gs
  const g = list.find(x => x.name === ${GENRE@Q})
  if (!g) return JSON.stringify({ error: 'no such genre: ' + ${GENRE@Q} })
  const r = (await __probe('genre', { id: g.id })).result
  const albums = (r.albums || r.items || [])
  let warmed = 0
  for (const a of albums) {
    if (!a.art) continue
    // An IMAGE, not fetch(). The shim is a different ORIGIN from the WebView, so fetch()
    // is a CORS request and the shim sends no CORS headers - every one fails silently.
    // <img> is how the app itself loads art and is not subject to that.
    const ok = await new Promise((res) => {
      const im = new Image()
      im.onload = () => res(true); im.onerror = () => res(false)
      im.src = a.art + '?size=${SIZE}'
      setTimeout(() => res(false), 8000)
    })
    if (ok) warmed++
  }
  return JSON.stringify({ genre: g.name, warmed, albums })
})()
EOF
)" > "$OUT/$GENRE.raw.json"

python3 - "$OUT/$GENRE.raw.json" "$OUT/$GENRE.json" <<'PY'
import json, sys
raw = json.load(open(sys.argv[1]))          # cdp.sh prints the JS return value as JSON
data = json.loads(raw) if isinstance(raw, str) else raw
if data.get('error'):
    sys.exit(data['error'])
albums = data['albums']
# A fixture with no covers is useless, and "0 warmed" once looked exactly like success -
# the covers on disk were leftovers from ordinary browsing. Fail rather than report done.
if data.get('warmed', 0) == 0:
    sys.exit('warmed 0 covers - the art never loaded, so this fixture would be empty. '
             'Is the app CONNECTED to the library? (a disconnected phone serves no art)')
# Keep only what a fixture needs to RENDER. Dropping the loopback `art` URL on purpose:
# its port changes every launch, so a stored one is a trap for whoever reads this later.
slim = [{k: a.get(k) for k in ('id', 'name', 'artist', 'year', 'songCount', 'coverId', 'libraryId')} for a in albums]
json.dump({'genre': data['genre'], 'count': len(slim), 'albums': slim}, open(sys.argv[2], 'w'), indent=1)
print(f"  {len(slim)} albums, {data['warmed']} covers warmed")
PY
rm -f "$OUT/$GENRE.raw.json"

# 2. Pull the warmed covers. run-as reaches the app's private dir on a debuggable build.
echo "== pulling covers =="
adb -s "$SERIAL" shell "run-as $PKG tar -cf - -C files/peartune/art . 2>/dev/null" \
  | tar -xf - -C "$OUT/covers" 2>/dev/null || true
# Assert what MATTERS - every album in the fixture has a cover file - not a count at one
# size. The shim serves whatever size it likes (the cache holds @300, @350 and @500 side by
# side), so counting one size measured nothing: it read 13 of 76 while all 76 were present.
python3 - "$OUT/$GENRE.json" "$OUT/covers" <<'COVERCHECK'
import json, os, sys
fx = json.load(open(sys.argv[1]))
have = {f.split('@')[0] for f in os.listdir(sys.argv[2])}
ids = [a['coverId'] for a in fx['albums'] if a.get('coverId')]
missing = [i for i in ids if i not in have]
print(f"  {len(ids) - len(missing)}/{len(ids)} albums have a cover on disk")
if missing:
    sys.exit(f"  {len(missing)} albums have NO cover - the grid would show gaps")
COVERCHECK
echo "== done: $OUT/$GENRE.json =="

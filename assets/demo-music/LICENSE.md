# Demo music — licence and provenance

These five tracks ship **inside the app binary** for the "Try it without a server"
demo path (`proposals/2026-07-28-app-review-demo.md`). Because they are
redistributed in a shipped product, the licence has to be unambiguous rather than
merely probable. It is recorded here so nobody has to re-derive it later.

## Licence

**CC0 1.0 Universal (Public Domain Dedication)** —
<https://creativecommons.org/publicdomain/zero/1.0/>

CC0 waives all rights worldwide. **No attribution is required**, commercial use is
permitted, and modification is permitted. There is no obligation to satisfy and no
condition that can be breached.

We credit the artist anyway, in About, because it costs nothing and it is the
decent thing to do — but that is a courtesy, not a licence term, and removing it
would not create a problem.

## Where they came from

- **Artist:** Loyalty Freak Music
- **Album:** *LOFI AMBIENT SONGS !* (2021)
- **Artist's site:** <https://loyaltyfreakmusic.com/>
- **Source download:** <https://archive.org/details/loyalty-freak-music-lofi-ambient-songs>

The archive.org item carries `licenseurl: creativecommons.org/publicdomain/zero/1.0/`,
**and** the artist's own site states a CC0 policy. Both were checked, deliberately:
archive.org's licence field is user-supplied and is not trustworthy on its own.
While searching for this music that same field returned a "CC0" Alexander Desplat
soundtrack and a Beatles covers album, neither of which is remotely public domain.
A single source would not have been evidence.

**CORRECTED 2026-07-30.** This section previously said the artist's site states CC0
"for their whole catalogue". It does not, and the difference matters for anything
added later. The FAQ says:

> 98 % of my work is under Creative Commons 0, so you can remix, use it in a
> commercial way and don't even need to credit me to use it. [...] **Check the
> description of the album to see the license if you want to be sure.**

So the site is a *policy*, not a per-album guarantee, and it names the remaining
~2% as an explicit exception without listing which. The five tracks here are still
sound: their own archive.org item is explicitly CC0 and its description says nothing
to the contrary, which is two independent sources for *this* album. But the earlier
wording would have let someone add a seventh album on the strength of the site alone.

**So the rule for adding any further demo music is per-ALBUM, not per-artist:**

1. The album's own `archive.org/metadata/<id>` must carry the CC0 `licenseurl`, and
2. that item's own description must not state a different licence, and
3. where the artist's site has a page for the album, its description must agree.

One album passing does not carry another, even by the same artist.

## Tracks

| # | Title | Original track no. |
|---|-------|--------------------|
| 1 | Lack of Color - Drowning in your smile | 1 |
| 2 | Lack of Color - Dancing in the street | 2 |
| 3 | Lack of Color - Aeroplane | 3 |
| 4 | Lack of Color - I'm glad you are here with me | 4 |
| 5 | Lack of Color - Sugar and coffee | **8** |

## What we changed, and why

CC0 permits both of these without asking. Recorded so the files are not mistaken
for pristine copies of the originals:

1. **Re-encoded from ~320 kbps to 192 kbps.** Halves the download cost, 29.7 MB →
   17.9 MB, which is what keeps this inside the size budget the proposal set.
   ID3 tags and embedded cover art were preserved (`-map 0 -c:v copy`).
2. **The fifth track was renumbered from 8 to 5.** This is a five-track subset, and
   tags reading 1, 2, 3, 4, 8 would render as a gap in the album view — which in a
   *demo* reads as "the app failed to load something", the exact opposite of the
   impression it exists to give.
3. **A genre, `Lo-Fi`, was added in `manifest.json` only.** The files themselves
   carry no genre frame, so the Genres view would otherwise be empty — again, a
   working app looking broken. It is taken from the album's own title (*LOFI
   AMBIENT SONGS !*), not invented, and it lives in our manifest rather than in
   the ID3 tags so the files stay as they came.
4. **The cover art is named `cover.bin`, not `cover.jpg`.** The bytes are an unmodified
   JPEG. The extension is the change, and it is forced on us: React Native's Android
   asset packager turns anything it recognises as an image into a drawable *resource*,
   which the app can name but cannot open as a file - so the cover would never reach
   the art store. See `metro.config.js`.

Nothing else was touched: titles, artist, album and year are the artist's own.

## Why instrumental mattered

Chosen partly because there are no lyrics. Bundled vocal content would pull the
app's content rating into scope at submission, for no benefit to a demo whose job
is to show that playback works.

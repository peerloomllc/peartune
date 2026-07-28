# A demo mode, so App Review can actually use the app

**Goal** — give an App Store reviewer (and a curious first-run user) a working
PearTune without a server, so the app is not rejected for being unusable.

**Tier** — **T2.** App-only. No wire change, no host change, no change to grants,
pairing or the security boundary. It earns T2 on shipping audio in the bundle and
adding a first-run path that bypasses onboarding.

---

## Why this is a release blocker and not a nicety

PearTune has no account and no cloud. A reviewer installs it, opens it, and is
asked to scan a pairing code from a dashboard on a machine they do not own. There
is nothing to log into and nothing to tap. That is
**Guideline 2.1, App Completeness** — the most common rejection reason there is —
and it is a fair reading: from where they sit, the app does nothing.

Play has the same problem in a milder form, and a rejection there costs less.

### The obvious fix does not work, and this is the load-bearing finding

"Put a pairing link in the review notes" is what everyone reaches for. It cannot
work here, for two reasons in the code rather than two reasons in principle:

- `PAIR_TTL_MS` is **5 minutes** (`protocol/constants.js`).
- The window **closes on the first successful pair** (`host/pair.js`,
  `this.close('paired')`).

So a link is both short-lived **and** single-use. A reviewer opening the app a day
later has nothing. Two reviewers, or one reviewer retrying after a rejection, and
the second gets nothing even inside the window. There is no version of "paste a
link into App Store Connect" that survives contact with an unattended reviewer.

### And the workaround for THAT is worse than the problem

The way to make a link work would be a **standing invite**: long-lived,
multi-use. That is not a small flag. `host/pair.js` says what the window is for:

> The window IS the security boundary for a first pair: there is nothing yet to
> check a newcomer against, so trust reduces to "the operator opened a session
> just now, and this device holds the token from that session".

A never-expiring, unlimited-use invite is precisely the negation of that
sentence, and the code path would exist in **every** host — including the ones
strangers run for their friends — to solve a problem in Apple's review queue.
That trade is not worth making. **Rejected, deliberately, and recorded here so it
is not re-proposed as an easy win.**

---

## What to build instead

**A "Try it without a server" path on the onboarding intro card.** It plays a
handful of tracks shipped inside the app. No pairing, no host, no network, no
grant. A reviewer can browse, play, pause, seek, use the lock screen and see the
player skins — every user-facing surface except pairing itself, which is
demonstrated in the video.

It is not a review trick. Someone who installs PearTune before setting up a
server currently sees a wall; this gives them the app working in their hand while
they decide whether to run a library. That is the honest argument for building
it, and the reason it should stay in the product afterwards rather than being
stripped before release.

### Shape

- Demo tracks live in the bundle as ordinary assets. The audio shim already
  serves from local disk for cached tracks; the demo library should reuse that
  path rather than inventing a second player route.
- The demo library is **read-only and clearly labelled**. It must never look like
  a paired library: no revoke, no requests, no favourites syncing anywhere, and
  the library switcher should name it something unmistakable ("Demo music").
- Leaving demo mode is a first-class action, not a reinstall. Pairing a real
  library from inside demo mode should just work, and should retire the demo
  library from the blend at that point.
- Nothing about demo mode may touch the grant store, the identity keypair, or the
  pairing window.

### The constraint that decides the music

Every bundled track must be licensed for redistribution **inside a shipped
binary**: CC0, CC-BY, or public domain, with attribution carried in About where
CC-BY requires it. Never Tim's own collection, and never "probably fine".
Sourcing the music is a real task, not a footnote — budget for it.

Three to five tracks is enough to browse an album and hear gapless playback. At
~4 MB each that is 12–20 MB on the download, which is acceptable for a music app.

---

## Also required, regardless

**A demo video in the review notes**, showing the full flow end to end: install
the host, open the dashboard, pair a phone, browse, play, revoke. Apple accepts a
video for apps that need hardware or a service the reviewer cannot have, and it
costs about an hour. It is the fallback if the reviewer never finds the demo
path, and it is cheap enough that there is no reason to skip it even once demo
mode ships.

**Review notes that say the quiet part plainly**: there is no account by design,
the app plays music from a server the user runs, and here is the demo path plus
the video. Notes alone are not sufficient — but omitting them wastes the one
place Apple lets you explain yourself.

---

## Open questions

1. **Which music.** Needs actual sourcing and licence verification, with the
   licence recorded in the repo next to the files.
2. **Where the demo library appears in the blend.** Simplest is: only when nothing
   real is paired. Worth checking against the merged-library code before assuming.
3. **Whether Play needs the same thing.** Probably yes eventually; the rejection
   risk is lower, so it can follow.
4. **Whether demo mode should be reachable after pairing** (a "show me the demo
   again" affordance) or is strictly a first-run state.

## Verify

Beyond `npm run verify`: install on a device with **no** pairings and confirm the
demo path plays without any network at all — airplane mode is the honest test,
because it proves no host is involved.

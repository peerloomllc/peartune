# Third-party content bundled in PearTune

Two things ship *inside* the app that PearTune did not write. This file records what they are
and under what terms, in one place, because "do you have the rights to it" is a question the
app stores ask directly and the answer should not have to be reconstructed.

This is about **content bundled in the binary**, not about npm dependencies - those carry their
own licences in `node_modules` and are listed in `package.json`.

## The Manrope typeface - SIL Open Font License 1.1

> Copyright 2018 The Manrope Project Authors (https://github.com/sharanda/manrope),
> with Reserved Font Name "Manrope".

Full licence text: [`assets/fonts/OFL.txt`](assets/fonts/OFL.txt).

Manrope is the app's typeface and the dashboard's. It is embedded as base64 woff2 inside
`src/ui/fonts.js`, which is generated, so it ships in the phone binary **and** inside the
host's `dashboard.html`.

**The OFL is permissive but not condition-free**, which is why this file exists. Clause 2
requires that every copy bundled with software carry the copyright notice and licence, in text
or in metadata a user can reach. Clause 1 forbids selling the font on its own, which PearTune
does not do, and clause 3 reserves the name for unmodified versions - the font is embedded
as-published, unmodified.

## The demo music - CC0 1.0 (public domain)

Five tracks by **Loyalty Freak Music**, shipped for the "I don't have one yet" path so the app
is usable before anyone has a server.

Full provenance, and the two independent checks made on the licence, are in
[`assets/demo-music/LICENSE.md`](assets/demo-music/LICENSE.md).

CC0 waives all rights worldwide: no attribution is required, commercial use and modification
are permitted, and there is no condition that can be breached. The app credits the artist in
its About tab anyway, as a courtesy rather than an obligation.

## What is *not* bundled

**Your music.** PearTune plays a library that lives on a machine the listener runs, streamed
over a direct connection while it plays. No copy of it is made on anyone else's hardware, and
none of it ships with the app.

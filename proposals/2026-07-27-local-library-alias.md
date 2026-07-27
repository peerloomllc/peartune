# A local alias for a library

**Goal** - let you call a library whatever you want ON YOUR OWN PHONE, without
touching the server it came from and without needing to own that server.

**Tier** - **T2.** One new optional persisted field (`alias` on the `hosts.json`
record) and one new IPC method. No wire change, no host change: the alias never
leaves the phone.

---

## Why

A library is named by its HOST. `identity.get` carries `libraryName`, the app
stores it, and every rename path (`syncHostNames`, the `library-renamed` push,
`addHost` on a re-pair) overwrites the stored name with whatever the server just
said. That is correct for a library you run. It is useless for a library you do
not:

- **You cannot relabel a friend's library at all.** There is no path that sets a
  name the host did not push, so "My Library" stays "My Library" no matter how
  little that tells you.
- **The #suffix is a disambiguator, not a name.** PR #212 made two same-named
  libraries distinguishable - "My Library #jud4" / "My Library #rxtj" - because
  the desktop host ships with `--name "My Library"` and two friends running
  defaults gave you two identical rows in the switcher, the chips, Settings, the
  request list and the Manage picker. It works, and it means nothing to a human.
  `jud4` is the right four characters for a bug report and the wrong four for
  someone deciding which library to play from.

Tim agreed to this as the follow-up to #212. The suffix fixed "I cannot tell
these apart"; the alias fixes "I cannot tell what these ARE".

The shape is already half-built. `libraryLabels()` in `worklet/hosts.js` is the
single place the app decides what a library is called, `labelFor()` in
`src/bare.js` funnels every user-facing payload through it, and the comment on
`libraryLabels` already anticipates this: *"the stored libraryName stays exactly
what the host said, so a later rename (or an alias) has something honest to
compare against."*

---

## Scope

### In

**1. `alias` on the host record.** Optional, absent by default. `record()` carries
it when it is a non-empty trimmed string and omits the key otherwise, so a file
written before this change and a file written after it are the same shape for a
library with no alias. No migration, no version bump.

**2. `setAlias(raw, hostKey, alias)` in `worklet/hosts.js`.** Pure, unit-tested,
alongside `renameHost`. Trims, caps at 40 characters, and treats an empty or
whitespace-only string as CLEAR (delete the key, fall back to the host's name).
A missing hostKey is a no-op, matching `renameHost`.

**3. `libraryLabels()` prefers the alias, and the clash rule runs on the result.**
The effective name becomes `alias || libraryName || 'Library'`, and the tally that
decides whether to append `#jud4` counts EFFECTIVE names. So:

| Libraries | Labels |
| --- | --- |
| "My Library", "My Library" | `My Library #jud4`, `My Library #rxtj` (today) |
| alias "Sam's music", "My Library" | `Sam's music`, `My Library` |
| alias "Music", alias "Music" | `Music #jud4`, `Music #rxtj` |
| alias "My Library", host-named "My Library" | `My Library #jud4`, `My Library #rxtj` |

That last row is the reason the clash check must move behind the alias rather than
in front of it: an alias can COLLIDE with a name a host pushes, and the pair still
has to be tellable apart.

**4. `setLibraryAlias({ hostKey, alias })` in `src/bare.js`.** Saves via
`setAlias`, emits `host:renamed` with the new label, returns `listHostsData()`.
`listHostsData()` also starts returning `hostName` (the raw stored server name)
next to the label, so the UI can show both.

**5. The three `host:renamed` emits go through `labelFor()`.** Today
`src/bare.js:619`, `:1177` and `:2157` push the RAW server name to the UI. With an
alias set that is a live bug: an operator renaming their library would flash their
name over your alias in the header and the switcher until the next full reload.
Every emit sends the label instead. The STORED `libraryName` keeps tracking the
server exactly as it does now - that is what makes clearing an alias reveal the
server's CURRENT name rather than a stale one.

**6. Settings > Libraries gets a pencil.** Beside the existing trash button, it
opens a small text sheet prefilled with the current alias, placeholdered with the
host's name. Saving sets it; clearing the field reverts to the host's name. When
an alias is set, the row's sub-line says what the server calls it, so the mapping
is discoverable and a server-side rename is never invisible.

Everything else relabels for free. The header, the source-filter chips, the merged
status, the request rows, the You > Manage picker and the switcher all render
`labelFor()` output already.

### Out

- **No host change and no wire change.** The alias is never sent anywhere. The app
  has never sent a library name to a host (`host/server.js:244` is the operator
  renaming their own library from the dashboard) and this does not start.
- **It does not sync between your own devices.** Deliberate. Syncing it would mean
  storing it on the host, which (a) makes it host state rather than phone state,
  a much bigger T2, and (b) tells your friend's server the private name you gave
  their library. "Sam's crap music" is exactly the string that must not travel.
- **Not editable at pair time.** One place to set it (Settings) beats two for v1.
- **No per-library colour or icon.** Same axis, separate feature, no demand yet.
- **Removing a library forgets its alias.** A removal is a forget; re-adding gives
  you the host's name back and one tap to re-alias.

---

## Compat

- **A fresh field, absent by default.** An unaliased record round-trips
  byte-identically through `normalize` before and after, so an upgraded phone sees
  no change until it sets one.
- **Downgrade is lossy but safe.** `record()` is a whitelist, so an older build
  reading a new `hosts.json` silently drops `alias` and shows host names. Nothing
  throws, nothing wedges.
- **Old host, new app** is the only combination that exists here, and it is
  unaffected: the host is not in this feature.

---

## Risks

**An alias hides a server rename.** You call it "Sam's music", Sam renames it
"Sam's jazz", and you never learn. Mitigated by showing the server's own name on
the Settings row whenever an alias is set, and by clearing an alias always
revealing the CURRENT server name (we keep syncing `libraryName` underneath).
Accepted: the whole point of an alias is that it wins.

**Aliasing two libraries the same thing.** Handled by construction - the clash
check runs on effective names, so you get `#jud4` / `#rxtj` back. Slightly funny
(you asked for that name twice) but never ambiguous.

**Hostile input.** Trim and a 40-character cap in the pure layer. The alias is
rendered by React as text, never as HTML, and never reaches the dashboard, so the
stored-XSS class that bit the device labels in July has no path here. Worth
stating rather than assuming: this string is displayed on ONE device, by one
renderer, and is written by the person reading it.

**Scope creep into "rename my own library".** An owner CAN rename a library they
own, from the dashboard, and that is a different feature with a different blast
radius (it changes the name for everyone). The pencil sets a local alias for every
library including one you own, which is the simpler and more honest rule.

---

## Verify

Unit (`test/hosts.test.js`, extending the existing `libraryLabels` cases):

- `setAlias` sets, clears on empty/whitespace, caps at 40, no-ops on a missing host
- an alias survives `renameHost` and `addHost` (a re-pair must not wipe it)
- `libraryLabels` prefers the alias over the host name
- a lone alias is left completely alone (no suffix)
- two identical aliases clash, and an alias clashing with a host-pushed name
  suffixes BOTH
- `record()` omits the key when the alias is absent or blank

Gate: `npm run verify` green (564/564 today, plus the new cases), including
`test/worklet-refs.test.js`.

Hardware (TCL, both libraries paired, both currently named "My Library"):

1. Alias the Umbrel "Tim's Umbrel". Confirm the switcher, the Settings row, the
   home chips, the Library header and the You > Requests rows all say it, and that
   the OTHER library drops its `#rxtj` suffix (the clash is gone).
2. Rename the library on the dashboard while the alias is set. Confirm the alias
   holds in the UI and the Settings sub-line updates to the new server name.
3. Clear the alias. Confirm the row goes back to the server's CURRENT name and the
   `#suffix` pair returns.
4. Kill and relaunch the app. Confirm the alias persisted.

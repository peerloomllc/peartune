# One connection per library: retire the "active" tier

**Goal** — every paired library reaches its host the same way, so no library is
privileged, "active" stops being a reliability tier, and the class of bug that
produced tonight's outage cannot recur.

**Tier** — **T2.** No wire change and no host change: the media channel, the
grant model and revoke semantics are untouched. What moves is IPC message shape
(`host:connected` / `host:disconnected` become per-library rather than
"the active one") and the runtime meaning of a persisted field
(`hosts.json.activeHostKey` stops selecting a connection tier). Proposal per
Constitution §3; no rollback plumbing needed beyond reverting the commit, since
nothing on disk or on the wire changes shape.

---

## Why this exists

PR #205 fixed a real outage: a library the phone was connected to could vanish
from All libraries for 20+ minutes. The A/B that followed (2026-07-26, same
phone, same LAN, one wifi bounce per configuration) settled the cause:

| Active | Pool | What the pool connection did |
| --- | --- | --- |
| Mac Mini | Umbrel | `pool:watchdog {"state":"zombie","conns":1,"live":1}` |
| Umbrel | Mac Mini | `pool:watchdog {"state":"zombie","conns":1,"live":1}` |

**The symptom followed the ROLE, not the host.** Whichever library was not
"active" was the one that died quietly and stayed dead.

The reason is structural. The active host's connection is reached through
`ensureConnected()`, and there are **39 call sites** - every favourite, every
resume write, every identity read. Each one re-joins the topic and forces a
discovery refresh, so ordinary use continuously repairs that one connection. No
equivalent caller exists for any other library: before #205 its only driver was a
timer that could stop while the host was still dark, and even now the watchdog is
a patch on an asymmetry rather than its removal.

Tim's question, which is the right one: with a blended library and every host
connected, **why is one of them special at all?** Auditing what `activeLibraryId`
still decides:

- **Browse and search** - served from the merged in-memory index. No host involved.
- **Streaming** - `routeTrack` / `bestCopy` send each track to a host that owns it,
  with failover to another copy. Not the active one.
- **Favourites, resume, play counts** - `trackClient(trackId)` routes to the
  track's OWNING host, with a per-library outbox when it is offline.
- **Requests** - fan out to every connected host (#187), collapsed for display.
- **The play session / "Play here"** - already coordinates through an ELECTED home
  (`sessionHomeLib` = smallest hostKey among connected), deliberately *not* the
  active one.

So nothing a user can name depends on it. What remains is internal: which
connection is the variable `client`, which one the shim falls back to, and -
critically - which one gets the well-trodden repair path. That is not a product
concept, it is a leftover from the single-host era that has quietly become a
reliability tier.

### The second cost: choreography

Because there are two tiers, connections must be MOVED between them, and every
move has been a bug:

- `demoteActiveToPool` exists because adding a library orphaned the previous
  active connection - Hyperswarm dedups one connection per peer, so re-joining its
  topic never re-emitted it and the host showed offline forever (2026-07-23).
- `promotePoolToActive` exists because the mirror case stranded the survivor when
  the active library was removed (2026-07-24).
- `attachActive` grew a `switching` flag so a fresh client is used for the incoming
  host and the outgoing one keeps its own.

None of that is essential complexity. It is all bookkeeping for a distinction we
are proposing to delete: with one tier there is nothing to promote, nothing to
demote, and nothing to orphan.

---

## Scope

### In

1. **One connection map.** Extend today's `pool` map to hold EVERY paired library,
   the current active one included: `libraryId -> { host, client, discovery,
   nudgeTimer, waiters }`. One `attach(host, conn)` replaces `attachActive` +
   `attachPool`. `demoteActiveToPool` and `promotePoolToActive` are DELETED.
2. **One accessor.** `clientFor(libraryId)` replaces the `client` global plus
   `poolClient`. `ensureConnected()` becomes `ensureLibrary(defaultLibraryId)`,
   keeping its name at first so the 39 call sites change in one mechanical pass.
3. **One repair path.** The #205 watchdog covers every library rather than
   skipping the active one, and runs whenever the app has 1+ paired libraries
   rather than only in merged mode. The nudge loop likewise becomes per-library
   with no special case.
4. **The shim resolves per request.** `setClient(c)` gives way to the resolver it
   already half has (`hostClient`, `libForTrack`, `libForCover`), falling back to
   the default library when a URL names no host.
5. **`activeLibraryId` becomes the DEFAULT library**, in name and in comments: the
   answer to "which library when the caller named none" and "which library does
   single-host mode show". It selects a default, never a connection tier.
6. **Per-library connection events.** `host:connected` / `host:disconnected`
   always carry `libraryId`, so the UI greys exactly the library that dropped.
   (The merged status already reports per-library connectivity; this makes the
   single-host path agree with it.)

### Out

- **The wire protocol, the grant store, revoke.** Untouched, including the T3
  guarantee that revoke kills live connections - it must be re-verified, not
  redesigned.
- **The host.** No change; an unmodified host serves this phone exactly as today.
- **The elected session home.** Already independent of "active"; it stays as is.
- **Single-host UX.** With 0-1 libraries the app looks and behaves identically.
- **The merged index build.** Just repaired in #205; this proposal does not touch
  `buildMergedIndex` or the rebuild gate.
- **Per-library state on disk** (dirs, leases, outboxes, queues). Already
  per-library, and correctly so.
- **A "make this library active" picker.** Explicitly rejected: exposing the
  choice would enshrine the asymmetry we are removing. If a user ever needs to
  pick a default for OTHER reasons (say, where a libraryId-less write lands),
  that is a separate, smaller question.

---

## Compat

- **On disk:** `hosts.json` keeps `activeHostKey` with its current shape and
  meaning-as-a-default. No migration, and an older build reading it still works.
- **On the wire:** nothing changes, in either direction. A phone on this build
  talks to today's hosts; today's phones talk to today's hosts.
- **Across the app:** the WebView UI and the worklet ship in the same APK, so the
  per-library event shape has no cross-version window. The UI change is additive
  (`libraryId` on events it already receives).
- **Downgrade:** reverting the commit restores current behaviour with no cleanup,
  because nothing persisted changed shape.

---

## Risks

- **Hyperswarm's one-connection-per-peer dedup.** The reason today's code
  choreographs moves. Unifying removes the moves, which is the point - but the
  first cut must confirm that joining every library's topic up front never
  produces two entries for one peer (it cannot: one topic per host, one host per
  peer, and `attach` is keyed by libraryId).
- **39 call sites.** `ensureConnected()` is threaded through half the method
  surface. The mitigation is to keep the function and its name, and change only
  what it resolves to, so the diff stays reviewable.
- **Battery and data.** Outside merged mode the pool is not joined today, so a
  single-focus user would go from 1 topic membership to N. Idle Hyperswarm
  keepalives are small, but this should be measured on the TCL over an hour
  before it ships, and stated in DONE.
- **The offline lease.** `stampAuth()` stamps the active library; per-library
  stamping already exists (`stampAuthFor`) and every connection would stamp its
  own. Worth an explicit test - a lease that stops being renewed silently expires
  a cached library.

---

## Phases

- **P1 - symmetry without restructuring.** Extend the #205 watchdog and the nudge
  loop to cover the default library too, and drop the merged-mode-only guard. Small,
  independently shippable, and removes the remaining reliability gap even if P2
  never lands.
- **P2 - one map, one accessor.** `clientFor` / `ensureLibrary`, `attach`, delete
  demote/promote, shim resolves per request. The bulk of the diff.
- **P3 - naming and events.** Rename the runtime concept to "default library",
  make connection events per-library, update the UI to grey per library.

---

## Verify

- **Gate:** `npm run verify`, green, no merges red (Constitution §5).
- **Unit:** the connection-map policy (which libraries need a dial, which need a
  probe) in the style of `worklet/pool-health.js`; a `clientFor` resolution table
  covering named / unnamed / offline libraries.
- **Integration (testnet, `test/transport.test.js` harness):** two hosts, both
  reachable through one swarm; kill one and confirm the other is unaffected;
  change the default library and confirm NO connection is torn down or rebuilt -
  the property that makes the whole change worth it.
- **Hardware (TCL + the Umbrel + the Mac), each with logs kept:**
  1. Launch: both libraries connect, blend shows both.
  2. Wifi bounce with the app foregrounded: both return, neither zombies.
  3. Background 5+ minutes and return: both return, blend rebuilt.
  4. Add a library while connected to another - the 2026-07-23 orphan shape.
  5. Remove the default library while connected - the 2026-07-24 strand shape.
  6. **Revoke mid-song from the dashboard: within a second, browse, the next
     track, art and reconnect are all denied.** The T3 guarantee, re-proved.
  7. An hour idle on the TCL with 2 libraries, battery noted, for the risk above.

---

## Open questions

1. **Keep a persisted default at all, or elect it?** `sessionHomeLib` already
   elects a coordinator deterministically. The same could answer "which library
   when none was named", which would let `activeHostKey` be deleted outright - at
   the cost of a hosts.json migration (a bigger T2). Recommendation: keep the
   persisted default for now; it is stable across restarts and costs nothing.
2. **Should focusing a single library disconnect the others?** No, in this
   author's view - the header switcher is a VIEW filter and the blend is the
   default with 2+ libraries. Worth confirming against the battery measurement.
3. **Does the default library still deserve any special treatment at all** (e.g.
   first to connect on a cold launch, so the app is usable a moment sooner)? A
   deliberate ordering is fine; a permanent tier is not.

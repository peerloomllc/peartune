// Host side of peartune/media/1.
//
// We do NOT tunnel a raw port (DECISIONS 2026-07-13). A tunnel would hand a
// guest Navidrome's entire surface plus its credentials, make per-request scope
// enforcement impossible, and teach the app to speak Subsonic - which would
// quietly demote the raw-folder adapter to a second-class citizen. Instead the
// host answers a normalized API, and the two source adapters sit behind it.
//
// The CHANNEL (registration order, the readonly check, backpressure, chunking, cancel,
// media.stream, the goodbye to a revoked device) is @peerloom/host's serveMedia. This
// file is the part that is PearTune: the method table, handed to LibraryHost as the
// `media` factory (see host/server.js).

const { ownerOf, serveFarewell } = require('@peerloom/host')
const { ERR, SCOPE } = require('@peerloom/host/constants')
const { REQUEST_KINDS, notifyOwners } = require('@peerloom/host')
const { hasFfmpeg } = require('./transcode')
const { viewOf } = require('./visibility')

// Methods that mutate. A readonly grant is refused HERE rather than at the adapter,
// so a new mutating method cannot accidentally ship without a scope check.
const MUTATING = new Set([
  'identity.set', 'identity.avatar', 'fav.set', 'resume.set', 'count.bump',
  // Bookmarks in books (proposal 2026-09-13, slice 4).
  'bookmark.add', 'bookmark.remove',
  'playlist.create', 'playlist.rename', 'playlist.delete', 'playlist.add', 'playlist.setTracks',
  'session.claim', 'session.set',
  // Filing a music request writes a host row, so a readonly grant is refused here
  // (proposal 2026-07-24, P1). Resolving is dashboard-only, not a media method.
  'request.add',
  // Removing your OWN request (You > Requests). Ownership is checked in the handler;
  // MUTATING just keeps a readonly grant out (it has no requests to remove anyway).
  'request.delete',
  // Casting to a Home Assistant speaker (proposal 2026-08-01). These are gated on
  // OWNER scope in the handlers as well; listing them here keeps a readonly grant out
  // at the same chokepoint every other mutating method uses, so a future relaxation
  // of the owner gate cannot accidentally let `readonly` through.
  'speaker.play', 'speaker.stop', 'speaker.volume', 'speaker.pause', 'speaker.resume'
])

// Every method this table answers. ping and media.stream are not here: the package
// answers both, through the `ping` and `openStream` hooks below.
const METHODS = ['library.stats', 'library.list', 'library.get', 'library.search', 'identity.get', 'identity.set', 'identity.avatar', 'device.leave', 'fav.list', 'fav.set', 'count.bump', 'count.top', 'resume.get', 'resume.latest', 'bookmark.list', 'bookmark.add', 'bookmark.remove', 'resume.list', 'resume.set', 'playlist.list', 'playlist.get', 'playlist.create', 'playlist.rename', 'playlist.delete', 'playlist.add', 'playlist.setTracks', 'request.add', 'request.list', 'owner.claim', 'owner.devices', 'owner.pairStart', 'owner.pairStop', 'owner.pairState', 'owner.requests', 'owner.requestResolve', 'owner.revoke', 'request.delete', 'session.get', 'session.claim', 'session.set', 'speaker.list', 'speaker.play', 'speaker.stop', 'speaker.pause', 'speaker.resume', 'speaker.volume', 'speaker.state', 'art.get', 'nowplaying.set', 'lyrics.get']

function createMedia ({ getAdapter, libraryName = null, grants = null, state = null, presence = null, avatars = null, onLeave = null, owner = null, speakers = null, onStream = null, onNowPlaying = null }) {
  // CONFIRMED means the claim matches the person this device is actually assigned
  // to - not merely that SOME person is assigned.
  //
  // Otherwise, changing your name after being confirmed leaves the app saying
  // "confirmed as Tim" while the row claims something else entirely. A rename is a
  // NEW claim, and it is pending until the operator says otherwise. (The device
  // still cannot move itself: only the operator confirms. That part is the point.)
  async function identityOf (row) {
    const person = row?.personId && grants ? await grants.getPerson(row.personId) : null
    const claim = row?.claimedUser || null
    // Disambiguated where two people share a name, so "belongs to Sam" on the phone names the
    // SAME Sam the dashboard's revoke button does (see grants.personLabels).
    const labels = person && grants ? await grants.personLabels() : null
    return {
      deviceName: row?.label || null,
      belongsTo: person ? (labels?.get(person.id) || person.name) : null,
      // The library's CURRENT name (a getter, read now), so a dashboard rename reflects on the
      // phone on its next connect - the app updates its stored host record + UI from this.
      libraryName: libraryName ? libraryName() : null,
      // The device's own guest expiry (null = permanent), so the phone can show a
      // "guest access expires in X" banner. Read from THIS connection's grant, never a
      // param - a device only ever learns its OWN access. Refreshed on every connect, so
      // an operator extending or clearing it on the dashboard reflects on the phone.
      expiresAt: row?.expiresAt ?? null,
      // Is THIS device the owner (proposal 2026-07-24, P2)? Off its own grant scope, so the
      // app shows the owner surface only for a device the dashboard actually made an owner.
      // Refreshed each connect, so a dashboard promote/revoke reflects on the next connect.
      owner: row?.scope === SCOPE.OWNER,
      user: claim
        ? {
            name: claim,
            confirmed: !!person && person.name.toLowerCase() === claim.toLowerCase()
          }
        : null
    }
  }

  async function handle (ctx) {
    const { method, params, grant, libraryId, log } = ctx

    // The adapter as THIS connection may see it (proposal 2026-08-31-per-person-folders).
    // Built per request off the LIVE grant, which LibraryHost.refreshGrant swaps, so a
    // narrowing saved on the dashboard filters the very next request with no reconnect.
    // Unnarrowed grants get the real adapter back (viewOf fast path).
    const adapterFor = () => viewOf(getAdapter(), grant)

    // Hidden ids leave the person's OWN lists on the way out, never their store: a
    // favorite of a hidden track is filtered here and comes back whole when the person
    // is widened (proposal 2026-08-31). No-op for an unnarrowed grant.
    async function visibleIds (ids, type) {
      const v = adapterFor()
      if (v === getAdapter()) return ids || []
      const out = []
      for (const x of ids || []) {
        if (await v.get({ id: x, type })) out.push(x)
      }
      return out
    }

  // Tell this person's OTHER devices that their playlists moved. Same gap the favorites push
  // closed (proposal 2026-07-30-favorites-live-update): a playlist created, renamed, deleted or
  // reordered on one phone did not reach the others until something made the app ask again, and
  // nothing does while it sits connected. Not the device that made the change - it already
  // re-rendered, and a push would fight its own optimistic update.
  //
  // `id` is which playlist (null when the change is not about one in particular), `reason` is
  // what happened. Neither is enough to patch a list with, deliberately: the client re-reads,
  // because the summaries carry counts that a create/add/remove all shift.
    function playlistsChanged (id, reason) {
      if (!presence) return
      presence.notifyOwner(ownerOf(grant), 'playlists:changed', { id: id || null, reason, libraryId },
        { exceptDevice: grant.deviceKey })
    }

    switch (method) {
      case 'library.stats':
        return ctx.reply(await adapterFor().stats())

      case 'library.list':
        return ctx.reply(await adapterFor().list(params || {}))

      case 'library.get':
        return ctx.reply(await adapterFor().get(params || {}))

      case 'library.search':
        return ctx.reply(await adapterFor().search(params || {}))

      // --- identity (proposal 2026-07-14) ------------------------------------
      //
      // THE CALLER IS THE CONNECTION. `grant` here is the row the firewall already
      // looked up from the Noise-authenticated remote public key, so a device can
      // only ever read and write ITS OWN identity - there is no deviceKey parameter
      // to forge, and adding one would be the whole vulnerability.
      case 'identity.get': {
        // RE-READ the row. `grant` is this CONNECTION's grant, captured once when the firewall
        // admitted it, so answering from it made identity.get report the state as of connect
        // time for the whole life of the connection - it could never see a claim the device had
        // just made, nor an operator confirming/renaming/assigning on the dashboard.
        //
        // That is what made a fresh pair sit on "Waiting for your server to confirm you are X"
        // while the host had already auto-created and assigned the person: identity.set wrote the
        // row and replied with fresh data, but the identity.get 13ms later still answered from the
        // stale snapshot (measured on-device 2026-07-21). Only a reconnect cleared it, which is
        // exactly why relaunching the app "fixed" it.
        const row = (grants && grant) ? await grants.get(grant.deviceKey) : null
        return ctx.reply(await identityOf(row || grant))
      }

      case 'identity.set': {
        if (!grants || !grant) return ctx.fail(ERR.FORBIDDEN, 'no grant')

        // params.deviceKey and params.personId are IGNORED, not merely unused: a
        // device names ITSELF, and only the operator decides who it belongs to.
        // A claim is cosmetic until confirmed on the dashboard.
        const row = await grants.setIdentity(grant.deviceKey, {
          deviceName: params?.deviceName,
          userName: params?.userName,
          // Additive: an older phone omits it and its platform is left as the grant recorded it.
          platform: params?.platform
        })
        if (!row) return ctx.fail(ERR.FORBIDDEN, 'no grant')

        log('identity:set', { label: row.label, claims: row.claimedUser || null })

        return ctx.reply({ ok: true, ...(await identityOf(row)) })
      }

      // A device sets its OWN avatar: a small JPEG, base64 in params.avatar. Keyed by
      // grant.deviceKey (this connection's Noise-authenticated key), so a device can
      // only ever set its own photo. The bytes go to the file-backed avatar store, not
      // the grant bee. An empty/absent avatar clears it.
      case 'identity.avatar': {
        if (!grant) return ctx.fail(ERR.FORBIDDEN, 'no grant')
        if (!avatars) return ctx.fail(ERR.NOT_FOUND, 'avatars unavailable')
        try {
          const buf = params?.avatar ? Buffer.from(String(params.avatar), 'base64') : null
          if (!buf || !buf.length) avatars.delete(grant.deviceKey)
          else avatars.set(grant.deviceKey, buf)
        } catch (e) {
          return ctx.fail(ERR.BAD_PARAMS, e.message)
        }
        log('identity:avatar', { bytes: (params?.avatar || '').length })
        return ctx.reply({ ok: true })
      }

      // The phone removed this library / unpaired: drop ITS OWN access here (proposal
      // 2026-07-20). Like identity.set, the subject is THIS connection's grant (grant.deviceKey,
      // Noise-authenticated) - there is no deviceKey param to forge, so a device can only ever
      // leave on its own behalf. Allowed for ANY scope (relinquishing your own access is the
      // least-privileged action), so it is deliberately NOT in the MUTATING scope gate. Reply
      // BEFORE onLeave, which revokes the grant and destroys THIS connection.
      case 'device.leave': {
        if (!grant) return ctx.fail(ERR.FORBIDDEN, 'no grant')
        ctx.reply({ ok: true })
        if (onLeave) { try { await onLeave(grant.deviceKey) } catch (e) { log('device:leave-failed', { err: e?.message }) } }
        return
      }

      // --- user state: favorites (host-as-hub, milestone 3) ------------------
      //
      // The owner comes from THIS connection's grant (ownerOf), never from params -
      // same rule as identity.set. A device can only ever touch its own state.
      case 'fav.list': {
        if (!state || !grant) return ctx.fail(ERR.FORBIDDEN, 'no grant')
        // Grouped { track:[ids], album:[ids], artist:[ids] }.
        const favs = await state.listFavs(ownerOf(grant))
        return ctx.reply({
          track: await visibleIds(favs.track, 'track'),
          album: await visibleIds(favs.album, 'album'),
          artist: await visibleIds(favs.artist, 'artist')
        })
      }

      case 'fav.set': {
        if (!state || !grant) return ctx.fail(ERR.FORBIDDEN, 'no grant')
        // kind defaults to 'track', and id accepts the old `trackId` name, so a phase-1
        // app degrades cleanly. An unknown kind is a bad-params error, not a throw.
        const kind = params?.kind || 'track'
        const favId = params?.id || params?.trackId
        if (!favId) return ctx.fail(ERR.BAD_PARAMS, 'id required')
        let row
        try {
          row = await state.setFav(ownerOf(grant), kind, favId, params?.on !== false)
        } catch {
          return ctx.fail(ERR.BAD_PARAMS, 'bad favorite kind')
        }
        // TELL THIS PERSON'S OTHER DEVICES, or they show the old hearts until something makes
        // them ask again - and nothing does while the app sits connected, which is why a
        // favorite made on one phone only appeared on the other after a relaunch (Tim,
        // 2026-07-30; proposal 2026-07-30-favorites-live-update). Not the device that just
        // wrote it: it already re-rendered, and a push would fight its own optimistic update.
        // Best-effort, and never gates the reply - presence is null in the unit tests.
        let told = 0
        if (presence) {
          told = presence.notifyOwner(ownerOf(grant), 'favorites:changed',
            { kind: row.kind, id: row.id, on: row.on, libraryId },
            { exceptDevice: grant.deviceKey })
        }
        log('fav:set', { kind: row.kind, on: row.on, told })
        return ctx.reply({ ok: true, kind: row.kind, id: row.id, on: row.on })
      }

      // --- play counts (milestone 3, phase 3) -------------------------------
      case 'count.bump': {
        if (!state || !grant) return ctx.fail(ERR.FORBIDDEN, 'no grant')
        if (!params?.trackId) return ctx.fail(ERR.BAD_PARAMS, 'trackId required')
        const count = await state.bumpCount(ownerOf(grant), params.trackId)
        log('count:bump', { count })
        return ctx.reply({ ok: true, count })
      }

      case 'count.top': {
        if (!state || !grant) return ctx.fail(ERR.FORBIDDEN, 'no grant')
        const top = await state.topCounts(ownerOf(grant), Number(params?.limit) || 50)
        const topVisible = new Set(await visibleIds(top.map((r) => r.trackId), 'track'))
        return ctx.reply({ items: top.filter((r) => topVisible.has(r.trackId)) })
      }

      // --- resume positions (milestone 3, phase 2) --------------------------
      case 'resume.get': {
        if (!state || !grant) return ctx.fail(ERR.FORBIDDEN, 'no grant')
        if (!params?.trackId) return ctx.fail(ERR.BAD_PARAMS, 'trackId required')
        const row = await state.getResume(ownerOf(grant), params.trackId)
        log('resume:get', { positionMs: row?.positionMs || 0 })
        return ctx.reply({ positionMs: row?.positionMs || 0, durationMs: row?.durationMs || null })
      }

      case 'resume.latest': {
        if (!state || !grant) return ctx.fail(ERR.FORBIDDEN, 'no grant')
        // Scoped to the asking device (proposal 2026-07-30-one-device-plays): the card answers
        // "what was I playing on THIS phone", with the person-wide newest as a fallback.
        let row = await state.latestResume(ownerOf(grant), grant.deviceKey)
        if (row && (await visibleIds([row.trackId], 'track')).length === 0) row = null
        // updatedAt lets the merged client pick the globally-newest resume across hosts, and
        // playedAt lets it order by when the device LISTENED rather than when the write landed
        // (an outbox flush lands late). An old host sends no playedAt; the client falls back.
        return ctx.reply(row ? { trackId: row.trackId, positionMs: row.positionMs, durationMs: row.durationMs, updatedAt: row.updatedAt || 0, playedAt: row.playedAt || row.updatedAt || 0 } : null)
      }

      // Several resume rows at once, each with its track (proposal 2026-09-13). `kind`
      // ('book' or 'music') filters on the track's kind; hidden and deleted tracks are
      // dropped, like resume.latest. An old host answers ENOMETHOD and the app shows no
      // Continue listening row.
      // --- bookmarks (proposal 2026-09-13, slice 4) ----------------------------
      //
      // Per person, like resume: ownerOf(grant) comes from the authenticated connection, so a
      // device only ever reads and writes its own person's bookmarks. The list is filtered by
      // what this person may see, so a narrowed grant does not learn a hidden track's position.
      case 'bookmark.list': {
        if (!state || !grant) return ctx.fail(ERR.FORBIDDEN, 'no grant')
        const ids = Array.isArray(params?.trackIds) ? params.trackIds.map(String).slice(0, 500) : []
        const visible = await visibleIds(ids, 'track')
        return ctx.reply(await state.listBookmarks(ownerOf(grant), visible))
      }

      case 'bookmark.add': {
        if (!state || !grant) return ctx.fail(ERR.FORBIDDEN, 'no grant')
        if (!params?.id || !params?.trackId) return ctx.fail(ERR.BAD_PARAMS, 'id and trackId required')
        const row = await state.addBookmark(ownerOf(grant), params, { deviceKey: grant.deviceKey })
        log('bookmark:add', { positionMs: row.positionMs })
        return ctx.reply(row)
      }

      case 'bookmark.remove': {
        if (!state || !grant) return ctx.fail(ERR.FORBIDDEN, 'no grant')
        if (!params?.id || !params?.trackId) return ctx.fail(ERR.BAD_PARAMS, 'id and trackId required')
        await state.removeBookmark(ownerOf(grant), String(params.trackId), String(params.id))
        return ctx.reply({ ok: true })
      }

      case 'resume.list': {
        if (!state || !grant) return ctx.fail(ERR.FORBIDDEN, 'no grant')
        const want = params?.kind
        const limit = Math.min(Math.max(Number(params?.limit) || 50, 1), 200)
        const out = []
        for (const r of await state.listResumes(ownerOf(grant))) {
          const track = await adapterFor().get({ id: r.trackId, type: 'track' }).catch(() => null)
          if (!track) continue
          if ((want === 'book' || want === 'music') && (track.kind === 'book') !== (want === 'book')) continue
          out.push({ trackId: r.trackId, positionMs: r.positionMs, durationMs: r.durationMs || null, playedAt: r.playedAt || r.updatedAt || 0, track })
          if (out.length >= limit) break
        }
        return ctx.reply(out)
      }

      case 'resume.set': {
        if (!state || !grant) return ctx.fail(ERR.FORBIDDEN, 'no grant')
        if (!params?.trackId) return ctx.fail(ERR.BAD_PARAMS, 'trackId required')
        // playedAt is the CLIENT's clock (when it actually listened) - the one thing the host
        // cannot know, because a write can arrive from an outbox hours later. deviceKey comes
        // from the authenticated connection, never a param: a device may only ever write as
        // itself, exactly as everywhere else in this file.
        await state.setResume(ownerOf(grant), params.trackId, Number(params.positionMs) || 0, params.durationMs, {
          playedAt: Number(params.playedAt) || 0,
          deviceKey: grant.deviceKey
        })
        log('resume:set', { positionMs: Number(params.positionMs) || 0 })
        return ctx.reply({ ok: true })
      }

      // --- playlists (milestone 3, phase 4) ---------------------------------
      //
      // Host-owned "our" playlists. The owner comes from ownerOf(grant), never from
      // params - a device can only ever touch its own playlists, same rule as favorites
      // above. A mutation that names a playlist the owner does not have gets NOT_FOUND
      // (the state layer returns null), not a silent no-op.
      case 'playlist.list': {
        if (!state || !grant) return ctx.fail(ERR.FORBIDDEN, 'no grant')
        return ctx.reply({ items: await state.listPlaylists(ownerOf(grant)) })
      }

      case 'playlist.get': {
        if (!state || !grant) return ctx.fail(ERR.FORBIDDEN, 'no grant')
        if (!params?.id) return ctx.fail(ERR.BAD_PARAMS, 'id required')
        const row = await state.getPlaylist(ownerOf(grant), params.id)
        if (!row) return ctx.fail(ERR.NOT_FOUND, 'no such playlist')
        return ctx.reply({ id: row.id, name: row.name, trackIds: await visibleIds(row.trackIds, 'track') })
      }

      case 'playlist.create': {
        if (!state || !grant) return ctx.fail(ERR.FORBIDDEN, 'no grant')
        const row = await state.createPlaylist(ownerOf(grant), params?.name)
        playlistsChanged(row.id, 'created')
        log('playlist:create', { id: row.id, name: row.name })
        return ctx.reply({ id: row.id, name: row.name })
      }

      case 'playlist.rename': {
        if (!state || !grant) return ctx.fail(ERR.FORBIDDEN, 'no grant')
        if (!params?.id) return ctx.fail(ERR.BAD_PARAMS, 'id required')
        const row = await state.renamePlaylist(ownerOf(grant), params.id, params?.name)
        if (!row) return ctx.fail(ERR.NOT_FOUND, 'no such playlist')
        playlistsChanged(row.id, 'renamed')
        log('playlist:rename', { id: row.id, name: row.name })
        return ctx.reply({ id: row.id, name: row.name })
      }

      case 'playlist.delete': {
        if (!state || !grant) return ctx.fail(ERR.FORBIDDEN, 'no grant')
        if (!params?.id) return ctx.fail(ERR.BAD_PARAMS, 'id required')
        await state.deletePlaylist(ownerOf(grant), params.id)
        playlistsChanged(params.id, 'deleted')
        log('playlist:delete', { id: params.id })
        return ctx.reply({ ok: true })
      }

      case 'playlist.add': {
        if (!state || !grant) return ctx.fail(ERR.FORBIDDEN, 'no grant')
        if (!params?.id) return ctx.fail(ERR.BAD_PARAMS, 'id required')
        // How many actually landed, after de-duping against what is already there -
        // so the app can say "added 2" vs "already in the playlist" honestly.
        const before = (await state.getPlaylist(ownerOf(grant), params.id))?.trackIds?.length ?? 0
        const row = await state.addToPlaylist(ownerOf(grant), params.id, params?.trackIds)
        if (!row) return ctx.fail(ERR.NOT_FOUND, 'no such playlist')
        const added = row.trackIds.length - before
        playlistsChanged(row.id, 'tracks-added')
        log('playlist:add', { id: row.id, count: row.trackIds.length, added })
        return ctx.reply({ ok: true, count: row.trackIds.length, added })
      }

      case 'playlist.setTracks': {
        if (!state || !grant) return ctx.fail(ERR.FORBIDDEN, 'no grant')
        if (!params?.id) return ctx.fail(ERR.BAD_PARAMS, 'id required')
        const row = await state.setPlaylistTracks(ownerOf(grant), params.id, params?.trackIds)
        if (!row) return ctx.fail(ERR.NOT_FOUND, 'no such playlist')
        playlistsChanged(row.id, 'tracks-set')
        log('playlist:set-tracks', { id: row.id, count: row.trackIds.length })
        return ctx.reply({ ok: true, count: row.trackIds.length })
      }

      // --- music requests (proposal 2026-07-24-owner-in-the-app, P1) --------
      //
      // A device asks the operator to add music. The REQUESTER is ownerOf(grant) -
      // host-derived, never a param - so a request cannot be filed on someone else's
      // behalf, and request.list can only ever return the caller's own. Resolving is
      // the operator's job and lives on the dashboard API, not here.
      case 'request.add': {
        if (!state || !grant) return ctx.fail(ERR.FORBIDDEN, 'no grant')
        if (!REQUEST_KINDS.includes(params?.kind)) return ctx.fail(ERR.BAD_PARAMS, 'kind must be artist, album or track')
        let row
        try {
          row = await state.addRequest(ownerOf(grant), {
            kind: params.kind, name: params.name, artist: params.artist, album: params.album, mbid: params.mbid
          })
        } catch (e) {
          return ctx.fail(ERR.BAD_PARAMS, e.message || 'bad request')
        }
        log('request:add', { kind: row.kind, folded: row.count > 1 })
        // P3: nudge every CONNECTED owner so a request is not a dead-drop nobody reads. Best-effort
        // by design (Tier A) - if no owner is online it just waits, and the dashboard/badge still
        // shows it on their next open. The owner set is the grant store's authority (scope OWNER,
        // not revoked); presence.notify only reaches the ones with a live channel. requesterName is
        // derived host-side from the caller's own grant, the same way the dashboard names it.
        if (presence && grants) {
          let requesterName = 'Someone'
          if (grant.personId) {
            // Suffixed where two people share a name - "Sam asked" must not be a coin flip on
            // the banner that an owner acts on.
            const labels = await grants.personLabels().catch(() => null)
            requesterName = labels?.get(grant.personId) ||
              (await grants.getPerson(grant.personId).catch(() => null))?.name || 'Someone'
          } else requesterName = grant.label || 'A device'
          const payload = { id: row.id, kind: row.kind, name: row.name, artist: row.artist, requesterName, count: row.count }
          await notifyOwners(presence, grants, 'request:new', payload)
        }
        return ctx.reply({ ok: true, id: row.id, status: row.status, count: row.count })
      }

      case 'request.list': {
        if (!state || !grant) return ctx.fail(ERR.FORBIDDEN, 'no grant')
        // The caller's OWN requests only - the operator's all-requests view is dashboard-side.
        return ctx.reply({ requests: await state.listRequests({ requester: ownerOf(grant) }) })
      }

      // --- owner maintenance (proposal 2026-07-24-owner-in-the-app, P2) -----
      //
      // Gated on the OWNER scope, which is minted only by pairing through the dashboard's
      // owner window (host-side) - a phone can never assert it. The gate is here at
      // dispatch, so a full/readonly/guest grant is refused before any owner op runs.
      // BECOME an owner over this existing connection (P2, the connected-device promote path).
      // NOT gated on owner scope - this is how a full device becomes an owner. It IS gated on
      // having a grant (only a paired device has a media channel) AND presenting the open owner
      // window's one-time code, which the host checks. So a random device cannot self-promote.
      case 'owner.claim': {
        if (!owner || !grant) return ctx.fail(ERR.FORBIDDEN, 'no grant')
        if (!params?.code) return ctx.fail(ERR.BAD_PARAMS, 'code required')
        const r = await owner.claim(grant.deviceKey, params.code)
        if (!r.ok) return ctx.fail(ERR.FORBIDDEN, r.reason || 'owner claim rejected')
        // The host's claimOwner swaps the promoted row into this connection's live grant
        // (LibraryHost.refreshGrant), so the very next owner.* here is already allowed.
        log('owner:claim')
        return ctx.reply({ ok: true })
      }

      case 'owner.devices': {
        if (!owner) return ctx.fail(ERR.INTERNAL, 'owner ops unavailable')
        if (grant?.scope !== SCOPE.OWNER) return ctx.fail(ERR.FORBIDDEN, 'owner only')
        return ctx.reply({ devices: await owner.listDevices() })
      }

      // Open a pairing window remotely so the owner can let a device in while away (P2b).
      // A NORMAL/guest window only - owner.pairStart never mints an owner grant (server binds
      // owner:false), so a stolen owner phone cannot make more owners.
      case 'owner.pairStart': {
        if (!owner) return ctx.fail(ERR.INTERNAL, 'owner ops unavailable')
        if (grant?.scope !== SCOPE.OWNER) return ctx.fail(ERR.FORBIDDEN, 'owner only')
        const link = owner.pairStart({ expiresMs: Number(params?.expiresMs) > 0 ? Number(params.expiresMs) : null })
        log('owner:pair-start', { guest: !!params?.expiresMs })
        return ctx.reply({ link })
      }

      case 'owner.pairStop': {
        if (!owner) return ctx.fail(ERR.INTERNAL, 'owner ops unavailable')
        if (grant?.scope !== SCOPE.OWNER) return ctx.fail(ERR.FORBIDDEN, 'owner only')
        owner.pairStop()
        return ctx.reply({ ok: true })
      }

      case 'owner.pairState': {
        if (!owner) return ctx.fail(ERR.INTERNAL, 'owner ops unavailable')
        if (grant?.scope !== SCOPE.OWNER) return ctx.fail(ERR.FORBIDDEN, 'owner only')
        return ctx.reply(owner.pairState())
      }

      // The full request queue (all requesters) + resolve, so the owner can work it from the
      // phone away from the dashboard (P2b).
      case 'owner.requests': {
        if (!owner) return ctx.fail(ERR.INTERNAL, 'owner ops unavailable')
        if (grant?.scope !== SCOPE.OWNER) return ctx.fail(ERR.FORBIDDEN, 'owner only')
        return ctx.reply({ requests: await owner.requests() })
      }

      case 'owner.requestResolve': {
        if (!owner) return ctx.fail(ERR.INTERNAL, 'owner ops unavailable')
        if (!params?.id || !['added', 'declined'].includes(params?.status)) return ctx.fail(ERR.BAD_PARAMS, 'id and status (added|declined) required')
        // The library's owner may resolve any row, and THE PERSON WHO FILED A ROW may
        // resolve that row (proposal 2026-08-31-the-requester-closes-the-ask): when
        // another library answers the same ask, the requester's device closes this
        // copy so the queue stops showing an answered ask as pending. The requester
        // is ownerOf(grant) off the Noise-authenticated connection compared to the
        // host-derived row.requester - the exact test request.delete already uses,
        // and marking answered is strictly less power than the delete it allows.
        if (grant?.scope !== SCOPE.OWNER) {
          if (!state) return ctx.fail(ERR.FORBIDDEN, 'owner only')
          const mine = await state.getRequest(params.id)
          if (!mine) return ctx.reply({ ok: false, notFound: true })
          if (mine.requester !== ownerOf(grant)) return ctx.fail(ERR.FORBIDDEN, 'owner only')
          // And only the mirror of an answer: 'added' onto a still-pending copy. A
          // requester cannot flip an owner's decline, and a decline never travels -
          // withdrawing entirely is what request.delete is for.
          if (params.status !== 'added') return ctx.fail(ERR.FORBIDDEN, 'owner only')
          if (mine.status !== 'pending') return ctx.reply({ ok: false, notFound: true })
        }
        const row = await owner.resolveRequest(params.id, params.status)
        if (!row) return ctx.reply({ ok: false, notFound: true })
        log('owner:request-resolve', { status: row.status, by: grant?.scope === SCOPE.OWNER ? 'owner' : 'requester' })
        return ctx.reply({ ok: true, status: row.status })
      }

      case 'owner.revoke': {
        if (!owner) return ctx.fail(ERR.INTERNAL, 'owner ops unavailable')
        if (grant?.scope !== SCOPE.OWNER) return ctx.fail(ERR.FORBIDDEN, 'owner only')
        if (!params?.deviceKey) return ctx.fail(ERR.BAD_PARAMS, 'deviceKey required')
        // An owner phone may NOT revoke another OWNER device (proposal security review):
        // owner-vs-owner stays a dashboard-only action, so a stolen owner phone cannot lock
        // out the real owner's other owner devices. It CAN revoke full/guest/readonly.
        const target = await owner.getGrant(params.deviceKey)
        if (target && !target.revokedAt && target.scope === SCOPE.OWNER) {
          return ctx.fail(ERR.FORBIDDEN, 'revoke an owner device from the dashboard')
        }
        const { grant: row, killed } = await owner.revokeDevice(params.deviceKey)
        if (!row) return ctx.reply({ ok: false, notFound: true })
        log('owner:revoke', { killed })
        return ctx.reply({ ok: true, killed })
      }

      case 'request.delete': {
        if (!state || !grant) return ctx.fail(ERR.FORBIDDEN, 'no grant')
        if (!params?.id) return ctx.fail(ERR.BAD_PARAMS, 'id required')
        // You can only remove YOUR OWN request. The requester on the row is host-derived
        // (ownerOf), so this compares the caller's identity to it - a device cannot delete
        // someone else's request by guessing an id. A resolved OR a pending one (withdraw).
        const row = await state.getRequest(params.id)
        if (!row) return ctx.reply({ ok: true, deleted: false }) // already gone
        if (row.requester !== ownerOf(grant)) return ctx.fail(ERR.FORBIDDEN, 'not your request')
        const deleted = await state.deleteRequest(params.id)
        // A WITHDRAWAL IS NEWS TO THE OPERATORS TOO. Only the arrival of a request was ever
        // pushed, so an owner sitting on Manage watched the queue grow and never shrink - the row
        // stayed until something made the app ask again (Tim, 2026-07-30). No payload beyond the
        // reason: the owner list is a live read, and telling it "something changed" is enough.
        if (deleted) await notifyOwners(presence, grants, 'requests:changed', { reason: 'withdrawn', id: params.id })
        log('request:delete', { deleted })
        return ctx.reply({ ok: true, deleted })
      }

      // --- play session: cross-device handoff (proposal 2026-07-17) ----------
      //
      // ownerOf(grant) keys the session to the PERSON; grant.deviceKey identifies WHICH of
      // their devices is acting. Both come from the Noise-authenticated connection, never a
      // param - a device can only ever touch its own owner's session and claim as itself.
      case 'session.get': {
        if (!state || !grant) return ctx.fail(ERR.FORBIDDEN, 'no grant')
        // merged = the cross-host session (phase 3): a distinct row keyed the same owner,
        // holding a queue that spans hosts. Same auth, same shape.
        const merged = !!params?.merged
        const row = await state.getSession(ownerOf(grant), merged)
        if (!row) return ctx.reply(null)
        // Enrich so the app can render "Playing on <name>" / "Play here" with no extra lookup:
        // is THIS device the active one, and if not, what is the active device called.
        const isActiveHere = row.activeDeviceKey === grant.deviceKey
        let activeDeviceName = null
        if (!isActiveHere && grants) {
          const g = await grants.get(row.activeDeviceKey)
          activeDeviceName = g?.label || null
        }
        return ctx.reply({ ...row, isActiveHere, activeDeviceName })
      }

      case 'session.claim': {
        if (!state || !grant) return ctx.fail(ERR.FORBIDDEN, 'no grant')
        const merged = !!params?.merged
        const owner = ownerOf(grant)
        // Who held the token BEFORE this claim - so we can tell them, instantly, that they lost
        // it (instead of them finding out lazily on their next heartbeat, deferred follow-up #1).
        const prev = (await state.getSession(owner, merged))?.activeDeviceKey || null
        // ...and who held the OTHER scope, because a claim now takes both (proposal
        // 2026-07-30-one-token-across-scopes). Read BEFORE the claim, or we read ourselves.
        const prevOther = (await state.getSession(owner, !merged))?.activeDeviceKey || null
        // Compare-and-set on the generation the client last saw. null = it lost the race.
        const row = await state.claimSession(owner, grant.deviceKey, Number(params?.generation) || 0, merged)
        // Push only on a SUCCESSFUL takeover from a DIFFERENT device (an idempotent re-claim by
        // the current holder, or a lost CAS race, must not tell anyone to stop). presence is
        // null in the unit tests; the push is best-effort and never gates the reply.
        let pushed = 0
        if (row && presence) {
          if (prev && prev !== grant.deviceKey) {
            pushed += presence.notify(prev, 'session-superseded', { generation: row.generation, merged })
          }
          // The other scope's loser gets the same message, carrying ITS row's new generation and
          // ITS scope - a device must never be handed a generation from a row it does not read.
          // Skipped when the same device held both, which is the ordinary single-phone case.
          if (prevOther && prevOther !== grant.deviceKey && prevOther !== prev) {
            const otherRow = await state.getSession(owner, !merged)
            pushed += presence.notify(prevOther, 'session-superseded',
              { generation: otherRow?.generation ?? null, merged: !merged })
          }
        }
        log('session:claim', { merged, ok: !!row, generation: row?.generation ?? null, superseded: pushed })
        return ctx.reply({ ok: !!row, session: row })
      }

      case 'session.set': {
        if (!state || !grant) return ctx.fail(ERR.FORBIDDEN, 'no grant')
        // Only the active device may write. null (ok:false) = superseded - the client learns
        // here that it lost the token (lazy presence) and pauses.
        const row = await state.setSession(ownerOf(grant), grant.deviceKey, params || {}, !!params?.merged)
        return ctx.reply({ ok: !!row, session: row })
      }

      // --- Home Assistant speakers (proposal 2026-08-01) ---------------------
      //
      // OWNER only in phase 1. A guest streaming to their own headphones is one thing;
      // a guest starting the kitchen speaker in someone else's house is another. The
      // rule is asserted here AND in host/cast.js (which re-checks it on every audio
      // fetch, long after this connection's `grant` was captured).
      //
      // An unconfigured host answers `enabled: false` rather than an error, so the app
      // can hide the button without treating a normal state as a failure.
      case 'speaker.list': {
        if (!speakers) return ctx.fail(ERR.NO_METHOD, 'speakers unavailable')
        if (grant?.scope !== SCOPE.OWNER) return ctx.fail(ERR.FORBIDDEN, 'owner only')
        if (!speakers.enabled()) return ctx.reply({ enabled: false, speakers: [] })
        const list = await speakers.list()
        return ctx.reply({ enabled: true, speakers: list, active: speakers.active(grant.deviceKey) })
      }

      case 'speaker.play': {
        if (!speakers) return ctx.fail(ERR.NO_METHOD, 'speakers unavailable')
        if (grant?.scope !== SCOPE.OWNER) return ctx.fail(ERR.FORBIDDEN, 'owner only')
        if (!params?.entityId || !params?.trackId) return ctx.fail(ERR.BAD_PARAMS, 'entityId and trackId required')
        if (!speakers.enabled()) return ctx.fail(ERR.FORBIDDEN, 'Home Assistant is not set up')
        // deviceKey comes from the Noise-authenticated grant, never from params - a
        // device can only ever cast as itself, which is what makes revoke able to find it.
        await speakers.play(grant.deviceKey, String(params.entityId), String(params.trackId))
        log('speaker:play', { entityId: params.entityId })
        return ctx.reply({ ok: true })
      }

      case 'speaker.stop': {
        if (!speakers) return ctx.fail(ERR.NO_METHOD, 'speakers unavailable')
        if (grant?.scope !== SCOPE.OWNER) return ctx.fail(ERR.FORBIDDEN, 'owner only')
        if (!params?.entityId) return ctx.fail(ERR.BAD_PARAMS, 'entityId required')
        await speakers.stop(grant.deviceKey, String(params.entityId))
        log('speaker:stop', { entityId: params.entityId })
        return ctx.reply({ ok: true })
      }

      // Pause and resume the SPEAKER (proposal 2026-08-02). Without these, the player's
      // play/pause button had nothing to talk to while casting, so it drove the phone and
      // put a second copy of the song in the room.
      case 'speaker.pause': {
        if (!speakers) return ctx.fail(ERR.NO_METHOD, 'speakers unavailable')
        if (grant?.scope !== SCOPE.OWNER) return ctx.fail(ERR.FORBIDDEN, 'owner only')
        if (!params?.entityId) return ctx.fail(ERR.BAD_PARAMS, 'entityId required')
        await speakers.pause(String(params.entityId))
        return ctx.reply({ ok: true })
      }

      case 'speaker.resume': {
        if (!speakers) return ctx.fail(ERR.NO_METHOD, 'speakers unavailable')
        if (grant?.scope !== SCOPE.OWNER) return ctx.fail(ERR.FORBIDDEN, 'owner only')
        if (!params?.entityId) return ctx.fail(ERR.BAD_PARAMS, 'entityId required')
        await speakers.resume(String(params.entityId))
        return ctx.reply({ ok: true })
      }

      case 'speaker.volume': {
        if (!speakers) return ctx.fail(ERR.NO_METHOD, 'speakers unavailable')
        if (grant?.scope !== SCOPE.OWNER) return ctx.fail(ERR.FORBIDDEN, 'owner only')
        if (!params?.entityId) return ctx.fail(ERR.BAD_PARAMS, 'entityId required')
        const level = Number(params.level)
        if (!Number.isFinite(level)) return ctx.fail(ERR.BAD_PARAMS, 'level required')
        await speakers.setVolume(String(params.entityId), level)
        return ctx.reply({ ok: true })
      }

      // Read-only, so it is not in MUTATING - but still owner-gated, because the
      // entity list itself is information about someone's house.
      case 'speaker.state': {
        if (!speakers) return ctx.fail(ERR.NO_METHOD, 'speakers unavailable')
        if (grant?.scope !== SCOPE.OWNER) return ctx.fail(ERR.FORBIDDEN, 'owner only')
        if (!params?.entityId) return ctx.fail(ERR.BAD_PARAMS, 'entityId required')
        if (!speakers.enabled()) return ctx.fail(ERR.FORBIDDEN, 'Home Assistant is not set up')
        return ctx.reply(await speakers.state(String(params.entityId)))
      }

      // The words for one track (proposal 2026-09-21). Read-only library data, so a
      // readonly grant may ask; a source with no lyrics() answers an empty list rather
      // than an error, because "this song has no words here" is not a failure.
      case 'lyrics.get': {
        const src = adapterFor()
        if (typeof src.lyrics !== 'function') return ctx.reply({ synced: false, lines: [] })
        const got = await src.lyrics({ trackId: params?.trackId })
        return ctx.reply(got && Array.isArray(got.lines) ? { synced: !!got.synced, lines: got.lines } : { synced: false, lines: [] })
      }

      case 'art.get': {
        const stream = await adapterFor().art(params || {})
        if (!stream) return ctx.fail(ERR.NOT_FOUND, 'no artwork')
        return ctx.stream(stream)
      }

      // What the device is playing FROM US right now. The phone is the only party that knows -
      // a host sees requests, not playback, and it cannot tell when someone moved to a track
      // another library serves (proposal 2026-07-28). Deliberately NOT persisted and NOT
      // acknowledged with anything but ok: it describes this instant and expires on its own.
      case 'nowplaying.set': {
        // The deviceKey is THIS connection's Noise-authenticated one, so a device can only ever
        // speak about itself.
        if (onNowPlaying) onNowPlaying(grant.deviceKey, params || null)
        return ctx.reply({ ok: true })
      }
    }
  }

  return {
    methods: Object.fromEntries(METHODS.map((name) => [name, handle])),
    mutating: [...MUTATING],

    // caps: what this host can do beyond protocol 1, so a NEWER phone degrades
    // deliberately instead of optimistically. timeOffset = media.stream honours
    // timeOffsetMs (ffmpeg -ss); a phone that sees no caps seeks the old way,
    // keeping its clock and its audio telling the same story (found on a real
    // Pixel against a pre-timeOffset host: the clock jumped, the audio restarted).
    //
    // books = this source labels audiobooks with kind:'book' (proposal 2026-09-13).
    // Absent, not false, on a source that cannot: an older phone reads caps the same.
    // The body is exactly what PearTune hosts have always sent (no `app` field).
    ping: async (ctx) => ({ protocol: 1, libraryId: ctx.libraryId, caps: { timeOffset: await hasFfmpeg(), ...(getAdapter()?.books ? { books: 1 } : {}), ...(typeof getAdapter()?.lyrics === 'function' ? { lyrics: 1 } : {}) } }),

    // Through the caller's view, so a narrowed person gets no bytes of a hidden track.
    // Thrown as typed errors with PearTune's own messages: a null return would make the
    // package answer 'no such item', which is not what PearTune phones have been sent.
    openStream: async (params, ctx) => {
      if (!params?.trackId) throw ctx.badParams('trackId required')
      const stream = await viewOf(getAdapter(), ctx.grant).stream(params)
      if (!stream) throw ctx.notFound('no such track')
      return stream
    },

    // THIS host is the one serving these bytes, which is the only thing it knows for certain
    // about what a device is listening to (Tim, 2026-07-28: show now-playing where the music
    // is actually coming from). Recorded per device by the caller.
    onStream: onStream ? (params, ctx) => onStream(ctx.deviceKey, params.trackId) : null
  }
}

module.exports = { createMedia, serveFarewell, ownerOf, MUTATING, METHODS }

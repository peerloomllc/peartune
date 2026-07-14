# Dashboard auth (and why the host must own the network)

**Goal** - let PearTune ship as an installable Umbrel app without putting the
revoke buttons and the pairing QR on an unauthenticated LAN port.

**Tier** - **T3.** This is an auth gate on the control plane. Constitution §2:
"auth gates" are T3, and this one guards the page that can revoke every device and
mint a pairing window.

---

## The chain of facts that forces this

1. **The host needs `network_mode: host`.** Re-measured today, on the Umbrel, with
   the real image: under Docker's default bridge the host's firewall ADMITS the
   client (`gate:allow-for-pairing`) and the connection then dies before the pair
   channel opens. Bridge NAT is a second layer of NAT and holepunching does not
   survive it. This is not a guess and not a stale note - it reproduced today,
   twice, with a fresh container.

2. **Host networking means Umbrel's `app_proxy` cannot front us.** The proxy is a
   container on a bridge network; it cannot reach a service bound to the host's
   127.0.0.1. Umbrel's own host-networked apps (Plex, Home Assistant) simply do not
   use the proxy: they declare a `port:` and serve their UI straight onto the LAN.

3. **The proxy is the ONLY thing standing in for our missing auth.** The dashboard
   has none by design ("no auth BY DESIGN (sits behind Umbrel's app_proxy), so it
   binds 127.0.0.1 unless the container says otherwise" - DONE, 2026-07-13). Today
   the operator reaches it through an SSH tunnel.

So: to be an app anyone can install, the dashboard must be reachable on the LAN;
to be reachable on the LAN, it must have a lock on the door. There is no third
option that keeps holepunching working.

## What the dashboard actually protects

Worth stating plainly, because it sets the bar:

- **Revoke** - any device, instantly, mid-song.
- **Pairing windows** - open one and anyone who can see the QR (or the link the API
  returns) gets a grant on the library.
- **Device and person names** - now that identity exists.

An unauthenticated LAN port here is not "a status page is exposed". It is "anyone
on your wifi can grant themselves your music library and kick your family off it".

## Scope

### Auth

- `PEARTUNE_PASSWORD` (Umbrel passes `${APP_PASSWORD}`). When set, EVERY request to
  the dashboard and its `/api/*` routes must present it.
- Mechanism: a login form that sets a session cookie (`HttpOnly`, `SameSite=Strict`,
  `Path=/`), holding a random session id minted at login. HTTP Basic was the
  simpler option and is rejected: browsers cache it invisibly, there is no logout,
  and it puts the password in every request including the ones the page makes for
  the QR.
- The password comparison is CONSTANT TIME (`crypto.timingSafeEqual` on hashes of
  equal length), because a naive `===` on a secret is a timing oracle, and this is
  the one page where that matters.
- Sessions live in memory, so a host restart logs everyone out. Correct: sessions
  are not worth persisting, and a restart is the cheapest revocation we have.
- Rate limit: after 5 failures from one IP, refuse that IP for 60 seconds. A LAN
  password is guessable at speed otherwise.

### Bind address: fail CLOSED

The rule that keeps this honest:

| `PEARTUNE_PASSWORD` | default bind | meaning |
|---|---|---|
| unset | `127.0.0.1` | today's behaviour. Loopback only, no auth, reachable by SSH tunnel. |
| set | `0.0.0.0` | LAN-reachable, password required. |

**The host REFUSES to start if it is told to bind a non-loopback address with no
password.** Not a warning - an exit. Every "expose it just for a minute" is how the
control plane ends up open forever, and a warning in a log nobody reads is not a
control.

### Not in scope

- TLS. On a home LAN, over plain HTTP, the password crosses in the clear. This is
  exactly what every other Umbrel app does, and Umbrel itself terminates nothing
  for host-networked apps. Say so in the README rather than pretend otherwise; a
  self-signed cert would train people to click through warnings, which is worse.
- Multi-user operator accounts. One password, one operator.

## Compat

- Existing deployments (including Tim's Umbrel, which runs with no password and a
  loopback bind) are UNCHANGED: no password, no auth, loopback. Nothing breaks.
- The Umbrel app sets `PEARTUNE_PASSWORD=${APP_PASSWORD}` and binds `0.0.0.0`, and
  the manifest advertises the credentials in umbrelOS's UI (`defaultUsername`,
  `defaultPassword`).

## Verify

- Unit: no password -> no gate. Password set -> `/`, `/api/state`, `/api/pair/start`
  and `/api/revoke` all 401 without a session; 200 with one. A wrong password does
  not authenticate. Constant-time compare is used. Rate limit trips at 5.
- Unit: the host EXITS if asked to bind 0.0.0.0 with no password.
- On the Umbrel: install from the community store, open the app from umbrelOS, log
  in with the shown password, pair a phone, revoke it. Then confirm from another
  machine on the LAN that the dashboard refuses without the password.

## Rollback

The gate is off unless `PEARTUNE_PASSWORD` is set, so reverting is: unset it and go
back to a loopback bind. Any release that turns out broken can be pinned back in
the store manifest (the image is pinned by digest).

## RCA readiness

The failure that would matter is "the dashboard was reachable and unlocked". The
test that catches it asserts the EXIT, not a warning: a host that would serve an
unauthenticated non-loopback port must refuse to run at all.

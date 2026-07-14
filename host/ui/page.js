// The dashboard page, as a string. No build step, no framework, no CDN.
//
// Milestone 1 UI: show the QR, list the devices, revoke any of them. It is meant
// to be honest rather than pretty; the real design pass comes with the app.

module.exports = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PearTune host</title>
<style>
  :root {
    --bg: #faf9f7; --fg: #1a1815; --muted: #6b6560;
    --line: #e2ddd6; --card: #fff; --accent: #2f7d5d; --danger: #b0413e;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14130f; --fg: #f0ece5; --muted: #948d84;
      --line: #2c2a25; --card: #1c1a16; --accent: #57ad86; --danger: #e0716d;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1.25rem; background: var(--bg); color: var(--fg);
    font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 46rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 .2rem; letter-spacing: -.01em; }
  .sub { color: var(--muted); margin: 0 0 2rem; font-size: .9rem; }
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: 12px;
    padding: 1.25rem; margin-bottom: 1.25rem;
  }
  h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .07em;
       color: var(--muted); margin: 0 0 1rem; font-weight: 600; }
  button {
    font: inherit; font-weight: 500; padding: .5rem 1rem; border-radius: 8px;
    border: 1px solid var(--line); background: var(--card); color: var(--fg);
    cursor: pointer;
  }
  button:hover { border-color: var(--muted); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, transparent); }
  button.danger:hover { background: var(--danger); color: #fff; border-color: var(--danger); }
  #qr { margin: 1rem 0; }
  #qr svg { width: 220px; height: 220px; background: #fff; padding: 10px; border-radius: 8px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem;
         color: var(--muted); word-break: break-all; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: .7rem .5rem; border-top: 1px solid var(--line); vertical-align: middle; }
  tr:first-child td { border-top: 0; }
  .name { font-weight: 500; }
  .meta { color: var(--muted); font-size: .8rem; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%;
         background: var(--accent); margin-right: .4rem; }
  .dot.off { background: var(--line); }
  .revoked { color: var(--danger); font-size: .8rem; }
  .empty { color: var(--muted); font-size: .9rem; }
  .addrow { display: flex; gap: .5rem; margin-top: 1rem; }
  .addrow input { flex: 1; font: inherit; padding: .5rem .7rem; border-radius: 8px;
                  border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
  select { font: inherit; font-size: .85rem; padding: .35rem .5rem; border-radius: 8px;
           border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
  .flash { padding: .7rem 1rem; border-radius: 8px; margin-bottom: 1rem;
           background: color-mix(in srgb, var(--accent) 12%, transparent);
           border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
           font-size: .9rem; }
</style>
</head>
<body>
<main>
  <h1 id="lib">PearTune</h1>
  <p class="sub" id="sub">loading…</p>

  <div id="flash"></div>

  <div class="card">
    <h2>Pair a device</h2>
    <div id="pairbox">
      <button class="primary" onclick="startPair()">Show pairing code</button>
      <p class="meta" style="margin:.75rem 0 0">
        Opens a 5 minute window. Scan the code in PearTune on your phone.
      </p>
    </div>
  </div>

  <div class="card">
    <h2>People</h2>
    <div id="people"><p class="empty">No people yet.</p></div>
    <div class="addrow">
      <input id="pname" placeholder="Name (e.g. Ben)" />
      <button onclick="addPerson()">Add person</button>
    </div>
    <p class="meta" style="margin:.75rem 0 0">
      Assign a device to a person, then you can revoke that person's access in one
      click without touching anyone else's devices.
    </p>
  </div>

  <div class="card">
    <h2>Devices</h2>
    <div id="devices"><p class="empty">No devices paired yet.</p></div>
  </div>
</main>

<script>
let timer = null

async function api (path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return res.json()
}

function flash (msg) {
  document.getElementById('flash').innerHTML = '<div class="flash">' + msg + '</div>'
  setTimeout(() => { document.getElementById('flash').innerHTML = '' }, 6000)
}

function ago (ts) {
  if (!ts) return 'never'
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return s + 's ago'
  if (s < 3600) return Math.floor(s / 60) + 'm ago'
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'
  return Math.floor(s / 86400) + 'd ago'
}

async function startPair () {
  const { link, svg } = await api('/api/pair/start', {})
  document.getElementById('pairbox').innerHTML =
    '<div id="qr">' + svg + '</div>' +
    '<p class="meta">Valid for 5 minutes. Closes as soon as one device pairs.</p>' +
    '<code>' + link + '</code><br><br>' +
    '<button onclick="stopPair()">Cancel</button>'
}

async function stopPair () {
  await api('/api/pair/stop', {})
  document.getElementById('pairbox').innerHTML =
    '<button class="primary" onclick="startPair()">Show pairing code</button>' +
    '<p class="meta" style="margin:.75rem 0 0">Opens a 5 minute window. Scan the code in PearTune on your phone.</p>'
}

let PEOPLE = []
let DEVICES = []

async function addPerson () {
  const el = document.getElementById('pname')
  const name = el.value.trim()
  if (!name) return
  const r = await api('/api/person', { name })
  if (r.error) return flash('Failed: ' + r.error)
  el.value = ''
  flash('Added <b>' + name + '</b>.')
  refresh()
}

async function assign (deviceKey, personId) {
  const r = await api('/api/assign', { deviceKey, personId: personId || null })
  if (r.error) return flash('Failed: ' + r.error)
  refresh()
}

async function revokePerson (id, name) {
  if (!confirm('Revoke ALL of ' + name + '\\'s devices?\\n\\nThey lose access immediately, even mid-song. Nobody else is affected. Their play counts stay in your history.')) return
  const r = await api('/api/person/revoke', { personId: id })
  if (r.error) return flash('Failed: ' + esc(r.error))
  flash('Revoked <b>' + esc(name) + '</b>: ' + r.devices + ' device(s), ' +
        r.killed + ' live connection(s) cut off.')
  refresh()
}

// EVERY string that came from a device or an operator goes through this before it
// reaches innerHTML.
//
// This is not hygiene, it is a fix: the device LABEL arrives in deviceHello from any
// device that reaches the pairing window, and it was interpolated raw into this page
// - the page with the revoke buttons and the pairing QR on it. That is a stored XSS
// on the control plane. (Proposal 2026-07-14. The host also sanitizes names at the
// store; this is the second layer, at the render.)
//
// NOTE: this whole file is ONE TEMPLATE LITERAL. A backtick in a comment closes the
// string and the dashboard stops parsing. Do not use them here.
function esc (s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderPeople (people, devices) {
  const el = document.getElementById('people')
  const live = people.filter(p => !p.revokedAt)
  if (!live.length) {
    el.innerHTML = '<p class="empty">No people yet. Add one below.</p>'
    return
  }
  el.innerHTML = '<table>' + live.map(p => {
    const theirs = devices.filter(d => d.personId === p.id && !d.revokedAt)
    const online = theirs.filter(d => d.online).length
    return '<tr>' +
      '<td><div class="name">' + esc(p.name) + '</div>' +
        '<span class="meta">' + theirs.length + ' device' + (theirs.length === 1 ? '' : 's') +
        (online ? ' · <span class="dot"></span>' + online + ' online' : '') + '</span></td>' +
      '<td style="text-align:right">' +
        (theirs.length
          ? '<button class="danger" onclick="revokePerson(\\'' + p.id + '\\', \\'' +
            esc(p.name) + '\\')">Revoke all</button>'
          : '<span class="meta">no devices</span>') +
      '</td></tr>'
  }).join('') + '</table>'
}

// The label is LOOKED UP, not passed in. It used to be interpolated into the
// button's onclick attribute, which is precisely the injection this page must not
// have (the label comes from the device, over the wire).
async function revoke (key) {
  const d = DEVICES.find(x => x.deviceKey === key)
  const label = d ? d.label : 'this device'
  if (!confirm('Revoke "' + label + '"?\\n\\nIt loses access immediately, even mid-song. Its play counts stay in your history.')) return
  const r = await api('/api/revoke', { deviceKey: key })
  if (r.error) return flash('Failed: ' + esc(r.error))
  // Say which actually happened. "Revoked" and "revoked AND the music stopped"
  // are different claims.
  flash(r.killed > 0
    ? 'Revoked <b>' + esc(label) + '</b> and cut off ' + r.killed + ' live connection' + (r.killed === 1 ? '' : 's') + '.'
    : 'Revoked <b>' + esc(label) + '</b>. It was not connected.')
  refresh()
}

// The operator turning a device's CLAIM into a real assignment. This is the only
// path from "says it is Tim" to "is Tim": the device cannot do it itself.
async function confirmClaim (key) {
  const d = DEVICES.find(x => x.deviceKey === key)
  if (!d || !d.claimedUser) return
  if (!confirm('Confirm that "' + d.label + '" belongs to ' + d.claimedUser + '?\\n\\nThey will be created if they are new, and you can then revoke all of their devices in one click.')) return
  const r = await api('/api/person/confirm', { deviceKey: key })
  if (r.error) return flash('Failed: ' + esc(r.error))
  flash('<b>' + esc(d.label) + '</b> now belongs to <b>' + esc(r.person.name) + '</b>.')
  refresh()
}

function renderDevices (devices) {
  const el = document.getElementById('devices')
  if (!devices.length) {
    el.innerHTML = '<p class="empty">No devices paired yet.</p>'
    return
  }
  const live = PEOPLE.filter(p => !p.revokedAt)

  el.innerHTML = '<table>' + devices.map(d => {
    const status = d.revokedAt
      ? '<span class="revoked">revoked ' + ago(d.revokedAt) + '</span>'
      : '<span class="meta"><span class="dot ' + (d.online ? '' : 'off') + '"></span>' +
        (d.online ? 'connected' : 'last seen ' + ago(d.lastSeenAt)) + '</span>'

    // Who holds this device? Picking a person here is what turns a key into
    // somebody you can revoke by name.
    const owner = d.revokedAt
      ? ''
      : '<select onchange="assign(\\'' + d.deviceKey + '\\', this.value)">' +
          '<option value=""' + (d.personId ? '' : ' selected') + '>— unassigned —</option>' +
          live.map(p => '<option value="' + p.id + '"' +
            (d.personId === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') +
        '</select>'

    // The key ONLY. A device-supplied label was being interpolated into this
    // onclick, which is exactly the injection this page must not have.
    const action = d.revokedAt
      ? ''
      : '<button class="danger" onclick="revoke(\\'' + d.deviceKey + '\\')">Revoke</button>'

    // A device says who it belongs to; the OPERATOR decides. Until confirmed the
    // claim is cosmetic and grants nothing (proposal 2026-07-14).
    //
    // Shown whenever the claim does not MATCH the person it is assigned to - not
    // only when it is unassigned. Somebody who renames themselves after being
    // confirmed is making a new claim, and hiding it left the operator looking at a
    // name nobody uses any more. The device still cannot move itself: this button
    // is the operator's.
    const holder = PEOPLE.find(p => p.id === d.personId)
    const matches = holder && d.claimedUser &&
      holder.name.toLowerCase() === d.claimedUser.toLowerCase()
    const claim = (!d.revokedAt && d.claimedUser && !matches)
      ? '<div class="claim">' + (holder ? 'now claims to be ' : 'claims to be ') +
        '<b>' + esc(d.claimedUser) + '</b> ' +
        '<button onclick="confirmClaim(\\'' + d.deviceKey + '\\')">Confirm</button></div>'
      : ''

    return '<tr>' +
      '<td><div class="name">' + esc(d.label) + '</div>' + status + claim + '</td>' +
      '<td>' + owner + '</td>' +
      '<td style="text-align:right">' + action + '</td>' +
    '</tr>'
  }).join('') + '</table>'
}

async function refresh () {
  const s = await api('/api/state')
  PEOPLE = s.persons || []
  DEVICES = s.devices || []
  document.getElementById('lib').textContent = s.libraryName
  document.getElementById('sub').textContent =
    s.stats.tracks + ' tracks · ' + s.stats.source + ' · ' +
    s.devices.filter(d => !d.revokedAt).length + ' device(s)'
  renderPeople(PEOPLE, s.devices)
  renderDevices(s.devices)
}

refresh()
timer = setInterval(refresh, 3000)
</script>
</body>
</html>`

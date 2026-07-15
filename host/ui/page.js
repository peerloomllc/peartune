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
       color: var(--muted); margin: 0 0 1rem; font-weight: 600; text-align: center; }
  button {
    font: inherit; font-weight: 500; padding: .5rem 1rem; border-radius: 8px;
    border: 1px solid var(--line); background: var(--card); color: var(--fg);
    cursor: pointer;
  }
  button:hover { border-color: var(--muted); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, transparent); }

  /* --- music source --------------------------------------------------- */
  /* fit-content + auto side margins centres just the pill, leaving the fields below
     left-aligned where they read best. */
  .seg { display: flex; width: fit-content; gap: .25rem; padding: 3px; margin: 0 auto .8rem;
         border: 1px solid var(--line); border-radius: 9999px; background: var(--bg); }
  .seg button { border: none; border-radius: 9999px; padding: .35rem 1rem; background: transparent; }
  .seg button.on { background: var(--accent); color: #fff; }
  #source label { display: block; margin: .6rem 0 .2rem; color: var(--muted); font-size: .8rem; }
  #source input {
    width: 100%; max-width: 28rem; padding: .5rem .6rem; font: inherit;
    border: 1px solid var(--line); border-radius: 8px;
    background: var(--bg); color: var(--fg);
  }
  #source .row { display: flex; align-items: center; gap: .5rem; margin-top: .9rem; }
  .ok { color: var(--accent); }
  .hint { color: var(--muted); font-size: .8rem; line-height: 1.5; margin: .8rem 0 0; }
  .hint.warn { color: var(--warn, #ffb74d); }
  .err {
    padding: .7rem .9rem; border-radius: 8px; margin-bottom: 1rem; font-size: .85rem;
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
  }

  /* --- the folder picker ------------------------------------------------ */
  .pick { display: flex; gap: .5rem; align-items: center; max-width: 28rem; }
  .pick input { flex: 1; }
  #browse {
    margin-top: .8rem; border: 1px solid var(--line); border-radius: 10px;
    max-width: 28rem; overflow: hidden; background: var(--bg);
  }
  #browse .head {
    display: flex; gap: .5rem; align-items: center; justify-content: space-between;
    padding: .5rem .6rem; border-bottom: 1px solid var(--line);
  }
  #browse .head code { color: var(--fg); }
  #browse ul { list-style: none; margin: 0; padding: 0; max-height: 15rem; overflow-y: auto; }
  #browse li { border-top: 1px solid var(--line); }
  #browse li:first-child { border-top: 0; }
  #browse li button {
    width: 100%; text-align: left; border: 0; border-radius: 0; background: transparent;
    padding: .45rem .6rem; display: flex; justify-content: space-between; gap: .5rem;
  }
  #browse li button:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); }
  #browse .has { color: var(--accent); font-size: .75rem; }
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
  .link { background: none; border: 0; padding: 0; font: inherit; color: var(--accent);
          text-decoration: underline; cursor: pointer; }
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

  <div class="card">
    <h2>Music source</h2>
    <div id="sourceerr" class="err" style="display:none"></div>
    <div id="source"></div>
    <p class="hint">
      Point PearTune at a Navidrome or Jellyfin you already run and you get its tags,
      artwork and transcoding. A plain folder works too - PearTune reads the tags
      itself (artist, album, track number, year and embedded cover art).
    </p>
    <p class="hint warn" id="sourcewarn" style="display:none">
      Changing the source changes every track's identity, so play counts and resume
      positions from the old source will not follow. Nothing is deleted.
    </p>
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
// Revoked devices are hidden by default so the live list stays short; the footer under
// Devices toggles them, and each shown revoked row gets a Delete to purge it for good.
let SHOW_REVOKED = false

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

// Only offered for a person with NO devices, so this removes a record, not access.
async function deletePerson (id, name) {
  if (!confirm('Delete ' + name + ' from the list?\\n\\nThey have no devices, so this only tidies the list. Nothing is revoked.')) return
  const r = await api('/api/person/delete', { personId: id })
  if (r.error) return flash('Failed: ' + esc(r.error))
  flash('Deleted <b>' + esc(name) + '</b> from the list.')
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
          // No devices: nothing to revoke, so offer to remove the empty row instead of
          // leaving a dead "no devices" label that never clears.
          : '<button class="danger" onclick="deletePerson(\\'' + p.id + '\\', \\'' +
            esc(p.name) + '\\')">Delete</button>') +
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

// Delete only ever appears on an ALREADY-REVOKED device, so this removes the record,
// not the access. The host refuses to delete a live grant, and a deleted device stays
// locked out until it pairs again - deleting cannot re-admit it.
async function deleteDevice (key) {
  const d = DEVICES.find(x => x.deviceKey === key)
  const label = d ? d.label : 'this device'
  if (!confirm('Delete "' + label + '" from the list?\\n\\nAccess is already revoked and stays revoked. This only removes the record; the device would have to pair again to return.')) return
  const r = await api('/api/device/delete', { deviceKey: key })
  if (r.error) return flash('Failed: ' + esc(r.error))
  flash('Deleted <b>' + esc(label) + '</b> from the list.')
  refresh()
}

function toggleRevoked () {
  SHOW_REVOKED = !SHOW_REVOKED
  renderDevices(DEVICES)
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

// The dashboard polls every 3 seconds and re-renders. That MUST NOT touch a form the
// operator is in the middle of editing: click Folder, and two seconds later the poll
// would re-render the card from the server's truth (still Navidrome) and throw your
// choice away. A half-typed URL or password went the same way.
//
// So: once you touch this card, it belongs to you until you Save or Cancel. The poll
// keeps updating everything else on the page.
let SOURCE_DIRTY = false

function markSourceDirty () {
  SOURCE_DIRTY = true
  document.getElementById('sourcewarn').style.display = 'block'
  document.getElementById('srccancel').style.display = ''
}

// SERVER sources look alike; a folder does not. Everything that differs between
// Navidrome and Jellyfin is the word on the button.
const SERVERS = {
  navidrome: { label: 'Navidrome', placeholder: 'http://localhost:4533' },
  jellyfin: { label: 'Jellyfin', placeholder: 'http://localhost:8096' }
}

let PICKED = 'folder'

function serverFields (kind, cfg) {
  const s = SERVERS[kind]
  return '<div id="k_' + kind + '" class="kind" style="display:none">' +
    '<label>' + s.label + ' URL</label>' +
    '<input id="' + kind + '_url" oninput="markSourceDirty()" placeholder="' + s.placeholder +
      '" value="' + esc(cfg.url) + '">' +
    '<label>Username</label>' +
    '<input id="' + kind + '_user" oninput="markSourceDirty()" placeholder="umbrel" value="' + esc(cfg.username) + '">' +
    '<label>Password</label>' +
    // The password is never sent BACK to the browser (host/source.js). An empty box
    // on an already-configured source means "leave it as it is".
    '<input id="' + kind + '_pass" type="password" oninput="markSourceDirty()" placeholder="' +
      (cfg.hasPassword ? 'unchanged' : 'password') + '">' +
  '</div>'
}

function renderSource (src, force) {
  if (SOURCE_DIRTY && !force) return

  const el = document.getElementById('source')
  const kinds = (src && src.kinds) || {}
  const active = (src && src.active) || 'folder'
  const folder = kinds.folder || {}

  el.innerHTML =
    '<div class="seg">' +
      '<button id="s_navidrome" onclick="pickSource(\\'navidrome\\')">Navidrome</button>' +
      '<button id="s_jellyfin" onclick="pickSource(\\'jellyfin\\')">Jellyfin</button>' +
      '<button id="s_folder" onclick="pickSource(\\'folder\\')">Folder</button>' +
    '</div>' +
    serverFields('navidrome', kinds.navidrome || {}) +
    serverFields('jellyfin', kinds.jellyfin || {}) +
    '<div id="k_folder" class="kind" style="display:none">' +
      '<label>Folder <span class="meta">- a path INSIDE the PearTune container</span></label>' +
      '<div class="pick">' +
        '<input id="f_root" oninput="markSourceDirty()" placeholder="/music" value="' +
          esc(folder.root || '/music') + '">' +
        '<button onclick="openBrowse()">Browse…</button>' +
      '</div>' +
      '<div id="browse" style="display:none"></div>' +
    '</div>' +
    '<div class="row">' +
      '<button onclick="testSource()">Test</button>' +
      '<button class="primary" onclick="saveSource()">Save</button>' +
      '<button onclick="rescan()">Rescan</button>' +
      '<button id="srccancel" style="display:none" onclick="cancelSource()">Cancel</button>' +
      '<span id="srcmsg" class="meta"></span>' +
    '</div>'

  showKind(active)
}

// Hand the card back to the server: whatever is actually running wins again.
function cancelSource () {
  SOURCE_DIRTY = false
  document.getElementById('sourcewarn').style.display = 'none'
  refresh()
}

function showKind (kind) {
  PICKED = kind
  for (const k of ['navidrome', 'jellyfin', 'folder']) {
    document.getElementById('s_' + k).className = k === kind ? 'on' : ''
    document.getElementById('k_' + k).style.display = k === kind ? 'block' : 'none'
  }
}

function pickSource (kind) {
  showKind(kind)
  markSourceDirty()
}

// Each kind's fields are their OWN, and the host keeps them that way (one config per
// kind; active is a pointer). Flipping to Folder and back no longer asks you to
// retype your Navidrome password, which is what it used to do.
function sourceForm () {
  if (PICKED === 'folder') {
    return { kind: 'folder', root: document.getElementById('f_root').value.trim() }
  }
  const cfg = {
    kind: PICKED,
    url: document.getElementById(PICKED + '_url').value.trim(),
    username: document.getElementById(PICKED + '_user').value.trim()
  }
  // Blank means "keep the password you already have"; the host fills it in.
  const pw = document.getElementById(PICKED + '_pass').value
  if (pw) cfg.password = pw
  return cfg
}

// --- the folder picker ------------------------------------------------------
//
// A free-text path the host cannot verify is what made this a trap: the box wants a
// path INSIDE THE CONTAINER, and the operator is looking at their NAS. Typing the
// path Navidrome uses gives you zero tracks - correctly, and indistinguishably from
// an empty library. So: show what the container can actually see, and let them click.
//
// Built with DOM nodes rather than string concatenation, on purpose. These names come
// off a filesystem, and this is the page with the revoke buttons on it (see esc(),
// and the stored XSS that made us write it).
async function openBrowse (path) {
  const el = document.getElementById('browse')
  el.style.display = 'block'
  el.textContent = 'looking…'

  const start = path || document.getElementById('f_root').value.trim() || '/'
  let r = await api('/api/source/folders?path=' + encodeURIComponent(start))
  // The path in the box may not exist - that is the whole reason this button is
  // here. Fall back to the root rather than showing the operator an error about
  // the thing they came here to fix.
  if (r.error) r = await api('/api/source/folders?path=/')
  if (r.error) { el.textContent = r.error; return }

  el.textContent = ''

  const head = document.createElement('div')
  head.className = 'head'

  const where = document.createElement('code')
  where.textContent = r.path + (r.here ? ' · ' + r.here + ' audio files here' : '')
  head.appendChild(where)

  const use = document.createElement('button')
  use.className = 'primary'
  use.textContent = 'Use this folder'
  use.onclick = () => {
    document.getElementById('f_root').value = r.path
    el.style.display = 'none'
    markSourceDirty()
  }
  head.appendChild(use)
  el.appendChild(head)

  const ul = document.createElement('ul')

  if (r.parent) {
    const li = document.createElement('li')
    const b = document.createElement('button')
    b.textContent = '../'
    b.onclick = () => openBrowse(r.parent)
    li.appendChild(b)
    ul.appendChild(li)
  }

  for (const d of r.dirs) {
    const li = document.createElement('li')
    const b = document.createElement('button')

    const name = document.createElement('span')
    name.textContent = d.name + '/'
    b.appendChild(name)

    // The only thing an operator actually wants to know about a directory here.
    if (d.music) {
      const tag = document.createElement('span')
      tag.className = 'has'
      tag.textContent = 'music'
      b.appendChild(tag)
    }

    b.onclick = () => openBrowse(d.path)
    li.appendChild(b)
    ul.appendChild(li)
  }

  if (!r.dirs.length && !r.here) {
    const li = document.createElement('li')
    li.className = 'empty'
    li.style.padding = '.5rem .6rem'
    li.textContent = 'nothing in here'
    ul.appendChild(li)
  }

  el.appendChild(ul)
}

async function testSource () {
  const msg = document.getElementById('srcmsg')
  msg.textContent = 'testing...'
  const r = await api('/api/source/test', sourceForm())
  if (!r.ok) {
    msg.innerHTML = '<span class="revoked">' + esc(r.error) + '</span>'
    return
  }
  // "works - 0 tracks" is the sentence that wasted an evening. Zero tracks is not a
  // pass; it means the path is wrong, or the folder is empty, and either way there
  // is nothing to play.
  msg.innerHTML = r.tracks
    ? '<span class="ok">works - ' + r.tracks + ' tracks</span>'
    : '<span class="revoked">reachable, but NO MUSIC in there. Nothing to play.</span>'
}

async function saveSource () {
  const msg = document.getElementById('srcmsg')
  msg.textContent = 'saving...'
  const r = await api('/api/source', sourceForm())
  if (!r.ok) {
    msg.innerHTML = '<span class="revoked">' + esc(r.error) + '</span>'
    return
  }
  SOURCE_DIRTY = false
  document.getElementById('sourcewarn').style.display = 'none'

  // The refresh REBUILDS this card, so the message has to be written on the other
  // side of it. Set first and it lives for a few milliseconds and vanishes, which
  // reads as "nothing happened" - and this is the button that just changed where
  // all the music comes from.
  await refresh()
  document.getElementById('srcmsg').innerHTML = '<span class="ok">saved - ' + r.tracks + ' tracks</span>'
}

// A folder has no scanner watching it. Copy an album onto the NAS and PearTune does
// not know until somebody says so - this is that somebody.
async function rescan () {
  document.getElementById('srcmsg').textContent = 'rescanning...'
  const r = await api('/api/source/rescan', {})
  await refresh()
  document.getElementById('srcmsg').innerHTML = r.ok
    ? '<span class="ok">rescanned - ' + r.tracks + ' tracks</span>'
    : '<span class="revoked">' + esc(r.error) + '</span>'
}

function renderDevices (devices) {
  const el = document.getElementById('devices')
  if (!devices.length) {
    el.innerHTML = '<p class="empty">No devices paired yet.</p>'
    return
  }
  const live = PEOPLE.filter(p => !p.revokedAt)

  // Revoked rows are dead weight in the live list. Hide them behind the footer toggle
  // unless the operator has asked to see them (to delete one).
  const revokedCount = devices.filter(d => d.revokedAt).length
  const shown = SHOW_REVOKED ? devices : devices.filter(d => !d.revokedAt)

  const footer = revokedCount
    ? '<p class="meta" style="margin-top:1rem">' + revokedCount + ' revoked · ' +
      '<button class="link" onclick="toggleRevoked()">' +
      (SHOW_REVOKED ? 'hide' : 'show') + '</button></p>'
    : ''

  if (!shown.length) {
    el.innerHTML = '<p class="empty">No active devices.</p>' + footer
    return
  }

  el.innerHTML = '<table>' + shown.map(d => {
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
    // A revoked row offers Delete (remove the tombstone) instead of Revoke.
    const action = d.revokedAt
      ? '<button class="danger" onclick="deleteDevice(\\'' + d.deviceKey + '\\')">Delete</button>'
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
  }).join('') + '</table>' + footer
}

async function refresh () {
  const s = await api('/api/state')
  PEOPLE = s.persons || []
  DEVICES = s.devices || []
  renderSource(s.source)

  // The host comes up even when its source is broken - it must, or a mistyped
  // password would lock the operator out of the dashboard they need in order to fix
  // it (DECISIONS 2026-07-14). But it was only saying so in the LOG. The one person
  // who can fix a broken source is the one looking at this page.
  const err = document.getElementById('sourceerr')
  if (s.sourceError) {
    err.style.display = 'block'
    err.textContent = 'The music source is not working: ' + s.sourceError
  } else {
    err.style.display = 'none'
  }

  document.getElementById('lib').textContent = s.libraryName
  const st = s.stats || {}
  document.getElementById('sub').textContent =
    (st.tracks || 0) + ' tracks · ' +
    (st.albums ? st.albums + ' albums · ' : '') +
    (st.artists ? st.artists + ' artists · ' : '') +
    (st.source || '?') + ' · ' +
    s.devices.filter(d => !d.revokedAt).length + ' device(s)'
  renderPeople(PEOPLE, s.devices)
  renderDevices(s.devices)
}

refresh()
timer = setInterval(refresh, 3000)
</script>
</body>
</html>`

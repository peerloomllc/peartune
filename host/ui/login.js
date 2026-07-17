// The login page. Shown instead of the dashboard when a password is set and the
// browser has no session yet.
//
// Same shape as page.js - one string, no build step - and the same trap: THIS FILE
// IS ONE TEMPLATE LITERAL. A backtick in a comment closes it and the page stops
// parsing. (test/identity.test.js parses both pages for exactly this reason.)

module.exports = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PearTune</title>
<style>
  :root {
    --bg:#17140f; --fg:#f3ede1; --muted:#948a76; --line:#39332a;
    --card:#201c15; --accent:#e6b24e; --danger:#e0705f;
  }
  * { box-sizing:border-box }
  body {
    margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:var(--bg); color:var(--fg);
    font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;
  }
  .box { width:100%; max-width:22rem; padding:2rem; text-align:center }
  h1 { font-size:1.6rem; margin:0 0 .25rem; font-weight:600 }
  h1 span { color:var(--accent) }
  p.sub { color:var(--muted); font-size:.9rem; margin:0 0 1.5rem }
  input {
    width:100%; padding:.75rem; font:inherit; border-radius:10px;
    border:1px solid var(--line); background:var(--card); color:var(--fg);
  }
  button {
    width:100%; margin-top:.6rem; padding:.75rem; font:inherit; font-weight:600;
    border:none; border-radius:10px; background:var(--accent); color:#1c1305; cursor:pointer;
  }
  button:disabled { opacity:.5; cursor:default }
  .err {
    margin-top:.8rem; padding:.6rem .8rem; border-radius:8px; font-size:.85rem;
    background:rgba(224,112,95,.14); border:1px solid rgba(224,112,95,.4);
  }
  .hint { margin-top:1.5rem; color:var(--muted); font-size:.78rem; line-height:1.5 }
</style>
</head>
<body>
  <div class="box">
    <h1>Pear<span>Tune</span></h1>
    <p class="sub">This page can revoke devices and pair new ones. It wants a password.</p>

    <form id="f">
      <input id="pw" type="password" placeholder="Password" autofocus autocomplete="current-password">
      <button id="go" type="submit">Unlock</button>
    </form>

    <div id="err"></div>

    <p class="hint">
      On Umbrel this is the app password shown next to PearTune in your app list.
    </p>
  </div>

<script>
  const f = document.getElementById('f')
  const pw = document.getElementById('pw')
  const go = document.getElementById('go')
  const err = document.getElementById('err')

  f.onsubmit = async (e) => {
    e.preventDefault()
    err.innerHTML = ''
    go.disabled = true
    go.textContent = 'Unlocking...'

    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: pw.value })
      })

      if (r.ok) {
        // The session cookie is set; the same URL now serves the dashboard.
        location.reload()
        return
      }

      const body = await r.json().catch(() => ({}))
      err.innerHTML = '<div class="err">' + (body.error === 'too many attempts, wait a minute'
        ? 'Too many attempts. Wait a minute.'
        : 'Wrong password.') + '</div>'
    } catch (e) {
      err.innerHTML = '<div class="err">Could not reach the server.</div>'
    }

    go.disabled = false
    go.textContent = 'Unlock'
    pw.select()
  }
</script>
</body>
</html>
`

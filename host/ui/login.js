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
<link rel="icon" type="image/png" href="data:image/png;base64,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">
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

// The dashboard's data layer: the same JSON endpoints the old string-page talked
// to, plus a clipboard helper that survives a non-secure origin.

export async function api (path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  // A logged-out session answers the API with 401 (host/ui/auth.js). Reload so the
  // server hands back the login page instead of leaving the dashboard spinning.
  if (res.status === 401) { location.reload(); return {} }
  return res.json().catch(() => ({}))
}

// The dashboard is served over plain http (Umbrel's app_proxy, a LAN address).
// navigator.clipboard only exists on a SECURE origin, so a copy button would
// silently do nothing there. Fall back to the old execCommand path - the same
// trick the PearCircle seeder uses for exactly this reason.
export async function copyText (text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {}
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus(); ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

export function ago (ts) {
  if (!ts) return 'never'
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return s + 's ago'
  if (s < 3600) return Math.floor(s / 60) + 'm ago'
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'
  return Math.floor(s / 86400) + 'd ago'
}

// Suite donation config, the same addresses the phone app's About tab uses
// (src/ui/App.jsx). Rendered entirely client-side: no tracking, no phone-home.
export const DONATE = {
  lightning: 'peerloomllc@strike.me',
  strikeUrl: 'https://strike.me/peerloomllc/',
  onchain: 'bc1q0kksenz3j4u9ppe6f4krclvzwxk7sjy00cc9cf',
  bmcUrl: 'https://buymeacoffee.com/peerloomllc'
}

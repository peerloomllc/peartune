// The dashboard's theme, matched to the phone app but simpler.
//
// The phone keeps its theme preference in the WORKLET (settings.json) so the shell
// can read it before the WebView paints (DECISIONS 2026-07-14). The dashboard has
// no worklet and no shell - it is a plain browser page - so it uses the suite's
// ORIGINAL mechanism: the preference in localStorage, resolved against the OS.
//
// Same tokens, same [data-theme] contract as src/ui/styles.css, so the two look
// like one product.

import { FONT_CSS } from '../../../src/ui/fonts.js'

const KEY = 'peartune_dash_theme'

export function injectFonts () {
  if (document.getElementById('peartune-fonts')) return
  const el = document.createElement('style')
  el.id = 'peartune-fonts'
  el.textContent = FONT_CSS
  document.head.appendChild(el)
}

function systemIsDark () {
  try {
    return typeof matchMedia !== 'undefined' &&
      matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return true
  }
}

export function resolveTheme (pref) {
  if (pref === 'system') return systemIsDark() ? 'dark' : 'light'
  return pref === 'light' ? 'light' : 'dark'
}

export function loadThemePref () {
  try {
    const p = localStorage.getItem(KEY)
    return p === 'light' || p === 'dark' || p === 'system' ? p : 'system'
  } catch {
    return 'system'
  }
}

export function applyThemePref (pref) {
  const resolved = resolveTheme(pref)
  document.documentElement.setAttribute('data-theme', resolved)
  try { localStorage.setItem(KEY, pref) } catch {}
  return resolved
}

// PearTune theme. Suite convention (PearPetal/PearList/PearCircle): CSS custom
// properties under [data-theme], so a theme change is one attribute on <html> and
// NOT a React re-render - every colour in styles.css is already a var().
//
// The preference is 'dark' | 'light' | 'system'. Where it LIVES is the one place
// PearTune deviates from its siblings: they keep it in the WebView's
// localStorage, we keep it in the worklet (settings.json), next to the device
// identity and the paired host. That is what lets the shell read it BEFORE it
// loads this document (the worklet is already up by then), resolve it, and hand
// us HTML that already carries the right data-theme - so a light-theme user never
// sees a frame of dark on a cold start. See DECISIONS.

import { FONT_CSS } from './fonts.js'
import { call } from './bridge'

export function injectGlobalStyles () {
  if (document.getElementById('peartune-fonts')) return
  const el = document.createElement('style')
  el.id = 'peartune-fonts'
  el.textContent = FONT_CSS
  document.head.appendChild(el)
}

// The shell injects the real OS colour scheme as window.__pearColorScheme. An
// Android WebView's own prefers-color-scheme does NOT reliably track the app's
// night mode, so RN's Appearance API is the authority; matchMedia is only the
// browser-preview fallback.
function systemIsDark () {
  try {
    const s = window.__pearColorScheme
    if (s === 'dark' || s === 'light') return s === 'dark'
    return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return true
  }
}

export function resolveTheme (pref) {
  if (pref === 'system') return systemIsDark() ? 'dark' : 'light'
  return pref === 'light' ? 'light' : 'dark'
}

// The shell hands us the stored preference on the boot script. Falling back to
// 'system' rather than 'dark' means a fresh install looks like the phone.
export function loadThemePref () {
  const p = typeof window !== 'undefined' ? window.__pearTheme : null
  return p === 'light' || p === 'dark' || p === 'system' ? p : 'system'
}

// Stamp the resolved theme on <html>, persist the preference in the worklet, and
// tell the shell what we painted so the status bar and the strip behind the
// WebView match it.
export function applyThemePref (pref, { persist = true } = {}) {
  const resolved = resolveTheme(pref)
  document.documentElement.setAttribute('data-theme', resolved)
  if (persist) call('setSettings', { theme: pref }).catch(() => {})
  call('theme', { scheme: resolved }).catch(() => {})
  return resolved
}

// OS light/dark changes, which only matter while the preference is 'system'. The
// shell dispatches `pearcolorscheme` after updating window.__pearColorScheme.
export function onSystemThemeChange (cb) {
  const h = () => cb(window.__pearColorScheme === 'light' ? 'light' : 'dark')
  window.addEventListener('pearcolorscheme', h)
  return () => window.removeEventListener('pearcolorscheme', h)
}

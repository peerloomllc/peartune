// Build the WebView UI into ONE self-contained assets/index.html, with both the
// JS and the CSS inlined.
//
// Inlining the CSS is not cosmetic housekeeping. esbuild emits an imported
// stylesheet as a SEPARATE file (assets/app-ui.css), and the shell loads the UI
// by reading index.html into a string and handing it to the WebView - so there is
// no origin for a <link href> to resolve against, and the stylesheet silently
// never loads. The app then renders correctly-structured, completely unreadable
// black-on-black text. (Ask me how I know.)

import { build } from 'esbuild'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

await build({
  entryPoints: ['src/ui/main.jsx'],
  bundle: true,
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: 'assets/app-ui.bundle',
  legalComments: 'none'
})

const js = readFileSync('assets/app-ui.bundle', 'utf8').replace(/<\/script>/g, '<\\/script>')

// esbuild names the stylesheet after the outfile.
const cssPath = 'assets/app-ui.css'
const css = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : ''
if (!css) console.warn('WARNING: no CSS emitted - is styles.css still imported from main.jsx?')

const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
  <meta name="theme-color" content="#14130f">
  <title>PearTune</title>
  <!-- The pre-paint background follows the theme, not a hardcoded dark: the shell
       stamps data-theme on <html> before this document's bundle runs (it read the
       preference out of the worklet), so a light-theme user never gets a frame of
       dark. The fallback is the dark surface, which is also the default theme. -->
  <style>html,body,#root{height:100%;margin:0;background:var(--color-surface-base,#14130f)}</style>
  <style>${css}</style>
</head>
<body>
  <div id="root"></div>
  <script>${js}</script>
</body>
</html>
`

writeFileSync('assets/index.html', html)
console.log(`built assets/index.html (self-contained: ${(js.length / 1024).toFixed(0)}kb js + ${(css.length / 1024).toFixed(1)}kb css)`)

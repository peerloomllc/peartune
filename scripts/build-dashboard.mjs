// Build the host operator dashboard into ONE self-contained host/ui/dashboard.html,
// JS and CSS inlined.
//
// This is a BUILD-TIME artifact, exactly like the phone's assets/index.html: React,
// esbuild, Phosphor and qrcode are ROOT devDependencies, and none of them enter the
// host image. The host just serves the committed HTML string (host/ui/server.js),
// so host/package.json stays the eleven server packages it is (DECISIONS 2026-07-14
// "the host image gets its own package.json"). Run this whenever the dashboard
// source under host/ui/app/ changes, and commit the result.

import { build } from 'esbuild'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

await build({
  entryPoints: ['host/ui/app/main.jsx'],
  bundle: true,
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: 'host/ui/app/.dashboard.bundle',
  legalComments: 'none',
  minify: true
})

const js = readFileSync('host/ui/app/.dashboard.bundle', 'utf8').replace(/<\/script>/g, '<\\/script>')

const cssPath = 'host/ui/app/.dashboard.css'
const css = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : ''
if (!css) console.warn('WARNING: no CSS emitted - is styles.css still imported from main.jsx?')

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PearTune host</title>
  <!-- Favicon: the pear mark, inlined so nothing is fetched (self-contained page). -->
  <link rel="icon" type="image/png" href="data:image/png;base64,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">
  <!-- Height/margin only. Do NOT hardcode a background here: #root has id
       specificity, so a color here would override the theme tokens and strand the
       page on one theme's background (that is exactly how light mode broke). The
       stylesheet's body{background:var(--bg)} owns the background, per theme. -->
  <style>html,body,#root{height:100%;margin:0}</style>
  <style>${css}</style>
</head>
<body>
  <div id="root"></div>
  <script>${js}</script>
</body>
</html>
`

writeFileSync('host/ui/dashboard.html', html)
console.log(`built host/ui/dashboard.html (self-contained: ${(js.length / 1024).toFixed(0)}kb js + ${(css.length / 1024).toFixed(1)}kb css)`)

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

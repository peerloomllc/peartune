// Capture PearTune dashboard screenshots for the operator guide (docs/getting-started.md).
//
// Why this exists rather than `firefox --headless --screenshot`: the dashboard is a Preact
// SPA that renders "Connecting to the host..." until /api/state comes back, and Firefox's
// --screenshot fires on the `load` event, so the plain flag captures the placeholder every
// time. This drives Firefox over WebDriver BiDi instead, so it can wait for real content and
// click into a tab before shooting.
//
// Usage (needs a reachable dashboard - an ssh tunnel is fine):
//   node scripts/dashboard-shots.mjs http://127.0.0.1:18741 docs/img
//
// Firefox is the only browser on the dev box; there is no Chrome, so no --virtual-time-budget.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const BASE = process.argv[2] || 'http://127.0.0.1:18741'
const OUTDIR = process.argv[3] || 'docs/img'
const PORT = 9333
const VIEWPORT = { width: 1280, height: 900 }

mkdirSync(OUTDIR, { recursive: true })

const profile = mkdtempSync(join(tmpdir(), 'peartune-shots-'))
const firefox = spawn('firefox', [
  '--headless', '--no-remote', '--profile', profile,
  '--remote-debugging-port', String(PORT), BASE,
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Firefox speaks WebDriver BiDi ONLY - it has no CDP endpoint, so there is no
// /json/version to discover a socket URL from (asking for one gets a 404 page, which
// looks exactly like "the agent never started"). Two further traps, both of which
// present as "the agent never came up" when it is in fact running fine:
//   * The URL Firefox PRINTS at startup ("listening on ws://127.0.0.1:PORT") is not an
//     upgrade endpoint - connecting there answers HTTP 200 and the handshake fails. The
//     session endpoint is /session.
//   * The agent needs a moment to bind, so the socket must be polled, not assumed.
const BIDI_URL = `ws://127.0.0.1:${PORT}/session`
async function waitForAgent () {
  for (let i = 0; i < 60; i++) {
    const ok = await new Promise((resolve) => {
      const probe = new WebSocket(BIDI_URL)
      const done = (v) => { try { probe.close() } catch {} ; resolve(v) }
      probe.once('open', () => done(true))
      probe.once('error', () => done(false))
    })
    if (ok) return BIDI_URL
    await sleep(500)
  }
  throw new Error('the Firefox remote agent never came up')
}

let ws, nextId = 1
const pending = new Map()

function send (method, params = {}) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function connect (url) {
  ws = new WebSocket(url)
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    const slot = pending.get(msg.id)
    if (!slot) return
    pending.delete(msg.id)
    if (msg.error || msg.type === 'error') slot.reject(new Error(JSON.stringify(msg.error ?? msg)))
    else slot.resolve(msg.result)
  })
}

// Evaluate in the page and return the deserialised primitive.
async function evaluate (ctx, expression) {
  const r = await send('script.evaluate', {
    expression, target: { context: ctx }, awaitPromise: true, resultOwnership: 'none',
  })
  if (r.type === 'exception') throw new Error(r.exceptionDetails?.text || 'page threw')
  return r.result?.value
}

// Poll the page until `expression` is truthy. A fixed sleep would either be flaky or slow.
async function waitFor (ctx, expression, what, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(ctx, expression)) return
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function shoot (ctx, name) {
  const r = await send('browsingContext.captureScreenshot', { context: ctx })
  const path = join(OUTDIR, `${name}.png`)
  writeFileSync(path, Buffer.from(r.data, 'base64'))
  console.log(`  wrote ${path}`)
}

try {
  await connect(await waitForAgent())
  await send('session.new', { capabilities: {} })

  const { contexts } = await send('browsingContext.getTree', {})
  const ctx = contexts[0].context
  await send('browsingContext.setViewport', { context: ctx, viewport: VIEWPORT })

  console.log(`navigating to ${BASE}`)
  await send('browsingContext.navigate', { context: ctx, url: BASE, wait: 'complete' })

  // The placeholder is literally the string below, so waiting for its absence is the
  // honest check that real host data arrived - not a guess at a settle time.
  await waitFor(ctx, '!document.body.innerText.includes("Connecting to the host")', 'host data')
  await sleep(600) // let art and avatars paint

  // Buttons and tabs are plain elements; find one by its visible label rather than a
  // brittle selector, so a restyle does not silently produce blank screenshots.
  const clickText = (label) => evaluate(ctx, `
    (() => {
      const want = ${JSON.stringify(label.toLowerCase())}
      const el = [...document.querySelectorAll('button,a,[role="tab"]')]
        .find(n => n.textContent.trim().toLowerCase().startsWith(want))
      if (!el) return false
      el.click()
      return true
    })()
  `)

  // A host with no source and no devices opens on the first-run wizard, not the
  // dashboard. That is the operator's genuine first screen, so shoot it, then skip
  // past it to reach everything else.
  const onWizard = await evaluate(ctx, 'document.body.innerText.includes("Skip setup")')
  if (onWizard) {
    await shoot(ctx, 'dashboard-first-run')
    if (await clickText('skip setup')) await sleep(900)
  }

  // Expand every person so their devices show. Collapsed rows hide the platform chip,
  // the "paired <ago>" line and the per-DEVICE revoke button - which is most of what the
  // People & Devices tab is for.
  await evaluate(ctx, `[...document.querySelectorAll('.prow:not(.flat)')].forEach(n => n.click())`)
  await sleep(700)
  await shoot(ctx, 'dashboard-people')

  if (await clickText('music source')) {
    await sleep(900)
    await shoot(ctx, 'dashboard-music-source')
    await clickText('people')
    await sleep(600)
  } else {
    console.log('  no "Music Source" tab found - skipped')
  }

  // Pairing is two steps: choose Full access vs Guest pass, THEN reveal the code. Both
  // are worth a shot, and the operator guide walks them in that order.
  if (await clickText('pair a device')) {
    await sleep(700)
    await shoot(ctx, 'dashboard-pair-modal')

    if (await clickText('show pairing code')) {
      try {
        // The QR is an <img class="qr"> carrying a data: URL (Pair.jsx), NOT an svg or a
        // canvas - and "any svg in the modal" matches the close button's X icon, which is
        // there immediately, so that probe passes before the QR exists and shoots the
        // previous step. Wait for the image to have actually decoded.
        await waitFor(ctx, `
          (() => {
            const img = document.querySelector('img.qr')
            return !!img && img.complete && img.naturalWidth > 0
          })()
        `, 'the pairing QR to render', 20000)
        await sleep(400)
        await shoot(ctx, 'dashboard-pair-qr')
      } catch (e) {
        console.log(`  pairing QR: ${e.message} - skipped`)
      }
    }
  } else {
    console.log('  no "Pair a device" button found - skipped')
  }
} finally {
  try { ws?.close() } catch {}
  firefox.kill()
}

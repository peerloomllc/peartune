// AN UNREADABLE FILE MUST NEVER READ AS A FRESH INSTALL.
//
// The worklet keeps two files that decide who this device is and what it is paired to:
// identity.json (the key pair that IS the grant every host holds) and hosts.json (the paired
// libraries). Both loaders used to be `try { read } catch { assume fresh install }`, which
// silently collapses two completely different situations into one:
//
//   absent      -> a fresh install. Mint a key, show onboarding. Correct.
//   unreadable  -> something is wrong. Minting a key here DESTROYS the device's identity, so
//                  every host it was paired with now sees a stranger; returning the empty host
//                  list shows the onboarding wall to someone who is fully paired.
//
// The second one is not a hypothetical: a paired TCL came up on the onboarding screen after a
// reboot on 2026-08-02 and never recovered, and PR #330 shipped a retry without ever
// establishing the cause. These tests pin the distinction so it cannot quietly come back.
//
// EISDIR IS THE FORCING TRICK. Putting a DIRECTORY where the file should be produces a real,
// non-ENOENT read error on every platform without needing root or chmod games (which do not
// fail for a root-run CI job at all).
//
// HOW IT LOADS. Same three stubs as bare-smoke.test.js - Bare/BareKit globals and bare-fs /
// bare-path / bare-http1 mapped to node equivalents - because src/bare.js only loads under
// Bare. Each test needs its OWN copy of the module with its own DATA_DIR, so the require cache
// is cleared between loads rather than sharing one instance.

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('module')
const os = require('os')
const path = require('path')
const fs = require('fs')

const fakeHttp = {
  createServer (handler) {
    return {
      handler,
      once () {},
      listen (_port, _host, cb) { if (cb) setImmediate(cb) },
      address () { return { port: 45998 } },
      close (cb) { if (cb) cb() }
    }
  }
}

// Load a FRESH copy of src/bare.js with the given argv, and hand back its IPC dispatcher plus
// everything it has written. Returns the load error instead of throwing, so a test can assert
// on a refusal that happens at module scope.
//
// THE GLOBALS AND THE LOADER HOOK STAY UP FOR THE WHOLE TEST, not just the require. The
// worklet's `send()` reads BareKit.IPC at CALL time, and worklet/shim.js requires bare-http1
// lazily inside createAudioShim - so tearing either down straight after the load breaks every
// method call that follows, with an error that points at the logger rather than at the cause.
// bare-smoke.test.js makes the same choice for the same reason.
function loadWorklet (t, argv) {
  const sent = []
  let onData = null

  const prevBare = global.Bare
  const prevKit = global.BareKit
  global.Bare = { argv }
  global.BareKit = {
    IPC: {
      on: (event, fn) => { if (event === 'data') onData = fn },
      write: (buf) => sent.push(String(buf))
    }
  }

  const realLoad = Module._load
  Module._load = function (request, ...rest) {
    if (request === 'bare-fs') return require('fs')
    if (request === 'bare-path') return require('path')
    if (request === 'bare-http1') return fakeHttp
    return realLoad.call(this, request, ...rest)
  }

  const entry = require.resolve('../src/bare.js')
  delete require.cache[entry]

  let error = null
  try {
    require('../src/bare.js')
  } catch (e) {
    error = e
  }

  t.after(() => {
    Module._load = realLoad
    delete require.cache[entry]
    global.Bare = prevBare
    global.BareKit = prevKit
  })

  return { error, sent, call: (method, args = {}) => dispatch(onData, sent, method, args) }
}

function dispatch (onData, sent, method, args) {
  const id = 'ws-' + Math.random().toString(36).slice(2)
  onData(Buffer.from(JSON.stringify({ id, method, args }) + '\n'))
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = () => {
      for (const line of sent.join('').split('\n')) {
        if (!line.trim()) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (msg.id !== id) continue
        return msg.error ? reject(new Error(msg.error)) : resolve(msg.result)
      }
      if (Date.now() - started > 8000) return reject(new Error(`no reply to ${method}`))
      setTimeout(poll, 20)
    }
    poll()
  })
}

function tmpdir (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-storage-'))
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
  return dir
}

test('a fresh data dir still mints an identity and shows no libraries', async (t) => {
  const dir = tmpdir(t)
  const w = loadWorklet(t, [dir, 'android'])
  assert.equal(w.error, null)

  const s = await w.call('init')
  assert.ok(s.deviceKey, 'minted a device key')
  assert.equal(s.host, null, 'no libraries on a fresh install')
  assert.ok(fs.existsSync(path.join(dir, 'identity.json')), 'wrote the identity out')
})

test('a TRUNCATED identity file does NOT mint a new device key over the top of it', async (t) => {
  const dir = tmpdir(t)
  const file = path.join(dir, 'identity.json')
  // TRUNCATED, not a directory. A directory would make the old code fail too - but on the
  // WRITE, not the read, so the test would pass while proving nothing. Here the old code
  // parses nothing, falls into its catch, mints a fresh key pair and writes it straight over
  // this file: the device silently becomes a stranger to every host that ever granted it.
  const before = '{"publicKey":"aabb","secretK'
  fs.writeFileSync(file, before)

  const w = loadWorklet(t, [dir, 'android'])
  assert.equal(w.error, null, 'the module still loads - the refusal belongs to init, not to require')

  await assert.rejects(() => w.call('init'), /unreadable|fresh install/i)
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'and it did not overwrite the identity')
})

test('an unreadable hosts file does NOT report a fresh install', async (t) => {
  const dir = tmpdir(t)
  fs.mkdirSync(path.join(dir, 'hosts.json'))

  const w = loadWorklet(t, [dir, 'android'])
  await assert.rejects(() => w.call('init'), /hosts\.json|EISDIR|directory/i)
})

test('a TRUNCATED hosts file is refused rather than read as no libraries', async (t) => {
  const dir = tmpdir(t)
  // Exactly what a kill mid-write used to leave behind, before writes became atomic.
  fs.writeFileSync(path.join(dir, 'hosts.json'), '{"version":2,"hosts":[{"hostKey":"abc')

  const w = loadWorklet(t, [dir, 'android'])
  await assert.rejects(() => w.call('init'), /unreadable|fresh install/i)
})

// HONEST ABOUT WHAT THIS ONE IS. It does NOT prove atomicity - proving that needs a kill in
// the middle of a write, which this harness cannot stage. It guards the litter the atomic
// write itself introduces: a temp file that fails to get renamed away would sit in the data
// dir forever, and on a phone that is a leak nobody would ever look for.
test('the atomic write leaves no temp file behind', async (t) => {
  const dir = tmpdir(t)
  const w = loadWorklet(t, [dir, 'android'])
  await w.call('init')

  // renameHost goes through saveHostsFile without needing a network or a host to exist.
  // An unknown key is fine: what is under test is the WRITE path, not the rename itself.
  try { await w.call('renameHost', { hostKey: 'nope', name: 'x' }) } catch {}
  await w.call('init')

  assert.ok(!fs.existsSync(path.join(dir, 'hosts.json.tmp')), 'no .tmp left in the data dir')
  assert.ok(!fs.existsSync(path.join(dir, 'identity.json.tmp')), 'nor for the identity')
})

test('a RELATIVE data dir is refused outright', (t) => {
  // The shell's `?? ''` used to turn a missing documentDirectory into exactly this: a truthy
  // relative path, so the worklet's own `|| '/tmp/peartune'` fallback never fired and it ran
  // on a phantom directory resolved against its cwd - no identity, no hosts, onboarding screen,
  // on a phone that was perfectly paired.
  const w = loadWorklet(t, ['peartune', 'android'])
  assert.ok(w.error, 'refused to load')
  assert.match(w.error.message, /absolute/i)
})

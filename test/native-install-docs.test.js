// The documented source install must set NODE_PATH everywhere it runs the host.
//
// host/ holds the packages, but protocol/ and client/ sit beside it and resolve from the
// repo root, where a source install puts nothing. Until 2026-09-17 no doc said so, and the
// install died at startup in protocol/ids.js. scripts/smoke-native-install.sh runs the
// Linux steps for real in a container; this pins the text of every place a reader copies
// a launch from, which the container cannot see.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

test('the systemd unit sets NODE_PATH to the host packages before ExecStart', () => {
  const unit = read('host/deploy/peartune-host.service')
  const env = unit.indexOf('Environment=NODE_PATH=/opt/peartune/host/node_modules')
  assert.ok(env > 0)
  assert.ok(env < unit.indexOf('ExecStart='))
})

test('the LaunchAgent sample sets NODE_PATH', () => {
  assert.match(read('host/deploy/com.peerloom.peartune.plist'), /<key>NODE_PATH<\/key>\s*<string>\/opt\/peartune\/host\/node_modules<\/string>/)
})

test('every hand-run launch in the macOS and Windows guide sets NODE_PATH first', () => {
  const doc = read('docs/host-macos-windows.md')
  assert.match(doc, /NODE_PATH=\/opt\/peartune\/host\/node_modules \\\nnode \/opt\/peartune\/host\/index\.js/)
  assert.match(doc, /\$env:NODE_PATH="C:\\peartune\\host\\node_modules"\nnode C:\\peartune\\host\\index\.js/)
  assert.match(doc, /nssm set PearTune AppEnvironmentExtra [^\n]*NODE_PATH=C:\\peartune\\host\\node_modules/)
})

test('the Linux guide explains NODE_PATH next to the install', () => {
  assert.match(read('docs/host-linux.md'), /NODE_PATH=\/opt\/peartune\/host\/node_modules/)
})

test('the host names the fix instead of crashing when NODE_PATH is missing', () => {
  const index = read('host/index.js')
  const check = index.indexOf("require.resolve('hypercore-crypto'")
  assert.ok(check > 0)
  assert.ok(check < index.indexOf("require('./server')"), 'the check runs before anything loads protocol/')
  assert.match(index, /set NODE_PATH=/)
})

// Does the worklet actually reference things that exist?
//
// WHY THIS EXISTS (2026-07-26): a rename during the one-connection refactor left ONE call site
// pointing at a function that no longer existed. 546 tests stayed green, the APK built, and the
// bug surfaced only on the phone, as `init:merged-rebuild-failed {"err":"ensureHost is not
// defined"}` in logcat - a round trip of build, install, launch, read logs.
//
// The suite could not catch it because src/bare.js is the ONE file no test loads: it only runs
// under Bare (bare-fs, bare-path, the Bare and BareKit globals), so requiring it from node throws
// before the first assertion. Note also that LOADING it would not have been enough - the dead
// reference was inside a function body, so nothing short of calling that path (or reading the
// code) would trip it.
//
// So this reads the code. Every identifier the worklet references must be declared SOMEWHERE in
// its own file or be a known global. Deliberately scope-BLIND: a name declared anywhere counts,
// which cannot produce a false positive from shadowing and still catches the whole class of
// "renamed it, missed a caller".
//
// KNOWN LIMIT, found the same night by tripping over it: because it is scope-blind, deleting a
// module-level `let connected` stayed green - an unrelated function had a local `const connected`,
// so the name was still "declared somewhere" while five module-level readers had become
// ReferenceErrors. Reading the diff caught that, this test did not. Closing it needs real scope
// analysis; until then treat a green run as "no dangling names", not "correctly scoped".

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const acorn = require('acorn')

const FILES = [
  'src/bare.js',
  'client/index.js',
  'worklet/shim.js',
  'worklet/merge.js',
  'worklet/link-health.js',
  'worklet/rebuild-gate.js',
  'worklet/hosts.js',
  'worklet/catalog.js',
  'worklet/cache.js',
  'worklet/outbox.js',
  'worklet/leaves.js',
  'worklet/quality.js',
  'worklet/art-cache.js',
  'worklet/retry.js'
]

// Everything the worklet is allowed to reach for without declaring. Bare and BareKit are the
// runtime's own; the rest is the JS standard library plus the timer/console surface Bare provides.
const GLOBALS = new Set([
  'Bare', 'BareKit', 'require', 'module', 'exports', 'process', 'global', 'globalThis', 'console',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'queueMicrotask',
  'Promise', 'Error', 'TypeError', 'RangeError', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'Math', 'JSON', 'Date', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'RegExp', 'Buffer',
  'Uint8Array', 'ArrayBuffer', 'DataView', 'Int32Array', 'Float64Array', 'BigInt', 'Proxy',
  'Reflect', 'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'undefined', 'NaN', 'Infinity', 'URL',
  'TextEncoder', 'TextDecoder', 'AbortController', 'structuredClone', 'fetch'
])

function walk (node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return
  visit(node, parent)
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue
    const child = node[key]
    if (Array.isArray(child)) {
      for (const c of child) if (c && typeof c.type === 'string') walk(c, visit, node)
    } else if (child && typeof child.type === 'string') {
      walk(child, visit, node)
    }
  }
}

// Every name a binding pattern introduces: plain, destructured, defaulted, rest.
function patternNames (node, out) {
  if (!node) return out
  switch (node.type) {
    case 'Identifier': out.add(node.name); break
    case 'ObjectPattern': for (const p of node.properties) patternNames(p.type === 'RestElement' ? p.argument : p.value, out); break
    case 'ArrayPattern': for (const el of node.elements) patternNames(el, out); break
    case 'AssignmentPattern': patternNames(node.left, out); break
    case 'RestElement': patternNames(node.argument, out); break
    case 'Property': patternNames(node.value, out); break
  }
  return out
}

function analyse (file) {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  const ast = acorn.parse(src, { ecmaVersion: 2023, sourceType: 'script', locations: true })

  const declared = new Set()
  const referenced = []

  walk(ast, (node, parent) => {
    switch (node.type) {
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        if (node.id) declared.add(node.id.name)
        for (const p of node.params) patternNames(p, declared)
        break
      case 'ClassDeclaration':
      case 'ClassExpression':
        if (node.id) declared.add(node.id.name)
        break
      case 'VariableDeclarator':
        patternNames(node.id, declared)
        break
      case 'CatchClause':
        if (node.param) patternNames(node.param, declared)
        break
      case 'Identifier': {
        if (!parent) break
        // A property name, not a reference: obj.foo, { foo: 1 }, class { foo () {} }
        if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) break
        if (parent.type === 'Property' && parent.key === node && !parent.computed) break
        if (parent.type === 'MethodDefinition' && parent.key === node && !parent.computed) break
        if (parent.type === 'PropertyDefinition' && parent.key === node && !parent.computed) break
        // Declarations and binding positions are handled above.
        if (parent.type === 'VariableDeclarator' && parent.id === node) break
        if ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' ||
             parent.type === 'ArrowFunctionExpression' || parent.type === 'ClassDeclaration' ||
             parent.type === 'ClassExpression') && parent.id === node) break
        if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') break
        // Binding patterns (params, destructuring, catch) - already collected as declarations.
        if (['ObjectPattern', 'ArrayPattern', 'AssignmentPattern', 'RestElement'].includes(parent.type)) break
        referenced.push({ name: node.name, line: node.loc.start.line })
        break
      }
    }
  })

  return { declared, referenced }
}

// Also treat names declared in the OTHER worklet files as known, since bare.js pulls them in by
// require destructuring (already counted as declarations) - this is belt and braces for helpers
// that move between modules mid-refactor.
test('every identifier the worklet references is declared somewhere', () => {
  const problems = []
  for (const file of FILES) {
    const { declared, referenced } = analyse(file)
    for (const ref of referenced) {
      if (declared.has(ref.name) || GLOBALS.has(ref.name)) continue
      problems.push(`${file}:${ref.line} -> ${ref.name}`)
    }
  }
  assert.deepEqual(problems, [], 'undeclared references (a rename that missed a call site?):\n  ' + problems.join('\n  '))
})

test('the check is not vacuous - it catches a call to a function that does not exist', () => {
  // The exact shape of the bug that shipped: a call site left behind by a rename. Proved here
  // against a synthetic file so the guard cannot rot into an assertion that always passes.
  const tmp = path.join(__dirname, '..', 'worklet', '.refcheck-fixture.js')
  fs.writeFileSync(tmp, 'function ensureLink (h) { return h }\nmodule.exports = () => ensureHost(1)\n')
  try {
    const { declared, referenced } = analyse('worklet/.refcheck-fixture.js')
    const missed = referenced.filter((r) => !declared.has(r.name) && !GLOBALS.has(r.name)).map((r) => r.name)
    assert.deepEqual(missed, ['ensureHost'])
  } finally {
    fs.unlinkSync(tmp)
  }
})

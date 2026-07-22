// Patched Expo modules must be built FROM SOURCE, or the patch is inert.
//
// This is the guard for a bug that cost a working app: Expo SDK 54 ships PREBUILT
// Android AARs for its own modules and links those by default (autolinking prints
// them with a 📦). patch-package rewrites the Kotlin in node_modules, which that
// build never compiles - so `patches/expo-audio+1.1.1.patch` applied cleanly, the
// build was green, and the app called native methods that did not exist:
// "undefined is not a function", every time you pressed Play.
//
// The opt-out is `expo.autolinking.android.buildFromSource` in package.json. Nothing
// else fails when it is missing, which is exactly why it needs a test: the failure is
// silent at build time and only shows up on a device.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

// `<name>+<version>.patch`, where the name may itself contain '+'-free scopes.
function patchedPackages () {
  const dir = path.join(ROOT, 'patches')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.patch'))
    .map(f => ({ file: f, name: f.slice(0, f.lastIndexOf('+')), body: fs.readFileSync(path.join(dir, f), 'utf8') }))
}

test('every PATCHED expo-* module is opted out of prebuilt binaries (or the patch is inert)', () => {
  const fromSource = pkg.expo?.autolinking?.android?.buildFromSource ?? []
  const needed = patchedPackages().filter(p => p.name.startsWith('expo-') && /\/android\//.test(p.body))

  for (const p of needed) {
    assert.ok(
      fromSource.includes(p.name),
      `${p.file} patches ${p.name}'s ANDROID source, so "${p.name}" must be listed in ` +
      'package.json expo.autolinking.android.buildFromSource - otherwise the build links ' +
      'the prebuilt AAR and the patch does nothing on device.'
    )
  }
})

test('the buildFromSource list only names packages we actually patch', () => {
  const fromSource = pkg.expo?.autolinking?.android?.buildFromSource ?? []
  const patched = new Set(patchedPackages().map(p => p.name))

  for (const name of fromSource) {
    assert.ok(
      patched.has(name),
      `package.json opts ${name} out of prebuilt Expo modules, but nothing in patches/ patches it. ` +
      'Building from source is slower, so drop it if the patch is gone.'
    )
  }
})

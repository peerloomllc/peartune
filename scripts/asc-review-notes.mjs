// Push metadata/ios/review-notes.md to the App Review Information "Notes" box of the
// editable App Store version. The file is the source of truth; App Store Connect is a
// copy of it. Dry run by default, --apply to write.
//
//   node scripts/asc-review-notes.mjs           # show target version + what would change
//   node scripts/asc-review-notes.mjs --apply   # PATCH, then read back and verify
//
// Refuses when every version is live (READY_FOR_SALE etc): Apple only lets review
// details change on a version still being prepared or in review. Run it from
// release.sh's App Store publish step, after the version record exists.
//
// Auth comes from ASC_KEY_ID / ASC_ISSUER_ID / ASC_APP_ID / ASC_PRIVATE_KEY_PATH in the
// environment, falling back to scripts/.env, same values release.sh uses.

import { createSign } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

function env (name) {
  if (process.env[name]) return process.env[name]
  const envFile = path.join(root, 'scripts', '.env')
  if (existsSync(envFile)) {
    const m = readFileSync(envFile, 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'))
    if (m) return m[1].trim().replace(/^\$HOME/, process.env.HOME)
  }
  throw new Error(`${name} not set and not in scripts/.env`)
}

const KEY_ID = env('ASC_KEY_ID')
const ISSUER = env('ASC_ISSUER_ID')
const APP_ID = env('ASC_APP_ID')
const p8 = readFileSync(env('ASC_PRIVATE_KEY_PATH'), 'utf8')

function jwt () {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const head = b64({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' })
  const body = b64({ iss: ISSUER, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' })
  const sign = createSign('SHA256')
  sign.update(`${head}.${body}`)
  const sig = sign.sign({ key: p8, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  return `${head}.${body}.${sig}`
}

async function req (method, url, body) {
  const res = await fetch(`https://api.appstoreconnect.apple.com/v1${url}`, {
    method,
    headers: { authorization: `Bearer ${jwt()}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 400)}`)
  return text ? JSON.parse(text) : null
}

// The note is everything after the first line that is exactly "---"; the comment
// block above the marker is for the repo, not for Apple.
const raw = readFileSync(path.join(root, 'metadata', 'ios', 'review-notes.md'), 'utf8')
const marker = raw.indexOf('\n---\n')
if (marker === -1) throw new Error('no --- marker line in metadata/ios/review-notes.md')
const notes = raw.slice(marker + 5).trim()
if (notes.length > 4000) throw new Error(`note is ${notes.length} chars, Apple's limit is 4000`)

const LIVE_STATES = ['READY_FOR_SALE', 'REPLACED_WITH_NEW_VERSION', 'REMOVED_FROM_SALE', 'DEVELOPER_REMOVED_FROM_SALE']
const versions = await req('GET', `/apps/${APP_ID}/appStoreVersions?filter[platform]=IOS&limit=5&fields[appStoreVersions]=versionString,appStoreState`)
const editable = versions.data.find(v => !LIVE_STATES.includes(v.attributes.appStoreState))
if (!editable) {
  console.error('No editable App Store version - every version is already live.')
  console.error('Create the next version record first (release.sh does this), then rerun.')
  process.exit(1)
}
const { versionString, appStoreState } = editable.attributes
console.log(`target: version ${versionString} (${appStoreState})`)

const detail = await req('GET', `/appStoreVersions/${editable.id}/appStoreReviewDetail`)
const current = detail.data.attributes.notes || ''
if (current === notes) {
  console.log('server already holds this note, nothing to do')
  process.exit(0)
}
console.log(`server holds ${current.length} chars, file holds ${notes.length}`)

if (!process.argv.includes('--apply')) {
  console.log('dry run - rerun with --apply to push the file')
  process.exit(0)
}

await req('PATCH', `/appStoreReviewDetails/${detail.data.id}`, {
  data: { type: 'appStoreReviewDetails', id: detail.data.id, attributes: { notes } }
})
const back = await req('GET', `/appStoreVersions/${editable.id}/appStoreReviewDetail`)
if (back.data.attributes.notes !== notes) throw new Error('readback does not match the file')
console.log(`pushed and verified: ${notes.length} chars on version ${versionString}`)

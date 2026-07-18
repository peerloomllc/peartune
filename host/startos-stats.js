// StartOS (0.3.x compat) reads a service's Properties from <volume>/start9/stats.yaml
// (version 2 format). We surface just the dashboard password there, masked + copyable,
// so a Start9 operator isn't digging through the service logs for it.
//
// Written at startup (host/index.js) AND on an in-dashboard password change
// (host/ui/server.js), so Properties mirrors the live password instead of going
// stale after a change. Best-effort: a failure here must never stop the host.

const fs = require('fs')
const path = require('path')

// source: 'generated' | 'file' (both = a password WE own, changeable in the dashboard)
// vs anything else (platform-set). Only the note text differs.
function writeStartosStats (file, password, source) {
  if (!file || !password) return
  try {
    const owned = source === 'generated' || source === 'file'
    const note = owned
      ? 'Generated on first run. Change it in the PearTune dashboard (Maintenance).'
      : 'Log in to the PearTune dashboard with this.'
    const yaml = [
      'version: 2',
      'data:',
      '  Dashboard Password:',
      '    type: string',
      '    value: ' + JSON.stringify(String(password)),
      '    description: ' + JSON.stringify(note),
      '    copyable: true',
      '    qr: false',
      '    masked: true',
      ''
    ].join('\n')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, yaml, { mode: 0o600 })
  } catch (e) {
    console.error('warning: could not write StartOS stats:', e.message)
  }
}

module.exports = { writeStartosStats }

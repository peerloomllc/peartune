// WebView -> shell IPC. Same shape as every app in the suite: post { id, method,
// args }, get a __pearResponse back, listen for __pearEvent pushes.

const pending = new Map()
let nextId = 1
const listeners = new Map()

window.__pearResponse = (id, payload) => {
  const p = pending.get(id)
  if (!p) return
  pending.delete(id)
  if (payload.error) p.reject(new Error(payload.error))
  else p.resolve(payload.result)
}

window.__pearEvent = (name, data) => {
  for (const fn of listeners.get(name) || []) fn(data)
}

export function call (method, args = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    window.ReactNativeWebView.postMessage(JSON.stringify({ id, method, args }))
  })
}

// A tap you can feel. Fire-and-forget by design: a dropped buzz is not worth a
// rejected promise anywhere up the call stack.
export function haptic (kind = 'light') {
  call('shell:haptic', { kind }).catch(() => {})
}

export function on (name, fn) {
  if (!listeners.has(name)) listeners.set(name, [])
  listeners.get(name).push(fn)
  return () => {
    const arr = listeners.get(name) || []
    const i = arr.indexOf(fn)
    if (i >= 0) arr.splice(i, 1)
  }
}

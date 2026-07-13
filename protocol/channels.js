// Channel construction, shared by host and client.
//
// WHY THIS FILE EXISTS. Protomux assigns each message a type id by REGISTRATION
// ORDER: the first addMessage() on a channel is type 0, the next is type 1, and
// so on. Both ends must therefore register the same encodings in the same order,
// or every message is decoded as the wrong type. It fails silently - the frames
// arrive, decode into garbage, and the handler you expected simply never fires.
//
// That bug cost real time during milestone 1: the host registered `paired` then
// `deviceHello` while the client did the reverse, so the hello was decoded as a
// `paired` and pairing just hung with no error on either side.
//
// So the order lives HERE, once, and both sides call these factories. Never call
// mux.createChannel + addMessage for a PearTune channel by hand; if you add a
// message type, add it to the END of the list (appending preserves every
// existing type id; inserting in the middle silently renumbers the wire).

const framing = require('./framing')
const { PAIR_PROTOCOL, MEDIA_PROTOCOL } = require('./constants')

// Message order for peartune/pair/1: hello(0), paired(1).
function pairChannel (mux, { id, onhello = null, onpaired = null, onopen = null, onclose = null } = {}) {
  const channel = mux.createChannel({
    protocol: PAIR_PROTOCOL,
    id,
    onopen: onopen || undefined,
    onclose: onclose || undefined
  })
  if (!channel) return null

  const messages = {
    hello: channel.addMessage({ encoding: framing.deviceHello, onmessage: onhello || undefined }),
    paired: channel.addMessage({ encoding: framing.paired, onmessage: onpaired || undefined })
  }

  return { channel, messages }
}

// Message order for peartune/media/1: req(0), res(1), chunk(2), end(3), err(4).
function mediaChannel (mux, {
  id,
  onreq = null,
  onres = null,
  onchunk = null,
  onend = null,
  onerr = null,
  onopen = null,
  onclose = null
} = {}) {
  const channel = mux.createChannel({
    protocol: MEDIA_PROTOCOL,
    id,
    onopen: onopen || undefined,
    onclose: onclose || undefined
  })
  if (!channel) return null

  const messages = {
    req: channel.addMessage({ encoding: framing.req, onmessage: onreq || undefined }),
    res: channel.addMessage({ encoding: framing.res, onmessage: onres || undefined }),
    chunk: channel.addMessage({ encoding: framing.chunk, onmessage: onchunk || undefined }),
    end: channel.addMessage({ encoding: framing.end, onmessage: onend || undefined }),
    err: channel.addMessage({ encoding: framing.err, onmessage: onerr || undefined })
  }

  return { channel, messages }
}

module.exports = { pairChannel, mediaChannel }

// Protomux message encodings for peartune/media/1.
//
// Five message types. JSON rides inside a compact-encoding string rather than
// getting its own encoder: the control messages are small and infrequent, and
// the ONE thing that has to be fast (audio) is a raw buffer in `chunk`, which
// never passes through JSON.
//
// Ordering guarantee we rely on: Protomux delivers messages on a channel in
// send order, so `chunk` seq 0..n followed by `end` cannot arrive scrambled.
// `seq` is carried anyway as a cheap assertion against our own bugs.

const c = require('compact-encoding')

const json = {
  preencode (state, v) {
    c.string.preencode(state, JSON.stringify(v === undefined ? null : v))
  },
  encode (state, v) {
    c.string.encode(state, JSON.stringify(v === undefined ? null : v))
  },
  decode (state) {
    const s = c.string.decode(state)
    try {
      return JSON.parse(s)
    } catch {
      return null
    }
  }
}

// Client -> host. `id` correlates the reply; the client owns the id space.
const req = {
  preencode (state, m) {
    c.uint.preencode(state, m.id)
    c.string.preencode(state, m.method)
    json.preencode(state, m.params ?? null)
  },
  encode (state, m) {
    c.uint.encode(state, m.id)
    c.string.encode(state, m.method)
    json.encode(state, m.params ?? null)
  },
  decode (state) {
    return {
      id: c.uint.decode(state),
      method: c.string.decode(state),
      params: json.decode(state)
    }
  }
}

// Host -> client, for JSON replies. Byte streams use chunk/end instead.
const res = {
  preencode (state, m) {
    c.uint.preencode(state, m.id)
    json.preencode(state, m.body ?? null)
  },
  encode (state, m) {
    c.uint.encode(state, m.id)
    json.encode(state, m.body ?? null)
  },
  decode (state) {
    return {
      id: c.uint.decode(state),
      body: json.decode(state)
    }
  }
}

// Host -> client. One frame of a byte stream (audio or artwork).
const chunk = {
  preencode (state, m) {
    c.uint.preencode(state, m.id)
    c.uint.preencode(state, m.seq)
    c.buffer.preencode(state, m.data)
  },
  encode (state, m) {
    c.uint.encode(state, m.id)
    c.uint.encode(state, m.seq)
    c.buffer.encode(state, m.data)
  },
  decode (state) {
    return {
      id: c.uint.decode(state),
      seq: c.uint.decode(state),
      data: c.buffer.decode(state)
    }
  }
}

// Host -> client. Terminates a byte stream. `total` lets the receiver assert it
// got everything, which is what makes a resumed pinned download safe to trust.
const end = {
  preencode (state, m) {
    c.uint.preencode(state, m.id)
    c.uint.preencode(state, m.total)
  },
  encode (state, m) {
    c.uint.encode(state, m.id)
    c.uint.encode(state, m.total)
  },
  decode (state) {
    return {
      id: c.uint.decode(state),
      total: c.uint.decode(state)
    }
  }
}

// Host -> client. A typed failure. Never drops the channel: an old host that
// does not know a new client's method answers ENOMETHOD and both sides live.
const err = {
  preencode (state, m) {
    c.uint.preencode(state, m.id)
    c.string.preencode(state, m.code)
    c.string.preencode(state, m.message || '')
  },
  encode (state, m) {
    c.uint.encode(state, m.id)
    c.string.encode(state, m.code)
    c.string.encode(state, m.message || '')
  },
  decode (state) {
    return {
      id: c.uint.decode(state),
      code: c.string.decode(state),
      message: c.string.decode(state)
    }
  }
}

// Host -> client. An UNSOLICITED, typed event - the one server->client push path.
// Carries no request id (it answers no request); `kind` names the event and `data` is
// its JSON payload. Kinds: 'session-superseded' (another of your devices claimed the play-
// session token, so stop) and 'library-renamed' (the operator renamed this library; data
// carries { libraryId, libraryName } so a device relabels the right host at once). It rides the same Noise-authenticated,
// firewall-gated media channel as everything else and dies with the connection, so a
// revoked device - whose connection the host destroys - can never receive one. Appended
// LAST (type 5) so every existing type id is preserved: an old client that never
// registered it simply drops the frame and falls back to lazy presence.
const push = {
  preencode (state, m) {
    c.string.preencode(state, m.kind || '')
    json.preencode(state, m.data ?? null)
  },
  encode (state, m) {
    c.string.encode(state, m.kind || '')
    json.encode(state, m.data ?? null)
  },
  decode (state) {
    return {
      kind: c.string.decode(state),
      data: json.decode(state)
    }
  }
}

// Client -> host, on peartune/pair/1. The phone announces itself.
//
// `rv` is the one-time pairing token from the QR. It proves the phone actually
// saw the code the operator is holding: the host's public key is an address, not
// a secret, so dialing the host is not by itself evidence of anything.
//
// `deviceKey` is redundant with the connection's Noise-proven remotePublicKey,
// and that is the point: the host MUST reject the hello if they disagree. It is
// a stated claim checked against a proven fact.
const deviceHello = {
  preencode (state, m) {
    c.fixed32.preencode(state, m.rv)
    c.fixed32.preencode(state, m.deviceKey)
    c.string.preencode(state, m.label || '')
    c.string.preencode(state, m.platform || '')
  },
  encode (state, m) {
    c.fixed32.encode(state, m.rv)
    c.fixed32.encode(state, m.deviceKey)
    c.string.encode(state, m.label || '')
    c.string.encode(state, m.platform || '')
  },
  decode (state) {
    return {
      rv: c.fixed32.decode(state),
      deviceKey: c.fixed32.decode(state),
      label: c.string.decode(state),
      platform: c.string.decode(state)
    }
  }
}

// Host -> client, on peartune/pair/1. Handed over only AFTER the connection is
// authenticated, which is why the QR itself can stay secret-free.
const paired = {
  preencode (state, m) {
    json.preencode(state, m)
  },
  encode (state, m) {
    json.encode(state, m)
  },
  decode (state) {
    return json.decode(state)
  }
}

module.exports = { json, req, res, chunk, end, err, push, deviceHello, paired }

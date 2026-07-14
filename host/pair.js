// Host side of peartune/pair/1.
//
// DESIGN NOTE (changed 2026-07-13, during milestone 1 - see DECISIONS).
//
// The first cut copied PearCircle's seeder pairing literally: a Hyperswarm
// rendezvous topic that both the phone and the host joined. That was wrong here,
// and it did not survive contact with the code. Hyperswarm creates its OWN
// HyperDHT server and listens on its keypair, so a host running both a Hyperswarm
// (for pairing) and its own dht.createServer (for media) under one identity had
// two servers fighting over the same keypair. It deadlocked.
//
// The seeder needed a rendezvous because the PHONE held the secrets and the
// seeder was anonymous. Here it is the other way round: the host has a stable
// public key, and that key is already printed in the QR. So the phone just DIALS
// THE HOST BY KEY.
//
// That is strictly stronger than the topic handshake it replaces. Dialing a
// HyperDHT key means Noise authenticates the far end AS that key, so an impostor
// who photographed the QR cannot answer the call at all. "Check the host is who
// the QR claims" stops being a check we must remember to write, and becomes a
// property of the transport.
//
// What `rv` is now: a one-time pairing token, 32 random bytes, presented by the
// phone in its hello to prove it actually saw the QR. The host's public key is an
// ADDRESS, not a secret, so dialing it proves nothing on its own.

const b4a = require('b4a')
const z32 = require('z32')
const sodium = require('sodium-universal')
const Protomux = require('protomux')

const { pairChannel } = require('../protocol/channels')
const { PAIR_TTL_MS } = require('../protocol/constants')
const { randomRv } = require('../protocol/ids')
const { encodeLink } = require('../protocol/link')

// Constant-time. A token compare that short-circuits on the first wrong byte
// leaks the token a byte at a time to anyone willing to make enough attempts
// inside the window. The window is short and the attack is impractical over a
// network, but there is no reason to hand it out for free.
function tokenEquals (a, b) {
  if (!a || !b || a.byteLength !== 32 || b.byteLength !== 32) return false
  return sodium.sodium_memcmp(a, b)
}

class PairSession {
  constructor ({ identity, grants, libraryName, ttl = PAIR_TTL_MS, log = () => {}, onpaired = null }) {
    this.identity = identity
    this.grants = grants
    this.libraryName = libraryName
    this.ttl = ttl
    this.log = log
    this.onpaired = onpaired

    this.rv = randomRv()
    this.closed = false

    // The window IS the security boundary for a first pair: there is nothing yet
    // to check a newcomer against, so trust reduces to "the operator opened a
    // session just now, and this device holds the token from that session".
    this.timer = setTimeout(() => {
      this.log('pair:expired')
      this.close('expired')
    }, this.ttl)
    if (this.timer.unref) this.timer.unref()
  }

  get link () {
    return encodeLink({
      rv: this.rv,
      hostKey: this.identity.publicKey,
      name: this.libraryName
    })
  }

  // Serve the pair protocol to a connection the firewall admitted ONLY because a
  // pairing window is open. Such a connection never gets a media channel.
  serve (conn) {
    const remoteKey = conn.remotePublicKey
    const mux = Protomux.from(conn)

    const built = pairChannel(mux, {
      id: b4a.from(this.identity.libraryId),
      onhello: (hello) => this._onhello(hello, conn, remoteKey, built)
    })
    if (!built) return

    built.channel.open()
  }

  async _onhello (hello, conn, remoteKey, built) {
    try {
      if (this.closed) {
        conn.destroy()
        return
      }

      // Proof the device actually saw the QR the operator is holding.
      if (!tokenEquals(hello.rv, this.rv)) {
        this.log('pair:rejected', { reason: 'bad-token' })
        conn.destroy()
        return
      }

      // The claim must match the proof. Noise has already established who the
      // remote really IS; the hello merely says who it CLAIMS to be. If they
      // disagree, a device is trying to pair as somebody else - which would let
      // it inherit a victim's grant, or mint one for a key whose owner never
      // consented.
      if (!b4a.equals(hello.deviceKey, remoteKey)) {
        this.log('pair:rejected', { reason: 'deviceKey-mismatch' })
        conn.destroy()
        return
      }

      const existing = await this.grants.get(remoteKey)
      if (existing && !existing.revokedAt) {
        // Idempotent: re-scanning the QR on an already-paired phone is a no-op,
        // not a duplicate row. The GRANT is untouched - that is the point.
        //
        // The NAME, however, is honoured. A device that unpairs, gives itself a new
        // name and pairs again would otherwise keep the old label forever, silently
        // - and it can rename itself over the media channel anyway (identity.set),
        // so refusing the name here would protect nothing and only surprise people.
        // personId and any claim are deliberately left alone: naming yourself is not
        // the same as saying who you belong to.
        if (hello.label) await this.grants.setIdentity(remoteKey, { deviceName: hello.label })

        this.log('pair:already-granted', {
          device: z32.encode(remoteKey).slice(0, 8),
          label: hello.label || existing.label
        })
      } else {
        await this.grants.grant({
          deviceKey: remoteKey,
          label: hello.label || 'device',
          platform: hello.platform || '',
          grantedBy: 'qr-pair'
        })
        this.log('pair:granted', { device: z32.encode(remoteKey).slice(0, 8), label: hello.label })
      }

      // Only now, over an authenticated connection, does the phone learn how to
      // reach the library. This is why the QR itself can stay secret-free.
      built.messages.paired.send({
        hostKey: z32.encode(this.identity.publicKey),
        libraryId: this.identity.libraryId,
        libraryName: this.libraryName
      })

      if (this.onpaired) this.onpaired({ deviceKey: remoteKey, label: hello.label })

      // One-shot. The window exists to admit one device; leaving it open after a
      // success is free risk.
      this.close('paired')
    } catch (e) {
      this.log('pair:failed', { err: e?.message })
      conn.destroy()
    }
  }

  close (reason = 'closed') {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.log('pair:closed', { reason })
  }
}

module.exports = { PairSession, tokenEquals }

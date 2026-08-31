# Security

PearTune plays music from a computer you own, to devices you have let in. That means
a program on your machine accepts connections from the internet, reads your files and
runs ffmpeg on them. This page says what protects what, so you do not have to read the
code to find out.

## Reporting a problem

Email **peerloomllc@proton.me**. If it is a real vulnerability, please give us a chance
to ship a fix before you publish it. There is no bounty. There is a thank you in the
release notes if you want one.

MIT licensed and developed in the open, so anything claimed here can be checked:
<https://github.com/peerloomllc/peartune>

## What an attacker would be trying to reach

The **host** is the interesting target. It runs on the machine holding your music, it
is reachable over the internet by design, and it can read your library. The phone app
matters less: it holds no library and no keys worth stealing beyond its own.

## The boundaries that hold this up

### A stranger cannot make the host do anything

The host is found by key, not by an address, and every connection is encrypted and
authenticated by the Noise handshake before a single byte of ours is read. An unknown
key is refused at the firewall (`host/gate.js`), and refused *again* when it tries to
open the media channel, because the first refusal has a deliberate exemption while a
pairing window is open and the second does not. A connection without a grant gets no
method table at all, so there is nothing to call.

If an error is thrown while deciding, the connection is denied. HyperDHT initialises
its hook as `firewalled: true` and swallows a throw, and `test/gate.test.js` pins that
behaviour so a future dependency bump cannot silently flip it open.

### There are no passwords, tokens or connection strings

Noise tells the host which device is calling, so there is nothing to steal, leak or
forget to rotate. This is why we did not build on a tunnel: a tunnel hands a guest the
whole of whatever is behind it, plus its credentials. See `DECISIONS.md` 2026-07-13.

### The allow-list is host-local and never replicated

Who may connect lives in a store only the host writes and nothing syncs. If it were in
a shared ledger, a revoked device would still hold a writer key and could append itself
back onto the list. The host is the sole authority on admission.

### Revoking cuts a device off now, not at its next login

The firewall only runs at connect time, so the host also tracks every live connection
per device and destroys them when you revoke. Within a second: no reconnect, no browse,
no next track, no artwork. Music already buffered on the phone may finish playing -
that is deliberate, so switching between wifi and mobile data does not stop the music -
and nothing *new* is ever served. The revoked device is also told once why it was
refused, so it stops knocking and can say so plainly instead of blaming your network.

### One person can be narrowed to chosen folders

A person can be given part of a library rather than all of it. Everything else is not
listed, not searchable, not streamable and has no artwork for them; a group (an album,
an artist) is visible only if at least one of its tracks is. Two rules make it safe
rather than approximate: anything the host cannot place on disk is hidden from a
narrowed person, and a music source that cannot enforce the rule at all serves them
nothing rather than everything.

### ffmpeg is never handed to a shell

Every ffmpeg and ffprobe run is `spawn(binary, [arguments])`, with the arguments as
separate array entries (`host/transcode.js`). There is no `shell: true`, no `exec`, and
no command assembled by string concatenation anywhere in the host.

### A phone cannot ask for a file by path

Track, album and artist ids are namespaced hashes, not paths (`protocol/ids.js`). They
are not invertible and cannot be walked: an id the host does not know is simply not
found, so there is no `../..` to attempt. The host's own filesystem layout is never
sent to a phone.

### A device can only ever speak about itself

Everything a phone writes - its name, its photo, its favourites, its resume points, its
requests - is keyed to the identity of the connection it arrived on, never to a
parameter the phone supplies. A device cannot name itself as somebody else, and it
cannot attach itself to an existing person: only the operator confirms that, on the
dashboard.

## The dashboard

The dashboard can revoke every device and open a pairing window onto the whole library,
so it is treated as a control plane.

- **It refuses to start unauthenticated on a network.** A non-loopback bind with no
  password throws rather than warns (`requireSafeBind`). On Umbrel and Start9 the
  platform supplies the password.
- **Failed logins are rate-limited**, and the session cookie is `SameSite=Strict`.
- **When there is no password** - the desktop tray app, which binds to loopback only -
  requests must come from loopback by both `Host` and `Origin`. That closes two
  attacks a bare loopback bind does not: a web page you visit blind-POSTing to the
  dashboard, and DNS rebinding, where a page re-resolves its own name to 127.0.0.1 so
  the browser hands it the answers. A password-protected install is untouched by this
  check, because the cookie already covers both.

## The phone app

- The bundled page is the only thing the WebView loads; any attempt to navigate
  elsewhere is refused, and an ordinary web link is handed to the browser instead.
- The shell will open only `https:`, `mailto:`, `lightning:` and `bitcoin:` URLs.
  Anything else - notably Android's `intent://` and `file://` - is refused.
- The only capture permission granted is the camera, for the pairing QR scanner.
- The app asks for the network, the camera and (on Android) notifications and
  foreground playback. It has no account, sends no analytics and phones nothing home.

## When a direct connection is impossible

Some mobile networks refuse a direct connection between two devices. PearTune then
falls back to a relay we run, which forwards data it cannot read - the encryption is
end-to-end between your phone and your host, and the relay holds no keys and keeps no
copy. Your phone always tries a direct connection first, asks before streaming a
library's music over the relay, and Settings can disable it entirely.

## What this does not claim

- It does not protect a machine somebody already controls. A host with a compromised
  operating system is compromised.
- It does not hide *that* you are running PearTune from someone watching your network,
  only what you are playing.
- A device you have let in can see the music you let it see. Sharing is a decision, and
  revoking is how you undo it.

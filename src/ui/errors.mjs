// How a failure becomes something a person can read.
//
// Pure and dependency-free so it can be unit-tested away from React (the same reason
// app/queue-index.js and host/gate.js are pure) - and because the day this file
// exists to prevent, the message a user saw WAS the whole bug report.

// --- what a failure LOOKS like ---------------------------------------------
//
// A raw message is not a sentence. "undefined is not a function" is a stack trace
// with the stack cut off, and it shipped to the user as a red bar across the
// library - which tells them nothing except that PearTune is broken.
//
// So every failure goes through friendlyError, which sorts it into one of three
// kinds and gives it words a person can act on:
//
//   plain - we wrote this message for a human already (pairError's copy, "that
//           artist has no albums"). Show it as-is; a Details drawer would be
//           theatre.
//   known - we RECOGNISE the cause (access revoked, host unreachable, gone). Say
//           what happened and what to do. The original stays under Details,
//           because "which of the two network failures was it" has burned us
//           before. No Report button: this is not a bug.
//   bug   - we do not recognise it, or it is plainly internal (a TypeError, a
//           missing property). Say so honestly - it is not the user's fault - and
//           offer to report it WITH the technical text attached.
//
// The order matters: internal-looking messages are classified before the network
// patterns, or a TypeError mentioning "connection" would be filed as a network
// blip and the real bug would stay invisible.
export function friendlyError (raw) {
  const m = String(raw ?? '').trim()
  if (!m) return null

  // Ours already: written for a person, ends like a sentence, no JS/errno shrapnel.
  // Deliberately NOT errno codes (ECONNREFUSED and friends): those are network
  // conditions, and filing them as app bugs would bury the real ones.
  const internal = /is not a function|undefined is not|null is not an object|Cannot read|Cannot access|TypeError|ReferenceError|\bNaN\b|\[object /
  if (!internal.test(m) && /[.!?]$/.test(m) && / /.test(m)) {
    return { kind: 'plain', title: m }
  }

  if (internal.test(m)) {
    return {
      kind: 'bug',
      title: 'Something went wrong inside PearTune.',
      hint: 'This is a bug in the app, not something you did. Reporting it with the details below is the fastest way to get it fixed.',
      technical: m
    }
  }
  if (/revoked|denied|no grant|not allowed|forbidden|unauthorized/i.test(m)) {
    return {
      kind: 'known',
      title: "Your library stopped this device's access.",
      hint: 'Whoever runs the server can pair this phone again from its dashboard.',
      technical: m
    }
  }
  if (/unreachable|timed out|timeout|offline|disconnect|connection|network|refused|ENOTFOUND|ECONN/i.test(m)) {
    return {
      kind: 'known',
      title: "Can't reach your library right now.",
      hint: 'Check the server is on and that this phone and it can see each other on the network.',
      technical: m
    }
  }
  if (/not found|404|missing|no such/i.test(m)) {
    return {
      kind: 'known',
      title: "That isn't in your library any more.",
      hint: 'It may have been moved or removed on the server. Pull to refresh, or rescan from the dashboard.',
      technical: m
    }
  }
  return {
    kind: 'bug',
    title: "PearTune hit a problem it doesn't have words for yet.",
    hint: 'Reporting it with the details below is what turns it into a message that makes sense.',
    technical: m
  }
}

// Nothing leaves the phone with a key in it. A bug report is a URL the user opens
// in their own browser, but it is still THEIR library - so strip the two things a
// PearTune error can carry: a z32 key/id (host keys, device keys, track ids) and a
// loopback stream URL, whose port says nothing useful anyway.
export function redact (text) {
  return String(text ?? '')
    .replace(/https?:\/\/127\.0\.0\.1:\d+\/\S*/g, '<local stream url>')
    .replace(/\b[a-z0-9]{40,}\b/gi, '<id>')
}

// GitHub renders markdown; a mail client shows it raw, where `**bold**` and fenced
// code just read as line noise. Same report, two dresses.
function reportParts (technical, { version = '0.0.0', platform = 'unknown platform', markdown = true } = {}) {
  const said = redact(technical)
  const body = markdown
    ? [
        '**What I was doing**', '', '(a line or two here helps a lot)', '',
        '**What PearTune said**', '', '```', said, '```', '',
        `App ${version} \u00b7 ${platform}`, '',
        '_Keys and stream URLs are stripped from this automatically._'
      ]
    : [
        'What I was doing:', '', '(a line or two here helps a lot)', '',
        'What PearTune said:', '', '  ' + said, '',
        `App ${version} \u00b7 ${platform}`, '',
        'Keys and stream URLs are stripped from this automatically.'
      ]
  return { title: `[bug] ${said.slice(0, 80)}`, body: body.join('\n') }
}

export function reportUrl (technical, opts = {}) {
  const { title, body } = reportParts(technical, opts)
  return `${opts.repo ?? ''}/issues/new?labels=bug&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
}

// The same report as an email. Not a nicety: GitHub makes you SIGN IN before it will
// show a prefilled issue form, so a user without an account taps "Report" and lands
// on a login wall. Mail works for everyone, and Copy works when neither app does.
export function reportMailto (technical, opts = {}) {
  const { title, body } = reportParts(technical, { ...opts, markdown: false })
  return `mailto:${opts.to ?? ''}?subject=${encodeURIComponent('[PearTune] ' + title)}&body=${encodeURIComponent(body)}`
}

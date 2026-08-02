// The Home Assistant config block the dashboard hands the operator.
//
// This exists because a broken one shipped. Successive edits put `peartune_control` after
// the automation block instead of under `rest_command`, and the second automation after
// `media_player` - so both landed inside the wrong parent, and Home Assistant refused the
// whole file with "expected <block end>, but found '?'". Nothing could have caught it: the
// YAML was a string literal inside a JSX file, and no test parsed it.
//
// So: parse it, and assert the shape. A mis-indented edit now fails the gate rather than
// somebody's Home Assistant.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

// The module is an ES export for the dashboard bundle; the test only needs the template, so
// pull the function body out rather than dragging a bundler in for one string.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'host', 'ui', 'app', 'ha-config.js'), 'utf8')
const haConfig = new Function('opts', SRC.replace(/^export /gm, '') + '\nreturn haConfig(opts)')

const CFG = () => haConfig({ port: 8742, token: 'test-token', speakerEntity: 'media_player.spk' })

test('the one-time include is valid YAML and turns on package loading', () => {
  const inc = /export const PACKAGE_INCLUDE = `([^`]*)`/.exec(SRC)[1]
  // !include_dir_named is a Home Assistant tag, not standard YAML, so parsing it needs the
  // tag declared. What matters is the shape: a homeassistant block with a packages key.
  assert.match(inc, /^homeassistant:/m)
  assert.match(inc, /packages: !include_dir_named packages/)
})

test('the generated Home Assistant config is valid YAML', () => {
  assert.doesNotThrow(() => yaml.load(CFG()), 'it must parse at all - this is the bug that shipped')
})

test('every block is TOP LEVEL, not nested inside its neighbour', () => {
  const doc = yaml.load(CFG())
  // The exact failure: peartune_control ended up inside automation, and the second
  // automation inside media_player. Asserting the top-level keys pins both.
  assert.deepEqual(Object.keys(doc).sort(), ['automation', 'intent_script', 'rest_command'])
})

test('both rest_commands are under rest_command, with the right ports and token', () => {
  const doc = yaml.load(CFG())
  const rc = doc.rest_command
  assert.deepEqual(Object.keys(rc).sort(), ['peartune_control', 'peartune_play'])
  assert.equal(rc.peartune_play.url, 'http://127.0.0.1:8742/voice/play')
  assert.equal(rc.peartune_control.url, 'http://127.0.0.1:8742/voice/control')
  for (const cmd of Object.values(rc)) {
    assert.match(cmd.payload, /test-token/, 'the token has to actually reach the payload')
    assert.equal(cmd.method, 'POST')
  }
})

test('there is NO media_player block - our sentences beat the built-in intents', () => {
  const doc = yaml.load(CFG())
  // A `universal` player was here to satisfy HassMediaNext/HassMediaPrevious, which match
  // on features AND a PLAYING state AND require the entity to be exposed to Assist - the
  // last of which is a UI toggle we cannot generate ("Sorry, PearTune is not exposed").
  // Measured 2026-08-02: a conversation trigger on "next" wins outright, so all of that
  // went away. Putting it back would reintroduce the exposure step.
  assert.equal('media_player' in doc, false)
})

test('the stop sentences avoid the built-in pause intent\'s name matching', () => {
  const doc = yaml.load(CFG())
  const stop = doc.automation[1].triggers.find(t => t.id === 'stop')
  // "stop peartune" parses as stop + device NAME for the built-in, which then answers
  // "not aware of any device called PearTune".
  assert.equal(stop.command.includes('stop peartune'), false)
  assert.ok(stop.command.includes('stop the music'))
})

test('next and previous are OUR sentences, on the words people actually use', () => {
  const doc = yaml.load(CFG())
  const t = doc.automation[1].triggers
  const next = t.find(x => x.id === 'next')
  const prev = t.find(x => x.id === 'previous')
  assert.ok(next.command.includes('next'))
  assert.ok(next.command.includes('skip'))
  assert.ok(prev.command.includes('go back'))
})

test('both automations are present and each carries its own sentences', () => {
  const doc = yaml.load(CFG())
  assert.equal(doc.automation.length, 2)
  const [play, controls] = doc.automation
  assert.match(play.alias, /PearTune voice/)
  assert.ok(play.triggers[0].command.some(c => c.includes('put on')))
  // "play {query}" alone is HA's built-in search intent, which cannot see this library.
  // Claiming it would lose the match and answer "no devices supports the required features".
  assert.equal(
    play.triggers[0].command.some(c => /^play \[some\] \{query\}$/.test(c)), false,
    'plain "play X" belongs to the built-in intent - taking it breaks voice'
  )
  assert.equal(controls.triggers.length, 4)
  assert.deepEqual(controls.triggers.map(t => t.id).sort(), ['next', 'previous', 'shuffle', 'stop'])
})

test('a named song is answered with the song AND who it is by', () => {
  const doc = yaml.load(CFG())
  const said = String(doc.automation[0].actions.find(x => 'set_conversation_response' in x).set_conversation_response)
  // "put on rock and roll" answered "Playing KISS" - true, but it hid WHICH Rock and Roll
  // it had picked, and several artists have one. Naming both is how the person finds out
  // they got a different band's song.
  assert.match(said, /by \{\{ result\.content\.artist \}\}/)
  assert.match(said, /the album/)
})

test('the spoken replies name what is happening, not just "OK"', () => {
  const doc = yaml.load(CFG())
  const said = String(doc.automation[1].actions.find(x => 'set_conversation_response' in x).set_conversation_response)
  // "OK" told Tim nothing about whether shuffle had done anything (2026-08-02).
  assert.match(said, /Shuffling/)
  assert.match(said, /result\.content\.label/, 'and it names the artist when the host knows one')
  assert.match(said, /Skipping/)
})

test('every automation speaks its outcome, including failure', () => {
  const doc = yaml.load(CFG())
  for (const a of doc.automation) {
    const said = a.actions.find(x => 'set_conversation_response' in x)
    assert.ok(said, `${a.alias} must answer out loud`)
    // The silent-failure bug: the host said "not in the library" and the automation
    // dropped it, so an unknown artist was silence.
    assert.match(String(said.set_conversation_response), /else/, 'the failure branch has to exist')
    assert.ok(a.actions.some(x => x.response_variable), 'and it needs the response to branch on')
  }
})

test('the LLM-facing intent carries a description', () => {
  const doc = yaml.load(CFG())
  const it = doc.intent_script.PearTunePlayMusic
  // Optional to Home Assistant, but it is what an LLM agent reads to decide whether to use
  // the tool. Without it the model gets a generic fallback and rarely picks it.
  assert.ok(it.description && it.description.length > 40)
  assert.ok(it.parameters.search_query)
})

test('the port and token are substituted, never left as placeholders', () => {
  const out = haConfig({ port: 9999, token: 'abc123' })
  assert.match(out, /127\.0\.0\.1:9999/)
  assert.match(out, /abc123/)
  assert.equal(/PORT|YOUR_TOKEN|undefined|\$\{/.test(out), false, 'nothing unsubstituted may reach a config file')
})

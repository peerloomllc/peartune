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

// --- the optional light ring indicator (2026-08-08) --------------------------
//
// Tim asked for a twinkle. The Voice PE ring is one RGB light with no named effects and no
// per-LED control (measured: supported_features 40 = TRANSITION + FLASH, EFFECT unset,
// effect_list empty even when lit, and no `esphome.` services at all), so what is buildable
// is a breathing PULSE. The firmware's own twinkle is not reachable from Home Assistant.
//
// The trap these guard is the one this whole module exists for: the LED automation must JOIN
// the existing `automation:` list, not add a second top-level `automation:` key. A duplicate
// key does not error - the later one silently wins, and the voice sentences vanish.

const LED = { light: 'light.ring', player: 'media_player.spk', style: 'solid' }
const cfgLed = (over = {}) =>
  haConfig({ port: 8742, token: 'test-token', led: { ...LED, ...over } })

test('the LED block is OFF unless asked for, and the file is unchanged without it', () => {
  assert.equal(CFG(), haConfig({ port: 8742, token: 'test-token', speakerEntity: 'media_player.spk', led: null }))
  assert.ok(!CFG().includes('peartune_led'), 'no LED automation when it was not requested')
})

test('the LED automation JOINS the automation list - no duplicate top-level key', () => {
  const src = cfgLed()
  // The bug, stated as an assertion: exactly one `automation:` at column 0.
  assert.equal((src.match(/^automation:/gm) || []).length, 1, 'a second automation: key silently eats the first')
  const doc = yaml.load(src)
  assert.deepEqual(Object.keys(doc).sort(), ['automation', 'intent_script', 'rest_command'])
  const ids = doc.automation.map(a => a.id).filter(Boolean)
  assert.ok(ids.includes('peartune_led'), 'the LED automation is in the list')
  // And the voice sentences must still be there beside it - what a duplicate key destroys.
  assert.ok(doc.automation.some(a => a.alias === 'PearTune voice'), 'the voice automation survived')
})

test('solid sets a colour once; pulse loops with a transition', () => {
  const solid = yaml.load(cfgLed({ style: 'solid' })).automation.find(a => a.id === 'peartune_led')
  const play = solid.actions[0].choose[0].sequence
  assert.equal(play.length, 1, 'solid is one call')
  assert.equal(play[0].action, 'light.turn_on')
  assert.ok(!JSON.stringify(play).includes('repeat'), 'solid does not loop')

  const pulse = yaml.load(cfgLed({ style: 'pulse' })).automation.find(a => a.id === 'peartune_led')
  const loop = pulse.actions[0].choose[0].sequence[0].repeat
  assert.ok(loop, 'pulse is a repeat loop')
  assert.equal(loop.while[0].state, 'playing', 'and it ends by itself when the music does')
  assert.ok(JSON.stringify(loop.sequence).includes('"transition":2'), 'it fades rather than steps')
})

test('mode is restart, which is what cancels the pulse when the music stops', () => {
  // Without it, pausing leaves the loop running and it keeps writing to the ring forever.
  const a = yaml.load(cfgLed({ style: 'pulse' })).automation.find(a => a.id === 'peartune_led')
  assert.equal(a.mode, 'restart')
})

test('paused is SOLID even in pulse mode, and idle hands the ring back', () => {
  const a = yaml.load(cfgLed({ style: 'pulse' })).automation.find(a => a.id === 'peartune_led')
  const paused = a.actions[0].choose[1]
  assert.equal(paused.conditions[0].state, 'paused')
  assert.ok(!JSON.stringify(paused.sequence).includes('repeat'), 'a pulsing "paused" is a contradiction')
  // The default branch must turn the light OFF, not set some colour of ours - the ring
  // belongs to the assistant when we are not using it.
  assert.equal(a.actions[0].default[0].action, 'light.turn_off')
})

test('it re-asserts on a timer, because the assistant takes the ring back', () => {
  // The assistant animates the ring whenever it listens or replies, below the light entity.
  // A colour set once can simply vanish; without this trigger it stays vanished.
  const a = yaml.load(cfgLed()).automation.find(a => a.id === 'peartune_led')
  assert.ok(a.triggers.some(t => t.trigger === 'time_pattern'), 'no recovery trigger')
  assert.ok(a.triggers.some(t => t.trigger === 'state' && t.entity_id === 'media_player.spk'))
})

test('a half-configured LED request is ignored rather than half-written', () => {
  assert.ok(!haConfig({ led: { light: '', player: 'media_player.spk' } }).includes('peartune_led'))
  assert.ok(!haConfig({ led: { light: 'light.ring', player: '' } }).includes('peartune_led'))
})

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

const LED = {
  light: 'light.ring',
  player: 'media_player.spk',
  style: 'solid',
  satellite: 'assist_satellite.spk'
}
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
  // choose[0] is the stand-down branch; the music branch is the one keyed on "playing".
  const musicBranch = a => a.actions[0].choose.find(b => b.conditions.some(c => c.state === 'playing'))
  const solid = yaml.load(cfgLed({ style: 'solid' })).automation.find(a => a.id === 'peartune_led')
  const play = musicBranch(solid).sequence
  assert.equal(play.length, 1, 'solid is one call')
  assert.equal(play[0].action, 'light.turn_on')
  assert.ok(!JSON.stringify(play).includes('repeat'), 'solid does not loop')

  const pulse = yaml.load(cfgLed({ style: 'pulse' })).automation.find(a => a.id === 'peartune_led')
  const loop = musicBranch(pulse).sequence[0].repeat
  assert.ok(loop, 'pulse is a repeat loop')
  assert.equal(loop.while[0].state, 'playing', 'and it ends by itself when the music does')
  assert.ok(JSON.stringify(loop.sequence).includes('"transition":2'), 'it fades rather than steps')
})

test('mode is restart, which is what cancels the pulse when the music stops', () => {
  // Without it, pausing leaves the loop running and it keeps writing to the ring forever.
  const a = yaml.load(cfgLed({ style: 'pulse' })).automation.find(a => a.id === 'peartune_led')
  assert.equal(a.mode, 'restart')
})

test('there is NO paused branch, because the firmware blanks the ring there', () => {
  // Written after the first version shipped one. HA accepted an amber "paused" colour and
  // reported it set; the device stayed dark, because the firmware takes the ring back the
  // moment playback stops. Tim saw the pulse work while playing and saw nothing at all on
  // pause, which is what gives the rule.
  //
  // Commanding a colour that never renders is exactly how that version looked verified, so
  // the branch is gone rather than left in as a hopeful no-op.
  const a = yaml.load(cfgLed({ style: 'pulse' })).automation.find(a => a.id === 'peartune_led')
  const music = a.actions[0].choose.find(b => b.conditions.some(c => c.state === 'playing'))
  assert.ok(music, 'playing is the one state that is ours to drive')
  assert.ok(!JSON.stringify(a).includes('200, 120, 0'), 'no amber anywhere')
  // Not playing: hand the ring back rather than keep driving it.
  assert.equal(a.actions[0].default.at(-1).action, 'light.turn_off')
  assert.ok(!JSON.stringify(a.actions[0].default).includes('0, 180, 60'), 'no green left behind')
})

test('stopping restores the ring to the speaker\'s own resting blue', () => {
  // The bug Tim caught on 2026-08-10: after this feature shipped, the ring woke GREEN on the
  // wake word instead of blue. `light.led_ring` is not just a light on the Voice PE, it is
  // the palette the FIRMWARE paints its own voice states with -
  //   auto light_color = id(led_ring).current_values;   (home-assistant-voice.yaml)
  // so our playing colour was recolouring listening and thinking too, and it stuck on the
  // device after light.turn_off.
  const a = yaml.load(cfgLed({ style: 'pulse' })).automation.find(a => a.id === 'peartune_led')
  const restore = a.actions[0].default.find(s => s.if)
  assert.ok(restore, 'nothing puts the colour back when the music stops')
  const call = restore.then[0]
  assert.equal(call.action, 'light.turn_on')
  // The firmware's factory initial_state: 9.4% / 73.3% / 94.9% at 66% brightness.
  assert.deepEqual(call.data.rgb_color, [24, 187, 242])
  assert.equal(call.data.brightness, 168)
  // And it must be off again afterwards, not left showing our restore.
  assert.equal(a.actions[0].default.at(-1).action, 'light.turn_off')
})

test('the colour is only restored when WE are the one holding the ring', () => {
  // The gate is the light being on, which in the not-playing branch means our own pulse left
  // it on. Without it the minute tick would overwrite a colour the owner set with the
  // speaker's dial, every 60 seconds, forever.
  const a = yaml.load(cfgLed()).automation.find(a => a.id === 'peartune_led')
  const restore = a.actions[0].default.find(s => s.if)
  assert.equal(restore.if[0].entity_id, 'light.ring')
  assert.equal(restore.if[0].state, 'on')
})

// --- the speaker's own voice is not music (2026-08-10) -----------------------
//
// Tim saw a second of erratic flicker at the wake word. The Voice PE speaks its replies
// through the SAME media_player this automation watches, so every "Okay Nabu" showed up as a
// second of `playing` and we lit the ring underneath the assistant's own animation.

test('a one-second announcement is not mistaken for music', () => {
  const a = yaml.load(cfgLed()).automation.find(a => a.id === 'peartune_led')
  const start = a.triggers.find(t => t.to === 'playing')
  assert.equal(start.for, '00:00:05', 'playing has to LAST before we take the ring')
  const music = a.actions[0].choose.find(b => b.conditions.some(c => c.state === 'playing'))
  assert.equal(music.conditions[0].for, '00:00:05', 'or the minute tick grabs it mid-reply')
})

test('it stands off the ring entirely while the assistant is using it', () => {
  const a = yaml.load(cfgLed({ style: 'pulse' })).automation.find(a => a.id === 'peartune_led')
  // First branch wins in a choose, so standing down has to come before the music branch.
  const busy = a.actions[0].choose[0]
  assert.match(String(busy.conditions[0].value_template), /assist_satellite\.spk/)
  assert.ok(busy.sequence[0].stop, 'it must do NOTHING, not write some colour of its own')
  // And it has to hear the assistant let go, or the ring stays dark for up to a minute.
  assert.ok(a.triggers.some(t => t.entity_id === 'assist_satellite.spk'), 'no trigger to come back on')
  // The pulse stops writing too, rather than painting over the animation every two seconds.
  const loop = a.actions[0].choose[1].sequence[0].repeat
  assert.match(JSON.stringify(loop.while), /assist_satellite\.spk/)
})

test('a speaker with no Assist satellite still works, and never stands down', () => {
  // states() on an unknown entity is 'unknown', not an error - but rather than lean on that,
  // a config without a satellite omits the trigger and hard-codes the branch to false.
  const a = yaml.load(cfgLed({ satellite: '' })).automation.find(a => a.id === 'peartune_led')
  assert.ok(!JSON.stringify(a).includes('assist_satellite'), 'no dangling entity id')
  assert.match(String(a.actions[0].choose[0].conditions[0].value_template), /false/)
  assert.equal(a.triggers.filter(t => t.id === 'assistant').length, 0, 'nothing to trigger on')
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

// --- saying a room (2026-08-11) ----------------------------------------------
//
// "Put on Metallica in the kitchen." The host already accepted a target speaker
// (cast.js: `body.entityId || cfg.voiceEntityId`); what was missing was Home Assistant
// ever sending one. These pin the two decisions that were made by LOOKING at Tim's real
// Home Assistant rather than at how one is supposed to be set up.

const voiceAuto = () => yaml.load(CFG()).automation.find(a => a.alias === 'PearTune voice')
const resolverOf = (a) => String(a.actions.find(s => s.variables)?.variables?.target || '')

test('a room reaches the host, instead of being thrown away', () => {
  // The payload used to hardcode "entityId":"" - so a room could be heard, matched, and
  // then silently dropped on the doorstep.
  // Assert on the PARSED payload, not the source text: inside a single-quoted YAML scalar
  // the empty default is written '''' and unescapes to ''. Reading the raw file would be
  // testing the escaping rather than what Home Assistant receives.
  const payload = yaml.load(CFG()).rest_command.peartune_play.payload
  assert.match(payload, /"entityId":"\{\{ entity_id \| default\(''\) \}\}"/, 'the rest_command cannot carry a speaker')
  assert.doesNotThrow(() => JSON.parse(payload.replace(/\{\{[^}]*\}\}/g, 'x')), 'the payload must still be JSON')
  const step = voiceAuto().actions.find(s => s.action === 'rest_command.peartune_play')
  assert.ok(step.data.entity_id, 'the play step does not pass one')
})

test('the plain sentences still exist, and are matched FIRST', () => {
  // A wildcard room in the only pattern would eat part of an artist's name.
  const t = voiceAuto().triggers
  const plain = t.find(x => x.id === 'here')
  const room = t.find(x => x.id === 'room')
  assert.ok(plain && room, 'both sentence sets must exist')
  assert.ok(plain.command.every(c => !c.includes('{room}')), 'the plain set must have no room slot')
  assert.ok(room.command.every(c => c.includes('{room}')), 'the room set must have one')
  assert.ok(t.indexOf(plain) < t.indexOf(room), 'plain sentences come first')
})

test('a room is looked up by AREA first, then by speaker NAME', () => {
  // Measured on Tim's HA 2026-08-11: FOUR of his five speakers have no area at all, and
  // are named for their rooms ("Kitchen speaker"). Areas alone would have found nothing
  // outside the man cave.
  const r = resolverOf(voiceAuto())
  assert.match(r, /area_entities\(r\)/, 'no area lookup')
  assert.match(r, /states\.media_player/, 'no name fallback')
  assert.ok(r.indexOf('area_entities') < r.indexOf('states.media_player'), 'area is the more deliberate statement, so it wins')
})

test('the resolver uses NO regex, because HA has no regex_escape', () => {
  // The first cut did, and Tim's own Home Assistant answered "No filter named
  // 'regex_escape' found" - every room lookup would have thrown at runtime. Plain
  // lowercase containment also survives the apostrophe in "Sarah's room", which resolved
  // correctly against his real speakers.
  const r = resolverOf(voiceAuto())
  assert.ok(!r.includes('regex_escape'), 'regex_escape does not exist in Home Assistant')
  assert.match(r, /\| lower\) in \(/, 'plain containment is what replaced it')
})

test('AN UNFINDABLE ROOM MUST NOT PLAY SOMEWHERE ELSE', () => {
  // Falling through to the default speaker would answer "play it in the kitchen" by
  // playing it in the man cave. The person walks off believing it worked.
  const a = voiceAuto()
  const guard = a.actions.findIndex(s => s.if && JSON.stringify(s.if).includes('NONE'))
  const play = a.actions.findIndex(s => s.action === 'rest_command.peartune_play')
  assert.ok(guard > -1, 'nothing catches a room with no speaker')
  assert.ok(guard < play, 'the guard has to come BEFORE the play, or it plays anyway')
  assert.match(JSON.stringify(a.actions[guard].then), /could not find a speaker/i)
  assert.ok(JSON.stringify(a.actions[guard].then).includes('stop'), 'it must stop, not continue')
})

test('the LLM path takes a room too, and resolves it identically', () => {
  const doc = yaml.load(CFG())
  const intent = doc.intent_script.PearTunePlayMusic
  assert.ok(intent.parameters.room, 'an LLM agent cannot pass a room')
  const intentResolver = String(intent.action.find(s => s.variables)?.variables?.target || '')
  const spoken = resolverOf(voiceAuto())
  // Same text, not merely similar: two copies WILL drift about what a room means.
  assert.ok(intentResolver.includes('area_entities(r)') && intentResolver.includes('states.media_player'))
  assert.equal(
    intentResolver.replace(/\s+/g, ' ').includes(spoken.split('%}').pop().replace(/\s+/g, ' ').trim().slice(0, 40)),
    true,
    'the two paths must share one resolver'
  )
})

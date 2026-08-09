// The Home Assistant configuration block the Speakers panel hands the operator.
//
// ITS OWN MODULE SO IT CAN BE PARSED IN A TEST. It lived inline in the panel and shipped
// broken: successive edits inserted `peartune_control` after the automation block instead of
// under `rest_command`, and the second automation after `media_player`, so both landed inside
// the wrong parent. Home Assistant answered "expected <block end>, but found '?'" and the
// operator got a config that would not load. Nothing in the suite could have caught that,
// because the YAML was a string literal in a JSX file that nothing parsed.
//
// test/ha-config.test.js now parses this with js-yaml and asserts the shape, so a
// mis-indented edit fails the gate rather than Tim's Home Assistant.
//
// WHY EACH PIECE IS HERE:
//   rest_command   - the two calls into PearTune. Loopback only; HA must be on this machine.
//   automation     - the sentences, including next/previous. There WAS a `universal`
//                    media_player here to satisfy Home Assistant's built-in skip intents,
//                    which match on FEATURES and a PLAYING state and then require the entity
//                    to be EXPOSED to Assist - a UI step we could not generate. Measured
//                    2026-08-02: our own conversation sentences beat the built-ins outright
//                    ("next" -> OK), so the entity, the exposure step and the state rule all
//                    went away with it. "play X" belongs to HA's built-in search intent (which
//                    cannot see this library), so ours are "put on" / "listen to". Shuffle
//                    and a true stop have no built-in intent at all, hence their own block.
//   intent_script  - for LLM voice agents, which never see sentences and are offered intents
//                    as tools instead.

// The ONE-TIME line that turns on package loading. Added to configuration.yaml once and
// never touched again; after that, PearTune lives entirely in its own file and an update
// replaces that file rather than surgically editing the operator's main config.
//
// Tim asked for this (2026-08-02) and he is right that it is the better practice: editing
// somebody's configuration.yaml on every update is how you eventually corrupt it - which we
// had just done, shipping a block that landed inside the wrong parent.
export const PACKAGE_INCLUDE = `homeassistant:
  packages: !include_dir_named packages
`

export const PACKAGE_PATH = 'packages/peartune.yaml'

// speakerEntity is accepted and unused: it was needed by a `universal` media_player that no
// longer exists (see the note above about our sentences winning outright). Kept in the
// signature so callers do not have to change, and so this comment explains its absence.

// THE LIGHT RING INDICATOR, appended only when the operator asks for it.
//
// Measured on a real Voice PE (2026-08-08): the ring is an ordinary RGB light that takes a
// colour and holds it. supported_features is 40 - TRANSITION and FLASH - and EFFECT is NOT
// set, effect_list is empty even with the light on, and the device exposes no `esphome.`
// services at all. So there is NO named effect to ask for.
//
// TIM IS RIGHT THAT THE HARDWARE TWINKLES - he saw it during Nabu Casa setup. That is the
// FIRMWARE animating the ring for its own voice states, below the HA light entity, and it
// offers Home Assistant no handle on it. A real per-LED sparkle also needs twelve
// addressable lights and HA sees one. Both would need custom firmware, which is buildable
// (the Voice PE firmware is open source) but means self-managing updates on the box the
// house's voice control depends on. Out of scope for an indicator light.
//
// What IS available is TRANSITION, so a pulse is a loop of turn_on calls that fade.
//
// THE FIRMWARE ONLY LETS GO OF THE RING WHILE MEDIA IS PLAYING, and that is the whole
// shape of this feature. Found the hard way on 2026-08-08: I first reported all three
// states "verified" on the strength of API READBACK - HA said on/[0,180,60]/brightness
// oscillating, exactly as commanded. Tim was looking at the actual device. Commanded to
// full-brightness red with nothing playing, HA reported `on 255 [255,0,0]` and the ring
// was DARK. The readback was never the claim; "a light comes on" was, and only a person
// looking could settle it.
//
// But he also saw the PULSE work while music played. Both observations together give the
// rule: the ring renders Home Assistant's light DURING PLAYBACK and the firmware blanks it
// otherwise. So:
//
//   playing   ours. Pulse or solid, and it genuinely lights.
//   paused    NOT ours. An amber "paused" colour was written and never appeared, because
//             the firmware has already taken the ring back. Do not pretend otherwise -
//             sending a colour nothing renders is how the first version looked verified.
//   idle/off  not ours either, and nothing to do.
//
// So there is no paused branch. The ring goes dark when the music stops, which is the
// firmware's behaviour rather than ours, and the UI says so plainly.

// IT IS A LIST ITEM, NOT A SECOND `automation:` KEY. Appending another top-level
// `automation:` to this file would be a DUPLICATE YAML KEY - the second one silently wins
// and the voice sentences vanish. That is the same shape as the bug this module was split
// out for in the first place, so the LED automation joins the existing list instead.
function ledConfig ({ light, player, style }) {
  if (!light || !player) return ''
  const pulse = style === 'pulse'
  const playing = pulse
    ? `
              # The pulse. It lives INSIDE the playing branch and the automation is
              # mode: restart, so a change to paused or idle cancels it outright - no
              # second automation to turn on and off, and no loop left writing to the
              # ring after the music stops. The while-condition is a second belt: even
              # if it were never cancelled it would end on its own.
              - repeat:
                  while:
                    - condition: state
                      entity_id: ${player}
                      state: "playing"
                  sequence:
                    - action: light.turn_on
                      target:
                        entity_id: ${light}
                      data:
                        rgb_color: [0, 180, 60]
                        brightness: 110
                        transition: 2
                    - delay: "00:00:02"
                    - action: light.turn_on
                      target:
                        entity_id: ${light}
                      data:
                        rgb_color: [0, 180, 60]
                        brightness: 20
                        transition: 2
                    - delay: "00:00:02"`
    : `
              - action: light.turn_on
                target:
                  entity_id: ${light}
                data:
                  rgb_color: [0, 180, 60]
                  brightness: 60`

  return `
  # --- light ring indicator (optional; delete this whole entry to remove it) ---
#
  # The ring is an ordinary RGB light: no named effects and no per-LED control, so this
  # breathes rather than sparkles. The twinkle the Voice PE does at setup is its own
  # firmware animating the ring for voice states, and it offers Home Assistant no
  # handle on it - see the note in PearTune's ha-config.js.
  #
  # mode: restart is load-bearing. Pausing re-triggers this automation, which cancels
  # the pulse loop mid-flight; without it the loop would keep writing to the ring.
  #
  # The time_pattern trigger is the recovery. The assistant takes the ring whenever it
  # listens or replies, so a colour set once can simply vanish. Re-asserting every
  # minute puts it back without firing on every attribute change.
  - id: peartune_led
    alias: PearTune light ring
    mode: restart
    triggers:
      - trigger: state
        entity_id: ${player}
        to: ["playing", "paused", "idle", "off", "standby"]
      - trigger: time_pattern
        minutes: "/1"
    actions:
      - choose:
          - conditions:
              - condition: state
                entity_id: ${player}
                state: "playing"
            sequence:${playing}
        default:
          # NOT PLAYING. Turn ours off and hand the ring back. The firmware has almost
          # certainly blanked it already - a colour commanded here never appears on the
          # device - so this is tidiness rather than something the eye will notice.
          - action: light.turn_off
            target:
              entity_id: ${light}
`
}

export function haConfig ({ port = 8742, token = '', speakerEntity = '', led = null } = {}) {
  const ledBlock = led ? ledConfig(led) : ''
  return `rest_command:
  peartune_play:
    url: "http://127.0.0.1:${port}/voice/play"
    method: POST
    content_type: "application/json"
    payload: '{"token":"${token}","query":"{{ query }}","entityId":""}'
  peartune_control:
    url: "http://127.0.0.1:${port}/voice/control"
    method: POST
    content_type: "application/json"
    payload: '{"token":"${token}","action":"{{ action }}"}'

automation:
  - alias: PearTune voice
    mode: queued
    triggers:
      - trigger: conversation
        command:
          - "put on [some] {query}"
          - "listen to [some] {query}"
          - "I want to listen to [some] {query}"
          - "play [some] {query} from peartune"
    actions:
      - action: rest_command.peartune_play
        data:
          query: "{{ trigger.slots.query }}"
        response_variable: result
      - set_conversation_response: >-
          {% if result.status != 200 %}I could not find {{ trigger.slots.query }} in your library{% elif result.content.kind == 'artist' %}Playing {{ result.content.artist }}{% elif result.content.kind == 'album' %}Playing the album {{ result.content.title }}{% elif result.content.artist %}Playing {{ result.content.title }} by {{ result.content.artist }}{% else %}Playing {{ result.content.title }}{% endif %}

  - alias: PearTune voice controls
    mode: queued
    triggers:
      - trigger: conversation
        command:
          - "next"
          - "next song"
          - "next track"
          - "skip"
          - "skip this song"
        id: next
      - trigger: conversation
        command:
          - "go back"
          - "previous"
          - "previous song"
          - "previous track"
        id: previous
      - trigger: conversation
        command:
          - "shuffle"
          - "shuffle [the] (music|queue|songs)"
        id: shuffle
      - trigger: conversation
        command:
          # NOT "stop peartune": Home Assistant's built-in pause intent parses that as
          # stop + a device NAME, then answers "not aware of any device called PearTune".
          # These phrasings are unclaimed. Plain "stop playing" still reaches the built-in
          # pause, which pauses the speaker - a reasonable thing for it to do.
          - "stop the music"
          - "stop my music"
        id: stop
    actions:
      - action: rest_command.peartune_control
        data:
          action: "{{ trigger.id }}"
        response_variable: result
      - set_conversation_response: >-
          {% if result.status != 200 %}Nothing is playing{% elif trigger.id == 'shuffle' %}Shuffling{% if result.content.label %} {{ result.content.label }}{% endif %}{% elif trigger.id == 'stop' %}Stopped{% elif trigger.id == 'previous' %}Going back{% else %}Skipping{% endif %}
${ledBlock}
intent_script:
  PearTunePlayMusic:
    description: >-
      Play music from the user's personal PearTune music library on a speaker in
      their home. Use this for any request to play a specific artist, album or
      song. The search_query is what the user asked for, such as "Led Zeppelin"
      or "Rock and Roll by Led Zeppelin" - pass the phrase as spoken, including
      the "by <artist>" part, which PearTune uses to pick the right version when
      several artists have a song by the same name.
    parameters:
      search_query:
        description: The artist, album or song to play
    action:
      - action: rest_command.peartune_play
        data:
          query: "{{ search_query }}"
    speech:
      text: "Playing {{ search_query }}"
`
}

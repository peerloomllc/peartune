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
//
// SETTING THE COLOUR IS NOT A LOCAL ACT. Tim noticed (2026-08-10) that after this shipped,
// the ring turned GREEN when the assistant woke on the wake word, where it had always been
// the stock blue. That is us, and it is by design in the firmware rather than a bug in it.
// From esphome/home-assistant-voice-pe's home-assistant-voice.yaml: every voice-state
// animation reads its colour off the user light,
//
//   auto light_color = id(led_ring).current_values;                        // each effect
//   brightness: !lambda return max(id(led_ring).current_values.get_brightness(), 0.2f);
//
// so `light.led_ring` is not just "a light we can turn on" - it is the PALETTE the whole
// device paints its own states with, wake word included. Writing green to it recolours
// listening, thinking and replying too, and the ring holds that colour on the device after
// light.turn_off (HA reports rgb_color null while it is off, which is why nothing in the
// dashboard showed the change).
//
// So the automation has to PUT THE PALETTE BACK when the music stops. The firmware's own
// factory setting is the target: initial_state red 9.4% green 73.3% blue 94.9% at 66%
// brightness, i.e. rgb(24, 187, 242) at 168/255.
//
// RESTORED ON THE STOP TRANSITION ONLY, NEVER ON THE MINUTE TICK. The tick exists to
// re-assert our colour during playback; if it also re-asserted the resting colour it would
// wipe out a colour the owner had chosen themselves - the device's dial sets the ring hue
// (the firmware writes it straight back into led_ring), so a stomp every 60 seconds would
// make that dial useless. Restoring only when playback ends touches the palette exactly as
// often as we dirtied it.
//
// AND THE SPEAKER'S OWN CHIME IS NOT MUSIC. Tim watched the first cut of the restore and saw
// a second of erratic flicker at the wake word before the blue spin settled. The history on
// his box says why, exactly:
//
//   media_player ...  16:40:18.126 playing -> 16:40:18.958 idle     (0.83s: the reply)
//   light ...         16:40:18.255 on      -> 16:40:19.083 off      (us, on top of it)
//
// The Voice PE speaks its acknowledgement THROUGH THE SAME media_player we watch, so every
// "Okay Nabu" flips it to `playing` for a second and our automation lit the ring green
// underneath the assistant's own animation - two partition lights writing the same twelve
// LEDs, with our colour mid-transition. Hence the flicker, and hence:
//
//   1. MUSIC IS `playing` THAT LASTS. A `for: 5s` on both the trigger and the condition, so
//      a chime or a spoken reply never counts. A song is minutes long and loses five seconds
//      of green; an announcement is one to three seconds and gets none, which is the point.
//   2. HANDS OFF WHILE THE ASSISTANT IS TALKING. assist_satellite.<device> reports idle /
//      listening / processing / responding, so we can simply stand down while it is not
//      idle, and take the ring back when it returns. Never fight the animation.
//   3. RESTORE WHENEVER WE ARE HOLDING IT. The light being `on` in the not-playing branch
//      means we are the one holding it, whatever route got us there - including "Okay Nabu,
//      stop", where the music ends while the assistant is still speaking.
const PLAYING_RGB = '[0, 180, 60]'
const RESTING_RGB = '[24, 187, 242]'
const RESTING_BRIGHTNESS = 168

// Long enough that no acknowledgement reaches it, short enough to feel like it belongs to the
// song. Measured replies on Tim's box: 0.83s, 3.09s, 0.83s.
const MUSIC_FOR = '00:00:05'

// Fail-open. An unknown entity id makes states() return 'unknown' rather than an error, so a
// device that names its satellite differently behaves exactly as it did before this branch
// existed instead of losing the ring entirely.
// WHICH SPEAKER DID THEY MEAN? One template, used by both the spoken sentences and the
// intent_script, so the two can never drift into disagreeing about a room.
//
// Expects `r` to be set to the spoken room, already trimmed. Renders the entity id, or the
// sentinel NONE when a room WAS said and nothing matched - which the caller must treat as
// "say so", never as "use the default speaker".
//
// NO REGEX. The first cut used `selectattr('name','search', '(?i)' ~ (r | regex_escape))` and
// Tim's own Home Assistant rejected it: **there is no `regex_escape` filter in HA's Jinja.**
// Every room lookup would have thrown at runtime. Caught by rendering this against his real HA
// through /api/template before shipping it, which is the only reason it is not in this file.
// Plain lowercase containment needs no escaping and cannot be broken by an apostrophe or a
// bracket in someone's room name.
const ROOM_TO_SPEAKER = `{%- if r -%}
                {%- set by_area = area_entities(r) | select('search', '^media_player\\\\.') | list -%}
                {%- if by_area -%}
                  {{ by_area[0] }}
                {%- else -%}
                  {%- set ns = namespace(hit='') -%}
                  {%- for s in states.media_player -%}
                    {%- if ns.hit == '' and (r | lower) in (s.name | lower) -%}
                      {%- set ns.hit = s.entity_id -%}
                    {%- endif -%}
                  {%- endfor -%}
                  {{ ns.hit if ns.hit else 'NONE' }}
                {%- endif -%}
              {%- endif -%}`

const AT_REST = "['idle', 'unknown', 'unavailable']"
const assistantBusy = satellite => (satellite ? `states('${satellite}') not in ${AT_REST}` : 'false')
const assistantIdle = satellite => (satellite ? `states('${satellite}') in ${AT_REST}` : 'true')

// IT IS A LIST ITEM, NOT A SECOND `automation:` KEY. Appending another top-level
// `automation:` to this file would be a DUPLICATE YAML KEY - the second one silently wins
// and the voice sentences vanish. That is the same shape as the bug this module was split
// out for in the first place, so the LED automation joins the existing list instead.
function ledConfig ({ light, player, style, satellite = '' }) {
  if (!light || !player) return ''
  const pulse = style === 'pulse'
  const playing = pulse
    ? `
              # The pulse. It lives INSIDE the playing branch and the automation is
              # mode: restart, so a change to paused or idle cancels it outright - no
              # second automation to turn on and off, and no loop left writing to the
              # ring after the music stops. The while-conditions are a second belt: even
              # if it were never cancelled it would end on its own, and it stops writing
              # the moment the assistant needs the ring.
              - repeat:
                  while:
                    - condition: state
                      entity_id: ${player}
                      state: "playing"
                    - condition: template
                      value_template: "{{ ${assistantIdle(satellite)} }}"
                  sequence:
                    - action: light.turn_on
                      target:
                        entity_id: ${light}
                      data:
                        rgb_color: ${PLAYING_RGB}
                        brightness: 110
                        transition: 2
                    - delay: "00:00:02"
                    - action: light.turn_on
                      target:
                        entity_id: ${light}
                      data:
                        rgb_color: ${PLAYING_RGB}
                        brightness: 20
                        transition: 2
                    - delay: "00:00:02"`
    : `
              - action: light.turn_on
                target:
                  entity_id: ${light}
                data:
                  rgb_color: ${PLAYING_RGB}
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
  #
  # The 5-second hold on "playing" is what keeps the speaker's OWN voice out of this.
  # It answers through the same media_player we watch, so every "Okay Nabu" shows up
  # here as a second of "playing". Music lasts; an acknowledgement does not.
  - id: peartune_led
    alias: PearTune light ring
    mode: restart
    triggers:
      - trigger: state
        entity_id: ${player}
        to: "playing"
        for: "${MUSIC_FOR}"
        id: music
      - trigger: state
        entity_id: ${player}
        to: ["paused", "idle", "off", "standby"]
        id: music
${satellite
    ? `      # Out of idle: the assistant wants the ring. Back to idle: we can have it again.
      # Pinned to those two edges rather than the bare entity, which would also fire on
      # every attribute change the satellite reports.
      - trigger: state
        entity_id: ${satellite}
        from: "idle"
        id: assistant
      - trigger: state
        entity_id: ${satellite}
        to: "idle"
        id: assistant\n`
    : ''}      - trigger: time_pattern
        minutes: "/1"
        id: tick
    actions:
      - choose:
          # THE ASSISTANT IS USING THE RING. Stand down and touch nothing: mode: restart
          # has already cancelled our pulse, and anything we wrote here would be a second
          # light drawing on the same twelve LEDs underneath its animation. That was the
          # flicker Tim saw at the wake word. We come back when it goes idle, which is
          # what the trigger on this entity is for.
          - conditions:
              - condition: template
                value_template: "{{ ${assistantBusy(satellite)} }}"
            sequence:
              - stop: "the assistant has the ring"
          # MUSIC, and music it has actually been for a while - not a spoken reply.
          - conditions:
              - condition: state
                entity_id: ${player}
                state: "playing"
                for: "${MUSIC_FOR}"
            sequence:${playing}
        default:
          # NOT PLAYING. Put the ring's colour back to the speaker's own resting blue
          # before handing it over, because that colour is what the device paints its
          # wake-word and listening animations with. Leave green here and the assistant
          # answers in green for good.
          #
          # Only when the light is ON, which in this branch means WE are the ones holding
          # it - our pulse leaves it on and nothing else here turns it on. That keeps the
          # restore to exactly the occasions we dirtied the colour, so the minute tick is
          # not forever overwriting a colour the owner set with the speaker's own dial.
          # It also covers "Okay Nabu, stop", where the music ends while the assistant is
          # still speaking and there is no tidy stop transition to hang this on.
          - if:
              - condition: state
                entity_id: ${light}
                state: "on"
            then:
              - action: light.turn_on
                target:
                  entity_id: ${light}
                data:
                  rgb_color: ${RESTING_RGB}
                  brightness: ${RESTING_BRIGHTNESS}
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
    payload: '{"token":"${token}","query":"{{ query }}","entityId":"{{ speaker_id | default('''') }}"}'
  peartune_control:
    url: "http://127.0.0.1:${port}/voice/control"
    method: POST
    content_type: "application/json"
    payload: '{"token":"${token}","action":"{{ action }}"}'

automation:
  # ONE SET OF SENTENCES, AND THE ROOM IS PARSED OUT OF WHAT WAS SAID.
  #
  # The first cut had a second set - "put on {query} in [the] {room}" - and Tim's own
  # Voice PE proved it wrong within a minute. BOTH patterns matched one utterance, so the
  # automation ran TWICE off a single "put on Metallica in the kitchen":
  #
  #   voice:no-match {"query":"Metallica in the kitchen"}          <- the plain sentence
  #   voice:play     {"query":"Metallica","entityId":"...man cave"} <- the room sentence
  #
  # He got a spurious "I could not find that" AND the music in the wrong room. A wildcard
  # cannot be told not to be greedy, and two patterns that can both match one sentence are
  # a race, not a design.
  #
  # So there is one pattern, and the room is found by asking a question only THIS HOUSE can
  # answer: take the text after the last " in ", and see whether it names a speaker. If it
  # does, it was a room. If it does not, it was part of the song - which is why
  # "put on Rock in the USA" still searches for the whole title.
  #
  # WHY THE LOOKUP CHECKS TWO PLACES, and it is not belt-and-braces - it is what a real
  # house looks like. Measured on Tim's Home Assistant, 2026-08-11:
  #
  #   media_player.kitchen_speaker              area=None   "Kitchen speaker"
  #   media_player.master_bedroom_speaker       area=None   "Master Bedroom speaker"
  #   media_player.home_assistant_voice_...     area=Man Cave
  #
  # FOUR OF HIS FIVE SPEAKERS HAVE NO AREA, and they are named for their rooms, because
  # that is what people type when setting a Chromecast up. Areas are the tidy Home
  # Assistant answer and area-only would have found nothing outside the man cave - built,
  # shipped, and useless in the house it was built for. So: area first (the more
  # deliberate statement), then the speaker's own name.
  #
  # EACH "variables:" STEP IS ITS OWN ACTION, on purpose. A later step can always see an
  # earlier step's variables; whether two variables in the SAME block can see each other is
  # exactly the kind of thing that fails silently, and one of those bit this feature once
  # already.
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
      - variables:
          said: "{{ trigger.slots.query | default('') | trim }}"
      # The candidate room: everything after the LAST " in ", without a leading "the".
      # Last, not first, so "Rock in the USA in the kitchen" still finds the kitchen.
      - variables:
          r: >-
            {%- set parts = said.rsplit(' in ', 1) -%}
            {%- if parts | count == 2 -%}
              {%- set t = parts[1] | trim -%}
              {{ (t[4:] | trim) if (t[:4] | lower == 'the ') else t }}
            {%- endif -%}
      - variables:
          target: >-
            ${ROOM_TO_SPEAKER}
      # NONE means "that was not a room", so it stays part of what to search for. Nothing
      # here can send the music to a room nobody asked for: either the tail named a speaker
      # in this house, or it is treated as words in a title.
      - variables:
          room: "{{ r if (target and target != 'NONE') else '' }}"
          search: "{{ said.rsplit(' in ', 1)[0] | trim if (target and target != 'NONE') else said }}"
          speaker: "{{ target if (target and target != 'NONE') else '' }}"
      - action: rest_command.peartune_play
        data:
          query: "{{ search }}"
          speaker_id: "{{ speaker }}"
        response_variable: result
      - set_conversation_response: >-
          {% if result.status != 200 %}I could not find {{ search }} in your library{% if r and not room %}, and I do not know a speaker called {{ r }}{% endif %}{% elif result.content.kind == 'artist' %}Playing {{ result.content.artist }}{% elif result.content.kind == 'album' %}Playing the album {{ result.content.title }}{% elif result.content.artist %}Playing {{ result.content.title }} by {{ result.content.artist }}{% else %}Playing {{ result.content.title }}{% endif %}{% if room %} in the {{ room }}{% endif %}

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
      room:
        description: >-
          Which room or speaker to play in, if the user named one - "the kitchen",
          "Sarah's room". Leave it out entirely when they did not, and PearTune uses
          the speaker it was set up with.
    action:
      # The same two-step lookup the spoken sentences use, for the same reason: an area
      # is the tidy answer and a name is what most people actually have. See the note on
      # the automation above.
      - variables:
          target: >-
            {%- set r = room | default('') | trim -%}
            ${ROOM_TO_SPEAKER}
      - condition: template
        value_template: "{{ target != 'NONE' }}"
      - action: rest_command.peartune_play
        data:
          query: "{{ search_query }}"
          speaker_id: "{{ target | default('') }}"
    speech:
      text: "Playing {{ search_query }}"
`
}

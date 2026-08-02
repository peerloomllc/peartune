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
//   media_player   - a `universal` player that DECLARES next/previous/stop. Home Assistant
//                    routes media commands by FEATURE, and a speaker handed one track at a
//                    time does not advertise skipping, so without this "next" fails the way
//                    "play" does. YAML-only, which keeps this a one-paste setup.
//   automation     - the sentences. "play X" belongs to HA's built-in search intent (which
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

export function haConfig ({ port = 8742, token = '', speakerEntity = '' } = {}) {
  // `children` is LOAD-BEARING, not decoration. A universal player with no children has no
  // state to mirror and sits at `off` - and HassMediaNext / HassMediaPrevious carry
  // `required_states={MediaPlayerState.PLAYING}`, so "next" answers "no device supports the
  // required features" no matter what the entity advertises. Pointing it at the speaker it
  // drives makes it read `playing` when the speaker is, and the intents match.
  //
  // It also means play/pause on this entity forward to the real speaker, which is right.
  const children = speakerEntity
    ? `    children:\n      - ${speakerEntity}\n`
    : ''
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

media_player:
  - platform: universal
    name: PearTune
    unique_id: peartune_voice_player
${children}    commands:
      media_next_track:
        action: rest_command.peartune_control
        data:
          action: next
      media_previous_track:
        action: rest_command.peartune_control
        data:
          action: previous
      media_stop:
        action: rest_command.peartune_control
        data:
          action: stop

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
          {% if result.status == 200 %}Playing {{ result.content.artist or result.content.title }}{% else %}I could not find {{ trigger.slots.query }} in your library{% endif %}

  - alias: PearTune voice controls
    mode: queued
    triggers:
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
          {% if result.status == 200 %}OK{% else %}Nothing is playing{% endif %}

intent_script:
  PearTunePlayMusic:
    description: >-
      Play music from the user's personal PearTune music library on a speaker in
      their home. Use this for any request to play a specific artist, album or
      song. The search_query is what the user asked for, such as "Led Zeppelin".
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

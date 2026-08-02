# Voice control: "Okay Nabu, play Led Zeppelin"

Ask a Home Assistant voice satellite for music and hear it start on a speaker.

Everything below goes in **Home Assistant**. PearTune needs nothing installed there - these
are stock building blocks (`rest_command`, `intent_script`, `custom_sentences`).

## Before you start

Turn voice control on in the PearTune dashboard: **Speakers** tab, then **Turn on voice
control**. It gives you a token, shown once. Copy it.

Read the disclosure on that screen. The short version: **anyone who can speak in your home can
play your music.** A spoken request carries no password and there is no way to tell who said
it. It cannot browse, download, share or change anything, only start playback on your own
speakers, and turning it off stops it at once - but it is presence, not permission.

## The short way

**The dashboard writes this for you.** When you turn voice control on, it shows a complete
configuration block with your token and port already filled in, and a **Copy configuration**
button. Paste that at the end of your Home Assistant `configuration.yaml`, restart Home
Assistant, and skip to the end of this page.

You still have to edit a file, and there is no way around that: Home Assistant has no API for
adding a `rest_command`. But you should never have to transcribe or look anything up.

The rest of this page explains what that block does and how to change it.

## 1. The connection to PearTune

```yaml
rest_command:
  peartune_play:
    url: "http://127.0.0.1:8742/voice/play"
    method: POST
    content_type: "application/json"
    payload: '{"token":"YOUR_TOKEN","query":"{{ query }}","entityId":"{{ entity_id }}"}'
```

`8742` is the host's usual loopback port; the dashboard shows the real one, which differs only
if something else had taken it.

`127.0.0.1` is not a placeholder. The endpoint listens on loopback only, so **Home Assistant
has to be on the same machine as the PearTune host.** That is the same requirement speaker
playback has, and for the same reason: nothing about your library is published to your network.

## 2. The intent

```yaml
intent_script:
  PearTunePlayMusic:
    description: >-
      Play music from the user's personal PearTune library on a speaker. Use this for any
      request to play a specific artist, album or song. The search_query should be what the
      user asked for, such as "Led Zeppelin" or "Rock and Roll".
    parameters:
      search_query:
        description: The artist, album or song to play
      area:
        description: Which room or speaker to play on, if the user said one
    action:
      - service: rest_command.peartune_play
        data:
          query: "{{ search_query }}"
          entity_id: "{{ speaker_entity | default('') }}"
    speech:
      text: "Playing {{ search_query }}"
```

**Write the `description` even though it is optional.** If you use an LLM voice agent, this
intent is offered to it as a tool automatically, and the description is what the model reads to
decide when to use it. Without one, Home Assistant generates a generic fallback and the model
guesses.

## Say "put on", not "play"

**"Play Led Zeppelin" will not work, and cannot be made to.** Home Assistant's built-in
`HassMediaSearchAndPlay` intent claims that phrasing and every variation of it:

```
"play {search_query}"                    "play {search_query} in [the] {area}"
"play {search_query} on [the] {name}"    "play [the] {media_class} {search_query}"
```

It wins, and then it fails, because it only matches speakers that advertise the
`SEARCH_MEDIA` feature - which no ordinary smart speaker does. That is the
**"Sorry, no devices supports the required features"** you get.

So PearTune uses the phrasings Home Assistant leaves free:

- **"put on Led Zeppelin"**
- **"listen to Led Zeppelin"**
- **"play Led Zeppelin from PearTune"**

Making plain "play X" work needs PearTune to register a `media_player` entity of its own
inside Home Assistant, which is a proper integration rather than a config block. It is on the
list.

## 3. Sentences, if you use the default agent

The block the dashboard generates already includes these, as a **conversation trigger
automation** rather than a `custom_sentences` file - sentences in their own directory would
make this a two-file setup for no gain, and a conversation trigger carries its own.

An LLM agent needs no sentences at all: it is offered the `intent_script` as a tool and decides
from its description. That is why the generated block contains both halves.

If you would rather use `custom_sentences/en/peartune.yaml` by hand:

```yaml
language: "en"
intents:
  PearTunePlayMusic:
    data:
      - sentences:
          - "play [some] {search_query} [on the {area} speaker]"
          - "put on [some] {search_query}"
          - "I want to listen to {search_query}"
lists:
  search_query:
    wildcard: true
```

Restart Home Assistant, then try it: **"Okay Nabu, play Led Zeppelin."**

## What it plays

A request queues up to 50 tracks, so an artist is an evening rather than one song. What it
picks, in order of preference:

1. **A song whose title matches.** "Put on Rock and Roll" gets that song, then keeps going
   with whatever else matched.
2. **An artist whose name matches.** Their tracks become the queue.
3. **An album whose name matches.** Its tracks, in album order.
4. Otherwise, whatever the search turned up, in the order your library's search ranked it.

## Which speaker

If the request does not name one, PearTune uses the default speaker you picked in the
dashboard. Naming one in the sentence overrides that.

## If it does not work

- **"I could not find X in your library"**: exactly what it says. Voice deliberately does
  **not** file a music request; that is a separate feature in the app.
- **It says nothing at all when it fails:** your automation is missing the
  `response_variable` / `set_conversation_response` pair. Regenerate the block from the
  dashboard - the first version of it did not speak failures, so an unknown artist was just
  silence.
- **Nothing happens at all with an LLM agent:** check the intent has a `description`. Without
  one the model rarely picks it.
- **Nothing happens with the default agent:** the sentence did not match. Custom sentences are
  exact-ish; add the phrasing you actually used to the list.
- **403 in the Home Assistant log:** the token is wrong, or it was rotated in the dashboard.
  Turn voice off and on again for a fresh one and update `configuration.yaml`.
- **Connection refused:** Home Assistant is not on the same machine as the PearTune host, or
  the port in your file is not the one the host took. The dashboard's Speakers tab shows the
  real one.

## Turning it off

Either **Turn off** on the Speakers tab, or revoke the **"Home Assistant voice"** device on the
People &amp; Devices tab. Both take effect immediately, and the second is deliberately the same
revoke you would use on a phone: voice holds an ordinary device grant rather than a special
exemption.

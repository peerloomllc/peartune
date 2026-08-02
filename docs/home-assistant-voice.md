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

## 1. The connection to PearTune

`configuration.yaml`:

```yaml
rest_command:
  peartune_play:
    url: "http://127.0.0.1:PORT/voice/play"
    method: POST
    content_type: "application/json"
    payload: '{"token":"YOUR_TOKEN","query":"{{ query }}","entityId":"{{ entity_id }}"}'
```

Replace `PORT` and `YOUR_TOKEN` with the values from the dashboard.

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

## 3. Sentences, if you use the default agent

An LLM agent needs no sentences: it decides from the description above. The **default** agent
does, so add `custom_sentences/en/peartune.yaml`:

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

## Which speaker

If the request does not name one, PearTune uses the default speaker you picked in the
dashboard. Naming one in the sentence overrides that.

## If it does not work

- **"I could not find that"** and nothing plays: the search found nothing in your library.
  Voice deliberately does **not** file a music request; that is a separate feature in the app.
- **Nothing happens at all with an LLM agent:** check the intent has a `description`. Without
  one the model rarely picks it.
- **Nothing happens with the default agent:** the sentence did not match. Custom sentences are
  exact-ish; add the phrasing you actually used to the list.
- **403 in the Home Assistant log:** the token is wrong, or it was rotated in the dashboard.
  Turn voice off and on again for a fresh one and update `configuration.yaml`.
- **Connection refused:** Home Assistant is not on the same machine as the PearTune host, or
  the port changed. The port is assigned at host start; check the Speakers tab.

## Turning it off

Either **Turn off** on the Speakers tab, or revoke the **"Home Assistant voice"** device on the
People &amp; Devices tab. Both take effect immediately, and the second is deliberately the same
revoke you would use on a phone: voice holds an ordinary device grant rather than a special
exemption.

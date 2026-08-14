# The Voice PE light ring shows what the music is doing

## Goal
A glance at the Home Assistant Voice PE tells you whether PearTune is playing or paused, the
way it already tells you an alarm is set.

## Tier
T1. It adds an optional block to the Home Assistant package PearTune already generates. No wire
change, no new persisted field, no grant or auth change, and nothing in the host's own code
path. Proposal is optional at this tier - written because it touches a light in someone's home,
which deserves the same care as touching their config file did.

## What was measured, not assumed

On Tim's Voice PE (`light.home_assistant_voice_091831_led_ring`), 2026-08-08:

```
supported_color_modes: ['rgb']      effect_list: None      resting state: off

-> light.turn_on  rgb_color [0,180,60] brightness 60
   state: on   rgb: [0,180,60]   brightness: 60
   still on, same colour, 5s later      -> the firmware does NOT immediately stomp it
-> light.turn_off
   state: off                           -> restored exactly as found
```

So: **an ordinary RGB light, settable and it holds.**

## Twinkling: half yes, half no, and the no is hard

Tim asked for a twinkling effect. Checked properly rather than inferred from the `effect_list`
being empty, which could have meant "only reported while on":

```
with the ring ON:  effect_list: None   effect: None
supported_features: 40  =  TRANSITION (32) + FLASH (8),  and EFFECT (4) is NOT set
```

Two separate limits fall out of that, and only one of them is workable around:

- **No built-in effects.** The firmware exposes none through HA, so there is no "twinkle" to ask
  for by name. But **TRANSITION is supported**, which means a smooth **breathing pulse** can be
  built from ordinary `light.turn_on` calls with a transition time, looped. That looks like the
  thing people mean by "it's alive", and it is genuinely achievable.
- **The ring is ONE light, not twelve.** A real twinkle - individual LEDs sparkling
  independently - needs per-LED addressing, and HA sees a single RGB entity for the whole ring.
  **That is not a limitation we can work around from Home Assistant at all.** It would need
  custom ESPHome firmware flashed onto the device, which means giving up the official firmware
  and its updates on a device Tim relies on for voice. Not worth it for an indicator light, and
  not proposed here.

**The cost of a pulse, stated up front:** it is a loop, so it sends a command to the device every
couple of seconds for as long as music plays, and it competes with the assistant for the ring far
more often than a static colour would. A solid colour costs two commands per track. That is a
real trade and the reason the design below offers both, with solid as the default.

## The thing that makes this not-quite-trivial

**The ring is not ours.** The ESPHome firmware drives it for the assistant's own states -
listening, thinking, replying - and it does that below the HA light entity, not through it. The
resting state of the entity is `off` while the assistant still visibly uses the ring, which is
the tell. So:

- our colour will be interrupted by any voice interaction, and
- what the firmware leaves behind afterwards is **not established**. It may return the ring to
  off, which silently loses the indicator until the next track change.

That is the one real unknown and it decides the shape. It was not tested because testing it means
speaking to the box, which is a person-in-the-room job rather than something to script.

**Consequence for the design: the automation must be state-driven, not edge-driven.** An
automation that only fires on a play/pause transition will lose the ring for the rest of the
track after any voice interaction. One that re-asserts the colour periodically, or on any
`media_player` state report, recovers on its own. The second costs a little more traffic to a
device on the same LAN and is worth it.

## Design

An **optional** block in the generated `packages/peartune.yaml`, off unless the operator turns it
on in the Speakers tab. Off by default because a music player quietly taking over a light in
someone's house is not a reasonable default, however nice it looks.

- **playing** - green. Two styles, because the trade above is real and it is not mine to make:
  - `solid` (default) - one `light.turn_on` and done. Two commands per track.
  - `pulse` (Tim asked for this) - a `repeat` loop alternating brightness with a ~2s
    `transition`, so it breathes. Costs a command every couple of seconds while music plays,
    and collides with the assistant far more often.
- **paused** - solid amber, dimmer. Always solid: a pulsing "paused" is a contradiction, and it
  is the state most likely to sit there for an hour.
- **anything else** (idle, off, stopped) - `light.turn_off`, returning the ring to its resting
  state rather than to some colour we picked. The pulse loop must be cancellable here, or it
  keeps writing to the ring after the music stops - which is the obvious way to get this wrong.

It watches the **Voice PE's own** `media_player`, not whatever PearTune happens to be playing
anywhere. A ring in the man cave glowing because the kitchen speaker is playing is a worse
answer than no ring at all.

## Why this belongs in the package rather than in the host

The host would have to poll HA and push light changes, which means holding a second piece of the
user's home hostage to PearTune being up. The package is declarative, visible in a file the
operator can read and delete, and stops working the moment they remove it - which is the right
failure mode for something that controls a light. It also costs the host nothing.

## Rollback

Turn it off in the Speakers tab and re-write the package; or delete the block by hand. The ring
returns to firmware control immediately, and `light.turn_off` is already what our "not playing"
branch does, so nothing is left lit.

## Open question

**Only one, and it needs a person in the room:** after a voice interaction, does the firmware
leave the ring where we set it, or return it to off? If it returns it to off, the periodic
re-assert above is required rather than merely tidier. Worth answering before building, because
it is the difference between a two-state automation and a three-branch one.

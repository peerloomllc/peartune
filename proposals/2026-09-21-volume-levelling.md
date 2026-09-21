# Volume levelling

**Goal** - a quiet album and a loud one play at the same level, so a shuffle across a
library does not send anyone reaching for the volume every third song.

**Tier** - T2. One added field on the track JSON (`gain`) and one added `ping` cap
(`caps.gain`). Both additive: `gain` is a JSON key on an existing message, which old
phones ignore and old hosts never send. Nothing stored, nothing replicated, no grant
semantics touched.

## What is wrong

Nothing in PearTune reads loudness. The tags are usually already there - ReplayGain in
Vorbis comments and ID3 (`REPLAYGAIN_TRACK_GAIN`, `TXXX:replaygain_track_gain`), or
R128 in Opus (`R128_TRACK_GAIN`) - and Navidrome and Jellyfin both surface them. We
ignore all of it and play every file at whatever level it was mastered at.

## Where the numbers come from

The host resolves ONE number per track, decibels relative to the reference, and sends
it as `gain`:

| Adapter | Where it reads |
| --- | --- |
| Subsonic | `replayGain` on the song (OpenSubsonic): `trackGain` / `albumGain`, and `trackPeak` / `albumPeak` for the clipping guard. |
| Jellyfin | `NormalizationGain` on the item (track), `LUFS` on the album for album mode. |
| Folder | `music-metadata` already parses the tags during the scan: `common.replaygain_track_gain` and the R128 equivalent, stored with the track row so playback costs no extra read. |
| Audiobookshelf | None. Spoken word does not want it. |

No analysis pass. A library with no tags gets no levelling, which is honest - computing
gain ourselves would mean decoding every file, and that is a different proposal.

## The shape

- **Host** - `gain` on the track objects `library.get` / `library.list` / `library.search`
  already return, absent when unknown. `ping` gains `caps.gain: 1`.
- **Shell** - a single `applyVolume()` that owns `player.volume`, because three things
  now want it: the per-track gain, the sleep timer's fade, and casting (which sets 0
  deliberately). Volume becomes `gainFactor * fadeFactor * (casting ? 0 : 1)`, and the
  sleep fade stops restoring a literal `1`. The gain is applied on each track change -
  the shell already announces those - so gapless playback is untouched: nothing is
  re-prepared, only the volume moves.
- **Clipping** - a positive gain that would push the peak over 1.0 is reduced to fit
  when the peak is known, and capped at +6 dB when it is not. Levelling that clips is
  worse than no levelling.
- **UI** - Settings > Playback: Off / Track / Album, default TRACK. Album mode keeps a
  record's own quiet-to-loud shape, which is what people want for an album and not what
  they want on shuffle. Absent when the host does not advertise the cap.

## Backwards compatibility

- Old host, new phone: no `caps.gain`, no `gain` field, the setting does not appear and
  volume stays 1, exactly as today.
- New host, old phone: an unknown JSON key on a track, already ignored by every parser
  in the client.
- No migration: the setting is a phone-local preference, the numbers come from the tags.

## What could go wrong

- **A nonsense tag.** Values are clamped to [-20, +6] dB and anything unparseable is
  dropped, so a bad tag cannot silence a track or blow the output.
- **The sleep fade and the gain fighting.** This is the reason for `applyVolume()`:
  after it, every caller sets its own factor and never the raw volume. A test pins that
  the shell has no `volume = 1` restore left in it.
- **Casting.** The host does the mixing for a cast device, not us, so gain is not
  applied in cast mode. The placeholder player stays at 0.

## Verify

`npm run verify` green, plus: unit tests for the dB-to-factor maths, the clipping guard
and the clamp; adapter tests against fixtures carrying ReplayGain, R128 and no tags;
on the emulator, a levelled track and an unlevelled one measured back to back, and the
sleep-timer fade still fading to silence and back with a gain applied.

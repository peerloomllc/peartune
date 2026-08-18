// Does iOS actually DECODE this file, or merely accept it?
//
// The question behind this is worklet/quality.js's UNPLAYABLE.ios list. A format the
// player cannot decode does not error - the raw bytes arrive, nothing comes out, and
// the UI shows "paused" forever. That is how the .wma case surfaced on 2026-08-14.
//
// So: do not ask AVURLAsset whether it isPlayable and believe the answer. Run the
// bytes through AVAssetReader and COUNT THE PCM FRAMES that come out the other side.
// A format with a decoder yields ~44100 frames per second of audio; a format without
// one yields zero, or fails to produce an audio track at all.

import Foundation
import AVFoundation

struct Result {
  let name: String
  let playable: Bool
  let tracks: Int
  let frames: Int
  let note: String
}

func check(_ path: String) async -> Result {
  let name = (path as NSString).lastPathComponent
  let asset = AVURLAsset(url: URL(fileURLWithPath: path))

  var playable = false
  do { playable = try await asset.load(.isPlayable) } catch { }

  var tracks: [AVAssetTrack] = []
  do { tracks = try await asset.loadTracks(withMediaType: .audio) } catch {
    return Result(name: name, playable: playable, tracks: 0, frames: 0,
                  note: "loadTracks threw: \(error.localizedDescription)")
  }
  guard let track = tracks.first else {
    return Result(name: name, playable: playable, tracks: 0, frames: 0,
                  note: "no audio track - the container was not parsed")
  }

  // Ask for linear PCM out. If no decoder exists for the source codec, the reader
  // either refuses to start or produces nothing.
  let settings: [String: Any] = [
    AVFormatIDKey: kAudioFormatLinearPCM,
    AVLinearPCMBitDepthKey: 16,
    AVLinearPCMIsFloatKey: false,
    AVLinearPCMIsBigEndianKey: false,
    AVLinearPCMIsNonInterleaved: false
  ]

  do {
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
    guard reader.canAdd(output) else {
      return Result(name: name, playable: playable, tracks: tracks.count, frames: 0,
                    note: "reader refused a PCM output - no decoder for this codec")
    }
    reader.add(output)
    guard reader.startReading() else {
      return Result(name: name, playable: playable, tracks: tracks.count, frames: 0,
                    note: "startReading failed: \(reader.error?.localizedDescription ?? "unknown")")
    }

    var frames = 0
    while let buf = output.copyNextSampleBuffer() {
      frames += CMSampleBufferGetNumSamples(buf)
    }

    if reader.status == .failed {
      return Result(name: name, playable: playable, tracks: tracks.count, frames: frames,
                    note: "decode FAILED: \(reader.error?.localizedDescription ?? "unknown")")
    }
    return Result(name: name, playable: playable, tracks: tracks.count, frames: frames,
                  note: frames > 0 ? "decoded" : "zero frames out")
  } catch {
    return Result(name: name, playable: playable, tracks: tracks.count, frames: 0,
                  note: "reader threw: \(error.localizedDescription)")
  }
}

let paths = Array(CommandLine.arguments.dropFirst()).sorted()
print(String(format: "%-10s %-9s %-7s %-9s %s", ("FILE" as NSString).utf8String!,
             ("PLAYABLE" as NSString).utf8String!, ("TRACKS" as NSString).utf8String!,
             ("FRAMES" as NSString).utf8String!, ("VERDICT" as NSString).utf8String!))
for p in paths {
  let r = await check(p)
  print(String(format: "%-10@ %-9@ %-7d %-9d %@", r.name as NSString,
               (r.playable ? "yes" : "NO") as NSString, r.tracks, r.frames, r.note as NSString))
}

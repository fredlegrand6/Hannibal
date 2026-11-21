// VOICE IO — Hannibal's mouth and ears on Apple's own echo cancelling.
//
// Talking over Hannibal failed because the browser's echo canceller mangles
// Fred's voice while Hannibal plays. Apple's voice processing (the one FaceTime
// uses) is built for both people talking at once, but it can only remove the
// sound it plays itself. So this helper does both: it plays Hannibal's voice
// AND listens, with voice processing on.
//
// stdin (one JSON per line):
//   {"cmd":"play","id":"7","path":"/tmp/x.mp3"}   → {"ev":"done","id":"7"} when heard
//   {"cmd":"stop"}                                 → stops at once; pending ids get "done"
//   {"cmd":"clip","id":"c1","ms":2500}             → {"ev":"clip","id":"c1","path":"/tmp/….wav"}
// stdout: {"ev":"ready"}, {"ev":"level","mic":0.012,"out":0.08} every 50 ms while
// playing (and 1 s after), {"ev":"error","error":"…"}.
// Build: swiftc -O VoiceIO.swift -o voice-io
import AVFoundation
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
let lock = NSLock()
func emit(_ d: [String: Any]) {
  guard let j = try? JSONSerialization.data(withJSONObject: d), let s = String(data: j, encoding: .utf8) else { return }
  lock.lock(); print(s); lock.unlock()
}

let engine = AVAudioEngine()
let input = engine.inputNode
do { try input.setVoiceProcessingEnabled(true) } catch {
  emit(["ev": "error", "error": "voice processing unavailable: \(error.localizedDescription)"]); exit(1)
}
if #available(macOS 14.0, *) {
  // Don't turn other apps (music, calls) down while Hannibal listens.
  input.voiceProcessingOtherAudioDuckingConfiguration =
    AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
}

let player = AVAudioPlayerNode()
engine.attach(player)
var playFormat = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 1)!
engine.connect(player, to: engine.mainMixerNode, format: playFormat)

// ── ears: echo-cancelled mic → 16 kHz mono ring (last 30 s) ──
let ringRate = 16000.0
var ring = [Int16](repeating: 0, count: Int(ringRate * 30))
var ringTotal = 0
var micLevel: Float = 0
var lastPlayAt = Date.distantPast
let inFormat = input.outputFormat(forBus: 0)
var ringRatio = inFormat.sampleRate / ringRate
func onMic(_ buf: AVAudioPCMBuffer) {
  guard let ch = buf.floatChannelData?[0] else { return }
  let n = Int(buf.frameLength)
  var sum: Float = 0
  for i in 0..<n { sum += ch[i] * ch[i] }
  let rms = sqrt(sum / Float(max(1, n)))
  let ratio = buf.format.sampleRate / ringRate
  let outN = Int(Double(n) / ratio)
  lock.lock()
  micLevel = max(micLevel, rms)
  for i in 0..<outN {
    let a = Int(Double(i) * ratio), b = min(n, Int(Double(i + 1) * ratio))
    var s: Float = 0; for j in a..<max(a + 1, b) { s += ch[min(j, n - 1)] }
    let v = max(-1, min(1, s / Float(max(1, b - a))))
    ring[ringTotal % ring.count] = Int16(v * 32767)
    ringTotal += 1
  }
  lock.unlock()
}
// With voice processing on, the mic reports odd channel counts (x9 on a MacBook);
// tapping in that format can stop the engine from starting. Try what works.
let monoIn = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: inFormat.sampleRate, channels: 1, interleaved: false)
let tapFormats: [(String, AVAudioFormat?)] = [("mono", monoIn), ("native", inFormat), ("default", nil)]
_ = ringRatio
// His loudness for the brain animation: per-50 ms RMS of each scheduled sentence,
// looked up by how far the player has got (no tap on the output, which voice
// processing does not like).
var schedule: [(start: Int64, rms: [Float])] = []
var scheduledEnd: Int64 = 0
func chunkRMS(_ b: AVAudioPCMBuffer) -> [Float] {
  guard let ch = b.floatChannelData?[0] else { return [] }
  let n = Int(b.frameLength), step = 2205
  var out: [Float] = []
  var i = 0
  while i < n { let e = min(n, i + step); var s: Float = 0; for j in i..<e { s += ch[j] * ch[j] }; out.append(sqrt(s / Float(e - i))); i = e }
  return out
}
func currentOut() -> Float {
  guard player.isPlaying, let nt = player.lastRenderTime, let pt = player.playerTime(forNodeTime: nt) else { return 0 }
  let t = pt.sampleTime
  for e in schedule.reversed() where t >= e.start {
    let k = Int((t - e.start) / 2205)
    return k < e.rms.count ? e.rms[k] : 0
  }
  return 0
}

let outFmt = engine.outputNode.inputFormat(forBus: 0)
emit(["ev": "info", "in": "\(inFormat.sampleRate) Hz x\(inFormat.channelCount)", "out": "\(outFmt.sampleRate) Hz x\(outFmt.channelCount)"])
var started = false
for (name, fmt) in tapFormats {
  input.removeTap(onBus: 0)
  input.installTap(onBus: 0, bufferSize: 1024, format: fmt) { buf, _ in onMic(buf) }
  engine.prepare()
  do { try engine.start(); started = true; emit(["ev": "info", "error": "engine started (mic tap: \(name))"]); break } catch {
    emit(["ev": "info", "error": "engine start with \(name) tap: \(error.localizedDescription)"])
    engine.stop()
  }
}
if !started {
  // Last try: let the engine pick every format itself.
  engine.disconnectNodeOutput(player)
  engine.connect(player, to: engine.mainMixerNode, format: nil)
  playFormat = player.outputFormat(forBus: 0)
  input.removeTap(onBus: 0)
  input.installTap(onBus: 0, bufferSize: 1024, format: nil) { buf, _ in onMic(buf) }
  engine.prepare()
  do { try engine.start(); started = true; emit(["ev": "info", "error": "engine started (all default formats)"]) } catch {
    emit(["ev": "info", "error": "engine start, all defaults: \(error.localizedDescription)"])
  }
}
if !started { emit(["ev": "error", "error": "audio engine would not start"]); exit(1) }
emit(["ev": "ready", "micRate": inFormat.sampleRate, "channels": Int(inFormat.channelCount)])

// levels every 50 ms while he speaks (and a second after)
Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
  lock.lock(); let m = micLevel; micLevel = 0; lock.unlock()
  let o = currentOut()
  if player.isPlaying || Date().timeIntervalSince(lastPlayAt) < 1 {
    emit(["ev": "level", "mic": Double(m), "out": Double(o)])
  }
}

var pending = Set<String>()
func finish(_ id: String) {
  DispatchQueue.main.async {
    if pending.remove(id) != nil { lastPlayAt = Date(); emit(["ev": "done", "id": id]) }
  }
}

func load(_ path: String) throws -> AVAudioPCMBuffer {
  let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
  let src = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))!
  try file.read(into: src)
  if file.processingFormat == playFormat { return src }
  let conv = AVAudioConverter(from: file.processingFormat, to: playFormat)!
  let cap = AVAudioFrameCount(Double(src.frameLength) * playFormat.sampleRate / file.processingFormat.sampleRate) + 1024
  let dst = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: cap)!
  var fed = false
  var err: NSError?
  conv.convert(to: dst, error: &err) { _, status in
    if fed { status.pointee = .endOfStream; return nil }
    fed = true; status.pointee = .haveData; return src
  }
  if let e = err { throw e }
  return dst
}

func writeClip(ms: Int) -> String? {
  lock.lock()
  let want = min(ring.count, Int(ringRate * Double(ms) / 1000), ringTotal)
  var pcm = [Int16](repeating: 0, count: want)
  for i in 0..<want { pcm[i] = ring[(ringTotal - want + i) % ring.count] }
  lock.unlock()
  var d = Data()
  func u32(_ v: UInt32) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 4)) }
  func u16(_ v: UInt16) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 2)) }
  d.append("RIFF".data(using: .ascii)!); u32(UInt32(36 + want * 2)); d.append("WAVE".data(using: .ascii)!)
  d.append("fmt ".data(using: .ascii)!); u32(16); u16(1); u16(1); u32(16000); u32(32000); u16(2); u16(16)
  d.append("data".data(using: .ascii)!); u32(UInt32(want * 2))
  pcm.withUnsafeBufferPointer { d.append(Data(buffer: $0)) }
  let path = NSTemporaryDirectory() + "hannibal-clip-\(UUID().uuidString).wav"
  return FileManager.default.createFile(atPath: path, contents: d) ? path : nil
}

// ── commands ──
DispatchQueue.global().async {
  while let line = readLine() {
    guard let data = line.data(using: .utf8),
          let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let cmd = j["cmd"] as? String else { continue }
    let id = (j["id"] as? String) ?? ""
    DispatchQueue.main.async {
      switch cmd {
      case "play":
        guard let path = j["path"] as? String else { return }
        do {
          let buf = try load(path)
          pending.insert(id)
          lastPlayAt = Date()
          if !player.isPlaying { schedule.removeAll(); scheduledEnd = 0 }
          schedule.append((start: scheduledEnd, rms: chunkRMS(buf)))
          scheduledEnd += Int64(buf.frameLength)
          if schedule.count > 20 { schedule.removeFirst(schedule.count - 20) }
          player.scheduleBuffer(buf, completionCallbackType: .dataPlayedBack) { _ in finish(id) }
          if !engine.isRunning { try? engine.start() }
          if !player.isPlaying { player.play() }
        } catch {
          emit(["ev": "error", "id": id, "error": "play: \(error.localizedDescription)"]); emit(["ev": "done", "id": id])
        }
      case "stop":
        let ids = pending; pending.removeAll()
        player.stop()
        lastPlayAt = Date()
        for p in ids { emit(["ev": "done", "id": p, "stopped": true]) }
      case "clip":
        let ms = (j["ms"] as? Int) ?? Int((j["ms"] as? Double) ?? 2500)
        if let p = writeClip(ms: ms) { emit(["ev": "clip", "id": id, "path": p]) }
        else { emit(["ev": "error", "id": id, "error": "clip failed"]) }
      case "quit":
        exit(0)
      default: break
      }
    }
  }
  exit(0)
}

NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { _ in
  // A headset was plugged in / the output changed: restart the engine.
  try? engine.start()
  emit(["ev": "reconfigured"])
}
RunLoop.main.run()

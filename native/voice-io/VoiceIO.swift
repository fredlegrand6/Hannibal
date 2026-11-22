// VOICE IO — Hannibal's mouth and ears on Apple's own echo cancelling.
//
// Talking over Hannibal failed because the browser's echo canceller mangles
// Fred's voice while Hannibal plays. Apple's voice processing (the one FaceTime
// uses) is built for both people talking at once, but it only removes the sound
// it plays itself, so this helper plays Hannibal's voice AND listens.
//
// Voice processing takes the mic over for the whole Mac while it runs (his normal
// ears went deaf when it stayed on), so the engine runs ONLY while he speaks:
// it starts on "warm" (he is thinking) or the first "play", and stops on "release"
// (the app says he is done) or IDLE_S after the last sentence as a safety net.
// Tested on Fred's Mac: another mic recorder hears silence while it runs and
// normal sound again right after it closes.
//
// stdin (one JSON per line):
//   {"cmd":"warm"}                                 → start the engine now (he's about to talk)
//   {"cmd":"play","id":"7","path":"/tmp/x.mp3"}   → {"ev":"done","id":"7"} when heard
//   {"cmd":"stop"}                                 → stops at once; pending ids get "done"
//   {"cmd":"clip","id":"c1","ms":2500}             → {"ev":"clip","id":"c1","path":"/tmp/….wav"}
// stdout: {"ev":"ready"} (helper alive), {"ev":"level","mic":…,"out":…} every 50 ms
// while the engine runs, {"ev":"engine","on":true|false}, {"ev":"error","error":"…"}.
// Build: swiftc -O VoiceIO.swift -o voice-io
import AVFoundation
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
let lock = NSLock()
func emit(_ d: [String: Any]) {
  guard let j = try? JSONSerialization.data(withJSONObject: d), let s = String(data: j, encoding: .utf8) else { return }
  lock.lock(); print(s); lock.unlock()
}
let IDLE_S = 4.0   // safety net; normally the app sends "release" the moment he is done

// ── ears: echo-cancelled mic → 16 kHz mono ring (last 30 s) ──
let ringRate = 16000.0
var ring = [Int16](repeating: 0, count: Int(ringRate * 30))
var ringTotal = 0
var micLevel: Float = 0
var micFresh = false      // a mic buffer arrived since the last level tick
var lastMic: Float = 0, staleTicks = 0
func onMic(_ buf: AVAudioPCMBuffer) {
  guard let ch = buf.floatChannelData?[0] else { return }
  let n = Int(buf.frameLength)
  var sum: Float = 0
  for i in 0..<n { sum += ch[i] * ch[i] }
  let rms = sqrt(sum / Float(max(1, n)))
  let ratio = buf.format.sampleRate / ringRate
  let outN = Int(Double(n) / ratio)
  lock.lock()
  micLevel = max(micLevel, rms); micFresh = true
  for i in 0..<outN {
    let a = Int(Double(i) * ratio), b = min(n, Int(Double(i + 1) * ratio))
    var s: Float = 0; for j in a..<max(a + 1, b) { s += ch[min(j, n - 1)] }
    let v = max(-1, min(1, s / Float(max(1, b - a))))
    ring[ringTotal % ring.count] = Int16(v * 32767)
    ringTotal += 1
  }
  lock.unlock()
}

// ── one speaking session: engine + player, voice processing on ──
final class Session {
  let engine = AVAudioEngine()
  let player = AVAudioPlayerNode()
  var playFormat: AVAudioFormat
  var chunks: [(start: Int64, rms: [Float], step: Int)] = []
  var scheduledEnd: Int64 = 0
  var configObserver: NSObjectProtocol? = nil

  init() throws {
    let input = engine.inputNode
    try input.setVoiceProcessingEnabled(true)
    if #available(macOS 14.0, *) {
      // Don't turn other apps (music, calls) down while he talks.
      input.voiceProcessingOtherAudioDuckingConfiguration =
        AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
    }
    engine.attach(player)
    // Straight into the output: with voice processing on, any mixer in between
    // stops the engine from starting (tested on Fred's Mac, macOS 27).
    playFormat = engine.outputNode.inputFormat(forBus: 0)
    if playFormat.sampleRate == 0 { playFormat = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)! }
    engine.connect(player, to: engine.outputNode, format: playFormat)
    input.installTap(onBus: 0, bufferSize: 1024, format: nil) { buf, _ in onMic(buf) }
    engine.prepare()
    try engine.start()
    // Speakers came or went (monitor asleep, USB-C audio, AirPods): the engine
    // stops and the sentence it was playing never finishes. Before this, that
    // left him silent until a restart. Now: drop this engine, fail the pending
    // sentences with "audio device changed" (the app plays them again), and the
    // next sentence builds a fresh engine on the new speakers.
    configObserver = NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
      guard let self = self, !self.engine.isRunning else { return }   // still running: nothing broke
      engineChanged(self)
    }
  }

  func load(_ path: String) throws -> AVAudioPCMBuffer {
    let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
    let src = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))!
    try file.read(into: src)
    if file.processingFormat == playFormat { return src }
    // mono 44.1 kHz MP3 → the output's format (e.g. stereo 48 kHz)
    let conv = AVAudioConverter(from: file.processingFormat, to: playFormat)!
    if file.processingFormat.channelCount == 1 && playFormat.channelCount > 1 {
      conv.channelMap = [NSNumber](repeating: 0, count: Int(playFormat.channelCount))   // his voice on every speaker
    }
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

  // His loudness for the brain animation (no tap on the output: voice processing refuses it).
  func chunkRMS(_ b: AVAudioPCMBuffer, step: Int) -> [Float] {
    guard let ch = b.floatChannelData?[0] else { return [] }
    let n = Int(b.frameLength)
    var out: [Float] = []; var i = 0
    while i < n { let e = min(n, i + step); var s: Float = 0; for j in i..<e { s += ch[j] * ch[j] }; out.append(sqrt(s / Float(e - i))); i = e }
    return out
  }
  func schedule(_ buf: AVAudioPCMBuffer, done: @escaping () -> Void) {
    if !player.isPlaying { chunks.removeAll(); scheduledEnd = 0 }
    let step = Int(playFormat.sampleRate * 0.05)
    chunks.append((start: scheduledEnd, rms: chunkRMS(buf, step: step), step: step))
    scheduledEnd += Int64(buf.frameLength)
    if chunks.count > 20 { chunks.removeFirst(chunks.count - 20) }
    player.scheduleBuffer(buf, completionCallbackType: .dataPlayedBack) { _ in done() }
    if !player.isPlaying { player.play() }
  }
  func outLevel() -> Float {
    guard player.isPlaying, let nt = player.lastRenderTime, let pt = player.playerTime(forNodeTime: nt) else { return 0 }
    let t = pt.sampleTime
    for e in chunks.reversed() where t >= e.start {
      let k = Int((t - e.start) / Int64(e.step))
      return k < e.rms.count ? e.rms[k] : 0
    }
    return 0
  }
  func close() {
    if let o = configObserver { NotificationCenter.default.removeObserver(o); configObserver = nil }
    player.stop()
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    try? engine.inputNode.setVoiceProcessingEnabled(false)   // hand the mic back to the rest of the Mac
  }
}

var session: Session? = nil
var pending = Set<String>()
var lastActive = Date()
var warmUntil = Date.distantPast   // a "warm" keeps the engine up a while for the first sentence

func ensureSession() -> Session? {
  if let s = session { return s }
  do {
    let s = try Session()
    session = s
    lock.lock(); micLevel = 0; micFresh = false; lastMic = 0; staleTicks = 0; lock.unlock()
    emit(["ev": "engine", "on": true])
    return s
  } catch {
    emit(["ev": "error", "error": "voice processing would not start: \(error.localizedDescription)"])
    return nil
  }
}
func closeSession() {
  guard let s = session else { return }
  s.close(); session = nil
  emit(["ev": "engine", "on": false])
}
func engineChanged(_ s: Session) {
  guard session === s else { return }
  let ids = pending; pending.removeAll()
  closeSession()
  emit(["ev": "reconfigured"])
  for p in ids { emit(["ev": "error", "id": p, "error": "audio device changed"]) }
}

// levels every 50 ms while the engine runs; tear it down when he has been quiet IDLE_S
Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
  guard let s = session else { return }
  // The mic delivers buffers of ~100 ms, the ticks are 50 ms: a tick with no new
  // buffer repeats the last level instead of reporting silence (that made every
  // other tick 0 and the barge watcher never saw 250 ms of Fred in a row).
  lock.lock()
  if micFresh { lastMic = micLevel; staleTicks = 0 } else { staleTicks += 1; if staleTicks > 4 { lastMic = 0 } }
  let m = lastMic; micLevel = 0; micFresh = false
  lock.unlock()
  emit(["ev": "level", "mic": Double(m), "out": Double(s.outLevel())])
  if pending.isEmpty && !s.player.isPlaying && Date().timeIntervalSince(lastActive) > IDLE_S && Date() > warmUntil { closeSession() }
}

func finish(_ id: String) {
  DispatchQueue.main.async {
    if pending.remove(id) != nil { lastActive = Date(); emit(["ev": "done", "id": id]) }
  }
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
      case "warm":
        lastActive = Date(); warmUntil = Date().addingTimeInterval(8)
        _ = ensureSession()
      case "play":
        guard let path = j["path"] as? String else { return }
        lastActive = Date(); warmUntil = .distantPast
        guard let s = ensureSession() else { emit(["ev": "done", "id": id, "error": "no engine"]); return }
        do {
          let buf = try s.load(path)
          pending.insert(id)
          s.schedule(buf) { finish(id) }
        } catch {
          emit(["ev": "error", "id": id, "error": "play: \(error.localizedDescription)"])
        }
      case "stop":
        let ids = pending; pending.removeAll()
        session?.player.stop()
        lastActive = Date()
        for p in ids { emit(["ev": "done", "id": p, "stopped": true]) }
      case "release":
        // He is done talking: give the mic back to the rest of the Mac at once
        // (while voice processing runs, every other mic user hears silence).
        let ids = pending; pending.removeAll()
        for p in ids { emit(["ev": "done", "id": p, "stopped": true]) }
        warmUntil = .distantPast
        closeSession()
      case "clip":
        let ms = (j["ms"] as? Int) ?? Int((j["ms"] as? Double) ?? 2500)
        if let p = writeClip(ms: ms) { emit(["ev": "clip", "id": id, "path": p]) }
        else { emit(["ev": "error", "id": id, "error": "clip failed"]) }
      case "quit":
        closeSession(); exit(0)
      default: break
      }
    }
  }
  DispatchQueue.main.async { closeSession(); exit(0) }
}

// Check once at start that voice processing works here, then let the mic go.
if let _ = ensureSession() { closeSession(); emit(["ev": "ready"]) } else { exit(1) }
RunLoop.main.run()

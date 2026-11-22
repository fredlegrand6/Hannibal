// ─────────────────────────────────────────────────────────────────────────
// LIVE VOICE — hands-free conversation, like ChatGPT voice.
//
// The microphone stays open with Apple's echo cancellation (the same one
// FaceTime uses), so Hannibal doesn't hear himself. When Fred starts talking
// it records; when he pauses (~0.9 s) the sentence goes to the brain as a
// short WAV. If Fred talks while Hannibal is speaking, Hannibal stops at once
// and listens (barge-in). His voice plays through the same audio engine,
// which is what lets the echo cancellation take it out of the microphone.
// Keeps running with the screen locked (background audio), until Fred taps
// stop, a phone call comes in, or he leaves it quiet for a long time.
// ─────────────────────────────────────────────────────────────────────────
import AVFoundation

final class LiveVoice {
    // Called on the main thread
    var onUtterance: ((Data) -> Void)?      // a finished sentence, as 16 kHz WAV
    var onBargeIn: (() -> Void)?            // Fred started talking over Hannibal
    var onCapture: ((Bool) -> Void)?        // Fred is talking (true) / done (false)
    var onLevel: ((Float) -> Void)?         // 0…1 mic level for the orb
    var onStopped: ((String) -> Void)?      // the engine stopped by itself (call, error)

    private let engine = AVAudioEngine()
    private let playerNode = AVAudioPlayerNode()
    private let playFormat = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 1)!
    private let wavFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
    private var toWav: AVAudioConverter?
    private(set) var running = false
    private var observers: [NSObjectProtocol] = []

    // Shared with the audio thread, guarded by `lock`.
    private let lock = NSLock()
    private var vad = VAD()

    struct VAD {
        var accepting = true        // false while the brain is thinking
        var speaking = false        // Hannibal's voice is playing
        var floor: Float = -55      // background noise level (dB), learned
        var loudFor: Double = 0
        var capturing = false
        var silentFor: Double = 0
        var voicedFor: Double = 0
        var capturedFor: Double = 0
        var samples: [Int16] = []
        var preroll: [Int16] = []
        var lastLevelAt: Double = 0
        var clock: Double = 0
    }

    // MARK: Start / stop

    func start() throws {
        guard !running else { return }
        let s = AVAudioSession.sharedInstance()
        try s.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
        try s.setActive(true)

        let input = engine.inputNode
        try input.setVoiceProcessingEnabled(true)
        engine.attach(playerNode)
        engine.connect(playerNode, to: engine.mainMixerNode, format: playFormat)

        let inFormat = input.outputFormat(forBus: 0)
        guard inFormat.sampleRate > 0 else { throw NSError(domain: "Hannibal", code: 10, userInfo: [NSLocalizedDescriptionKey: "The microphone isn't available."]) }
        toWav = AVAudioConverter(from: inFormat, to: wavFormat)
        input.installTap(onBus: 0, bufferSize: 1024, format: inFormat) { [weak self] buf, _ in self?.process(buf) }

        engine.prepare()
        try engine.start()
        playerNode.play()
        lock.lock(); vad = VAD(); lock.unlock()
        running = true

        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
            self?.stop()
            self?.onStopped?("Live talk stopped for a call or another app.")
        })
        observers.append(nc.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            // Headphones in/out: the engine pauses itself; start it again on the new route.
            guard let self, self.running, !self.engine.isRunning else { return }
            do { try self.engine.start(); self.playerNode.play() }
            catch { self.stop(); self.onStopped?("Live talk stopped: the audio changed (\(error.localizedDescription)).") }
        })
    }

    func stop() {
        guard running else { return }
        running = false
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers.removeAll()
        engine.inputNode.removeTap(onBus: 0)
        playerNode.stop()
        engine.stop()
        engine.detach(playerNode)
        try? engine.inputNode.setVoiceProcessingEnabled(false)
        finishPlayback()
        AudioSession.setUp()          // back to the normal speaker set-up
    }

    /// False while the brain is working on an answer: talking then is ignored.
    func setAccepting(_ on: Bool) { lock.lock(); vad.accepting = on; lock.unlock() }

    // MARK: Listening (audio thread)

    private func process(_ buf: AVAudioPCMBuffer) {
        guard let ch = buf.floatChannelData?[0] else { return }
        let n = Int(buf.frameLength)
        guard n > 0 else { return }
        var sum: Float = 0
        for i in 0..<n { sum += ch[i] * ch[i] }
        let db = 20 * log10(sqrt(sum / Float(n)) + 1e-9)
        let dur = Double(n) / buf.format.sampleRate
        let pcm = convert(buf)

        var utterance: Data?
        var bargeIn = false
        var captureChange: Bool?
        var level: Float?

        lock.lock()
        vad.clock += dur
        // The background noise level follows quiet moments quickly, loud ones slowly.
        if !vad.capturing {
            if db < vad.floor + 6 { vad.floor += (db - vad.floor) * 0.05 } else { vad.floor += 0.02 }
            vad.floor = min(max(vad.floor, -75), -30)
        }
        let start = vad.speaking ? max(vad.floor + 20, -38) : max(vad.floor + 12, -50)
        let keep = vad.floor + 8

        if vad.capturing {
            vad.samples.append(contentsOf: pcm)
            vad.capturedFor += dur
            if db > keep { vad.silentFor = 0; vad.voicedFor += dur } else { vad.silentFor += dur }
            if vad.silentFor >= 0.9 || vad.capturedFor >= 30 {
                if vad.voicedFor >= 0.3 { utterance = Self.wav(vad.samples) }
                vad.capturing = false
                vad.samples = []
                vad.preroll = []
                vad.loudFor = 0
                captureChange = false
            }
        } else {
            vad.preroll.append(contentsOf: pcm)
            if vad.preroll.count > 6400 { vad.preroll.removeFirst(vad.preroll.count - 6400) }   // last 0.4 s
            vad.loudFor = db > start ? vad.loudFor + dur : 0
            let needed = vad.speaking ? 0.25 : 0.12
            if vad.accepting && vad.loudFor >= needed {
                vad.capturing = true
                vad.samples = vad.preroll
                vad.silentFor = 0
                vad.voicedFor = vad.loudFor
                vad.capturedFor = Double(vad.preroll.count) / 16000
                bargeIn = vad.speaking
                captureChange = true
            }
        }
        if vad.clock - vad.lastLevelAt > 0.05 {
            vad.lastLevelAt = vad.clock
            level = vad.capturing ? max(0, min(1, (db - vad.floor) / 35)) : 0
        }
        lock.unlock()

        if bargeIn || captureChange != nil || utterance != nil || level != nil {
            DispatchQueue.main.async { [weak self] in
                guard let self, self.running else { return }
                if bargeIn { self.onBargeIn?() }
                if let c = captureChange { self.onCapture?(c) }
                if let l = level { self.onLevel?(l) }
                if let u = utterance { self.onUtterance?(u) }
            }
        }
    }

    private func convert(_ buf: AVAudioPCMBuffer) -> [Int16] {
        guard let conv = toWav else { return [] }
        let cap = AVAudioFrameCount(Double(buf.frameLength) * wavFormat.sampleRate / buf.format.sampleRate) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: wavFormat, frameCapacity: cap) else { return [] }
        var fed = false
        var err: NSError?
        conv.convert(to: out, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buf
        }
        guard err == nil, let p = out.int16ChannelData?[0] else { return [] }
        return Array(UnsafeBufferPointer(start: p, count: Int(out.frameLength)))
    }

    static func wav(_ samples: [Int16]) -> Data {
        var d = Data()
        func u32(_ v: UInt32) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: UInt16) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 2)) }
        let bytes = UInt32(samples.count * 2)
        d.append(contentsOf: Array("RIFF".utf8)); u32(36 + bytes)
        d.append(contentsOf: Array("WAVE".utf8))
        d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1); u32(16000); u32(32000); u16(2); u16(16)
        d.append(contentsOf: Array("data".utf8)); u32(bytes)
        samples.withUnsafeBufferPointer { d.append(Data(buffer: $0)) }
        return d
    }

    // MARK: His voice through the same engine (so it is echo-cancelled)

    private var finished: CheckedContinuation<Void, Never>?
    private var playToken = 0

    @MainActor
    func play(_ mp3: Data) async throws {
        guard running else { throw NSError(domain: "Hannibal", code: 11, userInfo: [NSLocalizedDescriptionKey: "live talk is off"]) }
        let buffer = try decode(mp3)
        playToken += 1
        let token = playToken
        setSpeaking(true)
        defer { setSpeaking(false) }
        let seconds = Double(buffer.frameLength) / playFormat.sampleRate
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            finished = c
            playerNode.scheduleBuffer(buffer, at: nil, options: [], completionCallbackType: .dataPlayedBack) { [weak self] _ in
                DispatchQueue.main.async { if self?.playToken == token { self?.finishPlayback() } }
            }
            if !playerNode.isPlaying { playerNode.play() }
            // Never wait forever on one clip.
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds + 4) { [weak self] in
                guard let self, self.playToken == token, self.finished != nil else { return }
                self.stopPlayback()
            }
        }
    }

    @MainActor
    func stopPlayback() {
        playToken += 1
        if running { playerNode.stop(); playerNode.play() }
        finishPlayback()
        setSpeaking(false)
    }

    private func finishPlayback() {
        let c = finished
        finished = nil
        c?.resume()
    }

    private func setSpeaking(_ on: Bool) { lock.lock(); vad.speaking = on; vad.loudFor = 0; lock.unlock() }

    private func decode(_ mp3: Data) throws -> AVAudioPCMBuffer {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("tts-\(UUID().uuidString).mp3")
        try mp3.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let file = try AVAudioFile(forReading: url)
        guard let src = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)) else { throw NSError(domain: "Hannibal", code: 12) }
        try file.read(into: src)
        if src.format == playFormat { return src }
        guard let conv = AVAudioConverter(from: src.format, to: playFormat),
              let out = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(Double(src.frameLength) * playFormat.sampleRate / src.format.sampleRate) + 1024) else { throw NSError(domain: "Hannibal", code: 13) }
        var fed = false
        var err: NSError?
        conv.convert(to: out, error: &err) { _, status in
            if fed { status.pointee = .endOfStream; return nil }
            fed = true
            status.pointee = .haveData
            return src
        }
        if let err { throw err }
        return out
    }
}

/// Lets the Speaker play through the live engine while live talk is on.
@MainActor
final class LiveClipPlayer: ClipPlayer {
    let live: LiveVoice
    init(_ live: LiveVoice) { self.live = live }
    func play(_ mp3: Data) async throws { try await live.play(mp3) }
    func stop() { live.stopPlayback() }
}

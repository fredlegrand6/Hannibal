// ─────────────────────────────────────────────────────────────────────────
// AUDIO — the microphone (hold to talk) and Hannibal's voice.
//
// Recording: AAC in an .m4a, 16 kHz mono (small, and the same audio/mp4 the
// web app sends from Safari, so the server's ElevenLabs transcriber already
// takes it). Playback: his ElevenLabs voice from /api/speak, one sentence
// block at a time, with a time limit so a stuck clip can never freeze him
// (same lesson as PR #52 on the desk). Stop = tap the orb or start talking.
// ─────────────────────────────────────────────────────────────────────────
import AVFoundation

enum AudioSession {
    static func setUp() {
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP])
        try? s.setActive(true)
    }

    static func askMicPermission() async -> Bool {
        await withCheckedContinuation { c in
            AVAudioApplication.requestRecordPermission { c.resume(returning: $0) }
        }
    }
}

final class Recorder {
    private var recorder: AVAudioRecorder?
    private let url = FileManager.default.temporaryDirectory.appendingPathComponent("hannibal-voice.m4a")

    var isRecording: Bool { recorder?.isRecording ?? false }

    func start() throws {
        AudioSession.setUp()
        try? FileManager.default.removeItem(at: url)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 16000,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ]
        let r = try AVAudioRecorder(url: url, settings: settings)
        r.isMeteringEnabled = true
        guard r.record() else { throw NSError(domain: "Hannibal", code: 1, userInfo: [NSLocalizedDescriptionKey: "The microphone didn't start."]) }
        recorder = r
    }

    /// 0…1, for the orb while Fred talks.
    func level() -> Float {
        guard let r = recorder else { return 0 }
        r.updateMeters()
        let db = r.averagePower(forChannel: 0)
        return max(0, min(1, (db + 50) / 45))
    }

    /// Stops and returns the recording and how long it was.
    func stop() -> (data: Data, seconds: TimeInterval)? {
        guard let r = recorder else { return nil }
        let seconds = r.currentTime
        r.stop()
        recorder = nil
        guard let data = try? Data(contentsOf: url), !data.isEmpty else { return nil }
        return (data, seconds)
    }

    func cancel() {
        recorder?.stop()
        recorder?.deleteRecording()
        recorder = nil
    }
}

@MainActor
final class Speaker: NSObject, AVAudioPlayerDelegate {
    var fetch: ((String) async throws -> Data)?
    var onSpeaking: ((Bool) -> Void)?
    var onDrop: ((String, String) -> Void)?

    private var queue: [String] = []
    private var running = false
    private var player: AVAudioPlayer?
    private var finished: CheckedContinuation<Void, Never>?
    private var generation = 0

    /// While Fred holds the mic nothing new is played (it would end up in his
    /// recording); anything that arrives waits and plays once he lets go.
    var hold = false {
        didSet { if !hold && !queue.isEmpty && !running { Task { await run() } } }
    }

    func say(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        queue.append(String(t.prefix(1500)))
        if !running && !hold { Task { await run() } }
    }

    /// Stops now and forgets anything still waiting.
    func stop() {
        generation += 1
        queue.removeAll()
        player?.stop()
        player = nil
        finishNow()
        onSpeaking?(false)
    }

    private func run() async {
        running = true
        defer { running = false }
        while !queue.isEmpty && !hold {
            let gen = generation
            let text = queue.removeFirst()
            guard let fetch else { return }
            let data: Data
            do { data = try await fetch(text) } catch {
                if gen == generation { onDrop?("fetch", error.localizedDescription) }
                continue
            }
            guard gen == generation else { continue }
            if hold { queue.insert(text, at: 0); break }   // mic went on while fetching
            AudioSession.setUp()
            let p: AVAudioPlayer
            do { p = try AVAudioPlayer(data: data) } catch { onDrop?("decode", error.localizedDescription); continue }
            p.delegate = self
            player = p
            guard p.play() else { onDrop?("play", "the phone refused to play"); player = nil; continue }
            onSpeaking?(true)
            // Never wait forever on one clip: its length plus a margin.
            let limit = max(3, p.duration + 4)
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(limit * 1_000_000_000))
                guard let self, self.player === p else { return }
                self.onDrop?("stuck", "playback ran past \(Int(limit)) s")
                p.stop()
                self.finishNow()
            }
            await withCheckedContinuation { c in finished = c }
            if player === p { player = nil }
            if queue.isEmpty || gen != generation { onSpeaking?(false) }
        }
    }

    private func finishNow() {
        let c = finished
        finished = nil
        c?.resume()
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.finishNow() }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor in
            self.onDrop?("decode", error?.localizedDescription ?? "decode error")
            self.finishNow()
        }
    }
}

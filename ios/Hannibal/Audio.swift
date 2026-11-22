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

/// Plays one clip of his voice and returns when it has finished (or was stopped).
@MainActor
protocol ClipPlayer: AnyObject {
    func play(_ mp3: Data) async throws
    func stop()
}

/// Normal mode: a plain AVAudioPlayer, with a time limit so a stuck clip can
/// never freeze him.
@MainActor
final class SimpleClipPlayer: NSObject, ClipPlayer, AVAudioPlayerDelegate {
    private var player: AVAudioPlayer?
    private var finished: CheckedContinuation<Void, Never>?

    func play(_ mp3: Data) async throws {
        AudioSession.setUp()
        let p = try AVAudioPlayer(data: mp3)
        p.delegate = self
        player = p
        guard p.play() else { player = nil; throw NSError(domain: "Hannibal", code: 2, userInfo: [NSLocalizedDescriptionKey: "the phone refused to play"]) }
        let limit = max(3, p.duration + 4)
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(limit * 1_000_000_000))
            guard let self, self.player === p else { return }
            p.stop()
            self.finishNow()
        }
        await withCheckedContinuation { c in finished = c }
        if player === p { player = nil }
    }

    func stop() {
        player?.stop()
        player = nil
        finishNow()
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
        Task { @MainActor in self.finishNow() }
    }
}

/// His voice. Long answers are cut into sentences: the first one is fetched
/// and played straight away while the next is already being fetched, so he
/// starts talking much sooner. Stop = everything waiting is forgotten.
@MainActor
final class Speaker {
    var fetch: ((String) async throws -> Data)?
    var onSpeaking: ((Bool) -> Void)?
    var onDrop: ((String, String) -> Void)?
    /// Swapped for the live-conversation player (echo cancelled) in live mode.
    var clip: ClipPlayer = SimpleClipPlayer()

    private struct Item { let text: String; let gen: Int; var task: Task<Data, Error>? }
    private var queue: [Item] = []
    private var running = false
    private var generation = 0

    /// While Fred holds the mic nothing new is played (it would end up in his
    /// recording); anything that arrives waits and plays once he lets go.
    var hold = false {
        didSet { if !hold && !queue.isEmpty && !running { Task { await run() } } }
    }

    func say(_ text: String) {
        for chunk in Self.chunks(text) { queue.append(Item(text: chunk, gen: generation, task: nil)) }
        if !running && !hold { Task { await run() } }
    }

    /// Stops now and forgets anything still waiting.
    func stop() {
        generation += 1
        for item in queue { item.task?.cancel() }
        queue.removeAll()
        clip.stop()
        onSpeaking?(false)
    }

    private func startFetch(_ i: Int) {
        guard i < queue.count, queue[i].task == nil, let fetch else { return }
        let text = queue[i].text
        queue[i].task = Task { try await fetch(text) }
    }

    private func run() async {
        running = true
        defer { running = false }
        while !queue.isEmpty && !hold {
            startFetch(0)
            startFetch(1)                                // the next sentence loads while this one plays
            let item = queue.removeFirst()
            guard item.gen == generation, let task = item.task else { continue }
            let data: Data
            do { data = try await task.value } catch {
                if item.gen == generation && !(error is CancellationError) { onDrop?("fetch", error.localizedDescription) }
                continue
            }
            guard item.gen == generation else { continue }
            if hold { queue.insert(item, at: 0); break }  // mic went on while fetching
            onSpeaking?(true)
            do { try await clip.play(data) } catch { onDrop?("play", error.localizedDescription) }
        }
        onSpeaking?(false)
    }

    /// Sentences, joined up to ~240 characters; the first piece is kept short
    /// so his voice starts quickly.
    static func chunks(_ raw: String) -> [String] {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines).prefix(4000)
        guard !text.isEmpty else { return [] }
        var sentences: [String] = []
        var cur = ""
        for ch in text {
            cur.append(ch)
            if ".!?…\n".contains(ch), cur.trimmingCharacters(in: .whitespaces).count > 1 {
                sentences.append(cur); cur = ""
            }
        }
        if !cur.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { sentences.append(cur) }
        var out: [String] = []
        var piece = ""
        for s in sentences {
            let limit = out.isEmpty ? 90 : 240
            if !piece.isEmpty && piece.count + s.count > limit { out.append(piece); piece = "" }
            piece += s
        }
        if !piece.isEmpty { out.append(piece) }
        return out.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.map { String($0.prefix(1500)) }
    }
}

// ─────────────────────────────────────────────────────────────────────────
// MEETING MEMORY on the phone — tap the record button, put the phone on the
// table, talk. Keeps recording with the screen locked. Tap the red bar to
// stop: the recording goes to the server (/api/meeting), which transcribes
// it with speakers and sends back the write-up (summary, decisions, actions,
// reminders + follow-up mail on Fred's yes). A recording that couldn't be
// sent is kept and sent again the next time the app connects.
// AAC 16 kHz mono 32 kbps: about 14 MB an hour.
// ─────────────────────────────────────────────────────────────────────────
import AVFoundation
import Foundation

final class MeetingRecorder {
    private var recorder: AVAudioRecorder?
    private(set) var startedAt: Date?
    var isRecording: Bool { recorder?.isRecording ?? false }

    /// Recordings waiting to be sent (Documents/Meetings, kept across launches).
    static var folder: URL {
        let d = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Meetings", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    func start() throws {
        let s = AVAudioSession.sharedInstance()
        // The phone's own microphones, tuned for a room (not the voice-call mode live talk uses).
        try s.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .mixWithOthers])
        try s.setActive(true)
        let now = Date()
        let url = Self.folder.appendingPathComponent("meeting-\(Int(now.timeIntervalSince1970 * 1000)).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 16000,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 32000,
        ]
        let r = try AVAudioRecorder(url: url, settings: settings)
        guard r.record() else { throw NSError(domain: "Hannibal", code: 2, userInfo: [NSLocalizedDescriptionKey: "The microphone didn't start."]) }
        recorder = r
        startedAt = now
    }

    /// Stops and returns the file with its length in seconds.
    func stop() -> (url: URL, seconds: TimeInterval, started: Date)? {
        guard let r = recorder, let started = startedAt else { return nil }
        let seconds = r.currentTime
        r.stop()
        recorder = nil
        startedAt = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        return (r.url, seconds, started)
    }

    /// Every recording still waiting to be sent: (file, start time).
    static func waiting() -> [(URL, Date)] {
        let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
        return files.filter { $0.pathExtension == "m4a" }.compactMap { u in
            let ms = Double(u.deletingPathExtension().lastPathComponent.replacingOccurrences(of: "meeting-", with: "")) ?? 0
            return ms > 0 ? (u, Date(timeIntervalSince1970: ms / 1000)) : nil
        }
    }

    static func duration(of url: URL) async -> TimeInterval {
        let d = try? await AVURLAsset(url: url).load(.duration)
        return d.map { CMTimeGetSeconds($0) } ?? 0
    }
}

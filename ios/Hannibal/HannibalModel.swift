// ─────────────────────────────────────────────────────────────────────────
// HANNIBAL MODEL — the conversation and what the orb shows.
// One turn at a time (the server is one brain); Yes/No questions, reminders
// and the morning brief arrive live while the app is open.
// ─────────────────────────────────────────────────────────────────────────
import Foundation
import Observation
import UIKit

struct Line: Identifiable, Codable, Equatable {
    enum Kind: String, Codable { case me, him, note, notify, confirm, error }
    var id = UUID()
    var kind: Kind
    var text: String
    var confirmId: String? = nil
    var outcome: String? = nil      // for a Yes/No card once it's answered or expired
    var expires: Date? = nil        // the server gives up on a Yes/No after 2 minutes
    var sending = false             // Yes/No answer on its way
}

@MainActor
@Observable
final class HannibalModel {
    // What the screen shows
    var lines: [Line] = []
    var connection: Connection?
    var online = false
    var recording = false
    var speaking = false
    var looking = false
    var waiting = 0
    var level: Float = 0
    var pulses = 0                   // bumps when something arrives; the orb flashes
    var voiceAlways: Bool = UserDefaults.standard.bool(forKey: "voiceAlways") {
        didSet { UserDefaults.standard.set(voiceAlways, forKey: "voiceAlways") }
    }

    var openConfirms: Int { lines.filter { $0.kind == .confirm && $0.outcome == nil }.count }

    var orbState: String {
        if recording { return "listening" }
        if speaking { return "speaking" }
        if openConfirms > 0 { return "confirm" }
        if looking { return "looking" }
        if waiting > 0 { return "thinking" }
        return "idle"
    }

    var phase: String {
        switch orbState {
        case "listening": return "Listening"
        case "speaking": return "Speaking"
        case "confirm": return "Waiting for your yes"
        case "looking": return "Looking"
        case "thinking": return "Thinking"
        default: return online ? "Ready" : "Connecting…"
        }
    }

    @ObservationIgnored private var api: HannibalAPI?
    @ObservationIgnored private let recorder = Recorder()
    @ObservationIgnored private let speaker = Speaker()
    @ObservationIgnored private var eventsTask: Task<Void, Never>?
    @ObservationIgnored private var meterTask: Task<Void, Never>?
    @ObservationIgnored private var wantRecording = false
    @ObservationIgnored private var backoff: Double = 1
    private static let historyKey = "history.v1"

    init() {
        loadHistory()
        speaker.onSpeaking = { [weak self] on in self?.speaking = on }
        speaker.onDrop = { [weak self] stage, err in self?.api?.voiceDrop(stage: stage, error: err) }
        speaker.fetch = { [weak self] text in
            guard let api = self?.api else { throw APIError.badReply }
            return try await api.speak(text)
        }
        if let c = ConnectionStore.load() { use(c) }
    }

    // MARK: Connection

    func connect(link: String) -> Bool {
        guard let c = Connection.parse(link) else { return false }
        stopEvents()
        ConnectionStore.save(link)
        use(c)
        add(.note, "Connected to \(c.hostLabel).")
        startEvents()
        return true
    }

    func forgetLink() {
        stopEvents()
        ConnectionStore.delete()
        api = nil
        connection = nil
    }

    private func use(_ c: Connection) {
        connection = c
        api = HannibalAPI(conn: c)
    }

    // MARK: Live events (reminders, brief, Yes/No)

    func startEvents() {
        guard eventsTask == nil, let api else { return }
        eventsTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    try await api.listen { ev in self?.handle(ev) }
                } catch APIError.unauthorized {
                    self?.online = false
                    self?.add(.error, APIError.unauthorized.errorDescription ?? "Link refused.")
                    self?.eventsTask = nil
                    return
                } catch {}
                guard let self, !Task.isCancelled else { return }
                self.online = false
                let wait = self.backoff
                self.backoff = min(self.backoff * 2, 30)
                try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            }
        }
    }

    func stopEvents() {
        eventsTask?.cancel()
        eventsTask = nil
        online = false
    }

    private func handle(_ ev: HannibalEvent) {
        switch ev.type {
        case "hello":
            online = true
            backoff = 1
            expireOldConfirms()          // a close may have been missed while away
        case "notify":
            guard let t = ev.text, !t.isEmpty else { return }
            add(.notify, t)
            pulses += 1
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            speaker.say(t)
        case "confirm":
            guard let id = ev.id else { return }
            lines.append(Line(kind: .confirm, text: (ev.summary ?? "Shall I go ahead?"), confirmId: id, expires: Date().addingTimeInterval(120)))
            pulses += 1
            scheduleExpiry()
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
        case "confirm-closed":
            guard let id = ev.id, let i = lines.firstIndex(where: { $0.confirmId == id }) else { return }
            if lines[i].outcome == nil { lines[i].outcome = ev.note ?? ((ev.ok ?? false) ? "Going ahead." : "Not done.") }
            saveHistory()
        default:
            break
        }
    }

    func answer(_ line: Line, yes: Bool) {
        guard let id = line.confirmId, let api,
              let start = lines.firstIndex(where: { $0.id == line.id }), !lines[start].sending else { return }
        lines[start].sending = true
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        Task {
            let result = await api.confirm(id: id, yes: yes)
            guard let i = lines.firstIndex(where: { $0.id == line.id }) else { return }
            lines[i].sending = false
            switch result {
            case .done:
                if lines[i].outcome == nil { lines[i].outcome = yes ? "Going ahead." : "Not done." }
            case .expired:
                if lines[i].outcome == nil { lines[i].outcome = "That question had already closed, so nothing new was done." }
            case .unknown:
                // Keep the buttons: the server keeps only one answer per question,
                // so tapping again can never make him do it twice.
                add(.error, "I couldn't reach Hannibal with your answer. Tap it again, or check before asking again.")
            }
            saveHistory()
        }
    }

    private func expireOldConfirms() {
        let now = Date()
        var changed = false
        for i in lines.indices where lines[i].kind == .confirm && lines[i].outcome == nil {
            if let e = lines[i].expires, e <= now { lines[i].outcome = "No answer in 2 minutes, so I did not do it."; changed = true }
        }
        if changed { saveHistory() }
    }

    private func scheduleExpiry() {
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 122_000_000_000)
            self?.expireOldConfirms()
        }
    }

    // MARK: Talking

    func send(_ raw: String) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let api else { return }
        add(.me, text)
        waiting += 1
        Task {
            defer { waiting -= 1 }
            do { show(try await api.say(text), spoken: false) }
            catch { add(.error, friendly(error)) }
        }
    }

    func startRecording() {
        guard api != nil else { return }
        wantRecording = true
        speaker.stop()                                  // talking over him stops him
        speaker.hold = true                             // and nothing new plays into the mic
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task {
            guard await AudioSession.askMicPermission() else {
                speaker.hold = false
                add(.error, "Hannibal needs the microphone. Turn it on in Settings › Hannibal.")
                return
            }
            guard wantRecording else { return }          // let go before the mic was ready
            do { try recorder.start() } catch { speaker.hold = false; add(.error, friendly(error)); return }
            recording = true
            meterTask = Task { [weak self] in
                while let self, self.recording, !Task.isCancelled {
                    self.level = self.recorder.level()
                    try? await Task.sleep(nanoseconds: 50_000_000)
                }
            }
        }
    }

    /// send = false when Fred slides away to cancel.
    func stopRecording(send: Bool) {
        wantRecording = false
        defer { speaker.hold = false }                  // waiting reminders play now
        guard recording else { return }
        recording = false
        meterTask?.cancel()
        level = 0
        guard send else { recorder.cancel(); add(.note, "Cancelled."); return }
        guard let rec = recorder.stop() else { add(.error, "Nothing was recorded. Try again?"); return }
        guard rec.seconds >= 0.5 else { add(.note, "Hold the mic button while you talk."); return }
        guard let api else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        waiting += 1
        Task {
            defer { waiting -= 1 }
            do {
                let r = try await api.voice(rec.data, mime: "audio/mp4")
                if let heard = r.heard, !heard.isEmpty { add(.me, "🎙 " + heard) }
                show(r, spoken: true)
            } catch { add(.error, friendly(error)) }
        }
    }

    func stopSpeaking() { speaker.stop() }

    // MARK: Camera

    func sendPhoto(_ image: UIImage, caption raw: String) {
        guard let api, let jpeg = image.forHannibal() else { add(.error, "That photo didn't come through. Try again?"); return }
        let caption = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        add(.me, "📷 " + (caption.isEmpty ? "Photo" : caption))
        looking = true
        waiting += 1
        Task {
            defer { waiting -= 1; looking = false }
            do { show(try await api.look(jpegBase64: jpeg.base64EncodedString(), text: caption), spoken: false) }
            catch { add(.error, friendly(error)) }
        }
    }

    // MARK: Helpers

    private func show(_ r: Reply, spoken: Bool) {
        let text = r.reply ?? "No answer."
        let ok = r.ok ?? false
        add(ok ? .him : .error, text)
        if ok && (spoken || voiceAlways) { speaker.say(text) }
    }

    private func friendly(_ error: Error) -> String {
        if let e = error as? APIError { return e.errorDescription ?? "Something went wrong." }
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain {
            switch ns.code {
            case NSURLErrorTimedOut: return "Hannibal took too long to answer. Try again?"
            case NSURLErrorNotConnectedToInternet, NSURLErrorCannotFindHost, NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost:
                return "I can't reach Hannibal. Is Tailscale on on this phone?"
            default: break
            }
        }
        return error.localizedDescription
    }

    func add(_ kind: Line.Kind, _ text: String) {
        lines.append(Line(kind: kind, text: text))
        if lines.count > 200 { lines.removeFirst(lines.count - 200) }
        saveHistory()
    }

    func clearChat() {
        lines.removeAll()
        saveHistory()
    }

    private func saveHistory() {
        let keep = lines.filter { $0.kind != .confirm || $0.outcome != nil }.suffix(80)
        if let d = try? JSONEncoder().encode(Array(keep)) { UserDefaults.standard.set(d, forKey: Self.historyKey) }
    }

    private func loadHistory() {
        guard let d = UserDefaults.standard.data(forKey: Self.historyKey),
              let saved = try? JSONDecoder().decode([Line].self, from: d) else { return }
        lines = saved
    }
}

extension UIImage {
    /// Same size the desk and web app send: longest side 1568 px, JPEG.
    func forHannibal() -> Data? {
        let maxSide: CGFloat = 1568
        let longest = max(size.width, size.height)
        let scale = longest > maxSide ? maxSide / longest : 1
        let target = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let img = UIGraphicsImageRenderer(size: target, format: format).image { _ in draw(in: CGRect(origin: .zero, size: target)) }
        return img.jpegData(compressionQuality: 0.75)
    }
}

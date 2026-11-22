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
    var live = false                 // hands-free conversation is on
    var liveHearing = false          // ...and Fred is talking right now
    var looking = false
    var cameraOn = false             // live camera during live talk
    var waiting = 0
    var level: Float = 0
    var pulses = 0                   // bumps when something arrives; the orb flashes
    var voiceAlways: Bool = UserDefaults.standard.bool(forKey: "voiceAlways") {
        didSet { UserDefaults.standard.set(voiceAlways, forKey: "voiceAlways") }
    }

    var openConfirms: Int { lines.filter { $0.kind == .confirm && $0.outcome == nil }.count }

    var orbState: String {
        if recording || liveHearing { return "listening" }
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
        default:
            if live { return "Live · just talk" }
            return online ? "Ready" : "Connecting…"
        }
    }

    @ObservationIgnored private var api: HannibalAPI?
    @ObservationIgnored private let recorder = Recorder()
    @ObservationIgnored private let speaker = Speaker()
    @ObservationIgnored private var eventsTask: Task<Void, Never>?
    @ObservationIgnored private var meterTask: Task<Void, Never>?
    @ObservationIgnored private var wantRecording = false
    @ObservationIgnored private var backoff: Double = 1
    @ObservationIgnored private let liveVoice = LiveVoice()
    @ObservationIgnored private var pushToken: String?
    @ObservationIgnored private var liveActiveAt = Date()
    @ObservationIgnored private var liveWatch: Task<Void, Never>?
    @ObservationIgnored private let activity = LiveActivityController()
    @ObservationIgnored let camera = LiveCamera()
    private static let historyKey = "history.v1"

    init() {
        loadHistory()
        speaker.onSpeaking = { [weak self] on in self?.speaking = on }
        speaker.onDrop = { [weak self] stage, err in self?.api?.voiceDrop(stage: stage, error: err) }
        speaker.fetch = { [weak self] text in
            guard let api = self?.api else { throw APIError.badReply }
            return try await api.speak(text)
        }
        liveVoice.onBargeIn = { [weak self] in self?.speaker.stop() }
        liveVoice.onCapture = { [weak self] on in
            guard let self else { return }
            self.liveHearing = on
            self.liveActiveAt = Date()
            if !on { self.level = 0 }
        }
        liveVoice.onLevel = { [weak self] l in self?.level = l }
        liveVoice.onUtterance = { [weak self] wav in self?.sendLive(wav) }
        liveVoice.onStopped = { [weak self] why in self?.stopLive(why) }
        if let c = ConnectionStore.load() { use(c) }
        // Action Button / Siri / lock screen button / Dynamic Island stop.
        NotificationCenter.default.addObserver(forName: LiveRequest.start, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.takeLiveRequest() }
        }
        NotificationCenter.default.addObserver(forName: LiveRequest.stop, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.stopLive() }
        }
        takeLiveRequest()
    }

    /// Starts live talk if a shortcut asked for it (also after a cold launch).
    func takeLiveRequest() {
        guard LiveRequest.pendingStart, api != nil else { return }
        LiveRequest.pendingStart = false
        startLive()
    }

    /// Keeps the Dynamic Island in step with the orb while live talk runs
    /// (works with the screen locked, unlike a SwiftUI onChange).
    private func trackActivity() {
        guard live else { return }
        withObservationTracking { _ = (orbState, phase) } onChange: { [weak self] in
            Task { @MainActor in
                guard let self, self.live else { return }
                self.activity.update(state: self.orbState, phase: self.phase)
                self.trackActivity()
            }
        }
    }

    // MARK: Live talk (hands-free, interruptible)

    func toggleLive() { if live { stopLive() } else { startLive() } }

    func startLive() {
        guard api != nil, !live else { return }
        Task {
            guard await AudioSession.askMicPermission() else {
                add(.error, "Hannibal needs the microphone. Turn it on in Settings › Hannibal.")
                return
            }
            guard !live else { return }
            speaker.stop()
            do { try liveVoice.start() } catch {
                add(.error, "Live talk couldn't start: \(error.localizedDescription)")
                return
            }
            speaker.clip = LiveClipPlayer(liveVoice)
            live = true
            liveActiveAt = Date()
            UIApplication.shared.isIdleTimerDisabled = true
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            add(.note, "Live talk on. Just talk, and talk over him to interrupt. Tap the orb to stop.")
            activity.start(state: orbState, phase: phase)
            trackActivity()
            liveWatch = Task { [weak self] in
                // Falls asleep after 3 quiet minutes, to save the battery.
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 20_000_000_000)
                    guard let self, self.live else { return }
                    if self.speaking || self.waiting > 0 || self.liveHearing { self.liveActiveAt = Date(); continue }
                    if Date().timeIntervalSince(self.liveActiveAt) > 180 { self.stopLive("Live talk went to sleep after 3 quiet minutes."); return }
                }
            }
        }
    }

    /// Camera on/off during live talk (turning it on starts live talk if needed).
    func toggleCamera() {
        if cameraOn { camera.stop(); cameraOn = false; return }
        Task {
            guard await LiveCamera.askPermission() else {
                add(.error, "Hannibal needs the camera. Turn it on in Settings › Hannibal.")
                return
            }
            do { try camera.start(front: camera.front) } catch {
                add(.error, "The camera couldn't start: \(error.localizedDescription)")
                return
            }
            cameraOn = true
            if !live { startLive() }
            add(.note, "Camera on. Point it and just talk: he sees what you see when you finish a sentence.")
        }
    }

    /// iOS stops the camera when the app leaves the screen.
    func appWentToBackground() {
        if cameraOn { camera.stop(); cameraOn = false }
    }

    func stopLive(_ note: String? = "Live talk off.") {
        guard live else { return }
        live = false
        liveHearing = false
        level = 0
        liveWatch?.cancel()
        liveWatch = nil
        speaker.stop()
        liveVoice.stop()
        speaker.clip = SimpleClipPlayer()
        UIApplication.shared.isIdleTimerDisabled = false
        activity.end()
        if cameraOn { camera.stop(); cameraOn = false }
        if let note { add(.note, note) }
    }

    private func sendLive(_ wav: Data) {
        guard let api, live else { return }
        liveVoice.setAccepting(false)        // one question at a time
        liveActiveAt = Date()
        waiting += 1
        Task {
            defer {
                waiting -= 1
                liveActiveAt = Date()
                if live { liveVoice.setAccepting(true) }
            }
            do {
                let frame = cameraOn ? camera.snapshotJPEG() : nil
                if frame != nil { looking = true }
                defer { looking = false }
                let r: Reply
                if let frame { r = try await api.voiceLook(wav, mime: "audio/wav", jpeg: frame) }
                else { r = try await api.voice(wav, mime: "audio/wav") }
                let heard = (r.heard ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if heard.isEmpty { return }     // a cough or a door: ignore quietly in live talk
                add(.me, (frame != nil ? "📷🎙 " : "🎙 ") + heard)
                show(r, spoken: true)
            } catch { add(.error, friendly(error)) }
        }
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
        if let t = pushToken, let api { Task { await api.registerPush(token: t) } }
        takeLiveRequest()
    }

    // MARK: Push notifications (app closed)

    func registerPush(token: String) {
        pushToken = token
        guard let api else { return }
        Task { await api.registerPush(token: token) }
    }

    private static func stripAsk(_ text: String) -> String {
        text.replacingOccurrences(of: "\n\nShall I go ahead?", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// A reminder or the brief that came in as a notification while the app was closed.
    func showPushed(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, !lines.suffix(5).contains(where: { $0.kind == .notify && $0.text == t }) else { return }
        add(.notify, t)
        pulses += 1
    }

    /// Fred tapped a Yes/No notification: ask again in the app (the server still waits ~2 min).
    func showPushedConfirm(id: String, text: String) {
        guard !lines.contains(where: { $0.confirmId == id }) else { return }
        lines.append(Line(kind: .confirm, text: Self.stripAsk(text), confirmId: id, expires: Date().addingTimeInterval(110)))
        pulses += 1
        scheduleExpiry()
    }

    /// Yes / No pressed right on the lock screen.
    func answerFromPush(id: String, summary: String, yes: Bool) async {
        guard let api else { return }
        let result = await api.confirm(id: id, yes: yes)
        let text = Self.stripAsk(summary)
        let outcome: String
        switch result {
        case .done: outcome = yes ? "Going ahead (from the lock screen)." : "Not done (from the lock screen)."
        case .expired: outcome = "That question had already closed, so nothing new was done."
        case .unknown: outcome = "Your answer from the lock screen may not have arrived. Check before asking again."
        }
        if let i = lines.firstIndex(where: { $0.confirmId == id }) { lines[i].outcome = outcome }
        else { lines.append(Line(kind: .confirm, text: text, confirmId: id, outcome: outcome)) }
        saveHistory()
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
            guard let id = ev.id, !lines.contains(where: { $0.confirmId == id }) else { return }
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
        guard api != nil, !live else { return }
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

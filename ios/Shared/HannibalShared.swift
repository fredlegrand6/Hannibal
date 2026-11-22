// ─────────────────────────────────────────────────────────────────────────
// SHARED by the app and the widget extension (lock screen / Control Center
// button and the Dynamic Island): the Live Activity's data and the two
// intents those buttons run. Both intents run inside the app itself (the
// start one opens it, the stop one is a LiveActivityIntent), so they only
// pass the request on; the app's model does the work.
// ─────────────────────────────────────────────────────────────────────────
import ActivityKit
import AppIntents
import Foundation

/// What the Dynamic Island and lock screen show during live talk.
struct HannibalActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var state: String     // listening / thinking / speaking / confirm / looking / idle
        var phase: String     // "Listening", "Thinking", "Live · just talk", ...
    }
}

enum LiveRequest {
    static let start = Notification.Name("hannibal.live.start")
    static let stop = Notification.Name("hannibal.live.stop")
    /// Set when "start" arrives before the app's model is ready (cold launch).
    @MainActor static var pendingStart = false
}

/// Action Button, Siri ("Talk to Hannibal"), the lock screen / Control Center button.
struct StartLiveTalkIntent: AppIntent {
    static var title: LocalizedStringResource = "Talk to Hannibal"
    static var description = IntentDescription("Opens Hannibal and starts live talk: just talk, and talk over him to interrupt.")
    static var openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        LiveRequest.pendingStart = true
        NotificationCenter.default.post(name: LiveRequest.start, object: nil)
        return .result()
    }
}

/// The stop button in the Dynamic Island and on the lock screen.
struct StopLiveTalkIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Stop talking to Hannibal"
    static var isDiscoverable: Bool = false

    @MainActor
    func perform() async throws -> some IntentResult {
        LiveRequest.pendingStart = false
        NotificationCenter.default.post(name: LiveRequest.stop, object: nil)
        return .result()
    }
}

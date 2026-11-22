// ─────────────────────────────────────────────────────────────────────────
// SIRI + ACTION BUTTON — "Hey Siri, talk to Hannibal" starts live talk;
// "Hey Siri, ask Hannibal" lets Siri ask for the question, sends it to the
// same brain (/api/say: tools, facts, memory, Yes/No gate) and reads the
// answer out without opening the app. Both show up in the Shortcuts app and
// under Settings › Action Button › Shortcut.
// ─────────────────────────────────────────────────────────────────────────
import AppIntents
import Foundation
import UIKit
import UserNotifications

struct AskHannibalIntent: AppIntent {
    static var title: LocalizedStringResource = "Ask Hannibal"
    static var description = IntentDescription("Asks Hannibal something and reads his answer out, without opening the app.")

    @Parameter(title: "Question", requestValueDialog: "What should I ask Hannibal?")
    var question: String

    static var parameterSummary: some ParameterSummary { Summary("Ask Hannibal \(\.$question)") }

    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        guard let conn = ConnectionStore.load() else {
            let s = "Hannibal isn't connected yet. Open the app and paste his link first."
            return .result(value: s, dialog: IntentDialog(stringLiteral: s))
        }
        let q = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else {
            let s = "I didn't catch a question."
            return .result(value: s, dialog: IntentDialog(stringLiteral: s))
        }
        // Siri stops waiting after a while. A long job keeps running here; its
        // answer then arrives as a notification (tap it, or it shows in the
        // chat if the app is open), so nothing is lost.
        let api = HannibalAPI(conn: conn)
        let work = Task { () -> String in
            do { return try await api.say(q).reply ?? "He didn't answer." }
            catch { return "I couldn't reach Hannibal: \(error.localizedDescription)" }
        }
        guard let answer = await Self.first(of: work, within: 25) else {
            await Self.deliverLater(work, question: q)
            let s = "He's still working on it. I'll send you his answer as a notification."
            return .result(value: s, dialog: IntentDialog(stringLiteral: s))
        }
        let spoken = Self.clean(answer)
        return .result(value: spoken, dialog: IntentDialog(stringLiteral: spoken))
    }

    /// The answer, or nil if it takes longer than `seconds` (the work keeps going).
    static func first(of work: Task<String, Never>, within seconds: Double) async -> String? {
        final class Once: @unchecked Sendable {
            private let lock = NSLock()
            private var cont: CheckedContinuation<String?, Never>?
            init(_ c: CheckedContinuation<String?, Never>) { cont = c }
            func resume(_ v: String?) {
                lock.lock(); let c = cont; cont = nil; lock.unlock()
                c?.resume(returning: v)
            }
        }
        return await withCheckedContinuation { c in
            let once = Once(c)
            Task { once.resume(await work.value) }
            Task {
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                once.resume(nil)
            }
        }
    }

    /// Keeps the app awake for the rest of the answer, then posts it.
    @MainActor
    static func deliverLater(_ work: Task<String, Never>, question: String) {
        final class BG: @unchecked Sendable {
            var id = UIBackgroundTaskIdentifier.invalid
            @MainActor func end() {
                guard id != .invalid else { return }
                UIApplication.shared.endBackgroundTask(id); id = .invalid
            }
        }
        let bg = BG()
        bg.id = UIApplication.shared.beginBackgroundTask(withName: "hannibal.ask") { MainActor.assumeIsolated { bg.end() } }
        Task { @MainActor in
            let answer = clean(await work.value)
            let content = UNMutableNotificationContent()
            content.title = "Hannibal"
            content.subtitle = String(question.prefix(80))
            content.body = answer
            content.sound = .default
            try? await UNUserNotificationCenter.current().add(
                UNNotificationRequest(identifier: "ask-\(UUID().uuidString)", content: content, trigger: nil))
            bg.end()
        }
    }

    /// Siri reads plain text: drop markdown marks and the Yes/No tail.
    static func clean(_ s: String) -> String {
        var t = s.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "__", with: "")
        t = t.replacingOccurrences(of: "`", with: "").replacingOccurrences(of: "#", with: "")
        return t.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

struct HannibalShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: StartLiveTalkIntent(),
                    phrases: ["Talk to \(.applicationName)", "Start \(.applicationName)", "Open live talk in \(.applicationName)"],
                    shortTitle: "Talk to Hannibal",
                    systemImageName: "waveform")
        AppShortcut(intent: AskHannibalIntent(),
                    phrases: ["Ask \(.applicationName)", "Ask \(.applicationName) something", "Question for \(.applicationName)"],
                    shortTitle: "Ask Hannibal",
                    systemImageName: "bubble.left.and.text.bubble.right")
    }
    static var shortcutTileColor: ShortcutTileColor = .navy
}

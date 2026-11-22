// ─────────────────────────────────────────────────────────────────────────
// SIRI + ACTION BUTTON — "Hey Siri, talk to Hannibal" starts live talk;
// "Hey Siri, ask Hannibal" lets Siri ask for the question, sends it to the
// same brain (/api/say: tools, facts, memory, Yes/No gate) and reads the
// answer out without opening the app. Both show up in the Shortcuts app and
// under Settings › Action Button › Shortcut.
// ─────────────────────────────────────────────────────────────────────────
import AppIntents
import Foundation

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
        // Siri stops waiting after a while; a long job with tools keeps running
        // on the server, and its answer is in Hannibal's memory and the app.
        let api = HannibalAPI(conn: conn)
        let answer: String = await withTaskGroup(of: String?.self) { group in
            group.addTask {
                do { return try await api.say(q).reply ?? "He didn't answer." }
                catch { return "I couldn't reach Hannibal: \(error.localizedDescription)" }
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: 25_000_000_000)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first ?? "He's still working on it. Open Hannibal for the answer."
        }
        let spoken = Self.clean(answer)
        return .result(value: spoken, dialog: IntentDialog(stringLiteral: spoken))
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

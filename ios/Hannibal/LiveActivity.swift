// ─────────────────────────────────────────────────────────────────────────
// LIVE ACTIVITY — while live talk runs, the Dynamic Island and the lock
// screen show whether Hannibal is listening, thinking or speaking, with a
// stop button. Started with live talk, updated as the orb changes, ended
// when live talk stops. Silently does nothing if Live Activities are off.
// ─────────────────────────────────────────────────────────────────────────
import ActivityKit
import Foundation

@MainActor
final class LiveActivityController {
    private var activity: Activity<HannibalActivityAttributes>?
    private var last: HannibalActivityAttributes.ContentState?

    func start(state: String, phase: String) {
        guard activity == nil, ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        // A leftover from a crash or a forced quit: close it first.
        for a in Activity<HannibalActivityAttributes>.activities {
            Task { await a.end(nil, dismissalPolicy: .immediate) }
        }
        let s = HannibalActivityAttributes.ContentState(state: state, phase: phase)
        activity = try? Activity.request(attributes: HannibalActivityAttributes(),
                                         content: .init(state: s, staleDate: nil),
                                         pushType: nil)
        last = s
    }

    func update(state: String, phase: String) {
        guard let activity else { return }
        let s = HannibalActivityAttributes.ContentState(state: state, phase: phase)
        guard s != last else { return }
        last = s
        Task { await activity.update(.init(state: s, staleDate: nil)) }
    }

    func end() {
        guard let activity else { return }
        self.activity = nil
        last = nil
        Task { await activity.end(nil, dismissalPolicy: .immediate) }
    }
}

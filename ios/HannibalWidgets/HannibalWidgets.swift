// ─────────────────────────────────────────────────────────────────────────
// HANNIBAL WIDGETS — the extension that draws:
//  • the "Talk to Hannibal" button for the lock screen and Control Center
//    (iOS 18+ controls; also selectable for the Action Button), and
//  • the Live Activity: Dynamic Island + lock screen card during live talk.
// The button runs StartLiveTalkIntent (opens the app, starts live talk);
// the stop buttons run StopLiveTalkIntent inside the app.
// ─────────────────────────────────────────────────────────────────────────
import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

@main
struct HannibalWidgets: WidgetBundle {
    var body: some Widget {
        HannibalGlanceWidget()
        HannibalLiveActivity()
        HannibalTalkControl()
    }
}

// MARK: Lock screen / Control Center button

struct HannibalTalkControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.revalisgroup.hannibal.talk") {
            ControlWidgetButton(action: StartLiveTalkIntent()) {
                Label("Talk to Hannibal", systemImage: "waveform")
            }
        }
        .displayName("Talk to Hannibal")
        .description("Opens Hannibal and starts live talk.")
    }
}

// MARK: Live Activity

private extension HannibalActivityAttributes.ContentState {
    var color: Color {
        switch state {
        case "listening": return Color(red: 0.35, green: 0.78, blue: 1.0)
        case "speaking": return Color(red: 0.62, green: 0.55, blue: 1.0)
        case "thinking": return Color(red: 0.55, green: 0.6, blue: 0.75)
        case "confirm", "looking": return Color(red: 0.95, green: 0.75, blue: 0.3)
        default: return Color(red: 0.4, green: 0.7, blue: 0.9)
        }
    }
    var symbol: String {
        switch state {
        case "listening": return "ear"
        case "speaking": return "waveform"
        case "thinking": return "ellipsis"
        case "confirm": return "questionmark"
        case "looking": return "eye"
        default: return "waveform.circle"
        }
    }
}

private struct Dot: View {
    let s: HannibalActivityAttributes.ContentState
    var size: CGFloat = 22
    var body: some View {
        ZStack {
            Circle().fill(s.color.opacity(0.25))
            Circle().strokeBorder(s.color, lineWidth: 1.5)
            Image(systemName: s.symbol).font(.system(size: size * 0.45, weight: .semibold)).foregroundStyle(s.color)
        }
        .frame(width: size, height: size)
    }
}

private struct StopButton: View {
    var body: some View {
        Button(intent: StopLiveTalkIntent()) {
            Label("Stop", systemImage: "stop.fill").font(.system(size: 14, weight: .semibold))
        }
        .tint(.red)
    }
}

struct HannibalLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: HannibalActivityAttributes.self) { ctx in
            // Lock screen / banner
            HStack(spacing: 12) {
                Dot(s: ctx.state, size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Hannibal").font(.headline).foregroundStyle(.white)
                    Text(ctx.state.phase).font(.subheadline).foregroundStyle(.white.opacity(0.75))
                }
                Spacer()
                StopButton()
            }
            .padding(16)
            .activityBackgroundTint(Color.black.opacity(0.85))
            .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { ctx in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { Dot(s: ctx.state, size: 36).padding(.leading, 4) }
                DynamicIslandExpandedRegion(.center) {
                    VStack(spacing: 2) {
                        Text("Hannibal").font(.headline)
                        Text(ctx.state.phase).font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) { StopButton().padding(.trailing, 4) }
            } compactLeading: {
                Dot(s: ctx.state, size: 20)
            } compactTrailing: {
                Text(ctx.state.phase.components(separatedBy: " ").first ?? "")
                    .font(.caption2).foregroundStyle(ctx.state.color)
                    .frame(maxWidth: 64)
            } minimal: {
                Dot(s: ctx.state, size: 20)
            }
            .keylineTint(ctx.state.color)
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────
// AT A GLANCE — home screen and lock screen widget: next appointments,
// reminders, and whether a Yes/No question waits. Reads /api/glance with
// the same link the app uses (shared keychain). Refreshes about every 15
// minutes, and right away when the app gets news. Tap opens Hannibal.
// ─────────────────────────────────────────────────────────────────────────
import SwiftUI
import WidgetKit

struct GlanceEntry: TimelineEntry {
    let date: Date
    let glance: Glance?
    let problem: String?
}

struct GlanceProvider: TimelineProvider {
    static let sample = Glance(ok: true,
        events: [.init(title: "Lunch with Jay", ts: Date().addingTimeInterval(3600).timeIntervalSince1970 * 1000, endTs: nil, allDay: false),
                 .init(title: "Call with HTS", ts: Date().addingTimeInterval(4 * 3600).timeIntervalSince1970 * 1000, endTs: nil, allDay: false)],
        reminders: [.init(message: "Pick up Gaian", ts: Date().addingTimeInterval(7200).timeIntervalSince1970 * 1000)],
        waiting: 0)

    func placeholder(in context: Context) -> GlanceEntry { GlanceEntry(date: Date(), glance: Self.sample, problem: nil) }

    func getSnapshot(in context: Context, completion: @escaping (GlanceEntry) -> Void) {
        if context.isPreview { completion(placeholder(in: context)); return }
        Task { completion(await load()) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<GlanceEntry>) -> Void) {
        Task {
            let entry = await load()
            completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(15 * 60))))
        }
    }

    private func load() async -> GlanceEntry {
        guard let conn = ConnectionStore.load() else { return GlanceEntry(date: Date(), glance: nil, problem: "Open Hannibal once") }
        do { return GlanceEntry(date: Date(), glance: try await HannibalAPI(conn: conn).glance(), problem: nil) }
        catch { return GlanceEntry(date: Date(), glance: nil, problem: "Can't reach Hannibal") }
    }
}

private let cyan = Color(red: 0.35, green: 0.85, blue: 1.0)
private let gold = Color(red: 0.95, green: 0.75, blue: 0.3)

private func when(_ ms: Double, allDay: Bool = false) -> String {
    let d = Date(timeIntervalSince1970: ms / 1000)
    let cal = Calendar.current
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_GB")
    if allDay { f.dateFormat = cal.isDateInToday(d) ? "'Today'" : "EEE" }
    else if cal.isDateInToday(d) { f.dateFormat = "HH:mm" }
    else if cal.isDateInTomorrow(d) { f.dateFormat = "'Tmrw' HH:mm" }
    else { f.dateFormat = "EEE HH:mm" }
    return f.string(from: d)
}

struct GlanceView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GlanceEntry

    var body: some View {
        switch family {
        case .accessoryInline: inline
        case .accessoryRectangular: rectangular
        default: home
        }
    }

    private var waiting: Int { entry.glance?.waiting ?? 0 }

    private var inline: some View {
        if waiting > 0 { return Text("Hannibal: \(waiting) waiting for your yes") }
        if let e = entry.glance?.events.first { return Text("\(when(e.ts, allDay: e.allDay ?? false)) \(e.title)") }
        if let r = entry.glance?.reminders.first { return Text("⏰ \(when(r.ts)) \(r.message)") }
        return Text(entry.problem ?? "Hannibal: nothing coming up")
    }

    private var rectangular: some View {
        VStack(alignment: .leading, spacing: 1) {
            if waiting > 0 { Text("● \(waiting) waiting for your yes").font(.caption.bold()) }
            if let g = entry.glance {
                ForEach(Array(g.events.prefix(waiting > 0 ? 1 : 2)), id: \.self) { e in
                    Text("\(when(e.ts, allDay: e.allDay ?? false))  \(e.title)").font(.caption).lineLimit(1)
                }
                if let r = g.reminders.first { Text("⏰ \(when(r.ts))  \(r.message)").font(.caption).lineLimit(1) }
                if g.events.isEmpty && g.reminders.isEmpty && waiting == 0 { Text("Nothing coming up").font(.caption) }
            } else { Text(entry.problem ?? "Hannibal").font(.caption) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var home: some View {
        let rows = family == .systemSmall ? 3 : (family == .systemLarge ? 10 : 4)
        return VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Circle().fill(cyan).frame(width: 8, height: 8)
                Text("Hannibal").font(.caption.bold()).foregroundStyle(cyan)
                Spacer()
                if waiting > 0 {
                    Text("\(waiting) yes?").font(.caption2.bold()).padding(.horizontal, 6).padding(.vertical, 2)
                        .background(gold.opacity(0.25), in: Capsule()).foregroundStyle(gold)
                }
            }
            if let g = entry.glance {
                let items: [(Double, String, String, Bool)] =
                    g.events.map { ($0.ts, when($0.ts, allDay: $0.allDay ?? false), $0.title, false) } +
                    g.reminders.map { ($0.ts, when($0.ts), $0.message, true) }
                let sorted = items.sorted { $0.0 < $1.0 }.map { ($0.1, $0.2, $0.3) }.prefix(rows)
                if sorted.isEmpty {
                    Spacer()
                    Text("Nothing coming up").font(.footnote).foregroundStyle(.secondary)
                    Spacer()
                } else {
                    ForEach(Array(sorted.enumerated()), id: \.offset) { _, it in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(it.2 ? "⏰" : "•").font(.caption2).foregroundStyle(it.2 ? gold : cyan)
                            Text(it.0).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                            Text(it.1).font(.caption).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                }
            } else {
                Spacer()
                Text(entry.problem ?? "").font(.footnote).foregroundStyle(.secondary)
                Spacer()
            }
        }
        .foregroundStyle(.white)
    }
}

struct HannibalGlanceWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "com.revalisgroup.hannibal.glance", provider: GlanceProvider()) { entry in
            GlanceView(entry: entry)
                .containerBackground(for: .widget) { Color.black }
        }
        .configurationDisplayName("Hannibal at a glance")
        .description("Your next appointments, reminders, and anything waiting for your yes.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular, .accessoryInline])
    }
}

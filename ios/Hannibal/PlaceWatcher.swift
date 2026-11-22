// ─────────────────────────────────────────────────────────────────────────
// PLACE REMINDERS on the phone — "remind me to buy milk when I get home".
// Hannibal keeps the list on the server (/api/places). The phone looks each
// place up on the map, watches it as a geofence (iOS wakes the app even when
// it's closed), and when Fred arrives / leaves it shows the reminder and
// tells the server it fired. A place it can't find is reported back, and
// Hannibal tells Fred. Needs location access "Always" (asked the first time
// there is a place to watch). iOS allows 20 watched places per app.
// ─────────────────────────────────────────────────────────────────────────
import CoreLocation
import Foundation
import UserNotifications

@MainActor
final class PlaceWatcher: NSObject, CLLocationManagerDelegate {
    static let shared = PlaceWatcher()
    private let manager = CLLocationManager()
    private let geocoder = CLGeocoder()
    private static let storeKey = "places.v1"   // id → reminder, to show it when iOS wakes us
    private var syncing = false

    private var known: [String: PlaceReminder] {
        get {
            guard let d = UserDefaults.standard.data(forKey: Self.storeKey),
                  let m = try? JSONDecoder().decode([String: PlaceReminder].self, from: d) else { return [:] }
            return m
        }
        set { UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: Self.storeKey) }
    }

    /// Call at launch so geofence events that relaunched the app are delivered.
    func start() { manager.delegate = self }

    /// Fetch the list and make the watched places match it.
    func sync() async {
        guard !syncing, let conn = ConnectionStore.load() else { return }
        syncing = true
        defer { syncing = false }
        let api = HannibalAPI(conn: conn)
        guard let list = try? await api.places() else { return }
        let wanted = Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })
        // Stop watching what was fired / cancelled elsewhere.
        for region in manager.monitoredRegions where region.identifier.hasPrefix("place-") {
            let id = String(region.identifier.dropFirst(6))
            if wanted[id] == nil { manager.stopMonitoring(for: region) }
        }
        var store = known.filter { wanted[$0.key] != nil }
        let watching = Set(manager.monitoredRegions.map(\.identifier))
        let new = list.filter { !watching.contains("place-\($0.id)") }
        if !new.isEmpty { askAlways() }
        for r in new {
            do {
                let marks = try await geocoder.geocodeAddressString(r.place)
                guard let mark = marks.first, let loc = mark.location else { throw CLError(.geocodeFoundNoResult) }
                // Cities and islands are big, a shop is small.
                var radius = (mark.region as? CLCircularRegion)?.radius ?? 150
                radius = min(max(radius, 150), min(20000, manager.maximumRegionMonitoringDistance))
                let region = CLCircularRegion(center: loc.coordinate, radius: radius, identifier: "place-\(r.id)")
                region.notifyOnEntry = r.on != "leave"
                region.notifyOnExit = r.on == "leave"
                manager.startMonitoring(for: region)
                store[r.id] = r
            } catch {
                await api.placeFailed(r.id, error: "The iPhone couldn't find \"\(r.place)\" on the map.")
            }
        }
        known = store
    }

    private func askAlways() {
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestAlwaysAuthorization()
        case .authorizedWhenInUse: manager.requestAlwaysAuthorization()
        default: break
        }
    }

    // MARK: Geofence events (also when iOS relaunched the app for one)

    nonisolated func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
        Task { @MainActor in self.hit(region.identifier) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
        Task { @MainActor in self.hit(region.identifier) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, monitoringDidFailFor region: CLRegion?, withError error: Error) {
        guard let id = region?.identifier, id.hasPrefix("place-") else { return }
        Task { @MainActor in
            guard let conn = ConnectionStore.load() else { return }
            await HannibalAPI(conn: conn).placeFailed(String(id.dropFirst(6)), error: "The iPhone couldn't watch that place: \(error.localizedDescription)")
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {}

    private func hit(_ identifier: String) {
        guard identifier.hasPrefix("place-") else { return }
        let id = String(identifier.dropFirst(6))
        for region in manager.monitoredRegions where region.identifier == identifier { manager.stopMonitoring(for: region) }
        var store = known
        guard let r = store.removeValue(forKey: id) else { return }
        known = store
        let content = UNMutableNotificationContent()
        content.title = "📍 Hannibal"
        content.subtitle = r.on == "leave" ? "Leaving \(r.place)" : "At \(r.place)"
        content.body = r.message
        content.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "place-\(id)", content: content, trigger: nil))
        Task {
            guard let conn = ConnectionStore.load() else { return }
            _ = await HannibalAPI(conn: conn).placeFired(id)
        }
    }
}
